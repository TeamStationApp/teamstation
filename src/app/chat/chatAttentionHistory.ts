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

/** A batch has loaded its pages; thrown inside a batch to end it. */
class BatchSpent extends Error {}

/**
 * How a discovery batch ended: `complete` when every page and original it
 * needs is in hand, `more` when it spent its page budget with the history
 * cursor still moving back, so the caller runs another batch.
 */
export type AttentionDiscovery = 'complete' | 'more'

/**
 * Pages back to the unread boundary, and past it where a reply's original
 * must be verified, at most `budget` pages per call. A long history (a
 * first visit has a boundary of 0) is progress, not failure: a call that
 * spends its budget while every page moved the cursor returns `more`. Only
 * a failed read, a cursor that did not move, or lost access rejects.
 */
export async function discoverAttentionHistory(options: {
  conversationId: string
  userId: string
  session: ChatAttentionSession
  view: (id: string) => ConversationView | undefined
  loadEarlier: (id: string) => Promise<ConversationView>
  cancelled: () => boolean
  budget?: number
}): Promise<AttentionDiscovery> {
  const { conversationId, userId, session, cancelled } = options
  const budget = Math.max(1, options.budget ?? 12)
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
    // Every page before this one moved the cursor back (checked below).
    if (pages >= budget) throw new BatchSpent()
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
  try {
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
  } catch (error) {
    if (!(error instanceof BatchSpent)) throw error
    current()
    return 'more'
  }
  return 'complete'
}
