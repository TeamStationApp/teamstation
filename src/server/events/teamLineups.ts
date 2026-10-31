import { createHash } from 'node:crypto'

import type { Kysely } from 'kysely'

import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import { recordOf } from '../../common/scoring/gumbo'
import {
  asStoredDefaultLineup,
  type CourtesyRunner,
  type DefaultLineup,
  type DueBatter,
  type GameLineups,
  type Lineup,
  type LineupContext,
  lineupHistory,
  type LineupPerson,
  placeholderSidesOf,
  readLineups,
  sameArrangement,
  type SideLineups,
  type StoredDefaultLineup,
  type StoredLineup,
  type StoredLineupGame,
  type StoredLineupPerson
} from '../../common/scoring/lineupHistory'
import type { Position, Side } from '../../common/scoring/state'
import type { SideTeams } from '../../common/scoring/teamRecord'
import { teamsOfRow } from '../../common/teamLists'
import type { Database } from '../db/database'
import { fenceDistanceFor } from '../games/fenceDistance'
import { resolveGumboIds } from '../scoring/gumboIds'
import { namesMergedAccounts, resolveScoringGame } from '../scoring/openRow'
import { teamNames } from '../users/nameBook'
import { atBatOf } from './atBatInProgress'
import { readPlays } from './postPlays'

type Trx = Kysely<Database>

/** A game's teams, as the replay names them. */
export async function lineupContext(
  db: Trx,
  game: { id: string; home_team_id: string; away_team_id: string }
): Promise<LineupContext> {
  const rows = await db
    .selectFrom('teams')
    .select(['id', 'name'])
    .where('id', 'in', [game.home_team_id, game.away_team_id])
    .execute()
  const nameOf = (id: string): string =>
    rows.find(row => row.id === id)?.name ?? ''
  return {
    gamePk: game.id,
    teams: {
      away: { id: game.away_team_id, name: nameOf(game.away_team_id) },
      home: { id: game.home_team_id, name: nameOf(game.home_team_id) }
    },
    fenceDistanceFt: await fenceDistanceFor(db, game.id)
  }
}

/** One side's lineups in a game, with the team they belong to. */
export type TeamSideLineups = SideLineups & { teamId: string; teamName: string }

/**
 * Both sides' lineups in a game as they stand now, as
 * `GET /games/:gameId/lineups` answers and the game socket sends them.
 */
export async function gameLineups(
  db: Trx,
  game: {
    id: string
    home_team_id: string
    away_team_id: string
    currentPlay: unknown
    pregame?: unknown
  }
): Promise<Record<Side, TeamSideLineups>> {
  const context = await lineupContext(db, game)
  const sides = lineupHistory(
    await resolveScoringGame(db, await storedOrPregame(db, game), {
      gameId: game.id
    }),
    context
  )
  return {
    away: {
      teamId: context.teams.away.id,
      teamName: context.teams.away.name,
      ...sides.away
    },
    home: {
      teamId: context.teams.home.id,
      teamName: context.teams.home.name,
      ...sides.home
    }
  }
}

/**
 * Both sides' lineups, as `gameLineups` reads them, with the digest the game
 * keeps of them (`lineups_digest`): what `GET /games/:gameId/lineups`
 * answers and the game socket sends. A screen keeps the digest it last read
 * or saved, to tell its own save from somebody else's. A game no live post
 * has written yet keeps none, and its digest is worked out from its stored
 * form (`storedFormDigest`), so a rename leaves it as it was.
 */
export async function lineupsAnswer(
  db: Trx,
  game: {
    id: string
    home_team_id: string
    away_team_id: string
    currentPlay: unknown
    pregame?: unknown
    lineups_digest: string | null
    play_generation: number
  }
): Promise<
  Record<Side, TeamSideLineups> & { digest: string; generation: number }
> {
  const context = await lineupContext(db, game)
  const stored = await storedOrPregame(db, game)
  const read = readLineups(
    await resolveScoringGame(db, stored, { gameId: game.id }),
    context
  )
  const sides = {
    away: {
      teamId: context.teams.away.id,
      teamName: context.teams.away.name,
      ...read.sides.away
    },
    home: {
      teamId: context.teams.home.id,
      teamName: context.teams.home.name,
      ...read.sides.home
    }
  }
  return {
    ...sides,
    digest: game.lineups_digest ?? digestOf(readLineups(stored, context)),
    generation: game.play_generation
  }
}

/**
 * The digest a game keeps of its lineups, as `lineupsAnswer` gives it, without
 * the lineups themselves: worked out only for a game no live post has written
 * (`storedFormDigest`).
 */
export async function storedLineupsDigest(
  db: Trx,
  game: {
    id: string
    home_team_id: string
    away_team_id: string
    currentPlay: unknown
    pregame?: unknown
    lineups_digest: string | null
  }
): Promise<string> {
  if (game.lineups_digest != null) return game.lineups_digest
  return await storedFormDigest(db, game)
}

