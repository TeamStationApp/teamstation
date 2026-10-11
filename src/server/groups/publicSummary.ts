import { type Kysely, sql } from 'kysely'

import { notFound } from '../../common/errors'
import {
  calendarDateText,
  type GroupKind,
  type GroupRef
} from '../../common/groupCreation'
import { asLocality } from '../../common/locality'
import type {
  GroupDetail,
  PublicGame,
  PublicGroup
} from '../../common/publicGroups'
import { publicStaffName } from '../../common/publicStaffName'
import { givenRolesOnTeam, nonMemberTeam, visibleScopes } from '../access'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { imageUrl, PROFILE_SIZE } from '../media/imageUrls'
import type { SpaceSettings } from '../media/spacesHls'
import { annotatePending, pendingSchedule } from '../schedule/pendingProjection'
import { followMerges } from '../teams/followMerges'
import { canAdminister } from './rights'

export async function publicGroup(
  db: Kysely<Database>,
  ref: GroupRef,
  space: SpaceSettings
): Promise<PublicGroup> {
  const table =
    ref.kind === 'league'
      ? 'leagues'
      : ref.kind === 'season'
        ? 'seasons'
        : 'teams'
  const row = await db
    .selectFrom(table)
    .selectAll()
    .where('id', '=', ref.id)
    .executeTakeFirst()
  if (row == null) throw notFound()
  const parentNames: string[] = []
  if ('league_id' in row && row.league_id != null) {
    const parent = await db
      .selectFrom('leagues')
      .select('name')
      .where('id', '=', row.league_id)
      .executeTakeFirst()
    if (parent != null) parentNames.push(parent.name)
  }
  if (ref.kind === 'team') {
    const parents = await db
      .selectFrom('season_team_parents')
      .innerJoin('seasons', 'seasons.id', 'season_team_parents.season_id')
      .select('seasons.name')
      .where('team_id', '=', ref.id)
      .orderBy('starts_on', ob => ob.desc().nullsLast())
      .orderBy('ends_on', ob => ob.desc().nullsLast())
      .orderBy('seasons.id')
      .execute()
    parentNames.push(...parents.map(parent => parent.name))
  }
  let locality: unknown = 'locality' in row ? row.locality : null
  if (ref.kind === 'season' && 'league_id' in row && row.league_id != null)
    locality =
      (
        await db
          .selectFrom('leagues')
          .select('locality')
          .where('id', '=', row.league_id)
          .executeTakeFirst()
      )?.locality ?? null
  return {
    id: row.id,
    kind: ref.kind,
    name: row.name,
    parentNames,
    imageUrl: imageUrl(space, row.logo_path, PROFILE_SIZE),
    locality: locality == null ? null : asLocality(locality),
    startsOn: 'starts_on' in row ? calendarDateText(row.starts_on) : null,
    endsOn: 'ends_on' in row ? calendarDateText(row.ends_on) : null,
    timezone: 'timezone' in row ? row.timezone : 'UTC',
    external: 'kind' in row && row.kind === 'external',
    leagueId: 'league_id' in row ? row.league_id : null
  }
}

