import type { Kysely } from 'kysely'

import type { PlannedGame } from '../../common/autoScheduler/types'
import { unavailable } from '../../common/errors'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import type { Clock } from '../groups/requests'
import { proposeGame } from '../schedule/gameApprovals'
import { type Tallies, tally } from './cancel'
import type { Snapshot } from './snapshot'

/**
 * Proposes a preview's games, each as its season, through the same approval
 * rules as any game: the rules decide whether it is on the schedule at once
 * or waits for a team's approval. Each game proposed gets its
 * `schedule_preview_games` row; a game that already has one was proposed
 * before and is skipped, so a retry makes no duplicates.
 */
export async function proposePlanned(
  trx: Kysely<Database>,
  actor: Actor,
  previewId: string,
  snap: Snapshot,
  games: PlannedGame[],
  clock: Clock,
  tallies: Tallies
): Promise<void> {
  if (games.length === 0) return
  // The same gate as the game proposal routes.
  const ready = await trx
    .selectFrom('system_settings')
    .select('value')
    .where('key', '=', 'creation.hierarchyReady')
    .executeTakeFirst()
  if (ready?.value !== true)
    throw unavailable(
      'A node administrator must finish organization setup before scheduling approved games'
    )
  const done = new Set(
    (
      await trx
        .selectFrom('schedule_preview_games')
        .select('game_key')
        .where('preview_id', '=', previewId)
        .execute()
    ).map(row => row.game_key)
  )
  for (const game of games) {
    if (done.has(game.key)) continue
    const timezone =
      snap.seasons.find(season => season.id === game.seasonId)?.timezone ??
      'UTC'
    const request = await proposeGame(
      trx,
      actor,
      {
        sender: { kind: 'season', id: game.seasonId },
        game: {
          homeTeamId: game.homeTeamId,
          awayTeamId: game.awayTeamId,
          seasonId: game.seasonId,
          startAt: game.startAt,
          endAt: game.endAt,
          timezone,
          venue: null,
          outsideTournament: null,
          status: 'scheduled',
          exhibition: game.exhibition,
          fieldId: game.fieldId,
          fieldSize: game.size
        },
        idempotencyKey: `schedule:${previewId}:${game.key}`
      },
      clock,
      undefined,
      { schedulePreviewId: previewId }
    )
    const published = request.status === 'accepted'
    await trx
      .insertInto('schedule_preview_games')
      .values({
        preview_id: previewId,
        game_key: game.key,
        season_id: game.seasonId,
        home_team_id: game.homeTeamId,
        away_team_id: game.awayTeamId,
        request_id: request.id,
        game_id: published ? request.game_id : null
      })
      .execute()
    for (const teamId of [game.homeTeamId, game.awayTeamId])
      if (published) tally(tallies, teamId, game.seasonId).scheduled++
      else tally(tallies, teamId, game.seasonId).awaiting++
  }
}
