import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import { bundleEnvironment, ruby } from './apple'
import { loadSettings } from './config'
import { app, fixtureSettings, testRoot } from './config.test'
import { Processes } from './process'
import { githubRepository, importSigning, signingMain } from './signing'
import { target } from './targets'
let root: string,
  config: string,
  settings: any,
  previous: Processes['run'],
  requests: Array<Record<string, unknown>>,
  privateRepo: boolean
let environments: Array<NodeJS.ProcessEnv | undefined>
function args(platform = 'ios'): string[] {
  return [
    '--config',
    config,
    '--app',
    app,
    '--branch',
    'master',
    '--platform',
    platform
  ]
}
function save(): void {
  writeFileSync(
    config,
    JSON.stringify({ schemaVersion: 1, branches: { master: { settings } } }),
    { mode: 0o600 }
  )
}
describe('Explicit encrypted signing import', () => {
  beforeEach(() => {
    root = testRoot('signing-')
    config = path.join(root, 'config.json')
    settings = fixtureSettings(root)
    mkdirSync(settings.repository)
    settings.match.repository = 'git@github.com:example/signing.git'
    settings.match.imports = {
      ios: {
        certificate: 'asset.cer',
        privateKey: 'asset.p12',
        profile: 'asset.mobileprovision'
      }
    }
    for (const name of [
      'asset.cer',
      'asset.p12',
      'asset.mobileprovision',
      'apple.json',
      'git.key'
    ])
      writeFileSync(path.join(root, name), 'synthetic', { mode: 0o600 })
    save()
    requests = []
    environments = []
    privateRepo = true
    // eslint-disable-next-line @typescript-eslint/unbound-method
    previous = Processes.prototype.run
    Processes.prototype.run = async function (command) {
      if (command.file === 'gh')
        return JSON.stringify({ isPrivate: privateRepo })
      requests.push(JSON.parse(readFileSync(command.args.at(-1)!, 'utf8')))
      environments.push(command.env)
      return ''
    }
  })
  it('uses a private Apple login for online import and keeps it out of readonly builds', async () => {
    delete settings.match.apiKeyFile
    settings.match.appleLoginFile = 'login.json'
    const cookies = path.join(root, 'cookies')
    mkdirSync(cookies, { mode: 0o700 })
    const loginFile = path.join(root, 'login.json')
    writeFileSync(
      loginFile,
      JSON.stringify({
        username: 'developer@example.test',
        password: 'synthetic-apple-password',
        cookieDirectory: 'cookies'
      }),
      { mode: 0o600 }
    )
    save()
    await importSigning(args(), new AbortController().signal)
    assert.equal(requests[0].username, 'developer@example.test')
    assert.equal(requests[0].password, undefined)
    assert.equal(environments[0]?.FASTLANE_PASSWORD, 'synthetic-apple-password')
    assert.equal(environments[0]?.SPACESHIP_COOKIE_PATH, cookies)
    const configured = loadSettings(config, 'master')
    assert.equal(configured.match?.appleLoginFile, loginFile)
    await ruby(
      {
        source: root,
        output: root,
        settings: configured,
        target: target(app, 'ios'),
        branch: 'master',
        commit: '0'.repeat(40),
        version: '1.2.3',
        buildNumber: 1,
        buildTime: new Date().toISOString(),
        processes: new Processes(new AbortController().signal)
      },
      'match',
      {},
      root
    )
    assert.equal(environments[1]?.FASTLANE_PASSWORD, undefined)
    assert.equal(requests[1].username, undefined)
    for (const mode of [0o755, 0o777]) {
      chmodSync(cookies, mode)
      await assert.rejects(
        importSigning(args(), new AbortController().signal),
        /session directory/
      )
    }
    chmodSync(cookies, 0o700)
    writeFileSync(
      loginFile,
      JSON.stringify({
        username: 'developer@example.test',
        password: 'synthetic-apple-password',
        cookieDirectory: 'cookies',
        unexpected: true
      })
    )
    await assert.rejects(
      importSigning(args(), new AbortController().signal),
      /configuration/
    )
    chmodSync(loginFile, 0o644)
    await assert.rejects(
      importSigning(args(), new AbortController().signal),
      /private regular/
    )
    delete settings.match.appleLoginFile
    save()
    await assert.rejects(
      importSigning(args(), new AbortController().signal),
      /API key or private Apple login/
    )
  })
  afterEach(() => {
    Processes.prototype.run = previous
    rmSync(root, { recursive: true, force: true })
  })
  it('requires private repository visibility, a separate branch and private explicit assets', async () => {
    assert.equal(
      githubRepository('https://github.com/example/signing.git'),
      'example/signing'
    )
    assert.throws(() => githubRepository('https://other.example.test/signing'))
    await importSigning(args(), new AbortController().signal)
    assert.equal(requests[0].type, 'adhoc')
    assert.equal(requests[0].password, undefined)
    assert.equal(await signingMain(args()), 0)
    privateRepo = false
    await assert.rejects(
      importSigning(args(), new AbortController().signal),
      /private/
    )
    assert.equal(await signingMain(args()), 1)
    privateRepo = true
    chmodSync(path.join(root, 'asset.p12'), 0o644)
    await assert.rejects(
      importSigning(args(), new AbortController().signal),
      /private regular/
    )
    chmodSync(path.join(root, 'asset.p12'), 0o600)
    delete settings.match.imports.ios.profile
    save()
    await assert.rejects(
      importSigning(args(), new AbortController().signal),
      /profile/
    )
    settings.match.branch = 'master'
    save()
    await assert.rejects(
      importSigning(args(), new AbortController().signal),
      /separate/
    )
    await assert.rejects(
      importSigning(args('android'), new AbortController().signal),
      /one Apple/
    )
    assert.equal(
      spawnSync(
        process.execPath,
        ['-r', 'sucrase/register', 'scripts/deploy/signing.ts'],
        { stdio: 'pipe' }
      ).status,
      1
    )
  })
  it('checks the real pinned Match implementation encrypts/decrypts with authenticated encryption', () => {
    Processes.prototype.run = previous
    const env = { ...process.env, ...bundleEnvironment() }
    const result = execFileSync(
      process.env.DEPLOY_TEST_BUNDLE ?? 'bundle',
      [
        'exec',
        'ruby',
        '-e',
        `require 'match'; require 'match/encryption/encryption'; e=Match::Encryption::MatchDataEncryption.new; c=e.encrypt(data: 'synthetic-private-material', password: 'synthetic-password'); raise 'plaintext' if c.include?('synthetic-private-material'); raise 'wrong envelope' unless Base64.decode64(c).start_with?('match_encrypted_v2__'); raise 'roundtrip' unless e.decrypt(base64encoded_encrypted: c, password: 'synthetic-password')=='synthetic-private-material'; begin; e.decrypt(base64encoded_encrypted: c, password: 'wrong-password'); raise 'wrong password accepted'; rescue OpenSSL::Cipher::CipherError; end; puts 'Authenticated Match encryption verified'`
      ],
      { env, encoding: 'utf8', stdio: 'pipe' }
    )
    assert(result.includes('verified'))
  })
})
