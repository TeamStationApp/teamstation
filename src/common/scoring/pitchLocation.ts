import { asBoolean, asNumber, asObject, asOptional } from 'cleaners'

import { asLiteral } from '../asLiteral'
import type { BatSide } from './state'

/**
 * Where a pitch crossed the plate, in the words a scorer says it from the
 * batter's side — "low and inside", "missed high and away" — so a dictation
 * model never has to know MLB's zone numbers. `pitchZone` turns it into one.
 */
export const PITCH_HEIGHTS = ['high', 'middle', 'low'] as const
export const PITCH_SIDES = ['inside', 'middle', 'away'] as const

export const asPitchLocation = asObject({
  height: asLiteral(...PITCH_HEIGHTS),
  side: asLiteral(...PITCH_SIDES),
  inZone: asBoolean
})
export type PitchLocation = ReturnType<typeof asPitchLocation>

/**
 * The MLB zone of a pitch at `location` to a batter on `batSide`, or
 * undefined when no zone says it.
 *
 * MLB numbers the zones as the catcher sees them: 1 2 3 across the top of
 * the strike zone, 4 5 6, then 7 8 9, 1 at the catcher's left. A right-handed
 * batter stands on the catcher's left, so his inside is 1, 4 and 7; a
 * left-handed batter's is 3, 6 and 9. Outside the zone, 11 and 12 are high to
 * the catcher's left and right, 13 and 14 low. A miss straight high or low,
 * or just inside or away, is in none of those corners, so it has no zone; nor
 * has a miss down the middle, which is no miss at all.
 */
export function pitchZone(
  location: PitchLocation,
  batSide: BatSide | null | undefined
): number | undefined {
  if (batSide == null) return undefined
  const { height, side, inZone } = location
  const row = PITCH_HEIGHTS.indexOf(height)
  // Columns from the catcher's left: a right-handed batter's inside first.
  const column =
    side === 'middle' ? 1 : (side === 'inside') === (batSide === 'R') ? 0 : 2
  if (inZone) return 1 + row * 3 + column
  if (height === 'middle' || side === 'middle') return undefined
  return (height === 'high' ? 11 : 13) + (column === 0 ? 0 : 1)
}

/**
 * The fields a pitch — one the batter hit, or one he did not — may say of
 * itself, as the action cleaners take them. A speed or zone out of range is
 * taken here and dropped by the engine (`isPitchSpeed`, `isPitchZone`).
 */
export const PITCH_DATA_CLEANERS = {
  speed: asOptional(asNumber),
  zone: asOptional(asNumber),
  pitchLocation: asOptional(asPitchLocation)
}

/** The same fields as `toolSchema()` offers them to a dictation model. */
export const PITCH_DATA_TOOL_FIELDS = {
  speed: { type: 'number', description: 'Pitch speed in mph, when said' },
  pitchLocation: {
    type: 'object',
    description:
      "Where the pitch crossed the plate, from the batter's side: 'low and inside', 'missed high and away'",
    properties: {
      height: { type: 'string', enum: PITCH_HEIGHTS },
      side: { type: 'string', enum: PITCH_SIDES },
      inZone: {
        type: 'boolean',
        description: 'In the strike zone; false when it missed'
      }
    },
    required: ['height', 'side', 'inZone'],
    additionalProperties: false
  },
  zone: {
    type: 'integer',
    description: 'MLB zone number, only if said as a number'
  }
}
