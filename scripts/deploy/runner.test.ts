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

import { main as deployMain } from '../deploy'
import { app, fixtureSettings, testRoot } from './config.test'
import { buildEnvironment } from './prepare'
import { DeploymentToolError } from './process'
import {
  type Builder,
  nativeNumber,
  options,
  run as runCheckout
} from './runner'
import { gitFixture } from './source.test'
import { State } from './state'
import { type Endpoint, endpoint } from './upload.test'
let root: string, service: Endpoint, config: string, source: string
const deployFile = path.resolve('scripts/deploy.ts')
const register = require.resolve('sucrase/register')
const run: typeof runCheckout = async (options, builders, signal, output) =>
  await runCheckout(options, builders, signal, output, source)
const main: typeof deployMain = async (args, builders) =>
  await deployMain(args, builders, source)

function parse(platforms = 'ios,android'): ReturnType<typeof options> {
  return options([
    '--build-number-file',
    path.join(source, '.git/buildNum.json'),
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
      register,
      deployFile,
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
      stdio: 'pipe',
      cwd: source
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
  it('targets APP_SERVER_URL in emitted native config without changing stored defaults', async () => {
    const settings = JSON.parse(readFileSync(config, 'utf8')) as {
      branches: {
        master: { settings: { apps: Record<string, { apiOrigin?: string }> } }
      }
    }
    const apps = settings.branches.master.settings.apps
    apps[app].apiOrigin = 'https://default.example.test'
    apps['app.teamstation.cameraman'] = {
      ...apps[app],
      apiOrigin: 'https://other.example.test'
    }
    writeFileSync(config, JSON.stringify(settings), { mode: 0o600 })
    const before = readFileSync(config, 'utf8')
    for (const [input, origin] of [
      ['preview.example.test', 'https://preview.example.test'],
      [
        'https://preview.example.test:8443/',
        'https://preview.example.test:8443'
      ],
      [undefined, 'https://default.example.test']
    ]) {
      const verify: Builder = async context => {
        const env = buildEnvironment(context)
        assert.equal(env.TS_API_BASE_URL, origin + '/api/v1')
        assert.equal(env.TS_PRIMARY_HOST, new URL(origin!).host)
        assert.equal(
          context.settings.apps['app.teamstation.cameraman'].apiOrigin,
          'https://other.example.test'
        )
        const compiled = execFileSync(
          process.execPath,
          [
            '-e',
            `
          const {transformFileSync}=require('@babel/core');
          const vm=require('node:vm');
          const code=transformFileSync('src/app/native/config.ts').code;
          const module={exports:{}};
          vm.runInNewContext(code,{module,exports:module.exports,require:()=>({PRIMARY_HOST:'default.example.test',httpOrigin:h=>'https://'+h})});
          if(code.includes('process.env.TS_API_BASE_URL')) throw new Error('URL not inlined');
          console.log(module.exports.apiBaseUrl);
        `
          ],
          {
            cwd: path.resolve('.'),
            env: { ...process.env, ...env },
            encoding: 'utf8'
          }
        ).trim()
        assert.equal(compiled, origin + '/api/v1')
        console.log('Native Babel config target:', compiled)
        return await builder(context)
      }
      assert.equal(
        await runCheckout(
          parse('ios'),
          { ios: verify },
          new AbortController().signal,
          () => {},
          source,
          { APP_SERVER_URL: input }
        ),
        0
      )
      assert.equal(readFileSync(config, 'utf8'), before)
    }
  })
  it('rejects invalid APP_SERVER_URL before allocating counters or output', async () => {
    for (const input of [
      '',
      'http://preview.example.test',
      'https://user:password@preview.example.test',
      'https://preview.example.test/path',
      'https://preview.example.test?query=x',
      'https://preview.example.test#fragment',
      'localhost',
      'https://LOCALHOST',
      'https://127.0.0.1',
      'https://127.1',
      'https://[::1]',
      'https://localhost.example.test'
    ]) {
      await assert.rejects(
        runCheckout(
          parse('ios'),
          { ios: builder },
          new AbortController().signal,
          () => {},
          source,
          { APP_SERVER_URL: input }
        )
      )
      assert(!existsSync(path.join(source, '.git/buildNum.json')))
      assert(!existsSync(path.join(root, 'output')))
    }
    const invalid = spawnSync(
      process.execPath,
      [
        '-r',
        register,
        deployFile,
        '--config',
        config,
        '--app',
        app,
        '--branch',
        'master',
        '--platform',
        'ios',
        '--dry-run'
      ],
      {
        cwd: source,
        env: { ...process.env, APP_SERVER_URL: 'http://preview.example.test' },
        encoding: 'utf8'
      }
    )
    assert.equal(invalid.status, 1)
  })
  it('pins all platforms, retains verified retry files and publishes successes after partial failure', async () => {
    writeFileSync(path.join(source, 'package.json'), '{"version":"9.8.7"}')
    const logs: string[] = []
    const commits: string[] = []
    const numbers: number[] = []
    const ios: Builder = async context => {
      commits.push(context.commit)
      numbers.push(context.buildNumber)
      assert.equal(context.version, '9.8.7')
      return await builder(context)
    }
    const android: Builder = async context => {
      commits.push(context.commit)
      numbers.push(context.buildNumber)
      assert.equal(context.version, '9.8.7')
      throw new Error('synthetic-private-error')
    }
    assert.equal(
      await run(parse(), { ios, android }, new AbortController().signal, line =>
        logs.push(line)
      ),
      1
    )
    assert.equal(new Set(commits).size, 1)
    assert.equal(new Set(numbers).size, 1)
    assert.equal(numbers.length, 2)
    assert.equal(service.requests.length, 1)
    assert(!logs.join('\n').includes('synthetic-private-error'))
    assert.equal(
      readFileSync(path.join(source, 'package.json'), 'utf8'),
      '{"version":"9.8.7"}'
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
    assert.equal(record.version, '9.8.7')
    assert.equal(record.buildNumberFormat, 'date')
    state.close()
    const counterBefore = readFileSync(
      path.join(source, '.git/buildNum.json'),
      'utf8'
    )
    assert.equal(
      await run(
        { ...parse('ios'), publishOnly: id },
        {},
        new AbortController().signal,
        () => {}
      ),
      0
    )
    assert.equal(
      readFileSync(path.join(source, '.git/buildNum.json'), 'utf8'),
      counterBefore
    )
    assert.equal(service.requests.length, 1)
    assert(existsSync(path.join(root, 'output', id, 'ios.ipa')))
  })
  it('reports a failing tool status without private paths or compiler output', async () => {
    const lines: string[] = []
    const status = await run(
      parse('ios'),
      {
        ios: async () => {
          throw new DeploymentToolError(
            'Deployment tool failed',
            '/var/app/private/example-tool',
            17
          )
        }
      },
      new AbortController().signal,
      line => lines.push(line)
    )
    assert.equal(status, 1)
    assert(
      lines.includes(
        'ios build failed (example-tool exited 17); no package was published'
      )
    )
    assert(!lines.join('\n').includes('/var/app/private'))
    assert.equal(service.requests.length, 0)
  })
  it('distinguishes tool signal termination from a startup failure', async () => {
    const lines: string[] = []
    const status = await run(
      parse('ios'),
      {
        ios: async () => {
          throw new DeploymentToolError(
            'Deployment tool failed',
            '/var/app/private/example-tool',
            undefined,
            'SIGTERM'
          )
        }
      },
      new AbortController().signal,
      line => lines.push(line)
    )
    assert.equal(status, 1)
    assert(
      lines.includes(
        'ios build failed (example-tool terminated by SIGTERM); no package was published'
      )
    )
    assert(!lines.join('\n').includes('could not start'))
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
    assert.equal(state.load(id).buildNumberFormat, 'date')
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
  it('preserves legacy Apple numbers on upload-only retries', async () => {
    service.statuses.push(401)
    await run(
      parse('ios'),
      { ios: builder },
      new AbortController().signal,
      () => {}
    )
    const state = new State(path.join(root, 'state'))
    const id = String(state.db.prepare('SELECT id FROM runs').get()?.id)
    const record = state.load(id)
    delete record.buildNumberFormat
    record.artifacts[0].buildNumber = 42
    state.save(record)
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
    assert.equal(service.result.build_version, '1.0.42')
  })
  it('requires an explicit shared path and reports the daily limit through the CLI', async () => {
    await assert.rejects(
      run(
        { ...parse('ios'), buildNumberFile: undefined },
        {},
        new AbortController().signal
      ),
      /shared --build-number-file/
    )
    const now = new Date()
    const full =
      ((now.getFullYear() % 100) * 10000 +
        (now.getMonth() + 1) * 100 +
        now.getDate()) *
        100 +
      99
    const shared = path.join(source, '.git/buildNum.json')
    writeFileSync(
      shared,
      JSON.stringify([
        {
          branch: 'master',
          lastBuildDate: now.toISOString(),
          buildNumber: full
        }
      ])
    )
    const errors: unknown[] = []
    const old = console.error
    console.error = line => {
      errors.push(line)
    }
    try {
      assert.equal(
        await main(
          [
            '--config',
            config,
            '--app',
            app,
            '--branch',
            'master',
            '--platform',
            'ios',
            '--build-number-file',
            shared
          ],
          { ios: builder }
        ),
        1
      )
    } finally {
      console.error = old
    }
    assert.deepEqual(errors, ['maximum build number reached'])
    const output = path.join(root, 'output')
    assert.deepEqual(readdirSync(output), ['.teamstation-deploy'])
    assert.equal(service.requests.length, 0)
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
    assert(existsSync(path.join(source, 'package.json')))
    assert(!existsSync(path.join(root, 'worktrees')))
  })
})
