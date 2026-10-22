import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type BallInPlayAction,
  cleanAction,
  type PitchAction,
  type ScoringAction
} from '../../common/scoring/actions'
import type { Depth, FOUL_DEPTHS } from '../../common/scoring/depth'
import { distanceFeet } from '../../common/scoring/document'
import {
  PITCH_TYPE_NAMES,
  type PitchType,
  pitchTypeSaid
} from '../../common/scoring/pitchType'
import { fieldInfoOf, type GameState } from '../../common/scoring/state'
import { scoringSession } from '../../test/scoringSession'
import { fieldingLocation } from '../field/fieldingLocation'
import { sampleHit, samplePitch } from '../field/playAnimationModel'
import { OUTFIELD_RADIUS } from '../field/stadiumBoundary'
import { playDefaults } from './dictatedCompletion'
import { baseSaid, depthSaid } from './dictatedDepth'
import { bearingOf, depthUnits, foulPlace } from './dictatedGeometry'
import { hitGeometry } from './dictatedReel'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'
import {
  FOUL_FLIGHT_MAX_MS,
  foulFlightMs,
  hitPresentation,
  PITCH_TIMING,
  type PitchSequence
} from './scoringPresentation'
import type { ScoringState } from './scoringTypes'

type FoulDepth = (typeof FOUL_DEPTHS)[number]

// The development game: the home team fields 10 P, 11 C, 12 1B, 13 2B,
// 14 SS, 15 3B, 16 LF, 17 CF, 18 RF.
const F = {
  P: 10,
  C: 11,
  B1: 12,
  B2: 13,
  SS: 14,
  B3: 15,
  LF: 16,
  CF: 17,
  RF: 18
}

function game(fenceFt = 200): ScoringState {
  const state = initialScoringState(scoringSession(gameFixture), false)
  state.session.gameData.venue = { fieldInfo: fieldInfoOf(fenceFt) }
  return state
}
const radius = (point: { x: number; z: number }): number =>
  Math.hypot(point.x, point.z)
const feetAt = (units: number, fenceFt: number): number =>
  (units * fenceFt) / OUTFIELD_RADIUS
function ballOf(actions: readonly ScoringAction[]): BallInPlayAction {
  return actions.find(
    (action): action is BallInPlayAction => action.type === 'ballInPlay'
  )!
}
function placed(
  session: GameState,
  transcript: string,
  ...actions: ScoringAction[]
): BallInPlayAction {
  return ballOf(playDefaults(session, actions, transcript))
}
const fly = (more: Partial<BallInPlayAction> = {}): BallInPlayAction => ({
  type: 'ballInPlay',
  contact: 'swing',
  trajectory: 'fly_ball',
  ...more
})
const caught: ScoringAction = {
  type: 'result',
  eventType: 'field_out',
  outBy: 'catch'
}
const single: ScoringAction = { type: 'result', eventType: 'single' }

