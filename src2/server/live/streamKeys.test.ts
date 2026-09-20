import { expect } from 'chai'
import { describe, it } from 'mocha'

import { openSecret, sealSecret } from './secrets'
import {
  liveBaseUrl,
  makeStreamKey,
  newStreamKey,
  streamUrlFor,
  streamWindow
} from './streamKeys'

const SECRET = 'a-test-session-secret'
const LIVE = {
  enabled: true,
  bindHost: '0.0.0.0',
  port: 1936,
  app: 'live',
  segmentSeconds: 4,
  closeAfterHours: 6
}

describe('stream keys', function () {
  it('seals a secret and reads it back', function () {
    const sealed = sealSecret(SECRET, 'gs_hello')
    expect(sealed).does.not.contain('gs_hello')
    expect(openSecret(SECRET, sealed)).equals('gs_hello')
  })

  it('will not open a seal with the wrong secret', function () {
    const sealed = sealSecret(SECRET, 'gs_hello')
    expect(() => openSecret('another-secret', sealed)).throws()
  })

  it('will not open a seal somebody has edited', function () {
    const sealed = sealSecret(SECRET, 'gs_hello')
    const parts = sealed.split('.')
    parts[3] = Buffer.from('gs_theirs').toString('base64url')
    expect(() => openSecret(SECRET, parts.join('.'))).throws()
  })

  it('makes a key that says nothing about the game', function () {
    const key = makeStreamKey()
    expect(key.startsWith('gs_')).equals(true)
    expect(key.length).equals(25)
    expect(makeStreamKey()).does.not.equal(key)
  })

  it('keeps enough of a key to name it and not enough to use it', function () {
    const made = newStreamKey(SECRET)
    expect(made.keyPrefix.length).equals(9)
    expect(made.key.startsWith(made.keyPrefix)).equals(true)
    expect(made.keyCipher).does.not.contain(made.key.slice(9))
    expect(openSecret(SECRET, made.keyCipher)).equals(made.key)
  })

  it('prints the URL people paste, key and all', function () {
    expect(streamUrlFor(LIVE, 'live.example.com', 'gs_abc')).equals(
      'rtmp://live.example.com:1936/live/gs_abc'
    )
  })

  it('names the deployment, never the bind address', function () {
    // A bind of 0.0.0.0 is not an address anybody can publish to, so the URL
    // is built from the name this deployment goes by — the same name the
    // playback links are built from.
    expect(LIVE.bindHost).equals('0.0.0.0')
    expect(liveBaseUrl(LIVE, 'develop2.gamestation.co')).equals(
      'rtmp://develop2.gamestation.co:1936'
    )
  })

  it('has no clock at either end', function () {
    // A game that finished last week, and a key issued now against it: which
    // is how the whole path gets proved without waiting for a fixture.
    const lastWeek = new Date('2026-09-10T22:15:00.000Z')
    const { opensAt, closesAt } = streamWindow(LIVE, lastWeek)
    expect(opensAt.getTime()).is.closeTo(Date.now(), 2000)
    // Null, not a date far away: the key stops when somebody stops it, and
    // `closesAt` records which moment that was.
    expect(closesAt).equals(null)
  })
})
