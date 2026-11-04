import type { Kysely } from 'kysely'

import type { GroupKind } from '../../common/groupCreation'
import type { PublicGroup } from '../../common/publicGroups'
import { ROLE_FLAGS } from '../../common/roles'
import { guardedRows, teamsPlayedOnNow, visibleScopes } from '../access'
import { onePerson } from '../admin/people'
import type { Database } from '../db/database'
import { isRealVideo } from '../db/realVideos'
import { publicGroup } from '../groups/publicSummary'
import { imageUrl } from '../media/imageUrls'
import type { SpaceSettings } from '../media/spacesHls'
import { teamRecords } from '../stats/records'
import { seasonParticipantCounts } from '../stats/seasonTeams'
import { followMerges } from '../teams/followMerges'

/**
 * Home's three lists for one person.
 *
 * A direct tie is a staff flag, a real membership, a follow, or a team a
 * guarded player plays on now, on that row itself. A row reached only because
 * a league or season flows downward, or only because the person is its admin,
 * comes after. The site-admin flag adds nothing: `visibleScopes` is asked
 * with `false`, and its `isAdmin` bit is never read.
 *
 * A follow whose group is gone is left out, and the rest of the list still
 * returns. Merged and external teams are left out. A merged team that was
 * followed is the team it became.
 */

const STAFF = new Set<string>(ROLE_FLAGS)

export interface HomeLists {
  teams: HomeRow[]
  seasons: HomeRow[]
  leagues: HomeRow[]
}

/** A list row. Member teams and seasons carry their summary; the rest a public group. */
export type HomeRow = Record<string, unknown> & {
  id: string
  name: string
  direct: boolean
  source: 'member' | 'follow'
}

interface Followed {
  kind: GroupKind
  id: string
  group: PublicGroup
}

interface Listed<T> {
  id: string
  name: string
  at: Date | null
  direct: boolean
  entry: T
}

interface TeamRow {
  id: string
  name: string
  short_name: string | null
  logo_path: string | null
  kind: 'full' | 'external'
}

interface SeasonRow {
  id: string
  league_id: string | null
  name: string
  year: number
  term: string | null
  age_group: string | null
  logo_path: string | null
}

const empty = (): HomeLists => ({ teams: [], seasons: [], leagues: [] })

function when(value: Date | string | null | undefined): Date | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function byRecency(
  a: { at: Date | null; name: string; id: string },
  b: { at: Date | null; name: string; id: string }
): number {
  if (a.at != null && b.at != null && a.at.getTime() !== b.at.getTime())
    return b.at.getTime() - a.at.getTime()
  if (a.at != null && b.at == null) return -1
  if (a.at == null && b.at != null) return 1
  const name = a.name.localeCompare(b.name)
  if (name !== 0) return name
  return a.id.localeCompare(b.id)
}

function ordered<T>(rows: Array<Listed<T>>): T[] {
  return [
    ...rows.filter(row => row.direct).sort(byRecency),
    ...rows.filter(row => !row.direct).sort(byRecency)
  ].map(row => row.entry)
}

async function loadFollows(
  db: Kysely<Database>,
  userId: string,
  space: SpaceSettings
): Promise<Followed[]> {
  const rows = await db
    .selectFrom('follows')
    .select(['group_type', 'group_id'])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute()
  const out: Followed[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const id =
      row.group_type === 'team'
        ? await followMerges(db, row.group_id)
        : row.group_id
    const key = `${row.group_type}:${id}`
    if (seen.has(key)) continue
    seen.add(key)
    try {
      out.push({
        kind: row.group_type,
        id,
        group: await publicGroup(db, { kind: row.group_type, id }, space)
      })
    } catch {
      // A group that has gone away is simply no longer on the list.
    }
  }
  return out
}

async function fullTeams(
  db: Kysely<Database>,
  ids: string[]
): Promise<Map<string, TeamRow>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .selectFrom('teams')
    .select(['id', 'name', 'short_name', 'logo_path', 'kind'])
    .where('id', 'in', ids)
    .where('kind', '=', 'full')
    .where('merged_into', 'is', null)
    .execute()
  return new Map(rows.map(row => [row.id, row]))
}

