import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { Settings } from './config'
import { Processes } from './process'
import { noSymlinks, runId } from './state'
import { branchName, object, sha } from './validation'

export interface Source {
  directory: string
  commit: string
  cleanup: () => Promise<void>
}
export async function prepareRepository(
  settings: Settings,
  repository: string,
  required: string,
  branch: string,
  id: string,
  processes: Processes
): Promise<Source> {
  branchName(branch)
  runId(id)
  const repo = realpathSync(repository)
  const git = async (args: string[]): Promise<string> =>
    await processes.run({ file: settings.tools.git, args, cwd: repo })
  const top = await git(['rev-parse', '--show-toplevel'])
  if (realpathSync(top) !== repo)
    throw new Error('Source must be a repository root')
  const ref = `refs/deploy/${id}`
  const directory = path.join(
    settings.worktreeDirectory,
    `${path.basename(repo)}_build${id}`
  )
  noSymlinks(directory)
  if (existsSync(directory)) throw new Error('Build checkout already exists')
  const cleanupProcess = new Processes(new AbortController().signal)
  const cleanupGit = async (args: string[]): Promise<string> =>
    await cleanupProcess.run({ file: settings.tools.git, args, cwd: repo })
  let commit: string
  try {
    await git(['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:${ref}`])
    commit = sha(await git(['rev-parse', `${ref}^{commit}`]))
    try {
      await git(['worktree', 'add', '--detach', directory, commit])
    } catch (error) {
      if (existsSync(directory))
        await cleanupGit(['worktree', 'remove', '--force', directory])
      throw error
    }
  } finally {
    await cleanupGit(['update-ref', '-d', ref])
  }
  const marker = path.join(directory, '.teamstation-deploy-run')
  writeFileSync(marker, JSON.stringify({ id, commit }), {
    flag: 'wx',
    mode: 0o600
  })
  async function cleanup(): Promise<void> {
    noSymlinks(directory)
    noSymlinks(marker)
    const identity = object({ id: runId, commit: sha })(
      JSON.parse(readFileSync(marker, 'utf8'))
    )
    if (identity.id !== id || identity.commit !== commit)
      throw new Error('Checkout ownership changed')
    // Cancellation must still remove this owned checkout, without reusing the cancelled signal.
    const cleanup = new Processes(new AbortController().signal)
    await cleanup.run({
      file: settings.tools.git,
      args: ['worktree', 'remove', '--force', directory],
      cwd: repo
    })
  }
  if (!existsSync(path.join(directory, required))) {
    await cleanup()
    throw new Error('Selected branch does not contain the requested target')
  }
  return { directory, commit, cleanup }
}
