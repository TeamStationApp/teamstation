import { createHash } from 'node:crypto'

import type { Kysely } from 'kysely'

import { scoringEntry } from '../../common/scoring/scoringEntry'
import { canSeeGame, explicitRoleTeams, visibleScopes } from '../access'
import { onePerson } from '../admin/people'
import type { Actor } from '../auth/sessions'
import { anyOf } from '../db/anyOf'
import type { Database } from '../db/database'
import { type Clock, realClock } from '../groups/requests'
import { recordedPlaysOf } from '../replay/replayable'

/** How far ahead a phone keeps games to score with no signal. */
export const OFFLINE_WINDOW_HOURS = 96
/** How long a game the phone holds stays held once it has started. */
export const HELD_STARTED_HOURS = 6
/** How many games a phone keeps to score with no signal, at most. */
export const OFFLINE_GAMES = 3
/** How many candidate games one read takes. */
const PAGE = 16
const HOUR_MS = 3_600_000

export interface OfflineGame {
  id: string
  startAt: string
  homeTeamId: string
  awayTeamId: string
  /** Whether the game has started: the phone holds it, nobody chose it now. */
  started: boolean
}

export interface OfflineManifest {
  games: OfflineGame[]
  /** When the choice next changes with no write, or null. */
  nextBoundary: string | null
  /** The choice's validator: its ids, starts and started flags. */
  digest: string
}

interface Candidate {
  id: string
  home_team_id: string
  away_team_id: string
  season_id: string | null
  start_at: Date
  status: string
  home_score: number | null
  away_score: number | null
  linescore: unknown
  scoringOwner: string | null
  currentPlay: unknown
}

/**
 * The games a phone keeps to score with no signal: the soonest three within
 * the next 96 hours, across every team, on whose either side this person was
 * given the scorekeeper role as such — on the team, its season or its league,
 * never through administering it. Each must be one they may see and score in
 * full; the limit counts only those. A game the phone already holds stays
 * while under six hours past its start, and comes first: a scorer who reaches
 * the field after the start keeps it. A started game is never newly chosen.
 */
