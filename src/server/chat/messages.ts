import { type Kysely, type Selectable, sql } from 'kysely'

import { equalBytes, utf8 } from '../../common/chatCrypto/bytes'
import {
  type EnvelopeKind,
  openWithMessageKey,
  verifyMessage
} from '../../common/chatCrypto/seal'
import { badRequest, conflict, forbidden, notFound } from '../../common/errors'
import { makeId } from '../../common/ids'
import type { ChatKind, ChatMessagesTable, Database } from '../db/database'
import type { MediaContext } from '../media/mediaContext'
import { latestEpoch, lockConversation } from './epochs'
import { type ChatCaller, requireHolder } from './keys'
import { chatPeople, moderatorsOf } from './listing'
import { notifyChat, notifyChatUser } from './membershipLog'
import { clearManualUnread } from './preferences'
import { memberNow } from './reconciler'
import { scopeIdentities, scopesOf, titlesOf } from './titles'
import { b64 } from './wire'

/**
 * Messages, deletes, read cursors and reports.
 *
 * **Posting** (`POST /chat/conversations/:id/messages`). The server sees the
 * envelope: its `kind`, and `target_ids` on the two delete kinds only (what a
 * reaction or an edit points at stays inside the ciphertext). In one
 * transaction holding the conversation's row `for update`:
 *
 * - The id is the client's (`newMessageId()`). A repeat by the same sender
 *   in the same conversation answers the stored row, whatever it carries; the
 *   same id anywhere else is `idTaken`.
 * - A closed conversation refuses every post (`closed`).
 * - The session must be bound to a linked device of the sender (`notHolder`),
 *   since a revoked phone signed in again still holds the identity key.
 * - `sender_identity_id` must be the sender's current identity
 *   (`staleIdentity`), the epoch the latest (`staleEpoch`), and the sender
 *   must hold a box for it under that identity (`locked`).
 * - In `seasonAnnouncements`, `post`, `edit` and `delete` are for season
 *   staff (`notStaff`); a `reaction` is open to every member.
 * - `delete` targets only the sender's own messages (`notYours`);
 *   `moderatorDelete` needs a moderator (`notModerator`). Targets are posts,
 *   edits or reactions in this conversation (400 `target` otherwise). Both
 *   clear each target: `cleared_at` set and its ciphertext emptied, and the
 *   attachments only those targets referenced are deleted, objects first
 *   (through `ChatObjectStore`).
 * - `attachmentIds` (posts only) name completed uploads by the sender in this
 *   conversation (400 `attachment`); they fill `chat_message_attachments`.
 * - The signature must be the sender identity's over the envelope
 *   (`badSignature`).
 * - The message's `seq` comes from `chat_conversations.last_seq`, and the
 *   transaction notifies `chat_changes` with `{ c, k: 'message', seq }`.
 *
 * **Read cursors** only move forward, and a move notifies `read`.
 *
 * **Reports.** The reporter discloses one message's plaintext and its message
 * key. The server copies the row into the report (`envelope`), checks the
 * signature against the identity that signed it (current or since
 * replaced), and opens the stored ciphertext with the key: the report is
 * `verified` when the signature holds and the opened content is exactly the
 * plaintext. A cleared message cannot be reported (`cleared`). A later
 * delete clears the message, never the report's copy.
 */

/** The largest ciphertext a message may carry. */
export const MAX_CIPHERTEXT = 64 * 1024

/** The most targets one delete may name: a post and its edits. */
export const MAX_TARGETS = 500

/** The longest page of `GET …/messages`, and the page without `limit`. */
export const MAX_PAGE = 500
export const DEFAULT_PAGE = 100

/** The two kinds that carry `target_ids`. */
export const DELETE_KINDS: readonly EnvelopeKind[] = [
  'delete',
  'moderatorDelete'
]

/**
 * Where attachment objects live (`spaceObjectStore` in `attachments.ts`).
 * Deletes remove the objects of the attachments they clear through it;
 * without one (no Space) the attachment rows are left for the orphan purge,
 * which takes attachments only cleared messages reference.
 */
export interface ChatObjectStore {
  deleteObjects: (objectKeys: string[]) => Promise<void>
}

