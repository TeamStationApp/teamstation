import { expect } from 'chai'
import { describe, it } from 'mocha'

import { after, game } from '../../test/scoringGames'
import { defaultRadarSettings as settings } from '../nodeSettings'
import type { ScoringAction } from './actions'
import { comparablePlay } from './comparable'
import { currentDocumentOf } from './document'
import { radarPacket, radarTargets, withRadarSpeeds } from './radarSpeeds'
import { setupOf } from './state'

const at = Date.parse('2026-01-01T12:00:00Z')
interface SpeedDocument {
  playEvents: Array<{ pitchData?: { startSpeed?: number } }>
}
function folded(actions: ScoringAction[]): SpeedDocument {
  const before = game()
  const state = after(before, ...actions)
  return currentDocumentOf(state, state.liveData.plays.currentPlay, {
    setupBefore: setupOf(before),
    actions,
    actionTimes: actions.map((_, i) => new Date(at + i * 20000).toISOString())
  }) as unknown as SpeedDocument
}
function pitch(kind = 'B'): any {
  const hit = kind === 'hit' || kind === 'caught'
  return {
    teamStation: {
      version: 1,
      setupBefore: setupOf(game()),
      actions: hit
        ? [{ type: 'ballInPlay', contact: 'swing' }]
        : [{ type: 'pitch', call: kind }],
      actionTimes: [new Date(at).toISOString()],
      detail: { foulCaught: kind === 'caught' }
    },
    playEvents: [
      {
        isPitch: true,
        type: 'pitch',
        details: { code: hit ? 'X' : kind, isInPlay: hit },
        pitchData: { zone: 2 },
        ...(hit ? { hitData: { trajectory: 'ground_ball' } } : {})
      }
    ]
  }
}
const reading = (
  offset: number,
  pitchSpeed = 80,
  exitVelocity = 95,
  version = 1
): any => ({ at: at + offset, version, pitchSpeed, exitVelocity })

