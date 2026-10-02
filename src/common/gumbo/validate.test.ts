import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { after, F, TEAMS } from '../../test/scoringGames'
import type { GumboPlay } from '../gumboPlay'
import type { ScoringAction } from '../scoring/actions'
import { currentDocumentOf, finalDocumentOf } from '../scoring/document'
import { foldPlay } from '../scoring/gumbo'
import { freshGame, newSetup } from '../scoring/lineup'
import { type GameState, setupOf } from '../scoring/state'
import { gumboViolations } from './validate'

/**
 * The reference validator (U22): MLB's own feed and a play TeamStation
 * scored pass it, and each kind of departure from the lists or the feed's
 * shapes is named.
 */

const feed = JSON.parse(
  readFileSync('src/common/gumbo/reference/feed776258.json', 'utf8')
) as { liveData: { plays: { allPlays: unknown[] } } }

const AWAY = Array.from({ length: 9 }, (_, i) => 101 + i)
const HOME = Array.from({ length: 9 }, (_, i) => 201 + i)

function start(): GameState {
  return freshGame(
    'g1',
    TEAMS,
    newSetup(TEAMS, {
      away: AWAY.map((userId, i) => ({ userId, shortName: `Away ${i + 1}` })),
      home: HOME.map((userId, i) => ({ userId, shortName: `Home ${i + 1}` }))
    })
  )
}

const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
const ball: ScoringAction = { type: 'pitch', call: 'B' }
const strike: ScoringAction = { type: 'pitch', call: 'C' }

/** The U10 games in one: a single, a steal, a run on a double, wild pitches. */
const scoredActions: ScoringAction[] = [
  {
    type: 'ballInPlay',
    contact: 'swing',
    trajectory: 'line_drive',
    launchAngle: 15,
    location: { x: 10, z: -60 },
    fielder: F.CF,
    speed: 72.4,
    pitchLocation: { height: 'low', side: 'inside', inZone: true }
  },
  { type: 'result', eventType: 'single' },
  close,
  { type: 'baseRunning', kind: 'steal', runner: 1 },
  ball,
  { type: 'ballInPlay', contact: 'swing', fielder: F.LF },
  { type: 'result', eventType: 'double' },
  { type: 'runnerMovement', runner: 1, to: 'home' },
  close,
  { type: 'lineup', kind: 'addPlayer', side: 'home', name: 'Reliever' },
  {
    type: 'lineup',
    kind: 'substitute',
    side: 'home',
    player: 19,
    replaces: F.P
  },
  ball,
  {
    type: 'batteryEvent',
    kind: 'wild_pitch',
    advances: [{ runner: 2, to: '3B' }]
  },
  strike,
  strike,
  { type: 'pitch', call: 'C', speed: 68, zone: 5 },
  close,
  { type: 'ballInPlay', contact: 'swing', fielder: F.SS },
  { type: 'result', eventType: 'field_error' },
  { type: 'fieldingPlay', fielders: [F.SS], error: F.SS },
  { type: 'runnerMovement', runner: 2, to: 'home' },
  close
]

function scored(): { state: GameState; plays: GumboPlay[] } {
  const state = after(start(), ...scoredActions)
  const stamp = { setupBefore: setupOf(state), actions: scoredActions }
  return {
    state,
    plays: state.liveData.plays.allPlays.map(play =>
      foldPlay(state, play, stamp)
    )
  }
}

/** A stored play's JSON, to break by hand. */
type Json = Record<string, any>

/** A deep copy to break. */
function copy(value: unknown): Json {
  return structuredClone(value) as Json
}

/** Each violation as `rule path`. */
function named(play: unknown): string[] {
  return gumboViolations(play).map(found => `${found.rule} ${found.path}`)
}

