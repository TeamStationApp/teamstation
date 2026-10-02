import { expect } from 'chai'
import { describe, it } from 'mocha'

import { completeMotions } from '../../test/scoringHelpers'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import {
  copyState,
  initialScoringState,
  scoringReducer,
  snapshotOf
} from './scoringMachine'
import type { ScoringState } from './scoringTypes'

/**
 * U35: the Undo history grows with the game, not with the game times the
 * number of taps.
 */

const MB = 1024 * 1024

/**
 * The history the screen kept before it replayed the log: a full copy of the
 * state, game and all, before every step. Kept here only to show that the
 * measurement below sees its growth. Each copy is held as its JSON.
 */
class FullCopyHistory {
  private readonly copies: string[] = []
  private bytes = 0

  /** Records the state a step was taken from. */
  step(before: ScoringState): void {
    const copy = JSON.stringify(snapshotOf(before))
    this.copies.push(copy)
    this.bytes += copy.length
  }

  get size(): number {
    return this.bytes
  }

  get length(): number {
    return this.copies.length
  }
}

/** The history the screen keeps now: its steps and its checkpoints. */
function retained(state: ScoringState): number {
  return JSON.stringify({ past: state.past, checkpoints: state.checkpoints })
    .length
}

/** What the retained history is made of. */
interface Measure {
  total: number
  /** The steps, and the checkpoints without their games. */
  steps: number
  /** The copies of the game the checkpoints hold. */
  games: number[]
}

function measure(state: ScoringState): Measure {
  const games = state.checkpoints.flatMap(point =>
    point.session != null ? [JSON.stringify(point.session).length] : []
  )
  return {
    total: retained(state),
    steps: JSON.stringify({
      past: state.past,
      checkpoints: state.checkpoints.map(point => ({
        ...point,
        session: null
      }))
    }).length,
    games
  }
}

/**
 * Scores `appearances` plate appearances of five pitches each, strikeouts
 * and walks in turn, measuring the retained history after every 50.
 */
function script(
  appearances: number,
  fullCopies?: FullCopyHistory
): { state: ScoringState; sizes: Measure[] } {
  let state = initialScoringState(createDevelopmentSession(gameFixture, [], []))
  const sizes: Measure[] = []
  for (let appearance = 0; appearance < appearances; appearance++) {
    const pitches =
      appearance % 2 === 0
        ? (['foul', 'called', 'ball', 'ball', 'swing'] as const)
        : (['ball', 'foul', 'ball', 'ball', 'ball'] as const)
    for (const kind of pitches) {
      fullCopies?.step(state)
      state = completeMotions(scoringReducer(state, { type: 'PITCH', kind }))
    }
    state = scoringReducer(state, { type: 'CLOSE_PLAY' })
    if (fullCopies == null && (appearance + 1) % 50 === 0)
      sizes.push(measure(state))
  }
  return { state, sizes }
}

describe('the Undo history over a long game (U35)', function () {
  it('stays under 5 MB over 150 appearances, the steps growing linearly', function () {
    this.timeout(120_000)
    const { state, sizes } = script(150)
    expect(state.session.liveData.plays.allPlays).has.length(150)
    expect(state.past).has.length(750)
    const [fifty, hundred, all] = sizes
    // About 4 MB in all (0.6, 2.0, 4.0 MB at 50, 100, 150).
    expect(all.total).lessThan(5 * MB)
    // The steps are linear: each fifty appearances add about what the fifty
    // before did. Growth with the game times the taps would add 5/3 as much
    // the second time.
    expect(
      (all.steps - hundred.steps) / (hundred.steps - fifty.steps)
    ).lessThan(1.3)
    // The games are one copy per ten appearances, plus the newest two: the
    // first, every tenth and the newest two checkpoints hold one.
    expect(
      state.checkpoints.flatMap((point, index) =>
        point.session != null ? [index] : []
      )
    ).deep.equals([
      0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 148, 149
    ])
    expect(fifty.games).has.length(7)
    expect(hundred.games).has.length(12)
    // Each copy is at most the size of the newest game, which is linear.
    for (const { games } of sizes)
      for (const game of games) expect(game).lessThanOrEqual(games.at(-1)!)
    expect(
      (all.games.at(-1)! - hundred.games.at(-1)!) /
        (hundred.games.at(-1)! - fifty.games.at(-1)!)
    ).lessThan(1.3)
    // So the whole is the steps and those copies, and no more.
    expect(all.total).lessThan(
      all.steps + all.games.reduce((sum, game) => sum + game, 0) + 1024
    )
    // Twenty Undos in a row reach back four appearances, and still land on
    // the game as it was.
    const earlier = script(146).state
    let back = state
    for (let i = 0; i < 20; i++) back = scoringReducer(back, { type: 'UNDO' })
    expect(back.log).deep.equals(earlier.log)
    expect(back.session).deep.equals(copyState(earlier.session))
    expect(back.past).has.length(730)
  })

  it('would exceed 50 MB with a full copy per step, so the bound means something', function () {
    this.timeout(120_000)
    const fullCopies = new FullCopyHistory()
    const { state } = script(150, fullCopies)
    expect(fullCopies.length).equals(state.past.length)
    expect(fullCopies.size).greaterThan(50 * MB)
    expect(fullCopies.size).greaterThan(10 * retained(state))
  })
})