export interface MessageBody {
  id: string
  epoch: number
  kind: EnvelopeKind
  senderIdentityId: string
  targetIds: string[] | null
  attachmentIds: string[]
  nonce: Uint8Array
  ciphertext: Uint8Array
  signature: Uint8Array
}

export interface ChatMessageView {
  id: string
  conversationId: string
  seq: number
  epoch: number
  senderUserId: number
  senderIdentityId: string
  kind: EnvelopeKind
  targetIds: string[] | null
  nonce: string
  /** Empty once cleared. */
  ciphertext: string
  signature: string
  attachmentIds: string[]
  clearedAt: string | null
  createdAt: string
}

export interface ReportBody {
  messageId: string
  plaintext: string
  messageKey: Uint8Array
}

/** A report's copy of the message, as it stood when reported. */
export interface ReportEnvelope {
  id: string
  conversationId: string
  seq: number
  epoch: number
  senderUserId: number
  senderIdentityId: string
  senderIdentityKey: string
  kind: EnvelopeKind
  targetIds: string[] | null
  nonce: string
  ciphertext: string
  signature: string
  createdAt: string
}

export interface ChatReportView {
  id: string
  conversation: { id: string; kind: ChatKind; title: string | null }
  messageId: string
  reporter: { userId: number; shortName: string }
  sender: { userId: number; shortName: string }
  kind: EnvelopeKind
  sentAt: string
  plaintext: string
  verified: boolean
  createdAt: string
  resolvedAt: string | null
}

type MessageRow = Selectable<ChatMessagesTable>

const iso = (at: Date | string): string => new Date(at).toISOString()

const EMPTY = new Uint8Array(0)

async function messageRow(
  db: Kysely<Database>,
  id: string
): Promise<MessageRow | undefined> {
  return await db
    .selectFrom('chat_messages')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
}

/** Messages as the API sends them, with the attachments each references. */
async function views(
  db: Kysely<Database>,
  rows: MessageRow[]
): Promise<ChatMessageView[]> {
  const ids = rows.map(row => row.id)
  const links =
    ids.length === 0
      ? []
      : await db
          .selectFrom('chat_message_attachments')
          .select(['message_id', 'attachment_id'])
          .where('message_id', 'in', ids)
          .orderBy('message_id')
          .orderBy('attachment_id')
          .execute()
  const attachments = new Map<string, string[]>()
  for (const link of links) {
    const list = attachments.get(link.message_id) ?? []
    list.push(link.attachment_id)
    attachments.set(link.message_id, list)
  }
  return rows.map(row => ({
    id: row.id,
    conversationId: row.conversation_id,
    seq: Number(row.seq),
    epoch: row.epoch,
    senderUserId: Number(row.sender_user_id),
    senderIdentityId: row.sender_identity_id,
    kind: row.kind,
    targetIds: row.target_ids,
    nonce: b64(row.nonce),
    ciphertext: b64(row.ciphertext),
    signature: b64(row.signature),
    attachmentIds: attachments.get(row.id) ?? [],
    clearedAt: row.cleared_at == null ? null : iso(row.cleared_at),
    createdAt: iso(row.created_at)
  }))
}

const refuse = (reason: string, message: string): Error =>
  forbidden(message, { reason })

/** Whether a Postgres error is a unique violation of `constraint`. */
function violates(error: unknown, constraint: string): boolean {
  const pgError = error as { code?: string; constraint?: string }
  return pgError?.code === '23505' && pgError.constraint === constraint
}

/**
 * Where somebody stands for posting in a conversation now, by the rules a
 * post is checked against that need no keys: a member of an open
 * conversation who may post there (`poster`); a member who may not, because
 * it is closed or they are an Announcements reader (`reader`); or somebody
 * who is not a member at all, or a conversation that does not exist
 * (`stranger`). Typing hints are for posters only.
 */
export type PostingStanding = 'poster' | 'reader' | 'stranger'

export async function mayPost(
  db: Kysely<Database>,
  conversationId: string,
  userId: number,
  now: Date
): Promise<PostingStanding> {
  if (!(await memberNow(db, conversationId, userId, now))) return 'stranger'
  const conversation = await db
    .selectFrom('chat_conversations')
    .select(['kind', 'scope_id', 'closed_at'])
    .where('id', '=', conversationId)
    .executeTakeFirstOrThrow()
  if (conversation.closed_at != null) return 'reader'
  if (
    conversation.kind === 'seasonAnnouncements' &&
    !(await moderatorsOf(db, conversation, [userId])).has(userId)
  )
    return 'reader'
  return 'poster'
}

