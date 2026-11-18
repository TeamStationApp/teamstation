import type { Kysely } from 'kysely'

import { hierarchyReady } from '../access'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'

export interface OwnershipInput {
  teams: Array<{
    id: string
    kind: 'full' | 'external'
    leagueId?: string | null
    custodianId?: string | null
    custodianType?: 'league' | 'season' | 'team' | null
  }>
  seasons: Array<{ id: string; leagueId: string | null }>
  leagues: Array<{ id: string }>
  memberships: Array<{ teamId: string; seasonId: string }>
  directAdmins: Array<{ kind: 'team' | 'season' | 'league'; id: string }>
}

export interface OwnershipChoice {
  teamId: string
  parentSeasonIds: string[]
}

export interface OwnershipReport {
  ready: boolean
  conflicts: Array<{ kind: string; id: string; reason: string }>
  parents: Array<{ teamId: string; seasonId: string; leagueId: string | null }>
  alreadyApplied?: boolean
}

/** A report contains identifiers, not names, emails or credentials. Keep it private. */
export function analyzeOwnership(
  input: OwnershipInput,
  choices: OwnershipChoice[] = []
): OwnershipReport {
  const conflicts: Array<{ kind: string; id: string; reason: string }> = []
  const parents: Array<{
    teamId: string
    seasonId: string
    leagueId: string | null
  }> = []
  const selected = new Map(
    choices.map(choice => [choice.teamId, choice.parentSeasonIds])
  )
  const seasons = new Map(input.seasons.map(season => [season.id, season]))
  for (const choice of choices) {
    if (!input.teams.some(team => team.id === choice.teamId))
      conflicts.push({
        kind: 'team',
        id: choice.teamId,
        reason: 'Unknown team decision'
      })
  }
  for (const team of input.teams) {
    if (team.kind === 'external') {
      const scopes =
        team.custodianType === 'league'
          ? input.leagues
          : team.custodianType === 'season'
            ? input.seasons
            : team.custodianType === 'team'
              ? input.teams.filter(row => row.kind === 'full')
              : []
      if (
        team.custodianId == null ||
        !scopes.some(row => row.id === team.custodianId)
      )
        conflicts.push({
          kind: 'team',
          id: team.id,
          reason: 'Assign an explicit placeholder custodian'
        })
      continue
    }
    const candidates = input.memberships.filter(row => row.teamId === team.id)
    const wanted = selected.get(team.id) ?? candidates.map(row => row.seasonId)
    if (new Set(wanted).size !== wanted.length) {
      conflicts.push({
        kind: 'team',
        id: team.id,
        reason: 'Duplicate parent decision'
      })
      continue
    }
    if (
      wanted.some(
        id => !candidates.some(row => row.seasonId === id) || !seasons.has(id)
      )
    ) {
      conflicts.push({
        kind: 'team',
        id: team.id,
        reason: 'Parent decision is not an existing season membership'
      })
      continue
    }
    const leagues = wanted.map(id => seasons.get(id)!.leagueId)
    if (
      new Set(leagues).size > 1 ||
      (wanted.length > 1 && leagues.includes(null))
    ) {
      conflicts.push({
        kind: 'team',
        id: team.id,
        reason:
          'Choose one standalone parent or one shared non-null league lineage'
      })
      continue
    }
    for (const seasonId of wanted)
      parents.push({
        teamId: team.id,
        seasonId,
        leagueId: seasons.get(seasonId)!.leagueId
      })
  }
  const direct = (kind: 'league' | 'season' | 'team', id: string): boolean =>
    input.directAdmins.some(admin => admin.kind === kind && admin.id === id)
  const leagueAdmin = (id: string | null | undefined): boolean =>
    id != null && direct('league', id)
  const seasonAdmin = (id: string): boolean =>
    direct('season', id) || leagueAdmin(seasons.get(id)?.leagueId)
  const requireAdmin = (
    kind: 'league' | 'season' | 'team',
    id: string,
    covered: boolean
  ): void => {
    if (!covered)
      conflicts.push({ kind, id, reason: 'Assign an active administrator' })
  }
  for (const league of input.leagues)
    requireAdmin('league', league.id, direct('league', league.id))
  for (const season of input.seasons)
    requireAdmin('season', season.id, seasonAdmin(season.id))
  for (const team of input.teams) {
    // A rejected parent decision has no chosen parents to judge coverage by.
    if (
      team.kind === 'external' ||
      conflicts.some(row => row.kind === 'team' && row.id === team.id)
    )
      continue
    const chosen = parents.filter(parent => parent.teamId === team.id)
    // Cutover adopts the selected parent league, or retains a direct league
    // when there are no selected parents. After cutover the direct edge stays.
    const leagueId = chosen.length > 0 ? chosen[0].leagueId : team.leagueId
    requireAdmin(
      'team',
      team.id,
      direct('team', team.id) ||
        leagueAdmin(leagueId) ||
        chosen.some(parent => seasonAdmin(parent.seasonId))
    )
  }
  return { ready: conflicts.length === 0, conflicts, parents }
}

