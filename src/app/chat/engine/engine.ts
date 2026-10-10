import type {
  ChatConversation,
  ChatDmPerson,
  ChatKindName,
  ChatMember,
  ChatMessage,
  ChatPin,
  ChatPreferences
} from '../../../common/api'
import type { AttachmentRef, ChatContent } from '../../../common/chatContent'
import { fromUtf8 } from '../../../common/chatCrypto/bytes'
import { safetyNumber } from '../../../common/chatCrypto/safetyNumber'
import { messageKey, openWithMessageKey } from '../../../common/chatCrypto/seal'
import { HttpError } from '../../../common/errors'
import type { ChatSocketEvent, GameSocket } from '../../../common/gameSocket'
import { lstrings, sprintf } from '../../locales/strings'
import { messagePreview } from '../chatModel'
import { b64, type ChatKeyStore, epochKeyOf, unb64 } from '../keyRecord'
import { foldMessages, type MessageView } from './apply'
import {
  type ChatEngineClient,
  ChatEngineError,
  type EngineContext,
  KeyHolder
} from './context'
import { fieldsOf, IdentityCache } from './decrypt'
import { approveGrant, fillGrants } from './grants'
import { type ChatSetup, type Enrolment, ensureEnrolled } from './links'
import { headOf, syncLog } from './log'
import { replyExcerpt } from './reply'
import {
  downloadAttachment,
  type FetchBytes,
  fetchBytes,
  type OutgoingFile,
  postContent,
  uploadAttachment
} from './send'
import {
  type ChatEngineListener,
  ChatMemory,
  type ConversationState
} from './store'
import {
  holdsLatest,
  loadEarlier,
  openPending,
  stateOf,
  syncEpochs,
  syncList,
  syncMembers,
  syncMessages,
  syncReads
} from './sync'

/**
 * The chat engine: everything the chat screens need, in plain TypeScript.
 *
 * It holds the session's chats in memory, keeps them current from the
 * socket's chat hints (`GameSocket.onChat`, registered when the app starts),
 * and does the key work behind the screens: epochs before a send, grants
 * for members who need history, the verified membership record, and the
 * pinned identities. Screens read `conversations()` and `view(id)` and
 * `subscribe` to know when to read them again.
 *
 * `start()` brings the device to `ready` (or says it must `link` or
 * `reset`, which `LinkDeviceScreen` handles); the list can be read before.
 */

/**
 * A DM's name, from the short names of its other members: the current ones
 * (from its members once read, else from the list), or, once they have all
 * left, the people who were in it with you, each marked "(left)", and "Just
 * you" when nobody else ever was.
 */
export function dmTitle(
  userId: number,
  members: ChatMember[] | undefined,
  people: ChatDmPerson[]
): string {
  const current =
    members == null
      ? people.filter(person => !person.left)
      : members.filter(member => member.userId !== userId)
  if (current.length > 0) {
    return current.map(person => person.shortName).join(', ')
  }
  const gone = people.filter(person => person.userId !== userId)
  if (gone.length === 0) return lstrings.chat_dm_just_you
  return gone
    .map(person => sprintf(lstrings.chat_dm_left, person.shortName))
    .join(', ')
}

/** One chat as the list shows it. */
export interface ConversationListItem {
  id: string
  kind: ChatKindName
  /** The scope's chat title, or a DM's members by short name. */
  title: string
  scope: ChatConversation['scope']
  /** The scope's own name (team, season title, league); null for a DM. */
  scopeName: string | null
  lastSeq: number
  /** When the newest message was posted, as last read; null before any. */
  lastMessageAt: string | null
  lastPostAt?: string | null
  lastPostId?: string | null
  lastPostSeq?: number
  preferences?: ChatPreferences
  preview?: string
  avatarUrl?: string | null
  unread: number
  canPost: boolean
  canModerate: boolean
  /** History is locked: this device holds no key for the latest epoch. */
  locked: boolean
  /** Nobody holds the latest key: the next send starts a new chain. */
  noHolder: boolean
  closed: boolean
  memberCount: number
  /** The membership record failed to verify on this device. */
  unverified: boolean
}

export interface MemberView extends ChatMember {
  /** The person's safety number changed since this device first saw it. */
  safetyNumberChanged: boolean
}

/** What the conversation screen draws. */
export interface ConversationView {
  pins?: ChatPin[]
  conversation: ConversationListItem
  messages: MessageView[]
  members: MemberView[]
  /** Who is typing now, other than the person. */
  typing: Array<{ userId: number; name: string | undefined }>
  /** "History is locked — it unlocks when another member opens TeamStation". */
  historyLocked: boolean
  /** "Earlier messages can't be opened". */
  earlierLost: boolean
  /** "Membership record could not be verified". */
  unverified: boolean
  /** Whether and why the composer is off. */
  composer: 'enabled' | 'locked' | 'readOnly' | 'closed'
  /** Older messages are on the server; `loadEarlier` reads them. */
  hasEarlier: boolean
  /** Verified envelope paging cursor, including pages without visible posts. */
  historyBefore?: number
  /** "<name>'s safety number changed", where the record says so. */
  safetyChanges: Array<{
    userId: number
    name: string | undefined
    seq: number
    at: number
  }>
}

