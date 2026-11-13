// The coverage gate for notifications on phones and browsers. Every measured
// run is recorded through `camera-focus-coverage.mjs record`, which ties its
// counters to the committed source, then the counters are merged, never the
// percentages, over this branch's production files:
//
//   combined (unit, integration and device): 95% of each changed file's
//     changed lines, overall, and of every line of a new file;
//   unit: 90% over the files of isolated logic (`unitScope`).
//
//   TS_COVERAGE_BASE=origin/develop npm run coverage.push
//
// `node scripts/push-coverage.mjs run <name>` is one run's own command, which
// `record` wraps. A milestone that ships code another way (Kotlin, Swift, a
// device run, an `.mjs` build edit) adds its run to `runs` or `mjsChecks`.
//
// The web device run (`run web`) starts the whole stack on ports of its own
// and runs `src/app/notifications.e2e.ts` against it: the API under V8
// coverage (`NODE_V8_COVERAGE`), from a folder holding its own
// `serverConfig.json`, the web app from `build.mjs --serve`, and the pages'
// and service worker's coverage from the browser, mapped through the served
// source maps. It needs
//
//   TS_PUSH_WEB_RUN       a scratch folder for the run (config, seed, logs)
//   TS_PUSH_WEB_DATABASE  a local database URL, dropped and made again
//   TS_PUSH_VAPID         a JSON file of { publicKey, privateKey, subject }
//   TS_NOTIFY_ARTIFACTS   where the scenarios' screenshots and logs go
//
// and takes TS_PUSH_WEB_API_PORT (9141) and TS_PUSH_WEB_PORT (8141).
//
// The Kotlin runs build with TS_PUSH_COVERAGE=1 (JAVA_HOME a JDK 17 to 21,
// ANDROID_HOME the SDK, TS_ANDROID_DEBUG_KEYSTORE as for any debug build).
// The emulator run (`run android`) builds and installs the debug app, starts
// the API as the web run does and Metro for the app on the emulator's
// address for this Mac, and runs N5 (`mobile/test/teamStationAppNotifications.e2e.ts`).
// It needs
//
//   TS_PUSH_ANDROID_RUN       a scratch folder for the run
//   TS_PUSH_ANDROID_DATABASE  a local database URL, dropped and made again
//   TS_PUSH_ANDROID_DEVICE    the emulator's serial, which it never chooses
//   MAESTRO_D                 a maestro-d daemon name of this run's own
//   TS_NOTIFY_ARTIFACTS       as above
//
// and takes TS_PUSH_ANDROID_API_PORT (9142) and TS_PUSH_METRO_PORT (8181).
//
// The Swift and Objective-C++ runs share one Release simulator build made for
// measuring them (`-enableCodeCoverage YES` and `TS_PUSH_COVERAGE`, so
// `Push/Coverage.swift` writes each process's counters to its own
// `push-<pid>.profraw` in its temporary directory), its JavaScript bundled
// with the API at this Mac's LAN address, which the simulator reaches and
// `app/native/config.ts` accepts. `run xctest` runs `TeamStationTests` over
// the wake vectors `scripts/pushWakeVectors.ts` writes; `run ios` starts the
// API on that address and runs N6, and the scenario reinstalls the build
// rebuilt with the filtering entitlement part way. Each reduces the profiles
// it collected off the simulator with `llvm-profdata` and `llvm-cov export`
// to lcov. They need
//
//   TS_PUSH_IOS_RUN       a scratch folder for the run
//   TS_PUSH_IOS_DATABASE  a local database URL, dropped and made again
//   TS_PUSH_IOS_DEVICE    the simulator's UDID, which it never chooses
//   TS_PUSH_IOS_HOST      this Mac's LAN address
//   MAESTRO_D             as above
//   TS_NOTIFY_ARTIFACTS   as above
//
// and take TS_PUSH_IOS_API_PORT (9143).
import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build, transformSync } from 'esbuild'

import { ASSET_LOADER } from '../src/esbuildLoaders.mjs'
import { mergeReports } from './camera-focus-coverage.mjs'
import { chatCoreResolvePlugin } from './chatCoreResolvePlugin.mjs'
import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
import { webSettings } from './web-build-settings.mjs'

const require = createRequire(import.meta.url)
const {
  changedLines,
  lineReportFromCounts
} = require('./changed-line-coverage.cjs')
const { coverageSource } = require('./coverage-provenance.cjs')

const base = process.env.TS_COVERAGE_BASE
if (base == null || base === '')
  throw new Error('Supply TS_COVERAGE_BASE, the ref this branch forked from')
const out = resolve('coverage/push')

/**
 * JaCoCo names a Kotlin file by its package, so its report is recorded once
 * against each source set: `PushDebugReceiver.kt` is in the debug one.
 */
const KOTLIN_ROOTS = ['android/app/src/main/java', 'android/app/src/debug/java']

/** The files of isolated logic, held to the unit bar as well. */
const unitScope = [
  /^src\/server\/push\/(config|apns|fcm|jwt|webPush|log|requests)\.ts$/,
  /^src\/app\/push\/(chatWake|chatWakeTask\.native|activeConversation)\.ts$/,
  /^src\/app\/web\/sw\.ts$/,
  /^src\/app\/hooks\/useForegroundEntry\.ts$/,
  /^src\/app\/platform\/(pushDevice[^/]*|sessionStore\.native)\.ts$/,
  /^src\/common\/accountSettings\.ts$/,
  /^src\/app\/chat\/engine\/decrypt\.ts$/,
  /^src\/app\/chat\/(chatModel|deviceApprovals)\.ts$/,
  /\/push\/(PushPayload|PushNotifications)\.kt$/,
  /\/(ChatWakeDecryptor|Push\/Push)\.swift$/
]

