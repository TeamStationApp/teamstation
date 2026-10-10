import { type Kysely, sql } from 'kysely'

import type { Database } from '../db/database'

/**
 * A team's record in one season, read from the games themselves.
 *
 * Only a finished game with both scores counts: a scheduled or abandoned one
 * has no result to record. Nothing is stored, so a game that becomes final, a
 * score that is corrected, a game moved between seasons and a team merge all
 * show on the next read, and no script has to be run to catch up.
 */
export interface TeamRecord {
  teamId: string
  seasonId: string | null
  w: number
  l: number
  t: number
  runsFor: number
  runsAgainst: number
}

export interface TeamRecordFilter {
  /** Only these teams. An empty list is nobody. */
  teamIds?: string[]
  /** Omitted keeps the historical inclusion of exhibitions. */
  includeExhibitions?: boolean
  /** One season, or `null` for games with no season. Absent is every season. */
  seasonId?: string | null
}

/** One row per team per season that has played at least one finished game. */
export async function teamRecords(
  db: Kysely<Database>,
  filter: TeamRecordFilter = {}
): Promise<TeamRecord[]> {
  const { teamIds, seasonId } = filter
  const exhibitionClause =
    filter.includeExhibitions === false ? sql`and exhibition = false` : sql``
  if (teamIds?.length === 0) return []

  const seasonClause =
    seasonId === undefined
      ? sql``
      : seasonId === null
        ? sql`and season_id is null`
        : sql`and season_id = ${seasonId}`

  // Each finished game seen from both sides, so a team's runs for and against
  // are its own score and the other's, whichever side it was on.
  const sides = sql`
    select home_team_id as team_id, season_id,
           home_score as runs_for, away_score as runs_against
    from games
    where status = 'final' and home_score is not null and away_score is not null
      ${seasonClause} ${exhibitionClause}
    union all
    select away_team_id as team_id, season_id,
           away_score as runs_for, home_score as runs_against
    from games
    where status = 'final' and home_score is not null and away_score is not null
      ${seasonClause} ${exhibitionClause}
  `
  const teamClause =
    teamIds == null ? sql`` : sql`where team_id in (${sql.join(teamIds)})`

  const result = await sql<{
    teamId: string
    seasonId: string | null
    w: string | number
    l: string | number
    t: string | number
    runsFor: string | number
    runsAgainst: string | number
  }>`
    select team_id as "teamId",
           season_id as "seasonId",
           count(*) filter (where runs_for > runs_against) as w,
           count(*) filter (where runs_for < runs_against) as l,
           count(*) filter (where runs_for = runs_against) as t,
           sum(runs_for) as "runsFor",
           sum(runs_against) as "runsAgainst"
    from (${sides}) as sides
    ${teamClause}
    group by team_id, season_id
    order by team_id, season_id nulls last
  `.execute(db)

  // `count` and `sum` come back as bigint/numeric, which pg hands over as
  // strings; a season is tens of games, so a number holds them exactly.
  return result.rows.map(row => ({
    teamId: row.teamId,
    seasonId: row.seasonId,
    w: Number(row.w),
    l: Number(row.l),
    t: Number(row.t),
    runsFor: Number(row.runsFor),
    runsAgainst: Number(row.runsAgainst)
  }))
}
