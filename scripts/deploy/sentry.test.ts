import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import { bundledSentryCli, loadSettings } from './config'
import { app, fixtureSettings, testRoot } from './config.test'
import { type Command, Processes } from './process'
import {
  builtApp,
  relativeSources,
  sentryBuildEnvironment,
  sentryCliEnvironment,
  sentryRelease,
  type SentrySettings,
  sentryUploader
} from './sentry'
import {
  main,
  parseUploadArgs,
  requireSentryEnvironment,
  runUpload
} from './sentryUpload'
import { sentryDsn } from './validation'

const DSN = 'https://0123456789abcdef0123456789abcdef@sentry.example.test/2'

let root: string
let calls: Command[]
let fail = false
let original: Processes['run']

function file(name: string, content = 'fixture', mode = 0o600): string {
  mkdirSync(path.dirname(name), { recursive: true })
  writeFileSync(name, content, { mode })
  return name
}

function settings(): SentrySettings {
  return {
    origin: 'https://sentry.example.test',
    org: 'teamstation',
    project: 'teamstation-app',
    dsn: DSN,
    tokenFile: file(
      path.join(root, 'sentry-token.json'),
      JSON.stringify({
        schemaVersion: 1,
        origin: 'https://sentry.example.test',
        token: 'sntrys_fixture'
      })
    )
  }
}