/**
 * Each measured run: its kind and report format as `record` takes them, and
 * the command that writes the report.
 */
const runs = [
  {
    name: 'unit',
    kind: 'unit',
    format: 'istanbul',
    // App suites run bundled, as `npm test` runs them.
    bundled: [
      'src/app/screens/AccountScreen.test.tsx',
      'src/app/hooks/useForegroundEntry.test.tsx',
      'src/app/push/activeConversation.test.tsx'
    ],
    specs: [
      'src/app/platform/pushDevice.test.ts',
      'src/app/platform/pushDevice.native.test.ts',
      'src/app/platform/sessionStore.native.test.ts',
      'src/app/push/chatWakeTask.native.test.ts',
      'src/app/push/chatWake.test.ts',
      'src/app/push/serviceWorker.test.ts',
      'src/app/chat/chatModel.test.ts',
      'src/app/chat/chatUiFollowupModel.test.ts',
      'src/app/chat/deviceApprovals.test.ts',
      'src/app/chat/engine/decrypt.test.ts',
      'src/app/chat/engine/dmTitle.test.ts',
      'src/common/api.test.ts',
      'src/common/gameSocket.test.ts',
      'src/common/ids.test.ts',
      'src/common/observability/errors.test.ts',
      'src/server/openapi.test.ts',
      'src/server/auth/apiKeyFamilies.test.ts',
      'src/server/backgroundJobs.test.ts',
      'src/server/push/apns.test.ts',
      'src/server/push/chatWakes.test.ts',
      'src/server/push/config.test.ts',
      'src/server/push/fcm.test.ts',
      'src/server/push/log.test.ts',
      'src/server/push/requests.test.ts',
      'src/server/push/send.test.ts',
      'src/server/push/webPush.test.ts',
      'src/server/serverConfig.test.ts',
      'src/server/statsBuilder/supervisor.test.ts',
      'src/server/tess/denyList.test.ts',
      'src/test/serviceWorkerBuild.test.ts'
    ]
  },
  {
    name: 'integration',
    kind: 'integration',
    format: 'istanbul',
    bundled: [],
    specs: [
      'src/migrate/migrations/118pushNotifications.integration.test.ts',
      'src/server/routes/accountNotifications.integration.test.ts',
      'src/server/routes/account.integration.test.ts',
      'src/server/account/deleteAccount.integration.test.ts',
      'src/server/routes/push.integration.test.ts',
      // A merge carries notification switches and reminders over.
      'src/server/admin/people.integration.test.ts',
      // With the hold, the seen skip, and a read taking notifications down.
      'src/server/push/chatWakes.integration.test.ts',
      // Whom a wake names in full, asked of every recipient at once.
      'src/server/access.integration.test.ts',
      'src/server/routes/chatMessages.integration.test.ts',
      'src/server/routes/chatPreferences.integration.test.ts',
      'src/server/push/rsvpReminders.integration.test.ts',
      // The push queue, and the sender forked as the server forks it.
      'src/server/push/queue.integration.test.ts',
      'src/server/push/sender/main.integration.test.ts',
      // Boots the server as `npm start` does: the routes `index.ts` mounts.
      'src/server/serverStart.integration.test.ts'
    ]
  },
  // The finished web app in a browser, its API and its service worker.
  { name: 'web', kind: 'device', format: 'istanbul', device: 'web' },
  // The Masonfile's cases (`coverage.mason`, which checks its own 90%).
  {
    name: 'mason',
    kind: 'unit',
    format: 'istanbul',
    command: ['npm', 'run', 'coverage.mason'],
    report: resolve('coverage/mason/coverage-final.json')
  },
  // The Kotlin push classes' JUnit run (PushPayloadTest, PushNotificationsTest).
  {
    name: 'kotlin',
    kind: 'unit',
    format: 'jacoco',
    device: 'kotlin',
    report: resolve(out, 'kotlin', 'main.xml'),
    root: resolve(KOTLIN_ROOTS[0]),
    also: [
      {
        kind: 'unit',
        format: 'jacoco',
        from: resolve(out, 'kotlin', 'pushCoverage.xml'),
        root: resolve(KOTLIN_ROOTS[1])
      }
    ]
  },
  // N5 on the emulator: the app's JaCoCo counters from every process, and
  // the API's and the scenario's own Node coverage.
  {
    name: 'android',
    kind: 'device',
    format: 'jacoco',
    device: 'android',
    report: resolve(out, 'android', 'main.xml'),
    root: resolve(KOTLIN_ROOTS[0]),
    also: [
      {
        kind: 'device',
        format: 'jacoco',
        from: resolve(out, 'android', 'pushCoverage.xml'),
        root: resolve(KOTLIN_ROOTS[1])
      },
      {
        kind: 'device',
        format: 'istanbul',
        from: resolve(out, 'android', 'node', 'coverage-final.json'),
        root: process.cwd()
      }
    ]
  },
  // TeamStationTests in the simulator: the decryptor over the wake vectors,
  // `Push.swift` and `RCTPush.mm`.
  { name: 'xctest', kind: 'unit', format: 'lcov', device: 'xctest' },
  // N6 on the simulator: the app's and the extension's counters, and the
  // API's and the scenario's own Node coverage.
  {
    name: 'ios',
    kind: 'device',
    format: 'lcov',
    device: 'ios',
    also: [
      {
        kind: 'device',
        format: 'istanbul',
        from: resolve(out, 'ios', 'node', 'coverage-final.json'),
        root: process.cwd()
      }
    ]
  }
].map(run => ({
  report: resolve(
    out,
    run.name,
    run.format === 'lcov' ? 'push.lcov' : 'coverage-final.json'
  ),
  root: process.cwd(),
  also: [],
  ...run
}))

