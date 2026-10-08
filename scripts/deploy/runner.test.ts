import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import { main } from '../deploy'
import { app, fixtureSettings, testRoot } from './config.test'
import { type Builder, nativeNumber, options, run } from './runner'
import { gitFixture } from './source.test'
import { State } from './state'
import { type Endpoint, endpoint } from './upload.test'
let root: string, service: Endpoint, config: string, source: string
function parse(platforms = 'ios,android'): ReturnType<typeof options> {
  return options([
    '--config',
    config,
    '--app',
    app,
    '--branch',
    'master',
    '--platform',
    platforms
  ])
}
function saveConfig(): void {
  const settings = fixtureSettings(root) as Record<string, unknown>
  const apps = settings.apps as Record<
    string,
    { ios: { upload: object }; android: { upload: object } }
  >
  const upload = {
    kind: 'mason',
    origin: service.origin,
    channelKey: 'fixture',
    tokenFile: path.join(root, 'token.json')
  }
  apps[app].ios.upload = upload
  apps[app].android.upload = upload
  writeFileSync(
    config,
    JSON.stringify({ schemaVersion: 1, branches: { master: { settings } } }),
    { mode: 0o600 }
  )
}
const builder: Builder = async context => {
  const file = path.join(
    context.source,
    context.target.platform +
      (context.target.platform === 'ios' ? '.ipa' : '.apk')
  )
  writeFileSync(file, 'fake-compiler-package')
  return {
    file,
    buildNumber: nativeNumber(context.target.platform, context.buildNumber)
  }
}
describe('Pinned multi-app deployment orchestration', () => {
  beforeEach(async () => {
    root = testRoot('runner-')
    service = await endpoint(root)
    source = gitFixture(root)
    config = path.join(root, 'deployConfig.json')
    saveConfig()
    writeFileSync(
      path.join(root, 'token.json'),
      JSON.stringify({
        schemaVersion: 1,
        origin: service.origin,
        token: 'synthetic-token'
      }),
      { mode: 0o600 }
    )
  })
  afterEach(async () => {
    await service.close()
    rmSync(root, { recursive: true, force: true })
  })
  it('dry-runs the actual CLI without allocating numbers, creating checkouts or leaking config', async () => {
    const args = [
      '-r',
      'sucrase/register',
      'scripts/deploy.ts',
      '--config',
      config,
      '--app',
      app,
      '--branch',
      'master',
      '--platform',
      'ios,android',
      '--dry-run'
    ]
    const output = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      stdio: 'pipe'
    })
    assert(output.includes('Build, verify and upload ios'))
    assert(!output.includes('synthetic'))
    assert(!output.includes(root))
    assert(!existsSync(path.join(root, 'state')))
    assert.equal(
      spawnSync(
        process.execPath,
        ['-r', 'sucrase/register', 'scripts/deploy.ts'],
        { stdio: 'pipe' }
      ).status,
      2
    )
    assert.equal(
      await main([
        '--config',
        config,
        '--app',
        app,
        '--branch',
        'master',
        '--platform',
        'ios',
        '--dry-run'
      ]),
      0
    )
    assert.equal(
      await main([
        '--config',
        path.join(root, 'missing'),
        '--app',
        app,
        '--branch',
        'master',
        '--platform',
        'ios'
      ]),
      1
    )
  })
  it('pins all platforms, retains verified retry files and publishes successes after partial failure', async () => {
    writeFileSync(path.join(source, 'package.json'), 'dirty')
    const logs: string[] = []
    const commits: string[] = []
    const ios: Builder = async context => {
      commits.push(context.commit)
      return await builder(context)
    }
    const android: Builder = async context => {
      commits.push(context.commit)
      throw new Error('synthetic-private-error')
    }
    assert.equal(
      await run(parse(), { ios, android }, new AbortController().signal, line =>
        logs.push(line)
      ),
      1
    )
    assert.equal(new Set(commits).size, 1)
    assert.equal(service.requests.length, 1)
    assert(!logs.join('\n').includes('synthetic-private-error'))
    assert.equal(
      readFileSync(path.join(source, 'package.json'), 'utf8'),
      'dirty'
    )
    assert.equal(
      execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: source,
        encoding: 'utf8'
      }).match(/worktree /g)?.length,
      1
    )
    const state = new State(path.join(root, 'state'))
    const id = String(state.db.prepare('SELECT id FROM runs').get()?.id)
    const record = state.load(id)
    assert.equal(record.artifacts[0].published, 7)
    assert.deepEqual(record.failed, ['android'])
    assert.equal(state.reserve(app, 'android', 1), 43)
    state.close()
    assert.equal(
      await run(
        { ...parse('ios'), publishOnly: id },
        {},
        new AbortController().signal,
        () => {}
      ),
      0
    )
    assert.equal(service.requests.length, 1)
    assert(existsSync(path.join(root, 'output', id, 'ios.ipa')))
  })
  it('retries a failed publication without rebuilding or reallocating its number', async () => {
    service.statuses.push(401)
    assert.equal(
      await run(
        parse('ios'),
        { ios: builder },
        new AbortController().signal,
        () => {}
      ),
      1
    )
    let state = new State(path.join(root, 'state'))
    const id = String(state.db.prepare('SELECT id FROM runs').get()?.id)
    assert.equal(
      state.load(id).artifacts[0].error,
      'Upload failed; retry this run with publish-only'
    )
    state.close()
    assert.equal(
      await run(
        { ...parse('ios'), publishOnly: id },
        {},
        new AbortController().signal,
        () => {}
      ),
      0
    )
    state = new State(path.join(root, 'state'))
    assert.equal(state.load(id).artifacts[0].published, 7)
    assert.equal(state.load(id).artifacts[0].error, undefined)
    assert.equal(state.reserve(app, 'ios', 1), 43)
    state.close()
    await assert.rejects(
      run(
        { ...parse('ios'), publishOnly: id, branch: 'other' },
        {},
        new AbortController().signal,
        () => {}
      )
    )
  })
  it('rejects wrong package numbers, missing adapters, tampered retry files and cancelled builds', async () => {
    assert.equal(
      await run(
        parse('ios'),
        {
          ios: async context => ({
            ...(await builder(context)),
            buildNumber: 'wrong'
          })
        },
        new AbortController().signal,
        () => {}
      ),
      1
    )
    assert.equal(
      await run(parse('ios'), {}, new AbortController().signal, () => {}),
      1
    )
    const cancel = new AbortController()
    assert.equal(
      await run(
        parse(),
        {
          ios: async context => {
            cancel.abort()
            return await builder(context)
          }
        },
        cancel.signal,
        () => {}
      ),
      1
    )
    assert.equal(service.requests.length, 0)
    service.statuses.push(401)
    assert.equal(
      await run(
        parse('ios'),
        { ios: builder },
        new AbortController().signal,
        () => {}
      ),
      1
    )
    const state = new State(path.join(root, 'state'))
    const rows = state.db
      .prepare('SELECT id FROM runs')
      .all()
      .map(row => state.load(String(row.id)))
    const retry = rows.find(row =>
      row.artifacts.some(artifact => artifact.error != null)
    )!
    state.close()
    chmodSync(path.join(root, 'output', retry.id, 'ios.ipa'), 0o600)
    writeFileSync(path.join(root, 'output', retry.id, 'ios.ipa'), 'changed')
    assert.equal(
      await run(
        { ...parse('ios'), publishOnly: retry.id },
        {},
        new AbortController().signal,
        () => {}
      ),
      1
    )
    assert.equal(readdirSync(path.join(root, 'worktrees')).length, 0)
  })
})
