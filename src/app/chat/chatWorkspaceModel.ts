import {
  type ChatAttentionSession,
  newAttentionSession
} from './chatAttentionModel'
import type { PickedFile } from './chatFileTypes'
import { type MentionToken, sameMentionTokens } from './chatMentionsModel'
import type { MessageView } from './engine/apply'
import type { ConversationView } from './engine/engine'

export const CHAT_WIDE_WIDTH = 960
export interface ChatDraft {
  text: string
  mentionTokens?: MentionToken[]
  picked: PickedFile[]
  replyTo?: MessageView
  editing?: MessageView
  scrollOffset: number
  /** Distinguishes a saved top-of-history position from a new conversation. */
  hasScrollPosition?: boolean
  /** Preserve automatic following only when the saved view was at its end. */
  followNewest?: boolean
  /**
   * Opaque row and its viewport position survive content re-folding on reopen.
   * `readableTop` is the overlays' clearance it was saved under, so floating
   * chrome measured again on reopen is not mistaken for newly covering it.
   */
  scrollAnchor?: {
    id: string
    relativeY: number
    bodyInset?: number
    readableTop?: number
  }
}
export interface ChatWorkspaceState {
  drafts: Map<string, ChatDraft>
  listOffset: number
  listAnchor?: { id: string; relativeY: number }
  selectedId?: string
}
export function newChatWorkspaceState(): ChatWorkspaceState {
  return { drafts: new Map(), listOffset: 0 }
}
export function emptyChatDraft(): ChatDraft {
  return { text: '', picked: [], scrollOffset: 0 }
}

type DraftField = 'text' | 'replyTo' | 'editing' | 'picked' | 'mentionTokens'
const samePickedFiles = (
  before: readonly PickedFile[],
  after: readonly PickedFile[]
): boolean =>
  before.length === after.length &&
  before.every((file, index) => file === after[index])
let nextDraftOwner = 0
export interface ChatSubmission {
  readonly draft: ChatDraft
  readonly revisions: Record<DraftField, number>
}

/** Owns requests across keyed screen/route lifetimes, only within one session. */
export class ChatDraftOwner {
  readonly key = nextDraftOwner++
  private live = true
  private readonly attentionSessions = new Map<string, ChatAttentionSession>()

  attention(id: string): ChatAttentionSession | undefined {
    return this.attentionSessions.get(id)
  }

  beginAttention(
    id: string,
    opened: ConversationView
  ): ChatAttentionSession | undefined {
    if (!this.live) return undefined
    const existing = this.attention(id)
    if (existing != null) return existing
    const session = newAttentionSession(opened)
    if (session != null) this.attentionSessions.set(id, session)
    return session
  }

  forgetAttention(id: string): void {
    this.attentionSessions.delete(id)
  }

  private readonly revisions = new Map<string, Record<DraftField, number>>()
  private readonly pending = new Map<string, ChatSubmission>()
  private readonly failures = new Set<string>()
  private readonly readers = new Map<string, () => ChatDraft>()
  private readonly listeners = new Map<string, Set<() => void>>()

  constructor(private readonly state: ChatWorkspaceState) {}

  draft(id: string): ChatDraft {
    return this.state.drafts.get(id) ?? emptyChatDraft()
  }

  write(id: string, next: ChatDraft): void {
    if (!this.live) return
    const before = this.draft(id)
    const revisions = this.revisions.get(id) ?? {
      text: 0,
      mentionTokens: 0,
      replyTo: 0,
      editing: 0,
      picked: 0
    }
    if (before.text !== next.text) revisions.text += 1
    if (!sameMentionTokens(before.mentionTokens, next.mentionTokens))
      revisions.mentionTokens += 1
    if (before.replyTo?.id !== next.replyTo?.id) revisions.replyTo += 1
    if (before.editing?.id !== next.editing?.id) revisions.editing += 1
    if (!samePickedFiles(before.picked, next.picked)) revisions.picked += 1
    this.revisions.set(id, revisions)
    this.state.drafts.set(id, next)
  }