describe('the reference validator (U22)', function () {
  it('passes every play in the live feed', function () {
    const plays = feed.liveData.plays.allPlays
    expect(plays.length).greaterThan(50)
    for (const [i, play] of plays.entries())
      expect(gumboViolations(play), `play ${i}`).deep.equals([])
  })

  it('passes every play TeamStation scored, and the at-bat in progress', function () {
    const { state, plays } = scored()
    expect(plays.map(play => play.result.eventType)).deep.equals([
      'single',
      'double',
      'strikeout',
      'field_error'
    ])
    for (const play of plays)
      expect(gumboViolations(play), String(play.about.atBatIndex)).deep.equals(
        []
      )
    // The steal, the substitution, the wild pitch and the hit data are there.
    const events = plays.flatMap(
      play => play.playEvents as Array<Record<string, unknown>>
    )
    expect(
      events.map(
        event => (event.details as { eventType?: string }).eventType ?? null
      )
    ).includes.members([
      'stolen_base_2b',
      'pitching_substitution',
      'wild_pitch'
    ])
    expect(events.some(event => 'hitData' in event)).equals(true)
    expect(
      events.filter(event => 'pitchData' in event).map(event => event.pitchData)
    ).deep.equals([
      { startSpeed: 72.4, zone: 7 },
      { startSpeed: 68, zone: 5 }
    ])

    const stamp = { setupBefore: setupOf(state), actions: scoredActions }
    const pitched = after(state, ball)
    expect(
      gumboViolations(
        currentDocumentOf(pitched, pitched.liveData.plays.currentPlay, stamp)
      )
    ).deep.equals([])
    expect(gumboViolations(currentDocumentOf(state, null, stamp))).deep.equals(
      []
    )
    expect(gumboViolations(finalDocumentOf(state, stamp))).deep.equals([])
  })

  it('names one violation for each departure from the lists', function () {
    const { plays } = scored()
    const [single, double] = plays

    const unknownType = copy(double)
    unknownType.result.eventType = 'nonsense_type' as never
    expect(named(unknownType)).deep.equals(['eventType result.eventType'])

    const unknownPitch = copy(double)
    const events = unknownPitch.playEvents as Array<{
      isPitch: boolean
      details: { code: string; call: { code: string } }
    }>
    const pitch = events.find(event => event.isPitch)!
    pitch.details.code = 'Q7'
    expect(named(unknownPitch)).deep.equals([
      'pitchCode playEvents[1].details.code'
    ])

    const unknownReason = copy(double)
    const runners = unknownReason.runners as Array<{
      details: Record<string, unknown>
      movement: Record<string, unknown>
      credits: Array<Record<string, unknown>>
    }>
    runners[1].details.movementReason = 'r_teleported'
    expect(named(unknownReason)).deep.equals([
      'movementReason runners[1].details.movementReason'
    ])

    const numericEnd = copy(double)
    ;(numericEnd.runners as typeof runners)[0].movement.end = 2
    expect(named(numericEnd)).deep.equals(['runner runners[0].movement.end'])

    const badTrajectory = copy(single)
    const inPlay = (
      badTrajectory.playEvents as Array<{ hitData?: Record<string, unknown> }>
    ).find(event => event.hitData != null)!
    inPlay.hitData!.trajectory = 'Line Drive'
    expect(named(badTrajectory)).deep.equals([
      'trajectory playEvents[0].hitData.trajectory'
    ])

    const creditHolder = copy(single)
    const holderRunner = (creditHolder.runners as typeof runners)[0]
    holderRunner.credits = [
      {
        player: { id: 201, fullName: 'Home 1' },
        position: { name: 'Pitcher', type: 'Pitcher', abbreviation: 'P' },
        credit: 'f_fielded_ball'
      }
    ]
    expect(named(creditHolder)).deep.equals([
      'position runners[0].credits[0].position.code'
    ])
  })

  it('holds every part of a play to the lists and shapes', function () {
    const { plays } = scored()
    const [single, double, strikeout] = plays

    expect(named(null)).deep.equals(['about '])

    const annotated = copy(single) as Record<string, unknown>
    annotated.about = { ...(annotated.about as object), halfOuts: -1 }
    annotated.hitData = { trajectory: 'line_drive' }
    annotated.matchup = {
      ...(annotated.matchup as object),
      batSide: { code: 'X' },
      pitchHand: 'R'
    }
    expect(named(annotated)).deep.equals([
      'about about.halfOuts',
      'hitData hitData',
      'matchup matchup.batSide',
      'matchup matchup.pitchHand'
    ])

    // A TeamStation play carries every runner key; each is the feed's kind.
    const runnerShape = copy(double) as Record<string, unknown>
    const runners = runnerShape.runners as Json[]
    const movement = runners[0].movement as Record<string, unknown>
    const details = runners[1].details as Record<string, unknown>
    delete movement.outNumber
    movement.start = 'home'
    movement.outBase = '5B'
    details.isScoringEvent = 'yes'
    details.eventType = 'homer'
    details.extra = true
    runners[1].credits = 'none'
    expect(runners.length).equals(3)
    ;(runners as unknown[]).push('runner', {
      movement: 3,
      details: null,
      credits: [],
      spare: 1
    })
    expect(named(runnerShape)).deep.equals([
      'runner runners[0].movement.outNumber',
      'runner runners[0].movement.start',
      'runner runners[0].movement.outBase',
      'runner runners[1].details.isScoringEvent',
      'runner runners[1].details.extra',
      'eventType runners[1].details.eventType',
      'credit runners[1].credits',
      'runner runners[3]',
      'runner runners[4].spare',
      'runner runners[4].movement',
      'runner runners[4].details'
    ])
    const noList = copy(double) as Record<string, unknown>
    noList.runners = {}
    noList.playEvents = {}
    expect(named(noList)).deep.equals([
      'runner runners',
      'playEvent playEvents'
    ])

    // A play posted by another service is held only to the keys it has.
    const posted: Json = {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
      result: { eventType: 'catcher_interf', awayScore: 0, homeScore: 0 },
      runners: [
        {
          movement: { start: null, end: '1B', isOut: false },
          details: { runner: { id: 101 }, eventType: 'catcher_interf' }
        },
        { details: { runner: { id: 102 } } },
        {
          movement: { start: '2B', end: null, isOut: true, outBase: '4B' },
          credits: [
            { player: { id: 202 }, credit: 'f_putout', spare: 1 },
            {
              player: { id: 203 },
              position: { code: 'Q', name: 'Q', type: 'Q', abbreviation: 'Q' },
              credit: 'f_assist'
            }
          ]
        }
      ]
    }
    expect(named(posted)).deep.equals([
      'credit runners[2].credits[0].spare',
      'position runners[2].credits[1].position.code'
    ])
    posted.result.eventType = 'catcher_interference'
    posted.runners[0].details!.eventType = 'catcher_interference'
    expect(named(posted)).deep.equals([
      'eventType result.eventType',
      'eventType runners[0].details.eventType',
      'credit runners[2].credits[0].spare',
      'position runners[2].credits[1].position.code'
    ])

    // Every event is a pitch, an action or a pickoff attempt, in its shape.
    const eventShape = copy(strikeout) as Record<string, unknown>
    const events = eventShape.playEvents as Json[]
    const [firstBall, wildPitch] = events.filter(
      event => event.isSubstitution !== true
    )
    const substitution = events.find(event => event.isSubstitution === true)!
    substitution.position = {
      code: '99',
      name: 'P',
      type: 'P',
      abbreviation: 'P'
    }
    ;(firstBall.details as Record<string, unknown>).call = null
    firstBall.hitData = { trajectory: 'popup' }
    ;(wildPitch.details as Record<string, unknown>).eventType = 'wild_throw'
    wildPitch.hitData = {}
    ;(events as unknown[]).push(
      'pitch',
      { type: 'swing' },
      { type: 'pickoff', isPitch: true, details: { code: '1' } },
      { type: 'pitch', isPitch: true, details: 'strike' },
      { type: 'action', isPitch: false, details: null }
    )
    const at = events.length - 5
    expect(named(eventShape)).deep.equals([
      `position playEvents[${events.indexOf(substitution)}].position.code`,
      `playEvent playEvents[${events.indexOf(firstBall)}].details.call`,
      `hitData playEvents[${events.indexOf(firstBall)}].hitData`,
      `eventType playEvents[${events.indexOf(wildPitch)}].details.eventType`,
      `hitData playEvents[${events.indexOf(wildPitch)}].hitData`,
      `playEvent playEvents[${at}]`,
      `playEvent playEvents[${at + 1}].type`,
      `playEvent playEvents[${at + 2}].isPitch`,
      `playEvent playEvents[${at + 3}].details`,
      `playEvent playEvents[${at + 4}].details`
    ])

    // Hit data names a listed trajectory, fielders, a spray-chart point, a
    // launch angle in degrees and a distance in feet, and TeamStation writes
    // no measurement it only estimated.
    const hit = copy(single) as Record<string, unknown>
    const inPlay = (hit.playEvents as Array<Record<string, unknown>>).find(
      event => event.hitData != null
    )!
    inPlay.hitData = {
      trajectory: 7,
      location: '80',
      coordinates: { coordX: '1' },
      launchAngle: 120,
      totalDistance: 0,
      launchSpeed: 90,
      hardness: 'hard'
    }
    expect(named(hit)).deep.equals([
      'hitData playEvents[0].hitData.launchAngle',
      'hitData playEvents[0].hitData.totalDistance',
      'trajectory playEvents[0].hitData.trajectory',
      'location playEvents[0].hitData.location',
      'hitData playEvents[0].hitData.coordinates',
      'hitData playEvents[0].hitData.launchSpeed',
      'hitData playEvents[0].hitData.hardness'
    ])
    inPlay.hitData = { location: '8', launchAngle: 22.5, totalDistance: 183 }
    expect(named(hit)).deep.equals([])
    for (const totalDistance of [-4, '183', Number.NaN])
      expect(
        named({
          ...hit,
          playEvents: [{ ...inPlay, hitData: { totalDistance } }]
        })
      ).deep.equals(['hitData playEvents[0].hitData.totalDistance'])
    inPlay.hitData = 'far'
    expect(named(hit)).deep.equals(['hitData playEvents[0].hitData'])
    // Another service's measured ball is its own.
    delete hit.teamStation
    inPlay.hitData = { location: '78', launchAngle: 15 }
    expect(named(hit)).deep.equals([])
  })

  it('holds pitch data to a speed and a zone, on a pitch', function () {
    const { plays } = scored()
    // The double: a steal, then a ball, then the pitch hit.
    const pitched = copy(plays[1])
    const events = pitched.playEvents as Json[]
    const at = events.findIndex(event => event.isPitch === true)
    const withData = (pitchData: unknown): string[] =>
      named({
        ...pitched,
        playEvents: events.map((event, i) =>
          i === at ? { ...event, pitchData } : event
        )
      })
    expect(withData({ startSpeed: 91.2, zone: 14 })).deep.equals([])
    expect(withData({ startSpeed: 0.5, zone: 1 })).deep.equals([])
    for (const startSpeed of [0, -80, '88', Number.NaN, Infinity])
      expect(withData({ startSpeed }), String(startSpeed)).deep.equals([
        `pitchData playEvents[${at}].pitchData.startSpeed`
      ])
    for (const zone of [0, 10, 15, 4.5, '5', null])
      expect(withData({ zone }), String(zone)).deep.equals([
        `pitchData playEvents[${at}].pitchData.zone`
      ])
    expect(withData('fast')).deep.equals([
      `pitchData playEvents[${at}].pitchData`
    ])
    // TeamStation measures nothing, so its plays carry no coordinates.
    expect(withData({ zone: 5, coordinates: { pX: 0, pZ: 2 } })).deep.equals([
      `pitchData playEvents[${at}].pitchData.coordinates`
    ])
    // Pitch data is a pitch's alone.
    const action = events.findIndex(event => event.type === 'action')
    const onAction = copy(pitched)
    onAction.playEvents[action].pitchData = { zone: 5 }
    expect(named(onAction)).deep.equals([
      `pitchData playEvents[${action}].pitchData`
    ])
    // Another service's measured pitch is its own.
    const theirs = copy(pitched)
    delete theirs.teamStation
    theirs.playEvents[at].pitchData = {
      startSpeed: 95.1,
      zone: 11,
      coordinates: { pX: -1.2, pZ: 3.4 }
    }
    expect(named(theirs)).deep.equals([])
  })
})
