import type { Kysely } from 'kysely'

import { conflict } from '../../common/errors'
import type { GameRequestTerms } from '../../common/gameApprovals'
import type {
  GameToReschedule,
  PublishedState,
  RescheduleReason
} from '../../common/schedulePreviews'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import {
  type Clock,
  requestStatus,
  type StoredRequest
} from '../groups/requests'
import { withdrawGameRequest } from '../schedule/gameApprovals'
import { cancelAsRescheduled, noticeTeams, type Tallies } from './cancel'

type Db = Kysely<Database>

interface RowFacts {
  preview_id: string
  game_key: string
  season_id: string
  home_team_id: string
  away_team_id: string
  request_id: string | null
  game_id: string | null
  rejected_at: Date | null
  resolved_at: Date | null
}

interface Linked {
  row: RowFacts
  request: StoredRequest | null
  game: {
    status: string
    cancellation_reason: string | null
    start_at: Date
    end_at: Date | null
    timezone: string | null
    exhibition: boolean
    field_id: string | null
  } | null
}

async function linked(db: Db, rows: RowFacts[]): Promise<Linked[]> {
  const requestIds = rows
    .map(row => row.request_id)
    .filter((id): id is string => id != null)
  const gameIds = rows
    .map(row => row.game_id)
    .filter((id): id is string => id != null)
  const requests =
    requestIds.length === 0
      ? []
      : await db
          .selectFrom('group_requests')
          .selectAll()
          .where('id', 'in', requestIds)
          .execute()
  const games =
    gameIds.length === 0
      ? []
      : await db
          .selectFrom('games')
          .select([
            'id',
            'status',
            'cancellation_reason',
            'start_at',
            'end_at',
            'timezone',
            'exhibition',
            'field_id'
          ])
          .where('id', 'in', gameIds)
          .execute()
  return rows.map(row => ({
    row,
    request: requests.find(request => request.id === row.request_id) ?? null,
    game: games.find(game => game.id === row.game_id) ?? null
  }))
}

/**
 * Why a published game needs rescheduling, or null while it stands: its
 * admin rejected it; its proposal was declined, withdrawn or not answered
 * in time; or the game was canceled, for any reason but the scheduler
 * placing it again.
 */
function reasonOf(item: Linked, clock: Clock): RescheduleReason | null {
  if (item.row.rejected_at != null) return 'rejected'
  if (item.game != null) {
    if (
      item.game.status === 'cancelled' &&
      item.game.cancellation_reason !== 'rescheduled'
    )
      return item.game.cancellation_reason === 'withdrawal'
        ? 'teamWithdrew'
        : 'cancelled'
    if (item.game.status !== 'cancelled') return null
  }
  if (item.request == null || item.game != null) return null
  const status = requestStatus(item.request, clock)
  return status === 'declined'
    ? 'declined'
    : status === 'cancelled'
      ? 'withdrawn'
      : status === 'expired'
        ? 'expired'
        : null
}

/** Where each published game of a preview stands. */
export async function publishedStates(
  db: Db,
  previewId: string,
  clock: Clock
): Promise<
  Array<{ gameKey: string; gameId: string | null; state: PublishedState }>
> {
  const rows = await db
    .selectFrom('schedule_preview_games')
    .selectAll()
    .where('preview_id', '=', previewId)
    .orderBy('game_key')
    .execute()
  return (await linked(db, rows)).map(item => {
    const reason = reasonOf(item, clock)
    const state: PublishedState =
      item.row.resolved_at != null ||
      item.game?.cancellation_reason === 'rescheduled'
        ? item.row.rejected_at != null
          ? 'rejected'
          : 'resolved'
        : reason === 'rejected'
          ? 'rejected'
          : reason != null
            ? 'needsRescheduling'
            : item.game != null
              ? 'scheduled'
              : 'awaiting'
    return { gameKey: item.row.game_key, gameId: item.row.game_id, state }
  })
}

