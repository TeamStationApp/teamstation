import type { Kysely } from 'kysely'

import type { ChatPin, ChatPreferences } from '../../common/api'
import { badRequest, notFound } from '../../common/errors'
import type { Database } from '../db/database'
import { lockConversation } from './epochs'
import { notifyChatUser } from './membershipLog'

export const defaultPreferences = (): ChatPreferences => ({
  pinned: false,
  muted: false,
  manualUnread: false,
  manualUnreadRevision: 0
})

export async function preferencesFor(
  db: Kysely<Database>,
  userId: number,
  conversationIds: string[]
): Promise<Map<string, ChatPreferences>> {
  if (conversationIds.length === 0) return new Map()
  const rows = await db
    .selectFrom('chat_conversation_preferences')
    .selectAll()
    .where('user_id', '=', userId)
    .where('conversation_id', 'in', conversationIds)
    .execute()
  return new Map(
    rows.map(row => [
      row.conversation_id,
      {
        pinned: row.pinned,
        muted: row.muted,
        manualUnread: row.manual_unread,
        manualUnreadRevision: Number(row.manual_unread_revision)
      }
    ])
  )
}

export async function updatePreferences(
  db: Kysely<Database>,
  userId: number,
  conversationId: string,
  patch: Partial<Pick<ChatPreferences, 'pinned' | 'muted' | 'manualUnread'>>
): Promise<ChatPreferences> {
  if (Object.values(patch).every(value => value == null))
    throw badRequest('Expected a preference')
  return await db.transaction().execute(async trx => {
    // All metadata writers follow reconciliation/deletion's parent-first order.
    await lockConversation(trx, conversationId)
    await lockMember(trx, userId, conversationId)
    await trx
      .insertInto('chat_conversation_preferences')
      .values({ user_id: userId, conversation_id: conversationId })
      .onConflict(oc => oc.columns(['user_id', 'conversation_id']).doNothing())
      .execute()
    await trx
      .selectFrom('chat_conversation_preferences')
      .select('user_id')
      .where('user_id', '=', userId)
      .where('conversation_id', '=', conversationId)
      .forUpdate()
      .execute()
    await trx
      .updateTable('chat_conversation_preferences')
      .set(eb => ({
        ...(patch.pinned == null ? {} : { pinned: patch.pinned }),
        ...(patch.muted == null ? {} : { muted: patch.muted }),
        ...(patch.manualUnread == null
          ? {}
          : {
              manual_unread: patch.manualUnread,
              manual_unread_revision: eb('manual_unread_revision', '+', 1)
            })
      }))
      .where('user_id', '=', userId)
      .where('conversation_id', '=', conversationId)
      .execute()
    await notifyChatUser(trx, userId, 'preferences')
    return (await preferencesFor(trx, userId, [conversationId])).get(
      conversationId
    )!
  })
}

async function lockMember(
  db: Kysely<Database>,
  userId: number,
  conversationId: string
): Promise<void> {
  const member = await db
    .selectFrom('chat_members')
    .select('user_id')
    .where('user_id', '=', userId)
    .where('conversation_id', '=', conversationId)
    .where('left_at', 'is', null)
    .forShare()
    .executeTakeFirst()
  if (member == null) throw notFound()
}

export async function pinsFor(
  db: Kysely<Database>,
  userId: number,
  conversationId: string
): Promise<ChatPin[]> {
  const rows = await db
    .selectFrom('chat_message_pins')
    .select(['message_id', 'pinned_at'])
    .where('user_id', '=', userId)
    .where('conversation_id', '=', conversationId)
    .orderBy('pinned_at', 'desc')
    .orderBy('message_id')
    .execute()
  return rows.map(row => ({
    messageId: row.message_id,
    pinnedAt: new Date(row.pinned_at).toISOString()
  }))
}

export async function setMessagePin(
  db: Kysely<Database>,
  userId: number,
  conversationId: string,
  messageId: string,
  pinned: boolean
): Promise<ChatPin[]> {
  return await db.transaction().execute(async trx => {
    await lockConversation(trx, conversationId)
    await lockMember(trx, userId, conversationId)
    if (pinned) {
      const post = await trx
        .selectFrom('chat_messages')
        .select('id')
        .where('id', '=', messageId)
        .where('conversation_id', '=', conversationId)
        .where('kind', '=', 'post')
        .where('cleared_at', 'is', null)
        .forShare()
        .executeTakeFirst()
      if (post == null) throw notFound()
      await trx
        .insertInto('chat_message_pins')
        .values({
          user_id: userId,
          conversation_id: conversationId,
          message_id: messageId
        })
        .onConflict(oc =>
          oc.columns(['user_id', 'conversation_id', 'message_id']).doNothing()
        )
        .execute()
    } else {
      await trx
        .deleteFrom('chat_message_pins')
        .where('user_id', '=', userId)
        .where('conversation_id', '=', conversationId)
        .where('message_id', '=', messageId)
        .execute()
    }
    await notifyChatUser(trx, userId, 'preferences')
    return await pinsFor(trx, userId, conversationId)
  })
}

/** A stale read request must never clear a newer deliberate mark-unread. */
export async function clearManualUnread(
  trx: Kysely<Database>,
  userId: number,
  conversationId: string,
  revision: number | undefined
): Promise<void> {
  if (revision == null) return
  const changed = await trx
    .updateTable('chat_conversation_preferences')
    .set({ manual_unread: false })
    .where('user_id', '=', userId)
    .where('conversation_id', '=', conversationId)
    .where('manual_unread', '=', true)
    .where('manual_unread_revision', '=', revision)
    .returning('user_id')
    .executeTakeFirst()
  if (changed != null) await notifyChatUser(trx, userId, 'preferences')
}
