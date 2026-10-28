/**
 * The phone's full-screen sheet and the finger that pulls it down: when a
 * move is the sheet's rather than the grid's, where the sheet is while the
 * finger holds it, and whether letting go closes it.
 */
import { TAP_SLOP_PX } from '../zones'

/**
 * How fast a finger has to be going down as it lifts, in px per ms, for a
 * short pull to close the sheet anyway: a flick.
 */
export const FLICK_PX_PER_MS = 0.8

/** How far down, as a share of the screen's height, a pull closes it. */
export const COMMIT_FRACTION = 0.25

/**
 * A move is the sheet's once it has gone the tap slop downwards and more
 * than twice as far down as sideways: a scrub along the bottom row, or a
 * tile carried sideways, stays the grid's.
 */
export function claimsSwipe(dx: number, dy: number): boolean {
  return dy >= TAP_SLOP_PX && dy > 2 * Math.abs(dx)
}

/** Whether letting go here closes the sheet, or it springs back up. */
export function commitsSwipe(dy: number, vy: number, height: number): boolean {
  return dy > COMMIT_FRACTION * height || vy > FLICK_PX_PER_MS
}

/** Where the sheet is drawn for a finger `dy` down: never above its place. */
export function followOf(dy: number): number {
  return Math.max(0, dy)
}
