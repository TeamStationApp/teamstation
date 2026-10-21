import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type {
  ArchiveOptions,
  CommandOptions,
  CommandResult,
  Json,
  PublishOptions,
  Setup,
  Stage,
  StageOptions,
  WorkflowBuilder
} from '@mason/types'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { buildStage, setup } from '../../Masonfile.ts'
import { publishedApps, rowFor, rows } from './apps.ts'
import {
  buildEnvironment,
  httpsOrigin,
  pipelineConfig,
  sentryEnvironment,
  sentryRelease,
  serverOrigin
} from './config.ts'
import {
  android,
  androidSigning,
  apkSigner,
  appStore,
  appVersion,
  ios,
  macos,
  OUTPUT,
  test,
  writeClientConfig
} from './stages.ts'

const TEAM = 'TEAM000000'
const CERT = 'ab'.repeat(32)
const config = {
  apiOrigin: 'https://api.example.test',
  appOrigin: 'https://app1.example.test',
  seats: { '1': 'https://seat1.example.test' },
  sentry: {
    origin: 'https://sentry.example.test',
    org: 'example',
    token: 'sntrys_placeholder',
    apps: {
      'app.teamstation.app': {
        project: 'teamstation',
        dsn: 'https://0000@sentry.example.test/1'
      },
      'app.teamstation.cameraman': {
        project: 'cameraman',
        dsn: 'https://0000@sentry.example.test/2'
      },
      'app.teamstation.distributor': {
        project: 'distributor',
        dsn: 'https://0000@sentry.example.test/3'
      }
    }
  },
  googleMapsAndroidKey: 'maps-placeholder'
}

interface Call {
  file: string
  args: string[]
  options: CommandOptions
}
interface Fake {
  ctx: Stage
  calls: Call[]
  saved: Array<[string, string | string[]]>
  published: PublishOptions[]
  archived: ArchiveOptions[]
  notarized: Array<{ path: string; staple?: boolean }>
  unstable: string[]
  testflight: unknown[]
}

