import { expect } from 'chai'
import { describe, it } from 'mocha'

import { after, ball, F, game, strike, walk } from '../../test/scoringGames'
import type { ScoringAction } from './actions'
import { applyAction } from './apply'
import { homeRunKind, isFair, PARK } from './park'
import {
  ADVANCE_OUT_REASONS,
  ADVANCE_SAFE_REASONS,
  allowedAngle,
  awaitingResult,
  canSwitchBatter,
  closesAutomatically,
  hasEligiblePitch,
  MAX_LAUNCH_ANGLE,
  moreEligibility,
  nextDecision,
  outcomeAvailable,
  runnerReasons,
  STATIONARY_OUT_REASONS,
  trajectoryLabel
} from './rules'
import { copyState, type GameState } from './state'

describe('the park', function () {
  it('calls a ball over the fence out of the park and one on it in play', function () {
    expect(homeRunKind({ x: 0, z: -(PARK.outfieldRadius + 1) })).equals(
      'out-of-park'
    )
    expect(homeRunKind({ x: 0, z: -PARK.outfieldRadius })).equals('in-park')
    expect(homeRunKind({ x: 200, z: -10 })).equals('in-park')
    expect(homeRunKind({ x: 0, z: 200 })).equals('in-park')
    expect(
      homeRunKind({ x: 0, z: -90 }, { ...PARK, outfieldRadius: 80 })
    ).equals('out-of-park')
  })

  it('knows fair from foul', function () {
    expect(isFair({ x: 0, z: -10 })).equals(true)
    expect(isFair({ x: 10, z: -10 })).equals(true)
    expect(isFair({ x: 11, z: -10 })).equals(false)
    expect(isFair({ x: 0, z: 1 })).equals(false)
  })
})

describe('batted-ball rules', function () {
  it('names a trajectory from its angle', function () {
    expect([60, 40, 20, 0, -40].map(trajectoryLabel)).deep.equals([
      'Pop Fly',
      'Fly Ball',
      'Line Drive',
      'Ground Ball',
      'Chopper'
    ])
  })

  it("offers a fielder's choice only with runners on", function () {
    expect(outcomeAvailable("Fielder's Choice", false)).equals(false)
    expect(outcomeAvailable("Fielder's Choice", true)).equals(true)
    expect(outcomeAvailable('Single', false)).equals(true)
  })

  it('keeps a caught ball and a ball over the fence off the ground', function () {
    expect(allowedAngle(-20, 'Ground Ball')).equals(-20)
    expect(allowedAngle(-20, 'Ball Caught')).equals(10)
    expect(allowedAngle(-20, 'Home Run', 'out-of-park')).equals(10)
    expect(allowedAngle(-20, 'Home Run', 'in-park')).equals(-20)
    expect(allowedAngle(99, 'Single')).equals(MAX_LAUNCH_ANGLE)
    expect(MAX_LAUNCH_ANGLE).equals(85)
    expect(allowedAngle(-99, 'Single')).equals(-45)
  })
})

describe('what the game allows between pitches', function () {
  it('offers reasons by what the runner did', function () {
    expect(runnerReasons({ decision: 'safe', from: 1, to: 2 })).equals(
      ADVANCE_SAFE_REASONS
    )
    expect(runnerReasons({ decision: 'out', from: 1, to: 2 })).equals(
      ADVANCE_OUT_REASONS
    )
    expect(runnerReasons({ from: 1, to: 1 })).equals(STATIONARY_OUT_REASONS)
  })

  it('needs a ball or a missed strike before a wild pitch', function () {
    expect(hasEligiblePitch(game())).equals(false)
    expect(hasEligiblePitch(after(game(), ball))).equals(true)
    expect(
      hasEligiblePitch(after(game(), { type: 'pitch', call: 'F' }))
    ).equals(false)
    const stale = after(game(), ball)
    stale.recentPitch = { atBatIndex: 9, index: 0 }
    expect(hasEligiblePitch(stale)).equals(false)
  })

  it('says why a more action cannot happen', function () {
    const empty = game()
    expect(moreEligibility(empty, 'Balk')).equals('No runners on base')
    expect(moreEligibility(empty, 'Wild Pitch')).equals(
      'Record an eligible pitch first'
    )
    expect(moreEligibility(empty, 'Dropped Third Strike')).equals(
      'Requires two strikes and first empty or two outs'
    )
    expect(
      moreEligibility(after(empty, strike, strike), 'Dropped Third Strike')
    ).equals(undefined)
    const onFirst = walk(game())
    expect(moreEligibility(onFirst, 'Put Batter on Base')).equals(
      'Requires empty bases'
    )
    expect(
      moreEligibility(after(onFirst, strike, strike), 'Dropped Third Strike')
    ).equals('Requires two strikes and first empty or two outs')
    expect(moreEligibility(onFirst, 'Balk')).equals(undefined)
    const nobody = game()
    nobody.liveData.plays.currentPlay = null
    expect(moreEligibility(nobody, 'Hit by Pitch')).equals(
      'Choose the next batter first'
    )
  })

  it('lets the batter change sides only before the first pitch', function () {
    expect(canSwitchBatter(game())).equals(true)
    expect(canSwitchBatter(after(game(), ball))).equals(false)
  })
})

