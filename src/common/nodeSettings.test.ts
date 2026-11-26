import { expect } from 'chai'
import { describe, it } from 'mocha'

import { installedNativeUrl } from '../test/installedNativeUrl'
import {
  appStoreProduct,
  asNodeSettings,
  asNodeSettingsUpdate,
  asScoreboardOverlay,
  defaultNodeSettings,
  type NodeSettings,
  utcStartOf
} from './nodeSettings'

describe('node settings', function () {
  const with_ = (change: (settings: NodeSettings) => void): unknown => {
    const settings = structuredClone(defaultNodeSettings)
    change(settings)
    return settings
  }
  const refused = (settings: unknown): string => {
    try {
      asNodeSettings(settings)
    } catch (error) {
      return (error as Error).message
    }
    throw new Error('accepted')
  }

  it('defaults the board to 1%, 1% and 15% (0.01, 0.01, 0.15), a 5 s hold and 2026-10-01', function () {
    expect(asNodeSettings(defaultNodeSettings)).deep.equals({
      radar: { pitchWindowSec: 3, inPlayWindowSec: 15 },
      replay: { pitchSec: 5 },
      scoreboard: {
        overlayStartDate: '2026-10-01',
        single: { x: 0.01, y: 0.01, height: 0.15 },
        landscape: { x: 0.01, y: 0.01, height: 0.15 },
        tvLandscape: { x: 0.01, y: 0.01, height: 0.15 },
        portraitHeight: 0.15,
        speedHoldSec: 5
      },
      highlights: {
        lagSec: 8,
        leadSec: 30,
        leadSecByEventType: { strikeout: 10 },
        mergeWithinSec: 5,
        tailSec: 5
      },
      distribution: { betaBuildsUrl: '', appStoreUrl: '', iosAppStoreUrl: '' },
      jev: { configured: false }
    })
  })

  it('reads the saved full settings document with the native URL implementation', () => {
    const url = 'HTTPS://APPS.APPLE.COM/us/app/test/id00123/?ref=1#store'
    const saved = asNodeSettingsUpdate({
      ...defaultNodeSettings,
      distribution: { ...defaultNodeSettings.distribution, iosAppStoreUrl: url }
    })
    const webUrl = globalThis.URL
    try {
      globalThis.URL = installedNativeUrl()
      expect(asNodeSettings(saved).distribution.iosAppStoreUrl).equals(url)
      expect(appStoreProduct(url)?.appId).equals('00123')
    } finally {
      globalThis.URL = webUrl
    }
  })

  it('keeps the full product link and extracts only the final literal path ID', () => {
    const id = '000123456789012345678901'
    const base = 'https://apps.apple.com:443/us/app/teamstation/id' + id
    for (const suffix of [
      '',
      '/',
      '?id=999',
      '#id333',
      '/?id=02#id44',
      '?name=⚾🏟️'
    ]) {
      const url = base + suffix
      expect(appStoreProduct('  ' + url + ' ')).deep.equals({ appId: id, url })
      expect(
        asNodeSettingsUpdate({
          ...defaultNodeSettings,
          distribution: {
            ...defaultNodeSettings.distribution,
            iosAppStoreUrl: url
          }
        }).distribution?.iosAppStoreUrl
      ).equals(url)
    }
    for (const port of ['0443', '00000443']) {
      const url = `https://apps.apple.com:${port}/app/id123`
      expect(appStoreProduct(url)).deep.equals({ appId: '123', url })
    }
    const legacy = {
      ...defaultNodeSettings,
      distribution: { appStoreUrl: '', betaBuildsUrl: '' }
    }
    expect(asNodeSettings(legacy).distribution.iosAppStoreUrl).equals('')
    expect(asNodeSettingsUpdate(legacy).distribution).not.have.property(
      'iosAppStoreUrl'
    )
    expect(
      asNodeSettingsUpdate({ ...legacy, distribution: undefined })
    ).not.have.property('distribution')
    for (const blank of ['', '   '])
      expect(
        asNodeSettingsUpdate({
          ...legacy,
          distribution: {
            ...defaultNodeSettings.distribution,
            iosAppStoreUrl: blank
          }
        }).distribution?.iosAppStoreUrl
      ).equals('')
    for (const value of [
      null,
      123,
      {},
      'apps.apple.com/app/id123',
      'https:apps.apple.com/id1',
      'http://apps.apple.com/app/id1',
      'https://u@apps.apple.com/app/id1',
      'https://@apps.apple.com/app/id1',
      'https://apps.apple.com.example.test/id1',
      'https://apps.apple.com:444/app/id1',
      'https://apps.apple.com:000444/app/id1',
      'https://apps.apple.com/app/name?id=123',
      'https://apps.apple.com/us/developer/example/id123',
      'https://apps.apple.com/story/id123',
      'https://apps.apple.com/id123',
      base + '/more',
      base + 'x',
      base + '?x=%z',
      base + '?x=a\u0085b',
      base + '?x=a\u009fb',
      base + '?x=\uD800',
      base + '#\uDFFF',
      'https://apps.apple.com/a\\b/id1',
      'https://apps.apple.com/a%2Fb/id1',
      'https://apps.apple.com/a\nb/id1',
      'https://apps.apple.com/app/%2E%2e/id1',
      'https://apps.apple.com/%69d1'
    ]) {
      expect(appStoreProduct(value)).equals(undefined)
      expect(() =>
        asNodeSettingsUpdate({
          ...legacy,
          distribution: {
            ...defaultNodeSettings.distribution,
            iosAppStoreUrl: value
          }
        })
      ).to.throw(/iOS App Store link.*https:\/\/apps.apple.com/)
    }
  })

  it('says whether a Jev key is set, and nothing from a server before Jev', function () {
    const { jev: _jev, ...older } = defaultNodeSettings
    expect(asNodeSettings(older).jev).deep.equals({ configured: false })
    expect(
      asNodeSettings({ ...defaultNodeSettings, jev: { configured: true } }).jev
    ).deep.equals({ configured: true })
    expect(
      refused({ ...defaultNodeSettings, jev: { configured: 'yes' } })
    ).equals('jev.configured must be true or false')
    expect(refused({ ...defaultNodeSettings, jev: [] })).equals(
      'jev must be an object'
    )
    // A save carries no Jev setting: the key has its own routes.
    expect(
      asNodeSettingsUpdate({
        ...defaultNodeSettings,
        jev: { configured: true }
      })
    ).not.have.property('jev')
  })

  it('stops a highlight 0 to 600 s past the play, 5 by default', function () {
    for (const value of [0, 5, 600])
      expect(
        asNodeSettings(with_(s => (s.highlights.tailSec = value))).highlights
          .tailSec
      ).equals(value)
    for (const value of [-1, 601, Number.NaN, '5'])
      expect(
        refused(
          with_(s => {
            ;(s.highlights as { tailSec: unknown }).tailSec = value
          })
        )
      ).equals('highlights.tailSec must be from 0 to 600 seconds')
    // A document saved by an app from before the setting.
    const { tailSec: _tail, ...older } = defaultNodeSettings.highlights
    expect(
      asNodeSettings({ ...defaultNodeSettings, highlights: older }).highlights
        .tailSec
    ).equals(5)
  })

  it('refuses each value out of range, naming it', function () {
    for (const key of ['pitchWindowSec', 'inPlayWindowSec'] as const)
      for (const value of [0, -1, Infinity, NaN, 601])
        expect(
          refused(
            with_(s => {
              s.radar[key] = value
            })
          )
        ).contains(`radar.${key}`)
    const { radar: _radar, ...legacy } = defaultNodeSettings
    expect(asNodeSettings(legacy).radar).deep.equals(defaultNodeSettings.radar)
    // A replay delay of whole seconds, 1 to 600; a body without it gets 5.
    for (const value of [0, -1, Infinity, NaN, 601, 2.5, '7'])
      expect(
        refused(
          with_(s => {
            s.replay.pitchSec = value as number
          })
        )
      ).contains('replay.pitchSec')
    expect(
      refused(
        with_(s => {
          s.replay.pitchSec = 2.5
        })
      )
    ).equals('replay.pitchSec must be a whole number of seconds from 1 to 600')
    const { replay: _replay, ...older } = defaultNodeSettings
    expect(asNodeSettings(older).replay).deep.equals({ pitchSec: 5 })
    expect(
      asNodeSettings({ ...defaultNodeSettings, replay: { pitchSec: 7 } }).replay
    ).deep.equals({ pitchSec: 7 })
    const { distribution: _links, ...withoutLinks } = defaultNodeSettings
    expect(asNodeSettings(withoutLinks).distribution).deep.equals({
      betaBuildsUrl: '',
      appStoreUrl: '',
      iosAppStoreUrl: ''
    })
    expect(
      asNodeSettings({
        ...defaultNodeSettings,
        distribution: {
          betaBuildsUrl: ' https://builds.example.test/mason ',
          appStoreUrl: ''
        }
      }).distribution
    ).deep.equals({
      betaBuildsUrl: 'https://builds.example.test/mason',
      appStoreUrl: '',
      iosAppStoreUrl: ''
    })
    expect(
      refused(
        with_(s => {
          s.distribution.appStoreUrl = 'http://apps.example.test'
        })
      )
    ).equals('distribution.appStoreUrl must be an HTTPS URL')
    expect(refused(with_(s => (s.scoreboard.single.x = 1)))).equals(
      'scoreboard.single.x must be a number from 0 to under 1'
    )
    expect(refused(with_(s => (s.scoreboard.landscape.y = -0.1)))).equals(
      'scoreboard.landscape.y must be a number from 0 to under 1'
    )
    expect(refused(with_(s => (s.scoreboard.single.height = 0)))).equals(
      'scoreboard.single.height must be a number above 0, up to 1'
    )
    expect(refused(with_(s => (s.scoreboard.portraitHeight = 1.5)))).equals(
      'scoreboard.portraitHeight must be a number above 0, up to 1'
    )
    expect(refused(with_(s => (s.scoreboard.speedHoldSec = 0)))).equals(
      'scoreboard.speedHoldSec must be above 0, up to 600 seconds'
    )
    expect(refused(with_(s => (s.scoreboard.speedHoldSec = 601)))).equals(
      'scoreboard.speedHoldSec must be from 0 to 600 seconds'
    )
    expect(
      refused(with_(s => (s.scoreboard.overlayStartDate = '2026-02-30')))
    ).equals('scoreboard.overlayStartDate must be a date, YYYY-MM-DD')
    expect(
      refused(with_(s => (s.scoreboard.overlayStartDate = '10/01/2026')))
    ).equals('scoreboard.overlayStartDate must be a date, YYYY-MM-DD')
    expect(refused(with_(s => (s.highlights.lagSec = Number.NaN)))).equals(
      'highlights.lagSec must be from 0 to 600 seconds'
    )
    expect(
      refused(with_(s => (s.highlights.leadSecByEventType = { 'Home Run': 3 })))
    ).equals('highlights.leadSecByEventType: Home Run is not a play type')
    expect(refused({ scoreboard: {} })).equals('highlights must be an object')
    expect(refused([])).equals('the settings must be an object')
  })

  it('reads what a player is told about one game', function () {
    const overlay = {
      show: true,
      single: { x: 0.1, y: 0.2, height: 0.3 },
      landscape: { x: 0, y: 0, height: 1 },
      portraitHeight: 0.15
    }
    expect(asScoreboardOverlay(overlay)).deep.equals({
      ...overlay,
      tvLandscape: defaultNodeSettings.scoreboard.tvLandscape
    })
    expect(() => asScoreboardOverlay({ ...overlay, show: 'yes' })).throws(
      'The overlay needs show'
    )
  })

  it('defaults old TV reads while preserving omitted TV writes and rejecting invalid placements', () => {
    const { tvLandscape: _tv, ...scoreboard } = defaultNodeSettings.scoreboard
    const legacy = { ...defaultNodeSettings, scoreboard }
    expect(asNodeSettings(legacy).scoreboard.tvLandscape).deep.equals(_tv)
    expect(asNodeSettingsUpdate(legacy).scoreboard).not.has.property(
      'tvLandscape'
    )
    const value = { x: 0.12, y: 0.08, height: 0.25 }
    expect(
      asNodeSettingsUpdate({
        ...legacy,
        scoreboard: { ...scoreboard, tvLandscape: value }
      }).scoreboard.tvLandscape
    ).deep.equals(value)
    for (const invalid of [
      null,
      { ...value, x: 1 },
      { ...value, y: -1 },
      { ...value, height: 0 }
    ])
      expect(() =>
        asNodeSettingsUpdate({
          ...legacy,
          scoreboard: { ...scoreboard, tvLandscape: invalid }
        })
      ).throws('scoreboard.tvLandscape')
  })

  it('starts a date at 00:00 UTC, whatever zone a game is in', function () {
    expect(utcStartOf('2026-10-01')).equals(Date.UTC(2026, 9, 1))
  })
})