describe('radar speed matching', () => {
  it('pairs equal-time pitches separately and respects edits to either manual speed', () => {
    const document = (speeds: number[]): any => {
      const p: any = folded(
        speeds.map(speed => ({ type: 'pitch', call: 'B', speed }))
      )
      p.teamStation.actionTimes.fill(new Date(at).toISOString())
      return p
    }
    const input = document([80, 84])
    const prior = withRadarSpeeds(input, [reading(0, 88)], settings)
    const speeds = (p: any): number[] =>
      p.playEvents.map((e: any) => e.pitchData.startSpeed)
    expect(speeds(withRadarSpeeds(input, [], settings, prior))).deep.equals([
      88, 88
    ])
    expect(
      speeds(withRadarSpeeds(document([84, 84]), [], settings, prior))
    ).deep.equals([84, 88])
    expect(
      speeds(withRadarSpeeds(document([80, 80]), [], settings, prior))
    ).deep.equals([88, 80])
    expect(
      speeds(withRadarSpeeds(document([84]), [], settings, prior))
    ).deep.equals([88])
  })

  for (const hit of [false, true])
    for (const insert of [false, true])
      it(`retains timed pitch measurements when a pickoff is ${insert ? 'inserted' : 'removed'} (${hit})`, () => {
        const before = game()
        const place: ScoringAction = {
          type: 'gameFlow',
          kind: 'placeRunner',
          runner: 2,
          base: '1B'
        }
        const pickoff: ScoringAction = {
          type: 'runnerMovement',
          runner: 2,
          to: '1B',
          reason: 'Safe from Pickoff',
          fielders: [10, 12]
        }
        const pitched: ScoringAction = hit
          ? { type: 'ballInPlay', contact: 'swing' }
          : { type: 'pitch', call: 'B' }
        const document = (withPickoff: boolean): any => {
          const actions = [place, ...(withPickoff ? [pickoff] : []), pitched]
          const state = after(before, ...actions)
          return currentDocumentOf(state, state.liveData.plays.currentPlay, {
            setupBefore: setupOf(before),
            actions,
            actionTimes: actions.map(action =>
              new Date(
                at +
                  (action === pitched ? 40000 : action === pickoff ? 20000 : 0)
              ).toISOString()
            )
          })
        }
        const prior = withRadarSpeeds(
          document(!insert),
          [reading(40000, 82, 94)],
          settings
        )
        const changed = document(insert)
        const oldIndex = radarTargets(prior)[0].index
        const newIndex = radarTargets(changed)[0].index
        expect(oldIndex).not.equals(newIndex)
        const saved = withRadarSpeeds(changed, [], settings, prior)
        expect(saved.playEvents[newIndex].pitchData.startSpeed).equals(82)
        expect(saved.playEvents[newIndex].hitData?.launchSpeed).equals(
          hit ? 94 : undefined
        )
        expect(saved.teamStation.radarMeasurements[newIndex].pitchSpeed).equals(
          at + 40000
        )
        expect(withRadarSpeeds(changed, [], settings, saved)).deep.equals(saved)
      })

  for (const kind of ['B', 'hit'])
    it(`revalidates retained ${kind} measurement timestamps against narrowed windows`, () => {
      const p = pitch(kind)
      const packets = [reading(kind === 'B' ? 2500 : -14000)]
      const prior = withRadarSpeeds(p, packets, settings)
      const narrow = { pitchWindowSec: 1, inPlayWindowSec: 10 }
      for (const remaining of [packets, []]) {
        const recomputed = withRadarSpeeds(p, remaining, narrow, prior)
        expect(recomputed.playEvents[0].pitchData.startSpeed).equals(undefined)
        expect(recomputed.playEvents[0].hitData?.launchSpeed).equals(undefined)
        expect(recomputed.teamStation.radarMeasurements).equals(undefined)
        expect(recomputed).deep.equals(withRadarSpeeds(p, remaining, narrow))
      }
      const retained = withRadarSpeeds(p, [], settings, prior)
      expect(retained).deep.equals(prior)
      expect(comparablePlay(prior)).deep.equals(comparablePlay(p))
    })
  it('preserves current manual speed edits while retaining unchanged measured values', () => {
    const before = folded([{ type: 'pitch', call: 'B', speed: 80 }])
    const edited = folded([{ type: 'pitch', call: 'B', speed: 84 }])
    const removed = folded([{ type: 'pitch', call: 'B' }])
    expect(
      withRadarSpeeds(edited, [], settings, before).playEvents[0].pitchData
        ?.startSpeed
    ).equals(84)
    expect(
      withRadarSpeeds(removed, [], settings, before).playEvents[0].pitchData
        ?.startSpeed
    ).equals(undefined)
    const measured = withRadarSpeeds(before, [reading(0, 88)], settings)
    expect(
      withRadarSpeeds(before, [], settings, measured).playEvents[0].pitchData
        ?.startSpeed
    ).equals(88)
    expect(
      withRadarSpeeds(edited, [reading(0, 88)], settings, measured)
        .playEvents[0].pitchData?.startSpeed
    ).equals(88)
  })
  it('uses the latest valid in-play speed refinement without changing the pitch time', () => {
    const p = folded([
      { type: 'ballInPlay', contact: 'swing', speed: 80 },
      { type: 'ballInPlay', contact: 'swing', speed: 84.44 },
      { type: 'ballInPlay', contact: 'swing', speed: 150 }
    ])
    expect(radarTargets(p)).has.length(1)
    expect(radarTargets(p)[0]).includes({ at, speed: 84.4 })
    expect(
      withRadarSpeeds(p, [], settings).playEvents[0].pitchData?.startSpeed
    ).equals(84.4)
    expect(
      withRadarSpeeds(p, [reading(-1000, 86)], settings).playEvents[0].pitchData
        ?.startSpeed
    ).equals(86)
    const late = folded([
      { type: 'ballInPlay', contact: 'swing' },
      { type: 'ballInPlay', contact: 'swing', speed: 85 }
    ])
    expect(
      withRadarSpeeds(late, [], settings).playEvents[0].pitchData?.startSpeed
    ).equals(85)
  })
  it('keeps scorer speed validation separate from positive radar readings', () => {
    for (const speed of [0, 19, 111, 150, Infinity, NaN]) {
      const p = folded([{ type: 'pitch', call: 'B', speed }])
      expect(p.playEvents[0].pitchData?.startSpeed).equals(undefined)
      expect(
        withRadarSpeeds(p, [], settings).playEvents[0].pitchData?.startSpeed
      ).equals(undefined)
    }
    for (const speed of [20, 110]) {
      const p = folded([{ type: 'pitch', call: 'B', speed }])
      expect(
        withRadarSpeeds(p, [], settings).playEvents[0].pitchData?.startSpeed
      ).equals(speed)
    }
    expect(
      withRadarSpeeds(
        folded([{ type: 'pitch', call: 'B' }]),
        [reading(0, 150)],
        settings
      ).playEvents[0].pitchData?.startSpeed
    ).equals(150)
  })
  it('takes only explicitly supplied positive finite packet fields', () => {
    for (const value of [
      null,
      [],
      2,
      {},
      { pitchSpeed: 0 },
      { pitchSpeed: NaN, exitVelocity: -1 },
      { pitchSpeed: Infinity }
    ])
      expect(radarPacket(value)).equals(undefined)
    expect(
      radarPacket({ pitchSpeed: 80, exitVelocity: 0, balls: 2 })
    ).deep.equals({ pitchSpeed: 80 })
    expect(radarPacket({ exitVelocity: 90 })).deep.equals({ exitVelocity: 90 })
  })
  for (const kind of ['B', 'C', 'S', 'F', 'T', 'L', 'hit', 'caught'])
    it(`uses inclusive ${kind} boundaries and newest valid readings per field`, () => {
      const before = pitch(kind)
      const isHit = ['hit', 'caught'].includes(kind)
      const low = isHit ? -15000 : -3000
      const high = isHit ? 0 : 3000
      for (const boundary of [low, high]) {
        const saved = withRadarSpeeds(before, [reading(boundary)], settings)
          .playEvents[0]
        expect(saved.pitchData).deep.equals({ zone: 2, startSpeed: 80 })
        expect(saved.hitData?.launchSpeed).equals(
          kind === 'hit' ? 95 : undefined
        )
      }
      const saved = withRadarSpeeds(
        before,
        [reading(low - 1), reading(high + 1)],
        settings
      )
      expect(saved).deep.equals(before)
      const latest = withRadarSpeeds(
        before,
        [reading(low, 81, 91), reading(high, 82, 0), reading(high, 83, NaN, 2)],
        settings
      ).playEvents[0]
      expect(latest.pitchData.startSpeed).equals(83)
      expect(latest.hitData?.launchSpeed).equals(
        kind === 'hit' ? 91 : undefined
      )
      expect(before.playEvents[0].pitchData).deep.equals({ zone: 2 })
    })
  it('allows one packet to match multiple pitches and respects configurable windows', () => {
    const a = pitch()
    const b = pitch()
    b.teamStation.actionTimes[0] = new Date(at + 1000).toISOString()
    for (const p of [a, b])
      expect(
        withRadarSpeeds(p, [reading(0)], settings).playEvents[0].pitchData
          .startSpeed
      ).equals(80)
    expect(withRadarSpeeds(a, [reading(4000)], settings)).deep.equals(a)
    expect(
      withRadarSpeeds(a, [reading(4000)], { ...settings, pitchWindowSec: 4 })
        .playEvents[0].pitchData.startSpeed
    ).equals(80)
  })
  it('does not backfill missing, malformed, mismatched, or imported records', () => {
    for (const change of [
      (p: any) => {
        delete p.teamStation
      },
      (p: any) => {
        delete p.teamStation.actionTimes
      },
      (p: any) => {
        p.teamStation.actionTimes = ['bad']
      },
      (p: any) => {
        p.teamStation.actionTimes = []
      },
      (p: any) => {
        p.playEvents = []
      },
      (p: any) => {
        p.teamStation.actions = [{ type: 'gameFlow', kind: 'closePlay' }]
      },
      (p: any) => {
        delete p.playEvents
      }
    ]) {
      const p = pitch()
      change(p)
      expect(withRadarSpeeds(p, [reading(0)], settings)).equals(p)
    }
    expect(radarTargets(null)).deep.equals([])
  })
  it('matches implicit hits and hit-by-pitch actions, and caught-foul flags', () => {
    for (const kind of ['single', 'hit_by_pitch']) {
      const p = pitch(kind === 'single' ? 'hit' : 'B')
      p.teamStation.actions = [{ type: 'result', eventType: kind }]
      expect(
        withRadarSpeeds(p, [reading(-10000)], settings).playEvents[0].pitchData
          .startSpeed
      ).equals(kind === 'single' ? 80 : undefined)
    }
    const p = pitch('hit')
    p.teamStation.actions.push({
      type: 'result',
      eventType: 'field_out',
      outBy: 'catch',
      foulCaught: true
    })
    p.teamStation.actionTimes.push(new Date(at + 500).toISOString())
    expect(
      withRadarSpeeds(p, [reading(0)], settings).playEvents[0].hitData
        .launchSpeed
    ).equals(undefined)
  })
  it('matches the first in-play tap when later actions refine its fielder and trajectory', () => {
    const p = pitch('hit')
    p.teamStation.actions.push({
      type: 'ballInPlay',
      contact: 'swing',
      fielder: 12,
      launchAngle: 1
    })
    p.teamStation.actionTimes.push(new Date(at + 20000).toISOString())
    const saved = withRadarSpeeds(
      p,
      [reading(-1000, 82, 94), reading(19000, 90, 100)],
      settings
    )
    expect(saved.playEvents[0].pitchData.startSpeed).equals(82)
    expect(saved.playEvents[0].hitData.launchSpeed).equals(94)
  })
  it('preserves durable prior speeds only for the same timed pitch identity', () => {
    const p = pitch('hit')
    const prior = withRadarSpeeds(p, [reading(0)], settings)
    expect(withRadarSpeeds(p, [], settings, prior)).deep.equals(prior)
    p.teamStation.actionTimes[0] = new Date(at + 30000).toISOString()
    expect(
      withRadarSpeeds(p, [], settings, prior).playEvents[0].pitchData.startSpeed
    ).equals(undefined)
    const foul = pitch('caught')
    expect(
      withRadarSpeeds(foul, [], settings, prior).playEvents[0].hitData
        .launchSpeed
    ).equals(undefined)
  })
  it('strips stale speeds but keeps zone and hit geometry, and compares without server measurements', () => {
    const before = pitch('hit')
    const enriched = withRadarSpeeds(before, [reading(0)], settings)
    expect(comparablePlay(enriched)).deep.equals(comparablePlay(before))
    enriched.playEvents[0].pitchData.zone = 4
    expect(comparablePlay(enriched)).not.deep.equals(comparablePlay(before))
    const p = pitch('F')
    p.playEvents[0].pitchData = { startSpeed: 90 }
    p.playEvents[0].hitData = { launchSpeed: 100 }
    const saved = withRadarSpeeds(p, [], settings)
    expect(saved.playEvents[0]).not.have.property('pitchData')
    expect(saved.playEvents[0]).not.have.property('hitData')
    expect(comparablePlay(p).playEvents[0]).not.have.property('hitData')
  })
})
