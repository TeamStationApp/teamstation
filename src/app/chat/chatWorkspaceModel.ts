import type { PickedFile } from './chatFileTypes'
import type { MessageView } from './engine/apply'

export const CHAT_WIDE_WIDTH = 960
export interface ChatDraft {
  text: string
  picked: PickedFile[]
  replyTo?: MessageView
  editing?: MessageView
  scrollOffset: number
  /** Distinguishes a saved top-of-history position from a new conversation. */
  hasScrollPosition?: boolean
  /** Preserve automatic following only when the saved view was at its end. */
  followNewest?: boolean
  /** Opaque row and its viewport position survive content re-folding on reopen. */
  scrollAnchor?: { id: string; relativeY: number }
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

type DraftField = 'text' | 'replyTo' | 'editing'
let nextDraftOwner = 0
export interface ChatSubmission {
  readonly draft: ChatDraft
  readonly revisions: Record<DraftField, number>
}

/** Owns requests across keyed screen/route lifetimes, only within one session. */
export class ChatDraftOwner {
  readonly key = nextDraftOwner++
  private live = true
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
      replyTo: 0,
      editing: 0
    }
    if (before.text !== next.text) revisions.text += 1
    if (before.replyTo?.id !== next.replyTo?.id) revisions.replyTo += 1
    if (before.editing?.id !== next.editing?.id) revisions.editing += 1
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
      draft: { ...this.draft(id), picked: [...this.draft(id).picked] },
      revisions: {
        ...(this.revisions.get(id) ?? { text: 0, replyTo: 0, editing: 0 })
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
      this.write(id, {
        ...current,
        text:
          revisions.text === token.revisions.text &&
          current.text === token.draft.text
            ? ''
            : current.text,
        replyTo:
          revisions.replyTo === token.revisions.replyTo &&
          current.replyTo?.id === token.draft.replyTo?.id
            ? undefined
            : current.replyTo,
        editing:
          revisions.editing === token.revisions.editing &&
          current.editing?.id === token.draft.editing?.id
            ? undefined
            : current.editing,
        picked: current.picked.filter(
          file => !token.draft.picked.includes(file)
        )
      })
    } else this.failures.add(id)
    this.pending.delete(id)
    this.changed(id)
    return this.draft(id)
  }

  invalidate(): void {
    this.live = false
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
  { engine: object; userId: number; owner: ChatDraftOwner }
>()

export function chatDraftOwner(
  state: ChatWorkspaceState,
  engine: object,
  userId: number
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

/** Measure the still-visible list before its managed navigation changes state. */
export class ChatListNavigationCapture {
  private owner: object | undefined
  private read: (() => Promise<void>) | undefined
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

  attach(read: () => Promise<void>): () => void {
    const owner = {}
    this.owner = owner
    this.read = read
    return () => {
      if (this.owner !== owner) return
      this.owner = undefined
      this.read = undefined
    }
  }

  setContextActive(active: boolean): void {
    if (this.active && !active) {
      this.contextRevision += 1
      this.owner = undefined
      this.read = undefined
    }
    this.active = active
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
          await this.read()
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
