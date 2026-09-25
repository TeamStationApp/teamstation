import { expect } from 'chai'
import { describe, it } from 'mocha'

import { after, ball, F, game, strike, walk } from '../../test/scoringGames'
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
