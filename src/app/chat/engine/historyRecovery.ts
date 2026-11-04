import type {
  ChatHistoryGrantBox,
  ChatHistoryRequest
} from '../../../common/api'
import { verifyPuk } from '../../../common/chatCrypto/chain'
import { epochAad, hpkeSeal } from '../../../common/chatCrypto/hpke'
import {
  chatHistorySegments,
  highestHistoryKey
} from '../../../common/chatHistory'
import { b64, epochKeyOf, unb64 } from '../keyRecord'
import { ChatEngineError, type EngineContext } from './context'
import { pinCurrent } from './decrypt'
import { syncLog } from './log'
import { openPending, syncEpochs } from './sync'

export function heldHistoryEpoch(
  ctx: EngineContext,
  request: ChatHistoryRequest
): number | undefined {
  const state = ctx.memory.state(request.conversationId)
  if (state == null || [...state.epochs.values()].some(e => !e.valid))
    return undefined
  const epochs = [...state.epochs.values()]
    .map(e => e.record)
    .sort((a, b) => a.epoch - b.epoch)
  if (epochs.some((row, index) => row.epoch !== index + 1)) return undefined
  const segment = chatHistorySegments(epochs).find(
    s =>
      s.start === request.segmentStartEpoch &&
      s.end === request.targetEpoch &&
      s.closed
  )
  if (segment == null) return undefined
  return highestHistoryKey(
    segment,
    Object.keys(ctx.keys.record.epochKeys[request.conversationId] ?? {}).map(
      Number
    ),
    request.coveredThroughEpoch
  )
}

async function historyBox(
  ctx: EngineContext,
  request: ChatHistoryRequest,
  approveHistory: boolean
): Promise<ChatHistoryGrantBox | undefined> {
  await syncEpochs(ctx, request.conversationId)
  const epoch = heldHistoryEpoch(ctx, request)
  if (epoch == null) return undefined
  const head = await syncLog(ctx, request.conversationId)
  if (
    head.broken ||
    !head.members.includes(request.userId) ||
    !head.members.includes(ctx.userId)
  )
    throw new ChatEngineError(
      'unverified',
      'Historical recipients must belong to the verified membership record'
    )
  const current = await ctx.client.chatUserKeys(request.userId)
  if (
    current.identity?.id !== request.identityId ||
    current.identity.publicKey !== request.identityKey ||
    current.puk?.generation !== request.pukGeneration ||
    current.puk.publicKey !== request.pukPublicKey ||
    !verifyPuk(
      {
        userId: request.userId,
        generation: request.pukGeneration,
        publicKey: unb64(request.pukPublicKey)
      },
      unb64(request.pukSignature),
      unb64(request.identityKey)
    )
  )
    throw new ChatEngineError(
      'badKeys',
      'Historical recipient keys failed verification'
    )
  const key = epochKeyOf(ctx.keys.record, request.conversationId, epoch)!
  await pinCurrent(ctx, request.userId, request.identityKey)
  return {
    requestId: request.id,
    conversationId: request.conversationId,
    targetEpoch: request.targetEpoch,
    epoch,
    userId: request.userId,
    identityId: request.identityId,
    pukGeneration: request.pukGeneration,
    approveHistory,
    box: b64(
      hpkeSeal(
        'grant',
        unb64(request.pukPublicKey),
        epochAad({
          conversationId: request.conversationId,
          epoch,
          recipientUserId: request.userId,
          identityId: request.identityId,
          generation: request.pukGeneration
        }),
        key
      )
    )
  }
}

/** Capable-server discovery is independent of the fresh-publication flag. */
export async function readHistoryGrants(
  ctx: EngineContext
): Promise<ChatHistoryRequest[]> {
  if (!ctx.memory.recoveryProbed) {
    const first = ctx.memory.conversations.keys().next().value
    if (first != null) await syncEpochs(ctx, first)
  }
  if (ctx.memory.recoveryVersion !== 1) return []
  let cursor = '0'
  const requests: ChatHistoryRequest[] = []
  for (let page = 0; page < 100; page++) {
    const answer = await ctx.client.chatHistoryGrants(cursor, 100)
    requests.push(...answer.requests)
    if (answer.nextCursor == null) break
    if (BigInt(answer.nextCursor) <= BigInt(cursor))
      throw new Error('Non-advancing history cursor')
    cursor = answer.nextCursor
  }
  ctx.memory.historyGrants = requests
  ctx.memory.emit({ type: 'approvals' })
  return requests
}

/** A bad historical target cannot block current sending or other segments. */
export async function fillHistoryGrants(ctx: EngineContext): Promise<number> {
  let filled = 0
  let changed = false
  try {
    const requests = await readHistoryGrants(ctx)
    for (const request of requests) {
      try {
        await syncEpochs(ctx, request.conversationId)
        await pinCurrent(ctx, request.userId, request.identityKey)
        if (request.requiresApproval) continue
        const box = await historyBox(ctx, request, false)
        if (box == null) continue
        const answer = await ctx.client.postChatHistoryGrants([box])
        filled += answer.filled
        changed ||= answer.results.some(result => result.status !== 'skipped')
      } catch (error) {
        const state = ctx.memory.state(request.conversationId)
        if (state != null) state.historyError = true
        ctx.memory.emit({ type: 'error', error })
      }
    }
    if (changed) await readHistoryGrants(ctx)
    for (const state of ctx.memory.conversations.values()) {
      if (!state.synced) continue
      await syncEpochs(ctx, state.summary.id)
      if ((await openPending(ctx, state)) > 0) {
        ctx.memory.emit({
          type: 'conversation',
          conversationId: state.summary.id
        })
        ctx.memory.emit({ type: 'conversations' })
      }
    }
  } catch (error) {
    ctx.memory.emit({ type: 'error', error })
  }
  return filled
}

export async function approveHistoryGrant(
  ctx: EngineContext,
  id: string
): Promise<void> {
  const request = ctx.memory.historyGrants.find(r => r.id === id)
  if (request?.canApprove !== true || request.userId === ctx.userId)
    throw new ChatEngineError(
      'target',
      'There is no historical request to approve'
    )
  const box = await historyBox(ctx, request, true)
  if (box == null)
    throw new ChatEngineError(
      'locked',
      'This device does not hold a key for that historical range'
    )
  const answer = await ctx.client.postChatHistoryGrants([box])
  if (
    !answer.results.some(
      result => result.requestId === id && result.status !== 'skipped'
    )
  )
    throw new ChatEngineError(
      'target',
      'The historical request changed; refresh and try again'
    )
  await readHistoryGrants(ctx)
  await fillHistoryGrants(ctx)
}