async function seasonRows(
  db: Kysely<Database>,
  ids: string[]
): Promise<SeasonRow[]> {
  if (ids.length === 0) return []
  return await db
    .selectFrom('seasons')
    .select([
      'id',
      'league_id',
      'name',
      'year',
      'term',
      'age_group',
      'logo_path'
    ])
    .where('id', 'in', ids)
    .execute()
}

async function latestByTeam(
  db: Kysely<Database>,
  ids: string[]
): Promise<Map<string, Date | null>> {
  const out = new Map<string, Date | null>()
  if (ids.length === 0) return out
  const rows = await db
    .selectFrom('teams')
    .leftJoin('games', join =>
      join.on(eb =>
        eb.or([
          eb('games.home_team_id', '=', eb.ref('teams.id')),
          eb('games.away_team_id', '=', eb.ref('teams.id'))
        ])
      )
    )
    .select(['teams.id as id'])
    .select(eb => eb.fn.max('games.start_at').as('at'))
    .where('teams.id', 'in', ids)
    .groupBy('teams.id')
    .execute()
  for (const row of rows) out.set(row.id, when(row.at))
  return out
}

async function latestBySeason(
  db: Kysely<Database>,
  ids: string[]
): Promise<Map<string, Date | null>> {
  const out = new Map<string, Date | null>()
  if (ids.length === 0) return out
  const rows = await db
    .selectFrom('games')
    .select(['season_id as id'])
    .select(eb => eb.fn.max('start_at').as('at'))
    .where('season_id', 'in', ids)
    .groupBy('season_id')
    .execute()
  for (const row of rows) {
    if (row.id != null) out.set(row.id, when(row.at))
  }
  return out
}

async function latestByLeague(
  db: Kysely<Database>,
  ids: string[]
): Promise<Map<string, Date | null>> {
  const out = new Map<string, Date | null>()
  if (ids.length === 0) return out
  const rows = await db
    .selectFrom('seasons')
    .innerJoin('games', 'games.season_id', 'seasons.id')
    .select(['seasons.league_id as id'])
    .select(eb => eb.fn.max('games.start_at').as('at'))
    .where('seasons.league_id', 'in', ids)
    .groupBy('seasons.league_id')
    .execute()
  for (const row of rows) {
    if (row.id != null) out.set(row.id, when(row.at))
  }
  return out
}