describe('Sentry symbol uploads', () => {
  beforeEach(() => {
    root = testRoot('sentry-')
    calls = []
    fail = false
    // Preserve the prototype method for restoration, never call it unbound.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    original = Processes.prototype.run
    Processes.prototype.run = async function (command) {
      // The staged bundle exists only while the upload runs.
      calls.push({ ...command, input: JSON.stringify(readStaged(command)) })
      if (fail) throw new Error('exit 1')
      return ''
    }
  })
  afterEach(() => {
    Processes.prototype.run = original
    rmSync(root, { recursive: true, force: true })
  })

  function readStaged(command: Command): string[] {
    try {
      return readdirSync(command.cwd)
    } catch {
      return []
    }
  }

  function uploader(): ReturnType<typeof sentryUploader> {
    return sentryUploader(
      'sentry-cli',
      { SENTRY_AUTH_TOKEN: 'sntrys_fixture' },
      new Processes(new AbortController().signal),
      root
    )
  }

  it('names a release by app, version and the build number the app stamps', () => {
    assert.deepEqual(sentryRelease('app.teamstation.app', '1.0', '1.0.42'), {
      release: 'app.teamstation.app@1.0+1.0.42',
      dist: '1.0.42'
    })
  })

  it('gives the build the DSN only when the app has a sentry block', () => {
    assert.deepEqual(sentryBuildEnvironment(undefined), {})
    assert.deepEqual(sentryBuildEnvironment({ ...settings() }), {
      TS_SENTRY_DSN: DSN
    })
  })

  it('reads the token from its private file and refuses one for another server', () => {
    const sentry = settings()
    assert.deepEqual(sentryCliEnvironment(sentry), {
      SENTRY_URL: 'https://sentry.example.test',
      SENTRY_ORG: 'teamstation',
      SENTRY_PROJECT: 'teamstation-app',
      SENTRY_AUTH_TOKEN: 'sntrys_fixture'
    })
    assert.throws(
      () =>
        sentryCliEnvironment({
          ...sentry,
          origin: 'https://other.example.test'
        }),
      /another server/
    )
    file(
      sentry.tokenFile,
      JSON.stringify({ schemaVersion: 2, origin: sentry.origin, token: 't' })
    )
    assert.throws(
      () => sentryCliEnvironment(sentry),
      /insecure deployment configuration/
    )
  })

  it('uploads dSYMs with their sources', async () => {
    const dsyms = path.join(root, 'App.xcarchive/dSYMs')
    mkdirSync(dsyms, { recursive: true })
    await uploader().dsyms(dsyms)
    assert.deepEqual(calls[0].args, [
      'debug-files',
      'upload',
      '--include-sources',
      dsyms
    ])
    assert.equal(calls[0].file, 'sentry-cli')
    assert.equal(calls[0].env?.SENTRY_AUTH_TOKEN, 'sntrys_fixture')
    assert(!calls[0].args.join(' ').includes('sntrys_fixture'))
    await assert.rejects(uploader().dsyms(path.join(root, 'none')), /no dSYMs/)
  })

  it('uploads a bundle and its map under the name the app reports frames by', async () => {
    const bundle = file(path.join(root, 'build/main.jsbundle'), 'bundle')
    const map = file(path.join(root, 'build/out.map'), '{}')
    await uploader().bundle(
      bundle,
      map,
      'index.android.bundle',
      { release: 'app.teamstation.app@1.0+42', dist: '42' },
      root
    )
    assert.deepEqual(calls[0].args, [
      'sourcemaps',
      'upload',
      '--release',
      'app.teamstation.app@1.0+42',
      '--dist',
      '42',
      '--url-prefix',
      'app:///',
      '.'
    ])
    assert.deepEqual(JSON.parse(calls[0].input!), [
      'index.android.bundle',
      'index.android.bundle.map'
    ])
    await uploader().bundle(
      bundle,
      map,
      'main.jsbundle',
      { release: 'x@1' },
      root
    )
    assert(!calls[1].args.includes('--dist'))
    await assert.rejects(
      uploader().bundle(
        path.join(root, 'none'),
        map,
        'x',
        { release: 'x@1' },
        root
      ),
      /no bundle or source map/
    )
  })

  it('names map sources from the checkout, not the build machine', () => {
    const map = JSON.stringify({
      version: 3,
      sources: [
        '/var/app/teamstation/src/app/components/BuildInfoModal.tsx',
        '/var/app/teamstation/node_modules/react-native/Libraries/x.js',
        '/opt/other/node_modules/metro-runtime/src/polyfills/require.js',
        '/opt/other/elsewhere.js',
        'already/relative.js'
      ],
      mappings: ''
    })
    assert.deepEqual(JSON.parse(relativeSources(map, '/var/app/teamstation')), {
      version: 3,
      sources: [
        'src/app/components/BuildInfoModal.tsx',
        'node_modules/react-native/Libraries/x.js',
        'node_modules/metro-runtime/src/polyfills/require.js',
        '/opt/other/elsewhere.js',
        'already/relative.js'
      ],
      mappings: ''
    })
    assert.deepEqual(
      JSON.parse(relativeSources('{"version":3}', '/var/app/')),
      { version: 3 }
    )
    // A root given relative to the working directory, as `--root .` is.
    const here = JSON.stringify({
      version: 3,
      sources: [path.join(process.cwd(), 'src/app/App.tsx')]
    })
    assert.deepEqual(JSON.parse(relativeSources(here, '.')).sources, [
      'src/app/App.tsx'
    ])
  })

  it('preserves unnamed sources and mapping indices in generated source maps', () => {
    const map = {
      version: 3,
      sources: [null, '/example/src/App.tsx', null],
      sourcesContent: [null, 'example source', null],
      names: [],
      mappings: 'AAAA;ACAA'
    }
    assert.deepEqual(
      JSON.parse(relativeSources(JSON.stringify(map), '/example')),
      {
        ...map,
        sources: [null, 'src/App.tsx', null]
      }
    )
  })

  it('uploads native libraries, and names the step that failed', async () => {
    const libs = path.join(root, 'merged_native_libs')
    mkdirSync(libs)
    await uploader().nativeLibraries(libs)
    assert.deepEqual(calls[0].args, ['debug-files', 'upload', libs])
    await assert.rejects(
      uploader().nativeLibraries(path.join(root, 'none')),
      /no native libraries/
    )
    fail = true
    await assert.rejects(
      uploader().nativeLibraries(libs),
      /^Error: Sentry upload failed: native libraries$/
    )
  })

  it('reads an app sentry block, resolving its token file beside the settings', () => {
    const config = fixtureSettings(root) as {
      apps: Record<string, Record<string, unknown>>
    }
    config.apps[app].sentry = {
      origin: 'https://sentry.example.test',
      org: 'teamstation',
      project: 'teamstation-app',
      dsn: DSN,
      tokenFile: 'sentry-token.json'
    }
    const written = file(
      path.join(root, 'deployConfig.json'),
      JSON.stringify({
        schemaVersion: 1,
        branches: { master: { settings: config } }
      })
    )
    const loaded = loadSettings(written, 'master')
    assert.equal(
      loaded.apps[app].sentry?.tokenFile,
      path.join(root, 'sentry-token.json')
    )
    // Without a configured sentry-cli, the one the repository installs.
    assert.equal(
      loaded.tools.sentryCli,
      path.resolve('node_modules/.bin/sentry-cli')
    )
    assert.equal(bundledSentryCli(root), 'sentry-cli')
  })

  it('accepts only a Sentry DSN', () => {
    assert.equal(sentryDsn(DSN), DSN)
    for (const bad of [
      'http://0123456789abcdef0123456789abcdef@sentry.example.test/2',
      'https://sentry.example.test/2',
      'https://0123456789abcdef0123456789abcdef:secret@sentry.example.test/2',
      'https://0123456789abcdef0123456789abcdef@sentry.example.test/projects',
      'https://0123456789abcdef0123456789abcdef@sentry.example.test/2?x=1',
      'https://0123456789abcdef0123456789abcdef@sentry.example.test/2#x'
    ])
      assert.throws(() => sentryDsn(bad), /Sentry DSN/)
  })

  it('finds the one built app', () => {
    const products = path.join(root, 'Products/Applications')
    mkdirSync(path.join(products, 'TeamStation.app'), { recursive: true })
    assert.equal(builtApp(products), path.join(products, 'TeamStation.app'))
    mkdirSync(path.join(products, 'Other.app'))
    assert.throws(() => builtApp(products), /one built app/)
  })

  it('takes upload requests from the command line', async () => {
    assert.deepEqual(parseUploadArgs(['--dsyms', 'd']), {
      kind: 'dsyms',
      directory: 'd'
    })
    assert.deepEqual(parseUploadArgs(['--native-libs', 'n']), {
      kind: 'native-libs',
      directory: 'n'
    })
    assert.deepEqual(
      parseUploadArgs([
        '--bundle',
        'b',
        '--map',
        'm',
        '--name',
        'main.jsbundle',
        '--release',
        'r',
        '--dist',
        'd'
      ]),
      {
        kind: 'bundle',
        bundle: 'b',
        map: 'm',
        name: 'main.jsbundle',
        release: 'r',
        dist: 'd',
        root: process.cwd()
      }
    )
    assert.equal(
      (
        parseUploadArgs([
          '--bundle',
          'b',
          '--map',
          'm',
          '--name',
          'n',
          '--release',
          'r',
          '--root',
          '/var/app'
        ]) as { root: string }
      ).root,
      '/var/app'
    )
    assert.equal(
      (
        parseUploadArgs([
          '--bundle',
          'b',
          '--map',
          'm',
          '--name',
          'n',
          '--release',
          'r',
          '--root',
          '.'
        ]) as { root: string }
      ).root,
      process.cwd()
    )
    for (const bad of [
      [],
      ['--dsyms'],
      ['dsyms', 'd'],
      ['--dsyms', '--bundle'],
      ['--dsyms', 'd', '--native-libs', 'n'],
      ['--bundle', 'b', '--map', 'm']
    ])
      assert.throws(() => parseUploadArgs(bad), /usage/)
    assert.throws(
      () => requireSentryEnvironment({ SENTRY_URL: 'u' }),
      /SENTRY_ORG is not set/
    )
    const env = {
      SENTRY_URL: 'https://sentry.example.test',
      SENTRY_ORG: 'o',
      SENTRY_PROJECT: 'p',
      SENTRY_AUTH_TOKEN: 't',
      UNRELATED: 'x'
    }
    assert.deepEqual(Object.keys(requireSentryEnvironment(env)), [
      'SENTRY_URL',
      'SENTRY_ORG',
      'SENTRY_PROJECT',
      'SENTRY_AUTH_TOKEN'
    ])
    const seen: string[] = []
    const recorder = {
      dsyms: async (d: string) => {
        seen.push(`dsyms ${d}`)
      },
      nativeLibraries: async (d: string) => {
        seen.push(`libs ${d}`)
      },
      bundle: async (
        b: string,
        m: string,
        n: string,
        r: { release: string; dist?: string },
        at: string
      ) => {
        seen.push(`bundle ${b} ${m} ${n} ${r.release} ${String(r.dist)} ${at}`)
      }
    }
    await runUpload({ kind: 'dsyms', directory: 'd' }, recorder)
    await runUpload({ kind: 'native-libs', directory: 'n' }, recorder)
    await runUpload(
      {
        kind: 'bundle',
        bundle: 'b',
        map: 'm',
        name: 'x',
        release: 'r',
        root: '/var/app'
      },
      recorder
    )
    assert.deepEqual(seen, [
      'dsyms d',
      'libs n',
      'bundle b m x r undefined /var/app'
    ])
    const libs = path.join(root, 'libs')
    mkdirSync(libs)
    await main(
      ['--native-libs', libs],
      { ...env, SENTRY_CLI: '/opt/sentry-cli' },
      new Processes(new AbortController().signal)
    )
    assert.equal(calls.at(-1)?.file, '/opt/sentry-cli')
    await main(
      ['--native-libs', libs],
      env,
      new Processes(new AbortController().signal)
    )
    assert.equal(calls.at(-1)?.file, 'sentry-cli')
  })
})
