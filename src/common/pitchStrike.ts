import { CALL_OF_PITCH_CODE } from './gumbo/reference'
import pitchCodes from './gumbo/reference/pitchCodes.json'

interface PitchDetails {
  call?: { code?: unknown; description?: unknown }
  code?: unknown
  description?: unknown
  isInPlay?: unknown
  isStrike?: unknown
  isBall?: unknown
}

export function pitchCode(details: PitchDetails): string | undefined {
  return [details.call?.code, details.code].find(
    (code): code is string => typeof code === 'string'
  )
}

const nonPitchCodes = new Set(
  pitchCodes.filter(pitch => !pitch.pitchStatus).map(pitch => pitch.code)
)

/** Explicit no-pitch records never count as deliveries, even if isPitch is set. */
export function isRecordedPitch(details: PitchDetails): boolean {
  const code = pitchCode(details)
  return code == null || !nonPitchCodes.has(code)
}

/** A delivery's count outcome, shared by totals and first-pitch statistics. */
export function pitchCall(
  details: PitchDetails
): 'ball' | 'strike' | 'inPlay' | null {
  if (!isRecordedPitch(details)) return null
  const code = pitchCode(details)
  const call = code == null ? undefined : CALL_OF_PITCH_CODE.get(code)
  return (
    call ??
    (details.isInPlay === true
      ? 'inPlay'
      : details.isStrike === true
        ? 'strike'
        : details.isBall === true
          ? 'ball'
          : null)
  )
}

/** Whether a recorded delivery counts as a strike thrown; absent detail is unknown. */
export function pitchStrike(details: PitchDetails): number | null {
  if (!isRecordedPitch(details)) return 0
  const call = pitchCall(details)
  return call == null ? null : call === 'ball' ? 0 : 1
}

const swingingCodes = new Set(
  pitchCodes.filter(pitch => pitch.swingStatus).map(pitch => pitch.code)
)

/** Classify a completed strikeout identically for its batter and pitcher. */
export function strikeoutLooking(
  details: PitchDetails,
  storedOutcome?: unknown
): number | null {
  const code = pitchCode(details)
  // The scorer's dropped-third-strike action records S without asking whether
  // strike three was called or swung at. Preserve that missing distinction.
  if (
    code === 'S' &&
    [storedOutcome, details.description, details.call?.description].includes(
      'Dropped Third Strike'
    )
  )
    return null
  if (code === 'C') return 1
  // Automatic strikes are known non-swinging penalties, not called pitches.
  if (
    code != null &&
    (swingingCodes.has(code) || ['A', 'AC', 'AB'].includes(code))
  )
    return 0
  // A generic strike flag (or K) cannot distinguish looking from swinging.
  return null
}