/** A reset identity's request, waiting for an approver to tap Approve. */
export interface GrantApproval {
  requestId: number
  conversationId: string
  conversationTitle: string | undefined
  userId: number
  name: string | undefined
  /** Before the reset, when this device had seen it. */
  oldSafetyNumber: string | undefined
  newSafetyNumber: string
}

export interface ChatEngineOptions {
  client: ChatEngineClient
  store: ChatKeyStore
  /** The signed-in user. */
  userId: number
  /** How this device names itself if it registers. */
  device: ChatSetup['device']
  /** The app's socket, for chat hints and typing. */
  socket?: Pick<GameSocket, 'onChat' | 'sendTyping'>
  /** How an attachment's blob is fetched from its presigned URL. */
  fetchBytes?: FetchBytes
  /** Messages per request (100). */
  pageSize?: number
  /** How long a typing hint shows, in milliseconds (6 s). */
  typingMs?: number
  now?: () => number
}

/** Whether a refusal says the person is no longer in the chat. */
const isGone = (error: unknown): boolean =>
  (error instanceof HttpError && error.code === 'notFound') ||
  (error instanceof ChatEngineError && error.code === 'notMember')

/** What a hint asks to be read again. */
type Part = 'members' | 'epochs' | 'messages' | 'reads'

/** The later of the list's last-message time and the newest envelope read. */
function newest(
  listed: string | null,
  state: ConversationState
): string | null {
  const read = state.envelopes.get(state.newestSeq)?.createdAt ?? null
  if (read == null) return listed
  if (listed == null) return read
  return Date.parse(read) > Date.parse(listed) ? read : listed
}

export class ChatEngine {
  /** Where the device stands; `idle` until `start()`. */
  status: 'idle' | Enrolment['state'] = 'idle'
  private readonly memory = new ChatMemory()
  private readonly options: ChatEngineOptions
  private readonly identities: IdentityCache
  private context: EngineContext | undefined
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly wanted = new Map<string, Set<Part>>()
  private readonly work = new Set<Promise<unknown>>()
  /** Chats a screen has opened: hints keep them current. */
  private readonly active = new Set<string>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly safety = new Map<string, string>()
  private readonly personalPins = new Map<string, ChatPin[]>()
  private readonly previewVersions = new Map<
    string,
    { state: ConversationState; version: string }
  >()

  private readonly previewWaiting: Array<() => void> = []
  private previewActive = 0
  private readonly pendingAlerts = new Map<string, Set<number>>()
  private readonly alertedSeq = new Map<string, number>()
  private unlisten: (() => void) | undefined
  private stopped = false

  constructor(options: ChatEngineOptions) {
    this.options = options
    this.identities = new IdentityCache(options.client)
  }

  private get now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private get setup(): ChatSetup {
    const { client, store, userId, device } = this.options
    return { client, store, userId, device }
  }

  /** The key work's context; throws until `start()` reached `ready`. */
  private get ctx(): EngineContext {
    if (this.context == null || this.status !== 'ready') {
      throw new ChatEngineError('notReady', 'Chat is not set up on this device')
    }
    return this.context
  }

  /** Hears when what the screens show has changed. */
  subscribe(listener: ChatEngineListener): () => void {
    return this.memory.subscribe(listener)
  }

  /**
   * Starts hearing the socket's chat hints. Called when the signed-in app
   * starts, so hints arrive on every screen. Answers the way to stop.
   */
  listen(): () => void {
    const socket = this.options.socket
    if (socket == null || this.unlisten != null) return () => {}
    const stop = socket.onChat(event => {
      this.hint(event)
    })
    this.unlisten = stop
    return () => {
      if (this.unlisten !== stop) return
      stop()
      this.unlisten = undefined
    }
  }

  /**
   * Brings the device to `ready`, `link` or `reset` (see `links.ts`). When
   * ready, reads the chats and fills the grant requests it may.
   */
  async start(): Promise<Enrolment['state']> {
    const enrolment = await ensureEnrolled(this.setup)
    if (this.context == null) {
      this.context = {
        client: this.options.client,
        userId: this.options.userId,
        memory: this.memory,
        keys: new KeyHolder(this.options.store, enrolment.record),
        identities: this.identities,
        pageSize: this.options.pageSize ?? 100,
        refreshKeys: async () => {
          await this.context?.keys.replace(
            async () => (await ensureEnrolled(this.setup)).record
          )
        }
      }
    } else {
      await this.context.keys.replace(async () => enrolment.record)
    }
    this.status = enrolment.state
    if (this.status === 'ready') {
      await this.refresh()
      this.later('grants', async () => {
        await fillGrants(this.ctx)
      })
    }
    return this.status
  }

