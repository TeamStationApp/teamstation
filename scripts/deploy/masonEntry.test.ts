import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import { app, fixtureSettings, testRoot } from './config.test'
import { masonDeploy } from './mason'
import { type Builder, nativeNumber } from './runner'
import { gitFixture } from './source.test'
import { type Endpoint, endpoint } from './upload.test'

let root: string, source: string, config: string, service: Endpoint
const entry = path.resolve('Masonfile.ts')
const builder: Builder = async context => {
  const file = path.join(context.source, context.target.platform + '.ipa')
  writeFileSync(file, 'fake-compiler-package')
  return {
    file,
    buildNumber: nativeNumber(context.target.platform, context.buildNumber)
  }
}
function environment(): NodeJS.ProcessEnv {
  return {
    MASON_APP: app,
    MASON_BRANCH: 'master',
    MASON_PLATFORMS: 'ios,android',
    DEPLOY_CONFIG_FILE: config,
    BUILD_NUMBER_FILE: path.join(root, 'buildNum.json'),
    MASON_RESULT_FILE: path.join(root, 'result.json')
  }
}
function saveConfig(iosOnly = false): void {
  const settings = fixtureSettings(root) as {
    apps: Record<
      string,
      { ios: { upload: object }; android?: { upload: object } }
    >
  }
  const upload = {
    kind: 'mason',
    origin: service.origin,
    channelKey: 'fixture',
    tokenFile: path.join(root, 'token.json')
  }
  settings.apps[app].ios.upload = upload
  if (iosOnly) delete settings.apps[app].android
  else settings.apps[app].android!.upload = upload
  writeFileSync(
    config,
    JSON.stringify({ schemaVersion: 1, branches: { master: { settings } } }),
    { mode: 0o600 }
  )
}
async function bootstrap(
  script: string,
  socketExit = 0,
  cancel = false
): Promise<number | null> {
  const bin = path.join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, 'socket'), `#!/bin/sh\nexit ${socketExit}\n`, {
    mode: 0o700
  })
  mkdirSync(path.join(source, 'node_modules/sucrase'), { recursive: true })
  writeFileSync(path.join(source, 'node_modules/sucrase/register.js'), '')
  mkdirSync(path.join(source, 'scripts/deploy'), { recursive: true })
  writeFileSync(path.join(source, 'scripts/deploy/mason.ts'), script)
  return await new Promise(resolve => {
    const child = spawn(process.execPath, [entry], {
      cwd: source,
      env: {
        ...process.env,
        ...environment(),
        PATH: bin + ':' + process.env.PATH
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stderr.resume()
    child.stdout.on('data', () => {
      if (cancel) child.kill('SIGTERM')
    })
    child.once('exit', resolve)
  })
}
describe('TeamStation Mason entrypoint', () => {
  beforeEach(async () => {
    root = testRoot('mason-entry-')
    source = gitFixture(root)
    service = await endpoint(root)
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
  it('builds the supplied checkout with one counter allocation and reports success', async () => {
    assert.equal(
      await masonDeploy(
        environment(),
        source,
        { ios: builder, android: builder },
        false
      ),
      0
    )
    const result = JSON.parse(
      readFileSync(environment().MASON_RESULT_FILE!, 'utf8')
    ) as { status: string }
    assert.equal(result.status, 'succeeded')
    assert.equal(
      (
        JSON.parse(
          readFileSync(environment().BUILD_NUMBER_FILE!, 'utf8')
        ) as unknown[]
      ).length,
      1
    )
  })
  it('reports missing settings as partial while uploading configured platforms', async () => {
    saveConfig(true)
    assert.equal(
      await masonDeploy(environment(), source, { ios: builder }, false),
      1
    )
    assert.equal(
      (
        JSON.parse(readFileSync(environment().MASON_RESULT_FILE!, 'utf8')) as {
          status: string
        }
      ).status,
      'partial'
    )
  })
  it('reports missing and failed platforms and rejects invalid environment', async () => {
    saveConfig(true)
    assert.equal(
      await masonDeploy(
        { ...environment(), MASON_PLATFORMS: 'android' },
        source,
        {},
        false
      ),
      1
    )
    assert.equal(
      await masonDeploy(
        environment(),
        source,
        {
          ios: async () => {
            throw new Error('fixture failure')
          }
        },
        false
      ),
      1
    )
    await assert.rejects(masonDeploy({}), /Missing/)
    await assert.rejects(
      masonDeploy({ ...environment(), MASON_PLATFORMS: 'ios,ios' }),
      /Duplicate/
    )
    assert.equal(
      await masonDeploy(
        { ...environment(), MASON_PLATFORMS: 'ios' },
        source,
        {},
        true
      ),
      1
    )
  })
  it('still publishes Android when Ruby dependency setup fails', async () => {
    const settings = JSON.parse(readFileSync(config, 'utf8'))
    settings.branches.master.settings.tools = {
      bundle: path.join(root, 'missing-bundle')
    }
    writeFileSync(config, JSON.stringify(settings), { mode: 0o600 })
    let appleCalled = false
    const code = await masonDeploy(
      environment(),
      source,
      {
        ios: async c => {
          appleCalled = true
          return await builder(c)
        },
        android: builder
      },
      true
    )
    assert.equal(code, 1)
    assert.equal(appleCalled, false)
    const result = JSON.parse(
      readFileSync(environment().MASON_RESULT_FILE!, 'utf8')
    )
    assert.equal(result.messages.includes('android uploaded'), true)
    assert.equal(
      result.messages.includes('ios build failed; no package was published'),
      true
    )
  })
  it('prepares Ruby before publishing Apple packages', async () => {
    const bundle = path.join(root, 'fixture-bundle')
    writeFileSync(bundle, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const settings = JSON.parse(readFileSync(config, 'utf8'))
    settings.branches.master.settings.tools = { bundle }
    writeFileSync(config, JSON.stringify(settings), { mode: 0o600 })
    assert.equal(
      await masonDeploy(
        environment(),
        source,
        { ios: builder, android: builder },
        true
      ),
      0
    )
  })
  it('rejects invalid environment through the executable deploy entry', async () => {
    const child = spawn(
      process.execPath,
      ['-r', 'sucrase/register', 'scripts/deploy/mason.ts'],
      {
        cwd: path.resolve('.'),
        env: {
          PATH: process.env.PATH,
          NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE
        },
        stdio: 'ignore'
      }
    )
    assert.equal(await new Promise(resolve => child.once('exit', resolve)), 1)
  })
  it('executes Node 24 bootstrap, dependency failure and cancellation', async () => {
    assert.equal(await bootstrap('process.exitCode=0'), 0)
    assert.equal(await bootstrap('process.exitCode=0', 2), 1)
    assert.equal(await bootstrap('process.exitCode=3'), 3)
    assert.equal(
      await bootstrap(
        'process.on("SIGTERM",()=>process.exit(2)); console.log("ready"); setInterval(()=>{},1000)',
        0,
        true
      ),
      2
    )
  })
})
