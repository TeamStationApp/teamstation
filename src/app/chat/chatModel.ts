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
  /** The league, season or team name; undefined for direct messages. */
  title: string | undefined
  kind: 'league' | 'season' | 'team' | 'dm'
  chats: ConversationListItem[]
}

const SCOPE_ORDER = { league: 0, season: 1, team: 2 } as const

/** The order of a scope's chats within its group. */
const KIND_ORDER: Record<ConversationListItem['kind'], number> = {
  leagueOrg: 0,
  seasonAnnouncements: 0,
  seasonAllStaff: 1,
  seasonStaff: 2,
  teamMembers: 0,
  teamStaff: 1,
  teamFans: 2,
  dm: 0
}

const time = (chat: ConversationListItem): number =>
  chat.lastMessageAt == null ? 0 : Date.parse(chat.lastMessageAt)

/**
 * The list as the screen shows it: leagues, then seasons, then teams, each
 * under its name, and then the direct messages, newest first.
 */
export function groupChats(chats: ConversationListItem[]): ChatGroup[] {
  const groups = new Map<string, ChatGroup>()
  const dms: ConversationListItem[] = []
  for (const chat of chats) {
    if (chat.scope == null) {
      dms.push(chat)
      continue
    }
    const key = `${chat.scope.type}:${chat.scope.id}`
    let group = groups.get(key)
    if (group == null) {
      group = {
        key,
        title: chat.scopeName ?? undefined,
        kind: chat.scope.type,
        chats: []
      }
      groups.set(key, group)
    }
    group.chats.push(chat)
  }
  const scoped = [...groups.values()].sort((a, b) => {
    const order =
      SCOPE_ORDER[a.kind as keyof typeof SCOPE_ORDER] -
      SCOPE_ORDER[b.kind as keyof typeof SCOPE_ORDER]
    return order !== 0 ? order : (a.title ?? '').localeCompare(b.title ?? '')
  })
  for (const group of scoped) {
    group.chats.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
  }
  const result = [...scoped]
  if (dms.length > 0) {
    result.push({
      key: 'dm',
      title: undefined,
      kind: 'dm',
      chats: [...dms].sort((a, b) => time(b) - time(a))
    })
  }
  return result
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
  return chats.some(chat => chat.unread > 0)
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
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'] as const

export type MessageAction =
  'reply' | 'react' | 'edit' | 'delete' | 'deleteForEveryone' | 'report'

/**
 * What a long press on a message offers this person: reply and react to
 * any readable message where they may post or react; edit and delete their
 * own; for a moderator, Delete for everyone on someone else's; and Report
 * on anyone else's readable message, wherever it is (a closed chat and an
 * Announcements reader included), since reporting posts nothing in it.
 */
export function actionsFor(
  message: MessageView,
  view: Pick<ConversationView, 'composer' | 'conversation'>
): MessageAction[] {
  if (message.status !== 'ok') {
    // A locked or removed message can still be removed by its author or a
    // moderator, but nothing else.
    if (message.status === 'removed') return []
    if (view.composer !== 'enabled') return []
    if (message.mine) return ['delete']
    return view.conversation.canModerate ? ['deleteForEveryone'] : []
  }
  const actions: MessageAction[] = []
  const closed = view.composer === 'closed'
  const posting = view.composer === 'enabled'
  if (posting) actions.push('reply')
  // Readers of Announcements react too; a locked device cannot send at all.
  if (!closed && view.composer !== 'locked') actions.push('react')
  if (message.mine && posting) actions.push('edit', 'delete')
  if (!message.mine && posting && view.conversation.canModerate) {
    actions.push('deleteForEveryone')
  }
  if (!message.mine) actions.push('report')
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

/** The 60 digits of a safety number as 12 groups of five. */
export function safetyGroups(digits: string): string[] {
  const groups: string[] = []
  for (let at = 0; at < digits.length; at += 5) {
    groups.push(digits.slice(at, at + 5))
  }
  return groups
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
  userId: number
): GrantApproval[] {
  return approvals.filter(
    approval =>
      approval.conversationId === conversationId && approval.userId !== userId
  )
}
