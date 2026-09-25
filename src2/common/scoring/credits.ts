import type { ErrorKind } from './actions'
import { playerRef } from './lineup'
import { type GameState, POSITIONS, type RunnerCredit } from './state'

/**
 * Who gets credit for what. Fielding credits follow the official scoring
 * rules: on an out, everyone who handled the ball before the fielder who made
 * the putout earns one assist, once each however many times he touched it; the
 * fielder who made the putout earns it. A fielder who throws and then takes
 * the return throw earns both. The fielder who first handled a ball that fell
 * for a hit, or that the batter reached on, is credited with fielding it.
 */

function positionOf(state: GameState, id: number): string {
  return (
    POSITIONS.find(
      position => state.liveData.linescore.defense[position]?.id === id
    ) ?? ''
  )
}

function credit(
  state: GameState,
  id: number,
  kind: RunnerCredit['credit']
): RunnerCredit {
  return {
    player: playerRef(state, id),
    credit: kind,
    position: positionOf(state, id)
  }
}

/** The assists and the putout for one out, from the fielders in order. */
export function outCredits(
  state: GameState,
  fielders: readonly number[]
): RunnerCredit[] {
  const putout = fielders.at(-1)
  if (putout == null) return []
  const assists = [...new Set(fielders.slice(0, -1))]
  return [
    ...assists.map(id => credit(state, id, 'f_assist')),
    credit(state, putout, 'f_putout')
  ]
}

/** The fielder who first handled a ball the batter reached on. */
export function fieldedCredit(state: GameState, fielder: number): RunnerCredit {
  return credit(state, fielder, 'f_fielded_ball')
}

export function errorCredit(
  state: GameState,
  fielder: number,
  kind: ErrorKind = 'fielding'
): RunnerCredit {
  return credit(
    state,
    fielder,
    kind === 'throwing' ? 'f_throwing_error' : 'f_fielding_error'
  )
}

/**
 * Whether a run on this play is batted in. Nobody drives in a run that scored
 * on a balk, on an error, or on a play the defence could have ended with a
 * force for the third out; those are taken back when the out is made.
 */
export function earnsRbi(outcome: string | undefined): boolean {
  return (
    outcome !== 'Balk' &&
    outcome !== 'Error' &&
    outcome !== 'Dropped Third Strike'
  )
}
