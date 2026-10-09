import type { MessageView } from './engine/apply'
import type {
  ConversationListItem,
  ConversationView,
  MemberView
} from './engine/engine'

/** Views as the engine hands them to the chat screens, for their tests. */

export function chat(
  over: Partial<ConversationListItem> = {}
): ConversationListItem {
  return {
    id: 'cnv_1',
    kind: 'teamMembers',
    title: 'Hawks Members',
    scope: { type: 'team', id: 'tem_hawks' },
    scopeName: 'Hawks',
    lastSeq: 0,
    lastMessageAt: null,
    unread: 0,
    canPost: true,
    canModerate: false,
    locked: false,
    noHolder: false,
    closed: false,
    memberCount: 5,
    unverified: false,
    ...over
  }
}

export function message(over: Partial<MessageView> = {}): MessageView {
  return {
    id: 'msg_1',
    seq: 1,
    epoch: 1,
    senderUserId: 2,
    senderName: 'Hank C',
    mine: false,
    sentAt: '2027-04-01T17:00:00.000Z',
    status: 'ok',
    removedBy: undefined,
    body: 'Game day',
    mentions: [],
    quote: undefined,
    attachments: [],
    edited: false,
    editIds: [],
    reactions: [],
    readBy: [],
    sentBeforeSafetyNumberChange: false,
    ...over
  }
}

export function member(
  userId: number,
  shortName: string,
  over: Partial<MemberView> = {}
): MemberView {
  return {
    userId,
    shortName,
    avatarUrl: null,
    label: 'Member',
    isModerator: false,
    isApprover: false,
    eligible: true,
    hasIdentity: true,
    identityKey: null,
    generation: 1,
    safetyNumberChanged: false,
    ...over
  }
}

export function view(over: Partial<ConversationView> = {}): ConversationView {
  return {
    conversation: chat(),
    messages: [],
    members: [member(1, 'Blair B'), member(2, 'Hank C')],
    typing: [],
    historyLocked: false,
    earlierLost: false,
    unverified: false,
    composer: 'enabled',
    hasEarlier: false,
    safetyChanges: [],
    ...over
  }
}
