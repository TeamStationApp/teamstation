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
  | 'report'
  | 'typing'
  | 'openAttachment'
  | 'approvals'
  | 'approve'
  | 'fillGrants'
  | 'safetyNumber'
> &
  Partial<
    Pick<
      ChatEngine,
      | 'setPreferences'
      | 'pinMessage'
      | 'loadPreview'
      | 'setBlocked'
      | 'isBlocked'
    >
  > & {
    /**
     * `ChatEngine.markRead`: true when the read cursor moved. A stand-in
     * may answer nothing.
     */
    markRead: (
      conversationId: string,
      clearManualUnreadRevision?: number
    ) => Promise<unknown>
  }
