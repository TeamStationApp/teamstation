/** What a press does, by where it lands in the picture. */
import type { VideoHandle } from './videoHandle'

export type Zone = 'seekBack' | 'seekForward' | 'toggle'

/**
 * Nine squares, tic-tac-toe, over the whole picture.
 *
 * | pause | pause | pause                            |
 * | −10s  | pause | +10s; hold: slow forwards         |
 * | pause | pause | pause                            |
 *
 * Even thirds of the **picture**, not of the window: the box is exactly the
 * video's own shape, so the two are the same thing. The browser's own controls
 * are cut out of the layer rather than shortening the grid, so a square is
 * never on top of a control and the thirds stay even.
 */
export function zoneFor(
  x: number,
  y: number,
  width: number,
  height: number
): Zone {
  const col = Math.min(2, Math.max(0, Math.floor((x / width) * 3)))
  const row = Math.min(2, Math.max(0, Math.floor((y / height) * 3)))
  if (row === 1 && col === 0) return 'seekBack'
  if (row === 1 && col === 2) return 'seekForward'
  return 'toggle'
}

/** What a press ends up doing: a zone's own action, or the crawl. */
export type GestureAction = Zone | 'slowForward'

/**
 * What a tap and what a hold do on each square.
 *
 * A tap is the square's own action. A hold is slow motion on the +10 s square
 * only — the finger is already where the eye is following the play, and the
 * crawl lasts exactly as long as it stays down — and nothing anywhere else, so
 * a press that lingers on the picture does not pause it when the finger lifts.
 * There is no crawl backwards.
 */
export function gestureAction(
  zone: Zone,
  kind: 'tap' | 'hold'
): GestureAction | null {
  if (kind === 'tap') return zone
  return zone === 'seekForward' ? 'slowForward' : null
}

/** A press becomes a hold at a quarter of a second. */
export const HOLD_MS = 250

/** How far a tap on the sides, or an arrow key, moves. */
export const STEP_SECONDS = 10

/** Seek, clamped, without changing whether it is playing. */
export function seekBy(video: VideoHandle, delta: number): void {
  const duration = Number.isFinite(video.duration)
    ? video.duration
    : video.currentTime + Math.max(0, delta)
  const next = video.currentTime + delta
  video.currentTime = Math.min(Math.max(0, next), duration)
}

/** What a press does on the multi-camera view, which has no bar of its own to cut round. */
export type AngleZone = Zone | 'controls'

/**
 * The same nine squares over the four angles, with the bottom row given to
 * the control bar.
 *
 * | pause | pause | pause                     |
 * | −10s  | pause | +10s; hold: slow forwards  |
 * |        show the controls                  |
 *
 * The bar hides itself after a few seconds, so the bottom third is how it is
 * called back.
 */
export function angleZoneFor(
  x: number,
  y: number,
  width: number,
  height: number
): AngleZone {
  const row = Math.min(2, Math.max(0, Math.floor((y / height) * 3)))
  return row === 2 ? 'controls' : zoneFor(x, y, width, height)
}
