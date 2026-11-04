import { type Kysely, sql } from 'kysely'

import type {
  ChatHistoryGrantsPosted,
  ChatHistoryRequests
} from '../../common/api'
import { badRequest, forbidden, notFound } from '../../common/errors'
import type { Database } from '../db/database'
import { isEligible } from './audiences'
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

export async function historyGrantsFor(
  db: Kysely<Database>,
  caller: ChatCaller,
  cursor: string,
  limit: number,
  now: Date
): Promise<ChatHistoryRequests> {
  if (!(await isEligible(db, caller.userId, now)))
    return { requests: [], nextCursor: null }
  return await db.transaction().execute(async trx => {
    const memberships = await trx
      .selectFrom('chat_members')
      .select('conversation_id')
      .where('user_id', '=', caller.userId)
      .where('left_at', 'is', null)
      .execute()
    // Match the grant writers' bytewise ordering, independent of database
    // collation. A locale-ordered reader can deadlock a multi-chat writer.
    const ids = memberships.map(row => row.conversation_id).sort()
    for (const id of ids) {
      await lockConversation(trx, id)
      await reconcileHistoryRequests(trx, id, now)
    }
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
    const requests: ChatHistoryRequests['requests'] = []
    for (const row of rows.slice(0, limit)) {
      const conversation = await lockConversation(trx, row.conversationId)
      const canApprove =
        row.userId !== caller.userId &&
        (await isApprover(trx, conversation, caller.userId))
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
