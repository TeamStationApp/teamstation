import { type Kysely, sql } from 'kysely'

import { conflict, HttpError, unauthorized } from '../../common/errors'
import type { GroupRef } from '../../common/groupCreation'
import { activeNodeIds } from '../admin/nodeAdministration'
import { MERGE_LOCK, onePerson } from '../admin/people'
import { signOutEverywhere } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { requireDirectAdmin } from '../groups/adminGuard'
import { groupName } from '../invites/grants'
import { revokeStreams } from '../live/revokeStreams'
import { eraseAnalytics } from '../observability/analytics'

/** What a deleted account is called wherever it still appears. */
export const DELETED_NAME = 'Deleted user'

/**
 * Deletes the signed-in person's account, which cannot be undone.
 *
 * The rows stay: a deleted person who played still has plays, stat lines and
 * roster places, and every one of those reads the name from `users`. So the
 * row is emptied rather than removed. Its name becomes "Deleted user", here
 * and on the requests it sent to other people's inboxes; its
 * addresses, password, picture, bats and throws, walk-up songs, family links,
 * roles, follows, tags, notifications and Tess conversation go; and it is
 * marked deleted, which
 * keeps it disabled for good: no sign-in, no lifted suspension and no import
 * gives it a way in, a role or a family link again. Its import ids and RSVPs
 * stay, with its plays and stats, so a later import of a game it played in
 * still credits the deleted row rather than making a second person.
 *
 * Every row merged into the account is emptied the same way. A merged row's
 * addresses still sign in, landing on the open row, so leaving them would leave
 * a door into the account just deleted. Pending sign-in codes and links for
 * those addresses are spent for the same reason, and every session, machine
 * token, OAuth grant and stream key of each row is revoked.
 *
 * A person who is the last direct administrator of a team, season or league
 * cannot delete their account until somebody else administers it, as with
 * suspension; nor can the last node administrator.
 *
 * It takes the merge lock so that no merge adds a row to the person between
 * reading who they are and emptying them. Returns the ids it emptied, whose
 * uploaded pictures the caller deletes from storage once this has committed.
 */
