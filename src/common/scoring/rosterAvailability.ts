import type { RosterEntry } from '../api'
import type { Unrostered } from '../unroster'
import { asGumboId } from '../userId'
import {
  copyState,
  type GamePlay,
  type GameSetup,
  type GameState,
  type GameTeam,
  type PlayEvent,
  POSITIONS,
  type Side
} from './state'

export type ScoringRosterEntry = Pick<
  RosterEntry,
  | 'gumboId'
  | 'isPlayer'
  | 'shortName'
  | 'nameFormat'
  | 'jersey'
  | 'positions'
  | 'bats'
  | 'throws'
>

/** Who a side would field: its roster's players and its guests. */
function fielded(
  roster: readonly ScoringRosterEntry[],
  guests: readonly ScoringRosterEntry[],
  left: readonly number[]
): ScoringRosterEntry[] {
  const players = roster.filter(row => row.isPlayer)
  const rosterIds = new Set(players.map(row => asGumboId(row.gumboId)))
  return [
    ...players.filter(row => !left.includes(asGumboId(row.gumboId))),
    ...guests.filter(row => !rosterIds.has(asGumboId(row.gumboId)))
  ]
}

/**
 * Who both sides of a game would field: somebody on both rosters, as a game
 * made after a roster add, or a merge, can leave them. They play for neither
 * until a coach leaves them out of one side; they cannot be asked to choose
 * when the game is made, and a season must not fail to publish over them.
 */
export function onBothSides(
  rosters: Record<Side, readonly ScoringRosterEntry[]>,
  guests: Record<Side, readonly ScoringRosterEntry[]>,
  unrostered: Unrostered
): Set<number> {
  const ids = (side: Side): number[] =>
    fielded(rosters[side], guests[side], unrostered[side]).map(row =>
      asGumboId(row.gumboId)
    )
  const away = new Set(ids('away'))
  return new Set(ids('home').filter(id => away.has(id)))
}

/** Somebody put on a base: a pinch runner, or a courtesy runner. */
function toBase(event: PlayEvent): boolean {
  return event.position === 'PR' || event.details.code === 'ts_courtesy_runner'
}

/** A change of who is in the game, with no pitch or action of the play. */
function isLineupEvent(event: PlayEvent): boolean {
  return event.isSubstitution === true || toBase(event)
}

/**
 * Who a pitch or an action of a play found at the plate and on the mound. A
 * lineup change overwrites the matchup, so this walks back from where it ends.
 */
function facedIn(play: GamePlay): { batters: number[]; pitchers: number[] } {
  let batter = play.matchup.batter.id
  let pitcher = play.matchup.pitcher.id
  const batters: number[] = []
  const pitchers: number[] = []
  for (const event of [...play.playEvents].reverse()) {
    if (!isLineupEvent(event)) {
      batters.push(batter)
      pitchers.push(pitcher)
      continue
    }
    if (event.player.id === batter) batter = event.replacedPlayer?.id ?? batter
    if (event.player.id === pitcher)
      pitcher = event.replacedPlayer?.id ?? pitcher
  }
  return { batters, pitchers }
}

/**
 * Who has appeared for each side so far: at the plate, on base, on the mound
 * or in the field. A play under way counts once it holds a pitch or an action,
 * and somebody who came in once one finds them there: a lineup change alone
 * has put nobody in the game.
 */
export function appearedBySide(state: GameState): Record<Side, Set<number>> {
  const { allPlays, currentPlay } = state.liveData.plays
  const underWay = currentPlay?.playEvents.some(event => !isLineupEvent(event))
  const sides = { away: new Set<number>(), home: new Set<number>() }
  for (const play of underWay === true
    ? [...allPlays, currentPlay!]
    : allPlays) {
    const top = play.about.halfInning === 'top'
    const batting = sides[top ? 'away' : 'home']
    const fielding = sides[top ? 'home' : 'away']
    const waiting = new Map<number, Set<number>>()
    for (const event of play.playEvents) {
      if (!isLineupEvent(event)) {
        for (const [id, side] of waiting) side.add(id)
        waiting.clear()
        continue
      }
      const id = event.player.id
      if (event.replacedPlayer != null) waiting.delete(event.replacedPlayer.id)
      if (toBase(event)) waiting.set(id, batting)
      else if (
        POSITIONS.some(position => position === event.position) &&
        state.gameData.players[id]?.teamId ===
          state.gameData.teams[top ? 'home' : 'away'].id
      )
        waiting.set(id, fielding)
    }
    const { batters, pitchers } = facedIn(play)
    for (const id of batters) batting.add(id)
    for (const id of pitchers) fielding.add(id)
    // A closed play with no pitch in it, as an intentional walk, has its result.
    if (play !== currentPlay && batters.length === 0) {
      batting.add(play.matchup.batter.id)
      fielding.add(play.matchup.pitcher.id)
    }
    for (const runner of play.runners) batting.add(runner.details.runner.id)
    for (const id of play.appeared?.batting ?? []) batting.add(id)
    for (const id of play.appeared?.fielding ?? []) fielding.add(id)
    const began = play.lineups?.began[top ? 'home' : 'away'].defense
    for (const id of Object.values(began ?? {}))
      if (id != null) fielding.add(id)
  }
  // A play scored elsewhere may name nobody: its stand-in reads 0.
  sides.away.delete(0)
  sides.home.delete(0)
  return sides
}

