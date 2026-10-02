import { createHash } from 'node:crypto'

import type { Kysely } from 'kysely'

import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import {
  asDefaultLineup,
  type DefaultLineup,
  type GameLineups,
  type LineupContext,
  lineupHistory,
  readLineups,
  sameArrangement,
  type SideLineups,
  type StoredLineupGame
} from '../../common/scoring/lineupHistory'
import type { Side } from '../../common/scoring/state'
import type { Database } from '../db/database'
import { fenceDistanceFor } from '../games/fenceDistance'
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
    storedLineupGame(await readPlays(db, game.id), game.currentPlay),
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
 * A sha256 of both sides' current lineups and changes, which changes exactly
 * when what a reader of the lineups sees changes.
 */
export function lineupsDigest(sides: Record<Side, SideLineups>): string {
  const seen = {
    away: { current: sides.away.current, changes: sides.away.changes },
    home: { current: sides.home.current, changes: sides.home.changes }
  }
  return createHash('sha256').update(JSON.stringify(seen)).digest('hex')
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

/**
 * What a live post leaves of the game's lineups, inside its transaction and
 * after its writes: the digest, and for a post from TeamStation the teams'
 * defaults. The first post after which the game has begun takes each side's
 * starting lineup as its team's default, unless the team's default is the
 * same arrangement already, and marks the game `lineup_started_at`. A post
 * that undoes the game back to before it began clears the mark, so the
 * lineup it begins with next is taken instead. Nothing else changes a
 * default. A record that no longer replays leaves everything as it is and
 * logs one warning naming the game.
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
  const read: GameLineups = readLineups(stored, await lineupContext(trx, game))
  const digest = lineupsDigest(read.sides)
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
  for (const [teamId, lineup] of [
    [game.away_team_id, away],
    [game.home_team_id, home]
  ] as const) {
    const row = await trx
      .selectFrom('teams')
      .select('default_lineup')
      .where('id', '=', teamId)
      .forUpdate()
      .executeTakeFirst()
    const kept = defaultOf(row?.default_lineup)
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
