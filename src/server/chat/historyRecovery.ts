import { type Kysely, sql } from 'kysely'

import type {
  ChatHistoryGrantsPosted,
  ChatHistoryRequests
} from '../../common/api'
import { badRequest, forbidden, notFound } from '../../common/errors'
import type { Database } from '../db/database'
import { isEligible, isUnder13 } from './audiences'
import { lockConversation } from './epochs'
import { approveHistoryAccess } from './historyAccess'
import { reconcileHistoryRequests } from './historyRequests'
import type { asHistoryGrantsBody } from './historyValidation'
import { type ChatCaller, requireHolder } from './keys'
import { isApprover } from './listing'
import { notifyChat } from './membershipLog'
import { b64 } from './wire'

/** Database distribution path to an actual epoch, stopping at the next break. */
export async function canDistributeEpoch(
  db: Kysely<Database>,
  id: string,
  userId: string,
  identityId: string,
  epoch: number
): Promise<boolean> {
  const { rows } = await sql<{ held: boolean }>`
    select exists(select 1 from chat_epoch_boxes b
      where b.conversation_id=${id} and b.user_id=${userId} and b.identity_id=${identityId}
        and b.epoch>=${epoch} and not exists(select 1 from chat_epochs e
          where e.conversation_id=b.conversation_id and e.epoch>${epoch} and e.epoch<=b.epoch
            and (e.chain_break or e.previous_key_box is null))) as held
  `.execute(db)
  return rows[0].held
}

async function member(
  db: Kysely<Database>,
  id: string,
  userId: string,
  now: Date
): Promise<boolean> {
  if (!(await isEligible(db, userId, now))) return false
  return (
    (await db
      .selectFrom('chat_members')
      .select('user_id')
      .where('conversation_id', '=', id)
      .where('user_id', '=', userId)
      .where('left_at', 'is', null)
      .executeTakeFirst()) != null
  )
}

/**
 * Reconcile, once, conversations nothing has reconciled since the upgrade.
 * Every later change reconciles as it is written, so a recovery read takes no
 * conversation lock. Box delivery order needs none either: the allocation
 * trigger holds the conversation row until its writer commits.
 *
 * Each conversation is its own short transaction, before the caller's read:
 * readers racing on the same chats after the upgrade wait for one lock at a
 * time, and skip a chat another reader has just reconciled.
 */
export async function reconcileUnreconciled(
  db: Kysely<Database>,
  ids: string[],
  now: Date
): Promise<void> {
  if (ids.length === 0) return
  const pending = await db
    .selectFrom('chat_conversations')
    .select('id')
    .where('id', 'in', ids)
    .where('history_reconciled_at', 'is', null)
    .execute()
  for (const { id } of pending) {
    await db.transaction().execute(async trx => {
      await lockConversation(trx, id)
      const current = await trx
        .selectFrom('chat_conversations')
        .select('history_reconciled_at')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      if (current.history_reconciled_at != null) return
      await reconcileHistoryRequests(trx, id, now)
    })
  }
}

/** Which of these recipients may still be granted history: chat-eligible accounts. */
async function grantableRecipients(
  db: Kysely<Database>,
  userIds: string[],
  now: Date
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  const users = await db
    .selectFrom('users')
    .select(['id', 'birth_year', 'birth_month'])
    .where('id', 'in', [...new Set(userIds)])
    .where('merged_into', 'is', null)
    .where('login_enabled', '=', true)
    .where('disabled_at', 'is', null)
    .execute()
  return new Set(
    users
      .filter(user => !isUnder13(user.birth_year, user.birth_month, now))
      .map(user => user.id)
  )
}

