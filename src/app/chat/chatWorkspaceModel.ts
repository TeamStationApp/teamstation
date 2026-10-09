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
}
export interface ChatWorkspaceState {
  drafts: Map<string, ChatDraft>
  listOffset: number
  selectedId?: string
}
export function newChatWorkspaceState(): ChatWorkspaceState {
  return { drafts: new Map(), listOffset: 0 }
}
export function emptyChatDraft(): ChatDraft {
  return { text: '', picked: [], scrollOffset: 0 }
}
