import type { GameDetail, RosterEntry } from '../../common/api'
import { addPlayer, freshGame } from '../../common/scoring/rules'
import { startingSetup, teamsOf } from '../../common/scoring/startingSetup'
import type { ScoringSessionState, Side } from './scoringTypes'

export {
  type DefaultLineups,
  startingSetup,
  teamsOf
} from '../../common/scoring/startingSetup'

/** A game scored here and kept nowhere: the field preview and the tests. */
export function createDevelopmentSession(
  game: GameDetail,
  away: RosterEntry[],
  home: RosterEntry[]
): ScoringSessionState {
  const state = freshGame(
    game.id,
    teamsOf(game),
    startingSetup(game, away, home),
    game.fenceDistanceFt
  )
  state.meta.source = 'local-development'
  return state
}

export function addDevelopmentPlayer(
  session: ScoringSessionState,
  side: Side,
  name: string,
  jersey = ''
): number {
  return addPlayer(session, side, name, jersey)
}
