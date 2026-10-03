import { messagePreview } from '../chatModel'
import type { MessageView, QuoteView } from './apply'
import type { ConversationView } from './engine'

/** The original's own current content; a reply never includes a nested quote. */
export function replyExcerpt(message: MessageView | undefined): string {
  const text = messagePreview(message)
  const points = Array.from(text)
  return points.length > 200 ? points.slice(0, 200).join('') + '…' : text
}

/** Encrypted snapshots are references, never authority for displayed content. */
export function resolveQuote(
  quote: QuoteView,
  posts: Map<string, MessageView>
): QuoteView {
  const original = posts.get(quote.id)
  return {
    id: quote.id,
    authorId: original?.senderUserId ?? quote.authorId,
    authorName: original?.senderName,
    snippet: replyExcerpt(original),
    status: original?.status ?? 'unavailable'
  }
}

/** Ordinary verified paging stops on cancellation, exhaustion or no progress. */
export async function findOriginal(
  engine: {
    view: (id: string) => ConversationView | undefined
    loadEarlier: (id: string) => Promise<ConversationView>
  },
  conversationId: string,
  messageId: string,
  cancelled: () => boolean
): Promise<MessageView | undefined> {
  let current = engine.view(conversationId)
  while (current != null && !cancelled()) {
    const original = current.messages.find(message => message.id === messageId)
    if (original != null) return original
    if (!current.hasEarlier) return undefined
    const first = current.messages[0]?.seq
    const count = current.messages.length
    const before = current.historyBefore
    current = await engine.loadEarlier(conversationId)
    if (cancelled() || engine.view(conversationId) == null) return undefined
    if (
      current.historyBefore === before &&
      current.messages.length === count &&
      current.messages[0]?.seq === first
    )
      return current.messages.find(message => message.id === messageId)
  }
  return undefined
}