/**
 * `POST /chat/conversations/:id/messages`, under the posting rules at the
 * top of this file. Answers the message, and whether it is new.
 */
export async function postMessage(
  db: Kysely<Database>,
  caller: ChatCaller,
  conversationId: string,
  body: MessageBody,
  now: Date,
  objects?: ChatObjectStore
): Promise<{ message: ChatMessageView; created: boolean }> {
  try {
    return await db.transaction().execute(async trx => {
      const conversation = await lockConversation(trx, conversationId)
      const existing = await messageRow(trx, body.id)
      if (existing != null) {
        if (
          existing.conversation_id === conversationId &&
          Number(existing.sender_user_id) === caller.userId
        ) {
          const [message] = await views(trx, [existing])
          return { message, created: false }
        }
        throw idTaken()
      }
      if (conversation.closed_at != null) {
        throw conflict('This chat is closed', { reason: 'closed' })
      }
      const { keys } = await requireHolder(trx, caller)
      if (body.senderIdentityId !== keys.identityId) {
        throw conflict('Sign with your current identity', {
          reason: 'staleIdentity'
        })
      }
      const latest = await latestEpoch(trx, conversationId)
      if (body.epoch !== latest) {
        throw conflict(
          latest === 0
            ? 'This chat has no epoch yet'
            : `The current epoch is ${latest}`,
          { reason: 'staleEpoch' }
        )
      }
      const held = await trx
        .selectFrom('chat_epoch_boxes')
        .select(['epoch'])
        .where('conversation_id', '=', conversationId)
        .where('epoch', '=', latest)
        .where('user_id', '=', caller.userId)
        .where('identity_id', '=', keys.identityId)
        .executeTakeFirst()
      if (held == null) {
        throw conflict('History is locked until a member grants it', {
          reason: 'locked'
        })
      }

      let moderator: boolean | undefined
      const isModerator = async (): Promise<boolean> =>
        (moderator ??= (
          await moderatorsOf(trx, conversation, [caller.userId])
        ).has(caller.userId))
      if (
        conversation.kind === 'seasonAnnouncements' &&
        body.kind !== 'reaction' &&
        body.kind !== 'moderatorDelete' &&
        !(await isModerator())
      ) {
        throw refuse('notStaff', 'Only season staff post announcements')
      }
      if (body.kind === 'moderatorDelete' && !(await isModerator())) {
        throw refuse('notModerator', 'Only a moderator removes messages')
      }
      if (body.targetIds != null) {
        await checkTargets(trx, conversationId, caller.userId, body)
      }
      if (body.attachmentIds.length > 0) {
        await checkAttachments(trx, conversationId, caller.userId, body)
      }
      if (
        !verifyMessage({
          conversationId,
          epoch: body.epoch,
          messageId: body.id,
          senderUserId: caller.userId,
          kind: body.kind,
          nonce: body.nonce,
          ciphertext: body.ciphertext,
          signature: body.signature,
          senderIdentityKey: keys.identityKey
        })
      ) {
        throw badRequest('The message is not signed by your identity', {
          reason: 'badSignature'
        })
      }

      const counter = await trx
        .updateTable('chat_conversations')
        .set(eb => ({ last_seq: eb('last_seq', '+', 1) }))
        .where('id', '=', conversationId)
        .returning(['last_seq'])
        .executeTakeFirstOrThrow()
      const seq = Number(counter.last_seq)
      await trx
        .insertInto('chat_messages')
        .values({
          id: body.id,
          conversation_id: conversationId,
          seq,
          epoch: body.epoch,
          sender_user_id: caller.userId,
          sender_identity_id: keys.identityId,
          kind: body.kind,
          target_ids: body.targetIds,
          nonce: body.nonce,
          ciphertext: body.ciphertext,
          signature: body.signature,
          created_at: now
        })
        .execute()
      if (body.attachmentIds.length > 0) {
        await trx
          .insertInto('chat_message_attachments')
          .values(
            body.attachmentIds.map(attachmentId => ({
              message_id: body.id,
              attachment_id: attachmentId,
              created_at: now
            }))
          )
          .execute()
      }
      if (body.targetIds != null) {
        await clearTargets(trx, conversationId, body.targetIds, now, objects)
      }
      await notifyChat(trx, conversationId, 'message', seq)
      const stored = await messageRow(trx, body.id)
      const [message] = await views(trx, [stored!])
      return { message, created: true }
    })
  } catch (error) {
    // The same id posted at the same moment in another conversation.
    if (violates(error, 'chat_messages_pkey')) throw idTaken()
    throw error
  }
}

