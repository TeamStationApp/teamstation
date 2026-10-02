import type {
  GameDetail,
  Lineup,
  LineupPerson,
  RosterEntry
} from '../../common/api'
import {
  addPlayer,
  freshGame,
  newSetup,
  type RosterPlayer
} from '../../common/scoring/rules'
import {
  type GameSetup,
  type GameTeam,
  type Position,
  POSITIONS
} from '../../common/scoring/state'
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

/** Each team's default lineup, where it has one. */
export type DefaultLineups = Partial<Record<Side, Lineup | null>>

/**
 * The lineups a game starts from: everyone on each roster who plays, topped
 * up to nine, batting in roster order and fielding the positions they list.
 * A side whose team has a default lineup starts from that instead (see
 * `arrangeFromDefault`).
 */
export function startingSetup(
  game: GameDetail,
  away: RosterEntry[],
  home: RosterEntry[],
  defaults: DefaultLineups = {}
): GameSetup {
  const setup = newSetup(teamsOf(game), {
    away: rosterOf(away),
    home: rosterOf(home)
  })
  for (const side of ['away', 'home'] as const) {
    const lineup = defaults[side]
    if (lineup != null) arrangeFromDefault(setup, teamsOf(game), side, lineup)
  }
  return setup
}

/**
 * Arranges one side of `setup` as its team's default lineup. Each person
 * with a user id is today's roster player of that id, and anybody no longer
 * on the roster is dropped; a placeholder is made again, with his name and
 * jersey. Roster players the default leaves out stay on the bench, out of
 * the order and the field. A default that no longer leaves a batter and a
 * pitcher leaves the side as the roster makes it.
 */
function arrangeFromDefault(
  setup: GameSetup,
  teams: Record<Side, GameTeam>,
  side: Side,
  lineup: Lineup
): void {
  const team = setup.sides[side]
  const rosterIds = team.players.filter(id => !setup.players[id].local)
  const byUser = new Map<number, number>()
  for (const id of rosterIds) {
    const userId = setup.players[id].userId
    if (userId != null) byUser.set(userId, id)
  }
  const kept = (person: LineupPerson | null): boolean =>
    person != null && (person.userId == null || byUser.has(person.userId))
  if (!lineup.batters.some(kept) || !kept(lineup.defense.P)) return

  // The roster's made-up players give way to the default's own.
  for (const id of team.players)
    if (setup.players[id].local) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete setup.players[id]
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete setup.identities.sessionToSource[id]
    }
  team.players = [...rosterIds]
  const draft = {
    gameData: { teams, players: setup.players },
    liveData: { boxscore: { teams: setup.sides } },
    meta: { identities: setup.identities }
  }
  const placeholders = new Map<string, number>()
  const idOf = (person: LineupPerson | null): number | null => {
    if (person == null) return null
    if (person.userId != null) return byUser.get(person.userId) ?? null
    let id = placeholders.get(person.name)
    if (id == null) {
      id = addPlayer(draft, side, person.name, person.jersey)
      placeholders.set(person.name, id)
    }
    return id
  }
  const order: number[] = []
  for (const person of lineup.batters) {
    const id = idOf(person)
    if (id != null && !order.includes(id)) order.push(id)
  }
  const defense = Object.fromEntries(
    POSITIONS.map(position => [position, null])
  ) as Record<Position, number | null>
  const fielding = new Set<number>()
  for (const position of POSITIONS) {
    const id = idOf(lineup.defense[position])
    if (id != null && !fielding.has(id)) {
      defense[position] = id
      fielding.add(id)
    }
  }
  team.battingOrder = order
  team.battingIndex = 0
  team.defense = defense
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