async function externalIdsOf(
  db: Kysely<Database>,
  ids: string[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (ids.length === 0) return out
  const rows = await db
    .selectFrom('external_ids')
    .select(['entity_id', 'external_id'])
    .where('entity_type', '=', 'team')
    .where('entity_id', 'in', ids)
    .orderBy('external_id')
    .execute()
  for (const row of rows) {
    const held = out.get(row.entity_id) ?? []
    held.push(row.external_id)
    out.set(row.entity_id, held)
  }
  return out
}

async function seasonCounts(
  db: Kysely<Database>,
  ids: string[]
): Promise<Map<string, { teams: number; games: number; videos: number }>> {
  const counts = new Map<
    string,
    { teams: number; games: number; videos: number }
  >()
  for (const id of ids) counts.set(id, { teams: 0, games: 0, videos: 0 })
  if (ids.length === 0) return counts
  const teamCounts = await seasonParticipantCounts(db, ids)
  for (const [id, total] of teamCounts) {
    const held = counts.get(id)
    if (held != null) held.teams = total
  }
  const gameRows = await db
    .selectFrom('games')
    .leftJoin('videos', join =>
      join.onRef('videos.game_id', '=', 'games.id').on(isRealVideo)
    )
    .select(['games.season_id as seasonId', 'games.id as gameId'])
    .select(eb => eb.fn.count<number>('videos.id').as('videoCount'))
    .where('games.season_id', 'in', ids)
    .groupBy(['games.season_id', 'games.id'])
    .execute()
  for (const row of gameRows) {
    const held = row.seasonId == null ? undefined : counts.get(row.seasonId)
    if (held == null) continue
    held.games += 1
    held.videos += Number(row.videoCount)
  }
  return counts
}

function indexFollows(
  rows: Followed[]
): Record<GroupKind, Map<string, PublicGroup>> {
  const out: Record<GroupKind, Map<string, PublicGroup>> = {
    team: new Map(),
    season: new Map(),
    league: new Map()
  }
  for (const row of rows) out[row.kind].set(row.id, row.group)
  return out
}

export async function homeLists(
  db: Kysely<Database>,
  userId: string,
  space: SpaceSettings
): Promise<HomeLists> {
  const user = await db
    .selectFrom('users')
    .select(['disabled_at', 'merged_into'])
    .where('id', '=', userId)
    .executeTakeFirst()
  if (user == null || user.disabled_at != null || user.merged_into != null)
    return empty()

  const actor = await onePerson(db, userId)
  const [
    scopes,
    roles,
    memberships,
    seasonMembers,
    leagueMembers,
    follows,
    guardedTeams
  ] = await Promise.all([
    visibleScopes(db, userId, false),
    db
      .selectFrom('scope_roles')
      .select(['scope_type', 'scope_id', 'role'])
      .where('user_id', '=', userId)
      .execute(),
    db
      .selectFrom('memberships')
      .select(['team_id', 'role', 'is_player'])
      .where('user_id', '=', userId)
      .execute(),
    db
      .selectFrom('season_members')
      .select(['season_id'])
      .where('user_id', 'in', actor.userIds)
      .execute(),
    db
      .selectFrom('league_members')
      .select(['league_id'])
      .where('user_id', 'in', actor.userIds)
      .execute(),
    loadFollows(db, userId, space),
    guardedRows(db, userId).then(async ids => await teamsPlayedOnNow(db, ids))
  ])

  const followed = indexFollows(follows)
  const directTeam = new Set<string>()
  const directSeason = new Set<string>()
  const directLeague = new Set<string>()
  const visibleLeague = new Set<string>()

  for (const row of roles) {
    const flagged = STAFF.has(row.role)
    if (row.scope_type === 'team' && flagged) directTeam.add(row.scope_id)
    if (row.scope_type === 'season' && flagged) directSeason.add(row.scope_id)
    if (row.scope_type === 'league') {
      visibleLeague.add(row.scope_id)
      if (flagged) directLeague.add(row.scope_id)
    }
  }
  for (const row of memberships) {
    if (row.role === 'member' || row.is_player) directTeam.add(row.team_id)
  }
  for (const row of seasonMembers) directSeason.add(row.season_id)
  for (const row of leagueMembers) {
    directLeague.add(row.league_id)
    visibleLeague.add(row.league_id)
  }
  for (const id of guardedTeams) directTeam.add(id)
  for (const id of followed.team.keys()) directTeam.add(id)
  for (const id of followed.season.keys()) directSeason.add(id)
  for (const id of followed.league.keys()) directLeague.add(id)

  const full = await fullTeams(db, [
    ...new Set([...directTeam, ...scopes.teamIds])
  ])
  const seasons = await seasonRows(db, [
    ...new Set([...directSeason, ...scopes.seasonIds])
  ])
  const leagueIds = [...new Set([...directLeague, ...visibleLeague])]

  const teamSource = (id: string): 'member' | 'follow' =>
    followed.team.has(id) && !scopes.teamIds.has(id) ? 'follow' : 'member'
  const seasonSource = (id: string): 'member' | 'follow' =>
    followed.season.has(id) && !scopes.seasonIds.has(id) ? 'follow' : 'member'
  const leagueSource = (id: string): 'member' | 'follow' =>
    followed.league.has(id) && !visibleLeague.has(id) ? 'follow' : 'member'

  const listedTeamIds = [...full.keys()]
  const memberTeamIds = listedTeamIds.filter(id => teamSource(id) === 'member')
  const memberSeasonIds = seasons
    .filter(season => seasonSource(season.id) === 'member')
    .map(season => season.id)

  const [teamAt, seasonAt, leagueAt, records, counts, externalIds] =
    await Promise.all([
      latestByTeam(db, listedTeamIds),
      latestBySeason(
        db,
        seasons.map(season => season.id)
      ),
      latestByLeague(db, leagueIds),
      memberTeamIds.length === 0
        ? Promise.resolve([])
        : teamRecords(db, { teamIds: memberTeamIds }),
      seasonCounts(db, memberSeasonIds),
      externalIdsOf(db, memberTeamIds)
    ])

  const seasonNames = new Map<string, { name: string; year: number }>()
  const heldYear = new Map<string, number>()
  const recordSeasonIds = [
    ...new Set(
      records
        .map(record => record.seasonId)
        .filter((id): id is string => id != null)
    )
  ]
  if (recordSeasonIds.length > 0) {
    const named = await db
      .selectFrom('seasons')
      .select(['id', 'name', 'year'])
      .where('id', 'in', recordSeasonIds)
      .execute()
    for (const season of named)
      seasonNames.set(season.id, { name: season.name, year: season.year })
  }
  const newest = new Map<
    string,
    { w: number; l: number; t: number; seasonName: string | null }
  >()
  for (const record of records) {
    const season =
      record.seasonId == null ? undefined : seasonNames.get(record.seasonId)
    const year = season?.year ?? 0
    const held = newest.get(record.teamId)
    if (held == null || year > (heldYear.get(record.teamId) ?? 0)) {
      heldYear.set(record.teamId, year)
      newest.set(record.teamId, {
        w: record.w,
        l: record.l,
        t: record.t,
        seasonName: season?.name ?? null
      })
    }
  }

  const teams = ordered(
    listedTeamIds.map(id => {
      const row = full.get(id)!
      const direct = directTeam.has(id)
      const source = teamSource(id)
      const group = followed.team.get(id)
      const record = newest.get(id)
      const entry: HomeRow =
        source === 'follow' && group != null
          ? { ...group, direct, source }
          : {
              id: row.id,
              name: row.name,
              shortName: row.short_name,
              logoPath: row.logo_path,
              logoUrl: imageUrl(space, row.logo_path),
              record:
                record == null || record.w + record.l + record.t === 0
                  ? null
                  : {
                      w: record.w,
                      l: record.l,
                      t: record.t,
                      seasonName: record.seasonName
                    },
              externalIds: externalIds.get(id) ?? [],
              kind: row.kind,
              direct,
              source: 'member'
            }
      return {
        id: row.id,
        name: row.name,
        at: teamAt.get(id) ?? null,
        direct,
        entry
      }
    })
  )

  const seasonEntries = ordered(
    seasons.map(season => {
      const direct = directSeason.has(season.id)
      const source = seasonSource(season.id)
      const group = followed.season.get(season.id)
      const count = counts.get(season.id) ?? { teams: 0, games: 0, videos: 0 }
      const entry: HomeRow =
        source === 'follow' && group != null
          ? { ...group, direct, source }
          : {
              id: season.id,
              leagueId: season.league_id,
              name: season.name,
              year: season.year,
              term: season.term,
              ageGroup: season.age_group,
              teams: count.teams,
              games: count.games,
              videos: count.videos,
              logoUrl: imageUrl(space, season.logo_path),
              direct,
              source: 'member'
            }
      return {
        id: season.id,
        name: season.name,
        at: seasonAt.get(season.id) ?? null,
        direct,
        entry
      }
    })
  )

  const leagueGroups = new Map<string, PublicGroup>()
  for (const id of leagueIds) {
    const cached = followed.league.get(id)
    if (cached != null) {
      leagueGroups.set(id, cached)
      continue
    }
    try {
      leagueGroups.set(id, await publicGroup(db, { kind: 'league', id }, space))
    } catch {
      // A league row that has gone away is left out with the follows.
    }
  }
  const leagues = ordered(
    [...leagueGroups].map(([id, group]) => {
      const direct = directLeague.has(id)
      const source = leagueSource(id)
      return {
        id,
        name: group.name,
        at: leagueAt.get(id) ?? null,
        direct,
        entry: { ...group, direct, source }
      }
    })
  )

  return { teams, seasons: seasonEntries, leagues }
}
