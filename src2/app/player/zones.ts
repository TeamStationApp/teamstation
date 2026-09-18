/** What a press does, by where it lands in the picture. */
export type Zone =
  | 'seekBack'
  | 'seekForward'
  | 'slowForward'
  | 'slowBack'
  | 'toggle'

/**
 * Nine squares, tic-tac-toe, over the whole picture.
 *
 * | pause | hold: slow forwards | pause |
 * | −10s  | pause               | +10s  |
 * | pause | hold: slow backwards| pause |
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
  if (row === 0 && col === 1) return 'slowForward'
  if (row === 2 && col === 1) return 'slowBack'
  return 'toggle'
}

/** How far a tap on the sides, or an arrow key, moves. */
export const STEP_SECONDS = 10

/** Seek, clamped, without changing whether it is playing. */
export function seekBy(video: HTMLVideoElement, delta: number): void {
  const duration = Number.isFinite(video.duration)
    ? video.duration
    : video.currentTime + Math.max(0, delta)
  const next = video.currentTime + delta
  video.currentTime = Math.min(Math.max(0, next), duration)
}
