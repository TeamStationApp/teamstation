import { type Kysely, sql } from 'kysely'

import type { SeasonResult, SeasonTeam } from '../../common/seasonStandings'
import type { Database } from '../db/database'

/**
 * Owned children, competition members and committed participants share one
 * read-only list. A team's `exhibition` flag is the one its season admin set.
 * A team's games are counted in one grouped read, so the list never reads the
 * season's game rows.
 */
export async function seasonParticipants(
  db: Kysely<Database>,
  seasonId: string
): Promise<{
  teams: Array<
    SeasonTeam & {
      activeMember: boolean
      parentMember: boolean
      /** Flagged as an exhibition team in this season. */
      exhibition: boolean
      seasonCategory: 'inSeason' | 'exhibition' | 'unscheduled'
      /** Plays a non-exhibition game here, cancelled or not. */
      playsInSeason: boolean
    }
  >
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
  const flagged = new Set(
    (
      await db
        .selectFrom('season_team_flags')
        .select('team_id')
        .where('season_id', '=', seasonId)
        .where('exhibition', '=', true)
        .execute()
    ).map(row => row.team_id)
  )
  const sides = await sql<{
    team_id: string
    scheduled: string | number
    in_season: boolean | null
    plays_in_season: boolean
  }>`
    select team_id,
           count(*) filter (where status <> 'cancelled') as scheduled,
           bool_or(not exhibition) filter (where status <> 'cancelled') as in_season,
           bool_or(not exhibition) as plays_in_season
    from (
      select home_team_id as team_id, status, exhibition from games where season_id = ${seasonId}
      union all
      select away_team_id, status, exhibition from games where season_id = ${seasonId}
    ) sides
    group by team_id
  `.execute(db)
  const played = new Map(sides.rows.map(row => [row.team_id, row]))
  const ids = [
    ...new Set([
      ...membership.map(row => row.team_id),
      ...parents.map(row => row.team_id),
      ...played.keys()
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
    teams: teams.map(team => {
      const games = played.get(team.id)
      return {
        ...team,
        activeMember: membership.some(row => row.team_id === team.id),
        parentMember: parents.some(row => row.team_id === team.id),
        exhibition: flagged.has(team.id),
        // A flagged team is listed with the exhibition teams whatever its
        // games.
        seasonCategory: flagged.has(team.id)
          ? 'exhibition'
          : games?.in_season === true
            ? 'inSeason'
            : Number(games?.scheduled ?? 0) > 0
              ? 'exhibition'
              : 'unscheduled',
        playsInSeason: games?.plays_in_season === true
      }
    })
  }
}

/**
 * The season's games standings count: final, with both scores, oldest first.
 */
export async function seasonResults(
  db: Kysely<Database>,
  seasonId: string
): Promise<SeasonResult[]> {
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
    .where('status', '=', 'final')
    .where('home_score', 'is not', null)
    .where('away_score', 'is not', null)
    .orderBy('start_at')
    .orderBy('id')
    .execute()
  return games.map(game => ({ ...game, startAt: game.startAt.toISOString() }))
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
