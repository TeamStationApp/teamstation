import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asServerConfig, eventControlIssuerOf } from '../serverConfig'
import { asAppLinksConfig, asFingerprint, asOrigin } from './config'

const FINGERPRINT = Array(32).fill('AB').join(':')

describe('asOrigin', function () {
  for (const good of [
    'https://director.example.test',
    'https://app1.example.test:8443',
    'http://127.0.0.1:9100',
    'http://localhost:9100',
    'http://[::1]:9100'
  ]) {
    it(`accepts ${good}`, function () {
      expect(asOrigin(good)).equals(good)
    })
  }
  for (const bad of [
    'https://director.example.test/',
    'https://director.example.test/signin',
    'https://director.example.test?x=1',
    'http://director.example.test',
    'http://192.168.100.20:9100',
    'HTTPS://Director.example.test',
    'ftp://director.example.test',
    'director.example.test',
    ''
  ]) {
    it(`refuses ${JSON.stringify(bad)}`, function () {
      expect(() => asOrigin(bad)).throws()
    })
  }
  it('refuses a value that is not a string', function () {
    expect(() => asOrigin(7)).throws()
  })
})

describe('asFingerprint', function () {
  it('accepts 32 uppercase pairs', function () {
    expect(asFingerprint(FINGERPRINT)).equals(FINGERPRINT)
  })
  it('refuses 31 pairs, lowercase hex and bare hex', function () {
    expect(() => asFingerprint(Array(31).fill('AB').join(':'))).throws()
    expect(() => asFingerprint(FINGERPRINT.toLowerCase())).throws()
    expect(() => asFingerprint('AB'.repeat(32))).throws()
  })
})

describe('asAppLinksConfig', function () {
  const app1 = {
    origin: 'https://app1.example.test',
    apple: { appIds: ['TEAM000000.test.example.app1'] },
    android: {
      packageName: 'test.example.app1',
      sha256CertFingerprints: [FINGERPRINT]
    }
  }

  it('reads apps and known servers', function () {
    const config = asAppLinksConfig({
      knownServers: ['https://seat.example.test'],
      apps: [app1, { origin: 'https://app2.example.test' }]
    })
    expect(config.knownServers).deep.equals(['https://seat.example.test'])
    expect(config.apps[0]).deep.equals(app1)
    expect(config.apps[1].apple).equals(undefined)
    expect(config.apps[1].android).equals(undefined)
  })
  it('defaults to empty lists', function () {
    expect(asAppLinksConfig({})).deep.equals({ knownServers: [], apps: [] })
  })
  it('refuses two apps with one origin', function () {
    expect(() => asAppLinksConfig({ apps: [app1, app1] })).throws(
      /listed twice/
    )
  })
  it('refuses a bad origin or fingerprint inside an app', function () {
    expect(() =>
      asAppLinksConfig({ apps: [{ ...app1, origin: 'https://x.test/' }] })
    ).throws()
    expect(() =>
      asAppLinksConfig({
        apps: [
          {
            ...app1,
            android: { packageName: 'p', sha256CertFingerprints: ['ab'] }
          }
        ]
      })
    ).throws()
  })
})

describe('server config: app links', function () {
  it('has no apps and no pinned issuer by default', function () {
    const config = asServerConfig({})
    expect(config.appLinks).deep.equals({ knownServers: [], apps: [] })
    expect(config.eventControlIssuer).equals(undefined)
  })
  it('reads appLinks and eventControlIssuer', function () {
    const config = asServerConfig({
      eventControlIssuer: 'https://old.example.test',
      appLinks: { apps: [{ origin: 'https://app1.example.test' }] }
    })
    expect(config.eventControlIssuer).equals('https://old.example.test')
    expect(config.appLinks.apps[0].origin).equals('https://app1.example.test')
    expect(() =>
      asServerConfig({ eventControlIssuer: 'https://old.example.test/' })
    ).throws()
  })
  it('derives event-control keys from the pinned issuer, else the public origin', function () {
    expect(
      eventControlIssuerOf(
        { eventControlIssuer: 'https://old.example.test' },
        'https://gs.example.test'
      )
    ).equals('https://old.example.test')
    expect(
      eventControlIssuerOf(
        { eventControlIssuer: undefined },
        'https://gs.example.test'
      )
    ).equals('https://gs.example.test')
  })
})
