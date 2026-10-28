import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asNodeSettings,
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
        portraitHeight: 0.15,
        speedHoldSec: 5
      },
      highlights: {
        lagSec: 8,
        leadSec: 30,
        leadSecByEventType: { strikeout: 10 },
        mergeWithinSec: 5,
        tailSec: 5
      }
    })
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
    expect(asScoreboardOverlay(overlay)).deep.equals(overlay)
    expect(() => asScoreboardOverlay({ ...overlay, show: 'yes' })).throws(
      'The overlay needs show'
    )
  })

  it('starts a date at 00:00 UTC, whatever zone a game is in', function () {
    expect(utcStartOf('2026-10-01')).equals(Date.UTC(2026, 9, 1))
  })
})
