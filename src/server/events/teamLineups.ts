import { createHash } from 'node:crypto'

import type { Kysely } from 'kysely'

import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import { recordOf } from '../../common/scoring/gumbo'
import {
  asDefaultLineup,
  type CourtesyRunner,
  type DefaultLineup,
  type DueBatter,
  type GameLineups,
  type LineupContext,
  lineupHistory,
  type LineupPerson,
  placeholderSidesOf,
  readLineups,
  sameArrangement,
  type SideLineups,
  type StoredLineupGame
} from '../../common/scoring/lineupHistory'
import type { Side } from '../../common/scoring/state'
import type { Database } from '../db/database'
import { fenceDistanceFor } from '../games/fenceDistance'
import { resolveGumboIds } from '../scoring/gumboIds'
import { resolveScoringGame } from '../scoring/openRow'
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
  }
): Promise<Record<Side, TeamSideLineups>> {
  const context = await lineupContext(db, game)
  const sides = lineupHistory(
    await resolveScoringGame(
      db,
      storedLineupGame(await readPlays(db, game.id), game.currentPlay)
    ),
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
 * has written yet keeps none, and its digest is worked out as a post would.
 */
export async function lineupsAnswer(
  db: Trx,
  game: {
    id: string
    home_team_id: string
    away_team_id: string
    currentPlay: unknown
    lineups_digest: string | null
  }
): Promise<Record<Side, TeamSideLineups> & { digest: string }> {
  const context = await lineupContext(db, game)
  const read = readLineups(
    await resolveScoringGame(
      db,
      storedLineupGame(await readPlays(db, game.id), game.currentPlay)
    ),
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
    digest:
      game.lineups_digest ??
      lineupsDigest(read.sides, read.bench, read.courtesy, read.due)
  }
}

/**
 * The digest a game keeps of its lineups, as `lineupsAnswer` gives it, without
 * the lineups themselves: worked out only for a game no live post has written.
 */
export async function storedLineupsDigest(
  db: Trx,
  game: {
    id: string
    home_team_id: string
    away_team_id: string
    currentPlay: unknown
    lineups_digest: string | null
  }
): Promise<string> {
  if (game.lineups_digest != null) return game.lineups_digest
  const read = readLineups(
    await resolveScoringGame(
      db,
      storedLineupGame(await readPlays(db, game.id), game.currentPlay)
    ),
    await lineupContext(db, game)
  )
  return lineupsDigest(read.sides, read.bench, read.courtesy, read.due)
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

/** A team's stored default, or none when it has none or it no longer reads. */
export function defaultOf(raw: unknown): DefaultLineup | null {
  if (raw == null) return null
  try {
    const cleaned = asDefaultLineup(raw)
    return cleaned.lineup == null ? null : cleaned
  } catch {
    return null
  }
}

/** Resolve stored default identities without modifying the historical lineup. */
export async function resolvedDefaultOf(
  db: Trx,
  raw: unknown
): Promise<DefaultLineup | null> {
  const kept = defaultOf(raw)
  if (kept?.lineup == null) return kept
  const people = [...kept.lineup.batters, ...Object.values(kept.lineup.defense)]
  const mapping = await resolveGumboIds(
    db,
    people.flatMap(person => (person?.gumboId == null ? [] : [person.gumboId]))
  )
  const resolve = (person: LineupPerson): LineupPerson => ({
    ...person,
    gumboId: person.gumboId == null ? null : mapping.get(person.gumboId)!
  })
  return {
    ...kept,
    lineup: {
      batters: kept.lineup.batters.map(resolve),
      defense: Object.fromEntries(
        Object.entries(kept.lineup.defense).map(([position, person]) => [
          position,
          person == null ? null : resolve(person)
        ])
      ) as typeof kept.lineup.defense
    }
  }
}

/**
 * What a live post leaves of the game's lineups, inside its transaction and
 * after its writes: the digest, and for a post from TeamStation the teams'
 * defaults. The first post after which the game has begun takes each side's
 * starting lineup as its team's default, unless the team's default is the
 * same arrangement already, and marks the game `lineup_started_at`. A side
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
  const read: GameLineups = readLineups(
    await resolveScoringGame(trx, stored),
    await lineupContext(trx, game)
  )
  const digest = lineupsDigest(read.sides, read.bench, read.courtesy, read.due)
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
  const placeholder = placeholderSides(stored)
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
    const kept = await resolvedDefaultOf(trx, row?.default_lineup)
    if (kept?.lineup != null && sameArrangement(kept.lineup, lineup)) continue
    const value: DefaultLineup = {
      lineup,
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
function placeholderSides(stored: StoredLineupGame): ReadonlySet<Side> {
  const reopened = stored.currentPlay?.about.atBatIndex
  const plays: Array<GumboPlay | CurrentPlay> = stored.plays.filter(
    play => play.about.atBatIndex !== reopened
  )
  if (stored.currentPlay != null) plays.push(stored.currentPlay)
  plays.sort((a, b) => a.about.atBatIndex - b.about.atBatIndex)
  return placeholderSidesOf(
    plays.flatMap(play => recordOf(play)?.actions ?? [])
  )
}