describe('what the game waits for next', function () {
  it('names each decision', function () {
    expect(nextDecision(game())).equals('ready')
    const throwOut = after(game(), { type: 'result', eventType: 'field_out' })
    expect(nextDecision(throwOut)).equals('batterOut')
    const choice = after(walk(game()), {
      type: 'result',
      eventType: 'fielders_choice'
    })
    expect(nextDecision(choice)).equals('resolveBatter')
    const error = after(
      game(),
      {
        type: 'ballInPlay',
        contact: 'swing',
        fielder: F.SS
      },
      { type: 'result', eventType: 'field_error' }
    )
    expect(nextDecision(error)).equals('errorAttribution')
    const triple = after(walk(game()), { type: 'result', eventType: 'triple' })
    expect(nextDecision(triple)).equals('homeDecision')
    const single = after(walk(game()), { type: 'result', eventType: 'single' })
    expect(nextDecision(single)).equals('close')
    expect(closesAutomatically(single)).equals(false)
    expect(nextDecision({ ...game(), final: true })).equals('final')
  })

  it('knows a ball in play is waiting for its result', function () {
    const swung = after(game(), ball, { type: 'ballInPlay', contact: 'swing' })
    expect(awaitingResult(game())).equals(false)
    expect(awaitingResult(after(game(), ball))).equals(false)
    expect(awaitingResult(swung)).equals(true)
    expect(
      awaitingResult(after(swung, { type: 'result', eventType: 'single' }))
    ).equals(false)
  })
})

/** A lineup change as its own event, which M7's substitutions write. */
function substitution(state: GameState): GameState {
  const play = state.liveData.plays.currentPlay!
  play.playEvents.push({
    index: play.playEvents.length,
    isPitch: false,
    type: 'action',
    isSubstitution: true,
    details: {
      code: 'offensive_substitution',
      description: 'Offensive Substitution'
    },
    count: { balls: 0, strikes: 0, outs: 0 },
    player: play.matchup.batter
  })
  return state
}
const endGame: ScoringAction = { type: 'gameFlow', kind: 'endGame' }
const steal: ScoringAction = { type: 'baseRunning', kind: 'steal', runner: 1 }

describe('the ball in play and the play begun (U13)', function () {
  it('reads the last pitch, so an action after the ball in play leaves it in play', function () {
    const inPlay = after(game(), { type: 'ballInPlay', contact: 'swing' })
    const subbed = substitution(copyState(inPlay))
    expect(awaitingResult(subbed)).equals(true)
    expect(applyAction(subbed, ball).problems[0].message).equals(
      'A ball in play needs its result'
    )
    // A runner who went while the ball was in play does not end it either.
    const running = after(
      walk(game()),
      { type: 'ballInPlay', contact: 'swing' },
      steal
    )
    expect(awaitingResult(running)).equals(true)
    expect(applyAction(running, ball).problems[0].message).equals(
      'A ball in play needs its result'
    )
    expect(
      applyAction(running, { type: 'result', eventType: 'hit_by_pitch' })
        .problems[0].message
    ).equals('A ball in play needs a batted-ball result')
    const hit = after(running, { type: 'result', eventType: 'single' })
    expect(
      hit.liveData.plays.currentPlay!.playEvents.filter(e => e.isPitch)
    ).length(1)
  })

  it('refuses End Game after a pitch, a steal or a lineup change, and allows it on an untouched play', function () {
    const untouched = walk(game())
    expect(after(untouched, endGame).final).equals(true)
    const refused = (state: GameState): string =>
      applyAction(state, endGame).problems[0]?.message
    expect(refused(after(untouched, ball))).equals('Finish the at-bat first')
    expect(refused(after(untouched, steal))).equals('Finish the at-bat first')
    expect(
      refused(
        after(untouched, { type: 'lineup', kind: 'batterSide', batSide: 'L' })
      )
    ).equals('Finish the at-bat first')
    // A substitution alone does not begin the play; any other action does.
    expect(after(substitution(copyState(untouched)), endGame).final).equals(
      true
    )
    const acted = substitution(copyState(untouched))
    delete acted.liveData.plays.currentPlay!.playEvents[0].isSubstitution
    expect(refused(acted)).equals('Finish the at-bat first')
  })
})

