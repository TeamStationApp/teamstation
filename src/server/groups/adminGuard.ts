import type { Kysely } from 'kysely'

import { conflict, forbidden, notFound } from '../../common/errors'
import type { GroupRef } from '../../common/groupCreation'
import { onePerson } from '../admin/people'
import type { Database } from '../db/database'
import { currentActor, requireGroupAdmin, requirePeopleManager } from './rights'

/** Direct active administrators survive removal of any inherited parent edge. */
export async function directAdminIds(
  db: Kysely<Database>,
  ref: GroupRef
): Promise<number[]> {
  const granted = await db
    .selectFrom('scope_roles')
    .innerJoin('users', 'users.id', 'scope_roles.user_id')
    .select('users.id')
    .where('scope_type', '=', ref.kind)
    .where('scope_id', '=', ref.id)
    .where('role', '=', 'admin')
    .where('users.login_enabled', '=', true)
    .where('users.disabled_at', 'is', null)
    .where('users.merged_into', 'is', null)
    .execute()
  const owners =
    ref.kind !== 'team'
      ? []
      : await db
          .selectFrom('memberships')
          .innerJoin('users', 'users.id', 'memberships.user_id')
          .select('users.id')
          .where('team_id', '=', ref.id)
          .where('role', 'in', ['owner', 'manager'])
          .where('users.login_enabled', '=', true)
          .where('users.disabled_at', 'is', null)
          .where('users.merged_into', 'is', null)
          .execute()
  return [...new Set([...granted, ...owners].map(row => row.id))]
}

export async function requireDirectAdmin(
  db: Kysely<Database>,
  ref: GroupRef
): Promise<void> {
  if (
    ref.kind === 'team' &&
    (
      await db
        .selectFrom('teams')
        .select('kind')
        .where('id', '=', ref.id)
        .executeTakeFirst()
    )?.kind === 'external'
  )
    return
  if ((await directAdminIds(db, ref)).length === 0)
    throw conflict(
      'Add another active direct administrator before removing the last one'
    )
}

/**
 * Whose say a change to somebody's place in a group needs: an
 * administrator's (`admin`); an administrator's, coach's or assistant's, for
 * anything but who is an administrator (`manager`); or the person's own, to
 * leave or step down (`self`).
 */
export type PersonChangeAuthority = 'admin' | 'manager' | 'self'

export async function authorizePersonChange(
  db: Kysely<Database>,
  ref: GroupRef,
  targetId: number,
  actorId: number,
  grantAdmin = false,
  authority: PersonChangeAuthority = 'admin'
): Promise<void> {
  const actor = await currentActor(db, {
    userId: actorId,
    isAdmin: false,
    scopes: []
  })
  if (authority === 'self') {
    if (!(await onePerson(db, actorId)).userIds.includes(targetId))
      throw forbidden('Only they can leave or step down themselves')
    return
  }
  if (authority === 'manager') await requirePeopleManager(db, actor, ref)
  else await requireGroupAdmin(db, actor, ref)
  if (
    grantAdmin &&
    ref.kind === 'team' &&
    (
      await db
        .selectFrom('teams')
        .select('kind')
        .where('id', '=', ref.id)
        .executeTakeFirst()
    )?.kind === 'external'
  )
    throw conflict(
      'Invite a verified administrator to manage this placeholder team first'
    )
  const target = await db
    .selectFrom('users')
    .select(['is_admin', 'login_enabled', 'disabled_at', 'merged_into'])
    .where('id', '=', targetId)
    .executeTakeFirst()
  if (target == null || target.merged_into != null) throw notFound()
  if (target.is_admin && !actor.isAdmin)
    throw forbidden(
      'Only a node administrator can change another node administrator'
    )
  if (grantAdmin && (!target.login_enabled || target.disabled_at != null))
    throw conflict('The replacement must first verify their email and sign in')
}
