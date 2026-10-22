import { type Kysely, sql } from 'kysely'

import type { GroupRef } from '../../common/groupCreation'
import { makeId } from '../../common/ids'
import { type Role, ROLES } from '../../common/roles'
import { onePerson } from '../admin/people'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import type { AddedNotice } from '../email/sendMail'
import { grantInformation, roleList } from '../notifications/requestInformation'
import { groupScopeIds, noteScopeChange } from '../socket/syncRevision'
import { addToScope, rolesAt } from './people'

/**
 * Adding somebody to a team, a season or a league, with no acceptance.
 *
 * Membership and every role, Admin included, take effect the moment they are
 * given. The person is told in their inbox ("Dana Lee added you as Coach of
 * Owls"), with a **Leave** that takes them out again, and anybody can leave a
 * level or step down from one role of their own. Only an address no account
 * holds yet still waits, as an invitation, for whoever verifies it; and a
 * guardian is never added this way.
 */

/** What can be given at a level: a role, or a plain membership. */
export type Grantable = Role | 'member'

export const GRANTABLE: readonly Grantable[] = [...ROLES, 'member']

/** What one person holds at exactly this level, nothing inherited. */
export interface Held {
  /** Admin first, then the flags; a team's owner or manager is its admin. */
  roles: Role[]
  /** A membership of this level itself: a team's, a season's, a league's. */
  member: boolean
}

/**
 * What somebody holds at this one level. A team's membership is the row's
 * own; a season's or league's is read across every row of the person, as
 * `visibleScopes` reads it, since a merge leaves those where they were.
 */
export async function heldAt(
  db: Kysely<Database>,
  ref: GroupRef,
  userId: string
): Promise<Held> {
  const roles = await rolesAt(db, ref.kind, ref.id, userId)
  if (ref.kind === 'team') {
    const membership = await db
      .selectFrom('memberships')
      .select('role')
      .where('team_id', '=', ref.id)
      .where('user_id', '=', userId)
      .executeTakeFirst()
    const owner = membership?.role === 'owner' || membership?.role === 'manager'
    return {
      roles: owner && !roles.includes('admin') ? ['admin', ...roles] : roles,
      member: membership != null
    }
  }
  const rows = (await onePerson(db, userId)).userIds
  const member =
    ref.kind === 'season'
      ? await db
          .selectFrom('season_members')
          .select('id')
          .where('season_id', '=', ref.id)
          .where('user_id', 'in', rows)
          .executeTakeFirst()
      : await db
          .selectFrom('league_members')
          .select('id')
          .where('league_id', '=', ref.id)
          .where('user_id', 'in', rows)
          .executeTakeFirst()
  return { roles, member: member != null }
}

/**
 * Whether somebody can hold a role: an account that signs in (`login_enabled`,
 * which needs an address), not suspended and not closed into another. Anybody
 * not closed into another can be a member.
 */
export async function canHoldRoles(
  db: Kysely<Database>,
  userId: string
): Promise<boolean> {
  const user = await db
    .selectFrom('users')
    .select('id')
    .where('id', '=', userId)
    .where('login_enabled', '=', true)
    .where('disabled_at', 'is', null)
    .where('merged_into', 'is', null)
    .executeTakeFirst()
  return user != null
}

/**
 * Gives these at this level, adding to what they hold and never taking
 * anything away: a role always brings the level's membership with it. The
 * caller has authorized the change. Answers what was new, `member` first
 * when the membership was.
 */
export async function grantAt(
  db: Kysely<Database>,
  ref: GroupRef,
  userId: string,
  wanted: readonly Grantable[],
  grantedBy: string
): Promise<Grantable[]> {
  return await atomic(db, async trx => {
    await lockKeys(trx, [
      'creation:parent-graph',
      `group:${ref.kind}:${ref.id}`
    ])
    const before = await heldAt(trx, ref, userId)
    const joined = (await addToScope(trx, ref.kind, ref.id, userId)).added
    const roles = ROLES.filter(
      role => wanted.includes(role) && !before.roles.includes(role)
    )
    if (roles.length > 0)
      await trx
        .insertInto('scope_roles')
        .values(
          roles.map(role => ({
            id: makeId('scopeRole'),
            user_id: userId,
            scope_type: ref.kind,
            scope_id: ref.id,
            role,
            granted_by: grantedBy
          }))
        )
        .onConflict(oc =>
          oc.columns(['user_id', 'scope_type', 'scope_id', 'role']).doNothing()
        )
        .execute()
    if (roles.length > 0)
      noteScopeChange(trx, { userId, ...groupScopeIds(ref.kind, ref.id) })
    return [...(joined && !before.member ? ['member' as const] : []), ...roles]
  })
}