export async function discoverGroups(
  db: Kysely<Database>,
  kind: GroupKind,
  query: string,
  space: SpaceSettings,
  allowedIds?: string[],
  limit: number | null = 50
): Promise<PublicGroup[]> {
  const table =
    kind === 'league' ? 'leagues' : kind === 'season' ? 'seasons' : 'teams'
  let lookup = db.selectFrom(table).select('id')
  if (allowedIds != null) {
    if (allowedIds.length === 0) return []
    lookup = lookup.where('id', 'in', allowedIds)
  }
  if (kind === 'team') lookup = lookup.where('merged_into', 'is', null)
  if (query !== '') {
    const pattern = '%' + query.replace(/[\\%_]/g, '\\$&') + '%'
    lookup = lookup.where(eb =>
      eb.or([
        eb('name', 'ilike', pattern),
        ...(kind === 'season'
          ? [
              eb.exists(
                eb
                  .selectFrom('leagues')
                  .select('id')
                  .whereRef('leagues.id', '=', 'seasons.league_id')
                  .where(
                    sql<string>`concat_ws(' ', leagues.locality->>'city', leagues.locality->>'region', leagues.locality->>'country')`,
                    'ilike',
                    pattern
                  )
              )
            ]
          : [
              eb(
                sql<string>`concat_ws(' ', locality->>'city', locality->>'region', locality->>'country')`,
                'ilike',
                pattern
              )
            ])
      ])
    )
  }
  let ordered = (
    kind === 'season'
      ? lookup
          .orderBy('starts_on', ob => ob.desc().nullsLast())
          .orderBy('ends_on', ob => ob.desc().nullsLast())
      : lookup.orderBy('name')
  ).orderBy('id')
  if (limit != null) ordered = ordered.limit(limit)
  const ids = await ordered.execute()
  const groups = await Promise.all(
    ids.map(async row => await publicGroup(db, { kind, id: row.id }, space))
  )
  const needle = query.toLocaleLowerCase()
  const result = groups
    .filter(group =>
      `${group.name} ${group.locality?.city ?? ''} ${group.locality?.region ?? ''} ${group.locality?.country ?? ''}`
        .toLocaleLowerCase()
        .includes(needle)
    )
    .sort((a, b) => {
      const first =
        kind === 'season'
          ? (b.startsOn ?? '').localeCompare(a.startsOn ?? '')
          : a.name.localeCompare(b.name)
      if (first !== 0) return first
      const second =
        kind === 'season' ? (b.endsOn ?? '').localeCompare(a.endsOn ?? '') : 0
      return second !== 0 ? second : a.id.localeCompare(b.id)
    })
  return limit == null ? result : result.slice(0, limit)
}

export async function publicGames(
  db: Kysely<Database>,
  ref: GroupRef,
  actor?: Actor
): Promise<PublicGame[]> {
  let query = db
    .selectFrom('games')
    .innerJoin('teams as home', 'home.id', 'games.home_team_id')
    .innerJoin('teams as away', 'away.id', 'games.away_team_id')
    .leftJoin(
      'teams as withdrawn',
      'withdrawn.id',
      'games.withdrawn_by_team_id'
    )
    .select([
      'games.id',
      'games.home_team_id',
      'home.name as homeName',
      'games.away_team_id',
      'away.name as awayName',
      'games.season_id',
      'games.start_at',
      'games.venue',
      'games.exhibition',
      'games.timezone',
      'home.kind as homeKind',
      'away.kind as awayKind',
      'games.status',
      'games.home_score',
      'games.away_score',
      'games.cancellation_reason',
      'games.withdrawn_by_team_id',
      'withdrawn.name as withdrawnName'
    ])
  if (ref.kind === 'team')
    query = query.where(eb =>
      eb.or([
        eb('games.home_team_id', '=', ref.id),
        eb('games.away_team_id', '=', ref.id)
      ])
    )
  else if (ref.kind === 'season')
    query = query.where('games.season_id', '=', ref.id)
  else
    query = query.where(
      'games.season_id',
      'in',
      db.selectFrom('seasons').select('id').where('league_id', '=', ref.id)
    )
  const rows = await query
    .orderBy('games.start_at', 'asc')
    .orderBy('games.id')
    .execute()
  const published = rows.map(row => ({
    id: row.id,
    homeTeam: { id: row.home_team_id, name: row.homeName },
    awayTeam: { id: row.away_team_id, name: row.awayName },
    seasonId: row.season_id,
    startAt: row.start_at.toISOString(),
    venue: row.venue,
    exhibition: row.exhibition,
    timezone: row.timezone,
    homeTeamExternal: row.homeKind === 'external',
    awayTeamExternal: row.awayKind === 'external',
    status: row.status,
    homeScore: row.home_score,
    awayScore: row.away_score,
    cancellationReason: row.cancellation_reason,
    withdrawnByTeamId: row.withdrawn_by_team_id,
    withdrawnByTeamName: row.withdrawnName
  }))
  const seasonIds =
    ref.kind !== 'league'
      ? []
      : (
          await db
            .selectFrom('seasons')
            .select('id')
            .where('league_id', '=', ref.id)
            .execute()
        ).map(season => season.id)
  const pending = await pendingSchedule(db, actor, new Date(), {
    publishedGameIds: published.map(game => game.id),
    ...(ref.kind === 'team'
      ? { teamId: ref.id }
      : { seasonIds: ref.kind === 'season' ? [ref.id] : seasonIds })
  })
  const projected = pending
    .filter(
      row =>
        row.existingGameId == null &&
        (ref.kind === 'team'
          ? row.homeTeamId === ref.id || row.awayTeamId === ref.id
          : ref.kind === 'season'
            ? row.hostSeasonIds.includes(ref.id)
            : row.hostSeasonIds.some(id => seasonIds.includes(id)))
    )
    .map(row => ({
      id: row.id,
      homeTeam: { id: row.homeTeamId, name: row.homeTeamName },
      awayTeam: { id: row.awayTeamId, name: row.awayTeamName },
      homeTeamExternal: row.homeTeamExternal,
      awayTeamExternal: row.awayTeamExternal,
      seasonId: row.seasonId,
      startAt: row.startAt,
      venue: row.venue,
      exhibition: row.exhibition,
      timezone: row.timezone,
      status: 'scheduled',
      homeScore: null,
      awayScore: null,
      cancellationReason: null,
      withdrawnByTeamId: null,
      withdrawnByTeamName: null,
      pendingApproval: true,
      pendingRequestId: row.pendingRequestId
    }))
  return [...annotatePending(published, pending), ...projected].sort((a, b) =>
    a.startAt.localeCompare(b.startAt) !== 0
      ? a.startAt.localeCompare(b.startAt)
      : a.id.localeCompare(b.id)
  )
}

