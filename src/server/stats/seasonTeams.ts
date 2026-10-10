import type { Kysely } from 'kysely'

import type { SeasonResult, SeasonTeam } from '../../common/seasonStandings'
import type { Database } from '../db/database'

/** Owned children, competition members and committed participants share one read-only list. */
export async function seasonParticipants(
  db: Kysely<Database>,
  seasonId: string
): Promise<{
  teams: Array<
    SeasonTeam & {
      activeMember: boolean
      parentMember: boolean
      seasonCategory: 'inSeason' | 'exhibition' | 'unscheduled'
    }
  >
  games: SeasonResult[]
}> {
  const membership = await db
    .selectFrom('season_teams')
    .select('team_id')
    .where('season_id', '=', seasonId)
    .where('active', '=', true)
    .execute()
  const parents = await db
    .selectFrom('season_team_parents')
    .select('team_id')
    .where('season_id', '=', seasonId)
    .execute()
  const games = await db
    .selectFrom('games')
    .select([
      'id',
      'home_team_id as homeTeamId',
      'away_team_id as awayTeamId',
      'start_at as startAt',
      'status',
      'home_score as homeScore',
      'away_score as awayScore',
      'exhibition'
    ])
    .where('season_id', '=', seasonId)
    .execute()
  const ids = [
    ...new Set([
      ...membership.map(row => row.team_id),
      ...parents.map(row => row.team_id),
      ...games.flatMap(game => [game.homeTeamId, game.awayTeamId])
    ])
  ]
  const teams =
    ids.length === 0
      ? []
      : await db
          .selectFrom('teams')
          .select([
            'id',
            'name',
            'kind',
            'logo_path as logoPath',
            'short_name as shortName'
          ])
          .where('id', 'in', ids)
          .where('merged_into', 'is', null)
          .orderBy('name')
          .orderBy('id')
          .execute()
  return {
    games: games.map(game => ({
      ...game,
      startAt: game.startAt.toISOString()
    })),
    teams: teams.map(team => {
      const scheduled = games.filter(
        game =>
          game.status !== 'cancelled' &&
          (game.homeTeamId === team.id || game.awayTeamId === team.id)
      )
      return {
        ...team,
        activeMember: membership.some(row => row.team_id === team.id),
        parentMember: parents.some(row => row.team_id === team.id),
        seasonCategory: scheduled.some(game => !game.exhibition)
          ? 'inSeason'
          : scheduled.length > 0
            ? 'exhibition'
            : 'unscheduled'
      }
    })
  }
}

/** Batched card counts use the same canonical identity union as the team collection. */
export async function seasonParticipantCounts(
  db: Kysely<Database>,
  seasonIds: string[]
): Promise<Map<string, number>> {
  if (seasonIds.length === 0) return new Map()
  const participants = db
    .selectFrom('season_teams')
    .select(['season_id as seasonId', 'team_id as teamId'])
    .where('active', '=', true)
    .where('season_id', 'in', seasonIds)
    .union(
      db
        .selectFrom('season_team_parents')
        .select(['season_id as seasonId', 'team_id as teamId'])
        .where('season_id', 'in', seasonIds)
    )
    .union(
      db
        .selectFrom('games')
        .select(['season_id as seasonId', 'home_team_id as teamId'])
        .where('season_id', 'in', seasonIds)
        .$narrowType<{ seasonId: string }>()
    )
    .union(
      db
        .selectFrom('games')
        .select(['season_id as seasonId', 'away_team_id as teamId'])
        .where('season_id', 'in', seasonIds)
        .$narrowType<{ seasonId: string }>()
    )
  const rows = await db
    .selectFrom(participants.as('participants'))
    .innerJoin('teams', 'teams.id', 'participants.teamId')
    .select('participants.seasonId')
    .select(eb => eb.fn.countAll().as('teams'))
    .where('teams.merged_into', 'is', null)
    .groupBy('participants.seasonId')
    .execute()
  return new Map(
    rows
      .filter(
        (row): row is typeof row & { seasonId: string } => row.seasonId != null
      )
      .map(row => [row.seasonId, Number(row.teams)])
  )
}
