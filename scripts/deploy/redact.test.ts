import assert from 'node:assert/strict'

import { afterEach, describe, it } from 'mocha'

import {
  forgetSecrets,
  redact,
  redactedTail,
  rememberEnvironment,
  rememberSecret,
  rememberSecrets
} from './redact'

describe('Build output redaction', () => {
  afterEach(() => {
    forgetSecrets()
  })

  it('replaces every remembered secret, longest first', () => {
    rememberSecret('abcd')
    rememberSecret('abcdefgh')
    rememberSecret('abc')
    assert.equal(
      redact('x abcdefgh y abcd z abc'),
      'x [redacted] y [redacted] z abc'
    )
  })

  it('remembers strings under credential-named fields at any depth', () => {
    rememberSecrets({
      app: 'app.teamstation.app',
      match: { keychainPassword: 'kc-fixture', branch: 'certs' },
      sentry: { tokens: ['tok-one', { value: 'tok-two' }] },
      android: { storePassword: 'store-fixture' },
      count: 3
    })
    assert.equal(
      redact(
        'app.teamstation.app certs kc-fixture tok-one tok-two store-fixture'
      ),
      'app.teamstation.app certs [redacted] [redacted] [redacted] [redacted]'
    )
  })

  it('remembers only credential-named environment values', () => {
    rememberEnvironment({
      PATH: '/usr/bin:/bin',
      FASTLANE_PASSWORD: 'fastlane-fixture',
      SENTRY_AUTH_TOKEN: 'sntrys_fixture',
      EMPTY_SECRET: undefined
    })
    rememberEnvironment()
    assert.equal(
      redact('/usr/bin:/bin fastlane-fixture sntrys_fixture'),
      '/usr/bin:/bin [redacted] [redacted]'
    )
  })

  it('replaces anything shaped like a credential', () => {
    assert.equal(
      redact('https://user:pa55@example.test/repo.git'),
      'https://[redacted]@example.test/repo.git'
    )
    assert.equal(
      redact('Authorization: Bearer abcdefgh12345678'),
      'Authorization: Bearer [redacted]'
    )
    assert.equal(
      redact('MATCH_PASSWORD=hunter22 api_key: "k e y" token=\'t\''),
      'MATCH_PASSWORD=[redacted] api_key: [redacted] token=[redacted]'
    )
    assert.equal(
      redact('keytool -storepass s3cret -keypass k3y --password p4ss'),
      'keytool -storepass [redacted] -keypass [redacted] --password [redacted]'
    )
    assert.equal(
      redact(
        'a\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\nb'
      ),
      'a\n[redacted private key]\nb'
    )
    assert.equal(
      redact('-----BEGIN PRIVATE KEY-----\ncut off'),
      '[redacted private key]'
    )
  })

  it('leaves ordinary build output alone', () => {
    const line =
      "mkdir -p build && xcodebuild -scheme TeamStation: error: No profile for 'app.teamstation.app'"
    assert.equal(redact(line), line)
  })

  it('keeps the last nonblank lines, redacted', () => {
    rememberSecret('s3cret-fixture')
    assert.deepEqual(
      redactedTail('one\r\n\ntwo  \rthree s3cret-fixture\n\n', 2),
      ['two', 'three [redacted]']
    )
  })
})