export async function groupDetail(
  db: Kysely<Database>,
  ref: GroupRef,
  space: SpaceSettings,
  actor?: Actor
): Promise<GroupDetail> {
  if (ref.kind === 'team')
    ref = { kind: 'team', id: await followMerges(db, ref.id) }
  const group = await publicGroup(db, ref, space)
  const parentRefs: GroupRef[] = []
  const childRefs: GroupRef[] = []
  const participationRefs: GroupRef[] = []
  const competitionRefs: GroupRef[] = []
  const keptRefs: GroupRef[] = []
  const teamSeasons: GroupDetail['teamSeasons'] = []
  if (ref.kind === 'team') {
    const team = await db
      .selectFrom('teams')
      .select(['league_id'])
      .where('id', '=', ref.id)
      .executeTakeFirstOrThrow()
    if (team.league_id != null)
      parentRefs.push({ kind: 'league', id: team.league_id })
    for (const row of await db
      .selectFrom('season_team_parents')
      .select('season_id')
      .where('team_id', '=', ref.id)
      .execute())
      parentRefs.push({ kind: 'season', id: row.season_id })
    for (const row of await db
      .selectFrom('season_teams')
      .select('season_id')
      .where('team_id', '=', ref.id)
      .where('active', '=', true)
      .execute())
      participationRefs.push({ kind: 'season', id: row.season_id })
  } else if (ref.kind === 'season') {
    const season = await db
      .selectFrom('seasons')
      .select('league_id')
      .where('id', '=', ref.id)
      .executeTakeFirstOrThrow()
    if (season.league_id != null)
      parentRefs.push({ kind: 'league', id: season.league_id })
    for (const row of await db
      .selectFrom('season_team_parents')
      .select('team_id')
      .where('season_id', '=', ref.id)
      .execute())
      childRefs.push({ kind: 'team', id: row.team_id })
    for (const row of await db
      .selectFrom('season_teams')
      .select('team_id')
      .where('season_id', '=', ref.id)
      .where('active', '=', true)
      .execute())
      competitionRefs.push({ kind: 'team', id: row.team_id })
  } else {
    for (const row of await db
      .selectFrom('seasons')
      .select('id')
      .where('league_id', '=', ref.id)
      .execute())
      childRefs.push({ kind: 'season', id: row.id })
    for (const row of await db
      .selectFrom('teams')
      .select('id')
      .where('league_id', '=', ref.id)
      .where('merged_into', 'is', null)
      .execute())
      childRefs.push({ kind: 'team', id: row.id })
    for (const row of await db
      .selectFrom('teams')
      .select('id')
      .where('custodian_type', '=', 'league')
      .where('custodian_id', '=', ref.id)
      .where('merged_into', 'is', null)
      .execute())
      keptRefs.push({ kind: 'team', id: row.id })
    // The league's seasons each of its teams belongs to, as a parent or as
    // a competitor, so a team's card can link to every one of them.
    const teamIds = [...childRefs, ...keptRefs]
      .filter(child => child.kind === 'team')
      .map(child => child.id)
    if (teamIds.length > 0) {
      const memberships = await db
        .selectFrom('season_teams')
        .innerJoin('seasons', 'seasons.id', 'season_teams.season_id')
        .select(['season_teams.team_id as teamId', 'seasons.id as seasonId'])
        .where('seasons.league_id', '=', ref.id)
        .where('season_teams.active', '=', true)
        .where('season_teams.team_id', 'in', teamIds)
        .union(
          db
            .selectFrom('season_team_parents')
            .innerJoin('seasons', 'seasons.id', 'season_team_parents.season_id')
            .select([
              'season_team_parents.team_id as teamId',
              'seasons.id as seasonId'
            ])
            .where('seasons.league_id', '=', ref.id)
            .where('season_team_parents.team_id', 'in', teamIds)
        )
        .execute()
      for (const teamId of teamIds) {
        const seasonIds = [
          ...new Set(
            memberships
              .filter(row => row.teamId === teamId)
              .map(row => row.seasonId)
          )
        ].sort()
        if (seasonIds.length > 0) teamSeasons.push({ teamId, seasonIds })
      }
    }
  }
  let custodian: PublicGroup | null = null
  if (group.external) {
    const held = await db
      .selectFrom('teams')
      .select(['custodian_type', 'custodian_id'])
      .where('id', '=', ref.id)
      .executeTakeFirstOrThrow()
    if (held.custodian_type != null && held.custodian_id != null)
      custodian = await publicGroup(
        db,
        { kind: held.custodian_type, id: held.custodian_id },
        space
      )
  }
  const staff: GroupDetail['staff'] = []
  if (ref.kind === 'team') {
    // The roles each was given, never the ones implied: an administrator is
    // listed as admin alone, a scorekeeper as scorekeeper alone.
    const given = await givenRolesOnTeam(db, ref.id)
    const ids = [...given.keys()]
    const users =
      ids.length === 0
        ? []
        : await db
            .selectFrom('users')
            .select([
              'id',
              'first_name',
              'last_name',
              'display_name',
              'onboarding_step'
            ])
            .where('id', 'in', ids)
            .execute()
    for (const user of users) {
      staff.push({
        name:
          user.onboarding_step === 'name'
            ? 'Staff member'
            : publicStaffName({
                firstName: user.first_name,
                lastName: user.last_name,
                displayName: user.display_name
              }),
        roles: given.get(user.id) ?? []
      })
    }
  }
  const load = async (refs: GroupRef[]): Promise<PublicGroup[]> =>
    (
      await Promise.all(
        refs.map(async ref => await publicGroup(db, ref, space))
      )
    ).sort((a, b) => {
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
      const range =
        a.kind === 'season'
          ? (b.startsOn ?? '').localeCompare(a.startsOn ?? '')
          : 0
      if (range !== 0) return range
      const end =
        a.kind === 'season' ? (b.endsOn ?? '').localeCompare(a.endsOn ?? '') : 0
      if (end !== 0) return end
      const name = a.name.localeCompare(b.name)
      return name !== 0 ? name : a.id.localeCompare(b.id)
    })
  const visible =
    actor == null ? null : await visibleScopes(db, actor.userId, actor.isAdmin)
  const canViewPrivate =
    visible != null &&
    (visible.isAdmin ||
      (ref.kind === 'team' ? visible.teamIds : visible.seasonIds).has(ref.id))
  // Anybody signed in who is not a member reads a team in the non-member
  // view; a season or league page is the same for everybody.
  const nonMemberView =
    ref.kind === 'team' &&
    visible != null &&
    (await nonMemberTeam(db, actor, visible, ref.id))
  return {
    group,
    canViewPrivate,
    nonMemberView,
    parents: await load(parentRefs),
    children: await load(childRefs),
    participatingSeasons: await load(participationRefs),
    competingTeams: await load(competitionRefs),
    keptTeams: await load(keptRefs),
    teamSeasons,
    staff,
    custodian,
    games: await publicGames(db, ref, actor),
    canManage:
      actor == null || actor.apiTokenId != null
        ? false
        : await canAdminister(db, actor, ref)
  }
}
