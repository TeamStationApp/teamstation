import { couldBeAged } from '../../common/age'

/** The answer Apple's Declared Age Range API, or its stand-in, returned. */
export type DeclaredAgeAnswer =
  | { status: 'unsupported' }
  | { status: 'unready' }
  | { status: 'unavailable' }
  | { status: 'declined' }
  | { status: 'sharing'; lowerBound?: number; upperBound?: number }

/**
 * What this device's age answer says about chat: 18 or older, under 13, or
 * an age of 13 to 17 within the range Apple shared (to 17 when it gave no
 * upper bound). `pending` is an answer that has not settled; `none` is a
 * platform that did not or could not answer.
 */
export type AppleAge =
  | 'pending'
  | 'declined'
  | 'none'
  | { kind: 'adult'; lowerBound: number }
  | { kind: 'under13' }
  | { kind: 'minor'; lowerBound: number; upperBound: number }

/**
 * A shared lower bound of 18 or more is an adult; one of 13 to 17 is a minor
 * within the range; any other shared range, a missing lower bound included,
 * is under 13. A platform that cannot give an answer is `none`, and
 * `unready` has not settled.
 */
export function appleAgeOf(answer: DeclaredAgeAnswer): AppleAge {
  if (answer.status === 'unready') return 'pending'
  if (answer.status === 'declined') return 'declined'
  if (answer.status !== 'sharing') return 'none'
  const { lowerBound, upperBound } = answer
  if (lowerBound == null || lowerBound < 13) return { kind: 'under13' }
  if (lowerBound >= 18) return { kind: 'adult', lowerBound }
  return {
    kind: 'minor',
    lowerBound,
    upperBound:
      upperBound != null && upperBound >= lowerBound && upperBound < 18
        ? upperBound
        : 17
  }
}

/** Whether a year and month of birth fall within a minor's Apple range today. */
export function withinAppleRange(
  apple: AppleAge,
  birth: { year: number; month: number },
  today: Date
): boolean {
  if (typeof apple === 'string' || apple.kind !== 'minor') return true
  return couldBeAged(
    birth.year,
    birth.month,
    today,
    apple.lowerBound,
    apple.upperBound
  )
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
 * The dev server's stand-in. A finite integer string is a shared lower bound,
 * and a second one, at or above it, its upper bound. Anything else as the
 * lower bound, including the production `''`, is a platform that did not ask.
 */
export function webDeclaredAge(raw: string, upper = ''): DeclaredAgeAnswer {
  if (!/^-?\d+$/.test(raw)) return { status: 'unsupported' }
  const lowerBound = Number(raw)
  if (!Number.isFinite(lowerBound)) return { status: 'unsupported' }
  const upperBound = /^-?\d+$/.test(upper) ? Number(upper) : undefined
  return upperBound != null && upperBound >= lowerBound
    ? { status: 'sharing', lowerBound, upperBound }
    : { status: 'sharing', lowerBound }
}