  attach(id: string, read: () => ChatDraft, changed: () => void): () => void {
    this.readers.set(id, read)
    const listeners = this.listeners.get(id) ?? new Set()
    listeners.add(changed)
    this.listeners.set(id, listeners)
    return () => {
      if (this.readers.get(id) === read) this.readers.delete(id)
      listeners.delete(changed)
      if (listeners.size === 0) this.listeners.delete(id)
    }
  }

  isSending(id: string): boolean {
    return this.pending.has(id)
  }

  failed(id: string): boolean {
    return this.failures.has(id)
  }

  begin(id: string): ChatSubmission | undefined {
    if (!this.live || this.pending.has(id)) return undefined
    this.pull(id)
    const token: ChatSubmission = {
      draft: {
        ...this.draft(id),
        picked: [...this.draft(id).picked],
        ...(this.draft(id).mentionTokens == null
          ? {}
          : {
              mentionTokens: this.draft(id).mentionTokens!.map(token => ({
                ...token
              }))
            })
      },
      revisions: {
        ...(this.revisions.get(id) ?? {
          text: 0,
          mentionTokens: 0,
          replyTo: 0,
          editing: 0,
          picked: 0
        })
      }
    }
    this.pending.set(id, token)
    this.failures.delete(id)
    this.changed(id)
    return token
  }

  finish(
    id: string,
    token: ChatSubmission,
    success: boolean
  ): ChatDraft | undefined {
    if (!this.live || this.pending.get(id) !== token) return undefined
    this.pull(id)
    const current = this.draft(id)
    const revisions = this.revisions.get(id)!
    if (success) {
      const unchanged =
        revisions.text === token.revisions.text &&
        revisions.mentionTokens === token.revisions.mentionTokens &&
        revisions.replyTo === token.revisions.replyTo &&
        revisions.editing === token.revisions.editing &&
        revisions.picked === token.revisions.picked &&
        current.text === token.draft.text &&
        sameMentionTokens(current.mentionTokens, token.draft.mentionTokens) &&
        current.replyTo?.id === token.draft.replyTo?.id &&
        current.editing?.id === token.draft.editing?.id &&
        samePickedFiles(current.picked, token.draft.picked)
      // A newer draft owns its whole context, including unchanged reply/files.
      if (unchanged)
        this.write(id, {
          ...current,
          text: '',
          ...(current.mentionTokens == null ? {} : { mentionTokens: [] }),
          replyTo: undefined,
          editing: undefined,
          picked: []
        })
    } else this.failures.add(id)
    this.pending.delete(id)
    this.changed(id)
    return this.draft(id)
  }

  invalidate(): void {
    this.live = false
    this.attentionSessions.clear()
    this.pending.clear()
    this.readers.clear()
    this.listeners.clear()
  }

  private pull(id: string): void {
    const read = this.readers.get(id)
    if (read != null) this.write(id, read())
    // Ensure even an empty initial draft has revision counters.
    else if (!this.revisions.has(id)) this.write(id, this.draft(id))
  }

  private changed(id: string): void {
    for (const listener of this.listeners.get(id) ?? []) listener()
  }
}

const owners = new WeakMap<
  ChatWorkspaceState,
  { engine: object; userId: string; owner: ChatDraftOwner }
>()

export function chatDraftOwner(
  state: ChatWorkspaceState,
  engine: object,
  userId: string
): ChatDraftOwner {
  const previous = owners.get(state)
  if (previous?.engine === engine && previous.userId === userId)
    return previous.owner
  if (previous != null) {
    previous.owner.invalidate()
    state.drafts.clear()
    state.selectedId = undefined
    state.listOffset = 0
    state.listAnchor = undefined
  }
  const owner = new ChatDraftOwner(state)
  owners.set(state, { engine, userId, owner })
  return owner
}

export type ChatListCaptureResult = 'accepted' | 'stale' | 'unavailable'
export type ChatListPositionCapture = () =>
  Promise<ChatListCaptureResult> | Promise<void>

