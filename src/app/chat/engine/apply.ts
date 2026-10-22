import type { ChatMessage, ChatRead } from '../../../common/api'
import type { AttachmentRef } from '../../../common/chatContent'
import type { Opened } from './decrypt'
import { resolveQuote } from './reply'

/**
 * Folding a chat's messages into what the screen shows: each post once,
 * with its latest edit, its reactions, whether and by whom it was removed,
 * the quote it replies to, and who has read it. Edits, deletes and
 * reactions apply to their target by id, in `seq` order, and wait for a
 * target not read yet.
 *
 * - An edit counts only from the post's own author.
 * - A delete's targets are on its envelope, which the server checked, so a
 *   removal shows even where the delete itself cannot be opened. A
 *   `moderatorDelete` of someone else's post shows as removed by a
 *   moderator.
 * - A reaction is one per person and emoji, the latest saying whether it
 *   stands.
 */

export interface ReactionView {
  emoji: string
  /** Who reacted with it, in the order they did. */
  userIds: string[]
  mine: boolean
}

export interface QuoteView {
  id: string
  authorId: string
  authorName: string | undefined
  snippet: string
  status?: MessageStatus | 'unavailable'
}

export type MessageStatus =
  /** Opened and verified. */
  | 'ok'
  /** No key yet: History is locked. */
  | 'locked'
  /** Before a chain break: Earlier messages can't be opened. */
  | 'lost'
  /** Did not verify, or its content is malformed. */
  | 'invalid'
  /** Deleted for everyone. */
  | 'removed'

export interface MessageView {
  id: string
  seq: number
  epoch: number
  senderUserId: string
  /** Undefined for someone no longer in the chat. */
  senderName: string | undefined
  mine: boolean
  sentAt: string
  status: MessageStatus
  removedBy: 'author' | 'moderator' | undefined
  /** The latest wording; empty unless `ok`. */
  body: string
  mentions: string[]
  quote: QuoteView | undefined
  attachments: AttachmentRef[]
  edited: boolean
  /** The ids of this post's opened edits; deleting the post clears them too. */
  editIds: string[]
  reactions: ReactionView[]
  /** Other members whose read cursor has reached it. */
  readBy: string[]
  /** Signed by an identity the sender has since replaced. */
  sentBeforeSafetyNumberChange: boolean
}

export interface FoldInput {
  /** Every envelope read, in any order. */
  envelopes: Iterable<ChatMessage>
  opened: Map<string, Opened>
  me: string
  names: Map<string, string>
  reads: ChatRead[]
}

function statusOf(opened: Opened | undefined): MessageStatus {
  switch (opened?.status) {
    case 'ok':
      return 'ok'
    case 'cleared':
      return 'removed'
    case 'lost':
      return 'lost'
    case 'invalid':
      return 'invalid'
    default:
      return 'locked'
  }
}

function remove(post: MessageView, by: 'author' | 'moderator'): void {
  post.status = 'removed'
  post.removedBy = by
  post.body = ''
  post.mentions = []
  post.quote = undefined
  post.attachments = []
}

/** The posts, oldest first, with everything aimed at them applied. */
export function foldMessages(input: FoldInput): MessageView[] {
  const envelopes = [...input.envelopes].sort((a, b) => a.seq - b.seq)
  const posts = new Map<string, MessageView>()
  const reactions = new Map<string, Map<string, Set<string>>>()
  for (const envelope of envelopes) {
    if (envelope.kind !== 'post') continue
    const opened = input.opened.get(envelope.id)
    const content =
      opened?.status === 'ok' && opened.content.type === 'text'
        ? opened.content
        : undefined
    const post: MessageView = {
      id: envelope.id,
      seq: envelope.seq,
      epoch: envelope.epoch,
      senderUserId: envelope.senderUserId,
      senderName: input.names.get(envelope.senderUserId),
      mine: envelope.senderUserId === input.me,
      sentAt: envelope.createdAt,
      status: statusOf(opened),
      removedBy: undefined,
      body: content?.body ?? '',
      mentions: content?.mentions ?? [],
      quote:
        content?.quote == null
          ? undefined
          : {
              ...content.quote,
              authorName: input.names.get(content.quote.authorId)
            },
      attachments: content?.attachments ?? [],
      edited: false,
      editIds: [],
      reactions: [],
      readBy: [],
      sentBeforeSafetyNumberChange:
        opened?.status === 'ok' && opened.replacedIdentity
    }
    if (post.status === 'removed') post.removedBy = 'author'
    posts.set(envelope.id, post)
  }

  for (const envelope of envelopes) {
    if (envelope.kind === 'delete' || envelope.kind === 'moderatorDelete') {
      for (const targetId of envelope.targetIds ?? []) {
        const post = posts.get(targetId)
        if (post == null) continue
        const own = envelope.senderUserId === post.senderUserId
        if (envelope.kind === 'delete' && !own) continue
        remove(post, own ? 'author' : 'moderator')
      }
      continue
    }
    const opened = input.opened.get(envelope.id)
    if (opened?.status !== 'ok') continue
    const content = opened.content
    if (content.type === 'edit') {
      const post = posts.get(content.targetId)
      if (
        post?.status !== 'ok' ||
        post.senderUserId !== envelope.senderUserId
      ) {
        continue
      }
      post.body = content.body
      post.mentions = content.mentions
      post.edited = true
      post.editIds.push(envelope.id)
    } else if (content.type === 'reaction') {
      if (!posts.has(content.targetId)) continue
      let byEmoji = reactions.get(content.targetId)
      if (byEmoji == null) {
        byEmoji = new Map()
        reactions.set(content.targetId, byEmoji)
      }
      let who = byEmoji.get(content.emoji)
      if (who == null) {
        who = new Set()
        byEmoji.set(content.emoji, who)
      }
      if (content.remove) who.delete(envelope.senderUserId)
      else who.add(envelope.senderUserId)
    }
  }

  const views = [...posts.values()]
  for (const post of views) {
    if (post.status === 'removed') continue
    if (post.quote != null) post.quote = resolveQuote(post.quote, posts)
    for (const [emoji, who] of reactions.get(post.id) ?? []) {
      if (who.size === 0) continue
      post.reactions.push({
        emoji,
        userIds: [...who],
        mine: who.has(input.me)
      })
    }
    post.readBy = input.reads
      .filter(read => read.userId !== post.senderUserId && read.seq >= post.seq)
      .map(read => read.userId)
  }
  return views
}
