import type { Rect } from '../player/controlGeometry'
import type { Size } from '../player/scoreboardOverlay/overlayLayout'

/**
 * Where a picture of `natural` size is drawn so it covers `container`
 * whole, its proportions kept: scaled until both sides reach, with the
 * overflow cut from the side away from `anchor`. `'right-top'` keeps the
 * picture's upper-right corner in the container's.
 */
export function coverRect(
  container: Size,
  natural: Size,
  anchor: 'right-top' | 'center' = 'right-top'
): Rect {
  if (
    !(container.width > 0) ||
    !(container.height > 0) ||
    !(natural.width > 0) ||
    !(natural.height > 0)
  )
    return { x: 0, y: 0, w: container.width, h: container.height }
  const scale = Math.max(
    container.width / natural.width,
    container.height / natural.height
  )
  const w = natural.width * scale
  const h = natural.height * scale
  return anchor === 'right-top'
    ? { x: container.width - w, y: 0, w, h }
    : { x: (container.width - w) / 2, y: (container.height - h) / 2, w, h }
}
