import type { ChatMessage } from '../../../common/api'
import { epochKeyOf } from '../keyRecord'
import { ChatEngineError, type EngineContext, isGone } from './context'
import { openEnvelope, openEpochKeys, pinCurrent, takeEpochs } from './decrypt'
import type { ConversationState } from './store'

/**
 * Reading a chat from the server: its epochs (by `after`), its messages
 * (by `seq`, forward from the newest read, and back a page at a time), its
 * members and its read cursors. What arrives is checked and opened by
 * `decrypt.ts`, and kept in memory (`store.ts`).
 */

/** Reads the chat list again. */
export async function syncList(
  ctx: Pick<EngineContext, 'client' | 'memory'>
): Promise<void> {
  const revision = ctx.memory.blockRevision
  const list = await ctx.client.chatConversations()
  if (revision !== ctx.memory.blockRevision) {
    await syncList(ctx)
    return
  }
  ctx.memory.setList(list)
}

/**
 * The chat's state, reading the list first when the chat is not in it yet
 * (a DM made a moment ago, say). Throws when the person is not in it.
 */
export async function stateOf(
  ctx: EngineContext,
  conversationId: string
): Promise<ConversationState> {
  let state = ctx.memory.state(conversationId)
  if (state == null) {
    await syncList(ctx)
    state = ctx.memory.state(conversationId)
  }
  if (state == null) {
    throw new ChatEngineError('notMember', `Not in chat ${conversationId}`)
  }
  return state
}

/**
 * Reads the epochs after the last one read and this device's boxes, checks
 * them, and opens every key they give. A box for a per-user key generation
 * this device lacks makes it fetch its keys once and try again.
 *
 * A history-capable server also streams this device's historical boxes. That
 * stream runs on its own (`syncHistoryBoxes`): reading or sending in a chat
 * waits for the current epochs only, never for a slow historical delivery.
 */
const epochSyncs = new WeakMap<
  EngineContext,
  Map<string, Promise<ConversationState>>
>()
const historySyncs = new WeakMap<EngineContext, Map<string, Promise<void>>>()

export async function syncEpochs(
  ctx: EngineContext,
  conversationId: string
): Promise<ConversationState> {
  let pending = epochSyncs.get(ctx)
  if (pending == null) {
    pending = new Map()
    epochSyncs.set(ctx, pending)
  }
  const existing = pending.get(conversationId)
  if (existing != null) return await existing
  const run = drainEpochs(ctx, conversationId)
  pending.set(conversationId, run)
  try {
    return await run
  } finally {
    pending.delete(conversationId)
  }
}

/**
 * The chat's historical box stream: the one already running, or a new one
 * from the saved cursor. It opens what it delivers, and the chat's locked
 * messages with it; a failure marks the chat's history and is reported.
 */
export async function syncHistoryBoxes(
  ctx: EngineContext,
  conversationId: string
): Promise<void> {
  let pending = historySyncs.get(ctx)
  if (pending == null) {
    pending = new Map()
    historySyncs.set(ctx, pending)
  }
  const existing = pending.get(conversationId)
  if (existing != null) {
    await existing
    return
  }
  const run = drainHistoryBoxes(ctx, conversationId)
  pending.set(conversationId, run)
  try {
    await run
  } finally {
    pending.delete(conversationId)
  }
}

/** Reads the current epochs, then starts the historical stream on its own. */
async function drainEpochs(
  ctx: EngineContext,
  conversationId: string
): Promise<ConversationState> {
  const state = await stateOf(ctx, conversationId)
  for (let page = 0; page < 100; page++) {
    const answer = await ctx.client.chatEpochs(
      conversationId,
      state.epochsAfter
    )
    await takeEpochs(ctx, conversationId, state, answer.epochs)
    if (answer.latest !== state.latest) state.latestHasServerBox = false
    state.latest = answer.latest
    state.needsRotation = answer.needsRotation
    state.noHolder = answer.noHolder
    state.historyRecoveryVersion = answer.historyRecoveryVersion
    state.freshEpochsEnabled = answer.freshEpochsEnabled === true
    ctx.memory.recoveryVersion = answer.historyRecoveryVersion
    ctx.memory.recoveryProbed = true
    if (answer.boxes.some(box => box.epoch === answer.latest))
      state.latestHasServerBox = true
    state.epochsAfter = Math.max(
      state.epochsAfter,
      ...answer.epochs.map(epoch => epoch.epoch)
    )
    state.epochsSynced = true
    state.epochsTick = ctx.memory.tick()
    let opened = await openEpochKeys(ctx, conversationId, state, answer.boxes)
    if (opened.needKeys) {
      await ctx.refreshKeys()
      opened = await openEpochKeys(ctx, conversationId, state, answer.boxes)
    }
    // A failed store save throws before this point. A missing PUK must be
    // replayed too; cursor lifetime is this account/server/identity session.
    if (opened.needKeys) {
      state.historyError = true
      break
    }
    if (answer.hasMoreBoxes !== true) break
    // Bound each drain. The next refresh continues at the last saved page.
    await Promise.resolve()
  }
  if (state.historyRecoveryVersion === 1)
    syncHistoryBoxes(ctx, conversationId).catch(() => {})
  return state
}

