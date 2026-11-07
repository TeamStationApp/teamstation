import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  after,
  bases,
  close,
  F,
  game,
  outs,
  runs
} from '../../test/scoringGames'
import type { ScoringAction } from './actions'
import { applyAction } from './apply'
import { playerRef } from './lineup'
import {
  groundOfferAt,
  hitOfferMovement,
  homeBackProposal,
  nextDecision
} from './rules'
import { BASE_KEYS, type GameState } from './state'

/** Runners 7, 8 and 9 stand on the bases `occupied` names, with `out` out. */
function setUp(occupied: readonly boolean[], out = 0): GameState {
  const state = game()
  const line = state.liveData.linescore
  occupied.forEach((on, index) => {
    if (on) line.offense[BASE_KEYS[index]] = playerRef(state, 7 + index)
  })
  line.outs = out
  return state
}
const RUNNER = { first: 7, second: 8, third: 9 } as const
const batter = (state: GameState): number =>
  state.liveData.plays.currentPlay!.matchup.batter.id

/** A ground ball to short: a Ground Out (`throw`) or an Out at First. */
function groundOut(
  contact: 'swing' | 'bunt' = 'swing',
  outBy: 'throw' | 'first' = 'throw'
): ScoringAction[] {
  return [
    { type: 'ballInPlay', contact, fielder: F.SS, launchAngle: -10 },
    {
      type: 'result',
      eventType: 'field_out',
      outBy,
      advance: 'ground'
    }
  ]
}
/** Both outs the scorer can call on a ground ball, as the engine names them. */
const GROUND_OUT_KINDS = [
  { outBy: 'throw', outcome: 'Ground Out' },
  { outBy: 'first', outcome: 'Out at First' }
] as const
const batterOut = (state: GameState): ScoringAction => ({
  type: 'runnerMovement',
  runner: batter(state),
  to: '1B',
  out: true,
  ...(state.pending?.outcome === 'Out at First'
    ? { reason: 'Out at First' as const }
    : {}),
  fielders: [F.SS, F['1B']]
})
const back = (runner: number, to: '1B' | '2B' | '3B'): ScoringAction => ({
  type: 'runnerMovement',
  runner,
  to
})
const problem = (state: GameState, action: ScoringAction): string | undefined =>
  applyAction(state, action).problems[0]?.message

/** Every one of the eight ways the bases can be filled. */
const OCCUPANCIES = Array.from({ length: 8 }, (_, mask) =>
  [0, 1, 2].map(bit => (mask & (1 << bit)) !== 0)
)