export async function historyGrantsFor(
  db: Kysely<Database>,
  caller: ChatCaller,
  cursor: string,
  limit: number,
  now: Date
): Promise<ChatHistoryRequests> {
  if (!(await isEligible(db, caller.userId, now)))
    return { requests: [], nextCursor: null }
  const memberships = await db
    .selectFrom('chat_members')
    .select('conversation_id')
    .where('user_id', '=', caller.userId)
    .where('left_at', 'is', null)
    .execute()
  const ids = memberships.map(row => row.conversation_id)
  await reconcileUnreconciled(db, ids, now)
  return await db.transaction().execute(async trx => {
    const { rows } = await sql<{
      id: string
      conversationId: string
      segmentStartEpoch: number
      targetEpoch: number
      coveredThroughEpoch: number
      userId: string
      identityId: string
      identityKey: Uint8Array
      pukGeneration: number
      pukPublicKey: Uint8Array
      pukSignature: Uint8Array
      requiresApproval: boolean
      openedAt: Date
    }>`
      select r.id::text as id,r.conversation_id as "conversationId",r.segment_start_epoch as "segmentStartEpoch",
        r.target_epoch as "targetEpoch",r.covered_through_epoch as "coveredThroughEpoch",r.user_id as "userId",
        r.identity_id as "identityId",i.identity_public_key as "identityKey",r.generation as "pukGeneration",
        k.public_key as "pukPublicKey",k.signature as "pukSignature",a.requires_approval as "requiresApproval",r.opened_at as "openedAt"
      from chat_history_requests r join chat_members caller on caller.conversation_id=r.conversation_id
        and caller.user_id=${caller.userId} and caller.left_at is null
      join chat_members recipient on recipient.conversation_id=r.conversation_id and recipient.user_id=r.user_id and recipient.left_at is null
      join chat_identities i on i.id=r.identity_id and i.user_id=r.user_id and i.replaced_at is null
      join chat_user_keys k on k.user_id=r.user_id and k.identity_id=r.identity_id and k.generation=r.generation
      join chat_history_access a on a.conversation_id=r.conversation_id and a.user_id=r.user_id and a.identity_id=r.identity_id
      where r.conversation_id=any(${ids}::text[])
        and r.id>${cursor}::bigint and r.filled_at is null and r.superseded_at is null
      order by r.id limit ${limit + 1}
    `.execute(trx)
    // A recipient who can no longer chat cannot be granted history: the
    // request stays open for when they can, but no holder is asked for it.
    const grantable = await grantableRecipients(
      trx,
      rows.slice(0, limit).map(row => row.userId),
      now
    )
    const page = rows.slice(0, limit).filter(row => grantable.has(row.userId))
    // A page usually spans a few chats: decide the caller's approver role
    // once for each.
    const approver = new Map<string, boolean>()
    const conversations =
      page.length === 0
        ? []
        : await trx
            .selectFrom('chat_conversations')
            .select(['id', 'kind', 'scope_id'])
            .where('id', 'in', [
              ...new Set(page.map(row => row.conversationId))
            ])
            .execute()
    for (const conversation of conversations)
      approver.set(
        conversation.id,
        await isApprover(trx, conversation, caller.userId)
      )
    const requests: ChatHistoryRequests['requests'] = []
    for (const row of page) {
      const canApprove =
        row.userId !== caller.userId &&
        approver.get(row.conversationId) === true
      requests.push({
        ...row,
        identityKey: b64(row.identityKey),
        pukPublicKey: b64(row.pukPublicKey),
        pukSignature: b64(row.pukSignature),
        canApprove,
        openedAt: new Date(row.openedAt).toISOString()
      })
    }
    return {
      requests,
      nextCursor: rows.length > limit ? rows[limit - 1].id : null
    }
  })
}