/**
 * Streams this device's historical boxes from the saved cursor. A key it
 * opens unlocks the chat's messages in place.
 */
async function drainHistoryBoxes(
  ctx: EngineContext,
  conversationId: string
): Promise<void> {
  const state = await stateOf(ctx, conversationId)
  let delivered = false
  for (let page = 0; page < 100; page++) {
    try {
      const answer = await ctx.client.chatEpochs(
        conversationId,
        state.epochsAfter,
        { boxesAfter: state.boxesCursor, boxLimit: 100 }
      )
      await takeEpochs(ctx, conversationId, state, answer.epochs)
      state.epochsAfter = Math.max(
        state.epochsAfter,
        ...answer.epochs.map(epoch => epoch.epoch)
      )
      let opened = await openEpochKeys(ctx, conversationId, state, answer.boxes)
      if (opened.needKeys) {
        await ctx.refreshKeys()
        opened = await openEpochKeys(ctx, conversationId, state, answer.boxes)
      }
      if (opened.needKeys) {
        state.historyError = true
        break
      }
      if (answer.nextBoxesCursor == null)
        throw new Error('Missing box delivery cursor')
      if (
        BigInt(answer.nextBoxesCursor) < BigInt(state.boxesCursor) ||
        (answer.hasMoreBoxes === true &&
          answer.nextBoxesCursor === state.boxesCursor)
      )
        throw new Error('Non-advancing box delivery cursor')
      state.boxesCursor = answer.nextBoxesCursor
      state.historyError = false
      delivered ||= answer.boxes.length > 0
      if (answer.hasMoreBoxes !== true) break
      await Promise.resolve()
    } catch (error) {
      // A chat the person has left is purged by the engine, not reported.
      if (isGone(error)) return
      state.historyError = true
      ctx.memory.emit({ type: 'error', error })
      break
    }
  }
  if (delivered && state.synced && (await openPending(ctx, state)) > 0) {
    ctx.memory.emit({ type: 'conversation', conversationId })
    ctx.memory.emit({ type: 'conversations' })
  }
}

/** Whether this device holds the key of the chat's latest epoch. */
export function holdsLatest(
  ctx: EngineContext,
  state: ConversationState
): boolean {
  return (
    state.latest > 0 &&
    epochKeyOf(ctx.keys.record, state.summary.id, state.latest) != null
  )
}

function keep(
  ctx: EngineContext,
  state: ConversationState,
  envelopes: ChatMessage[]
): void {
  for (const envelope of envelopes) {
    if (
      ctx.memory.blockedUserIds.has(envelope.senderUserId) &&
      envelope.kind !== 'delete' &&
      envelope.kind !== 'moderatorDelete'
    )
      continue
    state.envelopes.set(envelope.seq, envelope)
    // A message read again (cleared since) is opened again.
    const opened = state.opened.get(envelope.id)
    if (envelope.clearedAt != null && opened?.status !== 'cleared') {
      state.opened.delete(envelope.id)
    }
  }
}

/**
 * Opens every envelope not yet opened, and those still locked, reading the
 * epochs first when one is under an epoch not read yet.
 */
