import { type Kysely, sql, type Transaction } from 'kysely'

import type {
  CreatedTeamSeason,
  CreateTeamBody,
  CreateTeamResponse
} from '../../common/createTeam'
import {
  conflict,
  forbidden,
  notFound,
  unauthorized
} from '../../common/errors'
import { makeId } from '../../common/ids'
import {
  type AdminScopes,
  adminScopes,
  canManageTeam,
  canSeeTeam,
  visibleScopes
} from '../access'
import { lockKeys } from '../db/advisoryLocks'
import type { Database } from '../db/database'
import {
  type ExternalIdKey,
  externalIdLockKey,
  recordExternalId
} from '../db/externalIds'
import { followMerges } from './followMerges'

/** Who is making the team. */
export interface TeamCreator {
  userId: string
  isAdmin: boolean
}

/** What the caller may do with a team or season, read under the locks. */
interface CreatorAccess {
  maySee: (teamId: string) => Promise<boolean>
  mayManage: (teamId: string) => Promise<boolean>
  administersSeason: (seasonId: string) => Promise<boolean>
}

/**
 * The caller's access, read in the transaction and only when a question is
 * asked: a site administrator's never, and their visible teams only when a
 * held team needs it. Read after the locks, a team or season another post
 * made for them while this one waited is already theirs.
 */
function creatorAccess(
  trx: Transaction<Database>,
  creator: TeamCreator
): CreatorAccess {
  let admin: Promise<AdminScopes> | undefined
  const adminOf = async (): Promise<AdminScopes> => {
    admin ??= adminScopes(trx, creator.userId, creator.isAdmin)
    return await admin
  }
  const mayManage = async (teamId: string): Promise<boolean> =>
    creator.isAdmin || canManageTeam(await adminOf(), teamId)
  return {
    mayManage,
    // An administrator of a team knows it is there, member of it or not.
    maySee: async teamId =>
      (await mayManage(teamId)) ||
      canSeeTeam(
        await visibleScopes(trx, creator.userId, creator.isAdmin),
        teamId
      ),
    administersSeason: async seasonId =>
      creator.isAdmin || (await adminOf()).seasonIds.has(seasonId)
  }
}

/**
 * Makes a full team, puts it in a season when one is asked for, and records
 * the ids another system knows it by — or, when one of those ids already
 * names a team the caller can see, makes no team and answers with that one,
 * recording on it the body's ids nothing holds yet. It is not moved into the
 * asked season. An id on a team the caller cannot see is a conflict, and
 * nothing is made.
 *
 * Anybody may make a standalone team. Putting it in a season takes an
 * administrator of that season or of its league; a season asked for by name
 * is one the caller administers, else a new one. The caller becomes the
 * administrator of the team, and of a season this call makes.
 *
 * All in one transaction. Each external id, and a season asked for by name,
 * is locked first, so two posts of the same team at once make one team and
 * one season rather than two.
 */
export async function createTeam(
  db: Kysely<Database>,
  body: CreateTeamBody,
  creator: TeamCreator
): Promise<CreateTeamResponse> {
  return await db.transaction().execute(async trx => {
    // Use the same authority lock as suspension, person merge and role changes,
    // before external-ID locks so every writer keeps one lock order.
    await lockKeys(trx, ['creation:parent-graph'])
    const keys = body.externalIds.map(externalIdLockKey)
    if (body.season != null && 'name' in body.season) {
      keys.push(
        `season:${body.season.name.toLowerCase()}:${String(body.season.year)}`
      )
    }
    await lockKeys(trx, keys)
    const user = await trx
      .selectFrom('users')
      .select(['is_admin', 'disabled_at', 'merged_into', 'login_enabled'])
      .where('id', '=', creator.userId)
      .executeTakeFirst()
    if (
      user == null ||
      user.disabled_at != null ||
      user.merged_into != null ||
      !user.login_enabled
    )
      throw unauthorized()
    creator = { ...creator, isAdmin: user.is_admin }
    const access = creatorAccess(trx, creator)
    const { held, orphans } = await heldTeam(trx, body, access)
    if (held != null) return held

    const season =
      body.season == null ? null : await resolveSeason(trx, body.season, access)
    const teamId = makeId('team')
    await trx
      .insertInto('teams')
      .values({
        id: teamId,
        name: body.name,
        kind: 'full',
        created_from: 'api'
      })
      .execute()
    if (season != null) {
      await trx
        .insertInto('season_teams')
        .values({ season_id: season.id, team_id: teamId })
        .onConflict(oc => oc.columns(['season_id', 'team_id']).doNothing())
        .execute()
    }
    if (orphans.length > 0) {
      await trx
        .updateTable('external_ids')
        .set({ entity_id: teamId })
        .where('id', 'in', orphans)
        .execute()
    }
    for (const externalId of body.externalIds) {
      await recordExternalId(trx, 'team', teamId, externalId)
    }
    await makeAdmin(trx, creator.userId, 'team', teamId)
    // Their own team is one they belong to, so it lists among their teams.
    // A site administrator sees every team already, and belongs to none.
    if (!creator.isAdmin) {
      await trx
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: creator.userId,
          team_id: teamId,
          role: 'owner',
          joined_at: new Date()
        })
        .execute()
    }
    if (season?.created === true) {
      await makeAdmin(trx, creator.userId, 'season', season.id)
    }
    return { id: teamId, name: body.name, created: true, season }
  })
}

