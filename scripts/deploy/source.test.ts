import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import { resolveSettings, type Settings } from './config'
import { fixtureSettings, testRoot } from './config.test'
import { Processes } from './process'
import { prepareRepository } from './source'
let root: string, settings: Settings, source: string
export function gitFixture(root: string): string {
  const source = path.join(root, 'source')
  const remote = path.join(root, 'remote.git')
  mkdirSync(source)
  const git = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: source,
      encoding: 'utf8',
      stdio: 'pipe'
    }).trim()
  git(['init', '-b', 'master'])
  git(['config', 'user.name', 'Fixture'])
  git(['config', 'user.email', 'fixture@example.test'])
  writeFileSync(
    path.join(source, 'package.json'),
    '{"name":"fixture","version":"1.0.0"}'
  )
  git(['add', 'package.json'])
  git(['commit', '-m', 'Fixture'])
  git(['init', '--bare', '-b', 'master', remote])
  git(['remote', 'add', 'origin', remote])
  git(['push', 'origin', 'master'])
  return source
}
describe('Exact source branch preparation', () => {
  beforeEach(() => {
    root = testRoot('source-')
    source = gitFixture(root)
    settings = resolveSettings(
      {
        schemaVersion: 1,
        branches: { master: { settings: fixtureSettings(root) } }
      },
      'master'
    )
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })
  it('pins one fetched commit, preserves dirty source, owns dependencies and safely removes only its checkout', async () => {
    const processes = new Processes(new AbortController().signal)
    const expected = execFileSync('git', ['rev-parse', 'origin/master'], {
      cwd: source,
      encoding: 'utf8'
    }).trim()
    writeFileSync(path.join(source, 'package.json'), 'dirty')
    const prepare = async (
      id: string,
      required = 'package.json',
      repository = settings.repository
    ): ReturnType<typeof prepareRepository> =>
      await prepareRepository(
        settings,
        repository,
        required,
        'master',
        id,
        processes
      )
    const prepared = await prepare('a'.repeat(32))
    assert.equal(prepared.commit, expected)
    assert.equal(
      JSON.parse(
        readFileSync(path.join(prepared.directory, 'package.json'), 'utf8')
      ).name,
      'fixture'
    )
    assert.equal(
      readFileSync(path.join(source, 'package.json'), 'utf8'),
      'dirty'
    )
    assert(!existsSync(path.join(prepared.directory, 'node_modules')))
    assert.equal(
      execFileSync('git', ['for-each-ref', 'refs/deploy'], {
        cwd: source,
        encoding: 'utf8'
      }),
      ''
    )
    await assert.rejects(prepare('a'.repeat(32)))
    const marker = path.join(prepared.directory, '.teamstation-deploy-run')
    const saved = readFileSync(marker)
    writeFileSync(
      marker,
      JSON.stringify({ id: 'b'.repeat(32), commit: expected })
    )
    await assert.rejects(prepared.cleanup())
    writeFileSync(marker, saved)
    await prepared.cleanup()
    assert(!existsSync(prepared.directory))
    assert(existsSync(source))
  })
  it('rejects missing files and branches and non-root repositories', async () => {
    const processes = new Processes(new AbortController().signal)
    const prepare = async (
      id: string,
      required: string,
      options: { branch?: string; repository?: string } = {}
    ): ReturnType<typeof prepareRepository> =>
      await prepareRepository(
        settings,
        options.repository ?? settings.repository,
        required,
        options.branch ?? 'master',
        id,
        processes
      )
    await assert.rejects(
      prepare('b'.repeat(32), 'package.json', { branch: 'absent' })
    )
    await assert.rejects(
      prepare('c'.repeat(32), 'mobile/apps/tsDirector/project.yml'),
      /does not contain/
    )
    assert.equal(
      execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: source,
        encoding: 'utf8'
      }).match(/worktree /g)?.length,
      1
    )
    mkdirSync(path.join(source, 'nested'))
    await assert.rejects(
      prepare('d'.repeat(32), 'package.json', {
        repository: path.join(source, 'nested')
      }),
      /repository root/
    )
  })
})
