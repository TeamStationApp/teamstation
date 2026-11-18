import type { Kysely } from 'kysely'

import { forbidden, notFound, unauthorized } from '../../common/errors'
import type { GroupRef } from '../../common/groupCreation'
import {
  adminScopes,
  type RoleScopes,
  roleScopes,
  roleScopesForUsers
} from '../access'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { accountReadOnce, readOnce } from '../db/readOnce'
import { teamFacts } from '../teams/teamFacts'

/**
 * The actor as their account stands now, or a refusal. A machine token may
 * not manage organizations. Tess may, on the person's own session: each of
 * her writes runs only once the person holds Confirm on the card showing it.
 */
export async function currentActor(
  db: Kysely<Database>,
  actor: Actor
): Promise<Actor> {
  if (actor.apiTokenId != null)
    throw forbidden('Sign in to manage organizations')
  const lookup = db
    .selectFrom('users')
    .select(['is_admin', 'disabled_at', 'merged_into', 'login_enabled'])
    .where('id', '=', actor.userId)
  // Management writes hold the shared graph lock. Locking the actor row as
  // well would invert the game/scorer foreign-key order during live scoring.
  const user = await accountReadOnce(
    db,
    actor.userId,
    async () => await lookup.executeTakeFirst()
  )
  if (
    user == null ||
    user.disabled_at != null ||
    user.merged_into != null ||
    !user.login_enabled
  )
    throw unauthorized()
  return { ...actor, isAdmin: user.is_admin }
}
export async function canAdminister(
  db: Kysely<Database>,
  actor: Actor,
  group: GroupRef
): Promise<boolean> {
  const fresh = await currentActor(db, actor)
  if (group.kind === 'team') {
    const team = await teamFacts(db, group.id)
    if (team?.kind === 'external') {
      if (team.custodian_type == null || team.custodian_id == null) return false
      if (
        team.custodian_type === 'team' &&
        (await teamFacts(db, team.custodian_id))?.kind !== 'full'
      )
        return false
      return await canAdminister(db, fresh, {
        kind: team.custodian_type,
        id: team.custodian_id
      })
    }
  }
  const scopes = await adminScopes(db, fresh.userId, fresh.isAdmin)
  return (
    scopes.isAdmin ||
    (group.kind === 'league'
      ? scopes.leagueIds
      : group.kind === 'season'
        ? scopes.seasonIds
        : scopes.teamIds
    ).has(group.id)
  )
}
export async function requireGroupAdmin(
  db: Kysely<Database>,
  actor: Actor,
  group: GroupRef
): Promise<void> {
  const table =
    group.kind === 'league'
      ? 'leagues'
      : group.kind === 'season'
        ? 'seasons'
        : 'teams'
  if (
    (await readOnce(
      db,
      `${table}:${group.id}:exists`,
      async () =>
        await db
          .selectFrom(table)
          .select('id')
          .where('id', '=', group.id)
          .executeTakeFirst()
    )) == null
  )
    throw notFound()
  if (!(await canAdminister(db, actor, group)))
    throw forbidden('Only an administrator can manage this group')
}

/**
 * Whether somebody may manage this level's people: give and take away every
 * role but Admin, and membership. Its administrators, coaches and assistants,
 * set on the level or carried down from one above it. Who is an
 * administrator is for administrators alone (`requirePeopleManager`). A
 * placeholder team's people are its custodian's administrators' to manage.
 */
export async function canManagePeople(
  db: Kysely<Database>,
  actor: Actor,
  group: GroupRef
): Promise<boolean> {
  if (await canAdminister(db, actor, group)) return true
  const fresh = await currentActor(db, actor)
  const scopes = await roleScopes(db, fresh.userId, fresh.isAdmin)
  const key =
    group.kind === 'league'
      ? 'leagueIds'
      : group.kind === 'season'
        ? 'seasonIds'
        : 'teamIds'
  return scopes.coach[key].has(group.id) || scopes.assistant[key].has(group.id)
}

/** Team scheduling belongs to its administrators, coaches and assistants. */
export async function canScheduleFor(
  db: Kysely<Database>,
  actor: Actor,
  group: GroupRef
): Promise<boolean> {
  return group.kind === 'team'
    ? await canManagePeople(db, actor, group)
    : await canAdminister(db, actor, group)
}
export async function requireScheduler(
  db: Kysely<Database>,
  actor: Actor,
  group: GroupRef
): Promise<void> {
  const table =
    group.kind === 'team'
      ? 'teams'
      : group.kind === 'season'
        ? 'seasons'
        : 'leagues'
  if (
    (await readOnce(
      db,
      `${table}:${group.id}:exists`,
      async () =>
        await db
          .selectFrom(table)
          .select('id')
          .where('id', '=', group.id)
          .executeTakeFirst()
    )) == null
  )
    throw notFound()
  if (!(await canScheduleFor(db, actor, group)))
    throw forbidden(
      group.kind === 'team'
        ? 'Only team administrators, coaches and assistants may schedule for this team'
        : 'Only an administrator may schedule for this group'
    )
}