describe('the ball in play and the play begun, with the lineup changes the engine writes (U13)', function () {
  /** A reliever, 19, on the home bench, after a walk. */
  const relief = (): GameState =>
    after(walk(game()), {
      type: 'lineup',
      kind: 'addPlayer',
      player: 19,
      side: 'home',
      name: 'Reliever'
    })
  const change: ScoringAction = {
    type: 'lineup',
    kind: 'substitute',
    side: 'home',
    player: 19,
    replaces: F.P
  }
  const events = (state: GameState): string[] =>
    state.liveData.plays.currentPlay!.playEvents.map(
      event =>
        `${event.details.code}${event.isSubstitution === true ? ' sub' : ''}`
    )

  it('leaves the ball in play after a pitching change made while it is', function () {
    const changed = after(
      relief(),
      { type: 'ballInPlay', contact: 'swing' },
      change
    )
    expect(events(changed)).deep.equals(['X', 'pitching_substitution sub'])
    expect(awaitingResult(changed)).equals(true)
    expect(applyAction(changed, ball).problems[0].message).equals(
      'A ball in play needs its result'
    )
    // The batted result takes the ball in play, and throws no pitch.
    const hit = after(changed, { type: 'result', eventType: 'single' })
    expect(hit.liveData.plays.currentPlay!.result.eventType).equals('single')
    expect(events(hit)).deep.equals(['X', 'pitching_substitution sub'])
  })

  it('refuses End Game after a lineup change by its flag, never by its event', function () {
    const changed = after(relief(), change)
    expect(events(changed)).deep.equals(['pitching_substitution sub'])
    expect(applyAction(changed, endGame).problems[0]?.message).equals(
      'Finish the at-bat first'
    )
    // Without the flag the substitution alone has not begun the play.
    const flagless = copyState(changed)
    delete flagless.liveData.plays.currentPlay!.source.teamstation.lineupChanged
    expect(after(flagless, endGame).final).equals(true)
    expect(
      applyAction(after(flagless, ball), endGame).problems[0]?.message
    ).equals('Finish the at-bat first')
  })
})

describe('a pitch a wild pitch can follow (U14)', function () {
  it('is a B, C or S by its call code, and never an F, L, T or H', function () {
    const pointed = (state: GameState): GameState => {
      state.recentPitch = { atBatIndex: 0, index: 0 }
      return state
    }
    for (const call of ['B', 'C', 'S', 'F', 'L', 'T'] as const)
      expect(
        hasEligiblePitch(pointed(after(game(), { type: 'pitch', call }))),
        call
      ).equals(['B', 'C', 'S'].includes(call))
    const hitBatsman = after(game(), {
      type: 'result',
      eventType: 'hit_by_pitch'
    })
    expect(
      hitBatsman.liveData.plays.currentPlay!.playEvents[0].details.call
    ).deep.equals({ code: 'H', description: 'Hit by Pitch' })
    expect(hasEligiblePitch(pointed(hitBatsman))).equals(false)
    // The call decides, not the event's own code.
    const recoded = after(game(), ball)
    recoded.liveData.plays.currentPlay!.playEvents[0].details.code = 'F'
    expect(hasEligiblePitch(recoded)).equals(true)
    recoded.liveData.plays.currentPlay!.playEvents[0].details.call!.code = 'F'
    expect(hasEligiblePitch(recoded)).equals(false)
  })
})
