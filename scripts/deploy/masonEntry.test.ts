import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import {
  appIdOf,
  applyDevelopIdentity,
  buildIos,
  buildTv,
  compileAndroid,
  DEVELOP_APP,
  provenanceEnvironment,
  releaseIos,
  seatEnvironment,
  setup,
  signAndroid,
  STABLE_APP,
  TV_APP
} from '../../Masonfile'
import { app, fixtureSettings, testRoot } from './config.test'
import { masonDeploy } from './mason'
import { buildEnvironment } from './prepare'
import { type Builder, nativeNumber } from './runner'
import { gitFixture } from './source.test'
import { type Endpoint, endpoint } from './upload.test'

let root: string, source: string, config: string, service: Endpoint

function regexEscape(value: string): string {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}
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
  it('builds iOS on Nomac and signs the Android release on the signing node', async () => {
    const stages: Record<string, unknown> = {}
    const workflows: Record<string, Record<string, unknown>> = {}
    setup({
      apiVersion(version) {
        assert.equal(version, 1)
      },
      buildNumber(key, options) {
        assert.ok([STABLE_APP, TV_APP].includes(key))
        assert.equal(options?.format, 'YYMMDDCC')
        assert.equal(options?.timeZone, 'America/Los_Angeles')
      },
      parallel() {
        assert.fail('the build stages belong to the build workflow')
      },
      workflow(name, options, declare) {
        const recorded: Record<string, unknown> = { options }
        declare({
          stage(stageName, stageOptions) {
            recorded[stageName] = stageOptions
          },
          parallel(groupName, members, groupOptions) {
            assert.equal(groupName, 'build')
            assert.equal(groupOptions?.failFast, false)
            Object.assign(stages, members)
          }
        })
        workflows[name] = recorded
      }
    })
    const ios = stages.ios as Array<{
      name: string
      on: { type: string }
      tools?: { node: string; xcode: string; rust: string }
      apple: { distribution: string; app: string }
      checkout?: boolean | { depth: number }
      when?: { branch?: string[]; params?: Record<string, string> }
    }>
    const android = stages.android as Array<{
      name: string
      on: { type: string; labels?: readonly string[] }
      tools: {
        node?: string
        android?: string[]
        rust?: string
        apt?: string[]
        androidLicenses?: string
      }
      publishes?: string[]
    }>
    assert.equal(ios[0]?.name, 'archive')
    assert.equal(ios[0]?.on.type, 'nomac')
    assert.equal(ios[0]?.apple.distribution, 'adHoc')
    assert.equal(ios[0]?.apple.app, 'app.teamstation.app')
    assert.equal(ios[0]?.tools?.node, '24')
    assert.equal(ios[0]?.tools?.xcode, '27.0')
    assert.equal(ios[0]?.tools?.rust, '1.98.0')
    assert.equal(ios[1]?.name, 'release')
    assert.equal(ios[1]?.on.type, 'macos-arm64')
    assert.equal(ios[1]?.apple.distribution, 'appStore')
    assert.deepEqual(ios[1]?.checkout, { depth: 1 })
    assert.deepEqual(ios[1]?.when, {
      branch: ['master'],
      params: { seat: 'production' }
    })
    assert.deepEqual(Object.keys(workflows), ['build', 'tvos'])
    assert.deepEqual(workflows.build?.options, {
      params: {
        seat: {
          type: 'choice',
          choices: ['production', '1', '2', '3', '4', '5', '6', '7', '8'],
          default: 'production'
        }
      }
    })
    assert.equal(android[0]?.name, 'compile')
    assert.equal(android[0]?.on.type, 'do-linux')
    assert.equal(android[0]?.tools.rust, '1.98.0')
    assert.deepEqual(android[0]?.tools.apt, ['build-essential'])
    assert.deepEqual(android[0]?.tools.android, [
      'platforms;android-37.0',
      'build-tools;37.0.0',
      'ndk;27.1.12297006',
      'cmake;3.22.1'
    ])
    assert.equal(android[1]?.name, 'sign')
    assert.equal(android[1]?.on.type, 'macos-arm64')
    assert.deepEqual(android[1]?.on.labels, ['android-signing'])
    assert.equal(android[1]?.tools.androidLicenses, 'accept')
    assert.deepEqual(android[1]?.publishes, ['app.teamstation.app'])
    const commands: string[] = []
    const ctx = {
      run: {
        branch: 'master',
        commit: '0123456789abcdef0123456789abcdef01234567',
        params: { seat: 'production' }
      },
      async sh(
        command: string,
        options?: {
          env?: {
            MASON_BUILD_NUMBER?: string
            MASON_APP_VERSION?: string
            TS_API_BASE_URL?: string
            TS_BUILD_INFO?: string
          }
        }
      ) {
        commands.push(command)
        if (options?.env?.MASON_BUILD_NUMBER != null)
          commands.push(`build-number:${options.env.MASON_BUILD_NUMBER}`)
        if (options?.env?.MASON_APP_VERSION != null)
          commands.push(`app-version:${options.env.MASON_APP_VERSION}`)
        if (options?.env?.TS_API_BASE_URL != null)
          commands.push(`api:${options.env.TS_API_BASE_URL}`)
        if (options?.env?.TS_BUILD_INFO != null)
          commands.push(`info:${options.env.TS_BUILD_INFO}`)
        return { code: 0, stdout: '', stderr: '' }
      },
      getBuildNumber(key: string) {
        assert.equal(key, STABLE_APP)
        return '26103101'
      },
      async stash(name: string, paths?: string | string[]) {
        const listed = Array.isArray(paths) ? paths.join(',') : (paths ?? '')
        commands.push(`stash:${name}:${listed}`)
      },
      async unstash(name: string) {
        commands.push(`unstash:${name}`)
      },
      artifacts: {
        async save(name: string) {
          commands.push(`save:${name}`)
        }
      },
      fs: {
        async glob(pattern: string) {
          commands.push(`glob:${pattern}`)
          return ['android/app/build/outputs/apk/release/app-release.apk']
        }
      },
      async publish(options: { platform: string; path: string }) {
        commands.push(`publish:${options.platform}:${options.path}`)
      },
      apple: {
        async archive(options: {
          scheme: string
          version?: string
          buildNumber?: string
          xcargs?: string[]
          env?: {
            CARGO_HOME?: string
            TS_API_BASE_URL?: string
            TS_BUILD_INFO?: string
          }
        }) {
          commands.push(
            `archive:${options.scheme}:${options.version ?? ''}:${options.buildNumber ?? ''}`
          )
          commands.push(`xcargs:${(options.xcargs ?? []).join(' ')}`)
          commands.push(`cargo:${options.env?.CARGO_HOME ?? ''}`)
          if (options.env?.TS_API_BASE_URL != null)
            commands.push(`api:${options.env.TS_API_BASE_URL}`)
          if (options.env?.TS_BUILD_INFO != null)
            commands.push(`info:${options.env.TS_BUILD_INFO}`)
          return {
            archive: 'build/TeamStation.xcarchive',
            ipa: 'build/TeamStation.ipa',
            dsyms: 'build/TeamStation.dSYM'
          }
        }
      }
    }
    await buildIos(ctx)
    await compileAndroid(ctx)
    await signAndroid(ctx)
    const log = commands.join('\n')
    assert.match(log, /\.mason-tools\/node_modules\/\.bin\/socket npm ci/)
    assert.match(log, /node scripts\/deploy\/patchExpoModulesJsi\.mjs/)
    assert.match(log, /pod install/)
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version
    assert.match(
      log,
      new RegExp(`archive:TeamStation:${regexEscape(version)}:26103101`)
    )
    assert.match(log, new RegExp(`app-version:${regexEscape(version)}`))
    assert.match(
      log,
      /android\.defaultConfig\.versionName = System\.getenv\('MASON_APP_VERSION'\)/
    )
    assert.match(log, /xcargs:SWIFT_ENABLE_EXPLICIT_MODULES=NO/)
    assert.match(log, /cargo:.*\.mason\/tools\/rust\/1\.98\.0\/cargo/)
    assert.match(log, /publish:ios:build\/TeamStation\.ipa/)
    assert.match(
      log,
      /publish:android:android\/app\/build\/outputs\/apk\/release\/app-release\.apk/
    )
    assert.equal(log.includes('CODE_SIGNING_ALLOWED'), false)
    assert.match(log, /cargo install cargo-ndk/)
    assert.match(log, /MASON_BUILD_NUMBER/)
    assert.match(log, /build-number:26103101/)
    assert.match(
      log,
      /--init-script mason-version\.gradle :app:assembleRelease/
    )
    assert.equal(log.includes('-PversionCode'), false)
    assert.match(log, /stash:ios-adhoc:build\/TeamStation\.ipa/)
    assert.match(log, /stash:android-release/)
    assert.match(log, /unstash:android-release/)
    assert.match(log, /teamstation-sign-release-apk/)
    assert.match(log, /save:ios-ipa/)
    assert.match(log, /save:android-apk/)
    // A production build leaves the app's own server alone.
    assert.equal(log.includes('api:'), false)
    const recorded = commands
      .filter(line => line.startsWith('info:'))
      .map(
        line =>
          JSON.parse(line.slice('info:'.length)) as {
            app: string
            version: string
            buildNumber: string
            branch: string
            commit: string
            builtAt: string
          }
      )
    assert.equal(recorded.length, 2)
    for (const info of recorded) {
      assert.equal(info.app, 'TeamStation')
      assert.equal(info.version, version)
      assert.equal(info.buildNumber, '26103101')
      assert.equal(info.branch, 'master')
      assert.equal(info.commit, '0123456789abcdef0123456789abcdef01234567')
      assert.equal(Number.isNaN(Date.parse(info.builtAt)), false)
    }
  })

  it('points both platforms at a development seat', async () => {
    const apis: string[] = []
    const published: string[] = []
    const workspace = mkdtempSync(path.join(tmpdir(), 'seat-app-'))
    const files: Record<string, string> = {
      'android/app/build.gradle': 'applicationId "app.teamstation.app"\n',
      'android/app/src/main/res/values/strings.xml':
        '<string name="app_name">TeamStation</string>\n',
      'ios/TeamStation.xcodeproj/project.pbxproj':
        'PRODUCT_BUNDLE_IDENTIFIER = app.teamstation.app;\nPRODUCT_NAME = TeamStation;\n',
      'ios/TeamStation/Info.plist':
        '<key>CFBundleDisplayName</key>\n\t<string>TeamStation</string>\n<key>CFBundleURLName</key>\n\t\t\t<string>app.teamstation.app</string>\n',
      'package.json': JSON.stringify({ version: '1.2.3' })
    }
    for (const [file, text] of Object.entries(files)) {
      const full = path.join(workspace, file)
      mkdirSync(path.dirname(full), { recursive: true })
      writeFileSync(full, text)
    }
    const ctx = {
      workspace,
      run: {
        branch: 'paul/example',
        commit: '89abcdef0123456789abcdef0123456789abcdef',
        params: { seat: '3' }
      },
      async sh(
        _command: string,
        options?: { env?: { TS_API_BASE_URL?: string } }
      ) {
        if (options?.env?.TS_API_BASE_URL != null)
          apis.push(`gradle:${options.env.TS_API_BASE_URL}`)
        return { code: 0, stdout: '', stderr: '' }
      },
      getBuildNumber(key: string) {
        published.push(key)
        return '26110301'
      },
      async stash() {},
      artifacts: {
        async save() {}
      },
      async publish(options: { app: string }) {
        published.push(options.app)
      },
      apple: {
        async archive(options: { env?: { TS_API_BASE_URL?: string } }) {
          apis.push(`xcode:${options.env?.TS_API_BASE_URL ?? ''}`)
          return {
            archive: 'build/TeamStation.xcarchive',
            ipa: 'build/TeamStation.ipa',
            dsyms: 'build/TeamStation.dSYM'
          }
        }
      }
    }
    try {
      await buildIos(ctx)
      await compileAndroid(ctx)
      assert.deepEqual(apis, [
        'xcode:https://develop3.teamstation.app/api/v1',
        'gradle:https://develop3.teamstation.app/api/v1'
      ])
      assert.deepEqual(published, [DEVELOP_APP, DEVELOP_APP, DEVELOP_APP])
      assert.match(
        readFileSync(path.join(workspace, 'android/app/build.gradle'), 'utf8'),
        /applicationId "app\.teamstation\.develop"/
      )
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('refuses a bundle that has no branch or commit to show', () => {
    const run = { branch: 'master', commit: 'abc' }
    assert.throws(
      () =>
        provenanceEnvironment({ run: { ...run, branch: '' } }, '1.0.0', '2'),
      /no branch or commit/
    )
    assert.throws(
      () =>
        provenanceEnvironment({ run: { ...run, commit: '' } }, '1.0.0', '2'),
      /no branch or commit/
    )
  })

  it('names no server for production or a run with no seat, and refuses an unknown one', () => {
    const seated = (
      params?: Record<string, string | number | boolean>
    ): Record<string, string> =>
      seatEnvironment({ run: { branch: 'master', params } })
    assert.deepEqual(seated({ seat: 'production' }), {})
    assert.deepEqual(seated(), {})
    assert.deepEqual(seated({ seat: '8' }), {
      TS_API_BASE_URL: 'https://develop8.teamstation.app/api/v1',
      TS_APP_ORIGIN: 'https://develop8.teamstation.app'
    })
    const developServer = {
      TS_API_BASE_URL: 'https://develop.teamstation.app/api/v1',
      TS_APP_ORIGIN: 'https://develop.teamstation.app'
    }
    assert.deepEqual(
      seatEnvironment({
        run: { branch: 'develop', params: { seat: 'production' } }
      }),
      developServer
    )
    assert.deepEqual(
      seatEnvironment({
        run: { branch: 'paul/example', params: { seat: 'production' } }
      }),
      developServer
    )
    assert.deepEqual(
      seatEnvironment({
        run: { branch: 'paul/example', params: { seat: '3' } }
      }),
      {
        TS_API_BASE_URL: 'https://develop3.teamstation.app/api/v1',
        TS_APP_ORIGIN: 'https://develop3.teamstation.app'
      }
    )
    assert.throws(() => seated({ seat: '9' }), /Unknown seat 9/)
    assert.throws(() => seated({ seat: 3 }), /Unknown seat 3/)
  })

  it('publishes the develop app for the develop branch and for a seat', () => {
    assert.equal(appIdOf({ branch: 'master', seat: 'production' }), STABLE_APP)
    assert.equal(appIdOf(), STABLE_APP)
    assert.equal(appIdOf({ branch: 'develop' }), DEVELOP_APP)
    assert.equal(
      appIdOf({ branch: 'develop', seat: 'production' }),
      DEVELOP_APP
    )
    assert.equal(appIdOf({ branch: 'paul/example' }), DEVELOP_APP)
    assert.equal(
      appIdOf({ branch: 'paul/example', seat: 'production' }),
      DEVELOP_APP
    )
    assert.equal(appIdOf({ branch: 'paul/example', seat: '2' }), DEVELOP_APP)
    assert.equal(appIdOf({ branch: 'master', seat: '1' }), DEVELOP_APP)
    assert.equal(appIdOf({ branch: '', seat: '' }), STABLE_APP)
    const recorded: string[] = []
    setup({
      branch: 'develop',
      params: { seat: 'production' },
      apiVersion() {},
      buildNumber(key) {
        recorded.push(key)
      },
      parallel() {
        assert.fail('the build stages belong to the build workflow')
      },
      workflow(_name, _options, declare) {
        declare({
          stage() {},
          parallel(_group, members) {
            const ios = (
              members as {
                ios: Array<{ apple: { app: string }; publishes?: string[] }>
              }
            ).ios
            const android = (
              members as { android: Array<{ publishes?: string[] }> }
            ).android
            recorded.push(ios[0]?.apple.app ?? '')
            recorded.push((ios[0]?.publishes ?? []).join(','))
            recorded.push((android[1]?.publishes ?? []).join(','))
            recorded.push(ios[1]?.apple.app ?? '')
          }
        })
      }
    })
    assert.deepEqual(recorded, [
      DEVELOP_APP,
      DEVELOP_APP,
      DEVELOP_APP,
      DEVELOP_APP,
      STABLE_APP,
      TV_APP
    ])
  })

  it('refuses a develop build whose workspace is missing', async () => {
    const ctx = {
      run: { branch: 'develop', params: { seat: 'production' } },
      async sh() {
        return { code: 0, stdout: '', stderr: '' }
      }
    }
    await assert.rejects(async () => {
      await buildIos(ctx)
    }, /needs its workspace/)
  })

  it('rewrites the stable app id to the develop app, and only once', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'develop-app-'))
    try {
      const files: Record<string, string> = {
        'android/app/build.gradle': 'applicationId "app.teamstation.app"\n',
        'android/app/src/main/res/values/strings.xml':
          '<string name="app_name">TeamStation</string>\n',
        'ios/TeamStation.xcodeproj/project.pbxproj':
          'PRODUCT_BUNDLE_IDENTIFIER = app.teamstation.app.tests;\nPRODUCT_BUNDLE_IDENTIFIER = app.teamstation.app;\nPRODUCT_NAME = TeamStation;\nPRODUCT_BUNDLE_IDENTIFIER = app.teamstation.app;\nPRODUCT_NAME = TeamStation;\n',
        'ios/TeamStation/Info.plist':
          '<key>CFBundleDisplayName</key>\n\t<string>TeamStation</string>\n<key>CFBundleURLName</key>\n\t\t\t<string>app.teamstation.app</string>\n'
      }
      for (const [file, text] of Object.entries(files)) {
        const full = path.join(root, file)
        mkdirSync(path.dirname(full), { recursive: true })
        writeFileSync(full, text)
      }
      applyDevelopIdentity(root)
      applyDevelopIdentity(root)
      const gradle = readFileSync(
        path.join(root, 'android/app/build.gradle'),
        'utf8'
      )
      const project = readFileSync(
        path.join(root, 'ios/TeamStation.xcodeproj/project.pbxproj'),
        'utf8'
      )
      assert.match(gradle, /applicationId "app\.teamstation\.develop"/)
      assert.match(
        project,
        /PRODUCT_BUNDLE_IDENTIFIER = app\.teamstation\.app\.tests;/
      )
      assert.equal(
        project.match(/PRODUCT_BUNDLE_IDENTIFIER = app\.teamstation\.develop;/g)
          ?.length,
        2
      )
      assert.equal(
        project.match(/PRODUCT_NAME = "TeamStation Develop";/g)?.length,
        2
      )
      assert.equal(
        project.includes('PRODUCT_BUNDLE_IDENTIFIER = app.teamstation.app;'),
        false
      )
      assert.throws(() => {
        applyDevelopIdentity(path.join(root, 'missing'))
      }, /is missing/)
      writeFileSync(
        path.join(root, 'android/app/build.gradle'),
        'applicationId "app.example.other"\n'
      )
      assert.throws(() => {
        applyDevelopIdentity(root)
      }, /is missing/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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
      run: {
        branch: 'master',
        commit: '0123456789abcdef0123456789abcdef01234567'
      },
      getBuildNumber() {
        return '26103101'
      },
      artifacts: {
        async save(name: string) {
          commands.push(`save:${name}`)
        }
      },
      apple: {
        async archive() {
          return {
            archive: 'build/TeamStation.xcarchive',
            ipa: 'build/TeamStation.ipa',
            dsyms: 'build/TeamStation.dSYM'
          }
        }
      },
      async stash() {},
      async publish() {}
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

  it('stashes the ad hoc IPA as a path inside the workspace', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'mason-stash-'))
    try {
      writeFileSync(
        path.join(workspace, 'package.json'),
        JSON.stringify({ version: '9.8.7' })
      )
      let stashed = ''
      let archivedVersion = ''
      await buildIos({
        workspace,
        run: {
          branch: 'master',
          commit: '0123456789abcdef0123456789abcdef01234567'
        },
        async sh() {
          return { code: 0, stdout: '', stderr: '' }
        },
        getBuildNumber() {
          return '26103101'
        },
        async stash(_name: string, paths: string) {
          stashed = paths
        },
        artifacts: {
          async save() {}
        },
        async publish() {},
        apple: {
          async archive(options: { version?: string }) {
            archivedVersion = options.version ?? ''
            return {
              archive: path.join(workspace, 'build/TeamStation.xcarchive'),
              ipa: path.join(workspace, 'build/mason-archive/TeamStation.ipa'),
              dsyms: path.join(workspace, 'build/TeamStation.dSYM')
            }
          }
        }
      })
      assert.equal(archivedVersion, '9.8.7')
      assert.equal(stashed, 'build/mason-archive/TeamStation.ipa')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('refuses a package.json version Mason cannot write', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'mason-version-'))
    try {
      writeFileSync(
        path.join(workspace, 'package.json'),
        JSON.stringify({ version: '1.0.0-beta' })
      )
      await assert.rejects(async () => {
        await buildIos({
          workspace,
          async sh() {
            return { code: 0, stdout: '', stderr: '' }
          },
          getBuildNumber() {
            return '26103101'
          }
        })
      }, /package.json version must be one to three numeric components/)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('re-signs the stashed IPA for the App Store and uploads it', async () => {
    const commands: string[] = []
    await releaseIos({
      async unstash(name: string) {
        commands.push(`unstash:${name}`)
      },
      fs: {
        async glob() {
          return ['build/mason-archive/TeamStation.ipa']
        }
      },
      artifacts: {
        async save(name: string, paths: string) {
          commands.push(`save:${name}:${paths}`)
        }
      },
      apple: {
        async resign(options: {
          path: string
          version?: string
          buildNumber?: string
        }) {
          commands.push(
            `resign:${options.path}:${options.version ?? ''}:${options.buildNumber ?? ''}`
          )
          return { ipa: 'build/mason-archive/TeamStation-appStore.ipa' }
        },
        async testflight(options: {
          path: string
          groups?: string[]
          usesNonExemptEncryption?: boolean
          whatToTest?: string
        }) {
          commands.push(
            `testflight:${options.path}:${(options.groups ?? []).join(',')}:${String(options.usesNonExemptEncryption)}:${options.whatToTest ?? ''}`
          )
          return {
            buildId: '1',
            version: '1.0',
            buildNumber: '26103101',
            state: 'VALID'
          }
        }
      }
    })
    const log = commands.join('\n')
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version
    assert.match(log, /unstash:ios-adhoc/)
    assert.match(
      log,
      new RegExp(
        `resign:build/mason-archive/TeamStation\\.ipa:${regexEscape(version)}:\\n`
      )
    )
    assert.match(
      log,
      /save:ios-appstore:build\/mason-archive\/TeamStation-appStore\.ipa/
    )
    assert.match(
      log,
      /testflight:build\/mason-archive\/TeamStation-appStore\.ipa:TeamStation testers:false:TeamStation production build\./
    )
  })

  it('stops when the stashed iOS build has no IPA', async () => {
    await assert.rejects(async () => {
      await releaseIos({
        async unstash() {},
        fs: {
          async glob() {
            return []
          }
        }
      })
    }, /No ad hoc IPA was stashed/)
  })
})

describe('request-only Apple TV workflow', () => {
  for (const branch of ['master', 'develop']) {
    it(`only accepts requests on ${branch}`, () => {
      setup({
        branch,
        apiVersion() {},
        buildNumber() {},
        parallel() {
          assert.fail('unexpected parallel workflow')
        },
        workflow(name, options, declare) {
          if (name === 'build') {
            assert.equal(options.triggers, undefined)
            return
          }
          assert.equal(name, 'tvos')
          assert.deepEqual(options.triggers, [{ request: true }])
          assert.equal(options.params?.seat.default, 'production')
          declare({
            parallel() {
              assert.fail('unexpected parallel stage')
            },
            stage(name, stage) {
              assert.equal(name, 'archive')
              assert.deepEqual(stage.apple, {
                distribution: 'adHoc',
                app: TV_APP,
                platform: 'tvos'
              })
              assert.deepEqual(stage.publishes, [TV_APP])
              assert.deepEqual(stage.buildNumbers, [TV_APP])
              assert.equal(stage.run, buildTv)
            }
          })
        }
      })
    })
  }

  for (const [branch, seat, host] of [
    ['master', 'production', 'app'],
    ['develop', 'production', 'develop'],
    ['master', '2', 'develop2']
  ]) {
    it(`archives a standalone TV app for ${branch}/${seat}`, async () => {
      const commands: Array<[string, string | undefined]> = []
      const saved: string[] = []
      let published = false
      await buildTv({
        run: { branch, commit: '0'.repeat(40), params: { seat } },
        async sh(command, options) {
          commands.push([command, options?.cwd])
          return { code: 0, stdout: '', stderr: '' }
        },
        getBuildNumber(app) {
          assert.equal(app, TV_APP)
          return '26110601'
        },
        async stash() {
          assert.fail('no release stash')
        },
        async unstash() {},
        fs: {
          async glob() {
            return []
          }
        },
        artifacts: {
          async save(name) {
            saved.push(name)
          },
          async fetch() {
            return []
          }
        },
        apple: {
          async archive(options) {
            assert.equal(
              options.workspace,
              'appletv/ios/TeamStationTV.xcworkspace'
            )
            assert.equal(options.scheme, 'TeamStationTV')
            assert.equal(options.configuration, 'Release')
            assert.equal(options.buildNumber, '26110601')
            assert.match(options.version ?? '', /^\d+(\.\d+){0,2}$/)
            assert.deepEqual(options.xcargs, [
              'SWIFT_ENABLE_EXPLICIT_MODULES=NO',
              `TV_API_BASE_URL=https://${host}.teamstation.app/api/v1`
            ])
            return { archive: 'tv.xcarchive', ipa: 'tv.ipa', dsyms: 'tv.dSYM' }
          },
          async resign() {
            assert.fail('no re-signing')
          },
          async testflight() {
            assert.fail('no TestFlight submission')
          }
        },
        async publish(options) {
          assert.deepEqual(options, {
            app: TV_APP,
            platform: 'tvos',
            path: 'tv.ipa'
          })
          published = true
        }
      })
      assert.deepEqual(
        commands.filter(([cmd]) => cmd.includes('socket npm ci')),
        [
          ['.mason-tools/node_modules/.bin/socket npm ci', undefined],
          ['.mason-tools/node_modules/.bin/socket npm ci', 'appletv']
        ]
      )
      assert.deepEqual(commands.at(-1), ['pod install', 'appletv/ios'])
      assert.deepEqual(saved, ['tvos-ipa', 'tvos-dsym'])
      assert.ok(published)
    })
  }

  it('does not publish when tvOS export fails', async () => {
    await assert.rejects(
      buildTv({
        run: { branch: 'master', commit: '0'.repeat(40) },
        async sh() {
          return { code: 0, stdout: '', stderr: '' }
        },
        getBuildNumber() {
          return '26110601'
        },
        async stash() {},
        async unstash() {},
        fs: {
          async glob() {
            return []
          }
        },
        artifacts: {
          async save() {
            assert.fail('cannot save a failed export')
          },
          async fetch() {
            return []
          }
        },
        apple: {
          async archive() {
            return { archive: 'tv.xcarchive', dsyms: 'tv.dSYM' }
          },
          async resign() {
            assert.fail('no re-signing')
          },
          async testflight() {
            assert.fail('no TestFlight')
          }
        },
        async publish() {
          assert.fail('cannot publish a failed export')
        }
      }),
      /No tvOS IPA was exported/
    )
  })
})
