import type {
  ChatHistoryGrantBox,
  ChatHistoryRequest,
  ChatUserKeys
} from '../../../common/api'
import { verifyPuk } from '../../../common/chatCrypto/chain'
import { epochAad, hpkeSeal } from '../../../common/chatCrypto/hpke'
import {
  chatHistorySegments,
  highestHistoryKey
} from '../../../common/chatHistory'
import { HttpError } from '../../../common/errors'
import { b64, type ChatLogHead, epochKeyOf, unb64 } from '../keyRecord'
import { ChatEngineError, type EngineContext, isGone } from './context'
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
  return highestHeldKey(ctx, request)
}

/** This device's highest key in the request's range not yet covered. */
function highestHeldKey(
  ctx: EngineContext,
  request: ChatHistoryRequest
): number | undefined {
  return highestHistoryKey(
    { start: request.segmentStartEpoch, end: request.targetEpoch },
    Object.keys(ctx.keys.record.epochKeys[request.conversationId] ?? {}).map(
      Number
    ),
    request.coveredThroughEpoch
  )
}

/** The box for one request, from the chat's epochs as last read. */
async function historyBox(
  ctx: EngineContext,
  request: ChatHistoryRequest,
  approveHistory: boolean,
  verifiedHead: () => Promise<ChatLogHead>,
  recipientKeys: () => Promise<ChatUserKeys>
): Promise<ChatHistoryGrantBox | undefined> {
  const epoch = heldHistoryEpoch(ctx, request)
  if (epoch == null) return undefined
  const head = await verifiedHead()
  if (
    head.broken ||
    !head.members.includes(request.userId) ||
    !head.members.includes(ctx.userId)
  )
    throw new ChatEngineError(
      'unverified',
      'Historical recipients must belong to the verified membership record'
    )
  const current = await recipientKeys()
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

/**
 * Capable-server discovery is independent of the fresh-publication flag.
 * The chats whose requests for this device changed are added to `changed`.
 */
export async function readHistoryGrants(
  ctx: EngineContext,
  changed?: Set<string>
): Promise<ChatHistoryRequest[]> {
  await probeRecovery(ctx)
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
  const previous = ctx.memory.historyGrants
  ctx.memory.historyGrants = requests
  ctx.memory.emit({ type: 'approvals' })
  const own = (rows: ChatHistoryRequest[], id: string): string =>
    JSON.stringify(
      rows.filter(r => r.userId === ctx.userId && r.conversationId === id)
    )
  for (const id of new Set(
    [...previous, ...requests]
      .filter(r => r.userId === ctx.userId)
      .map(r => r.conversationId)
  )) {
    if (own(previous, id) !== own(requests, id)) {
      changed?.add(id)
      ctx.memory.emit({ type: 'conversation', conversationId: id })
    }
  }
  return requests
}

/** The most failed reads a probe makes before it reports the first. */
const PROBE_TRIES = 3

/**
 * Learns whether the server supports recovery from any chat's epochs: a
 * chat the person left is skipped, and one failed read tries the next.
 */
async function probeRecovery(ctx: EngineContext): Promise<void> {
  let failure: unknown
  let failures = 0
  for (const id of [...ctx.memory.conversations.keys()]) {
    if (ctx.memory.recoveryProbed) return
    try {
      await syncEpochs(ctx, id)
    } catch (error) {
      if (isGone(error)) continue
      if (failures === 0) failure = error
      failures += 1
      if (failures >= PROBE_TRIES) break
    }
  }
  if (!ctx.memory.recoveryProbed && failures > 0) throw failure
}

/** The most boxes one `POST /chat/grants?scope=history` carries. */
export const HISTORY_GRANT_BATCH = 100

/** A bad historical target cannot block current sending or other segments. */
export async function fillHistoryGrants(ctx: EngineContext): Promise<number> {
  let filled = 0
  let changed = false
  try {
    // Chats where this device's own requests changed: keys may await it.
    const mine = new Set<string>()
    const requests = await readHistoryGrants(ctx, mine)
    // Each chat is read once a pass, however many requests it has.
    const synced = new Map<string, Promise<unknown>>()
    const heads = new Map<string, Promise<ChatLogHead>>()
    // And each recipient's keys once, however many chats and segments.
    const recipients = new Map<string, Promise<ChatUserKeys>>()
    const boxes: ChatHistoryGrantBox[] = []
    for (const request of requests) {
      try {
        // Pinned first, so a reset's old safety number is kept for approval.
        await pinCurrent(ctx, request.userId, request.identityKey)
        if (request.requiresApproval) continue
        // Only another member's range this device holds a key in can be
        // filled. The key record persists, so the rest cost no reads: they
        // stay open for a holder.
        if (
          request.userId === ctx.userId ||
          highestHeldKey(ctx, request) == null
        )
          continue
        const id = request.conversationId
        await once(synced, id, async () => await syncEpochs(ctx, id))
        const box = await historyBox(
          ctx,
          request,
          false,
          async () => await once(heads, id, async () => await syncLog(ctx, id)),
          async () =>
            await once(
              recipients,
              request.userId,
              async () => await ctx.client.chatUserKeys(request.userId)
            )
        )
        if (box != null) boxes.push(box)
      } catch (error) {
        // Another member's request: reported, never this chat's own history.
        ctx.memory.emit({ type: 'error', error })
      }
    }
    for (let at = 0; at < boxes.length; at += HISTORY_GRANT_BATCH) {
      try {
        const posted = await postHistoryBoxes(
          ctx,
          boxes.slice(at, at + HISTORY_GRANT_BATCH)
        )
        filled += posted.filled
        changed ||= posted.changed
      } catch (error) {
        ctx.memory.emit({ type: 'error', error })
      }
    }
    if (changed) await readHistoryGrants(ctx, mine)
    // Keys this pass read, or granted to this device, open its placeholders
    // in place. Any other chat waits for its own next read: one whose
    // history nobody can supply would otherwise be read on every pass.
    for (const id of new Set([...synced.keys(), ...mine])) {
      const state = ctx.memory.state(id)
      if (
        state?.synced !== true ||
        ![...state.opened.values()].some(
          opened => opened.status === 'locked' || opened.status === 'lost'
        )
      )
        continue
      if (!synced.has(id)) {
        // Its keys arrive on the historical stream.
        state.historyDue = true
        await syncEpochs(ctx, id)
      }
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

/** `run` for `id`, started the first time it is asked for in a pass. */
async function once<T>(
  runs: Map<string, Promise<T>>,
  id: string,
  run: () => Promise<T>
): Promise<T> {
  let started = runs.get(id)
  if (started == null) {
    started = run()
    runs.set(id, started)
  }
  return await started
}

/** What the server refuses a whole batch for when one of its boxes is bad. */
const REFUSALS = new Set(['badRequest', 'forbidden', 'notFound'])

/**
 * Posts boxes in one request. The server refuses the whole batch for one bad
 * box, so a refused batch is posted again a box at a time: only the bad ones
 * fail, each reported on its own.
 */
async function postHistoryBoxes(
  ctx: EngineContext,
  boxes: ChatHistoryGrantBox[]
): Promise<{ filled: number; changed: boolean }> {
  try {
    const answer = await ctx.client.postChatHistoryGrants(boxes)
    return {
      filled: answer.filled,
      changed: answer.results.some(result => result.status !== 'skipped')
    }
  } catch (error) {
    if (
      boxes.length === 1 ||
      !(error instanceof HttpError) ||
      !REFUSALS.has(error.code)
    )
      throw error
  }
  let filled = 0
  let changed = false
  for (const box of boxes) {
    try {
      const posted = await postHistoryBoxes(ctx, [box])
      filled += posted.filled
      changed ||= posted.changed
    } catch (error) {
      ctx.memory.emit({ type: 'error', error })
    }
  }
  return { filled, changed }
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
  await syncEpochs(ctx, request.conversationId)
  const box = await historyBox(
    ctx,
    request,
    true,
    async () => await syncLog(ctx, request.conversationId),
    async () => await ctx.client.chatUserKeys(request.userId)
  )
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
