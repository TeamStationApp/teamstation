import type {
  ChatConversation,
  ChatEpochs,
  ChatIdentity,
  ChatMessage
} from '../../common/api'
import type { ChatWake } from '../../common/push'
import { contentPreview } from '../chat/chatModel'
import {
  type ChatEngineClient,
  type EngineContext,
  KeyHolder
} from '../chat/engine/context'
import {
  IdentityCache,
  openEnvelope,
  openEpochKey,
  takeEpochs
} from '../chat/engine/decrypt'
import { ChatMemory, newConversationState } from '../chat/engine/store'
import {
  type ChatKeyRecord,
  type ChatKeyStore,
  epochKeyOf,
  withEpochKey
} from '../chat/keyRecord'
import { lstrings, sprintf } from '../locales/strings'

/**
 * What a device shows for a chat wake (`common/push.ts`), Signal style: the
 * device opens the message with its own keys and shows a notification only
 * for a DM or a mention of `wake.u`. The browser's service worker and the
 * Android task run this; the iOS extension ports the same rules.
 */

/** What opening a wake reads. */
export interface WakeDeps {
  /** This device's key record for `wake.u`; undefined when it holds none. */
  record: ChatKeyRecord | undefined
  /** `GET …/messages?after=<seq - 1>&limit=1`'s message, when not inline. */
  fetchMessage: (
    conversationId: string,
    seq: number
  ) => Promise<ChatMessage | undefined>
  /** `GET …/epochs?after=<after>`. */
  fetchEpochs: (conversationId: string, after: number) => Promise<ChatEpochs>
  /** `GET /chat/identities/:id`. */
  fetchIdentity: (identityId: string) => Promise<ChatIdentity>
}

export interface WakeNotification {
  title: string
  body: string
  url: string
  /** `chat:<conversation id>`: one notification a chat. */
  tag: string
}

/**
 * A key store that holds one record in memory and drops every write: a
 * wake reads the device's record and never changes it.
 */
function readOnlyStore(record: ChatKeyRecord): ChatKeyStore {
  return {
    load: async () => record,
    save: async () => {},
    wipe: async () => {},
    exists: async () => true
  }
}

/**
 * The chat as far as a wake knows it. Only the epochs are read of its
 * state, so the rest is what an empty chat would say.
 */
function summaryOf(wake: ChatWake): ChatConversation {
  return {
    id: wake.c,
    kind: wake.dm ? 'dm' : 'teamMembers',
    title: wake.title,
    scope: null,
    scopeName: null,
    avatarName: null,
    avatarUrl: null,
    leagueId: null,
    leaguePictureUrl: null,
    lastSeq: wake.seq,
    lastMessageAt: null,
    lastPostAt: null,
    lastPostId: null,
    lastPostSeq: wake.seq,
    preferences: {
      pinned: false,
      muted: false,
      manualUnread: false,
      manualUnreadRevision: 0
    },
    unread: 0,
    canPost: false,
    canModerate: false,
    locked: false,
    noHolder: false,
    closed: false,
    memberCount: 0,
    people: []
  }
}

/** The opened post's content, or undefined when it does not open. */
async function openPost(
  wake: ChatWake,
  record: ChatKeyRecord,
  deps: WakeDeps
): Promise<
  | { kind: 'post'; body: string; mentions: string[] }
  | { kind: 'other' }
  | undefined
> {
  const envelope = wake.env ?? (await deps.fetchMessage(wake.c, wake.seq))
  if (envelope?.conversationId !== wake.c || envelope.seq !== wake.seq)
    return undefined
  if (envelope.kind !== 'post') return { kind: 'other' }
  const ctx: EngineContext = {
    // Only identities are read, through `identities`.
    client: {} as unknown as ChatEngineClient,
    userId: record.userId,
    memory: new ChatMemory(),
    keys: new KeyHolder(readOnlyStore(record), record),
    identities: new IdentityCache({ chatIdentity: deps.fetchIdentity }),
    pageSize: 1,
    refreshKeys: async () => {}
  }
  const state = newConversationState(summaryOf(wake))
  const epochs = await deps.fetchEpochs(wake.c, envelope.epoch - 1)
  await takeEpochs(ctx, wake.c, state, epochs.epochs)
  const key =
    epochKeyOf(record, wake.c, envelope.epoch) ??
    openEpochKey(record, record.userId, wake.c, state, epochs.boxes).found.get(
      envelope.epoch
    )
  if (key != null) {
    // Into the in-memory copy only: `openEnvelope` reads the key from it.
    await ctx.keys.update(held =>
      withEpochKey(held, wake.c, envelope.epoch, key)
    )
  }
  const opened = await openEnvelope(ctx, state, envelope)
  if (opened.status !== 'ok' || opened.content.type !== 'text') return undefined
  return {
    kind: 'post',
    body: contentPreview(opened.content),
    mentions: opened.content.mentions
  }
}

/**
 * The notification a wake shows, or null to show nothing. A DM shows the
 * sender and the message; a mention of `wake.u` shows "<from> in <title>";
 * any other message, and anything but a new post, shows nothing. A DM that
 * cannot be opened here (no record for `wake.u`, a key not yet held, a
 * failed check) still says who wrote; a group message that cannot shows
 * nothing. Never throws, and never writes the record.
 */
export async function openWake(
  wake: ChatWake,
  deps: WakeDeps
): Promise<WakeNotification | null> {
  const shown = (title: string, body: string): WakeNotification => ({
    title,
    body,
    url: wake.url,
    tag: `chat:${wake.c}`
  })
  const fallback = wake.dm
    ? shown(wake.from, sprintf(lstrings.chat_push_new_message_from, wake.from))
    : null
  const record = deps.record?.userId === wake.u ? deps.record : undefined
  if (record == null) return fallback
  let post: Awaited<ReturnType<typeof openPost>>
  try {
    post = await openPost(wake, record, deps)
  } catch {
    return fallback
  }
  if (post == null) return fallback
  if (post.kind === 'other') return null
  if (wake.dm) return shown(wake.from, post.body)
  if (!post.mentions.includes(wake.u)) return null
  return shown(
    sprintf(lstrings.chat_push_mention_title, wake.from, wake.title ?? ''),
    post.body
  )
}