describe('a ground out with fewer than two out', function () {
  it('sends every other runner up one base, and the runner from third waits on home', function () {
    for (const { outBy, outcome } of GROUND_OUT_KINDS)
      for (const occupied of OCCUPANCIES)
        for (const out of [0, 1]) {
          const label = `${outcome}: ${occupied.join(',')} with ${out} out`
          const state = after(
            setUp(occupied, out),
            ...groundOut('swing', outBy)
          )
          expect(state.pending!.outcome, label).equals(outcome)
          const expected = [null, null, null] as Array<number | null>
          occupied.forEach((on, index) => {
            if (on && index < 2) expected[index + 1] = 7 + index
          })
          expect(bases(state), label).deep.equals(expected)
          expect(state.homeQueue, label).deep.equals(
            occupied[2] ? [RUNNER.third] : []
          )
          expect(runs(state), label).equals(0)
          expect(nextDecision(state), label).equals('batterOut')
          // Each advance short of home is on the play, as the ground out.
          const play = state.liveData.plays.currentPlay!
          expect(
            play.runners.map(runner => [
              runner.details.runner.id,
              runner.movement.start,
              runner.movement.end,
              runner.details.movementReason
            ]),
            label
          ).deep.equals(
            [1, 0]
              .filter(index => occupied[index])
              .map(index => [7 + index, index + 1, index + 2, 'Ground Out'])
          )
          const done = after(state, batterOut(state))
          expect(outs(done), label).equals(out + 1)
          expect(runs(done), label).equals(0)
          expect(nextDecision(done), label).equals(
            occupied[2] ? 'homeDecision' : 'close'
          )
        }
  })

  it('names an Out at First by its own name, the batter out at first by a throw', function () {
    const state = after(
      setUp([true, false, true]),
      ...groundOut('swing', 'first')
    )
    expect(state.pending!.outcome).equals('Out at First')
    expect(
      state.pending!.movements.map(move => [move.playerId, move.to])
    ).deep.equals([
      [RUNNER.third, 4],
      [RUNNER.first, 2]
    ])
    const done = after(state, batterOut(state), {
      type: 'runnerMovement',
      runner: RUNNER.third,
      to: 'home'
    })
    const play = after(done, close).liveData.plays.allPlays.at(-1)!
    expect(play.source.teamstation.outSubtype).equals('Out at First')
    expect(play.result.event).equals('Out at First')
    expect(play.result.eventType).equals('field_out')
    expect(play.result.rbi).equals(1)
    const out = play.runners.find(
      runner => runner.details.runner.id === play.matchup.batter.id
    )!
    expect(out.details.movementReason).equals('Out at First')
    expect(out.movement.isOut).equals(true)
    expect(out.movement.end).equals(1)
    expect(
      out.credits.map(credit => [credit.credit, credit.player?.id])
    ).deep.equals([
      ['f_assist', F.SS],
      ['f_putout', F['1B']]
    ])
  })

  it('names the out a ground out, forced runners forced, the batter out at first', function () {
    const state = after(setUp([true, false, true]), ...groundOut())
    const pending = state.pending!
    expect(pending.outcome).equals('Ground Out')
    expect(
      pending.movements.map(move => [
        move.playerId,
        move.start,
        move.to,
        move.force,
        move.decision,
        move.groundOffer
      ])
    ).deep.equals([
      [RUNNER.third, 3, 4, false, 'pending', true],
      [RUNNER.first, 1, 2, true, 'safe', true]
    ])
    const done = after(state, batterOut(state), {
      type: 'runnerMovement',
      runner: RUNNER.third,
      to: 'home'
    })
    const play = after(done, close).liveData.plays.allPlays.at(-1)!
    expect(play.source.teamstation.outSubtype).equals('Ground Out')
    expect(play.result.event).equals('Ground Out')
    expect(play.result.rbi).equals(1)
  })
})

describe('a ground out with two out', function () {
  it('moves nobody, and the batter out ends the half with the score unchanged', function () {
    for (const { outBy, outcome } of GROUND_OUT_KINDS)
      for (const occupied of OCCUPANCIES) {
        const label = `${outcome}: ${occupied.join(',')}`
        const start = setUp(occupied, 2)
        const state = after(start, ...groundOut('swing', outBy))
        expect(bases(state), label).deep.equals(bases(start))
        expect(state.homeQueue, label).deep.equals([])
        const third = after(state, batterOut(state))
        expect(outs(third), label).equals(3)
        expect(nextDecision(third), label).equals('close')
        const done = after(third, close)
        expect(done.liveData.linescore.isTopInning, label).equals(false)
        expect(outs(done), label).equals(0)
        expect(runs(done), label).equals(0)
        expect(done.liveData.linescore.teams.away.runs, label).equals(0)
      }
  })
})

describe('dragging a ground-out runner back', function () {
  it('takes a forced runner back to the base he started from', function () {
    let state = after(setUp([true, false, false]), ...groundOut())
    state = after(state, batterOut(state))
    expect(hitOfferMovement(state, RUNNER.first)?.force).equals(true)
    const returned = applyAction(state, back(RUNNER.first, '1B'))
    expect(returned.problems).deep.equals([])
    expect(bases(returned.state)).deep.equals([RUNNER.first, null, null])
    // The advance he never made leaves the play.
    expect(
      returned.state.liveData.plays.currentPlay!.runners.filter(
        runner => runner.details.runner.id === RUNNER.first
      )
    ).deep.equals([])
    expect(returned.transitions).deep.include({
      type: 'runnerReturned',
      runner: RUNNER.first,
      from: 2,
      to: 1
    })
    // He may take the base again, as the ground out gave it.
    const retaken = after(returned.state, {
      type: 'runnerMovement',
      runner: RUNNER.first,
      to: '2B'
    })
    expect(bases(retaken)).deep.equals([null, RUNNER.first, null])
  })

  it('drags each of two runners back, and refuses the lead back onto the trail', function () {
    let state = after(setUp([true, true, false]), ...groundOut())
    expect(bases(state)).deep.equals([null, RUNNER.first, RUNNER.second])
    state = after(state, batterOut(state))
    expect(problem(state, back(RUNNER.second, '2B'))).equals(
      'That base is occupied. Move the lead runner first.'
    )
    state = after(state, back(RUNNER.first, '1B'))
    state = after(state, back(RUNNER.second, '2B'))
    expect(bases(state)).deep.equals([RUNNER.first, RUNNER.second, null])
    expect(nextDecision(state)).equals('close')
  })

  it('lets a runner go back before the batter is put out, but not further than his own base', function () {
    const state = after(setUp([false, true, false]), ...groundOut())
    expect(nextDecision(state)).equals('batterOut')
    const returned = after(state, back(RUNNER.second, '2B'))
    expect(bases(returned)).deep.equals([null, RUNNER.second, null])
    expect(problem(returned, back(RUNNER.second, '1B'))).equals(
      'A runner cannot go back'
    )
    // Retaking the offer is allowed while the batter's out is still to come.
    expect(
      bases(after(returned, { type: 'runnerMovement', runner: 8, to: '3B' }))
    ).deep.equals([null, null, RUNNER.second])
  })
})