/**
 * Tells somebody what they were just given, in their inbox: "Dana Lee added
 * you as Coach of Owls". Nothing to accept; the notification offers to leave
 * the level instead. Nobody is told about what they did themselves, and
 * nothing is said when nothing was new. Answers the notification's id.
 */
export async function notifyGrant(
  db: Kysely<Database>,
  grant: {
    ref: GroupRef
    userId: string
    added: readonly Grantable[]
    actorId: string
    at?: Date
  }
): Promise<string | undefined> {
  const { ref, userId, added, actorId } = grant
  if (added.length === 0) return undefined
  const actor = await onePerson(db, actorId)
  if (actor.userIds.includes(userId)) return undefined
  const [who, group] = await Promise.all([
    db
      .selectFrom('users')
      .select('display_name')
      .where('id', '=', actorId)
      .executeTakeFirstOrThrow(),
    groupName(db, ref)
  ])
  const roles = ROLES.filter(role => added.includes(role))
  const id = makeId('audit')
  await db
    .insertInto('notification_events')
    .values({
      id,
      source_type: 'grant',
      source_id: id,
      revision: 1,
      actor_id: actorId,
      metadata: {
        ...grantInformation(who.display_name, group, roles),
        scope: { kind: ref.kind, id: ref.id },
        roles
      },
      recorded_recipients: [userId],
      ...(grant.at == null ? {} : { created_at: grant.at })
    })
    .execute()
  return id
}

/** A league's, season's or team's name, or a placeholder for one that is gone. */
export async function groupName(
  db: Kysely<Database>,
  ref: GroupRef
): Promise<string> {
  const table =
    ref.kind === 'league'
      ? 'leagues'
      : ref.kind === 'season'
        ? 'seasons'
        : 'teams'
  const row = await db
    .selectFrom(table)
    .select('name')
    .where('id', '=', ref.id)
    .executeTakeFirst()
  return row?.name ?? 'Unavailable group'
}

/**
 * The address to tell somebody at: their primary verified one, else any
 * verified one, else none.
 */
export async function addressOf(
  db: Kysely<Database>,
  userId: string
): Promise<string | undefined> {
  const row = await db
    .selectFrom('user_emails')
    .select('email')
    .where('user_id', '=', userId)
    .where('verified_at', 'is not', null)
    .orderBy('is_primary', 'desc')
    .orderBy('created_at')
    .executeTakeFirst()
  return row?.email
}

/**
 * The account an address names: one that has verified it and can sign in,
 * not suspended or closed into another. None for an address nobody has
 * proved, which is invited instead.
 */
export async function accountForAddress(
  db: Kysely<Database>,
  email: string
): Promise<{ id: string; displayName: string } | undefined> {
  const row = await db
    .selectFrom('user_emails')
    .innerJoin('users', 'users.id', 'user_emails.user_id')
    .select(['users.id', 'users.display_name'])
    .where(sql<string>`lower(email)`, '=', email.toLowerCase())
    .where('verified_at', 'is not', null)
    .where('users.login_enabled', '=', true)
    .where('users.disabled_at', 'is', null)
    .where('users.merged_into', 'is', null)
    .executeTakeFirst()
  return row == null ? undefined : { id: row.id, displayName: row.display_name }
}

/** How the mail that somebody was added goes out, when it does. */
export interface AddedMail {
  publicUrl?: string
  sendAdded?: (email: string, notice: AddedNotice) => Promise<void>
}

/**
 * Mails somebody what a grant's notification says, with a link to it, where
 * they can leave. Sent where an invitation used to be: to the address they
 * were added by, or to their own when they were added to a level they were
 * not in. Thrown on failure, so the caller's transaction undoes the grant
 * rather than leave it untold.
 */
export async function mailGrant(
  db: Kysely<Database>,
  grant: {
    ref: GroupRef
    userId: string
    added: readonly Grantable[]
    actorId: string
    notificationId: string
    email?: string
  },
  mail: AddedMail | undefined
): Promise<void> {
  if (mail?.sendAdded == null) return
  const email = grant.email ?? (await addressOf(db, grant.userId))
  if (email == null) return
  const who = await db
    .selectFrom('users')
    .select('display_name')
    .where('id', '=', grant.actorId)
    .executeTakeFirstOrThrow()
  const base = (mail.publicUrl ?? '').replace(/\/$/, '')
  await mail.sendAdded(email, {
    addedBy: who.display_name,
    scopeName: await groupName(db, grant.ref),
    roles: roleList(ROLES.filter(role => grant.added.includes(role))),
    link: `${base}/notifications/${encodeURIComponent(grant.notificationId)}`
  })
}
