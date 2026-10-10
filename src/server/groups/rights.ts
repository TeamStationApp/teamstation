import type { Kysely } from 'kysely'

import { forbidden, notFound, unauthorized } from '../../common/errors'
import type { GroupRef } from '../../common/groupCreation'
import { adminScopes } from '../access'
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

/** Snapshot recipients for resolved information; pending requests always use live rights. */
export async function adminRecipients(
  db: Kysely<Database>,
  refs: GroupRef[]
): Promise<number[]> {
  const roles = await db
    .selectFrom('scope_roles')
    .select('user_id')
    .where('role', '=', 'admin')
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
  const recipients: number[] = []
  for (const user of users) {
    for (const ref of refs) {
      if (
        await canAdminister(
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