/** Cutover is explicit and atomic; ambiguous lineages never get guessed. */
export async function ownershipPreflight(
  db: Kysely<Database>,
  options: { dryRun: boolean; choices?: OwnershipChoice[] }
): Promise<OwnershipReport> {
  return await atomic(db, async trx => {
    await lockKeys(trx, ['creation:ownership-cutover', 'creation:parent-graph'])
    const teams = await trx
      .selectFrom('teams')
      .select(['id', 'kind', 'league_id', 'custodian_id', 'custodian_type'])
      .where('merged_into', 'is', null)
      .execute()
    const seasons = await trx
      .selectFrom('seasons')
      .select(['id', 'league_id'])
      .execute()
    const leagues = await trx.selectFrom('leagues').select(['id']).execute()
    const alreadyReady = await hierarchyReady(trx)
    const memberships = await trx
      .selectFrom(alreadyReady ? 'season_team_parents' : 'season_teams')
      .select(['team_id', 'season_id'])
      .execute()
    const admins = await trx
      .selectFrom('scope_roles')
      .innerJoin('users', 'users.id', 'scope_roles.user_id')
      .select(['scope_roles.scope_type', 'scope_roles.scope_id'])
      .where('role', '=', 'admin')
      .where('users.login_enabled', '=', true)
      .where('users.disabled_at', 'is', null)
      .where('users.merged_into', 'is', null)
      .execute()
    const owners = await trx
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .select('team_id')
      .where('role', 'in', ['owner', 'manager'])
      .where('users.login_enabled', '=', true)
      .where('users.disabled_at', 'is', null)
      .where('users.merged_into', 'is', null)
      .execute()
    const report = analyzeOwnership(
      {
        teams: teams.map(team => ({
          id: team.id,
          kind: team.kind,
          leagueId: team.league_id,
          custodianId: team.custodian_id,
          custodianType: team.custodian_type
        })),
        seasons: seasons.map(season => ({
          id: season.id,
          leagueId: season.league_id
        })),
        leagues,
        memberships: memberships.map(row => ({
          teamId: row.team_id,
          seasonId: row.season_id
        })),
        directAdmins: [
          ...admins.map(row => ({ kind: row.scope_type, id: row.scope_id })),
          ...owners.map(row => ({ kind: 'team' as const, id: row.team_id }))
        ]
      },
      options.choices
    )
    if (options.dryRun || !report.ready) return report
    if (alreadyReady) return { ...report, alreadyApplied: true }
    await lockKeys(
      trx,
      teams.map(team => `group:team:${team.id}`)
    )
    for (const team of teams) {
      const chosen = report.parents.filter(parent => parent.teamId === team.id)
      if (chosen.length === 0) continue
      await trx
        .updateTable('teams')
        .set({ league_id: chosen[0].leagueId })
        .where('id', '=', team.id)
        .execute()
      await trx
        .insertInto('season_team_parents')
        .values(
          chosen.map(parent => ({
            season_id: parent.seasonId,
            team_id: parent.teamId
          }))
        )
        .onConflict(oc => oc.columns(['season_id', 'team_id']).doNothing())
        .execute()
    }
    await trx
      .insertInto('system_settings')
      .values({ key: 'creation.hierarchyReady', value: true })
      .onConflict(oc => oc.column('key').doUpdateSet({ value: true }))
      .execute()
    return { ...report, alreadyApplied: false }
  })
}
