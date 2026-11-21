import type { Insertable, Kysely } from 'kysely'

import type { PlannedGame } from '../../common/autoScheduler/types'
import { unavailable } from '../../common/errors'
import type { GameProposal } from '../../common/gameApprovals'
import type { Actor } from '../auth/sessions'
import type { Database, SchedulePreviewGamesTable } from '../db/database'
import { runsOf } from '../db/runs'
import type { Clock, StoredRequest } from '../groups/requests'
import { proposeGame, proposeGames } from '../schedule/gameApprovals'
import { type Tallies, tally } from './cancel'
import type { Snapshot } from './snapshot'

/** How `proposePlanned` proposes a preview's games. */
export interface ProposeOptions {
  /**
   * Each game through `proposeGame`, one after another, rather than all of
   * them through `proposeGames`: the same outcome in many more statements.
   * The batched path is tested against it.
   */
  oneByOne?: boolean
}

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
  tallies: Tallies,
  options: ProposeOptions = {}
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
  const proposing = games.filter(game => !done.has(game.key))
  const bodies = proposing.map(game => proposalOf(previewId, snap, game))
  const context = { schedulePreviewId: previewId }
  const rows = (
    game: PlannedGame,
    request: StoredRequest
  ): Insertable<SchedulePreviewGamesTable> => ({
    preview_id: previewId,
    game_key: game.key,
    season_id: game.seasonId,
    home_team_id: game.homeTeamId,
    away_team_id: game.awayTeamId,
    request_id: request.id,
    game_id: request.status === 'accepted' ? request.game_id : null
  })
  const requests: StoredRequest[] = []
  if (options.oneByOne === true)
    for (const [i, game] of proposing.entries()) {
      const request = await proposeGame(
        trx,
        actor,
        bodies[i],
        clock,
        undefined,
        context
      )
      await trx
        .insertInto('schedule_preview_games')
        .values(rows(game, request))
        .execute()
      requests.push(request)
    }
  else {
    requests.push(...(await proposeGames(trx, actor, bodies, clock, context)))
    for (const run of runsOf(
      proposing.map((game, i) => rows(game, requests[i]))
    ))
      await trx.insertInto('schedule_preview_games').values(run).execute()
  }
  for (const [i, game] of proposing.entries())
    for (const teamId of [game.homeTeamId, game.awayTeamId])
      if (requests[i].status === 'accepted')
        tally(tallies, teamId, game.seasonId).scheduled++
      else tally(tallies, teamId, game.seasonId).awaiting++
}

/** A planned game's proposal, from its season, under its own key. */
function proposalOf(
  previewId: string,
  snap: Snapshot,
  game: PlannedGame
): GameProposal {
  // A game is shown in its field's zone, the zone it was placed in.
  const timezone =
    snap.engine.fields.find(field => field.id === game.fieldId)?.availability
      .timezone ?? 'UTC'
  return {
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
  }
}