/** Measure the still-visible list before its managed navigation changes state. */
export class ChatListNavigationCapture {
  /**
   * Every list attached, the last on top. Two can be mounted at once — a
   * conversation and the list a drag back reveals beneath it, or both sides
   * of a push — and the one that leaves gives the reader back to the one it
   * covered.
   */
  private readers: Array<{ owner: object; read: ChatListPositionCapture }> = []

  private get owner(): object | undefined {
    return this.readers.at(-1)?.owner
  }

  private get read(): ChatListPositionCapture | undefined {
    return this.readers.at(-1)?.read
  }

  private captureFlight:
    | { owner: object; context: number; work: Promise<ChatListCaptureResult> }
    | undefined

  private running = false
  private active = true
  private contextRevision = 0
  private readonly queued: Array<{
    owner: object | undefined
    context: number
    change: () => void
    done: () => void
    fail: (error: unknown) => void
  }> = []

  constructor(readonly context?: object) {}

  attach(read: ChatListPositionCapture): () => void {
    const owner = {}
    this.readers.push({ owner, read })
    return () => {
      this.readers = this.readers.filter(reader => reader.owner !== owner)
    }
  }

  setContextActive(active: boolean): void {
    if (this.active && !active) {
      this.contextRevision += 1
      this.readers = []
    }
    this.active = active
  }

  hasReader(): boolean {
    return this.active && this.read != null
  }

  async capture(): Promise<ChatListCaptureResult> {
    const owner = this.owner
    const read = this.read
    const context = this.contextRevision
    if (!this.active || owner == null || read == null) return 'unavailable'
    if (
      this.captureFlight?.owner === owner &&
      this.captureFlight.context === context
    )
      return await this.captureFlight.work
    const current = (): boolean =>
      this.active &&
      this.owner === owner &&
      this.read === read &&
      this.contextRevision === context
    const work = async (): Promise<ChatListCaptureResult> => {
      for (let pass = 0; pass < 2; pass++) {
        if (!current()) return 'unavailable'
        let result: ChatListCaptureResult | undefined
        try {
          result = (await read()) ?? undefined
        } catch {
          return 'unavailable'
        }
        if (!current()) return 'unavailable'
        if (result !== 'stale') return result ?? 'accepted'
      }
      return 'stale'
    }
    const flight = { owner, context, work: work() }
    this.captureFlight = flight
    try {
      return await flight.work
    } finally {
      if (this.captureFlight === flight) this.captureFlight = undefined
    }
  }

  private readonly waiting = new Set<string>()

  /**
   * `navigate`, but a change already waiting under the same `kind` takes this
   * one with it: a second Back pressed while the first still waits on the
   * capture would otherwise pop twice, the history with it, past the screen.
   */
  async navigateOnce(kind: string, change: () => void): Promise<void> {
    if (this.waiting.has(kind)) return
    this.waiting.add(kind)
    try {
      await this.navigate(change)
    } finally {
      this.waiting.delete(kind)
    }
  }

  async navigate(change: () => void): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.queued.push({
        owner: this.owner,
        context: this.contextRevision,
        change,
        done: resolve,
        fail: reject
      })
      if (!this.running)
        this.drain().catch((error: unknown) => {
          console.error(error)
        })
    })
  }

  private async drain(): Promise<void> {
    this.running = true
    while (this.queued.length > 0) {
      const owner = this.queued[0].owner
      if (owner === this.owner && this.read != null) {
        // A failed capture retains the previous position; navigation still works.
        try {
          await this.capture()
        } catch {}
      }
      const batch = []
      while (this.queued.length > 0 && this.queued[0].owner === owner)
        batch.push(this.queued.shift()!)
      for (const request of batch) {
        try {
          if (this.active && request.context === this.contextRevision)
            request.change()
          request.done()
        } catch (error) {
          request.fail(error)
        }
      }
    }
    this.running = false
  }
}