/** A stage context over a real workspace whose tools are simulated. */
function fakeStage(
  workspace: string,
  stage: string,
  options: {
    params?: Record<string, string>
    secrets?: Record<string, string>
    lint?: number
    families?: string
    signer?: string
  } = {}
): Fake {
  const calls: Call[] = []
  const saved: Fake['saved'] = []
  const published: PublishOptions[] = []
  const archived: ArchiveOptions[] = []
  const notarized: Fake['notarized'] = []
  const unstable: string[] = []
  const testflight: unknown[] = []
  const at = (file: string): string => path.resolve(workspace, file)
  const touch = (file: string, data = 'x'): void => {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, data)
  }
  const secrets: Record<string, string> = {
    TS_PIPELINE_CONFIG: JSON.stringify(config),
    ANDROID_SIGNING: JSON.stringify({
      alias: 'androiddebugkey',
      storePassword: 'android',
      keyPassword: 'android',
      certificateSha256: CERT
    }),
    ...options.secrets
  }
  const exec = async (
    file: string,
    args: string[] = [],
    command: CommandOptions = {}
  ): Promise<CommandResult> => {
    calls.push({ file, args, options: command })
    const cwd = at(command.cwd ?? '.')
    let stdout = ''
    let code = 0
    if (file === 'node' && args[0] === 'scripts/clientConfig.mjs') {
      touch(at(path.join(args[1], 'clientConfig.xcconfig')))
      stdout = path.join(args[1], 'clientConfig.xcconfig') + '\n'
    } else if (file === 'plutil') stdout = options.families ?? '[1]'
    else if (file === 'npm' && args[1] === 'lint') code = options.lint ?? 0
    else if (file === 'xcodebuild') {
      const derived = at(args[args.indexOf('-derivedDataPath') + 1])
      const scheme = args[args.indexOf('-scheme') + 1]
      touch(
        path.join(
          derived,
          'Build/Products/Release-iphonesimulator',
          `${scheme}.app`,
          'Info.plist'
        )
      )
    } else if (file === 'ditto' && args[0] === '-c') touch(args[4])
    else if (file === './gradlew') {
      touch(path.join(cwd, 'app/build/outputs/apk/release/app-release.apk'))
      if (cwd.endsWith('android'))
        touch(path.join(cwd, 'app/build/outputs/mapping/release/mapping.txt'))
    } else if (file.endsWith('apksigner'))
      stdout =
        options.signer ??
        `Signer #1 certificate SHA-256 digest: ${CERT}\nNumber of signers: 1\n`
    else if (file === 'npx' && args[0] === 'mocha')
      touch(at(path.join(OUTPUT, 'test-results.xml')), '<testsuite/>')
    if (code !== 0 && command.allowFailure !== true)
      throw new Error(`${file} failed`)
    return { code, stdout, stderr: '' }
  }
  const ctx = {
    run: {
      id: 'run',
      number: 1,
      workflow: 'build',
      branch: 'feature/one',
      commit: 'c'.repeat(40),
      trigger: 'request',
      params: options.params ?? {},
      url: 'https://mason.example.test/runs/run',
      changes: []
    },
    stage: { name: stage, attempt: 1, matrix: {} },
    node: { name: 'mac', type: 'mac', os: 'macos', arch: 'arm64', labels: [] },
    workspace,
    signal: new AbortController().signal,
    sh: async () => await exec('sh'),
    exec,
    secret: (name: string): string => {
      const value = secrets[name]
      if (value == null) throw new Error(`${name} is not declared`)
      return value
    },
    secretFile: (name: string): string => `/secrets/${name}`,
    output: async () => null,
    getBuildNumber: (key: string): string => {
      assert.equal(key, 'app')
      return '26102151'
    },
    stash: async () => undefined,
    unstash: async () => undefined,
    artifacts: {
      save: async (name: string, paths: string | string[]) => {
        saved.push([name, paths])
      },
      fetch: async () => []
    },
    tests: async () => ({ passed: 3, failed: 1, skipped: 0, failures: [] }),
    publish: async (publish: PublishOptions) => {
      published.push(publish)
      return {
        buildId: 7,
        url: 'https://builds.example.test/b/7',
        installUrl: 'https://builds.example.test/i/7',
        visible: true
      }
    },
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      section: async <T>(_title: string, body: () => Promise<T> | T) =>
        await body()
    },
    describe: () => undefined,
    unstable: (reason: string) => {
      unstable.push(reason)
    },
    retry: async <T>(_attempts: number, body: () => Promise<T>) => await body(),
    timeout: async <T>(
      _duration: string,
      body: (signal: AbortSignal) => Promise<T>
    ) => await body(new AbortController().signal),
    sleep: async () => undefined,
    waitUntil: async () => undefined,
    cache: { restore: async () => false, save: async () => undefined },
    checkout: async () => undefined,
    fs: {
      stat: async () => ({
        size: 0,
        isFile: true,
        isDirectory: false,
        mtimeMs: 0
      }),
      read: async (file: string) => readFileSync(at(file), 'utf8'),
      write: async (file: string, data: string | Uint8Array) => {
        touch(at(file))
        writeFileSync(at(file), data)
      },
      glob: async () => []
    },
    git: { tag: async () => undefined },
    apple: {
      signing: {
        teamId: TEAM,
        identity: 'Developer ID Application: Example (TEAM000000)',
        keychain: '/k/stage.keychain-db',
        profiles: {},
        buildSettings: {},
        exportOptions: '/k/ExportOptions.plist'
      },
      archive: async (archive: ArchiveOptions) => {
        archived.push(archive)
        const out = at(archive.output!)
        const xcarchive = path.join(out, `${archive.scheme}.xcarchive`)
        touch(
          path.join(
            xcarchive,
            'Products/Applications',
            `${archive.scheme}.app`,
            'Info.plist'
          )
        )
        const app = path.join(out, `${archive.scheme}.app`)
        touch(path.join(app, 'Contents/Info.plist'))
        return {
          archive: xcarchive,
          ipa: path.join(out, `${archive.scheme}.ipa`),
          app,
          dsyms: path.join(out, `${archive.scheme}.dSYMs.zip`)
        }
      },
      testflight: async (sent: unknown) => {
        testflight.push(sent)
        return {
          buildId: 'B1',
          version: '0.1.0',
          buildNumber: '26102151',
          state: 'VALID'
        }
      },
      notarize: async (request: { path: string; staple?: boolean }) => {
        notarized.push(request)
        return { id: 'N1', status: 'accepted' as const }
      }
    }
  } as unknown as Stage
  return {
    ctx,
    calls,
    saved,
    published,
    archived,
    notarized,
    unstable,
    testflight
  }
}