describe('the runner a ground out sends home', function () {
  function onThird(): GameState {
    const state = after(setUp([false, false, true]), ...groundOut())
    return after(state, batterOut(state))
  }

  it('scores only once he is called safe', function () {
    const state = onThird()
    expect(runs(state)).equals(0)
    const safe = after(state, {
      type: 'runnerMovement',
      runner: RUNNER.third,
      to: 'home'
    })
    expect(runs(safe)).equals(1)
    expect(nextDecision(safe)).equals('close')
  })

  it('is out at home with the fielders credited', function () {
    const out = after(onThird(), {
      type: 'runnerMovement',
      runner: RUNNER.third,
      to: 'home',
      out: true,
      fielders: [F['1B'], F.C]
    })
    expect(runs(out)).equals(0)
    expect(outs(out)).equals(2)
    const row = out.liveData.plays.currentPlay!.runners.at(-1)!
    expect(row.movement).includes({ start: 3, end: 4, isOut: true })
    expect(
      row.credits.map(credit => `${credit.credit} ${credit.player?.id}`)
    ).deep.equals([`f_assist ${F['1B']}`, `f_putout ${F.C}`])
  })

  it('goes back to an empty third', function () {
    const state = onThird()
    expect(homeBackProposal(state)).not.equals(null)
    const back3 = after(state, back(RUNNER.third, '3B'))
    expect(bases(back3)).deep.equals([null, null, RUNNER.third])
    expect(runs(back3)).equals(0)
    expect(back3.homeQueue).deep.equals([])
    expect(nextDecision(back3)).equals('close')
  })

  it('cannot go back while third is taken', function () {
    let state = after(setUp([false, true, true]), ...groundOut())
    state = after(state, batterOut(state))
    expect(homeBackProposal(state)).equals(null)
    expect(problem(state, back(RUNNER.third, '3B'))).equals(
      'The runners behind him cannot give ground'
    )
  })
})

describe('a ground out with the bases loaded', function () {
  function loaded(): GameState {
    const state = after(setUp([true, true, true]), ...groundOut())
    return after(state, batterOut(state))
  }

  it('drags the two trailing runners back and sends the lead back to third', function () {
    let state = loaded()
    expect(bases(state)).deep.equals([null, RUNNER.first, RUNNER.second])
    expect(state.homeQueue).deep.equals([RUNNER.third])
    state = after(state, back(RUNNER.first, '1B'))
    state = after(state, back(RUNNER.second, '2B'))
    state = after(state, back(RUNNER.third, '3B'))
    expect(bases(state)).deep.equals([
      RUNNER.first,
      RUNNER.second,
      RUNNER.third
    ])
    expect(runs(state)).equals(0)
    expect(outs(state)).equals(1)
  })

  it('scores the lead runner safe at home, the others standing a base up', function () {
    const state = after(loaded(), {
      type: 'runnerMovement',
      runner: RUNNER.third,
      to: 'home'
    })
    expect(runs(state)).equals(1)
    expect(bases(state)).deep.equals([null, RUNNER.first, RUNNER.second])
  })
})

