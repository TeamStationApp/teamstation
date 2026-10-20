/** Node 24 entrypoint. Dependencies belong to this pinned checkout. */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { dependencyInputs } from './scripts/deploy/dependencyInputs.ts'

export async function masonBootstrap(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  let child: ReturnType<typeof spawn> | undefined
  let stopping = false
  let killTimer: NodeJS.Timeout | undefined
  const stop = (): void => {
    stopping = true
    // The deploy process handles TERM and forwards it to its compiler groups.
    child?.kill('SIGTERM')
    killTimer = setTimeout(() => {
      child?.kill('SIGKILL')
    }, 9000)
    killTimer.unref()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  const dependencyEnv = { ...env }
  delete dependencyEnv.DEPLOY_UPLOAD_CREDENTIAL
  const run = async (
    file: string,
    args: string[],
    childEnv: NodeJS.ProcessEnv = env
  ): Promise<number> => {
    if (stopping) return 1
    return await new Promise(resolve => {
      child = spawn(file, args, { cwd, env: childEnv, stdio: 'inherit' })
      child.once('error', () => {
        resolve(1)
      })
      child.once('exit', code => {
        resolve(code ?? 1)
      })
    })
  }
  try {
    if ((await run('socket', ['npm', 'ci'], dependencyEnv)) !== 0) return 1
    writeFileSync(
      path.join(cwd, '.deploy-dependencies'),
      dependencyInputs(cwd),
      { mode: 0o600 }
    )
    return await run(process.execPath, [
      '-r',
      'sucrase/register',
      'scripts/deploy/mason.ts'
    ])
  } finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
    if (killTimer != null) clearTimeout(killTimer)
  }
}
if (
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  masonBootstrap()
    .then(code => {
      process.exitCode = code
    })
    .catch(() => {
      console.error('Mason dependency setup failed')
      process.exitCode = 1
    })
}
