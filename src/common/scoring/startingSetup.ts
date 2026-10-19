import type { GameDetail, RosterEntry } from '../api'
import type { Unrostered } from '../unroster'
import { asGumboId } from '../userId'
import type { ScoringAction } from './actions'
import { begun, newSetup, type RosterPlayer } from './lineup'
import {
  type Lineup,
  lineupOf,
  type LineupPerson,
  sameArrangement,
  unseenLineup
} from './lineupHistory'
import { reconcileRoster } from './rosterAvailability'
import {
  copyState,
  type GameSetup,
  type GameState,
  type GameTeam,
  lineupsOf,
  type Position,
  POSITIONS,
  setupOf,
  type Side
} from './state'

/** What of a game names its two teams. */
export type GameTeams = Pick<
  GameDetail,
  | 'awayTeamId'
  | 'awayTeamName'
  | 'awayLogoUrl'
  | 'homeTeamId'
  | 'homeTeamName'
  | 'homeLogoUrl'
>

export function teamsOf(game: GameTeams): Record<Side, GameTeam> {
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
      gumboId: asGumboId(row.gumboId),
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
  game: GameTeams & {
    unrostered?: Unrostered
    guestPlayers?: Record<Side, RosterEntry[]>
  },
  away: RosterEntry[],
  home: RosterEntry[],
  defaults: DefaultLineups = {},
  fillRoster = true
): GameSetup {
  const setup = newSetup(
    teamsOf(game),
    {
      away: rosterOf(
        away.filter(
          row =>
            !row.isPlayer ||
            game.unrostered?.away.includes(asGumboId(row.gumboId)) !== true
        )
      ),
      home: rosterOf(
        home.filter(
          row =>
            !row.isPlayer ||
            game.unrostered?.home.includes(asGumboId(row.gumboId)) !== true
        )
      )
    },
    fillRoster
  )
  const reconciled = reconcileRoster(
    setup,
    teamsOf(game),
    { away, home },
    game.guestPlayers ?? { away: [], home: [] },
    game.unrostered ?? { away: [], home: [] }
  )
  for (const side of ['away', 'home'] as const) {
    const lineup = defaults[side]
    if (lineup != null)
      arrangeFromDefault(reconciled, teamsOf(game), side, lineup)
  }
  return reconciled
}

/**
 * Arranges one side of `setup` as its team's default lineup. Each person
 * with a user id is today's roster player of that id, and anybody no longer
 * on the roster is dropped; a placeholder is made again, with his name and
 * jersey. Roster players the default leaves out stay on the bench, out of
 * the order and the field. Incomplete defaults stay incomplete for setup.
 */
function arrangeFromDefault(
  setup: GameSetup,
  teams: Record<Side, GameTeam>,
  side: Side,
  lineup: Lineup
): void {
  const team = setup.sides[side]
  const available = new Set(team.players)
  const idOf = (person: LineupPerson | null): number | null =>
    person?.gumboId != null && available.has(person.gumboId)
      ? person.gumboId
      : null
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

/** `state` with `side` arranged as `lineup`, leaving the other side as it is. */
export function withSideLineup(
  state: GameState,
  side: Side,
  lineup: Lineup
): GameState {
  const next = copyState(state)
  const setup = setupOf(next)
  arrangeFromDefault(setup, next.gameData.teams, side, lineup)
  next.gameData.players = setup.players
  next.liveData.boxscore.teams = setup.sides
  next.meta.tagOrder = setup.tagOrder
  return next
}

/**
 * The game a reader who can see `side` is shown. A side still held as the
 * roster order a save left, because that save could not see the team, is
 * shown from `lineup` (the default he may read) instead. Once the stored
 * arrangement is no longer that order, the stored lineup is the one he sees.
 * Nothing here is written: opening does not put the default into the game.
 */
export function shownWithDefault(
  state: GameState,
  actions: readonly ScoringAction[],
  side: Side,
  lineup: Lineup | null
): GameState {
  if (lineup == null) return state
  const placeholder = unseenLineup(actions, side)
  if (placeholder == null) return state
  const current = lineupOf(lineupsOf(state), side, state.gameData.players)
  if (!sameArrangement(current, placeholder)) return state
  return withSideLineup(state, side, lineup)
}

/**
 * Whether `side` is still the roster order a save left because it could not
 * see the team, and `lineup` is the default shown in its place. That lineup
 * is not accepted until the reader saves it.
 */
export function defaultPending(
  state: GameState,
  actions: readonly ScoringAction[],
  side: Side,
  lineup: Lineup | null
): boolean {
  return shownWithDefault(state, actions, side, lineup) !== state
}

/**
 * The game a scorer who can read these defaults is shown, before the first
 * pitch. A side still held as the roster order a save left, because that
 * save could not see the team, is shown from the default he may read.
 * Once the game has begun, the stored lineup is the one he sees. Nothing
 * here is written.
 */
export function withVisibleDefaults(
  state: GameState,
  actions: readonly ScoringAction[],
  defaults: DefaultLineups
): GameState {
  if (begun(state)) return state
  let next = state
  for (const side of ['away', 'home'] as const)
    next = shownWithDefault(next, actions, side, defaults[side] ?? null)
  return next
}

/**
 * Whether a default he can read stands in for a side that is still the
 * roster order a save left. That lineup is not accepted until he saves it
 * or scores from it.
 */
export function defaultsUnaccepted(
  actions: readonly ScoringAction[],
  defaults: DefaultLineups
): boolean {
  return (['away', 'home'] as const).some(
    side =>
      (defaults[side] ?? null) != null && unseenLineup(actions, side) != null
  )
}
