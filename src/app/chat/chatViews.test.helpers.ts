import { act } from 'react'

import { userIdOfGumbo } from '../../common/userId'
import type { MessageView } from './engine/apply'
import type {
  ConversationListItem,
  ConversationView,
  MemberView
} from './engine/engine'

/** Views as the engine hands them to the chat screens, for their tests. */

/** Browser fixtures supply the same public viewport measurements as a window. */
export function measureChatTestViewport(
  options: { width?: number; height?: number } = {}
): () => void {
  const element = document.documentElement
  const saved = ['clientWidth', 'clientHeight'].map(key => ({
    key,
    descriptor: Object.getOwnPropertyDescriptor(element, key)
  }))
  Object.defineProperties(element, {
    clientWidth: {
      configurable: true,
      get: () => options.width ?? window.innerWidth
    },
    clientHeight: {
      configurable: true,
      get: () => options.height ?? window.innerHeight
    }
  })
  window.dispatchEvent(new window.Event('resize'))
  return () => {
    for (const { key, descriptor } of saved) {
      if (descriptor == null) Reflect.deleteProperty(element, key)
      else Object.defineProperty(element, key, descriptor)
    }
    window.dispatchEvent(new window.Event('resize'))
  }
}

/** Wait for rendered geometry and public animation opacity, with a fixed bound. */
export async function settleChatMessageActions(
  phase?: 'open' | 'closed'
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const overlay = document.querySelector<HTMLElement>(
      '[data-testid="chat-message-spotlight"]'
    )
    if (overlay == null) return
    const opacity = Number(getComputedStyle(overlay.firstElementChild!).opacity)
    const controls = overlay.querySelector<HTMLElement>(
      '[data-testid="chat-message-spotlight-controls"]'
    )
    const desired =
      phase ??
      (getComputedStyle(overlay).pointerEvents === 'none' ? 'closed' : 'open')
    if (
      desired === 'closed'
        ? opacity === 0
        : opacity === 1 &&
          controls != null &&
          parseFloat(getComputedStyle(controls).height) > 0
    )
      return
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
  }
  throw new Error(`Message actions did not finish their ${phase} transition`)
}

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
    senderUserId: userIdOfGumbo(2),
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
  userId: string,
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
    members: [
      member(userIdOfGumbo(1), 'Blair B'),
      member(userIdOfGumbo(2), 'Hank C')
    ],
    typing: [],
    historyLocked: false,
    earlierLost: false,
    unverified: false,
    composer: 'enabled',
    hasEarlier: false,
    readsReady: true,
    ownReadSeq: over.conversation?.lastSeq ?? chat().lastSeq,
    safetyChanges: [],
    ...over
  }
}
