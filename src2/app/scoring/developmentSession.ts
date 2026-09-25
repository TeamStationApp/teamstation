import type { GameDetail, RosterEntry } from '../../common/api'
import {
  addPlayer,
  freshGame,
  newSetup,
  type RosterPlayer
} from '../../common/scoring/rules'
import type { GameSetup, GameTeam } from '../../common/scoring/state'
import type { ScoringSessionState, Side } from './scoringTypes'

export function teamsOf(game: GameDetail): Record<Side, GameTeam> {
  return {
    away: {
      id: game.awayTeamId,
      name: game.awayTeamName,
      logoUrl: game.awayLogoUrl
    },
    home: {
      id: game.homeTeamId,
      name: game.homeTeamName,
      logoUrl: game.homeLogoUrl
    }
  }
}

function rosterOf(rows: RosterEntry[]): RosterPlayer[] {
  return rows
    .filter(row => row.isPlayer)
    .map(row => ({
      userId: row.userId,
      shortName: row.shortName,
      jersey: row.jersey,
      bats: row.bats,
      throws: row.throws,
      positions: [...row.positions]
    }))
}

/**
 * The lineups a game starts from: everyone on each roster who plays, topped
 * up to nine, batting in roster order and fielding the positions they list.
 */
export function startingSetup(
  game: GameDetail,
  away: RosterEntry[],
  home: RosterEntry[]
): GameSetup {
  return newSetup(teamsOf(game), { away: rosterOf(away), home: rosterOf(home) })
}

/** A game scored here and kept nowhere: the field preview and the tests. */
export function createDevelopmentSession(
  game: GameDetail,
  away: RosterEntry[],
  home: RosterEntry[]
): ScoringSessionState {
  const state = freshGame(
    game.id,
    teamsOf(game),
    startingSetup(game, away, home)
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