/**
 * The digest of a game's lineups read from their stored form, not named
 * from `users`: each person by id, jersey and position, and by name only
 * one with no id (a placeholder the team named at the field). The one form
 * of a game's lineups digest: what a game that keeps no `lineups_digest`
 * answers and what every live post keeps (`keepLineups`), so a rename or a
 * guest's correction leaves it alone, and a post built on it is not
 * refused as stale.
 */
export async function storedFormDigest(
  db: Trx,
  game: Parameters<typeof lineupContext>[1] & {
    currentPlay: unknown
    pregame?: unknown
  }
): Promise<string> {
  return digestOf(
    readLineups(await storedOrPregame(db, game), await lineupContext(db, game))
  )
}

/** `lineupsDigest` of everything a read of the lineups counts. */
function digestOf(read: GameLineups): string {
  return lineupsDigest(read.sides, read.bench, read.courtesy, read.due)
}

/**
 * A new digest for a game whose lineups changed with no roster action left
 * to write one (it has no record yet): the stored digest, salted with what
 * changed, so a scorer's earlier view is refused as stale.
 */
export async function changedLineupsDigest(
  db: Trx,
  game: Parameters<typeof storedLineupsDigest>[1],
  ...changed: unknown[]
): Promise<string> {
  return createHash('sha256')
    .update(JSON.stringify([await storedLineupsDigest(db, game), ...changed]))
    .digest('hex')
}

/**
 * A game's plays and at-bat in progress as the lineups read them: before the
 * first pitch, its pregame lineups (`atBatOf`).
 */
async function storedOrPregame(
  db: Trx,
  game: { id: string; currentPlay: unknown; pregame?: unknown }
): Promise<StoredLineupGame> {
  const plays = await readPlays(db, game.id)
  return storedLineupGame(
    plays,
    atBatOf(
      { currentPlay: game.currentPlay, pregame: game.pregame ?? null },
      plays.length > 0
    )
  )
}

/** A game's stored plays and current play, as the lineups are read from. */
export function storedLineupGame(
  plays: Array<{ gumbo: unknown }>,
  currentPlay: unknown
): StoredLineupGame {
  return {
    plays: plays.map(play => play.gumbo as GumboPlay),
    currentPlay: (currentPlay ?? null) as CurrentPlay | null
  }
}

/**
 * A sha256 of both sides' current lineups, their changes, anyone on the
 * roster who is in neither the order nor the field, any pinch runner who
 * keeps the order, and who is due up when the order alone does not say so.
 * It changes when a reader of the lineups sees a different lineup, when
 * someone off the card is added, removed, or edited, when such a runner is
 * recorded, and when the batter due changes without any of those. An empty
 * bench is left out, and so is an empty list of those runners, and so is
 * no such batter, so a game with none of them keeps the digest it had
 * before they were counted.
 */