/** Who has appeared in a game so far, for either side (`appearedBySide`). */
export function appearedIn(state: GameState): Set<number> {
  const { away, home } = appearedBySide(state)
  return new Set([...away, ...home])
}

/** Rebuild live options while preserving the placements of players still available. */
export function reconcileRoster(
  held: GameSetup,
  teams: Record<Side, GameTeam>,
  rosters: Record<Side, readonly ScoringRosterEntry[]>,
  guests: Record<Side, readonly ScoringRosterEntry[]>,
  unrostered: Unrostered,
  /** Who stays with the team they played for, fielded by it or not. */
  appeared: ReadonlySet<number> = new Set()
): GameSetup {
  const next = copyState(held)
  const contested = onBothSides(rosters, guests, unrostered)
  const fields = (side: Side, id: number): boolean =>
    fielded(rosters[side], guests[side], unrostered[side]).some(
      row => asGumboId(row.gumboId) === id
    )
  for (const side of ['away', 'home'] as const) {
    const other = side === 'away' ? 'home' : 'away'
    const rosterIds = new Set(
      rosters[side]
        .filter(row => row.isPlayer)
        .map(row => asGumboId(row.gumboId))
    )
    // Somebody already in the game stays with the team they played for. An
    // entry for a team that left them out, in a game they have not been in,
    // is only a saved setup, and gives way to the side fielding them now.
    const moves = (id: number): boolean =>
      next.players[id].teamId !== teams[side].id &&
      !appeared.has(id) &&
      !fields(other, id)
    const rows = fielded(rosters[side], guests[side], unrostered[side]).filter(
      row => {
        const id = asGumboId(row.gumboId)
        const prior = next.players[id]
        return prior == null
          ? !contested.has(id)
          : prior.teamId === teams[side].id || moves(id)
      }
    )
    const ids = [...new Set(rows.map(row => asGumboId(row.gumboId)))]
    const available = new Set(ids)
    for (const row of rows) {
      const id = asGumboId(row.gumboId)
      const prior = next.players[id]
      next.players[id] =
        prior == null || moves(id)
          ? {
              id,
              teamId: teams[side].id,
              fullName: row.shortName,
              ...(row.nameFormat == null ? {} : { nameFormat: row.nameFormat }),
              jersey: row.jersey ?? '',
              bats: row.bats ?? 'right',
              throws: row.throws,
              positions: [...row.positions],
              local: !rosterIds.has(id)
            }
          : { ...prior, local: !rosterIds.has(id) }
      if (!next.tagOrder.includes(id)) next.tagOrder.push(id)
    }
    const team = next.sides[side]
    team.players = [
      ...team.players.filter(id => available.has(id)),
      ...ids.filter(id => !team.players.includes(id))
    ]
    team.players = [...new Set(team.players)]
    const beforeDue = team.battingOrder
      .slice(0, team.battingIndex)
      .filter(id => available.has(id))
    // Account merges can make distinct historical turns share one identity.
    // Availability removes people; it must not collapse their saved placements.
    team.battingOrder = team.battingOrder.filter(id => available.has(id))
    team.battingIndex =
      team.battingOrder.length === 0
        ? 0
        : beforeDue.length % team.battingOrder.length
    for (const position of POSITIONS) {
      const id = team.defense[position]
      if (id == null || !available.has(id)) team.defense[position] = null
    }
  }
  return next
}
