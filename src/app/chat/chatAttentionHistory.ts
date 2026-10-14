import {
  attentionReferences,
  type ChatAttentionSession,
  recordAttentionPage
} from './chatAttentionModel'
import type { ConversationView } from './engine/engine'
import { findOriginal } from './engine/reply'

export class AttentionCancelled extends Error {}

/** Serializes the complete ordinary page operation, including reader restoration. */
export class ChatHistoryCoordinator {
  private tail: Promise<unknown> = Promise.resolve()

  async run<T>(cancelled: () => boolean, work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      if (cancelled()) throw new AttentionCancelled()
      return await work()
    })
    this.tail = next.catch(() => undefined)
    return await next
  }
}

/** A bounded scan may pass the unread boundary to verify a reply's original. */
export async function discoverAttentionHistory(options: {
  conversationId: string
  userId: number
  session: ChatAttentionSession
  view: (id: string) => ConversationView | undefined
  loadEarlier: (id: string) => Promise<ConversationView>
  cancelled: () => boolean
  budget?: number
}): Promise<void> {
  const { conversationId, userId, session, cancelled } = options
  let pages = 0
  const current = (): ConversationView => {
    if (cancelled()) throw new AttentionCancelled()
    const view = options.view(conversationId)
    if (view == null || view.unverified)
      throw new Error('Conversation unavailable')
    return view
  }
  const loadEarlier = async (): Promise<ConversationView> => {
    const before = current()
    if (pages >= (options.budget ?? 12))
      throw new Error('History verification needs retry')
    pages += 1
    const next = await options.loadEarlier(conversationId)
    recordAttentionPage(session, next)
    current()
    if (
      next.hasEarlier &&
      (next.historyBefore == null ||
        before.historyBefore == null ||
        next.historyBefore >= before.historyBefore)
    )
      throw new Error('History cursor did not advance')
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    current()
    return next
  }
  while (
    current().conversation.lastSeq > session.boundary &&
    current().hasEarlier &&
    (current().historyBefore == null ||
      current().historyBefore! > session.boundary + 1)
  )
    await loadEarlier()
  const resolved = new Set<string>()
  while (true) {
    const id = attentionReferences(
      current(),
      userId,
      session.boundary,
      session.seen
    ).find(id => !resolved.has(id))
    if (id == null) break
    await findOriginal(
      { view: options.view, loadEarlier },
      conversationId,
      id,
      cancelled
    )
    current()
    resolved.add(id)
  }
}