/** The league's published games that need rescheduling, soonest first. */
export async function gamesToReschedule(
  db: Db,
  leagueId: string,
  clock: Clock
): Promise<GameToReschedule[]> {
  const rows = await db
    .selectFrom('schedule_preview_games')
    .innerJoin(
      'schedule_previews',
      'schedule_previews.id',
      'schedule_preview_games.preview_id'
    )
    .leftJoin('games', 'games.id', 'schedule_preview_games.game_id')
    .leftJoin(
      'group_requests',
      'group_requests.id',
      'schedule_preview_games.request_id'
    )
    .selectAll('schedule_preview_games')
    .where('schedule_previews.league_id', '=', leagueId)
    .where('schedule_previews.status', '=', 'published')
    .where('schedule_preview_games.resolved_at', 'is', null)
    // Only the rows that can need rescheduling (`reasonOf` has the last
    // word): rejected; a game canceled other than to be placed again; or a
    // proposal no longer waiting and never accepted.
    .where(eb =>
      eb.or([
        eb('schedule_preview_games.rejected_at', 'is not', null),
        eb.and([
          eb('games.status', '=', 'cancelled'),
          eb.or([
            eb('games.cancellation_reason', 'is', null),
            eb('games.cancellation_reason', '!=', 'rescheduled')
          ])
        ]),
        eb.and([
          eb('schedule_preview_games.game_id', 'is', null),
          eb('group_requests.status', '!=', 'accepted'),
          eb.or([
            eb('group_requests.status', '!=', 'pending'),
            eb('group_requests.expires_at', '<=', clock.now())
          ])
        ])
      ])
    )
    .execute()
  const listed = (await linked(db, rows))
    .map(item => ({ item, reason: reasonOf(item, clock) }))
    .filter(
      (entry): entry is { item: Linked; reason: RescheduleReason } =>
        entry.reason != null
    )
  if (listed.length === 0) return []
  const teamIds = [
    ...new Set(
      listed.flatMap(({ item }) => [
        item.row.home_team_id,
        item.row.away_team_id
      ])
    )
  ]
  const names = new Map(
    (
      await db
        .selectFrom('teams')
        .select(['id', 'name'])
        .where('id', 'in', teamIds)
        .execute()
    ).map(team => [team.id, team.name])
  )
  return listed
    .map(({ item, reason }) => {
      const terms = item.request?.terms as GameRequestTerms | undefined
      const startAt =
        item.game?.start_at.toISOString() ?? terms?.game.startAt ?? ''
      const endAt =
        item.game == null
          ? (terms?.game.endAt ?? null)
          : (item.game.end_at?.toISOString() ?? null)
      return {
        previewId: item.row.preview_id,
        gameKey: item.row.game_key,
        gameId: item.row.game_id,
        seasonId: item.row.season_id,
        homeTeamId: item.row.home_team_id,
        awayTeamId: item.row.away_team_id,
        homeTeamName: names.get(item.row.home_team_id) ?? '',
        awayTeamName: names.get(item.row.away_team_id) ?? '',
        startAt,
        endAt,
        exhibition: item.game?.exhibition ?? terms?.game.exhibition ?? false,
        fieldId: item.game?.field_id ?? terms?.game.fieldId ?? null,
        // The zone it was placed in: its field's, as it was proposed.
        timezone: item.game?.timezone ?? terms?.game.timezone ?? 'UTC',
        reason
      }
    })
    .sort((a, b) =>
      a.startAt === b.startAt
        ? a.gameKey.localeCompare(b.gameKey)
        : a.startAt.localeCompare(b.startAt)
    )
}

/**
 * Rejects games of a published preview: each is marked rejected and so
 * listed for rescheduling. A game on the schedules is taken off them, and
 * its teams' staff are told; a proposal still waiting is withdrawn. Only a
 * game scheduled or waiting can be rejected: one already replaced,
 * rejected or listed is refused.
 */
export async function rejectPublished(
  trx: Db,
  actor: Actor,
  preview: { id: string; league_id: string },
  gameKeys: string[],
  clock: Clock
): Promise<void> {
  if (gameKeys.length === 0) return
  const states = new Map(
    (await publishedStates(trx, preview.id, clock)).map(game => [
      game.gameKey,
      game.state
    ])
  )
  for (const key of gameKeys) {
    const state = states.get(key)
    if (state !== 'scheduled' && state !== 'awaiting')
      throw conflict(
        'Only a game on the schedules or waiting for approval can be rejected'
      )
  }
  const rows = await trx
    .updateTable('schedule_preview_games')
    .set({ rejected_at: clock.now() })
    .where('preview_id', '=', preview.id)
    .where('game_key', 'in', gameKeys)
    .where('rejected_at', 'is', null)
    .where('resolved_at', 'is', null)
    .returningAll()
    .execute()
  const tallies: Tallies = new Map()
  await cancelAsRescheduled(
    trx,
    rows.map(row => row.game_id).filter((id): id is string => id != null),
    clock,
    actor.userId,
    tallies
  )
  for (const row of rows)
    if (row.game_id == null && row.request_id != null) {
      const request = await trx
        .selectFrom('group_requests')
        .select('status')
        .where('id', '=', row.request_id)
        .executeTakeFirst()
      if (request?.status === 'pending')
        await withdrawGameRequest(trx, actor, row.request_id, clock)
    }
  await noticeTeams(trx, tallies, { actorId: actor.userId })
}
