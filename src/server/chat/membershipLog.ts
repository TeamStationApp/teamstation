import { type Kysely, sql } from 'kysely'

import {
  GENESIS_HASH,
  type LogEvent,
  logRowHash
} from '../../common/chatCrypto/logHash'
import type { Database } from '../db/database'

/**
 * Writing a conversation's membership: `chat_members`, the hash-chained
 * `chat_membership_log`, grant requests for joiners, and the `chat_changes`
 * notify. Every function here runs inside the transaction that holds the
 * conversation's row `for update`, so two writers never extend the chain
 * from the same `prev_hash`.
 *
 * Each log row's `at` is written as the very millisecond its hash covers
 * (the column's default would carry microseconds the hash does not).
 *
 * **Reasons** carried by log rows:
 *
 * - `join`: `audience` (the reconciler), `created` (in a new DM),
 *   `added` (added to a DM), `merged` (a survivor taking a closed row's
 *   place);
 * - `leave`: `audience`, `left` (left a DM), `notEligible` (no longer an
 *   account, or under 13), `merged`;
 * - `closed`: `pairRule` or `adultRequired`, with `user_id` the player the
 *   broken rule protects and `actor_user_id` the member whose leave closed
 *   it (null when the reconciler closed it).
 */

/** The channel every chat writer notifies, inside its transaction. */
export const CHAT_CHANGES_CHANNEL = 'chat_changes'

export type ChatChangeKind = 'message' | 'members' | 'epoch' | 'grant' | 'read'

export interface LogEntry {
  event: LogEvent
  userId: string
  actorUserId: string | null
  reason: string | null
}

/**
 * `pg_notify('chat_changes', { c, k, seq? })`, sent when the transaction
 * commits. `seq` is a new message's, or a moved read cursor's.
 */
export async function notifyChat(
  trx: Kysely<Database>,
  conversationId: string,
  kind: ChatChangeKind,
  seq?: number
): Promise<void> {
  const payload = JSON.stringify(
    seq == null
      ? { c: conversationId, k: kind }
      : { c: conversationId, k: kind, seq }
  )
  await sql`select pg_notify(${CHAT_CHANGES_CHANNEL}, ${payload})`.execute(trx)
}

export type ChatUserChangeKind = 'link' | 'devices' | 'preferences'

/**
 * `pg_notify('chat_changes', { u, k })`: something about one user's own chat
 * devices changed (`devices`), or a link to a new device was asked for or
 * approved (`link`). Sent when the transaction commits.
 */
export async function notifyChatUser(
  trx: Kysely<Database>,
  userId: string,
  kind: ChatUserChangeKind
): Promise<void> {
  const payload = JSON.stringify({ u: userId, k: kind })
  await sql`select pg_notify(${CHAT_CHANGES_CHANNEL}, ${payload})`.execute(trx)
}

/** Appends rows to the conversation's log, each hashed onto the last. */
export async function appendLog(
  trx: Kysely<Database>,
  conversationId: string,
  entries: LogEntry[],
  now: Date
): Promise<void> {
  if (entries.length === 0) return
  const counter = await trx
    .updateTable('chat_conversations')
    .set(eb => ({ last_log_seq: eb('last_log_seq', '+', entries.length) }))
    .where('id', '=', conversationId)
    .returning(['last_log_seq'])
    .executeTakeFirstOrThrow()
  const first = Number(counter.last_log_seq) - entries.length + 1
  const previous =
    first === 1
      ? undefined
      : await trx
          .selectFrom('chat_membership_log')
          .select(['hash'])
          .where('conversation_id', '=', conversationId)
          .where('seq', '=', first - 1)
          .executeTakeFirstOrThrow()
  let prevHash: Uint8Array =
    previous == null ? GENESIS_HASH : new Uint8Array(previous.hash)
  // The hash covers milliseconds; the row stores exactly that instant.
  const at = new Date(Math.floor(now.getTime()))
  const rows = entries.map((entry, index) => {
    const seq = first + index
    const hash = logRowHash(prevHash, {
      conversationId,
      seq,
      event: entry.event,
      userId: entry.userId,
      actorUserId: entry.actorUserId,
      reason: entry.reason,
      at
    })
    const row = {
      conversation_id: conversationId,
      seq,
      event: entry.event,
      user_id: entry.userId,
      actor_user_id: entry.actorUserId,
      reason: entry.reason,
      prev_hash: prevHash,
      hash,
      at
    }
    prevHash = hash
    return row
  })
  await trx.insertInto('chat_membership_log').values(rows).execute()
}

/**
 * Puts these people in the conversation (back in, for anybody who had
 * left), writes their `join` rows, and opens grant requests for those who
 * have a chat identity.
 */
export async function joinMembers(
  trx: Kysely<Database>,
  conversationId: string,
  userIds: string[],
  actorUserId: string | null,
  reason: string,
  now: Date
): Promise<void> {
  if (userIds.length === 0) return
  await trx
    .insertInto('chat_members')
    .values(
      userIds.map(userId => ({
        conversation_id: conversationId,
        user_id: userId,
        joined_at: now,
        left_at: null
      }))
    )
    .onConflict(oc =>
      oc
        .columns(['conversation_id', 'user_id'])
        .doUpdateSet({ joined_at: now, left_at: null })
    )
    .execute()
  await appendLog(
    trx,
    conversationId,
    userIds.map(userId => ({ event: 'join', userId, actorUserId, reason })),
    now
  )
  await openGrantRequests(trx, conversationId, userIds)
}

