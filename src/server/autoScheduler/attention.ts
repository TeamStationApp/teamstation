import type { Kysely } from 'kysely'

import { eventLocalRange, zoneName } from '../../common/eventTime'
import type { GameRequestTerms } from '../../common/gameApprovals'
import type { Database } from '../db/database'
import { adminRecipients } from '../groups/rights'
import { recordNotice } from '../venues/venueNotices'

/** Why a scheduler game stopped being scheduled. */
export type AttentionCause =
  'declined' | 'withdrawn' | 'replaced' | 'cancelled' | 'teamWithdrew'

const CAUSES: Record<AttentionCause, string> = {
  declined: 'was declined',
  withdrawn: 'was withdrawn',
  replaced: 'was cancelled',
  cancelled: 'was cancelled',
  teamWithdrew: 'was withdrawn'
}

interface AttentionGame {
  previewId: string
  gameId: string | null
  homeTeamId: string
  awayTeamId: string
  startAt: string
  endAt: string | null
  timezone: string | null
}

/**
 * Tells the league's admins that a game the Auto-Scheduler published needs
 * rescheduling. It is then listed under Needs rescheduling.
 */
async function notice(
  db: Kysely<Database>,
  game: AttentionGame,
  cause: AttentionCause,
  actorId: string | null
): Promise<void> {
  const preview = await db
    .selectFrom('schedule_previews')
    .select('league_id')
    .where('id', '=', game.previewId)
    .executeTakeFirst()
  if (preview == null) return
  const teams = new Map(
    (
      await db
        .selectFrom('teams')
        .select(['id', 'name'])
        .where('id', 'in', [game.homeTeamId, game.awayTeamId])
        .execute()
    ).map(team => [team.id, team.name])
  )
  await recordNotice(db, {
    type: 'scheduleNeedsAttention',
    actorId,
    recipients: await adminRecipients(db, [
      { kind: 'league', id: preview.league_id }
    ]),
    title: 'A scheduled game needs rescheduling',
    description: `${teams.get(game.awayTeamId) ?? 'Away'} at ${teams.get(game.homeTeamId) ?? 'Home'} ${CAUSES[cause]} (${eventLocalRange(game.startAt, game.endAt ?? undefined, game.timezone ?? 'UTC')} ${zoneName(game.startAt, game.timezone ?? 'UTC')}). Open the Auto-Scheduler to recalculate.`,
    // It opens the league's Auto-Scheduler, where the game is listed.
    metadata: { leagueId: preview.league_id, previewId: game.previewId }
  })
}

/** For a game row the Auto-Scheduler published; nothing for another game. */
export async function gameNeedsAttention(
  db: Kysely<Database>,
  gameId: string,
  cause: AttentionCause,
  actorId: string | null
): Promise<void> {
  const game = await db
    .selectFrom('games')
    .select([
      'id',
      'schedule_preview_id',
      'home_team_id',
      'away_team_id',
      'start_at',
      'end_at',
      'timezone'
    ])
    .where('id', '=', gameId)
    .executeTakeFirst()
  if (game?.schedule_preview_id == null) return
  await notice(
    db,
    {
      previewId: game.schedule_preview_id,
      gameId: game.id,
      homeTeamId: game.home_team_id,
      awayTeamId: game.away_team_id,
      startAt: game.start_at.toISOString(),
      endAt: game.end_at?.toISOString() ?? null,
      timezone: game.timezone
    },
    cause,
    actorId
  )
}

/**
 * For a scheduler proposal that won't become a game: declined, withdrawn or
 * expired before its game row exists. A change to a game already published
 * leaves the game as it was, so it needs nothing.
 */
export async function requestNeedsAttention(
  db: Kysely<Database>,
  request: { terms: unknown; game_id: string | null },
  cause: AttentionCause,
  actorId: string | null
): Promise<void> {
  const terms = request.terms as GameRequestTerms
  if (terms.schedulePreviewId == null) return
  await notice(
    db,
    {
      previewId: terms.schedulePreviewId,
      gameId: request.game_id ?? terms.gameId,
      homeTeamId: terms.game.homeTeamId,
      awayTeamId: terms.game.awayTeamId,
      startAt: terms.game.startAt,
      endAt: terms.game.endAt ?? null,
      timezone: terms.game.timezone ?? null
    },
    cause,
    actorId
  )
}
