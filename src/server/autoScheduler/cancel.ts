import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import type { Clock } from '../groups/requests'
import { schedulingRecipients } from '../groups/rights'
import { notifyGameChange } from '../socket/gameChanges'
import { noteGameFigures } from '../socket/syncRevision'
import { refreshFieldWarnings } from '../venues/fieldWarnings'
import { recordNotice } from '../venues/venueNotices'

/** What a publication did to one team's games. */
export interface TeamTally {
  scheduled: number
  awaiting: number
  removed: number
  /** The seasons the team's changed games are in. */
  seasonIds: Set<string>
}

export type Tallies = Map<string, TeamTally>

export function tally(
  tallies: Tallies,
  teamId: string,
  seasonId: string | null
): TeamTally {
  let found = tallies.get(teamId)
  if (found == null) {
    found = { scheduled: 0, awaiting: 0, removed: 0, seasonIds: new Set() }
    tallies.set(teamId, found)
  }
  if (seasonId != null) found.seasonIds.add(seasonId)
  return found
}

/**
 * Takes games off the schedules because the Auto-Scheduler is placing their
 * matchups again: cancels them as `'rescheduled'`, which nothing sets back
 * to scheduled, supersedes their pending proposals and changes, tells open
 * game screens, and looks at their fields' warnings again. Only scheduled
 * games are touched; each one removed is counted for both its teams.
 */
export async function cancelAsRescheduled(
  trx: Kysely<Database>,
  gameIds: string[],
  clock: Clock,
  actorId: string,
  tallies: Tallies
): Promise<string[]> {
  if (gameIds.length === 0) return []
  const cancelled = await trx
    .updateTable('games')
    .set({
      status: 'cancelled',
      cancellation_reason: 'rescheduled',
      updated_at: clock.now()
    })
    .where('id', 'in', gameIds)
    .where('status', '=', 'scheduled')
    .returning(['id', 'field_id', 'home_team_id', 'away_team_id', 'season_id'])
    .execute()
  if (cancelled.length === 0) return []
  const ids = cancelled.map(game => game.id)
  await trx
    .updateTable('group_requests')
    .set({
      status: 'superseded',
      resolved_at: clock.now(),
      resolved_by: actorId
    })
    .where('kind', 'in', ['game', 'gameChange'])
    .where('game_id', 'in', ids)
    .where('status', '=', 'pending')
    .execute()
  for (const game of cancelled) {
    tally(tallies, game.home_team_id, game.season_id).removed++
    tally(tallies, game.away_team_id, game.season_id).removed++
    await notifyGameChange(trx, { game: game.id, kind: 'game' })
    // Cancelled, it leaves its teams' records and its season's schedule.
    await noteGameFigures(trx, game.id)
  }
  await refreshFieldWarnings(
    trx,
    cancelled.map(game => game.field_id),
    clock,
    ids
  )
  return ids
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * Tells each team's staff, once, what a publication or a rejection did to
 * its games: how many were scheduled, how many wait for another team's
 * approval, and how many earlier games were removed. It opens the season's
 * schedule, or the team's when several seasons changed; the league's own
 * pages are its admins'.
 */
export async function noticeTeams(
  trx: Kysely<Database>,
  tallies: Tallies,
  context: { actorId: string }
): Promise<void> {
  if (tallies.size === 0) return
  const names = new Map(
    (
      await trx
        .selectFrom('teams')
        .select(['id', 'name'])
        .where('id', 'in', [...tallies.keys()])
        .execute()
    ).map(team => [team.id, team.name])
  )
  const seasonIds = [
    ...new Set([...tallies.values()].flatMap(counts => [...counts.seasonIds]))
  ]
  const seasons = new Map(
    seasonIds.length === 0
      ? []
      : (
          await trx
            .selectFrom('seasons')
            .select(['id', 'name'])
            .where('id', 'in', seasonIds)
            .execute()
        ).map(season => [season.id, season.name])
  )
  for (const [teamId, counts] of tallies) {
    const parts = [
      counts.scheduled > 0
        ? `${plural(counts.scheduled, 'game')} scheduled`
        : '',
      counts.awaiting > 0
        ? `${plural(counts.awaiting, 'game')} awaiting another team’s approval`
        : '',
      counts.removed > 0
        ? `${plural(counts.removed, 'earlier game')} removed`
        : ''
    ].filter(part => part !== '')
    if (parts.length === 0) continue
    const team = names.get(teamId) ?? 'your team'
    const only =
      counts.seasonIds.size === 1 ? [...counts.seasonIds][0] : undefined
    await recordNotice(trx, {
      type: 'schedulePublished',
      actorId: context.actorId,
      recipients: await schedulingRecipients(trx, [
        { kind: 'team', id: teamId }
      ]),
      title:
        only == null
          ? `Schedules updated for ${team}`
          : `${seasons.get(only) ?? 'Season'} schedule updated for ${team}`,
      description: `${parts.join(', ')}.`,
      metadata: { teamId, ...(only == null ? {} : { seasonId: only }) }
    })
  }
}
