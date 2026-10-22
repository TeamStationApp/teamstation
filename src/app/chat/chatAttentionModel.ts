import type { MessageView } from './engine/apply'
import type { ConversationView } from './engine/engine'

export interface ChatAttentionSession {
  readonly boundary: number
  readonly seen: Set<string>
  floor: number
  readonly frontiers: Set<number>
  complete: boolean
}

/** Capture a fresh reading visit only after its own read cursor is synchronized. */
export function newAttentionSession(
  view: ConversationView
): ChatAttentionSession | undefined {
  if (
    view.readsReady !== true ||
    view.ownReadSeq == null ||
    !Number.isSafeInteger(view.ownReadSeq) ||
    view.ownReadSeq < 0
  )
    return undefined
  const floor =
    view.historyBefore ?? view.messages[0]?.seq ?? view.conversation.lastSeq + 1
  return {
    boundary: view.ownReadSeq,
    seen: new Set(),
    floor,
    frontiers: new Set([floor]),
    complete: false
  }
}

export function recordAttentionPage(
  session: ChatAttentionSession,
  view: ConversationView
): void {
  if (view.historyBefore != null) session.frontiers.add(view.historyBefore)
}

/** Background verification keeps cached older media out of the mounted history. */
export function projectAttentionHistory(
  view: ConversationView,
  session: ChatAttentionSession | undefined
): ConversationView {
  if (session == null) return view
  const messages = view.messages.filter(message => message.seq >= session.floor)
  return {
    ...view,
    messages,
    safetyChanges: view.safetyChanges.filter(
      change => change.seq >= session.floor
    ),
    hasEarlier:
      view.hasEarlier ||
      messages.length < view.messages.length ||
      [...session.frontiers].some(cursor => cursor < session.floor)
  }
}

export function revealAttentionEarlier(
  session: ChatAttentionSession,
  view: ConversationView
): boolean {
  const frontier = [...session.frontiers]
    .filter(cursor => cursor < session.floor)
    .sort((a, b) => b - a)[0]
  const oldest = view.messages.find(message => message.seq < session.floor)?.seq
  const floor = frontier ?? oldest
  if (floor == null) return false
  session.floor = floor
  return true
}

export function revealAttentionTarget(
  session: ChatAttentionSession,
  message: MessageView
): void {
  session.floor = Math.min(session.floor, message.seq)
}

export function attentionMessages(
  view: ConversationView,
  userId: string,
  session: ChatAttentionSession
): MessageView[] {
  if (view.unverified) return []
  const originals = new Map(view.messages.map(message => [message.id, message]))
  return view.messages
    .filter(message => {
      if (
        message.seq <= session.boundary ||
        message.mine ||
        message.senderUserId === userId ||
        message.status !== 'ok' ||
        session.seen.has(message.id)
      )
        return false
      const original =
        message.quote == null ? undefined : originals.get(message.quote.id)
      return (
        message.mentions.includes(userId) ||
        (original?.status === 'ok' && original.senderUserId === userId)
      )
    })
    .sort((a, b) =>
      a.seq !== b.seq ? a.seq - b.seq : a.id.localeCompare(b.id)
    )
}

export function attentionReferences(
  view: ConversationView,
  userId: string,
  boundary: number,
  seen: ReadonlySet<string> = new Set()
): string[] {
  if (view.unverified) return []
  return [
    ...new Set(
      view.messages.flatMap(message =>
        message.seq > boundary &&
        !seen.has(message.id) &&
        !message.mine &&
        message.senderUserId !== userId &&
        message.status === 'ok' &&
        message.quote != null
          ? [message.quote.id]
          : []
      )
    )
  ]
}

export interface AttentionBodyBounds {
  top: number
  height: number
}
export interface AttentionReadingArea {
  top: number
  bottom: number
}
const leadingHeight = (body: AttentionBodyBounds): number =>
  Math.min(24, body.height)

export function attentionBodyViewed(
  body: AttentionBodyBounds,
  area: AttentionReadingArea,
  manualPast = false
): boolean {
  if (
    ![body.top, body.height, area.top, area.bottom].every(Number.isFinite) ||
    body.height <= 0 ||
    area.bottom <= area.top
  )
    return false
  const leading = leadingHeight(body)
  return (
    (body.top >= area.top && body.top + leading <= area.bottom) ||
    (manualPast && body.top + leading <= area.top)
  )
}

export function attentionBodyBelow(
  body: AttentionBodyBounds,
  area: AttentionReadingArea
): boolean {
  return (
    [body.top, body.height, area.top, area.bottom].every(Number.isFinite) &&
    body.height > 0 &&
    area.bottom > area.top &&
    body.top + leadingHeight(body) > area.bottom
  )
}