/**
 * Takes these people out of the conversation, writes their `leave` rows,
 * and flags the conversation for a new epoch, so they cannot read what is
 * sent after.
 */
export async function leaveMembers(
  trx: Kysely<Database>,
  conversationId: string,
  userIds: string[],
  actorUserId: string | null,
  reason: string,
  now: Date
): Promise<void> {
  if (userIds.length === 0) return
  await trx
    .updateTable('chat_members')
    .set({ left_at: now })
    .where('conversation_id', '=', conversationId)
    .where('user_id', 'in', userIds)
    .execute()
  await appendLog(
    trx,
    conversationId,
    userIds.map(userId => ({ event: 'leave', userId, actorUserId, reason })),
    now
  )
  await trx
    .updateTable('chat_conversations')
    .set({ needs_rotation: true })
    .where('id', '=', conversationId)
    .execute()
}

/** Closes a conversation for good (read-only), with a `closed` row. */
export async function closeConversation(
  trx: Kysely<Database>,
  conversationId: string,
  entry: { userId: string; actorUserId: string | null; reason: string },
  now: Date
): Promise<void> {
  await trx
    .updateTable('chat_conversations')
    .set({ closed_at: now })
    .where('id', '=', conversationId)
    .execute()
  await appendLog(trx, conversationId, [{ event: 'closed', ...entry }], now)
}

/**
 * Opens a grant request for each of these members who has a chat identity
 * and no box for the conversation's latest epoch at their current per-user
 * key generation, and notifies `grant` when any was opened. A conversation
 * with no epoch yet has nothing to grant; a member without an identity gets
 * theirs when they enrol. `identityReset` marks requests opened for an
 * identity that replaced one the conversation had seen, which only an
 * approver may fill.
 */
export async function openGrantRequests(
  trx: Kysely<Database>,
  conversationId: string,
  userIds: string[],
  identityReset = false
): Promise<number> {
  if (userIds.length === 0) return 0
  const latest = await trx
    .selectFrom('chat_epochs')
    .select(eb => eb.fn.max('epoch').as('epoch'))
    .where('conversation_id', '=', conversationId)
    .executeTakeFirst()
  const epoch = latest?.epoch
  if (epoch == null) return 0
  const keys = await trx
    .selectFrom('chat_identities')
    .innerJoin('chat_user_keys', join =>
      join
        .onRef('chat_user_keys.identity_id', '=', 'chat_identities.id')
        .onRef('chat_user_keys.user_id', '=', 'chat_identities.user_id')
    )
    .select([
      'chat_identities.user_id as userId',
      'chat_identities.id as identityId',
      eb => eb.fn.max('chat_user_keys.generation').as('generation')
    ])
    .where('chat_identities.user_id', 'in', userIds)
    .where('chat_identities.replaced_at', 'is', null)
    .groupBy(['chat_identities.user_id', 'chat_identities.id'])
    .execute()
  let opened = 0
  for (const key of keys) {
    const boxed = await trx
      .selectFrom('chat_epoch_boxes')
      .select(['epoch'])
      .where('conversation_id', '=', conversationId)
      .where('epoch', '=', epoch)
      .where('user_id', '=', key.userId)
      .where('identity_id', '=', key.identityId)
      .where('generation', '=', key.generation)
      .executeTakeFirst()
    if (boxed != null) continue
    const made = await trx
      .insertInto('chat_grant_requests')
      .values({
        conversation_id: conversationId,
        user_id: key.userId,
        identity_id: key.identityId,
        generation: key.generation,
        identity_reset: identityReset
      })
      .onConflict(oc =>
        oc
          .columns(['conversation_id', 'user_id', 'identity_id', 'generation'])
          .where('filled_at', 'is', null)
          .where('superseded_at', 'is', null)
          .doNothing()
      )
      .returning(['id'])
      .executeTakeFirst()
    if (made != null) opened += 1
  }
  if (opened > 0) await notifyChat(trx, conversationId, 'grant')
  return opened
}

/** Who is in a conversation now. */
export async function currentMembers(
  trx: Kysely<Database>,
  conversationId: string
): Promise<string[]> {
  const rows = await trx
    .selectFrom('chat_members')
    .select(['user_id'])
    .where('conversation_id', '=', conversationId)
    .where('left_at', 'is', null)
    .orderBy('user_id')
    .execute()
  return rows.map(row => row.user_id)
}

/**
 * Runs `work` in a transaction: `db`'s own when it already is one, a new one
 * otherwise.
 */
export async function inTransaction<T>(
  db: Kysely<Database>,
  work: (trx: Kysely<Database>) => Promise<T>
): Promise<T> {
  if (db.isTransaction) return await work(db)
  return await db.transaction().execute(work)
}