export async function deleteAccount(
  db: Kysely<Database>,
  userId: string,
  at = new Date()
): Promise<string[]> {
  return await atomic(db, async trx => {
    await lockKeys(trx, [
      'creation:parent-graph',
      'node:administration',
      MERGE_LOCK
    ])
    const user = await trx
      .selectFrom('users')
      .select('is_admin')
      .where('id', '=', userId)
      .where('merged_into', 'is', null)
      .where('login_enabled', '=', true)
      .forUpdate()
      .executeTakeFirst()
    if (user == null) throw unauthorized()
    if (user.is_admin && (await activeNodeIds(trx)).every(id => id === userId))
      throw conflict(
        'Add another node administrator before deleting this account'
      )

    const { userIds } = await onePerson(trx, userId)
    const emails = (
      await trx
        .selectFrom('user_emails')
        .select('email')
        .where('user_id', 'in', userIds)
        .execute()
    ).map(row => row.email.toLowerCase())
    // What they administer, read before their roles go and checked after.
    const administered: GroupRef[] = [
      ...(
        await trx
          .selectFrom('scope_roles')
          .select(['scope_type', 'scope_id'])
          .where('user_id', 'in', userIds)
          .where('role', '=', 'admin')
          .execute()
      ).map(row => ({ kind: row.scope_type, id: row.scope_id })),
      ...(
        await trx
          .selectFrom('memberships')
          .select('team_id')
          .where('user_id', 'in', userIds)
          .where('role', 'in', ['owner', 'manager'])
          .execute()
      ).map(row => ({ kind: 'team' as const, id: row.team_id }))
    ]
    const groups = [
      ...new Map(
        administered.map(ref => [`${ref.kind}:${ref.id}`, ref])
      ).values()
    ]
    if (emails.length > 0) {
      await trx
        .updateTable('email_codes')
        .set({ consumed_at: at })
        .where(sql<string>`lower(email)`, 'in', emails)
        .where('consumed_at', 'is', null)
        .execute()
      await trx
        .deleteFrom('user_emails')
        .where('user_id', 'in', userIds)
        .execute()
    }
    await trx
      .updateTable('users')
      .set({
        display_name: DELETED_NAME,
        // All of it as the first name, so the short name every roster and
        // box score draws is "Deleted user" too, never "Deleted u".
        first_name: DELETED_NAME,
        last_name: null,
        username: null,
        password_hash: null,
        login_enabled: false,
        disabled_at: at,
        deleted_at: at,
        is_admin: false,
        bats: null,
        throws: null,
        bats_source: null,
        picture_catalog_id: null,
        avatar_path: null,
        avatar_sha256: null,
        avatar_source: null,
        avatar_updated_at: at,
        updated_at: at
      })
      .where('id', 'in', userIds)
      .execute()
    await trx
      .deleteFrom('walk_up_songs')
      .where('user_id', 'in', userIds)
      .execute()
    await trx
      .deleteFrom('user_links')
      .where(eb =>
        eb.or([
          eb('user_id', 'in', userIds),
          eb('related_user_id', 'in', userIds)
        ])
      )
      .execute()
    await trx
      .deleteFrom('scope_roles')
      .where('user_id', 'in', userIds)
      .execute()
    // What they followed, how they were tagged, and their notifications.
    await trx.deleteFrom('follows').where('user_id', 'in', userIds).execute()
    await trx.deleteFrom('user_tags').where('user_id', 'in', userIds).execute()
    await trx
      .deleteFrom('notification_receipts')
      .where('user_id', 'in', userIds)
      .execute()
    // Their conversation with Tess: what they said and attached, the changes
    // she proposed, and the tokens it used.
    for (const table of [
      'tess_messages',
      'tess_attachments',
      'tess_changes',
      'tess_conversations',
      'tess_usage_weeks'
    ] as const)
      await trx.deleteFrom(table).where('user_id', 'in', userIds).execute()
    // Requests that are theirs or about them. Pending ones end here: a
    // guardian link or a membership accepted later would bring back what
    // this removes. One a team sent through them stays the team's.
    const ids = sql.join(userIds)
    const about = sql`(
      (sender_id in (${ids}) and sender_scope_type is null)
      or terms->>'playerUserId' in (${ids})
      or terms->'guardian'->>'userId' in (${ids})
      or terms->>'recipientUserId' in (${ids})
    )`
    const cancelled = (
      await sql<{ id: string }>`update group_requests
        set status = 'cancelled', resolved_at = ${at}, resolved_by = ${userId}
        where status = 'pending' and ${about}
        returning id`.execute(trx)
    ).rows.map(row => row.id)
    if (cancelled.length > 0)
      await trx
        .updateTable('invites')
        .set({ revoked_at: at })
        .where('request_id', 'in', cancelled)
        .where('revoked_at', 'is', null)
        .execute()
    // Still on the roster as a player, no longer running the team.
    await trx
      .updateTable('memberships')
      .set({ role: 'member' })
      .where('user_id', 'in', userIds)
      .where('role', 'in', ['owner', 'manager'])
      .execute()
    // Every group they would leave with nobody to run it, named at once.
    const unattended: string[] = []
    for (const ref of groups) {
      try {
        await requireDirectAdmin(trx, ref)
      } catch (error) {
        if (!(error instanceof HttpError) || error.code !== 'conflict')
          throw error
        unattended.push(await groupName(trx, ref))
      }
    }
    unattended.sort()
    if (unattended.length > 0)
      throw conflict(
        `Add another administrator to ${listOf(unattended)} before deleting your account`
      )
    await signOutEverywhere(trx, userIds, at)
    await eraseAnalytics(trx, userIds)
    await revokeStreams(
      trx,
      userIds,
      'The publishing account was deleted. Ask for a new stream URL.',
      at
    )
    return userIds
  })
}

/** `A`, `A and B`, `A, B and C`. */
function listOf(names: string[]): string {
  return names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