/**
 * `.mjs` production edits, which the gate cannot count: each is measured by
 * its own specs and checked with `changed-line-check.cjs`.
 */
const mjsChecks = [
  {
    name: 'build',
    files: ['scripts/serviceWorkerBuild.mjs', 'src/build.mjs'],
    // The second runs `build.mjs` itself, once and serving.
    specs: [
      'src/test/serviceWorkerBuild.test.ts',
      'src/buildCsp.integration.test.ts'
    ]
  }
]

function run(command, args, env = {}) {
  console.log('$', command, ...args)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

const fork = git('merge-base', base, 'HEAD')
const changed = [
  ...new Set([
    ...git('diff', '--name-only', fork).split('\n'),
    ...git('ls-files', '--others', '--exclude-standard').split('\n')
  ])
].filter(Boolean)

/** Whether a TypeScript file holds anything but types and imports. */
function runtime(path) {
  if (!/\.tsx?$/.test(path)) return true
  const { code } = transformSync(readFileSync(path, 'utf8'), {
    loader: path.endsWith('x') ? 'tsx' : 'ts',
    format: 'esm'
  })
  return (
    code.replace(/^\s*(export\s*\{\s*\};?|import\s[^;]*;)\s*$/gm, '').trim() !==
    ''
  )
}
/** This branch's production files: no tests, fixtures, generated code or types. */
const scope = changed.filter(
  path =>
    existsSync(path) &&
    (/^src\/.+\.tsx?$/.test(path) ||
      path === 'Masonfile.ts' ||
      /^android\/app\/src\/(main|debug)\/.+\.kt$/.test(path) ||
      /^ios\/.+\.(swift|mm)$/.test(path)) &&
    !/\.(test|e2e|integration|smoke)\./.test(path) &&
    !/\.d\.ts$/.test(path) &&
    !/(^|\/)(src\/test|[^/]*Tests?|androidTest)\//.test(path) &&
    path !== 'src/server/chat/chatTestFixture.ts' &&
    path !== 'src/server/dev/chatSeed.ts' &&
    runtime(path)
)

/** One istanbul run: mocha under V8 coverage, mapped back to the sources. */
async function istanbul(spec) {
  const temp = resolve(out, spec.name, 'tmp')
  rmSync(resolve(out, spec.name), { recursive: true, force: true })
  mkdirSync(temp, { recursive: true })
  const files = [...spec.specs]
  if (spec.bundled.length > 0) {
    const bundle = resolve('lib', `push-${spec.name}-tests.cjs`)
    mkdirSync('lib', { recursive: true })
    // As build-scoring-tests.mjs bundles them for `npm test`.
    await build({
      ...webSettings,
      plugins: [
        ...webSettings.plugins,
        chatCoreResolvePlugin(),
        pagedListStandInPlugin()
      ],
      alias: {
        ...webSettings.alias,
        'react-native/Libraries/Utilities/DevLoadingView':
          './src/test/tvDevLoadingStub.ts',
        'react-native-webview': './src/test/eventWebViewStub.tsx',
        'react-native-maps': './src/test/eventNativeMapStub.tsx',
        '@react-native-clipboard/clipboard': './src/test/eventClipboardStub.ts',
        '@react-native-community/geolocation': './src/test/geolocationStub.ts',
        '@react-native/assets-registry/registry':
          'react-native-web/dist/modules/AssetRegistry'
      },
      stdin: {
        contents: [
          "import { describe } from 'mocha'",
          ...spec.bundled.map(
            file => `describe('', () => {\n  require('./${file}')\n})`
          )
        ].join('\n'),
        resolveDir: process.cwd(),
        sourcefile: `push-${spec.name}-entry.ts`
      },
      outfile: bundle,
      platform: 'node',
      format: 'cjs',
      bundle: true,
      jsx: 'automatic',
      external: [
        'react',
        'react-dom',
        'three',
        '@react-three/fiber',
        '@react-three/test-renderer',
        'jsdom',
        'mocha',
        'chai'
      ],
      sourcemap: true,
      define: {
        __DEV__: 'true',
        TS_CHAT_NODE_ADDON: JSON.stringify(
          resolve('src/common/chatCrypto/node/chat_crypto.node')
        ),
        TS_API_BASE_URL: JSON.stringify('/api/v1'),
        'process.env.TS_SENTRY_DSN': JSON.stringify(''),
        'process.env.NODE_ENV': JSON.stringify('test')
      },
      loader: ASSET_LOADER
    })
    files.push(bundle)
  }
  run(
    'node_modules/.bin/mocha',
    [
      '-r',
      'sucrase/register',
      '-r',
      './src/test/scoringDomSetup.cjs',
      '--timeout',
      '60000',
      '--exit',
      ...files
    ],
    { NODE_V8_COVERAGE: temp }
  )
  c8Report(temp, resolve(out, spec.name))
  rmSync(temp, { recursive: true, force: true })
}

/** Node's V8 coverage in `temp`, mapped to this branch's sources in `dir`. */
function c8Report(temp, dir) {
  for (const name of readdirSync(temp)) {
    const file = resolve(temp, name)
    const value = JSON.parse(readFileSync(file, 'utf8'))
    for (const map of Object.values(value['source-map-cache'] ?? {}))
      if (map.data?.sources != null)
        map.data.sources = map.data.sources.map(source =>
          source.startsWith('file://') ? fileURLToPath(source) : source
        )
    writeFileSync(file, JSON.stringify(value))
  }
  const measured = scope.filter(path => /\.tsx?$/.test(path))
  run('node_modules/.bin/c8', [
    'report',
    '--all',
    '--temp-directory',
    temp,
    '--reporter=json',
    '--reports-dir',
    dir,
    '--exclude-after-remap',
    ...measured.flatMap(path => ['--include', path]),
    '--exclude',
    '**/*.test.*',
    '--exclude',
    '**/*.e2e.*',
    '--exclude',
    'src/test/**'
  ])
}

function required(name) {
  const value = process.env[name]
  if (value == null || value === '') throw new Error(`Supply ${name}`)
  return value
}

/** A child that is told when it said `pattern`, and keeps what it said. */
function started(name, command, args, options, pattern) {
  console.log('$', command, ...args)
  const child = spawn(command, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let said = ''
  const ready = new Promise((resolve, reject) => {
    const hear = chunk => {
      said += chunk.toString()
      process.stdout.write(`[${name}] ${chunk}`)
      if (pattern.test(said)) resolve()
    }
    child.stdout.on('data', hear)
    child.stderr.on('data', hear)
    child.once('exit', code => {
      reject(new Error(`${name} exited ${code} before it was ready`))
    })
  })
  return { child, ready }
}

async function stopped(child, signal = 'SIGTERM') {
  if (child.exitCode != null || child.signalCode != null) return
  const gone = new Promise(resolve => child.once('exit', resolve))
  child.kill(signal)
  await gone
}

/**
 * The API on a database of its own, with the chat fixture in it, as
 * `scripts/chat-e2e-reset.sh` makes it, from `folder`'s own
 * `serverConfig.json`: the local configuration moved onto this run's
 * database, port, push log and Valkey prefix, with background jobs on, so
 * the push sender it forks drains its push queue (emptied first) into the
 * log. The API, and the sender with it, run under V8 coverage into `temp`.
 * `<folder>/seed.txt` is the fixture's people.
 */
async function apiStack({
  folder,
  databaseUrl,
  apiPort,
  temp,
  cors,
  push,
  prefix,
  listenHost = '127.0.0.1'
}) {
  const database =
    /^postgres(?:ql)?:\/\/(localhost|127\.0\.0\.1):(\d+)\/([A-Za-z0-9_]+)$/.exec(
      databaseUrl
    )
  if (database == null)
    throw new Error('The run database must be one on this machine')
  const api = resolve(folder, 'api')
  rmSync(api, { recursive: true, force: true })
  for (const dir of [api, temp]) mkdirSync(dir, { recursive: true })
  rmSync(resolve(folder, 'push.jsonl'), { force: true })

  const local = JSON.parse(readFileSync('serverConfig.json', 'utf8'))
  const config = {
    ...local,
    databaseUrl,
    databasePoolUrl: '',
    listenHost,
    listenPort: apiPort,
    clusterWorkers: 1,
    workDir: resolve(folder, 'work'),
    mediaDir: resolve(folder, 'media'),
    uploadsDir: resolve(folder, 'uploads'),
    corsOrigins: cors,
    redis: { ...local.redis, prefix },
    backgroundJobs: true,
    logRequests: false,
    push: {
      ...push,
      iosFiltering: false,
      logFile: resolve(folder, 'push.jsonl'),
      // A post waits 2 s, not 15, before it wakes anybody: long enough for
      // a reader on the conversation to have read it, short for each step.
      chatHoldSeconds: 2
    }
  }
  const configFile = resolve(api, 'serverConfig.json')
  writeFileSync(configFile, JSON.stringify(config, null, 2))

  // An earlier run's requests would be for a database that is gone.
  const { createClient } = require('redis')
  const valkey = createClient({ url: config.redis.url })
  await valkey.connect()
  for (const key of ['requests', 'later', 'dead'])
    await valkey.del(`${prefix}:push:${key}`)
  for (const key of await valkey.keys(`${prefix}:push:woken:*`))
    await valkey.del(key)
  await valkey.close()

  const [, , port, name] = database
  run('dropdb', ['-h', 'localhost', '-p', port, '--if-exists', '--force', name])
  run('createdb', ['-h', 'localhost', '-p', port, name])
  const register = require.resolve('sucrase/register')
  const inApi = { cwd: api, stdio: 'inherit' }
  if (
    spawnSync(
      process.execPath,
      ['-r', register, resolve('src/migrate/cli.ts'), 'up'],
      inApi
    ).status !== 0
  )
    throw new Error('Migrating the run database failed')
  const seeded = spawnSync(
    process.execPath,
    ['-r', register, resolve('src/server/dev/chatSeed.ts')],
    { cwd: api, encoding: 'utf8' }
  )
  if (seeded.status !== 0) throw new Error(`chat-seed failed: ${seeded.stderr}`)
  const seed = resolve(folder, 'seed.txt')
  writeFileSync(seed, seeded.stdout, { mode: 0o600 })

  const server = started(
    'api',
    process.execPath,
    ['-r', register, resolve('src/server/index.ts')],
    { cwd: api, env: { ...process.env, NODE_V8_COVERAGE: temp } },
    /listening on/
  )
  return { configFile, seed, server }
}

/**
 * The web device run: the chat fixture in a database of its own, the API
 * and the web app on ports of their own, and the notification scenarios in a
 * real browser. The API's and the scenarios' own Node coverage (the reminder
 * sweep runs in the scenarios) and the browser's are one istanbul report.
 */
async function webDevice(spec) {
  const folder = resolve(required('TS_PUSH_WEB_RUN'))
  const vapid = JSON.parse(readFileSync(required('TS_PUSH_VAPID'), 'utf8'))
  const artifacts = resolve(required('TS_NOTIFY_ARTIFACTS'))
  const apiPort = Number(process.env.TS_PUSH_WEB_API_PORT ?? 9141)
  const webPort = Number(process.env.TS_PUSH_WEB_PORT ?? 8141)
  const web = `http://127.0.0.1:${webPort}`
  const served = resolve(folder, 'web')
  const temp = resolve(out, spec.name, 'tmp')
  for (const dir of [served, resolve(out, spec.name)])
    rmSync(dir, { recursive: true, force: true })
  mkdirSync(served, { recursive: true })
  const { configFile, server } = await apiStack({
    folder,
    databaseUrl: required('TS_PUSH_WEB_DATABASE'),
    apiPort,
    temp,
    cors: [web],
    prefix: 'notify-e2e:',
    push: {
      webPush: {
        publicKey: vapid.publicKey,
        privateKey: vapid.privateKey,
        subject: vapid.subject
      }
    }
  })
  const page = started(
    'web',
    process.execPath,
    ['-r', './src/test/exitOnTerm.cjs', 'src/build.mjs', '--serve'],
    {
      env: {
        ...process.env,
        TS_API_BASE_URL: `http://127.0.0.1:${apiPort}/api/v1`,
        TS_SERVE_PORT: String(webPort),
        TS_WEB_OUT_DIR: served
      }
    },
    /app on http/
  )
  const browser = resolve(out, spec.name, 'browser.json')
  let status = 1
  try {
    await Promise.all([server.ready, page.ready])
    status =
      spawnSync(
        'node_modules/.bin/mocha',
        [
          '-r',
          'sucrase/register',
          '--timeout',
          '600000',
          '--exit',
          'src/app/notifications.e2e.ts'
        ],
        {
          stdio: 'inherit',
          env: {
            ...process.env,
            NODE_V8_COVERAGE: temp,
            TS_NOTIFY_ARTIFACTS: artifacts,
            TS_NOTIFY_CONFIG: configFile,
            TS_NOTIFY_SEED: resolve(folder, 'seed.txt'),
            TS_NOTIFY_WEB: web,
            TS_NOTIFY_API: `http://127.0.0.1:${apiPort}/api/v1`,
            TS_NOTIFY_SERVED: served,
            TS_NOTIFY_COVERAGE: browser
          }
        }
      ).status ?? 1
  } finally {
    await stopped(server.child)
    await stopped(page.child)
  }
  if (status !== 0) throw new Error('The web notification scenarios failed')
  c8Report(temp, resolve(out, spec.name, 'node'))
  rmSync(temp, { recursive: true, force: true })
  const { createCoverageMap } = require('istanbul-lib-coverage')
  const merged = createCoverageMap({})
  for (const file of [
    browser,
    resolve(out, spec.name, 'node', 'coverage-final.json')
  ])
    merged.merge(JSON.parse(readFileSync(file, 'utf8')))
  writeFileSync(spec.report, JSON.stringify(merged.toJSON()))
}

/** Gradle in `android/`, with a coverage build's switch on. */
function gradle(args, env = {}) {
  console.log('$ (cd android &&', ...args, ')')
  const result = spawnSync('./gradlew', ['--console=plain', ...args], {
    cwd: 'android',
    stdio: 'inherit',
    env: { ...process.env, TS_PUSH_COVERAGE: '1', ...env }
  })
  if (result.status !== 0) throw new Error(`gradle ${args.join(' ')} failed`)
}

/**
 * `pushCoverage` over `execs`, written to the run's two reports: the one it
 * records against the main source set, and the copy for the debug one.
 */
function jacocoReports(spec, execs) {
  gradle([':app:pushCoverage', '--rerun'], { TS_PUSH_EXEC: execs.join(',') })
  const xml = resolve(
    'android/app/build/reports/jacoco/pushCoverage/pushCoverage.xml'
  )
  mkdirSync(resolve(out, spec.name), { recursive: true })
  copyFileSync(xml, spec.report)
  copyFileSync(xml, spec.also[0].from)
}

/** The JUnit run of the push classes, measured. */
async function kotlinUnit(spec) {
  rmSync(resolve(out, spec.name), { recursive: true, force: true })
  gradle([':app:testDebugUnitTest', '--tests', '*Push*Test', '--rerun'])
  jacocoReports(spec, [
    resolve(
      'android/app/build/outputs/unit_test_code_coverage/debugUnitTest/testDebugUnitTest.exec'
    )
  ])
}

function adb(serial, ...args) {
  run('adb', ['-s', serial, ...args])
}

/**
 * The emulator run: the debug app built with coverage and installed, the
 * API with the chat fixture, Metro serving the app's JavaScript with the API
 * at the emulator's address for this Mac (10.0.2.2), and N5. Every `.ec`
 * the scenario pulls off the emulator goes into one JaCoCo report.
 */
async function androidDevice(spec) {
  const folder = resolve(required('TS_PUSH_ANDROID_RUN'))
  const serial = required('TS_PUSH_ANDROID_DEVICE')
  const daemon = required('MAESTRO_D')
  const artifacts = resolve(required('TS_NOTIFY_ARTIFACTS'))
  const apiPort = Number(process.env.TS_PUSH_ANDROID_API_PORT ?? 9142)
  const metroPort = Number(process.env.TS_PUSH_METRO_PORT ?? 8181)
  const temp = resolve(out, spec.name, 'tmp')
  const pulled = resolve(folder, 'ec')
  for (const dir of [resolve(out, spec.name), pulled])
    rmSync(dir, { recursive: true, force: true })
  mkdirSync(pulled, { recursive: true })

  // The emulator reaches Metro on this Mac at 10.0.2.2, on the port built in.
  gradle([`-PreactNativeDevServerPort=${metroPort}`, ':app:assembleDebug'])
  const apk = resolve('android/app/build/outputs/apk/debug/app-debug.apk')
  adb(serial, 'install', '-r', apk)
  const { configFile, seed, server } = await apiStack({
    folder,
    databaseUrl: required('TS_PUSH_ANDROID_DATABASE'),
    apiPort,
    temp,
    cors: [],
    prefix: 'notify-android-e2e:',
    push: {}
  })
  const metro = started(
    'metro',
    resolve('node_modules/.bin/react-native'),
    ['start', '--port', String(metroPort), '--reset-cache'],
    {
      env: {
        ...process.env,
        TS_API_BASE_URL: `http://10.0.2.2:${apiPort}/api/v1`
      }
    },
    /Dev server ready|Welcome to Metro/
  )
  let status = 1
  try {
    await Promise.all([server.ready, metro.ready])
    status =
      spawnSync(
        process.execPath,
        [
          '-r',
          'sucrase/register',
          'mobile/test/teamStationAppNotifications.e2e.ts'
        ],
        {
          stdio: 'inherit',
          env: {
            ...process.env,
            NODE_V8_COVERAGE: temp,
            MAESTRO_D: daemon,
            TS_E2E_DEVICE: serial,
            TS_NOTIFY_ARTIFACTS: artifacts,
            TS_NOTIFY_CONFIG: configFile,
            TS_NOTIFY_SEED: seed,
            TS_NOTIFY_API: `http://127.0.0.1:${apiPort}/api/v1`,
            TS_NOTIFY_APK: apk,
            TS_NOTIFY_METRO_PORT: String(metroPort),
            TS_NOTIFY_METRO_PID: String(metro.child.pid),
            TS_PUSH_COVERAGE_DIR: pulled
          }
        }
      ).status ?? 1
  } finally {
    await stopped(server.child)
    await stopped(metro.child)
  }
  if (status !== 0) throw new Error('The Android notification scenario failed')
  const execs = readdirSync(pulled)
    .filter(name => name.endsWith('.ec'))
    .map(name => resolve(pulled, name))
  if (execs.length === 0)
    throw new Error('No coverage was pulled off the emulator')
  jacocoReports(spec, execs)
  c8Report(temp, resolve(out, spec.name, 'node'))
  rmSync(temp, { recursive: true, force: true })
}

/** The simulator build both Swift runs measure, and where it is. */
const iosBuild = {
  derived: resolve('ios/build/push'),
  get products() {
    return resolve(this.derived, 'Build/Products/Release-iphonesimulator')
  },
  get app() {
    return resolve(this.products, 'TeamStation.app')
  },
  get appex() {
    return resolve(this.app, 'PlugIns/TeamStationNotifications.appex')
  }
}

function iosApi() {
  const host = required('TS_PUSH_IOS_HOST')
  const port = Number(process.env.TS_PUSH_IOS_API_PORT ?? 9143)
  return { host, port, url: `http://${host}:${port}/api/v1` }
}

/**
 * The Release simulator build for measuring, its JavaScript bundled with the
 * API at `iosApi()` (afresh, since Babel inlines it). `entitlements` picks
 * the extension's (`TS_NSE_ENTITLEMENTS`); a second build with the other
 * only signs the extension again.
 */
function buildIos(
  udid,
  entitlements = 'TeamStationNotifications.entitlements'
) {
  run(
    'xcodebuild',
    [
      'build-for-testing',
      '-workspace',
      'ios/TeamStation.xcworkspace',
      '-scheme',
      'TeamStation',
      '-configuration',
      'Release',
      '-destination',
      `platform=iOS Simulator,id=${udid}`,
      '-derivedDataPath',
      iosBuild.derived,
      '-enableCodeCoverage',
      'YES',
      'OTHER_SWIFT_FLAGS=$(inherited) -DTS_PUSH_COVERAGE',
      `TS_NSE_ENTITLEMENTS=${entitlements}`
    ],
    {
      TS_API_BASE_URL: iosApi().url,
      EXTRA_PACKAGER_ARGS: '--reset-cache'
    }
  )
}

/** Every `push-*.profraw` the app and its extension wrote on the simulator. */
function profiles(udid) {
  const found = []
  const containers = resolve(
    homedir(),
    'Library/Developer/CoreSimulator/Devices',
    udid,
    'data/Containers/Data'
  )
  for (const kind of ['Application', 'PluginKitPlugin']) {
    const dir = resolve(containers, kind)
    if (!existsSync(dir)) continue
    for (const container of readdirSync(dir)) {
      const tmp = resolve(dir, container, 'tmp')
      if (!existsSync(tmp)) continue
      for (const name of readdirSync(tmp))
        if (/^push-\d+\.profraw$/.test(name)) found.push(resolve(tmp, name))
    }
  }
  return found
}

/** Moves the simulator's profiles into `into`, named so none overwrites another. */
function collectProfiles(udid, into) {
  mkdirSync(into, { recursive: true })
  for (const file of profiles(udid)) {
    const container = basename(resolve(file, '../..'))
    copyFileSync(file, resolve(into, `${container}-${basename(file)}`))
    rmSync(file)
  }
}

/**
 * The profiles in `dir` reduced to lcov over the app's and the extension's
 * own sources: `llvm-profdata merge`, then `llvm-cov export` against both
 * binaries.
 */
function lcovReport(spec, dir) {
  const raw = readdirSync(dir)
    .filter(name => name.endsWith('.profraw'))
    .map(name => resolve(dir, name))
  if (raw.length === 0)
    throw new Error(`No profiles were collected for ${spec.name}`)
  const profdata = resolve(out, spec.name, 'push.profdata')
  run('xcrun', ['llvm-profdata', 'merge', '-sparse', ...raw, '-o', profdata])
  const exported = spawnSync(
    'xcrun',
    [
      'llvm-cov',
      'export',
      '-format=lcov',
      // A Release simulator build holds both simulator architectures; the
      // simulator ran the arm64 one of each binary.
      '-arch',
      'arm64',
      '-arch',
      'arm64',
      '-instr-profile',
      profdata,
      resolve(iosBuild.app, 'TeamStation'),
      '-object',
      resolve(iosBuild.appex, 'TeamStationNotifications')
    ],
    { encoding: 'utf8', maxBuffer: 1 << 30 }
  )
  if (exported.status !== 0)
    throw new Error(`llvm-cov export: ${exported.stderr}`)
  // The app's and the extension's own files; not the pods linked in.
  const own = [
    resolve('ios/TeamStation'),
    resolve('ios/TeamStationNotifications')
  ]
  const records = exported.stdout.split('end_of_record\n').filter(record => {
    const file = /^SF:(.*)$/m.exec(record)?.[1]
    return file != null && own.some(dir => file.startsWith(`${dir}/`))
  })
  writeFileSync(
    spec.report,
    records.map(record => `${record}end_of_record\n`).join('')
  )
}

/** TeamStationTests on the simulator, over freshly written wake vectors. */
async function xctestRun(spec) {
  const udid = required('TS_PUSH_IOS_DEVICE')
  const dir = resolve(out, spec.name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const vectors = resolve(dir, 'wakeVectors.json')
  run(process.execPath, [
    '-r',
    'sucrase/register',
    'scripts/pushWakeVectors.ts',
    vectors
  ])
  buildIos(udid)
  for (const file of profiles(udid)) rmSync(file)
  run(
    'xcodebuild',
    [
      'test-without-building',
      '-workspace',
      'ios/TeamStation.xcworkspace',
      '-scheme',
      'TeamStation',
      '-configuration',
      'Release',
      '-destination',
      `platform=iOS Simulator,id=${udid}`,
      '-derivedDataPath',
      iosBuild.derived,
      '-resultBundlePath',
      resolve(dir, 'push.xcresult')
    ],
    {
      TEST_RUNNER_TS_WAKE_VECTORS: vectors,
      TEST_RUNNER_TS_CHAT_OPS: resolve('src/common/chatCrypto/ops.json')
    }
  )
  collectProfiles(udid, resolve(dir, 'profraw'))
  lcovReport(spec, resolve(dir, 'profraw'))
}

/**
 * N6: the measured build installed, the API with the chat fixture on this
 * Mac's LAN address, and the scenario, which reinstalls the copy of the
 * build signed with the filtering entitlement when it comes to it.
 */
async function iosDevice(spec) {
  const folder = resolve(required('TS_PUSH_IOS_RUN'))
  const udid = required('TS_PUSH_IOS_DEVICE')
  const daemon = required('MAESTRO_D')
  const artifacts = resolve(required('TS_NOTIFY_ARTIFACTS'))
  const api = iosApi()
  const dir = resolve(out, spec.name)
  const temp = resolve(dir, 'tmp')
  const pulled = resolve(dir, 'profraw')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(pulled, { recursive: true })

  // The filtering build, copied aside, then the default one, which stays
  // built for `lcovReport`. Only the extension is signed again in between.
  const filtering = resolve(folder, 'filtering', 'TeamStation.app')
  rmSync(resolve(folder, 'filtering'), { recursive: true, force: true })
  mkdirSync(resolve(folder, 'filtering'), { recursive: true })
  buildIos(udid, 'TeamStationNotifications.filtering.entitlements')
  run('ditto', [iosBuild.app, filtering])
  buildIos(udid)
  for (const file of profiles(udid)) rmSync(file)
  run('xcrun', ['simctl', 'install', udid, iosBuild.app])

  const { configFile, seed, server } = await apiStack({
    folder,
    databaseUrl: required('TS_PUSH_IOS_DATABASE'),
    apiPort: api.port,
    temp,
    cors: [],
    prefix: 'notify-ios-e2e:',
    push: {},
    listenHost: api.host
  })
  let status = 1
  try {
    await server.ready
    status =
      spawnSync(
        process.execPath,
        [
          '-r',
          'sucrase/register',
          'mobile/test/teamStationAppNotifications.e2e.ts'
        ],
        {
          stdio: 'inherit',
          env: {
            ...process.env,
            NODE_V8_COVERAGE: temp,
            MAESTRO_D: daemon,
            TS_NOTIFY_PLATFORM: 'ios',
            TS_E2E_DEVICE: udid,
            TS_NOTIFY_ARTIFACTS: artifacts,
            TS_NOTIFY_CONFIG: configFile,
            TS_NOTIFY_SEED: seed,
            TS_NOTIFY_API: api.url,
            TS_NOTIFY_APP: iosBuild.app,
            TS_NOTIFY_FILTERING_APP: filtering,
            TS_PUSH_COVERAGE_DIR: pulled
          }
        }
      ).status ?? 1
  } finally {
    await stopped(server.child)
  }
  if (status !== 0) throw new Error('The iOS notification scenario failed')
  collectProfiles(udid, pulled)
  lcovReport(spec, pulled)
  c8Report(temp, resolve(dir, 'node'))
  rmSync(temp, { recursive: true, force: true })
}

if (process.argv[2] === 'run') {
  const spec = runs.find(item => item.name === process.argv[3])
  if (spec == null) throw new Error(`No run ${process.argv[3]}`)
  if (spec.device === 'web') await webDevice(spec)
  else if (spec.device === 'kotlin') await kotlinUnit(spec)
  else if (spec.device === 'android') await androidDevice(spec)
  else if (spec.device === 'xctest') await xctestRun(spec)
  else if (spec.device === 'ios') await iosDevice(spec)
  else if (spec.command != null) run(spec.command[0], spec.command.slice(1))
  else await istanbul(spec)
  process.exit(0)
}
// `record` of a report a run already wrote, under another source root or format.
if (process.argv[2] === 'copy') {
  copyFileSync(process.argv[3], process.argv[4])
  process.exit(0)
}

console.log(
  `Push coverage over ${scope.length} files:\n  ${scope.join('\n  ')}`
)
run('node', ['scripts/chatCryptoBuild.mjs', 'node', 'wasm'])
const sidecars = []
for (const spec of runs) {
  const sidecar = resolve(out, `${spec.name}.provenance.json`)
  mkdirSync(out, { recursive: true })
  run('node', [
    'scripts/camera-focus-coverage.mjs',
    '--base',
    base,
    'record',
    sidecar,
    spec.kind,
    spec.format,
    spec.report,
    spec.root,
    '--',
    process.execPath,
    'scripts/push-coverage.mjs',
    'run',
    spec.name
  ])
  sidecars.push(sidecar)
  for (const [index, extra] of spec.also.entries()) {
    const also = resolve(out, `${spec.name}-${index + 1}.provenance.json`)
    const report = `${extra.from}.recorded`
    run('node', [
      'scripts/camera-focus-coverage.mjs',
      '--base',
      base,
      'record',
      also,
      extra.kind,
      extra.format,
      report,
      extra.root,
      '--',
      process.execPath,
      'scripts/push-coverage.mjs',
      'copy',
      extra.from,
      report
    ])
    sidecars.push(also)
  }
}
for (const check of mjsChecks) {
  const report = resolve(out, 'mjs', check.name)
  run('node_modules/.bin/c8', [
    '--reporter=json',
    '--report-dir',
    report,
    ...check.files.flatMap(file => ['--include', file]),
    'node_modules/.bin/mocha',
    '-r',
    'sucrase/register',
    '--timeout',
    '120000',
    '--exit',
    ...check.specs
  ])
  run('node', [
    'scripts/changed-line-check.cjs',
    '--base',
    base,
    '--coverage',
    resolve(report, 'coverage-final.json'),
    '--ext',
    '.mjs',
    '--min',
    '95',
    ...check.files
  ])
}

// The gate: counters merged from the same committed revision.
const source = coverageSource(process.cwd(), base)
const { counts, unit } = mergeReports(
  source,
  sidecars.map(file => JSON.parse(readFileSync(file, 'utf8')))
)
const changes = Object.fromEntries(
  Object.entries(
    changedLines(git('diff', '--unified=0', fork, 'HEAD', '--', ...scope))
  ).filter(([path]) => scope.includes(path))
)
const newFiles = git('diff', '--name-only', '--diff-filter=A', fork, 'HEAD')
  .split('\n')
  .filter(path => scope.includes(path))
const gate = (lines, measured, min) =>
  lineReportFromCounts(lines, measured, () => true, {
    newFiles,
    min,
    perFileMin: min,
    newFileMin: min
  })
const combined = gate(changes, counts, 95)
const unitChanges = Object.fromEntries(
  Object.entries(changes).filter(([path]) =>
    unitScope.some(pattern => pattern.test(path))
  )
)
const units = gate(unitChanges, unit, 90)
writeFileSync(
  resolve(out, 'gate.json'),
  JSON.stringify({ source, combined, unit: units }, null, 2)
)
function print(title, result) {
  console.log(`\n${title}`)
  for (const [path, lines] of Object.entries(result.files)) {
    const total = lines.covered.length + lines.uncovered.length
    if (total === 0) continue
    const own = result.newFiles[path]
    console.log(
      `  ${path}: ${((100 * lines.covered.length) / total).toFixed(2)}% of changed lines (${lines.covered.length}/${total})` +
        (own == null ? '' : `, ${own.toFixed(2)}% of the new file`) +
        (lines.uncovered.length > 0
          ? `; uncovered ${lines.uncovered.join(',')}`
          : '')
    )
  }
  console.log(
    `  overall: ${result.percent.toFixed(2)}% (${result.covered}/${result.total})`
  )
  if (result.missing.length > 0)
    console.log(`  no counters: ${result.missing.join(', ')}`)
  for (const path of [...result.shortFiles, ...result.shortNewFiles])
    console.log(`  below the bar: ${path}`)
}
print('Combined (unit, integration and device), minimum 95%:', combined)
print('Unit only, minimum 90%:', units)
if (!combined.pass || !units.pass || combined.total === 0)
  throw new Error(
    'Push coverage gate failed: unit 90%, combined 95% per file, overall and on new files; a changed file with no counters fails'
  )
