import { type Kysely, sql } from 'kysely'

import type { ChatBlock } from '../../common/api'
import { badRequest, forbidden, notFound } from '../../common/errors'
import type { Database } from '../db/database'
import type { MediaContext } from '../media/mediaContext'
import { rowsOfPeople, survivors } from '../teams/teamStaff'
import type { Reader } from '../users/readerNames'
import { chatPeople } from './listing'
import { inTransaction, notifyChatUser } from './membershipLog'

/**
 * Policy readers share this transaction lock; changes take it exclusively.
 * Acquire it before conversation/message locks. This also serializes creation
 * of a previously nonexistent DM with a block, without locking membership.
 */
export async function lockBlockPolicy(
  db: Kysely<Database>,
  write = false
): Promise<void> {
  if (write) {
    await sql`select pg_advisory_xact_lock(hashtext('chat-block-policy'))`.execute(
      db
    )
  } else {
    await sql`select pg_advisory_xact_lock_shared(hashtext('chat-block-policy'))`.execute(
      db
    )
  }
}

/** Include historical sender ids: ciphertext must retain its signed identity. */
export async function blockedSenderIds(
  db: Kysely<Database>,
  userId: string
): Promise<string[]> {
  const own = await rowsOfPeople(db, [userId])
  if (own.length === 0) return []
  const rows = await db
    .selectFrom('chat_user_blocks')
    .select('blocked_user_id')
    .where('blocker_user_id', 'in', own)
    .execute()
  const canonical = await survivors(
    db,
    rows.map(row => row.blocked_user_id)
  )
  return await rowsOfPeople(
    db,
    [...new Set(canonical.values())].filter(id => id !== userId)
  )
}

/** Resolve blockers in batches, independent of the conversation member count. */
export async function blockingRecipientIds(
  db: Kysely<Database>,
  senderId: string
): Promise<Set<string>> {
  const sender = (await survivors(db, [senderId])).get(senderId)
  if (sender == null) return new Set()
  const aliases = await rowsOfPeople(db, [sender])
  const rows = await db
    .selectFrom('chat_user_blocks')
    .select('blocker_user_id')
    .where('blocked_user_id', 'in', aliases)
    .execute()
  const canonical = await survivors(
    db,
    rows.map(row => row.blocker_user_id)
  )
  return new Set(
    await rowsOfPeople(
      db,
      [...new Set(canonical.values())].filter(id => id !== sender)
    )
  )
}

export async function blocksFor(
  db: Kysely<Database>,
  media: MediaContext,
  userId: string,
  reader?: Reader
): Promise<ChatBlock[]> {
  const own = await rowsOfPeople(db, [userId])
  if (own.length === 0) return []
  const rows = await db
    .selectFrom('chat_user_blocks')
    .selectAll()
    .where('blocker_user_id', 'in', own)
    .orderBy('created_at', 'desc')
    .execute()
  const canonical = await survivors(
    db,
    rows.map(row => row.blocked_user_id)
  )
  const ids = [...new Set(canonical.values())].filter(id => id !== userId)
  const people = await chatPeople(db, media.space, ids, { reader })
  return await Promise.all(
    ids.map(async id => ({
      userId: id,
      shortName: people.get(id)?.shortName ?? 'Former member',
      avatarUrl: people.get(id)?.avatarUrl ?? null,
      userIds: await rowsOfPeople(db, [id]),
      createdAt: new Date(
        rows.find(row => canonical.get(row.blocked_user_id) === id)!.created_at
      ).toISOString()
    }))
  )
}

/** Runs inside the caller's transaction and returns every identity of the target. */
export async function setBlock(
  db: Kysely<Database>,
  userId: string,
  targetId: string,
  blocked: boolean,
  now: Date
): Promise<string[]> {
  return await inTransaction(db, async trx => {
    await lockBlockPolicy(trx, true)
    const identities = await survivors(trx, [userId, targetId])
    const actor = identities.get(userId)
    const target = identities.get(targetId)
    if (actor == null || target == null) throw notFound()
    if (actor === target) throw badRequest('You cannot block yourself')
    const own = await rowsOfPeople(trx, [actor])
    const theirs = await rowsOfPeople(trx, [target])
    if (blocked) {
      const shared = await trx
        .selectFrom('chat_members as mine')
        .innerJoin(
          'chat_members as theirs',
          'theirs.conversation_id',
          'mine.conversation_id'
        )
        .select('mine.conversation_id')
        .where('mine.user_id', 'in', own)
        .where('theirs.user_id', 'in', theirs)
        .executeTakeFirst()
      if (shared == null) throw notFound()
      await trx
        .insertInto('chat_user_blocks')
        .values({
          blocker_user_id: actor,
          blocked_user_id: target,
          created_at: now
        })
        .onConflict(oc =>
          oc.columns(['blocker_user_id', 'blocked_user_id']).doNothing()
        )
        .execute()
    } else {
      await trx
        .deleteFrom('chat_user_blocks')
        .where('blocker_user_id', 'in', own)
        .where('blocked_user_id', 'in', theirs)
        .execute()
    }
    await notifyChatUser(trx, actor, 'blocks')
    return theirs
  })
}

/** Creation stays generic; a rejected send can explain the recipient block. */
export async function assertDmAllowed(
  db: Kysely<Database>,
  members: string[],
  senders: string[] = members,
  discloseBlock = false
): Promise<void> {
  for (const recipient of members) {
    const hidden = await blockedSenderIds(db, recipient)
    if (senders.some(id => hidden.includes(id)))
      throw forbidden(
        'This conversation is unavailable',
        discloseBlock ? { reason: 'recipientBlocked' } : undefined
      )
  }
}

export async function assertDmSendAllowed(
  db: Kysely<Database>,
  conversationId: string,
  sender: string
): Promise<void> {
  const members = await db
    .selectFrom('chat_members')
    .select('user_id')
    .where('conversation_id', '=', conversationId)
    .where('left_at', 'is', null)
    .execute()
  await assertDmAllowed(
    db,
    members.map(row => row.user_id),
    [sender],
    true
  )
}