describe('how far a dictated ball went', function () {
  it('puts each depth at its feet for the fence the game is played to', function () {
    const table: Record<Depth, [number, number, number]> = {
      shy_of_base: [30, 40, 59],
      dribbler: [31, 41, 61],
      infield: [48, 64, 97],
      past_base: [50, 62, 85],
      bloop: [70, 90, 131],
      shallow: [83, 110, 165],
      medium: [104, 139, 208],
      deep: [133, 178, 267],
      warning_track: [140, 190, 290],
      wall: [150, 200, 300]
    }
    for (const [depth, feet] of Object.entries(table) as Array<
      [Depth, [number, number, number]]
    >)
      for (const [index, fence] of [150, 200, 300].entries())
        expect(
          feetAt(depthUnits(depth, fence), fence),
          `${depth} at ${fence}`
        ).closeTo(feet[index], 1)
    // However small or large the fence, the depths keep their order.
    for (const fence of [60, 600]) {
      const chain: Depth[] = [
        'dribbler',
        'infield',
        'bloop',
        'shallow',
        'medium',
        'deep',
        'warning_track',
        'wall'
      ]
      for (let i = 1; i < chain.length; i++)
        expect(
          depthUnits(chain[i], fence),
          `${chain[i]} at ${fence}`
        ).greaterThan(depthUnits(chain[i - 1], fence))
      expect(depthUnits('past_base', fence)).greaterThan(
        depthUnits('shy_of_base', fence)
      )
    }
  })

  it('places a ball by its depth, on the bearing the words or the fielder give', function () {
    const { session } = game()
    // A direction: straight down its spray line.
    const left = placed(
      session,
      'said',
      fly({ depth: 'deep', direction: 'left' }),
      caught
    )
    expect(radius(left.location!)).closeTo(105, 0.05)
    expect(bearingOf(left.location!)).closeTo(-30, 0.1)
    // A fielder and no direction: on his bearing from the plate.
    const toRight = placed(
      session,
      'said',
      fly({ depth: 'shallow', fielder: F.RF }),
      caught
    )
    expect(radius(toRight.location!)).closeTo(65, 0.05)
    expect(bearingOf(toRight.location!)).greaterThan(20)
    // The catcher fields a dribbler in front of the plate, toward the mound.
    const catcher = placed(
      session,
      'Dribbler, the catcher throws him out.',
      { type: 'ballInPlay', contact: 'swing', fielder: F.C },
      { type: 'result', eventType: 'field_out', outBy: 'throw' }
    )
    expect(catcher.depth).equals('dribbler')
    expect(catcher.location!.z).lessThan(-20)
    expect(Math.abs(catcher.location!.x)).lessThan(0.01)
    // A spot on the plate is a model's placeholder: the depth places it.
    const placeholder = placed(
      session,
      'said',
      fly({ depth: 'deep', direction: 'left', location: { x: 0, z: 0 } }),
      caught
    )
    expect(radius(placeholder.location!)).closeTo(105, 0.05)
    // A spot the model gave anywhere else stands.
    const spot = placed(
      session,
      'said',
      fly({ depth: 'deep', direction: 'left', location: { x: 10, z: -40 } }),
      caught
    )
    expect(spot.location).deep.equals({ x: 10, z: -40 })
    // A throw's base is not the ball's.
    const toFirst = placed(
      session,
      'Dribbler, pitcher to first.',
      { type: 'ballInPlay', contact: 'swing', fielder: F.P },
      { type: 'result', eventType: 'field_out', outBy: 'throw' }
    )
    expect(Math.abs(bearingOf(toFirst.location!))).lessThan(0.1)
    // The base its own depth phrase names: just inside the first-base line.
    const shy = placed(
      session,
      'A grounder just shy of first.',
      { type: 'ballInPlay', contact: 'swing', trajectory: 'ground_ball' },
      { type: 'result', eventType: 'field_out', outBy: 'throw' }
    )
    expect(shy.depth).equals('shy_of_base')
    expect(bearingOf(shy.location!)).closeTo(43, 0.1)
    // With neither, a dribbler goes toward the mound.
    const plain = placed(
      session,
      'said',
      { type: 'ballInPlay', contact: 'swing', depth: 'dribbler' },
      single
    )
    expect(plain.location!.x).closeTo(0, 0.01)
    expect(radius(plain.location!)).closeTo(24, 0.05)
    // A spoken distance wins over a depth, at this game's fence.
    const far = game(350).session
    const spoken = placed(
      far,
      'said',
      fly({ depth: 'shallow', distanceFeet: 300, direction: 'center' }),
      caught
    )
    expect(feetAt(radius(spoken.location!), 350)).closeTo(300, 0.5)
    // A model's own spot is kept.
    const own = placed(
      session,
      'said',
      fly({ depth: 'deep', location: { x: 1, z: -40 } }),
      caught
    )
    expect(own.location).deep.equals({ x: 1, z: -40 })
  })

  it('names the fielder a depth gives a caught ball the model left unnamed', function () {
    const { session } = game()
    const pop = placed(
      session,
      'Infield pop to the left side, caught.',
      { type: 'ballInPlay', contact: 'swing', direction: 'left' },
      caught
    )
    expect(pop.depth).equals('infield')
    expect(pop.fielder).equals(F.B3)
    expect(radius(pop.location!)).closeTo(38, 0.05)
    const bloop = placed(
      session,
      'said',
      fly({ depth: 'bloop', direction: 'left' }),
      caught
    )
    expect(bloop.fielder).equals(F.LF)
  })

  it('keeps a home run past the fence, however deep it was called', function () {
    const { session } = game()
    const homer: ScoringAction = { type: 'result', eventType: 'home_run' }
    const deep = placed(
      session,
      'Deep fly to left, home run.',
      fly({ direction: 'left' }),
      homer
    )
    expect(deep.depth).equals('deep')
    expect(radius(deep.location!)).greaterThan(OUTFIELD_RADIUS)
    expect(distanceFeet(deep.location!, 200)).greaterThan(200)
    // A distance short of the fence does not bring it in.
    const far = game(350).session
    const short = placed(
      far,
      'a 330-foot homer',
      fly({ direction: 'center', distanceFeet: 330 }),
      homer
    )
    expect(radius(short.location!)).greaterThan(OUTFIELD_RADIUS)
    // One said past the fence places it there.
    const long = placed(
      far,
      'a 420-foot homer',
      fly({ direction: 'center', distanceFeet: 420 }),
      homer
    )
    expect(feetAt(radius(long.location!), 350)).closeTo(420, 0.5)
  })

  it('reads a depth the words say outright, and only of the ball', function () {
    const cases: Array<[string, Depth | undefined]> = [
      ['Bloop single to shallow center.', 'shallow'],
      ['Deep fly to right, caught at the warning track.', 'warning_track'],
      ['Grounder deep in the hole, short throws him out.', 'infield'],
      ['Line drive off the wall in left center.', 'wall'],
      ['Infield dribbler, pitcher to first.', 'dribbler'],
      ['A Texas leaguer to right.', 'bloop'],
      ['Can of corn to center.', 'medium'],
      ['Foul ball past first base.', 'past_base'],
      ['Fouled off just shy of third.', 'shy_of_base'],
      ['He worked it deep in the count, then struck out.', undefined],
      ['Eephus, a blooper pitch for a strike.', undefined],
      ['Ground ball to short.', undefined],
      ['Dribbler in front of the plate, catcher throws him out.', 'dribbler'],
      ['Pop up in front of the mound, caught.', undefined],
      ['It drops in front of the left fielder.', 'shallow'],
      ['A grounder past first, in the infield.', 'past_base'],
      ['Pop fly into no-man’s land, it drops.', 'bloop'],
      ['Single to left, Jones holds up short of third.', undefined],
      ['Ground out, the throw sails past first.', undefined],
      ['Single to left, Jones pulls up short of third.', undefined],
      ['Single to right, Jones caught in a rundown short of third.', undefined],
      ['Ground ball goes past first into right, single.', 'past_base'],
      ['Ground ball went past third, single to left.', 'past_base'],
      [
        'Runner on third, deep in the count, fly ball to center, caught.',
        undefined
      ],
      ['Ball two, deep in the count, he fouls it back.', undefined],
      [
        'Full count, runner on second, deep in the count, he flies out to left.',
        undefined
      ],
      ['Pop fly to deep short, caught.', 'infield'],
      ['Liner to deep second, the second baseman catches it.', 'infield'],
      ['Shallow fly to center, deep enough to tag up on.', 'shallow'],
      ['Down 0-2 and in the hole, he lines a single to left.', undefined],
      ['Behind in the count, in the hole 0-2, he flies out.', undefined]
    ]
    for (const [said, depth] of cases)
      expect(depthSaid(said), said).equals(depth)
    expect(baseSaid('Fouled off just shy of first.')).equals('first')
    expect(baseSaid('Past third, foul.')).equals('third')
    expect(baseSaid('Pitcher to first for the out.')).equals(undefined)
    expect(baseSaid('Single, the runner holds up short of third.')).equals(
      undefined
    )
    expect(
      baseSaid('Ground ball past first, the throw sails past third.')
    ).equals('first')
    // Two depths said, the model read one: the deeper. A model's depth the
    // words do not say stands over theirs; with no words, the model's
    // stands; and a sentence of two balls fills none.
    const { session } = game()
    expect(
      placed(
        session,
        'Bloop single to shallow center.',
        fly({ depth: 'bloop', direction: 'center' }),
        { type: 'result', eventType: 'single' }
      ).depth
    ).equals('shallow')
    expect(
      placed(
        session,
        'Fly to right.',
        fly({ depth: 'shallow', direction: 'right' }),
        caught
      ).depth
    ).equals('shallow')
    expect(
      placed(
        session,
        'Behind in the count, he flies out deep to center.',
        fly({ depth: 'medium', direction: 'center' }),
        caught
      ).depth
    ).equals('medium')
    const two = playDefaults(
      session,
      [
        fly({ direction: 'right' }),
        caught,
        { type: 'ballInPlay', contact: 'swing', direction: 'left' },
        single
      ],
      'Deep fly to right, caught. Next batter singles to left.'
    ).filter(
      (action): action is BallInPlayAction => action.type === 'ballInPlay'
    )
    expect(two.map(ball => ball.depth)).deep.equals([undefined, undefined])
  })

  it('plays a ball said deep out to the wall, and every other caught ball where a fielder stands', function () {
    const aim = { x: 0, z: -114 }
    const track = fieldingLocation('Ball Caught', aim, 'warning_track')
    expect(radius(track)).within(109, OUTFIELD_RADIUS)
    expect(radius(fieldingLocation('Ball Caught', aim))).at.most(110)
    // A deep foul stays foul.
    const foul = fieldingLocation('Ball Caught', { x: 100, z: -60 }, 'deep')
    expect(Math.abs(foul.x)).greaterThan(-foul.z)
    // A hit with no depth is clamped as before.
    expect(fieldingLocation('Single', { x: 0, z: -130 })).deep.equals({
      x: 0,
      z: -OUTFIELD_RADIUS
    })
    // Through the dictated picture: a track catch is drawn on the track.
    const { session } = game()
    const action = placed(
      session,
      'said',
      fly({ depth: 'warning_track', direction: 'right' }),
      caught
    )
    const { pending } = hitGeometry({ session }, action, caught)
    expect(radius(pending.location!)).within(109, OUTFIELD_RADIUS)
    // A distance said with no depth is played out there too.
    const spoken = placed(
      session,
      'said',
      fly({ distanceFeet: 194, direction: 'center' }),
      caught
    )
    expect(
      radius(hitGeometry({ session }, spoken, caught).pending.location!)
    ).greaterThan(110)
  })

  it('plays a ball off the wall off its carom, the fence its distance', function () {
    const state = game()
    const double: ScoringAction = { type: 'result', eventType: 'double' }
    const action = placed(
      state.session,
      'Off the wall in left center.',
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'line_drive',
        direction: 'left_center'
      },
      double
    )
    expect(action.depth).equals('wall')
    const { pending, angle } = hitGeometry(state, action, double)
    expect(radius(pending.location!)).closeTo(OUTFIELD_RADIUS - 0.5, 0.05)
    expect(pending.landingHeight).equals(3)
    expect(radius(pending.carom!)).closeTo(OUTFIELD_RADIUS - 8.5, 0.05)
    const hit = hitPresentation({ ...state, pendingPlay: pending }, angle)
    expect(hit.carom).deep.equals(pending.carom)
    expect(hit.fielderTarget).deep.equals(pending.carom)
    expect(hit.arc.landingHeight).equals(3)
    // It meets the wall in the air, drops, and comes to rest on the carom.
    const atWall = sampleHit(hit, hit.flightEndMs)
    expect(atWall.ball.y).closeTo(3, 0.3)
    const after = sampleHit(hit, hit.durationMs - 1)
    expect(after.ball.x).closeTo(pending.carom!.x, 0.2)
    expect(after.ball.z).closeTo(pending.carom!.z, 0.2)
    expect(after.ball.y).lessThan(0.2)
    // Its distance is the fence's.
    expect(distanceFeet(pending.location!, 200)).closeTo(200, 2)
  })

  it('plays a ball caught at the wall on the track, and a short distance where it fell', function () {
    const state = game()
    // "Hits the wall and makes the catch" is the fielder at the wall: caught
    // on the track, with no carom.
    const caughtAt = placed(
      state.session,
      'Sanchez hits the wall and makes the catch in right.',
      fly({ direction: 'right' }),
      caught
    )
    expect(caughtAt.depth).equals('warning_track')
    const result = caught
    expect(hitGeometry(state, caughtAt, result).pending.carom).equals(undefined)
    expect(
      hitGeometry(state, { ...caughtAt, depth: 'wall' }, result).pending.carom
    ).equals(undefined)
    // A distance short of deep is no ball at the wall.
    const short = hitGeometry(
      state,
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'ground_ball',
        fielder: F.SS,
        distanceFeet: 90,
        location: { x: -20, z: -45 }
      },
      { type: 'result', eventType: 'field_out', outBy: 'throw' }
    )
    expect(radius(short.pending.location!)).lessThan(depthUnits('deep', 200))
  })

  it('stores a bloop at its feet, and keeps the depth with the actions', function () {
    let state = game()
    state = scoringReducer(state, {
      type: 'DICTATED',
      transcript: 'Bloop single to center.',
      actions: [
        { type: 'ballInPlay', contact: 'swing', direction: 'center' },
        single
      ]
    })
    const play = state.session.liveData.plays.currentPlay!
    const coordinates = play.hitData!.coordinates!
    expect(distanceFeet(coordinates, 200)).within(85, 95)
    const ball = state.log.find(
      (action): action is BallInPlayAction => action.type === 'ballInPlay'
    )
    expect(ball?.depth).equals('bloop')
  })
})

