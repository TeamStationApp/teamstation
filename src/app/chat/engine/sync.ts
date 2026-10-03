import type { ChatMessage } from '../../../common/api'
import { epochKeyOf } from '../keyRecord'
import { ChatEngineError, type EngineContext } from './context'
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
  ctx.memory.setList(await ctx.client.chatConversations())
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
 */
export async function syncEpochs(
  ctx: EngineContext,
  conversationId: string
): Promise<ConversationState> {
  const state = await stateOf(ctx, conversationId)
  const answer = await ctx.client.chatEpochs(conversationId, state.epochsAfter)
  await takeEpochs(ctx, conversationId, state, answer.epochs)
  state.latest = answer.latest
  state.needsRotation = answer.needsRotation
  state.noHolder = answer.noHolder
  state.epochsAfter = Math.max(
    state.epochsAfter,
    ...answer.epochs.map(epoch => epoch.epoch)
  )
  state.epochsSynced = true
  state.epochsTick = ctx.memory.tick()
  const first = await openEpochKeys(ctx, conversationId, state, answer.boxes)
  if (first.needKeys) {
    await ctx.refreshKeys()
    await openEpochKeys(ctx, conversationId, state, answer.boxes)
  }
  return state
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

function keep(state: ConversationState, envelopes: ChatMessage[]): void {
  for (const envelope of envelopes) {
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
    if (opened != null && opened.status !== 'locked') continue
    const next = await openEnvelope(ctx, state, envelope)
    if (opened?.status !== next.status) changed += 1
    state.opened.set(envelope.id, next)
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
  conversationId: string
): Promise<number> {
  const state = await stateOf(ctx, conversationId)
  let arrived = 0
  if (!state.synced) {
    const page = await ctx.client.chatMessages(conversationId, {
      before: Math.max(state.summary.lastSeq, state.newestSeq) + 1,
      limit: ctx.pageSize
    })
    keep(state, page)
    arrived += page.length
    state.hasEarlier = page.length === ctx.pageSize && page[0].seq > 1
    state.oldestSeq = page[0]?.seq
    state.newestSeq = page[page.length - 1]?.seq ?? 0
    state.synced = true
  }
  for (;;) {
    const page = await ctx.client.chatMessages(conversationId, {
      after: state.newestSeq,
      limit: ctx.pageSize
    })
    keep(state, page)
    arrived += page.length
    if (page.length > 0) {
      state.newestSeq = page[page.length - 1].seq
      state.oldestSeq ??= page[0].seq
    }
    if (page.length < ctx.pageSize) break
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
  const page = await ctx.client.chatMessages(conversationId, {
    before: state.oldestSeq,
    limit: ctx.pageSize
  })
  keep(state, page)
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
}