  /** Stops hearing hints and drops every timer. */
  stop(): void {
    this.stopped = true
    this.unlisten?.()
    this.unlisten = undefined
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  /** Waits until the work the engine started by itself is done. */
  async idle(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work])
  }

  // --- The list ---------------------------------------------------------

  /**
   * Reads the chat list again, and the members of DMs, for their names: of
   * each DM not read yet, or whose count no longer matches the list's.
   */
  async refresh(): Promise<ConversationListItem[]> {
    await this.serial('list', async () => {
      await syncList({ client: this.options.client, memory: this.memory })
      for (const state of this.memory.conversations.values()) {
        if (
          state.summary.kind === 'dm' &&
          state.members?.length !== state.summary.memberCount
        ) {
          state.members = await this.options.client.chatMembers(
            state.summary.id
          )
        }
      }
    })
    for (const cache of [
      this.personalPins,
      this.previewVersions,
      this.pendingAlerts,
      this.alertedSeq
    ]) {
      for (const id of cache.keys())
        if (!this.memory.conversations.has(id)) cache.delete(id)
    }
    for (const id of [...this.pendingAlerts.keys()]) {
      await this.serial(id, async () => {
        const state = this.memory.state(id)
        if (state == null || this.stopped) return
        try {
          this.announcePost(id)
          const pending = this.pendingAlerts.get(id)
          if (pending == null) return
          let after = Math.min(...pending) - 1
          const through = Math.max(...pending)
          const limit = this.options.pageSize ?? 100
          while (after < through) {
            const page = await this.options.client.chatMessages(id, {
              after,
              before: through + 1,
              limit
            })
            if (this.stopped || this.memory.state(id) !== state) return
            this.announcePost(id, page)
            const next = page.at(-1)?.seq
            if (next == null || next <= after || page.length < limit) break
            after = next
          }
        } catch (error) {
          if (this.memory.state(id) !== state || this.stopped) return
          if (isGone(error)) {
            this.memory.conversations.delete(id)
            this.personalPins.delete(id)
            this.previewVersions.delete(id)
            this.pendingAlerts.delete(id)
            this.alertedSeq.delete(id)
            this.active.delete(id)
          } else {
            // List metadata succeeded. Retain unknown hints for a later read;
            // this optional classification failure must not hide that list.
            this.memory.emit({ type: 'error', error })
          }
        }
      })
    }
    for (const id of this.active) {
      if (this.memory.conversations.has(id)) {
        try {
          await this.serial(id, async () => {
            await this.readPins(id)
          })
        } catch (error) {
          if (!isGone(error)) throw error
          this.personalPins.delete(id)
          this.active.delete(id)
        }
      }
    }
    this.memory.emit({ type: 'conversations' })
    return this.conversations()
  }

  /** Every chat, in the server's order, as last read. */
  conversations(): ConversationListItem[] {
    return [...this.memory.conversations.values()].map(state =>
      this.item(state)
    )
  }

  private item(state: ConversationState): ConversationListItem {
    const summary = state.summary
    let lastPost = {
      id: summary.lastPostId,
      seq: summary.lastPostSeq ?? 0,
      at: summary.lastPostAt
    }
    for (const envelope of state.envelopes.values()) {
      if (envelope.kind === 'post' && envelope.seq > lastPost.seq) {
        lastPost = {
          id: envelope.id,
          seq: envelope.seq,
          at: envelope.createdAt
        }
      }
    }
    const keyed =
      this.context != null &&
      state.epochsSynced &&
      state.epochsTick > state.summaryTick
    const locked = keyed
      ? state.latest > 0 && !holdsLatest(this.context!, state)
      : summary.locked
    return {
      id: summary.id,
      kind: summary.kind,
      title:
        summary.title ??
        dmTitle(this.options.userId, state.members, summary.people),
      scope: summary.scope,
      scopeName: summary.scopeName,
      lastSeq: Math.max(summary.lastSeq, state.newestSeq),
      lastMessageAt: newest(summary.lastMessageAt, state),
      lastPostAt: lastPost.at,
      lastPostId: lastPost.id,
      lastPostSeq: lastPost.seq,
      preferences: summary.preferences,
      avatarUrl:
        summary.kind === 'dm'
          ? state.members?.find(member => member.userId !== this.options.userId)
              ?.avatarUrl
          : undefined,
      preview: state.synced
        ? messagePreview(
            foldMessages({
              envelopes: state.envelopes.values(),
              opened: state.opened,
              me: this.options.userId,
              names: new Map(
                (state.members ?? []).map(member => [
                  member.userId,
                  member.shortName
                ])
              ),
              reads: state.reads
            }).find(message => message.id === lastPost.id)
          )
        : undefined,
      unread: summary.unread,
      canPost: summary.canPost,
      canModerate: summary.canModerate,
      locked,
      noHolder: keyed ? state.noHolder : summary.noHolder,
      closed: summary.closed,
      memberCount: summary.memberCount,
      unverified: this.context?.keys.record.logs[summary.id]?.broken === true
    }
  }

  // --- One chat ---------------------------------------------------------

  /** Loads only visible-row previews, without activating a chat or marking read. */
  async loadPreview(conversationId: string): Promise<void> {
    const state = this.memory.state(conversationId)
    if (state == null || state.summary.lastSeq === 0 || this.status !== 'ready')
      return
    const previewVersion = (): string =>
      `${state.summary.lastSeq}:${this.item(state).locked}:${this.item(state).unverified}`
    const version = previewVersion()
    const cached = this.previewVersions.get(conversationId)
    if (cached?.state === state && cached.version === version) return
    this.previewVersions.set(conversationId, { state, version })
    if (this.previewActive >= 3)
      await new Promise<void>(resolve => {
        this.previewWaiting.push(resolve)
      })
    else this.previewActive += 1
    let syncedVersion = version
    try {
      if (this.stopped || this.memory.state(conversationId) !== state) return
      await this.serial(conversationId, async () => {
        if (this.memory.state(conversationId) !== state) return
        // One catch-up pass handles a concurrent snapshot without waiting for
        // an indefinitely busy chat to become quiet. A newer revision remains
        // uncached and can be requested by the next visible-row refresh.
        for (let pass = 0; pass < 2; pass += 1) {
          if (this.stopped || this.memory.state(conversationId) !== state)
            return
          await syncMembers(this.ctx, conversationId)
          await syncLog(this.ctx, conversationId)
          await syncEpochs(this.ctx, conversationId)
          const through = state.summary.lastSeq
          const lastPostId = state.summary.lastPostId
          syncedVersion = previewVersion()
          await syncMessages(this.ctx, conversationId, through)
          if (lastPostId != null)
            while (
              !this.stopped &&
              this.memory.state(conversationId) === state &&
              ![...state.envelopes.values()].some(
                message => message.id === lastPostId
              ) &&
              state.hasEarlier
            ) {
              await loadEarlier(this.ctx, conversationId)
            }
          if (syncedVersion === previewVersion()) break
        }
      })
      if (this.stopped || this.memory.state(conversationId) !== state) return
      this.previewVersions.set(conversationId, {
        state,
        version: syncedVersion
      })
      this.announcePost(conversationId)
      this.memory.emit({ type: 'conversations' })
    } catch (error) {
      if (this.memory.state(conversationId) !== state) return
      this.previewVersions.delete(conversationId)
      if (!isGone(error)) throw error
      this.memory.conversations.delete(conversationId)
      this.personalPins.delete(conversationId)
      this.active.delete(conversationId)
      this.memory.emit({ type: 'conversations' })
    } finally {
      const next = this.previewWaiting.shift()
      if (next != null) next()
      else this.previewActive -= 1
    }
  }

  /**
   * Reads a chat (its members, membership record, epochs, messages and
   * read cursors) and keeps it current from then on. Answers its view.
   */
  async open(conversationId: string): Promise<ConversationView> {
    const ctx = this.ctx
    this.active.add(conversationId)
    try {
      await this.serial(conversationId, async () => {
        await syncMembers(ctx, conversationId)
        await syncLog(ctx, conversationId)
        await syncEpochs(ctx, conversationId)
        await syncMessages(ctx, conversationId)
        await syncReads(ctx, conversationId)
        await this.readPins(conversationId)
      })
    } catch (error) {
      if (isGone(error)) this.active.delete(conversationId)
      throw error
    }
    this.memory.emit({ type: 'conversation', conversationId })
    return this.mustView(conversationId)
  }

  /** The screen left the chat: hints no longer read it. */
  close(conversationId: string): void {
    this.active.delete(conversationId)
  }

  /** Reads one page of older messages. */
  async loadEarlier(conversationId: string): Promise<ConversationView> {
    const ctx = this.ctx
    await this.serial(conversationId, async () => {
      await loadEarlier(ctx, conversationId)
    })
    this.memory.emit({ type: 'conversation', conversationId })
    return this.mustView(conversationId)
  }

  private mustView(conversationId: string): ConversationView {
    const view = this.view(conversationId)
    if (view == null) {
      throw new ChatEngineError('notMember', `Not in chat ${conversationId}`)
    }
    return view
  }

  /** A chat as last read, or undefined when it is not in the list. */
  view(conversationId: string): ConversationView | undefined {
    const state = this.memory.state(conversationId)
    if (state == null) return undefined
    const record = this.context?.keys.record
    const members = state.members ?? []
    const names = new Map(
      members.map(member => [member.userId, member.shortName])
    )
    const conversation = this.item(state)
    const messages = foldMessages({
      envelopes: state.envelopes.values(),
      opened: state.opened,
      me: this.options.userId,
      names,
      reads: state.reads
    })
    let earlierLost = [...state.opened.values()].some(
      opened => opened.status === 'lost'
    )
    if (!earlierLost && state.hasEarlier && record != null) {
      for (const [number, epoch] of state.epochs) {
        if (
          epoch.record.chainBreak &&
          epochKeyOf(record, conversationId, number - 1) == null
        ) {
          earlierLost = true
        }
      }
    }
    const head = record?.logs[conversationId]
    const now = this.now
    const historyLocked = conversation.locked && !conversation.noHolder
    return {
      conversation,
      pins: (this.personalPins.get(conversationId) ?? []).filter(
        pin =>
          !messages.some(
            message =>
              message.id === pin.messageId && message.status === 'removed'
          )
      ),
      messages,
      members: members.map(member => ({
        ...member,
        safetyNumberChanged: record?.previousPins[member.userId] != null
      })),
      typing: [...state.typing]
        .filter(([, until]) => until > now)
        .map(([userId]) => ({ userId, name: names.get(userId) })),
      historyLocked,
      earlierLost,
      unverified: head?.broken === true,
      composer: conversation.closed
        ? 'closed'
        : !conversation.canPost
          ? 'readOnly'
          : historyLocked
            ? 'locked'
            : 'enabled',
      hasEarlier: state.hasEarlier,
      historyBefore: state.oldestSeq,
      safetyChanges: (head?.resets ?? []).map(reset => ({
        ...reset,
        name: names.get(reset.userId)
      }))
    }
  }

  // --- Writing ----------------------------------------------------------

  private async post(
    conversationId: string,
    kind: Parameters<typeof postContent>[2],
    content: ChatContent,
    options?: Parameters<typeof postContent>[4]
  ): Promise<MessageView | undefined> {
    const ctx = this.ctx
    const stored = await this.serial(conversationId, async () => {
      const message = await postContent(
        ctx,
        conversationId,
        kind,
        content,
        options
      )
      await syncMessages(ctx, conversationId)
      return message
    })
    this.memory.emit({ type: 'conversation', conversationId })
    this.memory.emit({ type: 'conversations' })
    return this.view(conversationId)?.messages.find(
      message => message.id === stored.id
    )
  }

  /** A post in the chat as last read, or `target`. */
  private target(conversationId: string, targetId: string): MessageView {
    const found = this.view(conversationId)?.messages.find(
      message => message.id === targetId
    )
    if (found == null) {
      throw new ChatEngineError('target', 'There is no such message here')
    }
    return found
  }

  /**
   * Sends text, optionally replying to `quoteId` and carrying attachments
   * already uploaded (`attach` does both steps). Answers the posted message.
   */
  async sendText(
    conversationId: string,
    body: string,
    options: {
      quoteId?: string
      mentions?: number[]
      attachments?: AttachmentRef[]
    } = {}
  ): Promise<MessageView | undefined> {
    const quoted =
      options.quoteId == null
        ? undefined
        : this.target(conversationId, options.quoteId)
    const attachments = options.attachments ?? []
    return await this.post(
      conversationId,
      'post',
      {
        type: 'text',
        body,
        mentions: options.mentions ?? [],
        ...(quoted == null
          ? {}
          : {
              quote: {
                id: quoted.id,
                authorId: quoted.senderUserId,
                snippet: Array.from(replyExcerpt(quoted)).slice(0, 200).join('')
              }
            }),
        attachments
      },
      attachments.length === 0
        ? undefined
        : { attachmentIds: attachments.map(attachment => attachment.id) }
    )
  }

  /** Seals and uploads files, then sends them with `body`. */
  async attach(
    conversationId: string,
    files: OutgoingFile[],
    body = '',
    options: { quoteId?: string; mentions?: number[] } = {}
  ): Promise<MessageView | undefined> {
    const ctx = this.ctx
    const attachments: AttachmentRef[] = []
    for (const file of files) {
      attachments.push(await uploadAttachment(ctx, conversationId, file))
    }
    return await this.sendText(conversationId, body, {
      ...options,
      attachments
    })
  }

  /** Adds (or, with `remove`, takes back) a reaction. */
  async react(
    conversationId: string,
    targetId: string,
    emoji: string,
    remove = false
  ): Promise<void> {
    this.target(conversationId, targetId)
    await this.post(conversationId, 'reaction', {
      type: 'reaction',
      targetId,
      emoji,
      remove
    })
  }

  /** Changes the wording of one of the person's own posts. */
  async edit(
    conversationId: string,
    targetId: string,
    body: string,
    mentions: number[] = []
  ): Promise<void> {
    const target = this.target(conversationId, targetId)
    if (!target.mine || target.status !== 'ok') {
      throw new ChatEngineError(
        'target',
        'Only your own messages can be edited'
      )
    }
    await this.post(conversationId, 'edit', {
      type: 'edit',
      targetId,
      body,
      mentions
    })
  }

  /** Deletes one of the person's own posts for everyone, with its edits. */
  async deleteMessage(conversationId: string, targetId: string): Promise<void> {
    const target = this.target(conversationId, targetId)
    if (!target.mine) {
      throw new ChatEngineError(
        'target',
        'Only your own messages can be deleted'
      )
    }
    await this.post(
      conversationId,
      'delete',
      { type: 'delete', targetId },
      { targetIds: [targetId, ...target.editIds] }
    )
  }

  /** A moderator's Delete for everyone, of anyone's post and its edits. */
  async moderatorDelete(
    conversationId: string,
    targetId: string
  ): Promise<void> {
    const target = this.target(conversationId, targetId)
    await this.post(
      conversationId,
      'moderatorDelete',
      { type: 'delete', targetId },
      { targetIds: [targetId, ...target.editIds] }
    )
  }

  /**
   * Reports someone else's post to the site administrators. It discloses
   * that one message: its content exactly as it was sealed, and its own
   * message key, never the epoch's. Answers whether the server could prove
   * the sender wrote it.
   */
  async report(
    conversationId: string,
    messageId: string
  ): Promise<{ id: string; verified: boolean }> {
    const ctx = this.ctx
    const state = await stateOf(ctx, conversationId)
    let envelope: ChatMessage | undefined
    for (const held of state.envelopes.values()) {
      if (held.id === messageId) envelope = held
    }
    // As the person sees it: a post since deleted is no longer readable.
    const shown = this.view(conversationId)?.messages.find(
      message => message.id === messageId
    )
    const epochKey =
      envelope == null
        ? undefined
        : epochKeyOf(ctx.keys.record, conversationId, envelope.epoch)
    if (
      envelope?.kind !== 'post' ||
      shown?.status !== 'ok' ||
      shown.mine ||
      epochKey == null
    ) {
      throw new ChatEngineError(
        'target',
        'Only someone else’s message can be reported'
      )
    }
    const key = messageKey(epochKey, conversationId, messageId)
    const plaintext = fromUtf8(
      openWithMessageKey({
        ...fieldsOf(envelope),
        nonce: unb64(envelope.nonce),
        ciphertext: unb64(envelope.ciphertext),
        messageKey: key
      })
    )
    return await ctx.client.reportChatMessage({
      messageId,
      plaintext,
      messageKey: b64(key)
    })
  }

  /** Moves the person's read cursor to the newest message read. */
  async markRead(
    conversationId: string,
    clearManualUnreadRevision?: number
  ): Promise<void> {
    const ctx = this.ctx
    const moved = await this.serial(conversationId, async () => {
      const state = await stateOf(ctx, conversationId)
      const seq = state.newestSeq
      const mine = state.reads.find(read => read.userId === ctx.userId)
      const preferences = state.summary.preferences
      const clearing =
        preferences?.manualUnread &&
        preferences.manualUnreadRevision === clearManualUnreadRevision
      if (seq <= (mine?.seq ?? 0) && !clearing) return false
      const answer = await ctx.client.markChatRead(
        conversationId,
        seq,
        clearManualUnreadRevision
      )
      state.reads = [
        ...state.reads.filter(read => read.userId !== ctx.userId),
        { userId: ctx.userId, seq: answer.seq }
      ]
      const stillClearing =
        clearing &&
        state.summary.preferences?.manualUnreadRevision ===
          clearManualUnreadRevision
      state.summary = {
        ...state.summary,
        unread: 0,
        ...(stillClearing
          ? {
              preferences: {
                ...state.summary.preferences,
                manualUnread: false
              }
            }
          : {})
      }
      return true
    })
    if (!moved) return
    this.memory.emit({ type: 'conversation', conversationId })
    this.memory.emit({ type: 'conversations' })
  }

  /** Tells the others the person is typing; false when it was not sent. */
  typing(conversationId: string): boolean {
    return this.options.socket?.sendTyping(conversationId) ?? false
  }

  async setPreferences(
    conversationId: string,
    patch: Partial<Pick<ChatPreferences, 'pinned' | 'muted' | 'manualUnread'>>
  ): Promise<void> {
    await this.serial('list', async () => {
      const preferences = await this.options.client.updateChatPreferences(
        conversationId,
        patch
      )
      const state = this.memory.state(conversationId)
      if (state != null) state.summary = { ...state.summary, preferences }
    })
    this.memory.emit({ type: 'conversations' })
    this.memory.emit({ type: 'conversation', conversationId })
  }

  private async readPins(conversationId: string): Promise<void> {
    const state = this.memory.state(conversationId)
    const pins = await this.options.client.chatPins(conversationId)
    if (state != null && this.memory.state(conversationId) === state)
      this.personalPins.set(conversationId, pins)
  }

  async pinMessage(
    conversationId: string,
    messageId: string,
    pinned: boolean
  ): Promise<void> {
    if (pinned && this.target(conversationId, messageId).status !== 'ok') {
      throw new ChatEngineError('target', 'Only a readable post can be pinned')
    }
    await this.serial(conversationId, async () => {
      const state = this.memory.state(conversationId)
      const pins = await this.options.client.pinChatMessage(
        conversationId,
        messageId,
        pinned
      )
      if (state != null && this.memory.state(conversationId) === state)
        this.personalPins.set(conversationId, pins)
    })
    this.memory.emit({ type: 'conversation', conversationId })
  }

  /** Fetches, checks and opens an attachment. */
  async openAttachment(ref: AttachmentRef): Promise<Uint8Array> {
    return await downloadAttachment(
      this.ctx,
      ref,
      this.options.fetchBytes ?? fetchBytes
    )
  }

  // --- Keys and trust ---------------------------------------------------

  /** Reads the open grant requests, and fills those the rule allows. */
  async fillGrants(): Promise<number> {
    const ctx = this.ctx
    return await this.serial('grants', async () => await fillGrants(ctx))
  }

  /**
   * Requests from reset identities this person may approve: never their
   * own, which only another member can open.
   */
  approvals(): GrantApproval[] {
    const record = this.context?.keys.record
    const mine = record?.identity?.keys.publicKey
    if (record == null || mine == null) return []
    return this.memory.grants
      .filter(
        request =>
          request.identityReset &&
          request.canApprove &&
          request.userId !== this.options.userId
      )
      .map(request => {
        const state = this.memory.state(request.conversationId)
        const old = record.previousPins[request.userId]
        return {
          requestId: request.id,
          conversationId: request.conversationId,
          conversationTitle: state == null ? undefined : this.item(state).title,
          userId: request.userId,
          name: state?.members?.find(member => member.userId === request.userId)
            ?.shortName,
          oldSafetyNumber:
            old == null || old === request.identityKey
              ? undefined
              : this.safetyWith(mine, request.userId, old),
          newSafetyNumber: this.safetyWith(
            mine,
            request.userId,
            request.identityKey
          )
        }
      })
  }

  /** Approves a reset identity's request: boxes it the history. */
  async approve(requestId: number): Promise<void> {
    const ctx = this.ctx
    await this.serial('grants', async () => {
      await approveGrant(ctx, requestId)
    })
  }

  private safetyWith(mine: Uint8Array, userId: number, key: string): string {
    const cached = `${b64(mine)}:${userId}:${key}`
    let digits = this.safety.get(cached)
    if (digits == null) {
      digits = safetyNumber(
        { userId: this.options.userId, identityKey: mine },
        { userId, identityKey: unb64(key) }
      )
      this.safety.set(cached, digits)
    }
    return digits
  }

  /**
   * The 60-digit safety number the person shares with `userId`, from their
   * current identity; undefined when they have none.
   */
  async safetyNumber(userId: number): Promise<string | undefined> {
    const mine = this.ctx.keys.record.identity?.keys.publicKey
    if (mine == null) return undefined
    const keys = await this.options.client.chatUserKeys(userId)
    if (keys.identity == null) return undefined
    return this.safetyWith(mine, userId, keys.identity.publicKey)
  }

  // --- Hints ------------------------------------------------------------

  private announcePost(
    conversationId: string,
    received?: Iterable<ChatMessage>
  ): void {
    const pending = this.pendingAlerts.get(conversationId)
    const state = this.memory.state(conversationId)
    if (pending == null || state == null) return
    const known =
      received == null
        ? state.envelopes
        : new Map([...received].map(envelope => [envelope.seq, envelope]))
    let announce = false
    for (const seq of [...pending].sort((a, b) => a - b)) {
      const envelope = known.get(seq)
      if (envelope == null) continue
      pending.delete(seq)
      if (
        envelope.kind !== 'post' ||
        seq <= (this.alertedSeq.get(conversationId) ?? 0)
      )
        continue
      this.alertedSeq.set(conversationId, seq)
      if (
        envelope.senderUserId !== this.options.userId &&
        !state.summary.preferences?.muted
      )
        announce = true
    }
    if (pending.size === 0) this.pendingAlerts.delete(conversationId)
    if (announce) this.memory.emit({ type: 'messageAlert', conversationId })
  }

  private hint(event: ChatSocketEvent): void {
    if (this.stopped) return
    switch (event.type) {
      case 'chatUser':
        if (event.kind === 'preferences') {
          this.relist()
          for (const id of this.active)
            this.later(`pins:${id}`, async () => {
              await this.serial(id, async () => {
                await this.readPins(id)
              })
              this.memory.emit({ type: 'conversation', conversationId: id })
            })
          return
        }
        this.memory.emit({ type: 'devices' })
        return
      case 'chatTyping':
        this.typed(event.conversationId, event.userId)
        return
      case 'resync':
        this.pendingAlerts.clear()
        this.relist()
        for (const id of this.active) {
          this.want(id, ['members', 'epochs', 'messages', 'reads'])
        }
        this.grants()
        return
      case 'chat':
        break
      default:
        return
    }
    const id = event.conversationId
    switch (event.kind) {
      case 'message':
        if (event.seq != null && event.seq > (this.alertedSeq.get(id) ?? 0)) {
          const pending = this.pendingAlerts.get(id) ?? new Set<number>()
          pending.add(event.seq)
          this.pendingAlerts.set(id, pending)
        }
        this.relist()
        this.want(id, ['messages'])
        return
      case 'read':
        this.want(id, ['reads'])
        return
      case 'members':
        this.relist()
        this.want(id, ['members'])
        this.grants()
        return
      case 'epoch':
        this.relist()
        this.want(id, ['epochs'])
        return
      case 'grant':
        this.relist()
        this.want(id, ['epochs'])
        this.grants()
    }
  }

  private typed(conversationId: string, userId: number): void {
    const state = this.memory.state(conversationId)
    if (state == null || userId === this.options.userId) return
    const ms = this.options.typingMs ?? 6000
    state.typing.set(userId, this.now + ms)
    this.memory.emit({ type: 'conversation', conversationId })
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      this.memory.emit({ type: 'conversation', conversationId })
    }, ms + 50)
    this.timers.add(timer)
  }

  private relist(): void {
    if (!this.memory.listed) return
    this.later('relist', async () => {
      await this.refresh()
    })
  }

  private grants(): void {
    if (this.status !== 'ready') return
    this.later('grants', async () => {
      await fillGrants(this.ctx)
    })
  }

  /** Reads the asked-for parts of an open chat, once for many hints. */
  private want(conversationId: string, parts: Part[]): void {
    if (this.status !== 'ready' || !this.active.has(conversationId)) return
    const pending = this.wanted.get(conversationId)
    if (pending != null) {
      for (const part of parts) pending.add(part)
      return
    }
    this.wanted.set(conversationId, new Set(parts))
    this.track(
      this.serial(conversationId, async () => {
        const asked = this.wanted.get(conversationId) ?? new Set<Part>()
        this.wanted.delete(conversationId)
        await this.syncParts(conversationId, asked)
      })
    )
  }

  private async syncParts(
    conversationId: string,
    parts: Set<Part>
  ): Promise<void> {
    const ctx = this.ctx
    try {
      if (parts.has('members')) {
        await syncMembers(ctx, conversationId)
        await syncLog(ctx, conversationId)
      }
      if (parts.has('epochs')) await syncEpochs(ctx, conversationId)
      if (parts.has('messages')) {
        await syncMessages(ctx, conversationId)
      } else if (parts.has('epochs')) {
        await openPending(ctx, await stateOf(ctx, conversationId))
      }
      if (parts.has('reads')) await syncReads(ctx, conversationId)
    } catch (error) {
      if (!isGone(error)) throw error
      // Removed from the chat: it leaves the list, and nothing reads it.
      this.active.delete(conversationId)
      this.memory.conversations.delete(conversationId)
      this.memory.emit({ type: 'conversations' })
    }
    this.announcePost(conversationId)
    this.memory.emit({ type: 'conversation', conversationId })
  }

  /** Runs `run` after what is queued under `key`, unless one is already waiting. */
  private later(key: string, run: () => Promise<void>): void {
    const marker = `later:${key}`
    if (this.wanted.has(marker)) return
    this.wanted.set(marker, new Set())
    this.track(
      this.serial(key, async () => {
        this.wanted.delete(marker)
        await run()
      })
    )
  }

  private track(work: Promise<unknown>): void {
    const tracked = work.catch((error: unknown) => {
      this.memory.emit({ type: 'error', error })
    })
    this.work.add(tracked)
    tracked.finally(() => this.work.delete(tracked)).catch(() => undefined)
  }

  /** Runs `run` after everything queued under `key`. */
  private async serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.then(run, run)
    const tail = next.catch(() => undefined)
    this.queues.set(key, tail)
    tail
      .then(() => {
        if (this.queues.get(key) === tail) this.queues.delete(key)
      })
      .catch(() => undefined)
    return await next
  }

  /** Whether this device holds the key the chat's latest epoch needs. */
  holdsLatest(conversationId: string): boolean {
    const state = this.memory.state(conversationId)
    return (
      this.context != null && state != null && holdsLatest(this.context, state)
    )
  }

  /** The head of a chat's membership log as this device verified it. */
  verifiedMembers(conversationId: string): number[] | undefined {
    if (this.context == null) return undefined
    const head = headOf(this.context, conversationId)
    return head.broken ? undefined : head.members
  }
}