function idTaken(): Error {
  return conflict('That message id is taken', { reason: 'idTaken' })
}

/** A delete's targets: posts, edits or reactions here, the caller's own for `delete`. */
async function checkTargets(
  trx: Kysely<Database>,
  conversationId: string,
  userId: number,
  body: MessageBody
): Promise<void> {
  const targetIds = body.targetIds ?? []
  const rows = await trx
    .selectFrom('chat_messages')
    .select(['id', 'conversation_id', 'sender_user_id', 'kind'])
    .where('id', 'in', targetIds)
    .execute()
  const found = new Map(rows.map(row => [row.id, row]))
  for (const id of targetIds) {
    const row = found.get(id)
    if (
      row?.conversation_id !== conversationId ||
      DELETE_KINDS.includes(row.kind)
    ) {
      throw badRequest(`${id} is no message to delete here`, {
        reason: 'target'
      })
    }
    if (body.kind === 'delete' && Number(row.sender_user_id) !== userId) {
      throw refuse('notYours', 'You may delete only your own messages')
    }
  }
}

/** Each must be a completed upload by the sender in this conversation. */
async function checkAttachments(
  trx: Kysely<Database>,
  conversationId: string,
  userId: number,
  body: MessageBody
): Promise<void> {
  const rows = await trx
    .selectFrom('chat_attachments')
    .select(['id'])
    .where('id', 'in', body.attachmentIds)
    .where('conversation_id', '=', conversationId)
    .where('uploader_user_id', '=', userId)
    .where('completed_at', 'is not', null)
    // Held until the post commits, so the orphan purge (which takes these
    // rows `for update`) either waits and finds them referenced, or has
    // already deleted them and the post is refused.
    .forShare()
    .execute()
  if (rows.length !== body.attachmentIds.length) {
    throw badRequest('Attach only your own finished uploads in this chat', {
      reason: 'attachment'
    })
  }
}

/**
 * Clears the targets of a delete, and deletes the attachments that only
 * those (now cleared) messages referenced: their objects through `objects`,
 * then their rows. Object deletes run inside the transaction, so a failed
 * one fails the delete and the client's retry finds it all still to do.
 * Without a store the rows stay for the orphan purge.
 */
async function clearTargets(
  trx: Kysely<Database>,
  conversationId: string,
  targetIds: string[],
  now: Date,
  objects: ChatObjectStore | undefined
): Promise<void> {
  await trx
    .updateTable('chat_messages')
    .set({ cleared_at: now, ciphertext: EMPTY })
    .where('conversation_id', '=', conversationId)
    .where('id', 'in', targetIds)
    .where('cleared_at', 'is', null)
    .execute()
  const unpinned = await trx
    .deleteFrom('chat_message_pins')
    .where('conversation_id', '=', conversationId)
    .where('message_id', 'in', targetIds)
    .returning('user_id')
    .execute()
  for (const userId of new Set(unpinned.map(row => row.user_id))) {
    await notifyChatUser(trx, userId, 'preferences')
  }
  if (objects == null) return
  const { rows } = await sql<{ id: string; objectKey: string }>`
    select a.id, a.object_key as "objectKey"
    from chat_attachments a
    where a.id in (
      select attachment_id from chat_message_attachments
      where message_id = any(${targetIds}::text[])
    )
    and not exists (
      select 1 from chat_message_attachments l
      join chat_messages m on m.id = l.message_id
      where l.attachment_id = a.id and m.cleared_at is null
    )
    order by a.id
  `.execute(trx)
  if (rows.length === 0) return
  await objects.deleteObjects(rows.map(row => row.objectKey))
  await trx
    .deleteFrom('chat_attachments')
    .where(
      'id',
      'in',
      rows.map(row => row.id)
    )
    .execute()
}