let workspace: string
const commands = (fake: Fake): string[] =>
  fake.calls.map(call => [call.file, ...call.args].join(' '))

describe('TeamStation pipeline', () => {
  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), 'ts-pipeline-'))
    writeFileSync(
      path.join(workspace, 'package.json'),
      JSON.stringify({ version: '0.1.0' })
    )
  })
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('declares a test stage, every app row in parallel, and an approved release', () => {
    const recorded: Array<[string, unknown]> = []
    const workflows: Record<string, unknown> = {}
    const builder = (name: string): WorkflowBuilder => ({
      stage: (stage, options) => {
        recorded.push([`${name}:${stage}`, options])
        return { name: stage, kind: 'stage' }
      },
      parallel: (group, members, options) => {
        recorded.push([`${name}:${group}`, { members, options }])
        return { name: group, kind: 'group' }
      },
      matrix: () => {
        throw new Error('unused')
      },
      approval: (approval, options) => {
        recorded.push([`${name}:${approval}`, options])
        return { name: approval, kind: 'approval' }
      },
      post: () => undefined
    })
    const schemes: Record<string, unknown> = {}
    const m = {
      apiVersion: (version: number) => {
        assert.equal(version, 1)
      },
      buildNumber: (key: string, options: unknown) => {
        schemes[key] = options
      },
      workflow: (
        name: string,
        options: unknown,
        declare: (w: WorkflowBuilder) => void
      ) => {
        workflows[name] = options
        declare(builder(name))
      }
    } as unknown as Setup
    setup(m)
    assert.deepEqual(schemes.app, {
      scope: 'branch',
      format: 'YYMMDDCC',
      timeZone: 'America/Los_Angeles',
      check: 'apple'
    })
    assert.deepEqual(Object.keys(workflows), ['build', 'release'])
    const group = recorded.find(([name]) => name === 'build:build')![1] as {
      members: Record<string, StageOptions>
      options: { needs: Array<{ name: string }>; failFast: boolean }
    }
    assert.deepEqual(
      Object.keys(group.members),
      rows.map(row => row.name)
    )
    assert.equal(group.options.needs[0].name, 'test')
    assert.equal(group.options.failFast, false)
    assert.equal(
      group.members['distributor-macos'].apple?.distribution,
      'developerId'
    )
    assert.deepEqual(
      (
        recorded.find(([name]) => name === 'release:approve')![1] as {
          roles: string[]
        }
      ).roles,
      ['admin', 'manager']
    )
    const android = buildStage(rowFor('cameraman-android'))
    assert.deepEqual(android.on, { labels: ['teamstation-android'] })
    assert(android.secrets!.includes('ANDROID_KEYSTORE'))
    assert.deepEqual(buildStage(rowFor('teamstation-ios')).tools?.brew, [
      'xcodegen',
      'cocoapods'
    ])
    assert.deepEqual(buildStage(rowFor('preview-ios')).tools?.brew, [
      'xcodegen'
    ])
  })

  it('names rows by stage and lists each app once', () => {
    assert.equal(rowFor('build/director-ios').deviceFamily, 2)
    assert.equal(rowFor('cameraman-android').kind, 'kotlin')
    assert.throws(() => rowFor('build/none'), /No app build/)
    assert.deepEqual(publishedApps(), [
      'app.teamstation.app',
      'app.teamstation.cameraman',
      'app.teamstation.director',
      'app.teamstation.preview',
      'app.teamstation.distributor'
    ])
  })

  it('reads the private settings strictly and picks the seat’s server', () => {
    const read = pipelineConfig(JSON.stringify(config))
    assert.equal(serverOrigin(read, 'none'), 'https://api.example.test')
    assert.equal(serverOrigin(read, ''), 'https://api.example.test')
    assert.equal(serverOrigin(read, '1'), 'https://seat1.example.test')
    assert.throws(() => serverOrigin(read, '2'), /Seat 2 has no server/)
    assert.deepEqual(pipelineConfig('{}'), { seats: {} })
    assert.equal(serverOrigin(pipelineConfig('{}'), 'none'), undefined)
    for (const [bad, error] of [
      ['nope', /not JSON/],
      ['[]', /must be an object/],
      ['{"extra":1}', /unknown field extra/],
      ['{"apiOrigin":"http://api.example.test"}', /apiOrigin is not/],
      ['{"apiOrigin":"https://localhost"}', /apiOrigin is not/],
      ['{"apiOrigin":"https://a.example.test/path"}', /apiOrigin is not/],
      ['{"apiOrigin":"not a url"}', /apiOrigin is not/],
      ['{"seats":{"10":"https://a.example.test"}}', /Seat 10 is not/],
      ['{"googleMapsAndroidKey":" "}', /googleMapsAndroidKey/],
      [
        '{"sentry":{"origin":"https://s.example.test","org":"o","token":"t","apps":{"a":{"project":"p","dsn":"https://s.example.test/1"}}}}',
        /not a Sentry DSN/
      ],
      [
        '{"sentry":{"origin":"https://s.example.test","org":"o o","token":"t","apps":{}}}',
        /sentry\.org/
      ],
      [
        '{"sentry":{"origin":"https://s.example.test","org":"o","token":"t","apps":{"a":{"project":"p","dsn":"https://k@s.example.test/1","x":1}}}}',
        /unknown field x/
      ]
    ] as const)
      assert.throws(() => pipelineConfig(bad), error)
    assert.equal(
      httpsOrigin('https://a.example.test:8443', 'x'),
      'https://a.example.test:8443'
    )
    const env = buildEnvironment(
      {
        app: 'app.teamstation.app',
        version: '0.1.0',
        buildNumber: '26102151',
        branch: 'b',
        commit: 'c',
        builtAt: 't'
      },
      'https://seat1.example.test',
      read
    )
    assert.equal(env.TS_API_BASE_URL, 'https://seat1.example.test/api/v1')
    assert.equal(env.TS_PRIMARY_HOST, 'seat1.example.test')
    assert.equal(env.TS_SENTRY_DSN, 'https://0000@sentry.example.test/1')
    assert.equal(JSON.parse(env.TS_BUILD_INFO).buildNumber, '26102151')
    assert.deepEqual(
      Object.keys(
        buildEnvironment(
          {
            app: 'app.teamstation.preview',
            version: '0.1.0',
            buildNumber: '1',
            branch: 'b',
            commit: 'c',
            builtAt: 't'
          },
          undefined,
          read
        )
      ),
      ['NODE_BINARY', 'TS_BUILD_INFO']
    )
    assert.equal(sentryEnvironment(read, 'app.teamstation.preview'), undefined)
    assert.equal(
      sentryEnvironment(read, 'app.teamstation.app')?.SENTRY_PROJECT,
      'teamstation'
    )
    assert.deepEqual(sentryRelease('a', '1.0.0', '5'), {
      release: 'a@1.0.0+5',
      dist: '5'
    })
  })

  it('tests: lint and mocha results, marking the run unstable rather than failing', async () => {
    const fake = fakeStage(workspace, 'test', { lint: 1 })
    const result = (await test(fake.ctx)) as Record<string, Json>
    assert.equal(result.lint, false)
    assert.equal(result.failed, 1)
    assert.deepEqual(fake.unstable, ['Lint failed'])
    assert(commands(fake).some(line => line.includes('--reporter xunit')))
    const clean = fakeStage(workspace, 'test')
    assert.equal(((await test(clean.ctx)) as Record<string, Json>).lint, true)
    assert.deepEqual(clean.unstable, [])
  })

  it('builds TeamStation for iOS: dependencies, pods, Mason’s archive with the build environment, Sentry, publish and a Simulator build', async () => {
    const fake = fakeStage(workspace, 'build/teamstation-ios', {
      params: { seat: '1' }
    })
    const result = (await ios(fake.ctx)) as Record<string, Json>
    assert.equal(result.buildId, 7)
    assert.equal(result.buildNumber, '26102151')
    const lines = commands(fake)
    assert.equal(lines[0], 'npm ci')
    assert(lines.includes('pod install --deployment'))
    assert.equal(
      fake.calls.find(call => call.file === 'pod')!.options.cwd,
      'ios'
    )
    const archive = fake.archived[0]
    assert.equal(archive.workspace, 'ios/TeamStation.xcworkspace')
    assert.equal(archive.version, '0.1.0')
    assert.equal(archive.buildNumber, '26102151')
    assert.equal(
      archive.env!.TS_API_BASE_URL,
      'https://seat1.example.test/api/v1'
    )
    assert(archive.xcargs!.includes('ARCHS=arm64'))
    assert(archive.xcargs!.some(arg => arg.startsWith('SOURCEMAP_FILE=')))
    assert.deepEqual(
      JSON.parse(
        readFileSync(path.join(workspace, 'clientConfig.json'), 'utf8')
      ),
      { appOrigin: 'https://app1.example.test', appleTeamId: TEAM }
    )
    const uploads = fake.calls.filter(call =>
      call.args.includes('scripts/deploy/sentryUpload.ts')
    )
    assert.equal(uploads.length, 2)
    assert(uploads[0].args.includes('--dsyms'))
    assert(uploads[1].args.includes('main.jsbundle'))
    assert.equal(uploads[0].options.env!.SENTRY_PROJECT, 'teamstation')
    assert(uploads[0].args.includes('app.teamstation.app@0.1.0+26102151'))
    assert.deepEqual(
      fake.published.map(entry => [entry.app, entry.platform, entry.path]),
      [
        [
          'app.teamstation.app',
          'ios',
          `${OUTPUT}/teamstation-ios/TeamStation.ipa`
        ]
      ]
    )
    assert.deepEqual(
      fake.saved.map(([name]) => name),
      ['teamstation-ios-dsyms', 'teamstation-ios-simulator']
    )
    const simulator = fake.calls.find(call => call.file === 'xcodebuild')!
    assert(simulator.args.includes('CODE_SIGNING_ALLOWED=NO'))
    assert(simulator.args.includes('iphonesimulator'))
  })

  it('builds Director for iPad from its generated project, without Sentry, and refuses the wrong device family', async () => {
    const fake = fakeStage(workspace, 'build/director-ios', { families: '[2]' })
    await ios(fake.ctx)
    const lines = commands(fake)
    assert(!lines.includes('npm ci'))
    assert.deepEqual(lines.slice(0, 2), [
      'bash scripts/bootstrapNdi.sh',
      'xcodegen generate --quiet'
    ])
    assert.equal(
      fake.archived[0].project,
      'mobile/apps/tsDirector/Director.xcodeproj'
    )
    assert(
      fake.calls
        .find(call => call.file === 'node')!
        .args.includes('App/Director.entitlements')
    )
    assert(
      !fake.calls.some(call =>
        call.args.includes('scripts/deploy/sentryUpload.ts')
      )
    )
    const wrong = fakeStage(workspace, 'build/director-ios', {
      families: '[1]'
    })
    await assert.rejects(ios(wrong.ctx), /device family 2/)
    const noIpa = fakeStage(workspace, 'build/preview-ios')
    noIpa.ctx.apple.archive = async options => ({
      archive: path.join(workspace, OUTPUT, 'x.xcarchive'),
      dsyms: path.join(workspace, OUTPUT, 'x.zip'),
      ...(options.scheme === 'none' ? { ipa: 'x' } : {})
    })
    mkdirSync(
      path.join(
        workspace,
        OUTPUT,
        'x.xcarchive/Products/Applications/Preview.app'
      ),
      {
        recursive: true
      }
    )
    await assert.rejects(ios(noIpa.ctx), /no IPA/)
  })

  it('builds the Distributor: universal and hardened, the app and the DMG notarized, the DMG signed and checked', async () => {
    const fake = fakeStage(workspace, 'build/distributor-macos')
    await macos(fake.ctx)
    assert(fake.archived[0].xcargs!.includes('ARCHS=arm64 x86_64'))
    assert(fake.archived[0].xcargs!.includes('ENABLE_HARDENED_RUNTIME=YES'))
    assert.deepEqual(
      fake.notarized.map(entry => [path.basename(entry.path), entry.staple]),
      [
        ['Distributor.zip', false],
        ['Distributor.dmg', true]
      ]
    )
    const lines = commands(fake)
    assert(lines.some(line => line.startsWith('xcrun stapler staple')))
    assert(
      lines.some(line => line.startsWith('hdiutil create -volname Distributor'))
    )
    assert(
      lines.some(line =>
        line.startsWith(
          'codesign --sign Developer ID Application: Example (TEAM000000) --keychain /k/stage.keychain-db --timestamp'
        )
      )
    )
    assert(lines.some(line => line.startsWith('spctl -a -vv -t install')))
    assert(
      existsSync(
        path.join(workspace, OUTPUT, 'distributor-macos/dmg/Applications')
      )
    )
    assert.deepEqual(
      fake.published.map(entry => [
        entry.platform,
        entry.version,
        path.basename(entry.path)
      ]),
      [['macos', '0.1.0', 'Distributor.dmg']]
    )
    const noApp = fakeStage(workspace, 'build/distributor-macos')
    noApp.ctx.apple.archive = async () => ({
      archive: path.join(workspace, 'x'),
      dsyms: path.join(workspace, 'y')
    })
    await assert.rejects(macos(noApp.ctx), /no app/)
  })

  it('builds Android apps signed with the project keystore, checks the signer and keeps the mapping file', async () => {
    const sdk = path.join(workspace, 'sdk')
    mkdirSync(path.join(sdk, 'build-tools/37.0.0'), { recursive: true })
    const saved = process.env.ANDROID_HOME
    process.env.ANDROID_HOME = sdk
    try {
      const fake = fakeStage(workspace, 'build/teamstation-android')
      await android(fake.ctx)
      const gradle = fake.calls.find(call => call.file === './gradlew')!
      assert.equal(gradle.options.cwd, 'android')
      assert.equal(gradle.options.env!.DEPLOY_BUILD_NUMBER, '26102151')
      assert.equal(
        gradle.options.env!.DEPLOY_KEYSTORE,
        '/secrets/ANDROID_KEYSTORE'
      )
      assert.equal(gradle.options.env!.DEPLOY_KEY_ALIAS, 'androiddebugkey')
      assert.equal(
        gradle.options.env!.GOOGLE_MAPS_ANDROID_API_KEY,
        'maps-placeholder'
      )
      assert.match(
        readFileSync(
          path.join(workspace, OUTPUT, 'teamstation-android/signing.gradle'),
          'utf8'
        ),
        /DEPLOY_KEYSTORE/
      )
      assert.deepEqual(
        JSON.parse(
          readFileSync(path.join(workspace, 'clientConfig.json'), 'utf8')
        ),
        { appOrigin: 'https://app1.example.test' }
      )
      assert.deepEqual(
        fake.saved.map(([name]) => name),
        ['teamstation-android-mapping']
      )
      assert(
        fake.calls.some(call => call.args.includes('index.android.bundle'))
      )
      assert.equal(fake.published[0].platform, 'android')
      const kotlin = fakeStage(workspace, 'build/cameraman-android', {
        secrets: {
          TS_PIPELINE_CONFIG: JSON.stringify({
            ...config,
            appOrigin: undefined
          })
        }
      })
      await android(kotlin.ctx)
      const kotlinGradle = kotlin.calls.find(call => call.file === './gradlew')!
      assert.equal(kotlinGradle.options.cwd, 'mobile/apps/tsCameramanAndroid')
      assert.equal(
        kotlinGradle.options.env!.GOOGLE_MAPS_ANDROID_API_KEY,
        undefined
      )
      assert(kotlin.calls.some(call => call.args.includes('--native-libs')))
      assert(
        !existsSync(
          path.join(
            workspace,
            'mobile/apps/tsCameramanAndroid/clientConfig.json'
          )
        )
      )
      const wrongSigner = fakeStage(workspace, 'build/cameraman-android', {
        signer: `Signer #1 certificate SHA-256 digest: ${'cd'.repeat(32)}\n`
      })
      await assert.rejects(android(wrongSigner.ctx), /configured certificate/)
      rmSync(path.join(sdk, 'build-tools'), { recursive: true })
      mkdirSync(path.join(sdk, 'build-tools'))
      await assert.rejects(
        android(fakeStage(workspace, 'build/cameraman-android').ctx),
        /No Android build tools/
      )
      delete process.env.ANDROID_HOME
      delete process.env.ANDROID_SDK_ROOT
      await assert.rejects(
        android(fakeStage(workspace, 'build/cameraman-android').ctx),
        /ANDROID_HOME/
      )
    } finally {
      if (saved == null) delete process.env.ANDROID_HOME
      else process.env.ANDROID_HOME = saved
    }
  })

  it('reads the Android signing secret and the APK signer strictly', () => {
    assert.throws(() => androidSigning('null'), /must be an object/)
    assert.throws(
      () =>
        androidSigning(
          JSON.stringify({
            alias: 'a',
            storePassword: 'b',
            keyPassword: 'c',
            certificateSha256: 'AB'
          })
        ),
      /64 lowercase hex/
    )
    assert.equal(
      apkSigner(
        `V2 Signer: certificate SHA-256 digest: ${CERT.toUpperCase()}\nSigner #1 certificate SHA-256 digest: ${CERT}\n`
      ),
      CERT
    )
    assert.throws(
      () =>
        apkSigner(
          `Signer #1 certificate SHA-256 digest: ${CERT}\nNumber of signers: 2\n`
        ),
      /exactly one signer/
    )
    assert.throws(() => apkSigner(''), /exactly one signer/)
  })

  it('releases TeamStation to TestFlight’s groups from its App Store build', async () => {
    const fake = fakeStage(workspace, 'testflight', {
      params: { groups: 'Internal, Coaches ,' }
    })
    const result = (await appStore(fake.ctx)) as Record<string, Json>
    assert.deepEqual(result.groups, ['Internal', 'Coaches'])
    assert.equal(fake.archived[0].scheme, 'TeamStation')
    assert.deepEqual(fake.testflight, [
      {
        path: `${OUTPUT}/teamstation-ios/TeamStation.ipa`,
        groups: ['Internal', 'Coaches'],
        whatToTest: `feature/one ${'c'.repeat(7)}`,
        usesNonExemptEncryption: false
      }
    ])
    assert.deepEqual(fake.published, [])
    const none = fakeStage(workspace, 'testflight')
    none.ctx.apple.archive = async () => ({
      archive: path.join(workspace, 'x'),
      dsyms: path.join(workspace, 'y')
    })
    mkdirSync(path.join(workspace, 'x/Products/Applications/TeamStation.app'), {
      recursive: true
    })
    await assert.rejects(appStore(none.ctx), /no IPA/)
  })

  it('refuses a version that is not x.y.z and removes a client config with nothing in it', async () => {
    writeFileSync(path.join(workspace, 'package.json'), '{"version":"1.0"}')
    const fake = fakeStage(workspace, 'build/preview-ios')
    await assert.rejects(appVersion(fake.ctx), /x\.y\.z/)
    writeFileSync(path.join(workspace, 'clientConfig.json'), '{}')
    await writeClientConfig(fake.ctx, {
      row: rowFor('teamstation-android'),
      config: { seats: {} },
      version: '1.0.0',
      buildNumber: '1',
      origin: undefined,
      env: {}
    })
    assert(!existsSync(path.join(workspace, 'clientConfig.json')))
  })
})
