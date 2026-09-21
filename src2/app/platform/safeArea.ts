/**
 * What the hardware takes out of the window.
 *
 * Nothing, in a browser. `app/web/index.html` deliberately does **not** ask for
 * `viewport-fit=cover`, and says why: under `cover` the page runs beneath the
 * rounded corners and the camera housing, and the layout sizes itself from
 * `window.innerWidth`, which then reports the whole screen rather than the part
 * of it that can be seen. The default insets the page to the safe area and
 * reports that width, so the two agree and there is nothing left over.
 *
 * The four numbers exist so the header and the floating nav can ask on both
 * platforms without knowing which one they are on.
 */
import type { Insets } from './insets'

export type { Insets }

const NONE: Insets = { top: 0, bottom: 0, left: 0, right: 0 }

export function useInsets(): Insets {
  return NONE
}
