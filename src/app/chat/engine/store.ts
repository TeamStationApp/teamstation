import type {
  ChatConversation,
  ChatEpoch,
  ChatGrantRequest,
  ChatMember,
  ChatMessage,
  ChatRead
} from '../../../common/api'
import type { Opened } from './decrypt'

/**
 * What the engine holds for the session, in memory only: the chat list, and
 * for each chat opened so far its envelopes, what they opened to, its
 * epochs, members, read cursors and who is typing. Nothing here is written
 * anywhere; plaintext never leaves memory. Keys and the verified log heads
 * live in the device's key record instead.
 */

/** One epoch as this device checked it. */
export interface EpochState {
  record: ChatEpoch
  /** Its signature verified against its creator's identity. */
  valid: boolean
}

export interface ConversationState {
  summary: ChatConversation
  /** Current members, once read. */
  members: ChatMember[] | undefined
  /** Envelopes by `seq`. */
  envelopes: Map<number, ChatMessage>
  /** What each envelope opened to, by message id. */
  opened: Map<string, Opened>
  /** Every epoch read so far, by number. */
  epochs: Map<number, EpochState>
  /** The highest epoch read: the `after` of the next epochs request. */
  epochsAfter: number
  /** From the last epochs request. */
  latest: number
  needsRotation: boolean
  noHolder: boolean
  /** Epochs have been read at least once this session. */
  epochsSynced: boolean
  /**
   * Which was read last, the list's summary or the epochs (`ChatMemory.tick`
   * at the time), so `locked` and `noHolder` come from the fresher.
   */
  summaryTick: number
  epochsTick: number
  /** Messages have been read at least once this session. */
  synced: boolean
  /** The highest `seq` read with nothing missing below it, down to `oldestSeq`. */
  newestSeq: number
  /** The lowest `seq` read. */
  oldestSeq: number | undefined
  /** Older messages remain on the server. */
  hasEarlier: boolean
  reads: ChatRead[]
  /** A completed read sync distinguishes an absent own cursor from pending data. */
  readsReady: boolean
  /** Who is typing, by user id, until when (milliseconds). */
  typing: Map<string, number>
}

export type ChatEngineEvent =
  /** A newly received post; no content is included in the alert event. */
  | { type: 'messageAlert'; conversationId: string }
  /** The chat list changed (a chat, an unread count, a title). */
  | { type: 'conversations' }
  /** One chat's view changed. */
  | { type: 'conversation'; conversationId: string }
  /** Grant requests awaiting a person's approval changed. */
  | { type: 'approvals' }
  /** The person's own devices or link requests changed. */
  | { type: 'devices' }
  /** A person's safety number changed. */
  | { type: 'safetyNumber'; userId: string }
  /** Work the engine did by itself failed. */
  | { type: 'error'; error: unknown }

export type ChatEngineListener = (event: ChatEngineEvent) => void

export function newConversationState(
  summary: ChatConversation
): ConversationState {
  return {
    summary,
    members: undefined,
    envelopes: new Map(),
    opened: new Map(),
    epochs: new Map(),
    epochsAfter: 0,
    latest: 0,
    needsRotation: false,
    noHolder: false,
    epochsSynced: false,
    summaryTick: 0,
    epochsTick: 0,
    synced: false,
    newestSeq: 0,
    oldestSeq: undefined,
    hasEarlier: false,
    reads: [],
    readsReady: false,
    typing: new Map()
  }
}

export class ChatMemory {
  /** In the server's order. */
  readonly conversations = new Map<string, ConversationState>()
  /** The last `GET /chat/grants`. */
  grants: ChatGrantRequest[] = []
  /** The list has been read at least once. */
  listed = false
  /** Counts reads, to tell which of two was later. */
  private ticks = 0

  tick(): number {
    this.ticks += 1
    return this.ticks
  }

  private readonly listeners = new Set<ChatEngineListener>()

  /** Takes a fresh chat list; chats no longer in it are forgotten. */
  setList(list: ChatConversation[]): void {
    const kept = new Map(this.conversations)
    this.conversations.clear()
    for (const summary of list) {
      const state = kept.get(summary.id) ?? newConversationState(summary)
      state.summary = summary
      state.summaryTick = this.tick()
      this.conversations.set(summary.id, state)
    }
    this.listed = true
  }

  state(conversationId: string): ConversationState | undefined {
    return this.conversations.get(conversationId)
  }

  subscribe(listener: ChatEngineListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: ChatEngineEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // A screen's listener failing is the screen's problem.
      }
    }
  }
}
