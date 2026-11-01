import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import { buildAndroid, buildIos, setup } from '../../Masonfile'
import { app, fixtureSettings, testRoot } from './config.test'
import { masonDeploy } from './mason'
import { buildEnvironment } from './prepare'
import { type Builder, nativeNumber } from './runner'
import { gitFixture } from './source.test'
import { type Endpoint, endpoint } from './upload.test'

let root: string, source: string, config: string, service: Endpoint
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
function saveConfig(iosOnly = false, credentialEnv?: string): void {
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
    ...(credentialEnv == null
      ? { tokenFile: path.join(root, 'token.json') }
      : { credentialEnv })
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
    delete process.env.FIXTURE_UPLOAD_CREDENTIAL
    await service.close()
    rmSync(root, { recursive: true, force: true })
  })
  it('builds and publishes both platforms using only the Mason environment secret', async () => {
    process.env.FIXTURE_UPLOAD_CREDENTIAL = readFileSync(
      path.join(root, 'token.json'),
      'utf8'
    )
    rmSync(path.join(root, 'token.json'))
    saveConfig(false, 'FIXTURE_UPLOAD_CREDENTIAL')
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
    )
    assert.equal(result.status, 'succeeded')
    assert.equal(service.requests.length, 2)
    assert(
      service.requests.every(request =>
        request.body.includes('synthetic-token')
      )
    )
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
  it('passes APP_SERVER_URL from the job environment into deployment', async () => {
    const verify: Builder = async context => {
      assert.equal(
        buildEnvironment(context).TS_API_BASE_URL,
        'https://preview.example.test/api/v1'
      )
      return await builder(context)
    }
    assert.equal(
      await masonDeploy(
        { ...environment(), APP_SERVER_URL: 'preview.example.test' },
        source,
        { ios: verify, android: verify },
        false
      ),
      0
    )
    assert.equal(
      await masonDeploy(
        { ...environment(), APP_SERVER_URL: 'http://preview.example.test' },
        source,
        { ios: verify },
        false
      ),
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
      result.messages.includes(
        'ios build failed (missing-bundle could not start); no package was published'
      ),
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
})

describe('TeamStation pipeline Masonfile', () => {
  it('builds iOS on the Mac node and Android on the Linux pool', async () => {
    const stages: Record<
      string,
      {
        on: { type: string }
        tools: {
          node: string
          android?: string[]
          rust?: string
          apt?: string[]
        }
        run: (ctx: {
          sh: (command: string, options?: { cwd?: string }) => Promise<unknown>
          getBuildNumber: (key: string) => string
          artifacts: { save: (name: string, paths: string) => Promise<void> }
        }) => Promise<void>
      }
    > = {}
    setup({
      apiVersion(version) {
        assert.equal(version, 1)
      },
      buildNumber(key, options) {
        assert.equal(key, 'app.teamstation.app')
        assert.equal(options?.format, 'YYMMDDCC')
        assert.equal(options?.timeZone, 'America/Los_Angeles')
      },
      parallel(name, members) {
        assert.equal(name, 'build')
        Object.assign(stages, members)
      }
    })
    assert.equal(stages.ios?.on.type, 'macos-arm64')
    assert.equal(stages.android?.on.type, 'do-linux')
    assert.equal(stages.ios?.tools.node, '24')
    assert.equal(stages.android?.tools.rust, '1.98.0')
    assert.deepEqual(stages.android?.tools.apt, ['build-essential'])
    assert.deepEqual(stages.android?.tools.android, [
      'platforms;android-37.0',
      'build-tools;37.0.0',
      'ndk;27.1.12297006',
      'cmake;3.22.1'
    ])
    const commands: string[] = []
    const ctx = {
      async sh(command: string) {
        commands.push(command)
        return { code: 0, stdout: '', stderr: '' }
      },
      getBuildNumber(key: string) {
        assert.equal(key, 'app.teamstation.app')
        return '26103101'
      },
      artifacts: {
        async save(name: string) {
          commands.push(`save:${name}`)
        }
      }
    }
    await buildIos(ctx)
    await buildAndroid(ctx)
    const log = commands.join('\n')
    assert.match(log, /\.mason-tools\/node_modules\/\.bin\/socket npm ci/)
    assert.match(log, /pod install/)
    assert.match(log, /xcodebuild archive/)
    assert.match(log, /CODE_SIGNING_ALLOWED=NO/)
    assert.match(log, /CURRENT_PROJECT_VERSION=26103101/)
    assert.match(log, /cargo install cargo-ndk/)
    assert.match(log, /assembleRelease -PversionCode=26103101/)
    assert.match(log, /save:ios-archive/)
    assert.match(log, /save:android-apk/)
  })

  it('installs with npm when Socket has no quota or no token', async () => {
    const commands: string[] = []
    const ctx = {
      async sh(command: string) {
        commands.push(command)
        if (command.includes('socket npm ci')) {
          return {
            code: 1,
            stdout: '',
            stderr: 'Socket API Request failed (429): Insufficient quota'
          }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
      getBuildNumber() {
        return '26103101'
      },
      artifacts: {
        async save(name: string) {
          commands.push(`save:${name}`)
        }
      }
    }
    await buildIos(ctx)
    assert.ok(commands.includes('npm ci'))
  })

  it('stops when Socket reports a failure other than quota or a missing token', async () => {
    const commands: string[] = []
    const ctx = {
      async sh(command: string) {
        commands.push(command)
        if (command.includes('socket npm ci')) {
          return { code: 1, stdout: '', stderr: 'found 2 alerts' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
      getBuildNumber() {
        return '26103101'
      },
      artifacts: {
        async save() {}
      }
    }
    await assert.rejects(async () => {
      await buildIos(ctx)
    }, /socket npm ci failed/)
    assert.equal(commands.includes('npm ci'), false)
  })
})
