import type { ChatPin } from '../../common/api'
import { lstrings } from '../locales/strings'
import type { MessageView } from './engine/apply'
import { replyExcerpt } from './engine/reply'

const pinTime = (value: string): number => {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}

/** Personal pin order is independent of message sequence or conversation pins. */
export function orderedPins(pins: readonly ChatPin[]): ChatPin[] {
  return [...pins].sort((a, b) => {
    const time = pinTime(b.pinnedAt) - pinTime(a.pinnedAt)
    return time !== 0
      ? time
      : a.messageId < b.messageId
        ? -1
        : a.messageId > b.messageId
          ? 1
          : 0
  })
}

/** Only the current verified view can supply a pin's words and sender. */
export function pinPreview(
  pin: ChatPin,
  messages: readonly MessageView[]
): { sender?: string; excerpt: string } {
  const message = messages.find(message => message.id === pin.messageId)
  // A pinned post older than the loaded history (all of it, after a fresh
  // sign-in) is not unavailable: it is earlier, and the jump loads it.
  if (message == null) return { excerpt: lstrings.chat_pin_earlier }
  return {
    sender:
      message?.status === 'ok'
        ? message.mine
          ? lstrings.chat_you
          : (message.senderName ?? lstrings.chat_former_member)
        : undefined,
    excerpt: replyExcerpt(message)
  }
}
