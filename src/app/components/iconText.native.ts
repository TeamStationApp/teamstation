import type { IconName } from './Icon'
import { iconCodepoints } from './iconCodepoints'

/**
 * The character the phone font draws for this icon. The name itself is what
 * shows up as letters when the ligature does not form.
 */
export function iconText(name: IconName): string {
  return String.fromCodePoint(iconCodepoints[name])
}
