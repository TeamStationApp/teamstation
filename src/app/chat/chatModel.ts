import { lstrings } from '../locales/strings'
import type { MessageView } from './engine/apply'
import type {
  ConversationListItem,
  ConversationView,
  GrantApproval,
  MemberView
} from './engine/engine'

/**
 * What the chat screens decide without drawing anything: how the list is
 * grouped, who may start a conversation, what a message's ticks say, and
 * what a long press offers. Pure, so it is tested on its own.
 */

/** One heading of the chat list and its chats. */
export interface ChatGroup {
  key: string
  /** The personal Pinned or Chats heading. */
  title: string | undefined
  kind: 'pinned' | 'chats'
  chats: ConversationListItem[]
}

const time = (chat: ConversationListItem): number => {
  const value = Date.parse(
    (chat.lastPostAt === undefined ? chat.lastMessageAt : chat.lastPostAt) ?? ''
  )
  return Number.isFinite(value) ? value : 0
}

/**
 * Personal pins precede other chats; each section ranks DMs before groups,
 * then latest posts with a stable id tie-breaker.
 */
export function groupChats(chats: ConversationListItem[]): ChatGroup[] {
  return ([true, false] as const).flatMap(pinned => {
    const sorted = chats
      .filter(chat => (chat.preferences?.pinned === true) === pinned)
      .sort((a, b) => {
        const kind = Number(a.kind !== 'dm') - Number(b.kind !== 'dm')
        const recency = time(b) - time(a)
        return kind !== 0
          ? kind
          : recency !== 0
            ? recency
            : a.id < b.id
              ? -1
              : a.id > b.id
                ? 1
                : 0
      })
    return sorted.length === 0
      ? []
      : [
          {
            key: pinned ? 'pinned' : 'chats',
            kind: pinned ? ('pinned' as const) : ('chats' as const),
            title: pinned ? lstrings.chat_pinned : lstrings.chat_chats,
            chats: sorted
          }
        ]
  })
}

const SUBGROUP: Record<ConversationListItem['kind'], string> = {
  leagueOrg: 'Org',
  seasonStaff: 'Staff',
  seasonAllStaff: 'All Staff',
  seasonAnnouncements: 'Announcements',
  teamStaff: 'Staff',
  teamMembers: 'Members',
  teamFans: 'Fans',
  dm: ''
}

export function conversationTitle(chat: ConversationListItem): string {
  return chat.kind === 'dm' || chat.scope == null
    ? chat.title
    : (chat.scopeName ?? chat.title)
}

export function conversationPill(
  chat: ConversationListItem
): string | undefined {
  if (chat.kind === 'dm' || chat.scope == null) return undefined
  return `${chat.scope.type[0].toUpperCase()}${chat.scope.type.slice(1)} ${SUBGROUP[chat.kind]}`
}

/** Only verified accessible message content may become a local preview. */
export function messagePreview(message: MessageView | undefined): string {
  if (message == null) return lstrings.chat_message_unavailable
  if (message.status !== 'ok')
    return {
      removed: lstrings.chat_removed_author,
      locked: lstrings.chat_locked_message,
      lost: lstrings.chat_lost_message,
      invalid: lstrings.chat_invalid_message
    }[message.status]
  if (message.body !== '') return message.body
  if (message.attachments.length > 1)
    return `${message.attachments.length} ${lstrings.chat_attachments_label}`
  const attachment = message.attachments[0]
  if (attachment == null) return lstrings.chat_message_unavailable
  if (attachment.contentType.startsWith('image/'))
    return lstrings.chat_photo_label
  if (attachment.contentType.startsWith('video/'))
    return lstrings.chat_video_label
  return `${lstrings.chat_file}: ${attachment.fileName}`
}

/**
 * Whether the person may start a DM at all. Somebody whose only ties are
 * follows (Fans chats and DMs they were added to) never may, and the server
 * would answer every name with `notCandidate`; anyone who shares a Staff,
 * Members, Season Staff, All Staff or Org chat may name someone.
 */
export function canStartDm(chats: ConversationListItem[]): boolean {
  return chats.some(
    chat =>
      chat.kind === 'teamStaff' ||
      chat.kind === 'teamMembers' ||
      chat.kind === 'seasonStaff' ||
      chat.kind === 'seasonAllStaff' ||
      chat.kind === 'leagueOrg'
  )
}

/** Whether anything in the list is unread, for the tab's dot. */
export function hasUnread(chats: ConversationListItem[]): boolean {
  return chats.some(
    chat => chat.unread > 0 || chat.preferences?.manualUnread === true
  )
}

/** A DM holds at most this many people (the server's `DM_MAX_MEMBERS`). */
export const DM_MAX_MEMBERS = 20

/** Up to this many members, ticks name who read; above it, a count. */
export const TICKS_BY_NAME = 20