type HistoryBox = ReturnType<typeof asHistoryGrantsBody>['boxes'][number]
export async function postHistoryGrants(
  db: Kysely<Database>,
  caller: ChatCaller,
  boxes: HistoryBox[],
  now: Date
): Promise<ChatHistoryGrantsPosted> {
  return await db.transaction().execute(async trx => {
    const conversations = new Map<
      string,
      Awaited<ReturnType<typeof lockConversation>>
    >()
    for (const id of [...new Set(boxes.map(b => b.conversationId))].sort()) {
      const conversation = await lockConversation(trx, id)
      if (!(await member(trx, id, caller.userId, now))) throw notFound()
      conversations.set(id, conversation)
      await reconcileHistoryRequests(trx, id, now)
    }
    // Resolve linked identity after acquiring every lock: a reset may have won
    // while this transaction was waiting for a conversation.
    const { keys } = await requireHolder(trx, caller)
    const results: ChatHistoryGrantsPosted['results'] = []
    const touched = new Set<string>()
    let filled = 0
    for (const box of boxes) {
      const { rows } = await sql<{
        conversation_id: string
        user_id: string
        identity_id: string
        generation: number
        segment_start_epoch: number
        target_epoch: number
        covered_through_epoch: number
        filled_at: Date | null
        superseded_at: Date | null
      }>`select conversation_id,user_id,identity_id,generation,segment_start_epoch,target_epoch,
          covered_through_epoch,filled_at,superseded_at from chat_history_requests where id=${box.requestId}::bigint`.execute(
        trx
      )
      const request = rows[0]
      if (request == null)
        throw badRequest('Unknown history request', { reason: 'historyTarget' })
      if (
        request.conversation_id !== box.conversationId ||
        request.user_id !== box.userId ||
        request.identity_id !== box.identityId ||
        request.generation !== box.pukGeneration ||
        request.target_epoch !== box.targetEpoch ||
        box.epoch < request.segment_start_epoch ||
        box.epoch > request.target_epoch
      )
        throw badRequest('The box does not match its historical target', {
          reason: 'historyTarget'
        })
      const result = {
        requestId: box.requestId,
        coveredThroughEpoch: request.covered_through_epoch
      }
      if (
        request.superseded_at != null ||
        !(await member(trx, box.conversationId, box.userId, now))
      ) {
        results.push({ ...result, status: 'skipped' })
        continue
      }
      if (
        request.filled_at != null ||
        box.epoch <= request.covered_through_epoch
      ) {
        results.push({ ...result, status: 'alreadyCovered' })
        continue
      }
      if (
        !(await canDistributeEpoch(
          trx,
          box.conversationId,
          caller.userId,
          keys.identityId,
          box.epoch
        ))
      )
        throw forbidden('This device has no distribution path to that epoch', {
          reason: 'notHolder'
        })
      const access = await trx
        .selectFrom('chat_history_access')
        .select('requires_approval')
        .where('conversation_id', '=', box.conversationId)
        .where('user_id', '=', box.userId)
        .where('identity_id', '=', box.identityId)
        .executeTakeFirstOrThrow()
      if (access.requires_approval) {
        if (
          !box.approveHistory ||
          box.userId === caller.userId ||
          !(await isApprover(
            trx,
            conversations.get(box.conversationId)!,
            caller.userId
          ))
        )
          throw forbidden('Older history needs explicit approval', {
            reason: 'notApprover'
          })
        await approveHistoryAccess(
          trx,
          box.conversationId,
          box.userId,
          box.identityId,
          caller.userId,
          now
        )
      }
      await trx
        .insertInto('chat_epoch_boxes')
        .values({
          conversation_id: box.conversationId,
          epoch: box.epoch,
          user_id: box.userId,
          identity_id: box.identityId,
          generation: box.pukGeneration,
          box: box.box,
          granted_by_user_id: caller.userId,
          created_at: now
        })
        .onConflict(oc =>
          oc
            .columns([
              'conversation_id',
              'epoch',
              'user_id',
              'identity_id',
              'generation'
            ])
            .doNothing()
        )
        .execute()
      const completed = box.epoch === request.target_epoch
      await trx
        .updateTable('chat_history_requests')
        .set({
          covered_through_epoch: box.epoch,
          filled_at: completed ? now : null
        })
        .where('id', '=', box.requestId)
        .execute()
      if (completed) filled++
      results.push({
        requestId: box.requestId,
        coveredThroughEpoch: box.epoch,
        status: completed ? 'completed' : 'partial'
      })
      touched.add(box.conversationId)
    }
    for (const id of [...touched].sort()) await notifyChat(trx, id, 'grant')
    return { filled, results }
  })
}
