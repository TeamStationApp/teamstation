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
import { app, fixtureSettings, testRoot } from './config.test'
import { Processes } from './process'
import { currentSource, prepareSource, remoteCommit } from './source'
import { target } from './targets'
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
  it('builds the current root without remote access, cleaning or replacing local files', async () => {
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: source })
    writeFileSync(path.join(source, 'package.json'), '{"version":"9.8.7"}')
    writeFileSync(path.join(source, 'untracked.txt'), 'keep')
    const processes = new Processes(new AbortController().signal)
    const original = processes.run.bind(processes)
    const commands: string[][] = []
    processes.run = async command => {
      commands.push(command.args)
      return await original(command)
    }
    try {
      const current = await currentSource(
        settings,
        target(app, 'ios'),
        processes,
        source
      )
      assert.equal(current.directory, source)
      assert.equal(
        current.commit,
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: source,
          encoding: 'utf8'
        }).trim()
      )
      assert(commands.every(args => args[0] === 'rev-parse'))
      assert.equal(
        readFileSync(path.join(source, 'untracked.txt'), 'utf8'),
        'keep'
      )
      assert.equal(
        readFileSync(path.join(source, 'package.json'), 'utf8'),
        '{"version":"9.8.7"}'
      )
      await assert.rejects(
        currentSource(
          settings,
          target('app.teamstation.director', 'ios'),
          processes,
          source
        ),
        /requested target/
      )
      mkdirSync(path.join(source, 'nested'))
      await assert.rejects(
        currentSource(
          settings,
          target(app, 'ios'),
          processes,
          path.join(source, 'nested')
        ),
        /repository root/
      )
    } finally {
      processes.run = original
    }
  })
  it('pins one fetched commit, preserves dirty source, owns dependencies and safely removes only its checkout', async () => {
    const processes = new Processes(new AbortController().signal)
    const expected = await remoteCommit(settings, app, 'master', processes)
    writeFileSync(path.join(source, 'package.json'), 'dirty')
    const prepared = await prepareSource(
      settings,
      target(app, 'ios'),
      'master',
      'a'.repeat(32),
      processes
    )
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
    await assert.rejects(
      prepareSource(
        settings,
        target(app, 'ios'),
        'master',
        'a'.repeat(32),
        processes
      )
    )
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
  it('rejects missing targets/branches and non-root repositories', async () => {
    const processes = new Processes(new AbortController().signal)
    await assert.rejects(remoteCommit(settings, app, 'absent', processes))
    await assert.rejects(
      prepareSource(
        settings,
        target('app.teamstation.director', 'ios'),
        'master',
        'b'.repeat(32),
        processes
      )
    )
    const directorSettings = {
      ...settings,
      apps: { ...settings.apps, 'app.teamstation.director': settings.apps[app] }
    }
    await assert.rejects(
      prepareSource(
        directorSettings,
        target('app.teamstation.director', 'ios'),
        'master',
        'c'.repeat(32),
        processes
      ),
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
      prepareSource(
        { ...settings, repository: path.join(source, 'nested') },
        target(app, 'ios'),
        'master',
        'd'.repeat(32),
        processes
      ),
      /repository root/
    )
  })
})
