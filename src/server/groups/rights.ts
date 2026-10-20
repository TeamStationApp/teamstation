import type { Kysely } from 'kysely'

import { forbidden, notFound, unauthorized } from '../../common/errors'
import type { GroupRef } from '../../common/groupCreation'
import { adminScopes, roleScopes } from '../access'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'

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
  const user = await lookup.executeTakeFirst()
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
    const team = await db
      .selectFrom('teams')
      .select(['kind', 'custodian_type', 'custodian_id'])
      .where('id', '=', group.id)
      .executeTakeFirst()
    if (team?.kind === 'external') {
      if (team.custodian_type == null || team.custodian_id == null) return false
      if (
        team.custodian_type === 'team' &&
        (
          await db
            .selectFrom('teams')
            .select('kind')
            .where('id', '=', team.custodian_id)
            .executeTakeFirst()
        )?.kind !== 'full'
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
    (await db
      .selectFrom(table)
      .select('id')
      .where('id', '=', group.id)
      .executeTakeFirst()) == null
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
    (await db
      .selectFrom(table)
      .select('id')
      .where('id', '=', group.id)
      .executeTakeFirst()) == null
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
  const recipients: string[] = []
  for (const user of users) {
    for (const ref of refs) {
      if (
        await (scheduling ? canScheduleFor : canAdminister)(
          db,
          { userId: user.id, isAdmin: user.is_admin, scopes: [] },
          ref
        )
      ) {
        recipients.push(user.id)
        break
      }
    }
  }
  return recipients
}
