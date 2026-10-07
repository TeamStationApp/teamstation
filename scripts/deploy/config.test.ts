import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import { loadSettings, merge, privateJson, resolveSettings } from './config'
import { nativeNumber, options } from './runner'
import { target } from './targets'
import {
  appId,
  branchName,
  httpsOrigin,
  integer,
  object,
  platform,
  record,
  sha,
  text
} from './validation'
export const app = 'app.teamstation.app'
export function fixtureSettings(root: string): object {
  const upload = {
    kind: 'mason',
    origin: 'https://builds.example.test',
    tokenFile: 'token.json',
    channelKey: 'fixture'
  }
  return {
    repository: path.join(root, 'source'),
    stateDirectory: path.join(root, 'state'),
    worktreeDirectory: path.join(root, 'worktrees'),
    outputDirectory: path.join(root, 'output'),
    inhibitSleep: false,
    apps: {
      [app]: {
        version: '1.2.3',
        ios: {
          upload,
          seedBuildNumber: 42,
          apple: {
            teamId: 'EXAMPLETEAM',
            identity: 'Fixture Distribution',
            profileNames: { [app]: 'Fixture' },
            architectures: ['arm64']
          }
        },
        android: {
          upload,
          seedBuildNumber: 42,
          android: {
            keystore: 'example.keystore',
            alias: 'example',
            storePassword: 'synthetic-value',
            keyPassword: 'synthetic-value',
            certificateSha256: 'a'.repeat(64)
          }
        }
      }
    },
    match: {
      repository: 'https://example.test/signing.git',
      branch: 'signing',
      password: 'synthetic-value',
      apiKeyFile: 'apple.json',
      keychainPassword: 'synthetic-value',
      gitPrivateKey: 'git.key'
    },
    tools: { node: './node' }
  }
}
let root: string
export function testRoot(prefix: string): string {
  assert(process.env.DEPLOY_TEST_ROOT != null)
  mkdirSync(process.env.DEPLOY_TEST_ROOT, { recursive: true })
  return mkdtempSync(path.join(process.env.DEPLOY_TEST_ROOT, prefix))
}
describe('Deployment configuration', () => {
  beforeEach(() => {
    root = testRoot('config-')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })
  it('resolves multi-level branches, master fallback, replacement arrays and private relative paths', () => {
    const config = {
      schemaVersion: 1,
      branches: {
        master: { settings: fixtureSettings(root) },
        staging: {
          settings: {
            apps: {
              [app]: {
                version: '2.0.0',
                ios: { apple: { architectures: ['arm64', 'x86_64'] } }
              }
            }
          }
        },
        'feature/example': {
          extends: 'staging',
          settings: {
            apps: { [app]: { ios: { apple: { architectures: ['arm64'] } } } }
          }
        }
      }
    }
    assert.equal(resolveSettings(config, 'unlisted').apps[app].version, '1.2.3')
    assert.equal(
      resolveSettings(config, 'feature/example').apps[app].version,
      '2.0.0'
    )
    assert.deepEqual(
      resolveSettings(config, 'feature/example').apps[app].ios?.apple
        ?.architectures,
      ['arm64']
    )
    const file = path.join(root, 'config.json')
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 })
    const link = path.join(root, 'link.json')
    symlinkSync(file, link)
    const settings = loadSettings(link, 'master')
    assert.equal(
      settings.apps[app].ios?.upload.tokenFile,
      path.join(root, 'token.json')
    )
    assert.equal(
      settings.apps[app].android?.android?.keystore,
      path.join(root, 'example.keystore')
    )
    assert.equal(settings.match?.apiKeyFile, path.join(root, 'apple.json'))
    assert.equal(settings.match?.gitPrivateKey, path.join(root, 'git.key'))
    assert.equal(settings.tools.node, path.join(root, 'node'))
    assert.equal(settings.tools.git, 'git')
    assert.deepEqual(merge({ list: [1, 2] }, { list: [3] }), { list: [3] })
    chmodSync(file, 0o644)
    assert.throws(() => loadSettings(file, 'master'))
    assert.throws(() => privateJson(root, value => value))
  })
  it('rejects incomplete graphs, pollution, unknown settings, null and insecure files', () => {
    const base = { settings: fixtureSettings(root) }
    for (const config of [
      { schemaVersion: 2, branches: { master: base } },
      { schemaVersion: 1, branches: {} },
      { schemaVersion: 1, branches: { master: { ...base, extends: 'other' } } },
      {
        schemaVersion: 1,
        branches: { master: base, other: { extends: 'absent', settings: {} } }
      },
      {
        schemaVersion: 1,
        branches: { master: base, other: { extends: 'other', settings: {} } }
      },
      {
        schemaVersion: 1,
        branches: { master: base, other: { settings: { unknown: true } } }
      },
      {
        schemaVersion: 1,
        branches: { master: base, other: { settings: { tools: null } } }
      },
      JSON.parse('{"schemaVersion":1,"branches":{"__proto__":{}}}'),
      {
        schemaVersion: 1,
        branches: {
          master: base,
          other: { settings: JSON.parse('{"tools":{"constructor":{}}}') }
        }
      },
      {
        schemaVersion: 1,
        branches: {
          master: base,
          other: {
            settings: {
              tools: { git: { nested: Array(20).fill({ value: false }) } }
            }
          }
        }
      }
    ])
      assert.throws(() => resolveSettings(config, 'master'))
    assert.throws(() => merge({}, null))
    assert.throws(() => merge({}, undefined))
    let deep: unknown = 0
    for (let i = 0; i < 18; i++) deep = [deep]
    assert.throws(() => merge({}, deep))
    const file = path.join(root, 'bad.json')
    writeFileSync(file, 'x'.repeat(1024 * 1024 + 1), { mode: 0o600 })
    assert.throws(() => loadSettings(file, 'master'))
    writeFileSync(file, 'bad json')
    assert.throws(() => loadSettings(file, 'master'))
  })
  it('validates CLI app/platform/branch and portable scalar inputs', () => {
    const valid = [
      '--app',
      app,
      '--branch',
      'feature/日本',
      '--platform',
      'ios,android'
    ]
    assert.equal(options(valid).config, 'deployConfig.json')
    assert.equal(options([...valid, '--dry-run']).dryRun, true)
    assert.equal(
      options([...valid, '--publish-only', 'a'.repeat(32)]).publishOnly,
      'a'.repeat(32)
    )
    for (const args of [
      [],
      [...valid, '--unknown'],
      [...valid, '--app', app],
      [...valid, '--config'],
      [...valid, '--dry-run', '--publish-only', 'a'.repeat(32)],
      ['--app', app, '--branch', 'master', '--platform', 'ios,ios'],
      ['--app', app, '--branch', 'master', '--platform', 'macos']
    ])
      assert.throws(() => options(args))
    for (const branch of [
      '-master',
      '/master',
      'master/',
      'master.',
      'a b',
      'a..b',
      'a@{b',
      'a//b',
      '.hidden',
      'a.lock',
      '@',
      'a\\b',
      'a[b'
    ])
      assert.throws(() => branchName(branch))
    assert.throws(() => appId('invalid'))
    assert.throws(() => platform('windows'))
    assert.throws(() => sha('a'))
    assert.equal(sha('a'.repeat(40)), 'a'.repeat(40))
    assert.throws(() => text()('bad\ntext'))
    assert.throws(() => text()(''))
    assert.throws(() => integer()(1.5))
    assert.throws(() => integer()(-1))
    for (const url of [
      'http://example.test',
      'https://user:pass@example.test',
      'https://example.test/path',
      'https://example.test/?x=1'
    ])
      assert.throws(() => httpsOrigin(url))
    assert.throws(() => object({ value: text() })([]))
    assert.throws(() => object({ value: text() })({ extra: 'x', value: 'x' }))
    assert.throws(() => record(text())([]))
    assert.throws(() =>
      record(text())(
        Object.fromEntries(
          Array.from({ length: 1001 }, (_, i) => [String(i), 'x'])
        )
      )
    )
    assert.equal(target('app.teamstation.gcscraper', 'ios').harvester, true)
    assert.equal(nativeNumber('ios', 42), '1.0.42')
    assert.equal(nativeNumber('ios', 10000), '2.0.0')
    assert.equal(nativeNumber('android', 42), '42')
    assert.throws(() => nativeNumber('ios', 99990000))
  })
})
