import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, it } from 'mocha'

import {
  asClientConfig,
  main,
  writeXcconfig,
  xcconfigFor
} from '../clientConfig.mjs'
import { testRoot } from './config.test'

const TEAM = 'TEAM000000'

function scratch(): string {
  return testRoot('clientConfig-')
}

function appDir(config?: unknown): string {
  const dir = scratch()
  if (config !== undefined)
    writeFileSync(path.join(dir, 'clientConfig.json'), JSON.stringify(config))
  return dir
}

describe('clientConfig.mjs', () => {
  it('writes the team, the link host and the entitlements for an app with a link host', () => {
    const dir = appDir({
      appOrigin: 'https://app1.example.test',
      appleTeamId: TEAM
    })
    const file = main([dir, '--entitlements', 'App/Director.entitlements'])
    assert.equal(file, path.join(dir, 'clientConfig.xcconfig'))
    const text = readFileSync(file, 'utf8')
    assert.match(text, /^DEVELOPMENT_TEAM = TEAM000000$/m)
    assert.match(text, /^TS_APP_LINK_HOST = app1\.example\.test$/m)
    assert.match(text, /^TS_APP_ENTITLEMENTS = App\/Director\.entitlements$/m)
    assert.doesNotMatch(text, /CODE_SIGN_ENTITLEMENTS/)
    // Only the first line, a whole-line comment, may hold `//`.
    assert.ok(
      text
        .split('\n')
        .slice(1)
        .every(line => !line.includes('//'))
    )
  })

  it('claims no Associated Domains without a link host, and keeps the team', () => {
    const text = readFileSync(
      main([
        appDir({ appleTeamId: TEAM }),
        '--entitlements',
        'App/Director.entitlements'
      ]),
      'utf8'
    )
    assert.match(text, /^DEVELOPMENT_TEAM = TEAM000000$/m)
    assert.match(text, /^TS_APP_LINK_HOST = $/m)
    // Left out, so the target's default (none, or an empty entitlements file) applies.
    assert.doesNotMatch(text, /TS_APP_ENTITLEMENTS/)
    assert.doesNotMatch(
      xcconfigFor({ appOrigin: 'https://app1.example.test' }, undefined),
      /TS_APP_ENTITLEMENTS/
    )
  })

  it('prints the team, checked, for scripts that need only that', () => {
    assert.equal(main([appDir({ appleTeamId: TEAM }), '--team']), TEAM)
    assert.equal(
      main(['--team', appDir({ appOrigin: 'https://app1.example.test' })]),
      ''
    )
    assert.equal(main([appDir(), '--team']), '')
    assert.throws(
      () => main([appDir({ appleTeamId: 'bad' }), '--team']),
      /team/
    )
    assert.throws(() => main(['--team']), /usage/)
    assert.throws(() => main([appDir(), 'extra', '--team']), /usage/)
  })

  it('writes an empty xcconfig and fails without a clientConfig.json', () => {
    const dir = appDir()
    assert.throws(
      () => main([dir]),
      /clientConfig\.json missing: run appLinks\.mjs client/
    )
    assert.equal(
      readFileSync(path.join(dir, 'clientConfig.xcconfig'), 'utf8'),
      ''
    )
  })

  it('refuses a bad origin, a bad team, an unknown field and a //', () => {
    assert.throws(
      () => asClientConfig({ appOrigin: 'https://app1.example.test/' }),
      /https origin/
    )
    assert.throws(
      () => asClientConfig({ appOrigin: 'http://app1.example.test' }),
      /https origin/
    )
    assert.throws(
      () => asClientConfig({ appOrigin: 'not a url' }),
      /not an origin/
    )
    assert.throws(() => asClientConfig({ appleTeamId: 'short' }), /team/)
    assert.throws(() => asClientConfig({ appleTeamId: 7 }), /team/)
    assert.throws(() => asClientConfig({ extra: 1 }), /unknown field extra/)
    assert.throws(() => asClientConfig([]), /object/)
    assert.throws(() => asClientConfig(null), /object/)
    assert.throws(
      () =>
        xcconfigFor({ appOrigin: 'https://app1.example.test' }, 'https://x/y'),
      /TS_APP_ENTITLEMENTS cannot contain \/\//
    )
    assert.throws(
      () => writeXcconfig(appDir({ appleTeamId: 'bad' }), undefined),
      /team/
    )
  })

  it('refuses incomplete arguments', () => {
    assert.throws(() => main([]), /usage/)
    assert.throws(() => main(['a', 'b']), /usage/)
    assert.throws(() => main(['a', '--entitlements']), /needs a path/)
  })
})
