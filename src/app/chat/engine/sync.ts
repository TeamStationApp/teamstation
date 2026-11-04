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
 * Here it is read only when something may have delivered to it
 * (`historyDue`) or after this device's keys changed; the engine also reads
 * it when an open chat shows locked history.
 */
const epochSyncs: Runs<ConversationState> = new WeakMap()
const historySyncs: Runs<void> = new WeakMap()

export async function syncEpochs(
  ctx: EngineContext,
  conversationId: string
): Promise<ConversationState> {
  return await coalesce(
    epochSyncs,
    ctx,
    conversationId,
    async () => await drainEpochs(ctx, conversationId)
  )
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
  await coalesce(historySyncs, ctx, conversationId, async () => {
    try {
      await drainHistoryBoxes(ctx, conversationId)
    } finally {
      if (historyDelivering.get(ctx)?.delete(conversationId) === true)
        ctx.memory.emit({ type: 'conversation', conversationId })
    }
  })
}

/**
 * Chats whose stream has brought this device keys and is still opening them.
 * Only an actual delivery shows `recovering`: a read that finds nothing would
 * otherwise flash it on every visit.
 */
const historyDelivering = new WeakMap<EngineContext, Set<string>>()

/** Whether this device is opening historical keys the chat's stream brought. */
export function historyStreaming(
  ctx: EngineContext,
  conversationId: string
): boolean {
  return historyDelivering.get(ctx)?.has(conversationId) === true
}

/** One chat's read in flight, and whether a caller came while it ran. */
interface Run<T> {
  again: boolean
  done?: Promise<T>
}
type Runs<T> = WeakMap<EngineContext, Map<string, Run<T>>>

/**
 * Runs one read per chat at a time. A call made while a read runs may have a
 * reason that read started too early to see (a grant, a new epoch), so it
 * gets one more read after it, shared with every other such call.
 */
async function coalesce<T>(
  runs: Runs<T>,
  ctx: EngineContext,
  conversationId: string,
  read: () => Promise<T>
): Promise<T> {
  let pending = runs.get(ctx)
  if (pending == null) {
    pending = new Map()
    runs.set(ctx, pending)
  }
  const running = pending.get(conversationId)
  if (running?.done != null) {
    running.again = true
    return await running.done
  }
  const run: Run<T> = { again: false }
  const chats = pending
  chats.set(conversationId, run)
  run.done = (async () => {
    try {
      let result = await read()
      while (run.again) {
        run.again = false
        result = await read()
      }
      return result
    } finally {
      chats.delete(conversationId)
    }
  })()
  return await run.done
}

/** Reads the current epochs, then starts the historical stream when due. */
async function drainEpochs(
  ctx: EngineContext,
  conversationId: string
): Promise<ConversationState> {
  const state = await stateOf(ctx, conversationId)
  // Without `boxesAfter` the server answers every current box at once.
  const answer = await ctx.client.chatEpochs(conversationId, state.epochsAfter)
  await takeEpochs(ctx, conversationId, state, answer.epochs)
  state.latest = answer.latest
  state.needsRotation = answer.needsRotation
  state.noHolder = answer.noHolder
  state.historyRecoveryVersion = answer.historyRecoveryVersion
  state.freshEpochsEnabled = answer.freshEpochsEnabled === true
  ctx.memory.recoveryVersion = answer.historyRecoveryVersion
  ctx.memory.recoveryProbed = true
  // Every read answers anew: a reset identity's old boxes are no longer served.
  state.latestHasServerBox = answer.boxes.some(
    box => box.epoch === answer.latest
  )
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
  // Each read answers for itself: one that opens every box clears it.
  state.currentKeysMissing = opened.needKeys
  const keys = keysOf(ctx)
  if (state.historyKeys != null && state.historyKeys !== keys)
    state.historyDue = true
  state.historyKeys = keys
  if (state.historyRecoveryVersion === 1 && state.historyDue) {
    state.historyDue = false
    // The stream reports its own failures.
    const stream = syncHistoryBoxes(ctx, conversationId).catch(() => {})
    ctx.detach?.(stream)
  }
  return state
}

/** This device's identity and per-user key generations: a reset changes them. */
function keysOf(ctx: EngineContext): string {
  const record = ctx.keys.record
  return [record.identity?.id, ...record.puks.map(puk => puk.generation)].join(
    ':'
  )
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
  state.historyDue = false
  let delivered = false
  let more = false
  const stopped = (): boolean => ctx.live?.() === false
  for (let page = 0; page < 100 && !stopped(); page++) {
    try {
      const answer = await ctx.client.chatEpochs(
        conversationId,
        state.epochsAfter,
        { boxesAfter: state.boxesCursor, boxLimit: 100 }
      )
      // Stopped while it read: nothing more is opened or stored.
      if (stopped()) return
      // The stream restarts at '0' each session and carries the boxes this
      // device already holds: only a key it lacks is a recovery.
      const identity = ctx.keys.record.identity?.id
      if (
        answer.boxes.some(
          box =>
            box.identityId === identity &&
            epochKeyOf(ctx.keys.record, conversationId, box.epoch) == null
        )
      ) {
        let delivering = historyDelivering.get(ctx)
        if (delivering == null) {
          delivering = new Set()
          historyDelivering.set(ctx, delivering)
        }
        if (!delivering.has(conversationId)) {
          delivering.add(conversationId)
          ctx.memory.emit({ type: 'conversation', conversationId })
        }
      }
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
      more = answer.hasMoreBoxes === true
      if (!more) break
      await Promise.resolve()
    } catch (error) {
      // A chat the person has left is purged by the engine, not reported.
      if (isGone(error) || stopped()) return
      state.historyError = true
      ctx.memory.emit({ type: 'error', error })
      break
    }
  }
  if (stopped()) return
  // Bound each drain; the next epochs read continues from the saved cursor.
  if (more) state.historyDue = true
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