export function lineupsDigest(
  sides: Record<Side, SideLineups>,
  bench: Record<Side, LineupPerson[]> = { away: [], home: [] },
  courtesy: CourtesyRunner[] = [],
  due: DueBatter | null = null
): string {
  const seen = (
    side: Side
  ): {
    current: SideLineups['current']
    changes: SideLineups['changes']
    bench?: LineupPerson[]
  } => {
    const row = {
      current: sides[side].current,
      changes: sides[side].changes
    }
    return bench[side].length === 0 ? row : { ...row, bench: bench[side] }
  }
  const body: {
    away: ReturnType<typeof seen>
    home: ReturnType<typeof seen>
    courtesy?: CourtesyRunner[]
    due?: DueBatter
  } = { away: seen('away'), home: seen('home') }
  if (courtesy.length > 0) body.courtesy = courtesy
  if (due != null) body.due = due
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

/**
 * A team's stored default, or none when it has none or it no longer reads.
 * Its people are as stored: a player with an id may have no name.
 */
export function defaultOf(raw: unknown): StoredDefaultLineup | null {
  if (raw == null) return null
  try {
    const cleaned = asStoredDefaultLineup(raw)
    return cleaned.lineup == null ? null : cleaned
  } catch {
    return null
  }
}

/** Each person of a stored lineup, through `turn`. */
function mapLineup<From, To>(
  lineup: {
    batters: From[]
    defense: Record<Position, From | null>
  },
  turn: (person: From) => To
): { batters: To[]; defense: Record<Position, To | null> } {
  return {
    batters: lineup.batters.map(turn),
    defense: Object.fromEntries(
      Object.entries(lineup.defense).map(([position, person]) => [
        position,
        person == null ? null : turn(person)
      ])
    ) as Record<Position, To | null>
  }
}

/**
 * A team's stored default, read: merged ids resolved to their survivors
 * (the stored row is left as it is), and each player with an id named from
 * `users`, by the short names of the team's roster (`teamNames`). A
 * placeholder keeps the name the team typed.
 */
export async function resolvedDefaultOf(
  db: Trx,
  teamId: string,
  raw: unknown
): Promise<DefaultLineup | null> {
  const kept = defaultOf(raw)
  if (kept?.lineup == null) return null
  const people = [...kept.lineup.batters, ...Object.values(kept.lineup.defense)]
  const mapping = await resolveGumboIds(
    db,
    people.flatMap(person => (person?.gumboId == null ? [] : [person.gumboId]))
  )
  const nameOf = await teamNames(db, teamId, mapping.values())
  const resolve = (person: StoredLineupPerson): LineupPerson => {
    if (person.gumboId == null)
      return { gumboId: null, name: person.name ?? '', jersey: person.jersey }
    const gumboId = mapping.get(person.gumboId)!
    return { gumboId, name: nameOf(gumboId) ?? '', jersey: person.jersey }
  }
  return { ...kept, lineup: mapLineup(kept.lineup, resolve) }
}

/**
 * A lineup as a team's default stores it: each player with an id by his id
 * and jersey, a placeholder with the name the team typed.
 */
export function storedLineupOf(lineup: Lineup): StoredLineup {
  return mapLineup(lineup, (person): StoredLineupPerson =>
    person.gumboId == null
      ? { gumboId: null, name: person.name, jersey: person.jersey }
      : { gumboId: person.gumboId, jersey: person.jersey }
  )
}

/**
 * What a live post leaves of the game's lineups, inside its transaction and
 * after its writes: the digest, of their stored form as `storedFormDigest`
 * works it out (so a rename or a guest's correction never moves it), and
 * for a post from TeamStation the teams' defaults. The first post after which the game has begun takes each side's
 * starting lineup as its team's default, unless the team's default is the
 * same arrangement already, and marks the game `lineup_started_at`. The
 * default keeps each player's id and jersey and no name (`storedLineupOf`).
 * A side
 * whose starting lineup is still the roster order a save left because the
 * saver could not see that team keeps the default it already has. A later
 * roster save takes that side only when it confirms the side and the
 * arrangement is no longer that order. A post that undoes the game back to
 * before it began clears the mark, so the lineup it
 * begins with next is taken instead. Nothing else changes a default. A
 * record that no longer replays leaves everything as it is and logs one
 * warning naming the game.
 */
export async function keepLineups(
  trx: Trx,
  game: {
    id: string
    home_team_id: string
    away_team_id: string
    lineup_started_at: Date | null
  },
  stored: StoredLineupGame,
  fromTeamStation: boolean,
  now: Date
): Promise<{ lineups_digest: string; lineup_started_at?: Date | null }> {
  const context = await lineupContext(trx, game)
  const storedForm = readLineups(stored, context)
  const digest = digestOf(storedForm)
  // A game whose lineups are kept already asks of this read only whether it
  // replays and whether it has begun. A name decides neither, so unless an id
  // is resolved the stored form's replay answers both, and a post in a long
  // game does not pay for the same replay twice.
  const read: GameLineups =
    game.lineup_started_at != null && !(await namesMergedAccounts(trx, stored))
      ? storedForm
      : readLineups(
          await resolveScoringGame(trx, stored, { gameId: game.id }),
          context
        )
  if (read.problem != null) {
    console.warn(
      `game ${game.id}: its lineups could not be read, so its teams' default lineups are left as they are: ${read.problem}`
    )
    return { lineups_digest: digest }
  }
  if (!fromTeamStation) return { lineups_digest: digest }
  if (read.begun === false && game.lineup_started_at != null)
    return { lineups_digest: digest, lineup_started_at: null }
  const away = read.sides.away.start
  const home = read.sides.home.start
  if (game.lineup_started_at != null || away == null || home == null)
    return { lineups_digest: digest }
  const placeholder = placeholderSides(stored, teamsOfRow(game))
  for (const [teamId, lineup, side] of [
    [game.away_team_id, away, 'away'],
    [game.home_team_id, home, 'home']
  ] as const) {
    if (placeholder.has(side)) continue
    const row = await trx
      .selectFrom('teams')
      .select('default_lineup')
      .where('id', '=', teamId)
      .forUpdate()
      .executeTakeFirst()
    const kept = await resolvedDefaultOf(trx, teamId, row?.default_lineup)
    if (kept?.lineup != null && sameArrangement(kept.lineup, lineup)) continue
    const value: StoredDefaultLineup = {
      lineup: storedLineupOf(lineup),
      fromGameId: game.id,
      setAt: now.toISOString()
    }
    await trx
      .updateTable('teams')
      .set({ default_lineup: value })
      .where('id', '=', teamId)
      .execute()
  }
  return { lineups_digest: digest, lineup_started_at: now }
}

/**
 * Sides whose starting lineup is still the roster order a save wrote because
 * the saver could not see that team. See `placeholderSidesOf`.
 */
function placeholderSides(
  stored: StoredLineupGame,
  teams: SideTeams
): ReadonlySet<Side> {
  const reopened = stored.currentPlay?.about.atBatIndex
  const plays: Array<GumboPlay | CurrentPlay> = stored.plays.filter(
    play => play.about.atBatIndex !== reopened
  )
  if (stored.currentPlay != null) plays.push(stored.currentPlay)
  plays.sort((a, b) => a.about.atBatIndex - b.about.atBatIndex)
  return placeholderSidesOf(
    plays.flatMap(play => recordOf(play, teams)?.actions ?? [])
  )
}
