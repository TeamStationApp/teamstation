import type { MessageView } from './engine/apply'

/** A notice, calendar boundary, outgoing post or changed sender ends a run. */
export function endsIncomingRun(
  messages: readonly MessageView[],
  index: number,
  noticeBeforeNext = false
): boolean {
  const current = messages[index]
  if (current == null || current.mine) return false
  const next = messages[index + 1]
  return (
    noticeBeforeNext ||
    next == null ||
    next.mine ||
    next.senderUserId !== current.senderUserId ||
    new Date(next.sentAt).toDateString() !==
      new Date(current.sentAt).toDateString()
  )
}
