import { type Kysely, type RawBuilder, sql } from 'kysely'

import { HttpError } from '../../common/errors'
import type { GameRequestTerms } from '../../common/gameApprovals'
import type { GroupRef } from '../../common/groupCreation'
import { roleScopes, type VisibleScopes, visibleScopes } from '../access'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { currentActor } from '../groups/rights'

export interface PendingSchedule {
  existingGameId: string | null
  id: string
  affectedTeamIds: string[]
  hostSeasonIds: string[]
  pendingRequestId: string | null
  homeTeamId: string
  awayTeamId: string
  homeTeamName: string
  awayTeamName: string
  homeTeamExternal: boolean
  awayTeamExternal: boolean
  homeLogoPath: string | null
  awayLogoPath: string | null
  seasonId: string | null
  startAt: string
  venue: string | null
  endAt?: string | null
  address?: string | null
  notes?: string | null
  arrivalTimeDelta?: number | null
  latitude?: number | null
  longitude?: number | null
  exhibition: boolean
  timezone: string
}

export interface PendingLookup {
  /** Published rows already selected by the caller, including retained revisions. */
  publishedGameIds?: string[]
  teamId?: string
  seasonIds?: string[]
  visible?: VisibleScopes
  includeNew?: boolean
}

/** Minimal published schedule information; request terms never leave this helper. */
export async function pendingSchedule(
  db: Kysely<Database>,
  actor?: Actor,
  now = new Date(),
  lookup: PendingLookup = {}
): Promise<PendingSchedule[]> {
  const visible =
    lookup.visible ??
    (actor != null &&
    lookup.publishedGameIds == null &&
    lookup.teamId == null &&
    lookup.seasonIds == null
      ? await visibleScopes(db, actor.userId, actor.isAdmin)
      : undefined)
  const proposed: Array<RawBuilder<boolean>> = []
  const existing: Array<RawBuilder<boolean>> = []
  const oldId = sql<
    string | null
  >`coalesce(group_requests.terms->>'gameId', group_requests.game_id)`
  const home = sql<string>`group_requests.terms->'game'->>'homeTeamId'`
  const away = sql<string>`group_requests.terms->'game'->>'awayTeamId'`
  const hosts = sql`coalesce(group_requests.terms->'hostSeasonIds', jsonb_build_array(group_requests.terms->'game'->>'seasonId'))`
  if (lookup.teamId != null) {
    proposed.push(
      sql<boolean>`(${home} = ${lookup.teamId} or ${away} = ${lookup.teamId})`
    )
    existing.push(
      sql<boolean>`(games.home_team_id = ${lookup.teamId} or games.away_team_id = ${lookup.teamId})`
    )
  }
  if (lookup.seasonIds != null) {
    if (lookup.seasonIds.length === 0) return []
    proposed.push(sql<boolean>`${hosts} ?| ${lookup.seasonIds}::text[]`)
    existing.push(
      sql<boolean>`games.season_id = any(${lookup.seasonIds}::text[])`
    )
  }
  if (visible != null && !visible.isAdmin) {
    const teams = [...visible.teamIds]
    const seasons = [...visible.seasonIds]
    proposed.push(
      sql<boolean>`(${home} = any(${teams}::text[]) or ${away} = any(${teams}::text[]) or ${hosts} ?| ${seasons}::text[])`
    )
    existing.push(
      sql<boolean>`(games.home_team_id = any(${teams}::text[]) or games.away_team_id = any(${teams}::text[]) or games.season_id = any(${seasons}::text[]))`
    )
  }
  const alternatives: Array<RawBuilder<boolean>> = []
  if (lookup.publishedGameIds == null)
    alternatives.push(
      sql<boolean>`${oldId} is not null and exists(select 1 from games where games.id = ${oldId} ${existing.length === 0 ? sql`` : sql`and ${sql.join(existing, sql` and `)}`})`
    )
  else if (lookup.publishedGameIds.length > 0)
    alternatives.push(
      sql<boolean>`${oldId} = any(${lookup.publishedGameIds}::text[])`
    )
  if (lookup.includeNew !== false)
    alternatives.push(
      sql<boolean>`${oldId} is null ${proposed.length === 0 ? sql`` : sql`and ${sql.join(proposed, sql` and `)}`}`
    )
  if (alternatives.length === 0) return []
  const requests = await db
    .selectFrom('group_requests')
    .select(['id', 'terms', 'game_id', 'sender_scope_type', 'sender_scope_id'])
    .where('kind', '=', 'game')
    .where('status', '=', 'pending')
    .where('expires_at', '>', now)
    .where(sql<boolean>`(${sql.join(alternatives, sql` or `)})`)
    .orderBy('sent_at')
    .orderBy('id')
    .execute()
  if (requests.length === 0) return []
  const ids = [
    ...new Set(
      requests.flatMap(request => {
        const terms = request.terms as GameRequestTerms
        return [
          terms.game.homeTeamId,
          terms.game.awayTeamId,
          ...(request.sender_scope_type === 'team'
            ? [request.sender_scope_id]
            : [])
        ]
      })
    )
  ]
  const columns = [
    'id',
    'name',
    'kind',
    'logo_path',
    'custodian_type',
    'custodian_id'
  ] as const
  const teams = await db
    .selectFrom('teams')
    .select(columns)
    .where('id', 'in', ids)
    .execute()
  const names = new Map(teams.map(team => [team.id, team]))
  const owners = [
    ...new Set(
      teams
        .filter(
          team =>
            team.kind === 'external' &&
            team.custodian_type === 'team' &&
            team.custodian_id != null &&
            !names.has(team.custodian_id)
        )
        .map(team => team.custodian_id!)
    )
  ]
  if (owners.length > 0)
    for (const team of await db
      .selectFrom('teams')
      .select(columns)
      .where('id', 'in', owners)
      .execute())
      names.set(team.id, team)
  const permissions = new Map<string, boolean>()
  let scopes: Awaited<ReturnType<typeof roleScopes>> | undefined
  if (actor != null && actor.apiTokenId == null) {
    try {
      const fresh = await currentActor(db, actor)
      scopes = await roleScopes(db, fresh.userId, fresh.isAdmin)
    } catch (error) {
      if (
        !(error instanceof HttpError) ||
        !['unauthorized', 'forbidden', 'notFound'].includes(error.code)
      )
        throw error
    }
  }
  const administers = (ref: GroupRef): boolean => {
    const key = `${ref.kind}:${ref.id}`
    const cached = permissions.get(key)
    if (cached != null) return cached
    let result = false
    if (scopes != null) {
      const team = ref.kind === 'team' ? names.get(ref.id) : undefined
      if (team?.kind === 'external') {
        if (
          team.custodian_type != null &&
          team.custodian_id != null &&
          (team.custodian_type !== 'team' ||
            names.get(team.custodian_id)?.kind === 'full')
        )
          result =
            scopes.isAdmin ||
            (team.custodian_type === 'team'
              ? scopes.admin.teamIds
              : team.custodian_type === 'season'
                ? scopes.admin.seasonIds
                : scopes.admin.leagueIds
            ).has(team.custodian_id)
      } else
        result =
          scopes.isAdmin ||
          (ref.kind === 'league'
            ? scopes.admin.leagueIds
            : ref.kind === 'season'
              ? scopes.admin.seasonIds
              : scopes.admin.teamIds
          ).has(ref.id) ||
          (ref.kind === 'team' &&
            (scopes.coach.teamIds.has(ref.id) ||
              scopes.assistant.teamIds.has(ref.id)))
    }
    permissions.set(key, result)
    return result
  }
  const result: PendingSchedule[] = []
  for (const request of requests) {
    const terms = request.terms as GameRequestTerms
    const home = names.get(terms.game.homeTeamId)
    const away = names.get(terms.game.awayTeamId)
    if (home == null || away == null) continue
    const authorized = [
      { kind: 'team' as const, id: home.id },
      { kind: 'team' as const, id: away.id },
      { kind: request.sender_scope_type!, id: request.sender_scope_id! }
    ].some(administers)
    result.push({
      existingGameId: terms.gameId ?? request.game_id,
      id: terms.proposedGameId ?? `pending:${request.id}`,
      affectedTeamIds: terms.affectedTeamIds ?? [home.id, away.id],
      hostSeasonIds:
        terms.hostSeasonIds ??
        (terms.game.seasonId == null ? [] : [terms.game.seasonId]),
      pendingRequestId: authorized ? request.id : null,
      homeTeamId: home.id,
      awayTeamId: away.id,
      homeTeamName: home.name,
      awayTeamName: away.name,
      homeTeamExternal: home.kind === 'external',
      awayTeamExternal: away.kind === 'external',
      homeLogoPath: home.logo_path,
      awayLogoPath: away.logo_path,
      seasonId: terms.game.seasonId,
      startAt: terms.game.startAt,
      venue: terms.game.venue,
      endAt: terms.game.endAt,
      address: terms.game.address,
      notes: terms.game.notes,
      arrivalTimeDelta: terms.game.arrivalTimeDelta,
      latitude: terms.game.latitude,
      longitude: terms.game.longitude,
      exhibition: terms.game.exhibition ?? false,
      timezone: terms.game.timezone ?? 'UTC'
    })
  }
  return result
}

/** A canceled original stays canceled; a revision retains all approved fields. */
export function annotatePending<T extends { id: string; status: string }>(
  rows: T[],
  pending: PendingSchedule[]
): Array<T & { pendingApproval: boolean; pendingRequestId: string | null }> {
  return rows.map(row => {
    const proposal =
      row.status === 'cancelled'
        ? undefined
        : pending.find(item => item.existingGameId === row.id)
    return {
      ...row,
      pendingApproval: proposal != null,
      pendingRequestId: proposal?.pendingRequestId ?? null
    }
  })
}
