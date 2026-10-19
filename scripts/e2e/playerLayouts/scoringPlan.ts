/**
 * The plays the player-layouts fixture scores into its games, half by half:
 * a home run, a single and an error on a fixed pattern, then three
 * strikeouts. Both halves of an inning are the same, so the game stays tied
 * into extra innings, until the top of `innings` scores and the bottom does
 * not: the line score then has innings past nine, runs, hits and an error
 * for both sides.
 */
import type { ScoringAction } from '../../../src/common/scoring/actions'
import { fieldingSide } from '../../../src/common/scoring/lineup'
import { nextDecision } from '../../../src/common/scoring/rules'
import type { GameState } from '../../../src/common/scoring/state'

const strike: ScoringAction = { type: 'pitch', call: 'C' }
const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
const swing: ScoringAction = { type: 'ballInPlay', contact: 'swing' }

/** The batting events of one inning, before its three strikeouts. */
function events(inning: number): ScoringAction[][] {
  const out: ScoringAction[][] = []
  if (inning % 3 === 1)
    out.push([swing, { type: 'result', eventType: 'home_run' }])
  if (inning % 4 === 2)
    out.push([swing, { type: 'result', eventType: 'single' }])
  if (inning % 5 === 3)
    out.push([swing, { type: 'result', eventType: 'field_error' }])
  return out
}

/**
 * The plays of one half: each is the actions of one batter, which the
 * caller applies one at a time, saying what the play waits on first
 * (`decide`).
 */
export function halfPlays(
  inning: number,
  top: boolean,
  innings: number
): ScoringAction[][] {
  const homeRun: ScoringAction = { type: 'result', eventType: 'home_run' }
  const batters =
    inning === innings ? (top ? [[swing, homeRun]] : []) : events(inning)
  return [
    ...batters,
    [strike, strike, strike],
    [strike, strike, strike],
    [strike, strike, strike]
  ]
}

/**
 * What the scorer says before the next action when the play in front of
 * them waits on it: the shortstop charged with an error, or the play closed
 * once it is decided. Null when nothing is waiting.
 */
export function decide(state: GameState): ScoringAction | null {
  const decision = nextDecision(state)
  if (decision === 'close') return close
  if (decision === 'errorAttribution') {
    const shortstop =
      state.liveData.boxscore.teams[fieldingSide(state)].defense.SS
    if (shortstop == null) throw new Error('Nobody is at shortstop')
    return { type: 'fieldingPlay', fielders: [shortstop], error: shortstop }
  }
  return null
}