/**
 * What a message's ticks say, for the person's own messages: who has read
 * it, by name, in a DM or a chat of up to 20; "Seen by N" above that; and
 * "Sent" before anyone has.
 */
export function readLine(
  message: MessageView,
  conversation: ConversationListItem,
  members: MemberView[],
  formerMember: string
):
  | { kind: 'sent' }
  | { kind: 'names'; names: string[] }
  | { kind: 'count'; count: number } {
  if (message.readBy.length === 0) return { kind: 'sent' }
  if (conversation.kind !== 'dm' && conversation.memberCount > TICKS_BY_NAME) {
    return { kind: 'count', count: message.readBy.length }
  }
  const names = new Map(
    members.map(member => [member.userId, member.shortName])
  )
  return {
    kind: 'names',
    names: message.readBy.map(userId => names.get(userId) ?? formerMember)
  }
}

/** The six reactions a long press offers before the picker. */
export const QUICK_REACTIONS = ['❤️', '👍', '👎', '😂', '😮', '😢'] as const

export type MessageAction =
  'reply' | 'react' | 'copy' | 'pin' | 'unpin' | 'delete' | 'deleteForEveryone'

/**
 * The requested message controls: readable reply/reaction/copy and personal
 * pin, plus author or moderator deletion where allowed. Locked placeholders
 * retain only an existing personal Unpin action; edit/report stay outside
 * these restricted menus.
 */
export function actionsFor(
  message: MessageView,
  view: Pick<ConversationView, 'composer' | 'conversation' | 'pins'>
): MessageAction[] {
  const pinned = view.pins?.some(pin => pin.messageId === message.id) === true
  if (message.status !== 'ok') {
    // Lost/invalid envelopes may still be removed by an allowed author or
    // moderator. Locked content exposes only an existing personal Unpin.
    const actions: MessageAction[] = pinned ? ['unpin'] : []
    if (
      message.status !== 'removed' &&
      message.status !== 'locked' &&
      view.composer === 'enabled'
    ) {
      if (message.mine) actions.push('delete')
      else if (view.conversation.canModerate) actions.push('deleteForEveryone')
    }
    return actions
  }
  const actions: MessageAction[] = []
  const closed = view.composer === 'closed'
  const posting = view.composer === 'enabled'
  if (posting) actions.push('reply')
  // Readers of Announcements react too; a locked device cannot send at all.
  if (!closed && view.composer !== 'locked') actions.push('react')
  if (message.body !== '') actions.push('copy')
  actions.push(pinned ? 'unpin' : 'pin')
  if (message.mine && posting) actions.push('delete')
  if (!message.mine && posting && view.conversation.canModerate) {
    actions.push('deleteForEveryone')
  }
  return actions
}

/** The names in a typing line, as words. */
export function typingNames(
  typing: Array<{ name: string | undefined }>,
  someone: string
): string[] {
  return typing.map(entry => entry.name ?? someone)
}

/**
 * A time for the list: the clock today, the weekday this week, the date
 * before that.
 */
export function timeLabel(iso: string | null, now = new Date()): string {
  if (iso == null) return ''
  const at = new Date(iso)
  const sameDay = at.toDateString() === now.toDateString()
  if (sameDay) {
    return at.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit'
    })
  }
  const days = (now.getTime() - at.getTime()) / 86400000
  if (days < 6 && days >= 0) {
    return at.toLocaleDateString('en-US', { weekday: 'short' })
  }
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Bytes as people read them: 812 KB, 20.1 MB. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The size of an image's placeholder: as wide as `maxWidth` allows and in
 * the picture's own proportion, before its bytes are opened.
 */
export function placeholderSize(
  width: number | undefined,
  height: number | undefined,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  if (width == null || height == null || width <= 0 || height <= 0) {
    return { width: maxWidth, height: Math.round((maxWidth * 3) / 4) }
  }
  const scale = Math.min(maxWidth / width, maxHeight / height, 1)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

/** The sixteen comparison words, ready for the four-column grid. */
export function safetyGroups(words: string): string[] {
  return words.trim().split(/\s+/).filter(Boolean)
}

/** How far a message is dragged to the right before it is replied to. */
export const SWIPE_REPLY_PX = 60

/** How far a dragged message follows the finger: right only, and not far. */
export function swipeOffset(translationX: number): number {
  return Math.max(0, Math.min(translationX, SWIPE_REPLY_PX * 1.5))
}

/** Whether a drag that ended at `translationX` replies. */
export function swipeReplies(translationX: number): boolean {
  return translationX >= SWIPE_REPLY_PX
}

/**
 * The reset identities waiting for this person's approval in one chat.
 * Never the person's own: a reset identity holds no key, so only another
 * member can open its history.
 */
export function approvalsIn(
  approvals: GrantApproval[],
  conversationId: string,
  userId: string
): GrantApproval[] {
  return approvals.filter(
    approval =>
      approval.conversationId === conversationId && approval.userId !== userId
  )
}