/**
 * `GET …/messages?after=&before=&limit=`, oldest first: the first `limit`
 * after `after`, or, given only `before`, the last `limit` before it.
 */
export async function messagesOf(
  db: Kysely<Database>,
  conversationId: string,
  page: { after?: number; before?: number; limit: number }
): Promise<ChatMessageView[]> {
  let query = db
    .selectFrom('chat_messages')
    .selectAll()
    .where('conversation_id', '=', conversationId)
  if (page.after != null) query = query.where('seq', '>', page.after)
  if (page.before != null) query = query.where('seq', '<', page.before)
  const newestFirst = page.after == null && page.before != null
  const rows = await query
    .orderBy('seq', newestFirst ? 'desc' : 'asc')
    .limit(page.limit)
    .execute()
  if (newestFirst) rows.reverse()
  return await views(db, rows)
}

/**
 * `PUT …/read`: moves the caller's cursor up to `seq`, never back. A move
 * notifies `read`. Answers the cursor as it stands.
 */
export async function markRead(
  db: Kysely<Database>,
  conversationId: string,
  userId: number,
  seq: number,
  now: Date,
  clearManualUnreadRevision?: number
): Promise<{ seq: number }> {
  return await db.transaction().execute(async trx => {
    // Read/preference rows must not precede their conversation's lock either.
    await lockConversation(trx, conversationId)
    await clearManualUnread(
      trx,
      userId,
      conversationId,
      clearManualUnreadRevision
    )
    const conversation = await trx
      .selectFrom('chat_conversations')
      .select(['last_seq'])
      .where('id', '=', conversationId)
      .executeTakeFirstOrThrow()
    if (seq > Number(conversation.last_seq)) {
      throw badRequest(`No message has seq ${seq} yet`, { reason: 'seq' })
    }
    const moved = await trx
      .insertInto('chat_read_cursors')
      .values({
        conversation_id: conversationId,
        user_id: userId,
        seq,
        at: now
      })
      .onConflict(oc =>
        oc
          .columns(['conversation_id', 'user_id'])
          .doUpdateSet({ seq, at: now })
          .where('chat_read_cursors.seq', '<', seq)
      )
      .returning(['seq'])
      .executeTakeFirst()
    if (moved != null) {
      await notifyChat(trx, conversationId, 'read', seq)
      return { seq }
    }
    const cursor = await trx
      .selectFrom('chat_read_cursors')
      .select(['seq'])
      .where('conversation_id', '=', conversationId)
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow()
    return { seq: Number(cursor.seq) }
  })
}

/** The conversation a message is in, for the route's membership check. */
export async function conversationOfMessage(
  db: Kysely<Database>,
  messageId: string
): Promise<string | undefined> {
  const row = await db
    .selectFrom('chat_messages')
    .select(['conversation_id'])
    .where('id', '=', messageId)
    .executeTakeFirst()
  return row?.conversation_id
}

/**
 * `POST /chat/reports`: copies the message into a report and records
 * whether the disclosed plaintext and key prove it.
 */
export async function reportMessage(
  db: Kysely<Database>,
  reporterUserId: number,
  body: ReportBody,
  now: Date
): Promise<{ id: string; verified: boolean }> {
  return await db.transaction().execute(async trx => {
    const row = await trx
      .selectFrom('chat_messages')
      .innerJoin('chat_identities', join =>
        join
          .onRef('chat_identities.id', '=', 'chat_messages.sender_identity_id')
          .onRef('chat_identities.user_id', '=', 'chat_messages.sender_user_id')
      )
      .selectAll('chat_messages')
      .select(['chat_identities.identity_public_key as identityKey'])
      .where('chat_messages.id', '=', body.messageId)
      .forShare('chat_messages')
      .executeTakeFirst()
    if (row == null) throw notFound()
    if (row.cleared_at != null) {
      throw conflict('That message was deleted', { reason: 'cleared' })
    }
    const fields = {
      conversationId: row.conversation_id,
      epoch: row.epoch,
      messageId: row.id,
      senderUserId: Number(row.sender_user_id),
      kind: row.kind,
      nonce: new Uint8Array(row.nonce),
      ciphertext: new Uint8Array(row.ciphertext),
      signature: new Uint8Array(row.signature)
    }
    const signed = verifyMessage({
      ...fields,
      senderIdentityKey: new Uint8Array(row.identityKey)
    })
    let opened: Uint8Array | undefined
    try {
      opened = openWithMessageKey({ ...fields, messageKey: body.messageKey })
    } catch {
      opened = undefined
    }
    const verified =
      signed && opened != null && equalBytes(opened, utf8(body.plaintext))
    const envelope: ReportEnvelope = {
      id: row.id,
      conversationId: row.conversation_id,
      seq: Number(row.seq),
      epoch: row.epoch,
      senderUserId: Number(row.sender_user_id),
      senderIdentityId: row.sender_identity_id,
      senderIdentityKey: b64(row.identityKey),
      kind: row.kind,
      targetIds: row.target_ids,
      nonce: b64(row.nonce),
      ciphertext: b64(row.ciphertext),
      signature: b64(row.signature),
      createdAt: iso(row.created_at)
    }
    const id = makeId('chatReport')
    await trx
      .insertInto('chat_reports')
      .values({
        id,
        conversation_id: row.conversation_id,
        message_id: row.id,
        reporter_user_id: reporterUserId,
        envelope: JSON.stringify(envelope),
        message_key: body.messageKey,
        plaintext: body.plaintext,
        verified,
        created_at: now
      })
      .execute()
    return { id, verified }
  })
}

