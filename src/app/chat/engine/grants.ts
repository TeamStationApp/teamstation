import type { ChatGrantBox, ChatGrantRequest } from '../../../common/api'
import { verifyPuk } from '../../../common/chatCrypto/chain'
import { epochAad, hpkeSeal } from '../../../common/chatCrypto/hpke'
import { b64, epochKeyOf, unb64 } from '../keyRecord'
import { ChatEngineError, type EngineContext } from './context'
import { pinCurrent } from './decrypt'
import { reasonOf } from './links'
import { syncLog } from './log'
import { syncEpochs } from './sync'

/**
 * Filling grant requests: boxing a chat's latest epoch key to a member who
 * lacks it, so the whole history opens for them.
 *
 * A device holding the latest key fills a request by itself only when the
 * requester is in the chat's verified member set (a verified `join` with no
 * later `leave`) and the request is not an identity reset. A reset waits
 * for a person who is an approver to tap Approve, after comparing the old
 * and new safety numbers. A chat whose membership record did not verify is
 * granted nothing.
 */

/** The most boxes one `POST /chat/grants` carries. */
export const GRANT_BATCH = 500

/** The box for one request, or undefined when its per-user key is not the identity's. */
function boxFor(
  request: ChatGrantRequest,
  epochKey: Uint8Array
): ChatGrantBox | undefined {
  const publicKey = unb64(request.pukPublicKey)
  if (
    !verifyPuk(
      { userId: request.userId, generation: request.pukGeneration, publicKey },
      unb64(request.pukSignature),
      unb64(request.identityKey)
    )
  ) {
    return undefined
  }
  return {
    conversationId: request.conversationId,
    epoch: request.epoch,
    userId: request.userId,
    identityId: request.identityId,
    pukGeneration: request.pukGeneration,
    box: b64(
      hpkeSeal(
        'grant',
        publicKey,
        epochAad({
          conversationId: request.conversationId,
          epoch: request.epoch,
          recipientUserId: request.userId,
          identityId: request.identityId,
          generation: request.pukGeneration
        }),
        epochKey
      )
    )
  }
}

/** The latest epoch's key, reading the chat's epochs when it is not held yet. */
async function latestKey(
  ctx: EngineContext,
  request: ChatGrantRequest
): Promise<Uint8Array | undefined> {
  const held = epochKeyOf(
    ctx.keys.record,
    request.conversationId,
    request.epoch
  )
  if (held != null) return held
  await syncEpochs(ctx, request.conversationId)
  return epochKeyOf(ctx.keys.record, request.conversationId, request.epoch)
}

/** Reads the open requests in the person's chats. */
export async function readGrants(
  ctx: EngineContext
): Promise<ChatGrantRequest[]> {
  const requests = await ctx.client.chatGrants()
  ctx.memory.grants = requests
  ctx.memory.emit({ type: 'approvals' })
  return requests
}

/**
 * Reads the open requests and fills, in batches, every one the grant rule
 * lets this device fill by itself. Answers how many were filled.
 */
export async function fillGrants(ctx: EngineContext): Promise<number> {
  const requests = await readGrants(ctx)
  const boxes: ChatGrantBox[] = []
  const heads = new Map<string, Set<number> | undefined>()
  for (const request of requests) {
    // Every identity seen is pinned, so a reset's old safety number is kept
    // for the approval prompt.
    await pinCurrent(ctx, request.userId, request.identityKey)
    if (request.identityReset) continue
    const key = await latestKey(ctx, request)
    if (key == null) continue
    let members = heads.get(request.conversationId)
    if (!heads.has(request.conversationId)) {
      const head = await syncLog(ctx, request.conversationId)
      members = head.broken ? undefined : new Set(head.members)
      heads.set(request.conversationId, members)
    }
    if (members?.has(request.userId) !== true) continue
    const box = boxFor(request, key)
    if (box != null) boxes.push(box)
  }
  let filled = 0
  for (let at = 0; at < boxes.length; at += GRANT_BATCH) {
    try {
      const answer = await ctx.client.postChatGrants(
        boxes.slice(at, at + GRANT_BATCH)
      )
      filled += answer.filled
    } catch (error) {
      // The key moved on, or this device is no longer a holder: the next
      // run, after the hint that says so, finds where things stand.
      if (reasonOf(error) !== 'notHolder') throw error
    }
  }
  if (filled > 0) await readGrants(ctx)
  return filled
}

/**
 * Fills a reset identity's request after a person approved it here. The
 * requester must be in the chat's verified member set.
 */
export async function approveGrant(
  ctx: EngineContext,
  requestId: number
): Promise<void> {
  const request = ctx.memory.grants.find(open => open.id === requestId)
  if (request?.canApprove !== true) {
    throw new ChatEngineError('target', 'There is no such request to approve')
  }
  const key = await latestKey(ctx, request)
  if (key == null) throw new ChatEngineError('locked', 'History is locked')
  const head = await syncLog(ctx, request.conversationId)
  if (head.broken) {
    throw new ChatEngineError(
      'unverified',
      'Membership record could not be verified'
    )
  }
  if (!head.members.includes(request.userId)) {
    throw new ChatEngineError(
      'unverifiedMember',
      `User ${request.userId} is not in the verified membership record`
    )
  }
  const box = boxFor(request, key)
  if (box == null) {
    throw new ChatEngineError(
      'badKeys',
      `The keys published for user ${request.userId} do not check out`
    )
  }
  await pinCurrent(ctx, request.userId, request.identityKey)
  await ctx.client.postChatGrants([box])
  await readGrants(ctx)
}