/** The creator, as administrator of what this call made. */
async function makeAdmin(
  trx: Transaction<Database>,
  userId: string,
  scopeType: 'season' | 'team',
  scopeId: string
): Promise<void> {
  await trx
    .insertInto('scope_roles')
    .values({
      id: makeId('scopeRole'),
      user_id: userId,
      scope_type: scopeType,
      scope_id: scopeId,
      role: 'admin',
      granted_by: userId,
      granted_at: new Date()
    })
    .execute()
}

/**
 * The team one of the body's external ids already names, as the answer to
 * give instead of making one, with the body's unheld ids recorded on it when
 * the caller administers that team; a caller who can only see it is answered
 * the team and records nothing. An id held by something other than a team is
 * a conflict, wherever it is in the body: the table holds each id once,
 * whatever it is on. So is an id on a team the caller cannot see, before
 * anything is recorded on it.
 *
 * `orphans` are the `external_ids` rows of asked ids whose team row is gone.
 * They name nothing, so a team made now takes them over.
 */
async function heldTeam(
  trx: Transaction<Database>,
  body: CreateTeamBody,
  caller: CreatorAccess
): Promise<{ held?: CreateTeamResponse; orphans: string[] }> {
  const orphans: string[] = []
  if (body.externalIds.length === 0) return { orphans }
  const rows = await trx
    .selectFrom('external_ids')
    .select(['id', 'entity_type', 'entity_id', 'system', 'kind', 'external_id'])
    .where(eb =>
      eb.or(
        body.externalIds.map(one =>
          eb.and([
            eb('system', '=', one.system),
            eb('kind', '=', one.kind),
            eb('external_id', '=', one.id)
          ])
        )
      )
    )
    .execute()

  const find = (one: ExternalIdKey): (typeof rows)[number] | undefined =>
    rows.find(
      held =>
        held.system === one.system &&
        held.kind === one.kind &&
        held.external_id === one.id
    )
  for (const one of body.externalIds) {
    const row = find(one)
    if (row != null && row.entity_type !== 'team') {
      throw conflict(
        `${one.system} ${one.kind} ${one.id} is already on a ${row.entity_type}`
      )
    }
  }

  // In the order the body gave them, so the answer does not depend on how
  // the database happened to return the rows.
  for (const one of body.externalIds) {
    const row = find(one)
    if (row == null) continue
    const teamId = await followMerges(trx, row.entity_id)
    const team = await trx
      .selectFrom('teams')
      .select(['id', 'name'])
      .where('id', '=', teamId)
      .executeTakeFirst()
    if (team == null) {
      orphans.push(row.id)
      continue
    }
    if (!(await caller.maySee(team.id))) {
      throw conflict('That id is already on a team you cannot see')
    }
    // The ids the body names that nothing holds yet are this team's too,
    // and its administrators' to record on it rather than drop.
    if (await caller.mayManage(team.id)) {
      for (const other of body.externalIds) {
        if (find(other) == null) {
          await recordExternalId(trx, 'team', team.id, other)
        }
      }
    }
    return {
      held: { id: team.id, name: team.name, created: false, season: null },
      orphans
    }
  }
  return { orphans }
}

/**
 * The season named by id, which must exist and which the caller must
 * administer, as a season or league administrator; or by name and year: the
 * first one called that in that year, ignoring case and outer spaces, that
 * the caller administers, else a new one in no league.
 */
async function resolveSeason(
  trx: Transaction<Database>,
  asked: NonNullable<CreateTeamBody['season']>,
  caller: CreatorAccess
): Promise<CreatedTeamSeason> {
  if ('id' in asked) {
    const season = await trx
      .selectFrom('seasons')
      .select(['id', 'name', 'year'])
      .where('id', '=', asked.id)
      .executeTakeFirst()
    if (season == null) throw notFound(`No season ${asked.id}`)
    if (!(await caller.administersSeason(season.id))) {
      throw forbidden(
        'Only an administrator of the season or its league may add a team to it'
      )
    }
    return { ...season, created: false }
  }

  const named = await trx
    .selectFrom('seasons')
    .select(['id', 'name', 'year'])
    .where(sql<boolean>`lower(btrim(name)) = lower(${asked.name})`)
    .where('year', '=', asked.year)
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  for (const held of named) {
    if (await caller.administersSeason(held.id)) {
      return { ...held, created: false }
    }
  }

  const id = makeId('season')
  await trx
    .insertInto('seasons')
    .values({
      id,
      // Null on purpose: a league is something a person makes and moves
      // seasons into, not something a team implies.
      league_id: null,
      name: asked.name,
      year: asked.year
    })
    .execute()
  return { id, name: asked.name, year: asked.year, created: true }
}