describe('where a dictated foul went', function () {
  const foulAt = (point: { x: number; z: number }): boolean =>
    Math.abs(point.x) > -point.z
  const baseUnits = Math.hypot(19.397, 19.397)

  it('takes a foul’s side and depth, and refuses them on any other pitch', function () {
    expect(
      cleanAction({
        type: 'pitch',
        call: 'F',
        direction: 'right',
        depth: 'past_base'
      })
    ).deep.equals({
      action: {
        type: 'pitch',
        call: 'F',
        direction: 'right',
        depth: 'past_base'
      }
    })
    // Any other pitch keeps its call, without the place.
    for (const call of ['B', 'C', 'S', 'T', 'L'])
      expect(
        cleanAction({ type: 'pitch', call, direction: 'left', depth: 'deep' }),
        call
      ).deep.equals({ action: { type: 'pitch', call } })
    // A depth no foul goes to is no foul's.
    expect(
      cleanAction({ type: 'pitch', call: 'F', depth: 'dribbler' })
    ).to.have.nested.property('problem.code', 'malformed')
  })

  it('puts a foul short of the base, past it, or deep, on its side', function () {
    const { session } = game()
    const shy = foulPlace(session, {
      type: 'pitch',
      call: 'F',
      direction: 'right',
      depth: 'shy_of_base'
    })!
    expect(foulAt(shy)).equals(true)
    expect(shy.x).greaterThan(0)
    expect(radius(shy)).lessThan(baseUnits)
    const past = foulPlace(session, {
      type: 'pitch',
      call: 'F',
      direction: 'right',
      depth: 'past_base'
    })!
    expect(feetAt(radius(past) - baseUnits, 200)).within(10, 20)
    const deep = foulPlace(session, {
      type: 'pitch',
      call: 'F',
      direction: 'left',
      depth: 'deep'
    })!
    expect(deep.x).lessThan(0)
    expect(radius(deep)).greaterThan(radius(past))
    // Only the side: past the base. Neither: no spot.
    expect(
      radius(
        foulPlace(session, { type: 'pitch', call: 'F', direction: 'left' })!
      )
    ).closeTo(radius(past), 0.01)
    expect(foulPlace(session, { type: 'pitch', call: 'F' })).equals(undefined)
    expect(foulPlace(session, { type: 'pitch', call: 'B' })).equals(undefined)
  })

  it('reads a foul’s place from the words, the base it names before the batter’s side', function () {
    const state = game()
    state.session.liveData.plays.currentPlay!.matchup.batSide.code = 'L'
    const said = (transcript: string, depth?: FoulDepth): PitchAction =>
      playDefaults(
        state.session,
        [{ type: 'pitch', call: 'F', ...(depth == null ? {} : { depth }) }],
        transcript
      )[0] as PitchAction
    expect(said('Fouled off, just shy of first.')).deep.include({
      depth: 'shy_of_base',
      direction: 'right'
    })
    expect(said('Foul ball past third.')).deep.include({
      depth: 'past_base',
      direction: 'left'
    })
    expect(said('Foul ball deep into the right field seats.')).deep.include({
      depth: 'deep',
      direction: 'right'
    })
    expect(
      said('Fouled back deep, down the third base line.', 'deep')
    ).deep.include({
      direction: 'left'
    })
    // A foul the words do not place stays as it was.
    expect(said('Fouled it off.')).deep.equals({ type: 'pitch', call: 'F' })
  })

  it('flies a placed foul to where it came down, and every other foul as before', function () {
    const base = game()
    base.presentationEnabled = true
    const placedFoul = scoringReducer(base, {
      type: 'DICTATED',
      transcript: 'Foul ball past first.',
      actions: [
        { type: 'pitch', call: 'F', direction: 'right', depth: 'past_base' }
      ]
    }).presentation as PitchSequence
    expect(placedFoul.foul).not.equals(undefined)
    expect(placedFoul.durationMs).greaterThan(PITCH_TIMING.foulFinish)
    const end = samplePitch(placedFoul, placedFoul.durationMs - 1)
    expect(end.ball.x).closeTo(placedFoul.foul!.x, 0.2)
    expect(end.ball.z).closeTo(placedFoul.foul!.z, 0.2)
    expect(end.ball.y).lessThan(0.5)
    expect(
      samplePitch(placedFoul, PITCH_TIMING.plate + 300).ball.y
    ).greaterThan(2)
    // A foul into the seats is in the air no longer than a deep fly.
    expect(foulFlightMs({ x: 86, z: -60 })).equals(FOUL_FLIGHT_MAX_MS)
    expect(foulFlightMs({ x: 19, z: -13 })).closeTo(1151, 1)
    const plain = scoringReducer(base, {
      type: 'DICTATED',
      transcript: 'Fouled it off.',
      actions: [{ type: 'pitch', call: 'F' }]
    }).presentation as PitchSequence
    expect(plain.foul).equals(undefined)
    expect(plain.durationMs).equals(PITCH_TIMING.foulFinish)
  })

  it('drops a fielder the model guessed from the batting side, and plays a home run over the fence unless said inside the park', function () {
    const { session } = game()
    // The leadoff batter is no fielder, and the words name no one: the play
    // finds the left fielder by its direction.
    const guessed = placed(
      session,
      'Fly ball to the warning track in left, caught.',
      fly({ fielder: 1, direction: 'left', depth: 'warning_track' }),
      caught
    )
    expect(guessed.fielder).equals(F.LF)
    // A fielder in the field the model chose stands.
    expect(
      placed(
        session,
        'Fly ball to the warning track in left, caught.',
        fly({ fielder: F.CF, direction: 'left' }),
        caught
      ).fielder
    ).equals(F.CF)
    const homer: ScoringAction = { type: 'result', eventType: 'home_run' }
    expect(
      placed(
        session,
        'He hits a deep drive to right, home run.',
        fly({ direction: 'right', homeRunKind: 'in-park' }),
        homer
      ).homeRunKind
    ).equals('out-of-park')
    expect(
      placed(
        session,
        'Inside-the-parker to center, he scores.',
        fly({ direction: 'center', homeRunKind: 'in-park' }),
        homer
      ).homeRunKind
    ).equals('in-park')
    expect(
      placed(
        session,
        'An inside-the-park home run to right.',
        fly({ direction: 'right', homeRunKind: 'in-park' }),
        homer
      ).homeRunKind
    ).equals('in-park')
  })

  it('keeps a ground ball an infielder fields on the infield, however deep he played', function () {
    const { session } = game()
    const out: ScoringAction = {
      type: 'result',
      eventType: 'field_out',
      outBy: 'throw'
    }
    const grounder = (more: Partial<BallInPlayAction>): BallInPlayAction => ({
      type: 'ballInPlay',
      contact: 'swing',
      trajectory: 'ground_ball',
      ...more
    })
    // The words say deep, the model infield: neither goes to the outfield.
    for (const depth of [undefined, 'infield', 'deep'] as const) {
      const short = placed(
        session,
        'Grounder to deep short, 6-3.',
        grounder({ fielder: F.SS, ...(depth == null ? {} : { depth }) }),
        out
      )
      // "Deep short" is the infield, whatever the model sent.
      expect(short.depth, depth).equals('infield')
      expect(radius(short.location ?? { x: 0, z: 0 })).lessThan(60)
    }
    // With no fielder sent, the one the words give, on the infield.
    expect(
      placed(
        session,
        'Ground ball deep to third, he throws him out.',
        grounder({}),
        out
      ).depth
    ).equals('infield')
    // A pop or a liner an infielder catches goes no deeper than shallow:
    // the words' infield, or none.
    const pop = (said: string): unknown =>
      placed(
        session,
        said,
        fly({ trajectory: 'popup', fielder: F.SS, depth: 'deep' }),
        caught
      ).depth
    expect(pop('Pop fly to deep short, caught by the shortstop.')).equals(
      'infield'
    )
    expect(pop('Pop fly to short, caught by the shortstop.')).equals(undefined)
    expect(
      placed(
        session,
        'Bloop to shallow right, caught by the second baseman.',
        fly({ fielder: F.B2, depth: 'shallow' }),
        caught
      ).depth
    ).equals('shallow')
    // An outfielder's ground ball keeps its depth.
    expect(
      placed(
        session,
        'Seeing-eye grounder into shallow left, single.',
        grounder({ direction: 'left' }),
        { type: 'result', eventType: 'single' }
      ).depth
    ).equals('shallow')
  })

  it('keeps a kind of pitch only when the words name it', function () {
    const { session } = game()
    const said = (transcript: string, pitchType: PitchType): unknown =>
      playDefaults(
        session,
        [{ type: 'pitch', call: 'S', pitchType }],
        transcript
      )[0]
    expect(said('Breaking ball, swinging strike.', 'slider')).deep.equals({
      type: 'pitch',
      call: 'S'
    })
    expect(said('Uncle Charlie, he buckles, strike.', 'curveball')).deep.equals(
      { type: 'pitch', call: 'S', pitchType: 'curveball' }
    )
    // Every kind has words, and a ball in play is held to them too.
    for (const name of PITCH_TYPE_NAMES)
      expect(pitchTypeSaid(name, name.replace('_', ' ')), name).equals(true)
    // The plan's words for each kind.
    const words: Array<[PitchType, string]> = [
      ['fastball', 'heater'],
      ['fastball', 'gas'],
      ['fastball', 'cheese'],
      ['fastball', 'number one'],
      ['four_seam', 'four-seamer'],
      ['four_seam', 'riser'],
      ['sinker', 'two-seamer'],
      ['sinker', 'sinking fastball'],
      ['cutter', 'cut fastball'],
      ['curveball', 'hook'],
      ['curveball', 'yakker'],
      ['curveball', 'Uncle Charlie'],
      ['curveball', 'twelve-to-six'],
      ['curveball', 'bender'],
      ['knuckle_curve', 'spike curve'],
      ['changeup', 'circle change'],
      ['changeup', 'change of pace'],
      ['changeup', 'offspeed'],
      ['splitter', 'split-finger'],
      ['splitter', 'splitty'],
      ['knuckleball', 'knuckler'],
      ['eephus', 'blooper pitch']
    ]
    for (const [name, said] of words)
      expect(pitchTypeSaid(name, `${said}, ball.`), said).equals(true)
    // Ordinary words are no pitch.
    const ordinary: Array<[PitchType, string]> = [
      ['changeup', 'Pitching change, a new arm comes in.'],
      ['curveball', 'A hooked foul down the line.'],
      ['splitter', 'He split the gap for a double.']
    ]
    for (const [name, said] of ordinary)
      expect(pitchTypeSaid(name, said), said).equals(false)
    expect(
      placed(
        session,
        'Fly to right on a breaking ball, caught.',
        fly({ pitchType: 'sweeper' }),
        caught
      ).pitchType
    ).equals(undefined)
  })

  it('catches a foul at its depth, short of the base or out by the corner outfielder', function () {
    const { session } = game()
    const foulCaught: ScoringAction = {
      type: 'result',
      eventType: 'field_out',
      outBy: 'catch',
      foulCaught: true
    }
    const shy = placed(
      session,
      'Popped up foul just shy of first, caught.',
      { type: 'ballInPlay', contact: 'swing' },
      foulCaught
    )
    expect(shy.fielder).equals(F.B1)
    expect(foulAt(shy.location!)).equals(true)
    expect(radius(shy.location!)).lessThan(baseUnits)
    const deep = placed(
      session,
      'Foul fly deep to right, caught.',
      {
        type: 'ballInPlay',
        contact: 'swing',
        direction: 'right',
        depth: 'deep'
      },
      foulCaught
    )
    expect(deep.fielder).equals(F.RF)
    expect(foulAt(deep.location!)).equals(true)
    expect(radius(deep.location!)).closeTo(105, 0.05)
    // The picture keeps it foul.
    const { pending } = hitGeometry({ session }, deep, foulCaught)
    expect(foulAt(pending.location!)).equals(true)
    // The depth its words say, when the model gave none: past third is the
    // third baseman's, on his side.
    const third = placed(
      session,
      'Foul pop past third, caught.',
      { type: 'ballInPlay', contact: 'swing' },
      foulCaught
    )
    expect(third.depth).equals('past_base')
    expect(third.fielder).equals(F.B3)
    expect(third.location!.x).lessThan(0)
    // The field's side its words name, with no direction from the model.
    const leftField = placed(
      session,
      'Foul fly deep into left field, caught.',
      { type: 'ballInPlay', contact: 'swing' },
      foulCaught
    )
    expect(leftField.fielder).equals(F.LF)
    expect(leftField.location!.x).lessThan(0)
    // Out in shallow left, the model's depth with no words of its own, it is
    // the left fielder's.
    const left = placed(
      session,
      'Foul pop, caught.',
      {
        type: 'ballInPlay',
        contact: 'swing',
        direction: 'left',
        depth: 'shallow'
      },
      foulCaught
    )
    expect(left.fielder).equals(F.LF)
    expect(left.location!.x).lessThan(0)
  })
})
