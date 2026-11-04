/** The answer Apple's Declared Age Range API, or its stand-in, returned. */
export type DeclaredAgeAnswer =
  | { status: 'unsupported' }
  | { status: 'unready' }
  | { status: 'unavailable' }
  | { status: 'declined' }
  | { status: 'sharing'; lowerBound?: number; upperBound?: number }

/**
 * What this device's age answer says about chat. `pending` is an answer that
 * has not settled; `none` is a platform that did not or could not answer.
 */
export type AppleAge = 'pending' | 'over13' | 'under13' | 'declined' | 'none'

/**
 * A shared range of 13 or more is `over13`, and any other shared range — a
 * missing lower bound included — is `under13`. A platform that cannot give
 * an answer is `none`, and `unready` has not settled.
 */
export function appleAgeOf(answer: DeclaredAgeAnswer): AppleAge {
  if (answer.status === 'unready') return 'pending'
  if (answer.status === 'declined') return 'declined'
  if (answer.status === 'sharing') {
    return answer.lowerBound != null && answer.lowerBound >= 13
      ? 'over13'
      : 'under13'
  }
  return 'none'
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
