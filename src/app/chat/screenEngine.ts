import type { ChatEngine } from './engine/engine'

/**
 * The part of the chat engine the screens use. The screens take this rather
 * than the class so their tests can hand them a stand-in.
 */
export type ChatScreenEngine = Pick<
  ChatEngine,
  | 'start'
  | 'refresh'
  | 'conversations'
  | 'subscribe'
  | 'open'
  | 'close'
  | 'view'
  | 'loadEarlier'
  | 'sendText'
  | 'attach'
  | 'react'
  | 'edit'
  | 'deleteMessage'
  | 'moderatorDelete'
  | 'markRead'
  | 'typing'
  | 'openAttachment'
  | 'approvals'
  | 'approve'
  | 'fillGrants'
  | 'safetyNumber'
>