export async function offlineScoringManifest(
  db: Kysely<Database>,
  actor: Actor,
  held: readonly string[] = [],
  clock: Clock = realClock
): Promise<OfflineManifest> {
  const now = clock.now()
  const teams = await explicitRoleTeams(
    db,
    (await onePerson(db, actor.userId)).userIds,
    'scorekeeper'
  )
  if (teams.size === 0) return answer([], null)
  const teamIds = [...teams]
  const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
  const columns = [
    'id',
    'home_team_id',
    'away_team_id',
    'season_id',
    'start_at',
    'status',
    'home_score',
    'away_score',
    'linescore',
    'scoringOwner',
    'currentPlay'
  ] as const
  const ofTeams = db
    .selectFrom('games')
    .select(columns)
    .where(eb =>
      eb.or([
        eb('home_team_id', '=', anyOf(teamIds)),
        eb('away_team_id', '=', anyOf(teamIds))
      ])
    )
    .where(eb =>
      eb.or([
        eb('cancellation_reason', 'is', null),
        eb('cancellation_reason', '!=', 'rescheduled')
      ])
    )
  /** The games of a page the phone may score, in its order. */
  const eligible = async (rows: Candidate[]): Promise<Candidate[]> => {
    const seen = rows.filter(row =>
      canSeeGame(scopes, {
        homeTeamId: row.home_team_id,
        awayTeamId: row.away_team_id,
        seasonId: row.season_id
      })
    )
    const recorded = await recordedPlaysOf(
      db,
      seen.map(row => ({ id: row.id, currentPlay: row.currentPlay }))
    )
    return seen.filter(
      row =>
        scoringEntry({
          status: row.status,
          scoringOwner: row.scoringOwner,
          replayable: recorded.has(row.id),
          linescore: row.linescore,
          homeScore: row.home_score,
          awayScore: row.away_score
        }) != null
    )
  }
  const chosen: Array<{ row: Candidate; started: boolean }> = []
  const heldIds = [...new Set(held)].slice(0, OFFLINE_GAMES)
  if (heldIds.length > 0) {
    const rows = (await ofTeams
      .where('id', '=', anyOf(heldIds))
      .where('start_at', '<=', now)
      .where(
        'start_at',
        '>',
        new Date(now.getTime() - HELD_STARTED_HOURS * HOUR_MS)
      )
      .where('status', 'not in', ['final', 'cancelled'])
      .orderBy('start_at')
      .orderBy('id')
      .execute()) as Candidate[]
    for (const row of await eligible(rows)) chosen.push({ row, started: true })
  }
  const until = new Date(now.getTime() + OFFLINE_WINDOW_HOURS * HOUR_MS)
  let after: { at: Date; id: string } | undefined
  for (;;) {
    let page = ofTeams
      .where('start_at', '>=', now)
      .where('start_at', '<', until)
      .where('status', 'not in', ['final', 'cancelled'])
      .where('away_score', 'is', null)
      .orderBy('start_at')
      .orderBy('id')
      .limit(PAGE)
    if (after != null) {
      const { at, id } = after
      page = page.where(eb =>
        eb.or([
          eb('start_at', '>', at),
          eb.and([eb('start_at', '=', at), eb('id', '>', id)])
        ])
      )
    }
    const rows = (await page.execute()) as Candidate[]
    for (const row of await eligible(rows)) {
      if (chosen.length === OFFLINE_GAMES) break
      chosen.push({ row, started: false })
    }
    if (chosen.length === OFFLINE_GAMES || rows.length < PAGE) break
    const last = rows.at(-1)!
    after = { at: last.start_at, id: last.id }
  }
  // A full choice changes only when one of its games leaves. Short of three,
  // the next game to enter is the first eligible one past the window.
  const entering =
    chosen.length < OFFLINE_GAMES ? await firstBeyond(until) : null
  const boundaries = [
    ...chosen.map(({ row, started }) =>
      started
        ? row.start_at.getTime() + HELD_STARTED_HOURS * HOUR_MS
        : row.start_at.getTime()
    ),
    ...(entering == null
      ? []
      : [entering.getTime() - OFFLINE_WINDOW_HOURS * HOUR_MS])
  ]
  const next =
    boundaries.length === 0 ? null : new Date(Math.min(...boundaries))
  return answer(
    chosen.map(({ row, started }) => ({
      id: row.id,
      startAt: row.start_at.toISOString(),
      homeTeamId: row.home_team_id,
      awayTeamId: row.away_team_id,
      started
    })),
    next
  )

  /** The start of the first eligible game at or after `from`, or null. */
  async function firstBeyond(from: Date): Promise<Date | null> {
    let cursor: { at: Date; id: string } | undefined
    for (;;) {
      let page = ofTeams
        .where('start_at', '>=', from)
        .where('status', 'not in', ['final', 'cancelled'])
        .where('away_score', 'is', null)
        .orderBy('start_at')
        .orderBy('id')
        .limit(PAGE)
      if (cursor != null) {
        const { at, id } = cursor
        page = page.where(eb =>
          eb.or([
            eb('start_at', '>', at),
            eb.and([eb('start_at', '=', at), eb('id', '>', id)])
          ])
        )
      }
      const rows = (await page.execute()) as Candidate[]
      const first = (await eligible(rows))[0]
      if (first != null) return first.start_at
      if (rows.length < PAGE) return null
      const last = rows.at(-1)!
      cursor = { at: last.start_at, id: last.id }
    }
  }
}

function answer(games: OfflineGame[], next: Date | null): OfflineManifest {
  const digest = createHash('sha256')
    .update(
      JSON.stringify(
        games.map(game => [
          game.id,
          game.startAt,
          game.started,
          game.homeTeamId,
          game.awayTeamId
        ])
      )
    )
    .digest('hex')
    .slice(0, 32)
  return {
    games,
    nextBoundary: next == null ? null : next.toISOString(),
    digest
  }
}