/**
 * `canManagePeople`, or 404 for somebody who is neither an administrator,
 * coach nor assistant here, so a level's people are not confirmed to anybody
 * else; and 403 for a coach or assistant asking to change who is an
 * administrator (`touchesAdmin`).
 */
export async function requirePeopleManager(
  db: Kysely<Database>,
  actor: Actor,
  group: GroupRef,
  touchesAdmin = false
): Promise<void> {
  if (await canAdminister(db, actor, group)) return
  if (!(await canManagePeople(db, actor, group))) throw notFound()
  if (touchesAdmin)
    throw forbidden('Only an administrator can change who is an administrator')
}

/** Snapshot recipients for resolved information; pending requests always use live rights. */
export async function adminRecipients(
  db: Kysely<Database>,
  refs: GroupRef[]
): Promise<string[]> {
  return await groupRecipients(db, refs, false)
}
export async function schedulingRecipients(
  db: Kysely<Database>,
  refs: GroupRef[]
): Promise<string[]> {
  return await groupRecipients(db, refs, true)
}
async function groupRecipients(
  db: Kysely<Database>,
  refs: GroupRef[],
  scheduling: boolean
): Promise<string[]> {
  const users = await readOnce(
    db,
    `users:${scheduling ? 'scheduling' : 'admin'}:candidates`,
    async () => await recipientCandidates(db, scheduling)
  )
  // Every candidate's roles in one set of reads, then each ref checked in
  // memory: asking `canScheduleFor` per candidate read their roles again
  // for every ref, and a publication asks for every game it proposes.
  const targets = await Promise.all(
    refs.map(async ref => await adminTarget(db, ref))
  )
  const scopes = await roleScopesForUsers(
    db,
    users.map(user => user.id)
  )
  const recipients: string[] = []
  for (const user of users) {
    const held = scopes.get(user.id)
    if (held == null) continue
    if (
      refs.some((ref, i) =>
        scheduling
          ? schedulesFor(held, ref, targets[i])
          : administers(held, targets[i])
      )
    )
      recipients.push(user.id)
  }
  return recipients
}

/**
 * The accounts that can sign in and may hold a group's scheduling (or, not
 * `scheduling`, administration): site administrators, everyone holding one
 * of its roles anywhere, and every team's owners and managers.
 */
async function recipientCandidates(
  db: Kysely<Database>,
  scheduling: boolean
): Promise<Array<{ id: string; is_admin: boolean }>> {
  const roles = await db
    .selectFrom('scope_roles')
    .select('user_id')
    .where(
      'role',
      'in',
      scheduling ? ['admin', 'coach', 'assistant'] : ['admin']
    )
    .execute()
  const owners = await db
    .selectFrom('memberships')
    .select('user_id')
    .where('role', 'in', ['owner', 'manager'])
    .execute()
  const candidates = [...new Set([...roles, ...owners].map(row => row.user_id))]
  const users = await db
    .selectFrom('users')
    .select(['id', 'is_admin'])
    .where(eb =>
      eb.or([
        eb('is_admin', '=', true),
        ...(candidates.length === 0 ? [] : [eb('id', 'in', candidates)])
      ])
    )
    .where('login_enabled', '=', true)
    .where('disabled_at', 'is', null)
    .where('merged_into', 'is', null)
    .execute()
  return users
}

/**
 * The group whose administrators administer `group`, as `canAdminister`
 * decides it: the group itself, or, for a placeholder team, its custodian's,
 * followed up the chain; null when nobody does, a site admin neither.
 */
async function adminTarget(
  db: Kysely<Database>,
  group: GroupRef
): Promise<GroupRef | null> {
  if (group.kind !== 'team') return group
  const team = await teamFacts(db, group.id)
  if (team?.kind !== 'external') return group
  if (team.custodian_type == null || team.custodian_id == null) return null
  if (
    team.custodian_type === 'team' &&
    (await teamFacts(db, team.custodian_id))?.kind !== 'full'
  )
    return null
  return await adminTarget(db, {
    kind: team.custodian_type,
    id: team.custodian_id
  })
}

function scopeKey(group: GroupRef): 'leagueIds' | 'seasonIds' | 'teamIds' {
  return group.kind === 'league'
    ? 'leagueIds'
    : group.kind === 'season'
      ? 'seasonIds'
      : 'teamIds'
}

/**
 * `canAdminister`, from scopes already read and the ref's `adminTarget`. A
 * placeholder team nobody administers (no target) is nobody's, a site
 * admin's neither, as there.
 */
export function administers(
  scopes: RoleScopes,
  target: GroupRef | null
): boolean {
  if (target == null) return false
  return scopes.isAdmin || scopes.admin[scopeKey(target)].has(target.id)
}

/** `canScheduleFor`, from scopes already read. */
export function schedulesFor(
  scopes: RoleScopes,
  group: GroupRef,
  target: GroupRef | null
): boolean {
  if (administers(scopes, target)) return true
  if (group.kind !== 'team') return false
  return (
    scopes.coach.teamIds.has(group.id) || scopes.assistant.teamIds.has(group.id)
  )
}