/** `GET /admin/chat/reports`: newest first; only the unresolved with `open`. */
export async function reportsFor(
  db: Kysely<Database>,
  space: MediaContext['space'],
  options: { open: boolean; id?: string }
): Promise<ChatReportView[]> {
  let query = db
    .selectFrom('chat_reports')
    .innerJoin(
      'chat_conversations',
      'chat_conversations.id',
      'chat_reports.conversation_id'
    )
    .select([
      'chat_reports.id',
      'chat_reports.conversation_id',
      'chat_reports.message_id',
      'chat_reports.reporter_user_id',
      'chat_reports.envelope',
      'chat_reports.plaintext',
      'chat_reports.verified',
      'chat_reports.created_at',
      'chat_reports.resolved_at',
      'chat_conversations.kind',
      'chat_conversations.scope_type',
      'chat_conversations.scope_id'
    ])
  if (options.open) query = query.where('chat_reports.resolved_at', 'is', null)
  if (options.id != null)
    query = query.where('chat_reports.id', '=', options.id)
  const rows = await query
    .orderBy('chat_reports.created_at', 'desc')
    .orderBy('chat_reports.id', 'desc')
    .limit(MAX_PAGE)
    .execute()
  const envelopes = rows.map(row => row.envelope as ReportEnvelope)
  const titled = rows.map(row => ({
    id: row.conversation_id,
    kind: row.kind,
    scopeType: row.scope_type,
    scopeId: row.scope_id
  }))
  const titles = titlesOf(titled, await scopeIdentities(db, scopesOf(titled)))
  const people = await chatPeople(db, space, [
    ...rows.map(row => Number(row.reporter_user_id)),
    ...envelopes.map(envelope => envelope.senderUserId)
  ])
  const person = (userId: number): { userId: number; shortName: string } => ({
    userId,
    shortName: people.get(userId)?.shortName ?? ''
  })
  return rows.map((row, index) => ({
    id: row.id,
    conversation: {
      id: row.conversation_id,
      kind: row.kind,
      title: titles.get(row.conversation_id) ?? null
    },
    messageId: row.message_id,
    reporter: person(Number(row.reporter_user_id)),
    sender: person(envelopes[index].senderUserId),
    kind: envelopes[index].kind,
    sentAt: envelopes[index].createdAt,
    plaintext: row.plaintext,
    verified: row.verified,
    createdAt: iso(row.created_at),
    resolvedAt: row.resolved_at == null ? null : iso(row.resolved_at)
  }))
}

/** `PUT /admin/chat/reports/:id/resolve`: marks it resolved, once. */
export async function resolveReport(
  db: Kysely<Database>,
  space: MediaContext['space'],
  reportId: string,
  now: Date
): Promise<ChatReportView> {
  await db
    .updateTable('chat_reports')
    .set({ resolved_at: now })
    .where('id', '=', reportId)
    .where('resolved_at', 'is', null)
    .execute()
  const [view] = await reportsFor(db, space, { open: false, id: reportId })
  if (view == null) throw notFound()
  return view
}