export async function openPending(
  ctx: EngineContext,
  state: ConversationState
): Promise<number> {
  let newest = 0
  for (const envelope of state.envelopes.values()) {
    newest = Math.max(newest, envelope.epoch)
  }
  if (newest > state.epochsAfter) await syncEpochs(ctx, state.summary.id)
  let changed = 0
  for (const envelope of state.envelopes.values()) {
    const opened = state.opened.get(envelope.id)
    if (
      opened != null &&
      opened.status !== 'locked' &&
      opened.status !== 'lost'
    )
      continue
    const next = await openEnvelope(ctx, state, envelope)
    if (opened?.status !== next.status) changed += 1
    if (state.envelopes.has(envelope.seq)) state.opened.set(envelope.id, next)
  }
  return changed
}

/**
 * Reads the chat's messages: the latest page on the first look, then
 * every message after the newest read, a page at a time. Answers how many
 * arrived.
 */
export async function syncMessages(
  ctx: EngineContext,
  conversationId: string,
  through?: number
): Promise<number> {
  const state = await stateOf(ctx, conversationId)
  let arrived = 0
  const revision = ctx.memory.blockRevision
  if (!state.synced) {
    const page = await ctx.client.chatMessages(conversationId, {
      before: (through ?? Math.max(state.summary.lastSeq, state.newestSeq)) + 1,
      limit: ctx.pageSize
    })
    if (revision !== ctx.memory.blockRevision)
      return await syncMessages(ctx, conversationId, through)
    keep(ctx, state, page)
    arrived += page.length
    state.hasEarlier = page.length === ctx.pageSize && page[0].seq > 1
    state.oldestSeq = page[0]?.seq
    state.newestSeq = page[page.length - 1]?.seq ?? 0
    while (
      state.blockHistoryFloor != null &&
      state.oldestSeq != null &&
      state.oldestSeq > state.blockHistoryFloor &&
      state.hasEarlier
    ) {
      const older = await ctx.client.chatMessages(conversationId, {
        before: state.oldestSeq,
        limit: ctx.pageSize
      })
      if (revision !== ctx.memory.blockRevision)
        return await syncMessages(ctx, conversationId, through)
      keep(ctx, state, older)
      arrived += older.length
      if (older.length > 0) state.oldestSeq = older[0].seq
      state.hasEarlier = older.length === ctx.pageSize && older[0].seq > 1
    }
    state.synced = true
  }
  for (;;) {
    const page = await ctx.client.chatMessages(conversationId, {
      after: state.newestSeq,
      before: through == null ? undefined : through + 1,
      limit: ctx.pageSize
    })
    if (revision !== ctx.memory.blockRevision)
      return await syncMessages(ctx, conversationId, through)
    keep(ctx, state, page)
    arrived += page.length
    if (page.length > 0) {
      state.newestSeq = page[page.length - 1].seq
      state.oldestSeq ??= page[0].seq
    }
    if (
      page.length < ctx.pageSize ||
      (through != null && state.newestSeq >= through)
    )
      break
  }
  await openPending(ctx, state)
  return arrived
}

/** Reads one page of older messages. Answers how many arrived. */
export async function loadEarlier(
  ctx: EngineContext,
  conversationId: string
): Promise<number> {
  const state = await stateOf(ctx, conversationId)
  if (!state.synced) return await syncMessages(ctx, conversationId)
  if (!state.hasEarlier || state.oldestSeq == null) return 0
  const revision = ctx.memory.blockRevision
  const page = await ctx.client.chatMessages(conversationId, {
    before: state.oldestSeq,
    limit: ctx.pageSize
  })
  if (revision !== ctx.memory.blockRevision)
    return await syncMessages(ctx, conversationId)
  keep(ctx, state, page)
  if (page.length > 0) state.oldestSeq = page[0].seq
  state.hasEarlier = page.length === ctx.pageSize && page[0].seq > 1
  await openPending(ctx, state)
  return page.length
}

/** Reads the members, and pins each one's current identity key. */
export async function syncMembers(
  ctx: EngineContext,
  conversationId: string
): Promise<ConversationState> {
  const state = await stateOf(ctx, conversationId)
  const members = await ctx.client.chatMembers(conversationId)
  state.members = members
  for (const member of members) {
    if (member.identityKey != null) {
      await pinCurrent(ctx, member.userId, member.identityKey)
    }
  }
  return state
}

/** Reads every member's read cursor. */
export async function syncReads(
  ctx: EngineContext,
  conversationId: string
): Promise<void> {
  const state = await stateOf(ctx, conversationId)
  state.reads = await ctx.client.chatReads(conversationId)
  state.readsReady = true
}
