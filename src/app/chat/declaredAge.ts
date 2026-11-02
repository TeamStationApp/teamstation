/** The answer Apple's Declared Age Range API, or its stand-in, returned. */
export type DeclaredAgeAnswer =
  | { status: 'unsupported' }
  | { status: 'unready' }
  | { status: 'unavailable' }
  | { status: 'declined' }
  | { status: 'sharing'; lowerBound?: number; upperBound?: number }

/** Whether chat may be drawn. `pending` is an answer that has not settled. */
export type ChatGate = 'pending' | 'allowed' | 'denied'

/**
 * Chat is removed only for a decline or a shared range under 13.
 * A missing lower bound is under 13. An answer the platform cannot give
 * leaves chat up. `unready` has not settled.
 */
export function chatGate(answer: DeclaredAgeAnswer): ChatGate {
  if (answer.status === 'unready') return 'pending'
  if (answer.status === 'declined') return 'denied'
  if (answer.status === 'sharing') {
    if (answer.lowerBound == null || answer.lowerBound < 13) return 'denied'
    return 'allowed'
  }
  return 'allowed'
}

const CHAT_FRAMES = new Set([
  'conversation',
  'chatNew',
  'chatMembers',
  'chatInfo',
  'chatDevices',
  'chatLink',
  'chatReports'
])

/** The chat tab, and the frames that draw a conversation or its chrome. */
export function isChatSurface(
  tab: string,
  frameName: string | undefined
): boolean {
  return tab === 'chat' || (frameName != null && CHAT_FRAMES.has(frameName))
}

/**
 * The dev server's stand-in. A finite integer string is a shared lower bound.
 * Anything else, including the production `''`, is a platform that did not ask.
 */
export function webDeclaredAge(raw: string): DeclaredAgeAnswer {
  if (!/^-?\d+$/.test(raw)) return { status: 'unsupported' }
  const lowerBound = Number(raw)
  if (!Number.isFinite(lowerBound)) return { status: 'unsupported' }
  return { status: 'sharing', lowerBound }
}