describe('a bunt ground out', function () {
  it('moves the runners on a bunt Out at First as a swung one does', function () {
    for (const occupied of OCCUPANCIES) {
      const swung = after(setUp(occupied), ...groundOut('swing', 'first'))
      const bunted = after(setUp(occupied), ...groundOut('bunt', 'first'))
      expect(bases(bunted), occupied.join(',')).deep.equals(bases(swung))
      expect(bunted.homeQueue).deep.equals(swung.homeQueue)
    }
  })
  it('moves the runners as a swung ground out does', function () {
    for (const occupied of OCCUPANCIES) {
      const swung = after(setUp(occupied), ...groundOut('swing'))
      const bunted = after(setUp(occupied), ...groundOut('bunt'))
      expect(bases(bunted), occupied.join(',')).deep.equals(bases(swung))
      expect(bunted.homeQueue).deep.equals(swung.homeQueue)
      expect(bunted.pending!.movements).deep.equals(swung.pending!.movements)
    }
  })

  it('is a sacrifice when it moved a runner up', function () {
    let state = after(setUp([true, false, false]), ...groundOut('bunt'))
    state = after(state, batterOut(state), close)
    expect(state.liveData.plays.allPlays.at(-1)!.result.eventType).equals(
      'sac_bunt'
    )
  })
})

describe('outs that are not ground outs', function () {
  it('leave the runners where they stood on a ball caught', function () {
    for (const advance of [undefined, 'ground'] as const) {
      const start = setUp([true, true, true])
      const state = after(
        start,
        {
          type: 'ballInPlay',
          contact: 'swing',
          fielder: F.CF,
          launchAngle: 40
        },
        {
          type: 'result',
          eventType: 'field_out',
          outBy: 'catch',
          ...(advance == null ? {} : { advance })
        }
      )
      expect(bases(state)).deep.equals(bases(start))
      expect(state.homeQueue).deep.equals([])
      expect(outs(state)).equals(1)
    }
  })

  it('leave the runners where they stood on a ground out stored without advance', function () {
    const start = setUp([true, true, true])
    const state = after(
      start,
      { type: 'ballInPlay', contact: 'swing', fielder: F.SS },
      { type: 'result', eventType: 'field_out', outBy: 'throw' }
    )
    expect(bases(state)).deep.equals(bases(start))
    expect(state.pending!.movements).deep.equals([])
  })
})

describe('the relay that retires the batter after a ground out', function () {
  it('puts a runner out where the ground out stood him, from his own base', function () {
    const state = after(setUp([true, false, false]), ...groundOut())
    expect(groundOfferAt(state, RUNNER.first, 2)).not.equals(undefined)
    expect(groundOfferAt(state, RUNNER.first, 1)).equals(undefined)
    const done = after(
      state,
      {
        type: 'runnerMovement',
        runner: RUNNER.first,
        to: '2B',
        out: true,
        reason: 'Force Out',
        fielders: [F.SS, F['2B']]
      },
      {
        type: 'runnerMovement',
        runner: batter(state),
        to: '1B',
        out: true,
        fielders: [F['2B'], F['1B']]
      },
      close
    )
    const play = done.liveData.plays.allPlays.at(-1)!
    expect(play.result.eventType).equals('grounded_into_double_play')
    expect(
      play.runners.map(runner => [
        runner.details.runner.id,
        runner.movement.start,
        runner.movement.end,
        runner.movement.isOut,
        runner.movement.forceOut
      ])
    ).deep.equals([
      [RUNNER.first, 1, 2, true, true],
      [batter(state), 0, 1, true, true]
    ])
  })

  it('tags out an unforced runner where the ground out stood him', function () {
    const state = after(setUp([false, true, false]), ...groundOut())
    const done = after(state, {
      type: 'runnerMovement',
      runner: RUNNER.second,
      to: '3B',
      out: true,
      reason: 'Tag Out',
      fielders: [F.SS, F['3B']]
    })
    const row = done.liveData.plays.currentPlay!.runners.at(-1)!
    expect(row.movement).includes({
      start: 2,
      end: 3,
      isOut: true,
      forceOut: false
    })
    expect(row.details.movementReason).equals('Tag Out')
    expect(nextDecision(done)).equals('batterOut')
  })
})
