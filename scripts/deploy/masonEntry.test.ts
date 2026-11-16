import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import {
  chmodSync,
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
  CAMERAMAN_APP,
  CAMERAMAN_DEVELOP_APP,
  compileAndroid,
  DEVELOP_APP,
  DIRECTOR_APP,
  DIRECTOR_DEVELOP_APP,
  DISTRIBUTOR_APP,
  DISTRIBUTOR_DEVELOP_APP,
  MAPS_KEY_CHECK,
  PLAY_NOTES_LIMIT,
  PLAY_PUBLISHER_SECRET,
  PLAY_RELEASE_NOTES,
  PLAY_TRACK,
  playAccessToken,
  playAssertion,
  provenanceEnvironment,
  RELEASE_KEYSTORE_SECRET,
  RELEASE_PASSWORD_SECRET,
  releaseIos,
<<<<<<< HEAD
  releasePlayTesting,
  releaseToPlayTrack,
=======
  SEAT_PARAM,
>>>>>>> 2bebf4815 (Let a develop build's server be set by a deep link or About TeamStation, and a Mason build name its host)
  seatEnvironment,
  setup,
  signAabScript,
  signAndroid,
  signApkScript,
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
        assert.ok(
          [
            STABLE_APP,
            TV_APP,
            DIRECTOR_APP,
            DIRECTOR_DEVELOP_APP,
            CAMERAMAN_APP,
            CAMERAMAN_DEVELOP_APP,
            DISTRIBUTOR_APP,
            DISTRIBUTOR_DEVELOP_APP
          ].includes(key)
        )
        assert.equal(options?.format, 'YYMMDDCC')
        assert.equal(options?.timeZone, 'America/Los_Angeles')
      },
      parallel() {
        assert.fail('the build stages belong to the build workflow')
      },
      workflow(name, options, declare) {
        const recorded: Record<string, unknown> = { options }
        if (name === 'build') {
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
        }
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
      secrets?: string[]
    }>
    assert.equal(ios[0]?.name, 'archive')
    assert.equal(ios[0]?.on.type, 'nomac')
    assert.equal(ios[0]?.apple.distribution, 'adHoc')
    assert.equal(ios[0]?.apple.app, 'app.teamstation.app')
    assert.equal(ios[0]?.tools?.node, '24')
    assert.equal(ios[0]?.tools?.xcode, '>=27.0 <27.3')
    assert.equal(ios[0]?.tools?.rust, '1.98.0')
    assert.equal(ios[1]?.name, 'release')
    assert.equal(ios[1]?.on.type, 'macos-arm64')
    assert.equal(ios[1]?.apple.distribution, 'appStore')
    assert.deepEqual(ios[1]?.checkout, { depth: 1 })
    assert.deepEqual(ios[1]?.when, {
      branch: ['master'],
      params: { seat: 'production' }
    })
    assert.deepEqual(Object.keys(workflows), [
      'build',
      'tvos',
      'director',
      'cameraman',
      'distributor'
    ])
    assert.deepEqual(workflows.build?.options, {
      params: {
        seat: SEAT_PARAM
      }
    })
    // A seat, production, or a host name: an end-to-end stack's.
    const pattern = new RegExp(SEAT_PARAM.pattern)
    for (const seat of ['production', '1', '8', 'e2e-03.teamstation.app']) {
      assert.match(seat, pattern)
    }
    for (const seat of [
      '9',
      'evil.example.com',
      'e2e-03.teamstation.app.evil.test'
    ]) {
      assert.doesNotMatch(seat, pattern)
    }
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
    assert.deepEqual(android[0]?.secrets, ['GOOGLE_MAPS_ANDROID_API_KEY'])
    assert.deepEqual(android[1]?.secrets, [
      RELEASE_KEYSTORE_SECRET,
      RELEASE_PASSWORD_SECRET
    ])
    assert.equal(android[1]?.name, 'sign')
    assert.equal(android[1]?.on.type, 'macos-arm64')
    assert.deepEqual(android[1]?.on.labels, ['android-signing'])
    assert.equal(android[1]?.tools.androidLicenses, 'accept')
    assert.deepEqual(android[1]?.publishes, ['app.teamstation.app'])
    const play = android[2] as (typeof android)[number] & {
      checkout?: { depth: number }
      when?: { branch?: string[]; params?: Record<string, string> }
    }
    assert.equal(play?.name, 'play')
    assert.equal(play?.on.type, 'macos-arm64')
    assert.deepEqual(play?.on.labels, ['android-signing'])
    assert.deepEqual(play?.secrets, [PLAY_PUBLISHER_SECRET])
    assert.deepEqual(play?.checkout, { depth: 1 })
    assert.deepEqual(play?.when, {
      branch: ['master'],
      params: { seat: 'production' }
    })
    assert.equal(android.length, 3)
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
            TS_KEYSTORE?: string
            TS_STORE_PASSWORD?: string
          }
        }
      ) {
        commands.push(command)
        if (options?.env?.TS_KEYSTORE != null)
          commands.push(
            `signing:${options.env.TS_KEYSTORE}:${options.env.TS_STORE_PASSWORD ?? ''}`
          )
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
      secret(name: string) {
        assert.equal(name, RELEASE_PASSWORD_SECRET)
        return 'store-password'
      },
      secretFile(name: string) {
        assert.equal(name, RELEASE_KEYSTORE_SECRET)
        return '/private/secret-1'
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
          if (pattern.endsWith('.aab'))
            return ['android/app/build/outputs/bundle/release/app-release.aab']
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
    assert.match(log, /TS_APP_LINK_HOST=app.teamstation.app/)
    assert.match(
      log,
      /TS_APP_ENTITLEMENTS=TeamStation\/TeamStation.entitlements/
    )
    assert.match(log, /cargo:.*\.mason\/tools\/rust\/1\.98\.0\/cargo/)
    assert.match(log, /publish:ios:build\/TeamStation\.ipa/)
    assert.match(
      log,
      /publish:android:android\/app\/build\/outputs\/apk\/release\/app-release\.apk/
    )
    assert.equal(log.includes('CODE_SIGNING_ALLOWED'), false)
    assert.match(log, /cargo install cargo-ndk/)
    assert.match(
      log,
      /stash:play-bundle:android\/app\/build\/outputs\/bundle\/release\/app-release\.aab/
    )
    assert.match(log, /MASON_BUILD_NUMBER/)
    assert.match(log, /build-number:26103101/)
    assert.match(
      log,
      /--init-script mason-version\.gradle :app:assembleRelease\n/
    )
    assert.match(
      log,
      /--init-script mason-version\.gradle :app:bundleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a/
    )
    assert.equal(log.includes('-PversionCode'), false)
    const assemble = commands.findIndex(line =>
      line.endsWith(':app:assembleRelease')
    )
    const mapsCheck = commands.findIndex(line =>
      line.includes('com.google.android.geo.API_KEY')
    )
    const bundle = commands.findIndex(line =>
      line.includes(':app:bundleRelease')
    )
    assert.ok(assemble >= 0 && assemble < mapsCheck && mapsCheck < bundle)
    assert.equal(commands[mapsCheck], MAPS_KEY_CHECK)
    assert.match(log, /stash:ios-adhoc:build\/TeamStation\.ipa/)
    assert.match(
      log,
      /stash:android-release:.*apk\/release\/\*\.apk,.*bundle\/release\/\*\.aab/
    )
    assert.match(log, /unstash:android-release/)
    assert.equal(log.includes('.local/bin'), false)
    const apkSign = commands.indexOf(
      signApkScript('android/app/build/outputs/apk/release')
    )
    const aabSign = commands.indexOf(
      signAabScript('android/app/build/outputs/bundle/release')
    )
    assert.ok(apkSign >= 0 && aabSign > apkSign)
    for (const at of [apkSign, aabSign])
      assert.equal(commands[at + 1], 'signing:/private/secret-1:store-password')
    assert.match(log, /save:ios-ipa/)
    assert.match(log, /save:android-apk/)
    assert.match(log, /save:android-aab/)
    // Production is explicit, even without injected client configuration.
    assert.match(log, /api:https:\/\/app.teamstation.app\/api\/v1/)
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
    // The iOS archive, the Android APK and the Play bundle.
    assert.equal(recorded.length, 3)
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
        '<key>CFBundleDisplayName</key>\n\t<string>TeamStation</string>\n<key>CFBundleURLName</key>\n\t\t\t<string>app.teamstation.app</string>\n\t\t\t<array>\n\t\t\t\t<string>teamstation</string>\n\t\t\t</array>\n',
      'android/app/src/main/AndroidManifest.xml':
        '            <data android:scheme="teamstation" />\n',
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
        command: string,
        options?: { env?: { TS_API_BASE_URL?: string } }
      ) {
        if (options?.env?.TS_API_BASE_URL != null)
          apis.push(`gradle:${options.env.TS_API_BASE_URL}`)
        if (command.includes('com.google.android.geo.API_KEY'))
          apis.push('maps-key-check')
        return { code: 0, stdout: '', stderr: '' }
      },
      getBuildNumber(key: string) {
        published.push(key)
        return '26110301'
      },
      async stash(name: string) {
        apis.push(`stash:${name}`)
      },
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
        'stash:ios-adhoc',
        'gradle:https://develop3.teamstation.app/api/v1',
        'maps-key-check',
        'stash:android-release'
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

  it('checks the release APK manifest for exactly the Maps key, naming each failure', () => {
    const key = 'AIzaTestOnlyMapsKey0123456789abcdefghij'
    const root = mkdtempSync(path.join(tmpdir(), 'maps-key-check-'))
    const tools = path.join(root, 'sdk', 'build-tools')
    const apks = path.join(root, 'android', 'app/build/outputs/apk/release')
    const manifest = (value: string): string =>
      [
        '      E: meta-data (line=73)',
        '        A: http://schemas.android.com/apk/res/android:name(0x01010003)="com.google.android.geo.API_KEY" (Raw: "com.google.android.geo.API_KEY")',
        `        A: http://schemas.android.com/apk/res/android:value(0x01010024)="${value}" (Raw: "${value}")`,
        '      E: activity (line=76)'
      ].join('\n')
    const aapt2 = (version: string, body: string): void => {
      mkdirSync(path.join(tools, version), { recursive: true })
      const file = path.join(tools, version, 'aapt2')
      writeFileSync(file, `#!/bin/sh\n${body}\n`)
      chmodSync(file, 0o755)
    }
    const check = (
      env: Record<string, string | undefined>
    ): { status: number | null; out: string } => {
      const result = spawnSync('sh', ['-c', MAPS_KEY_CHECK], {
        cwd: path.join(root, 'android'),
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          ANDROID_HOME: path.join(root, 'sdk'),
          ...env
        }
      })
      return { status: result.status, out: result.stdout + result.stderr }
    }
    try {
      mkdirSync(apks, { recursive: true })
      writeFileSync(path.join(apks, 'app-release.apk'), '')
      writeFileSync(path.join(root, 'manifest.txt'), manifest(key))
      // The newest build-tools wins: 9.0.0 sorts below 37.0.0 only by version.
      aapt2('9.0.0', 'exit 9')
      aapt2('37.0.0', `cat '${path.join(root, 'manifest.txt')}'`)
      const pass = check({ GOOGLE_MAPS_ANDROID_API_KEY: key })
      assert.deepEqual(pass, {
        status: 0,
        out: 'The release APK carries the Google Maps key.\n'
      })
      for (const [env, message] of [
        [{ GOOGLE_MAPS_ANDROID_API_KEY: `${key}x` }, 'has no Google Maps key'],
        [
          { GOOGLE_MAPS_ANDROID_API_KEY: key.slice(0, 20) },
          'has no Google Maps key'
        ],
        [{ GOOGLE_MAPS_ANDROID_API_KEY: '' }, 'secret is empty'],
        [{}, 'secret is empty'],
        [
          { GOOGLE_MAPS_ANDROID_API_KEY: key, ANDROID_HOME: '' },
          'No build-tools aapt2'
        ],
        [
          {
            GOOGLE_MAPS_ANDROID_API_KEY: key,
            ANDROID_HOME: path.join(root, 'none')
          },
          'No build-tools aapt2'
        ]
      ] as const) {
        const failed = check(env)
        assert.equal(failed.status, 1)
        assert.match(failed.out, new RegExp(message))
        assert.equal(failed.out.includes(key.slice(4)), false)
      }
      writeFileSync(path.join(root, 'manifest.txt'), manifest(''))
      assert.match(
        check({ GOOGLE_MAPS_ANDROID_API_KEY: key }).out,
        /has no Google Maps key/
      )
      aapt2('38.0.0', 'exit 3')
      assert.match(
        check({ GOOGLE_MAPS_ANDROID_API_KEY: key }).out,
        /aapt2 could not read the release APK manifest/
      )
      writeFileSync(path.join(apks, 'other.apk'), '')
      assert.match(
        check({ GOOGLE_MAPS_ANDROID_API_KEY: key }).out,
        /Expected one release APK/
      )
      rmSync(apks, { recursive: true })
      mkdirSync(apks, { recursive: true })
      assert.match(
        check({ GOOGLE_MAPS_ANDROID_API_KEY: key }).out,
        /Expected one release APK/
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('signs release APKs and bundles with the release key from Mason secrets', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'release-sign-'))
    const bin = path.join(root, 'bin')
    const tools = path.join(root, 'sdk', 'build-tools')
    const keystore = path.join(root, 'secret-1')
    const password = 'store-password-1234'
    const release = 'B6:10:7F:04:17:CD:7B:CB:B1:DB:9E:69:C6:C8:70:BA'
    const tool = (file: string, body: string): void => {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, `#!/bin/sh\n${body}\n`)
      chmodSync(file, 0o755)
    }
    const run = (
      script: string,
      env: Record<string, string | undefined>
    ): { status: number | null; out: string } => {
      const result = spawnSync('sh', ['-c', script], {
        cwd: root,
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          ANDROID_HOME: path.join(root, 'sdk'),
          TS_KEYSTORE: keystore,
          TS_STORE_PASSWORD: password,
          ...env
        }
      })
      return { status: result.status, out: result.stdout + result.stderr }
    }
    const signed = (digest: string): void => {
      writeFileSync(path.join(root, 'digest.txt'), `${digest}\n`)
    }
    try {
      writeFileSync(keystore, 'keystore')
      // apksigner 37 names each scheme's signer ("V2", "V3.0"), so one key
      // prints its certificate more than once; a public key is not a
      // certificate and does not count.
      tool(
        path.join(tools, '37.0.0', 'apksigner'),
        [
          `[ "$1" = sign ] && { echo "sign $*" >> '${root}/signed.log'; exit 0; }`,
          "echo 'V2 Signer: certificate DN: CN=TeamStation, O=TeamStation, C=US'",
          `while read -r d; do echo "V2 Signer: certificate SHA-256 digest: $d"; echo "V3.0 Signer: certificate SHA-256 digest: $d"; done < '${root}/digest.txt'`,
          "echo 'V3.0 Signer: public key SHA-256 digest: 0123'"
        ].join('\n')
      )
      tool(path.join(tools, '9.0.0', 'apksigner'), 'exit 9')
      tool(
        path.join(bin, 'jarsigner'),
        `echo "jarsigner $*" >> '${root}/signed.log'`
      )
      tool(
        path.join(bin, 'keytool'),
        `while read -r d; do printf '\\tSHA256: %s\\n' "$d"; done < '${root}/digest.txt'`
      )
      const apks = path.join(root, 'apk')
      mkdirSync(apks)
      writeFileSync(path.join(apks, 'app-release.apk'), '')
      signed(release.replace(/:/g, '').toLowerCase())
      const apk = signApkScript('apk')
      assert.deepEqual(run(apk, {}), {
        status: 0,
        out: 'The release APK is signed with the release certificate.\n'
      })
      const log = readFileSync(path.join(root, 'signed.log'), 'utf8')
      assert.match(
        log,
        /sign --ks .*secret-1 --ks-key-alias teamstation --ks-pass env:TS_STORE_PASSWORD --key-pass env:TS_STORE_PASSWORD apk\/app-release\.apk/
      )
      assert.equal(log.includes(password), false)

      // Gradle's debug signature comes out of the bundle before jarsigner.
      const bundles = path.join(root, 'aab')
      const contents = path.join(root, 'contents')
      mkdirSync(path.join(contents, 'META-INF'), { recursive: true })
      mkdirSync(path.join(contents, 'base'))
      writeFileSync(path.join(contents, 'base', 'x.txt'), 'x')
      writeFileSync(path.join(contents, 'META-INF', 'ANDROIDD.SF'), 'x')
      writeFileSync(path.join(contents, 'META-INF', 'ANDROIDD.RSA'), 'x')
      mkdirSync(bundles)
      spawnSync('zip', ['-qr', path.join(bundles, 'app-release.aab'), '.'], {
        cwd: contents
      })
      signed(release)
      const aab = signAabScript('aab')
      assert.deepEqual(run(aab, {}), {
        status: 0,
        out: 'The release bundle is signed with the release certificate.\n'
      })
      const entries = spawnSync(
        'unzip',
        ['-Z1', path.join(bundles, 'app-release.aab')],
        { encoding: 'utf8' }
      ).stdout
      assert.equal(/ANDROIDD\.(SF|RSA)/.test(entries), false)
      assert.match(
        readFileSync(path.join(root, 'signed.log'), 'utf8'),
        /jarsigner -keystore .*secret-1 -storepass:env TS_STORE_PASSWORD -keypass:env TS_STORE_PASSWORD -sigalg SHA256withRSA -digestalg SHA-256 aab\/app-release\.aab teamstation/
      )

      signed('51:0F:28:16')
      for (const [script, env, message] of [
        [apk, {}, 'APK is not signed with the release certificate'],
        [aab, {}, 'bundle is not signed with the release certificate'],
        [
          apk,
          { TS_STORE_PASSWORD: '' },
          'ANDROID_RELEASE_KEYSTORE_PASSWORD secret is empty'
        ],
        [
          aab,
          { TS_STORE_PASSWORD: undefined },
          'ANDROID_RELEASE_KEYSTORE_PASSWORD secret is empty'
        ],
        [
          apk,
          { TS_KEYSTORE: path.join(root, 'none') },
          'teamstation-release.keystore secret file is missing'
        ],
        [apk, { ANDROID_HOME: '' }, 'No build-tools apksigner']
      ] as const) {
        const failed = run(script, env)
        assert.equal(failed.status, 1)
        assert.match(failed.out, new RegExp(message))
        assert.equal(failed.out.includes(password), false)
      }
      signed(`${release}\n51:0F:28:16`)
      assert.match(run(aab, {}).out, /does not have exactly one signer/)
      signed(`${release.replace(/:/g, '').toLowerCase()}\n510f2816`)
      assert.match(run(apk, {}).out, /does not have exactly one signer/)
      writeFileSync(path.join(apks, 'other.apk'), '')
      assert.match(run(apk, {}).out, /Expected one release APK to sign/)
      rmSync(bundles, { recursive: true })
      mkdirSync(bundles)
      assert.match(run(aab, {}).out, /Expected one release bundle to sign/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails the Android compile when the APK has no Google Maps key', async () => {
    const commands: string[] = []
    const ctx = {
      run: {
        branch: 'master',
        commit: '0123456789abcdef0123456789abcdef01234567',
        params: { seat: 'production' }
      },
      async sh(command: string) {
        commands.push(command)
        if (command.includes('com.google.android.geo.API_KEY'))
          throw new Error('The release APK has no Google Maps key')
        return { code: 0, stdout: '', stderr: '' }
      },
      getBuildNumber() {
        return '26103101'
      },
      async stash(name: string) {
        commands.push(`stash:${name}`)
      }
    }
    await assert.rejects(
      compileAndroid(ctx as unknown as Parameters<typeof compileAndroid>[0]),
      /The release APK has no Google Maps key/
    )
    assert.equal(
      commands.some(line => line.startsWith('stash:')),
      false
    )
    assert.equal(
      commands.some(line => line.includes(':app:bundleRelease')),
      false
    )
  })

  it('signs a Play bundle only for the stable app, after the APK is out', async () => {
    const androidRun = (
      branch: string,
      bundles: string[]
    ): { ctx: Parameters<typeof signAndroid>[0]; commands: string[] } => {
      const commands: string[] = []
      const ctx = {
        run: { branch, params: { seat: 'production' } },
        async sh(command: string) {
          commands.push(command)
          return { code: 0, stdout: '', stderr: '' }
        },
        secret: () => 'store-password',
        secretFile: () => '/private/secret-1',
        async unstash() {},
        artifacts: {
          async save(name: string) {
            commands.push(`save:${name}`)
          }
        },
        fs: {
          async glob(pattern: string) {
            if (pattern.endsWith('.aab')) return bundles
            return ['android/app/build/outputs/apk/release/app-release.apk']
          }
        },
        async publish(options: { app: string }) {
          commands.push(`publish:${options.app}`)
        }
      }
      return { ctx, commands }
    }

    const develop = androidRun('develop', [])
    await signAndroid(develop.ctx)
    assert.deepEqual(develop.commands.slice(1), [
      'save:android-apk',
      `publish:${DEVELOP_APP}`
    ])

    const missing = androidRun('master', [])
    await assert.rejects(
      signAndroid(missing.ctx),
      /No release bundle was signed/
    )
    assert.deepEqual(missing.commands.slice(1, 3), [
      'save:android-apk',
      'publish:app.teamstation.app'
    ])
    assert.equal(
      missing.commands[3],
      signAabScript('android/app/build/outputs/bundle/release')
    )
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

  it('explicitly selects API and app-link origins and refuses unknown seats', () => {
    const seated = (
      params?: Record<string, string | number | boolean>
    ): Record<string, string> =>
      seatEnvironment({ run: { branch: 'master', params } })
    const production = {
      TS_API_BASE_URL: 'https://app.teamstation.app/api/v1',
      TS_APP_ORIGIN: 'https://app.teamstation.app'
    }
    assert.deepEqual(seated({ seat: 'production' }), production)
    assert.deepEqual(seated(), production)
    assert.deepEqual(seated({ seat: '8' }), {
      TS_API_BASE_URL: 'https://develop8.teamstation.app/api/v1',
      TS_APP_ORIGIN: 'https://develop.teamstation.app'
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
        TS_APP_ORIGIN: 'https://develop.teamstation.app'
      }
    )
    assert.deepEqual(
      seatEnvironment({
        run: {
          branch: 'paul/example',
          params: { seat: 'e2e-03.teamstation.app' }
        }
      }),
      {
        TS_API_BASE_URL: 'https://e2e-03.teamstation.app/api/v1',
        TS_APP_ORIGIN: 'https://develop.teamstation.app'
      }
    )
    assert.throws(
      () => seated({ seat: 'evil.example.com' }),
      /Unknown seat evil\.example\.com/
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
      workflow(name, _options, declare) {
        if (name !== 'build') {
          declare({
            stage() {},
            parallel() {}
          })
          return
        }
        declare({
          stage() {},
          parallel(_group, members) {
            const ios = (
              members as {
                ios: Array<{ apple: { app: string }; publishes?: string[] }>
              }
            ).ios
            const android = (
              members as {
                android: Array<{ publishes?: string[]; secrets?: string[] }>
              }
            ).android
            recorded.push(ios[0]?.apple.app ?? '')
            recorded.push((ios[0]?.publishes ?? []).join(','))
            recorded.push((android[1]?.publishes ?? []).join(','))
            recorded.push((android[0]?.secrets ?? []).join(','))
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
      'GOOGLE_MAPS_ANDROID_API_KEY',
      STABLE_APP,
      TV_APP,
      DIRECTOR_DEVELOP_APP,
      CAMERAMAN_DEVELOP_APP,
      DISTRIBUTOR_DEVELOP_APP
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
          '<key>CFBundleDisplayName</key>\n\t<string>TeamStation</string>\n<key>CFBundleURLName</key>\n\t\t\t<string>app.teamstation.app</string>\n\t\t\t<array>\n\t\t\t\t<string>teamstation</string>\n\t\t\t</array>\n',
        'android/app/src/main/AndroidManifest.xml':
          '            <data android:scheme="teamstation" />\n        </intent-filter>\n'
      }
      for (const [file, text] of Object.entries(files)) {
        const full = path.join(root, file)
        mkdirSync(path.dirname(full), { recursive: true })
        writeFileSync(full, text)
      }
      applyDevelopIdentity(root)
      applyDevelopIdentity(root)
      // The develop app claims its test-control scheme beside its own, once.
      const plistText = readFileSync(
        path.join(root, 'ios/TeamStation/Info.plist'),
        'utf8'
      )
      assert.equal(
        plistText.match(/<string>teamstation-develop<\/string>/g)?.length,
        1
      )
      assert.match(plistText, /<string>teamstation<\/string>/)
      const manifest = readFileSync(
        path.join(root, 'android/app/src/main/AndroidManifest.xml'),
        'utf8'
      )
      assert.equal(
        manifest.match(/android:scheme="teamstation-develop"/g)?.length,
        1
      )
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
      describe(text: string) {
        commands.push(`describe:${text}`)
      },
      log: {
        info(message: string) {
          commands.push(`info:${message}`)
        },
        warn(message: string) {
          commands.push(`warn:${message}`)
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
            `testflight:${options.path}:${JSON.stringify(options.groups)}:${String(options.usesNonExemptEncryption)}:${options.whatToTest ?? ''}`
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
      /testflight:build\/mason-archive\/TeamStation-appStore\.ipa:undefined:false:TeamStation production build\./
    )
    assert.match(
      log,
      /info:TestFlight has 1\.0 \(26103101\)\. Add it to the TeamStation testers group and submit it for beta review in App Store Connect\./
    )
    assert.match(
      log,
      /describe:TestFlight 1\.0 \(26103101\) needs beta review in App Store Connect/
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
          if (
            name === 'director' ||
            name === 'cameraman' ||
            name === 'distributor'
          ) {
            assert.deepEqual(options.triggers, [{ request: true }])
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
    ['feature', '5', 'develop5'],
    ['master', '2', 'develop2'],
    ['feature', 'e2e-03.teamstation.app', 'e2e-03']
  ]) {
    it(`archives a standalone TV app for ${branch}/${seat}`, async () => {
      const commands: Array<[string, string | undefined]> = []
      const saved: string[] = []
      let published = false
      const workspace = mkdtempSync(path.join(tmpdir(), 'tv-app-'))
      const plist = path.join(workspace, 'appletv/ios/TeamStationTV/Info.plist')
      mkdirSync(path.dirname(plist), { recursive: true })
      writeFileSync(
        plist,
        '<dict>\n\t<key>TVAppOrigin</key>\n\t<string>$(TV_APP_ORIGIN)</string>\n</dict>\n'
      )
      writeFileSync(
        path.join(workspace, 'package.json'),
        readFileSync('package.json', 'utf8')
      )
      await buildTv({
        workspace,
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
            const info = JSON.parse(options.env!.TS_BUILD_INFO)
            assert.equal(info.branch, branch)
            assert.equal(info.commit, '0'.repeat(40))
            assert.equal(info.version, options.version)
            assert.equal(info.buildNumber, options.buildNumber)
            assert.match(options.version ?? '', /^\d+(\.\d+){0,2}$/)
            assert.deepEqual(options.xcargs, [
              'SWIFT_ENABLE_EXPLICIT_MODULES=NO',
              `TV_API_BASE_URL=https://${host}.teamstation.app/api/v1`,
              `TV_APP_ORIGIN=https://${host === 'app' ? 'app' : 'develop'}.teamstation.app`
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
      // A develop TV build alone claims the scheme its server link uses.
      const claimed = readFileSync(plist, 'utf8').includes(
        '<string>teamstationtv-develop</string>'
      )
      assert.equal(claimed, host !== 'app')
    })
  }

  it('rejects missing TV provenance before installing dependencies', async () => {
    for (const run of [
      { branch: '', commit: '0'.repeat(40) },
      { branch: 'master', commit: '' }
    ]) {
      const context = {
        run,
        getBuildNumber: () => '1',
        sh: async () => assert.fail('must validate before installing')
      }
      await assert.rejects(
        buildTv(context as Parameters<typeof buildTv>[0]),
        /branch|commit/
      )
    }
  })

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

describe('Google Play closed-testing release', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048
  })
  const key = {
    client_email: 'publisher@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    token_uri: 'https://oauth2.example.test/token'
  }
  interface Call {
    url: string
    method: string
    headers: Record<string, string>
    body: unknown
  }
  const reply = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status })
  const recorder = (
    answer: (call: Call) => Response
  ): {
    calls: Call[]
    fetcher: (url: string, init?: RequestInit) => Promise<Response>
  } => {
    const calls: Call[] = []
    return {
      calls,
      async fetcher(url, init) {
        const call = {
          url,
          method: init?.method ?? 'GET',
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: init?.body
        }
        calls.push(call)
        return answer(call)
      }
    }
  }

  it('keeps the en-US release notes within Play’s limit', () => {
    assert.equal(PLAY_NOTES_LIMIT, 500)
    assert.ok(PLAY_RELEASE_NOTES.length <= PLAY_NOTES_LIMIT)
    for (const section of [
      'Coaching:',
      'Scoring:',
      'Replay:',
      'Video:',
      'Chat:'
    ])
      assert.ok(PLAY_RELEASE_NOTES.includes(section), section)
    assert.equal(PLAY_TRACK, 'alpha')
  })

  it('signs a service-account assertion for the Android publisher scope', () => {
    const jwt = playAssertion(key, 1_800_000_000_500)
    const [head, claims, signature] = jwt.split('.')
    assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url').toString()), {
      alg: 'RS256',
      typ: 'JWT'
    })
    assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url').toString()), {
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: key.token_uri,
      iat: 1_800_000_000,
      exp: 1_800_003_600
    })
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${head}.${claims}`)
    assert.ok(verifier.verify(publicKey, Buffer.from(signature, 'base64url')))
  })

  it('trades the assertion for a token and reports a refusal without credentials', async () => {
    const ok = recorder(() => reply(200, { access_token: 'token-1' }))
    assert.equal(
      await playAccessToken(key, ok.fetcher, 1_800_000_000_000),
      'token-1'
    )
    assert.equal(ok.calls[0]?.url, key.token_uri)
    const form = new URLSearchParams(String(ok.calls[0]?.body))
    assert.equal(
      form.get('grant_type'),
      'urn:ietf:params:oauth:grant-type:jwt-bearer'
    )
    assert.equal(form.get('assertion'), playAssertion(key, 1_800_000_000_000))

    const refused = recorder(() => reply(400, { error: 'invalid_grant' }))
    await assert.rejects(
      playAccessToken(key, refused.fetcher),
      (error: Error) =>
        error.message ===
        'Google Play sign-in failed with HTTP 400: invalid_grant'
    )
    const empty = recorder(() => reply(200, {}))
    await assert.rejects(playAccessToken(key, empty.fetcher), /no access token/)
  })

  it('uploads the bundle, completes it on the track and commits one edit', async () => {
    const api = recorder(call => {
      if (call.url.endsWith('/edits')) return reply(200, { id: 'edit-7' })
      if (call.url.includes('/bundles?uploadType=media'))
        return reply(200, { versionCode: 26111501 })
      return reply(200, {})
    })
    const bundle = new Uint8Array([1, 2, 3])
    const result = await releaseToPlayTrack({
      token: 'token-1',
      bundle,
      track: 'alpha',
      notes: 'Notes',
      fetcher: api.fetcher
    })
    assert.deepEqual(result, { editId: 'edit-7', versionCode: 26111501 })
    const base =
      'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/app.teamstation.app'
    assert.deepEqual(
      api.calls.map(call => `${call.method} ${call.url}`),
      [
        `POST ${base}/edits`,
        'POST https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/app.teamstation.app/edits/edit-7/bundles?uploadType=media',
        `PUT ${base}/edits/edit-7/tracks/alpha`,
        `POST ${base}/edits/edit-7:commit`
      ]
    )
    for (const call of api.calls)
      assert.equal(call.headers.Authorization, 'Bearer token-1')
    assert.equal(api.calls[1]?.body, bundle)
    assert.equal(
      api.calls[1]?.headers['Content-Type'],
      'application/octet-stream'
    )
    assert.deepEqual(JSON.parse(String(api.calls[2]?.body)), {
      track: 'alpha',
      releases: [
        {
          versionCodes: ['26111501'],
          status: 'completed',
          releaseNotes: [{ language: 'en-US', text: 'Notes' }]
        }
      ]
    })
  })

  it('deletes the edit when a step after opening it fails', async () => {
    const api = recorder(call => {
      if (call.url.endsWith('/edits')) return reply(200, { id: 'edit-8' })
      if (call.url.includes('/bundles'))
        return reply(200, { versionCode: 26111502 })
      if (call.url.endsWith('/tracks/alpha'))
        return reply(403, {
          error: { message: 'The caller does not have permission' }
        })
      return reply(200, {})
    })
    await assert.rejects(
      releaseToPlayTrack({
        token: 'token-1',
        bundle: new Uint8Array([1]),
        track: 'alpha',
        notes: 'Notes',
        fetcher: api.fetcher
      }),
      (error: Error) =>
        error.message ===
          'Google Play alpha release failed with HTTP 403: The caller does not have permission' &&
        !error.message.includes('token-1')
    )
    assert.deepEqual(api.calls.at(-1)?.method, 'DELETE')
    assert.match(api.calls.at(-1)?.url ?? '', /\/edits\/edit-8$/)
    assert.equal(
      api.calls.some(call => call.url.endsWith(':commit')),
      false
    )

    const noId = recorder(() => reply(200, {}))
    await assert.rejects(
      releaseToPlayTrack({
        token: 't',
        bundle: new Uint8Array([1]),
        track: 'alpha',
        notes: 'Notes',
        fetcher: noId.fetcher
      }),
      /without an id/
    )
    const noCode = recorder(call =>
      call.url.endsWith('/edits')
        ? reply(200, { id: 'edit-9' })
        : reply(200, {})
    )
    await assert.rejects(
      releaseToPlayTrack({
        token: 't',
        bundle: new Uint8Array([1]),
        track: 'alpha',
        notes: 'Notes',
        fetcher: noCode.fetcher
      }),
      /no versionCode/
    )
    assert.equal(noCode.calls.at(-1)?.method, 'DELETE')
  })

  it('releases the stashed bundle from the play stage and logs the versionCode', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'play-stage-'))
    const realFetch = globalThis.fetch
    try {
      const keyFile = path.join(dir, 'key.json')
      writeFileSync(keyFile, JSON.stringify(key))
      const aab = 'android/app/build/outputs/bundle/release/app-release.aab'
      mkdirSync(path.join(dir, path.dirname(aab)), { recursive: true })
      writeFileSync(path.join(dir, aab), 'bundle-bytes')
      const events: string[] = []
      const api = recorder(call => {
        if (call.url === key.token_uri)
          return reply(200, { access_token: 'token-2' })
        if (call.url.endsWith('/edits')) return reply(200, { id: 'edit-10' })
        if (call.url.includes('/bundles'))
          return reply(200, { versionCode: 26111503 })
        return reply(200, {})
      })
      globalThis.fetch = (async (input: string, init?: RequestInit) =>
        await api.fetcher(input, init)) as typeof fetch
      const ctx = {
        workspace: dir,
        run: { branch: 'master', commit: 'abc' },
        async unstash(name: string) {
          events.push(`unstash:${name}`)
        },
        fs: {
          async glob(pattern: string) {
            events.push(`glob:${pattern}`)
            return [aab]
          }
        },
        secretFile(name: string) {
          assert.equal(name, PLAY_PUBLISHER_SECRET)
          return keyFile
        },
        log: {
          info(message: string) {
            events.push(`info:${message}`)
          },
          warn() {}
        },
        describe(text: string) {
          events.push(`describe:${text}`)
        }
      } as unknown as Parameters<typeof releasePlayTesting>[0]
      await releasePlayTesting(ctx)
      assert.deepEqual(events, [
        'unstash:play-bundle',
        'glob:android/app/build/outputs/bundle/release/*.aab',
        'info:Google Play alpha has versionCode 26111503 (edit edit-10).',
        'describe:Google Play closed testing has versionCode 26111503'
      ])
      const upload = api.calls.find(call => call.url.includes('/bundles'))
      assert.equal(
        Buffer.from(upload?.body as Uint8Array).toString(),
        'bundle-bytes'
      )
      const track = api.calls.find(call => call.url.endsWith('/tracks/alpha'))
      assert.equal(
        JSON.parse(String(track?.body)).releases[0].releaseNotes[0].text,
        PLAY_RELEASE_NOTES
      )

      const empty = {
        ...ctx,
        fs: {
          async glob() {
            return []
          }
        }
      } as unknown as Parameters<typeof releasePlayTesting>[0]
      await assert.rejects(
        releasePlayTesting(empty),
        /No signed Play bundle was stashed/
      )
    } finally {
      globalThis.fetch = realFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
