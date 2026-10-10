import { type Kysely, sql } from 'kysely'

import { asStatExtras } from '../../common/statExtras'
import { visibleGamesWhere, type VisibleScopes } from '../access'
import { survivorsOf } from '../admin/people'
import type { Database } from '../db/database'
import { DEFAULT_ERA_INNINGS, type StatRow } from '../stats'

/**
 * The stored stat lines, for whatever a screen is asking about.
 *
 * Every figure the app shows is a sum of these rows, so this is the one place
 * that fetches them and every screen asks the same question with a different
 * filter: one game for a box score, a team and a season for a team's table, a
 * player for their own page.
 */
export interface StatRowFilter {
  gameId?: string
  /** Bound historical aggregates to the caller’s currently visible games. */
  visibleGames?: VisibleScopes
  userId?: number
  /** Every id one person has had — see `admin/people.ts`. */
  userIds?: number[]
  teamId?: string
  seasonId?: string
  /** The calendar year the game was played in. */
  year?: number
  /** Games played by this moment, for a season-to-date average. */
  playedBy?: Date
  /** Any game either of these teams played, for a one-off with no season. */
  teamIds?: string[]
}

export interface StatRowWithGame extends StatRow {
  gameId: string
  seasonId: string | null
  startAt: Date | string | null
  seasonName: string | null
  seasonYear: number | null
  teamName: string | null
  /** The caller shortens these; a whole name never leaves a route. */
  firstName: string | null
  lastName: string | null
  displayName: string
}

export async function statRows(
  db: Kysely<Database>,
  filter: StatRowFilter
): Promise<StatRowWithGame[]> {
  let query = db
    .selectFrom('game_player_stats')
    .innerJoin('games', 'games.id', 'game_player_stats.game_id')
    .innerJoin('users', 'users.id', 'game_player_stats.user_id')
    .leftJoin('seasons', 'seasons.id', 'games.season_id')
    .leftJoin('leagues', 'leagues.id', 'seasons.league_id')
    .leftJoin('teams', 'teams.id', 'game_player_stats.team_id')
    .select([
      'game_player_stats.extra as extra',
      'game_player_stats.game_id as gameId',
      'game_player_stats.user_id as userId',
      'game_player_stats.team_id as teamId',
      'game_player_stats.pa as pa',
      'game_player_stats.ab as ab',
      'game_player_stats.h as h',
      'game_player_stats.singles as singles',
      'game_player_stats.doubles as doubles',
      'game_player_stats.triples as triples',
      'game_player_stats.hr as hr',
      'game_player_stats.bb as bb',
      'game_player_stats.k as k',
      'game_player_stats.r as r',
      'game_player_stats.rbi as rbi',
      'game_player_stats.hbp as hbp',
      'game_player_stats.ci as ci',
      'game_player_stats.sf as sf',
      'game_player_stats.sh as sh',
      'game_player_stats.sb as sb',
      'game_player_stats.cs as cs',
      'game_player_stats.pitch_bf as pitchBf',
      'game_player_stats.pitch_outs as pitchOuts',
      'game_player_stats.pitch_h as pitchH',
      'game_player_stats.pitch_hr as pitchHr',
      'game_player_stats.pitch_bb as pitchBb',
      'game_player_stats.pitch_hbp as pitchHbp',
      'game_player_stats.pitch_k as pitchK',
      'game_player_stats.pitch_r as pitchR',
      'game_player_stats.pitch_er as pitchEr',
      'games.season_id as seasonId',
      'games.start_at as startAt',
      'seasons.name as seasonName',
      'seasons.year as seasonYear',
      'teams.name as teamName',
      'users.first_name as firstName',
      'users.last_name as lastName',
      'users.display_name as displayName',
      sql<number>`coalesce(seasons.era_innings, leagues.era_innings, ${DEFAULT_ERA_INNINGS})`.as(
        'eraInnings'
      )
    ])

  if (filter.visibleGames != null) {
    const allowed = visibleGamesWhere(filter.visibleGames)
    if (allowed != null) query = query.where(allowed)
  }
  if (filter.gameId != null) {
    query = query.where('game_player_stats.game_id', '=', filter.gameId)
  }
  if (filter.userId != null) {
    query = query.where('game_player_stats.user_id', '=', filter.userId)
  }
  if (filter.userIds != null) {
    // An empty list is nobody, and `in ()` is not valid SQL.
    if (filter.userIds.length === 0) return []
    query = query.where('game_player_stats.user_id', 'in', filter.userIds)
  }
  if (filter.teamId != null) {
    query = query.where('game_player_stats.team_id', '=', filter.teamId)
  }
  if (filter.seasonId != null) {
    query = query.where('games.season_id', '=', filter.seasonId)
  }
  if (filter.year != null) {
    query = query
      .where('games.start_at', '>=', new Date(Date.UTC(filter.year, 0, 1)))
      .where('games.start_at', '<', new Date(Date.UTC(filter.year + 1, 0, 1)))
  }
  if (filter.playedBy != null) {
    query = query.where('games.start_at', '<=', filter.playedBy)
  }
  if (filter.teamIds != null) {
    const teamIds = filter.teamIds
    query = query.where(eb =>
      eb.or([
        eb('games.home_team_id', 'in', teamIds),
        eb('games.away_team_id', 'in', teamIds)
      ])
    )
  }

  const rows = await query.execute()

  // Whoever each row's id has since become. A person merged from two rows is
  // one line in a team's table and one average in a box score, not two, and
  // this is the one place that has to know it.
  const survivors = await survivorsOf(
    db,
    rows.map(row => row.userId)
  )
  // And their name with it. A row written under a row that has since closed
  // still joins the closed row's name, and a screen names a person by
  // whichever of their rows it reads first, so a child once imported as
  // `Unknown player`, and later merged into their own row, was listed under
  // that name.
  const merged = [
    ...new Set(
      rows
        .map(row => survivors.get(row.userId) ?? row.userId)
        .filter((id, at) => id !== rows[at].userId)
    )
  ]
  const names = new Map(
    merged.length === 0
      ? []
      : (
          await db
            .selectFrom('users')
            .select([
              'id',
              'first_name as firstName',
              'last_name as lastName',
              'display_name as displayName'
            ])
            .where('id', 'in', merged)
            .execute()
        ).map(user => [user.id, user])
  )
  return rows.map(row => {
    const userId = survivors.get(row.userId) ?? row.userId
    const name = names.get(userId)
    return {
      ...row,
      ...(name == null
        ? {}
        : {
            firstName: name.firstName,
            lastName: name.lastName,
            displayName: name.displayName
          }),
      extra: row.extra == null ? null : asStatExtras(row.extra),
      userId
    }
  })
}
