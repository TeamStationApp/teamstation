/**
 * Where four pictures go, and what happens when one of them is made big.
 *
 * The arrangement is the Distributor's: quadrants in reading order, two side
 * by side, three with one quadrant left empty. The mosaic it makes on the Mac
 * and the grid drawn here should put a camera in the same place, or a viewer
 * who has watched both has to learn the ground twice.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

/** Four is the cap, as it is in `CombinedLayoutRules.maximumCameras`. */
export const MAX_TILES = 4

/**
 * The box the grid is drawn in: the tiles' own shape, letterboxed once.
 *
 * Fitting each tile into a fixed quadrant with `object-fit: contain` puts
 * black bars inside all four of them, which is the thing `useVideoAspect` was
 * written to stop. A two-by-two of 16:9 tiles is itself 16:9, so the grid as a
 * whole can keep that shape and the bars end up around the outside — one pair
 * of them, at the edge of the window, where they read as the window being a
 * different shape from the pictures rather than as four spoiled pictures.
 */
export function gridBox(options: {
  width: number
  height: number
  count: number
  /** The tiles' shared aspect. 16/9 until the files say otherwise. */
  aspect: number
}): Rect {
  const { width, height, count, aspect } = options
  const columns = count <= 1 ? 1 : 2
  const rows = count <= 2 ? 1 : 2
  const wanted = (aspect * columns) / rows

  let w = width
  let h = width / wanted
  if (h > height) {
    h = height
    w = height * wanted
  }
  return { x: (width - w) / 2, y: (height - h) / 2, w, h }
}

/**
 * Each tile's rectangle inside the grid box, in reading order.
 *
 * Three tiles take three quadrants and leave the fourth empty. The
 * Distributor slides its odd one along an axis to look deliberate; that is a
 * kindness a fixed render needs and this one does not, because a tile here can
 * simply be dragged where somebody wants it.
 */
export function tileRects(options: {
  width: number
  height: number
  count: number
  aspect?: number
  /** The index, in reading order, of a tile blown up to the whole box. */
  zoomed?: number | null
}): Rect[] {
  const { width, height, count, aspect = 16 / 9, zoomed = null } = options
  const tiles = Math.max(0, Math.min(MAX_TILES, count))
  if (tiles === 0) return []

  const box = gridBox({ width, height, count: tiles, aspect })
  if (zoomed != null && zoomed >= 0 && zoomed < tiles) {
    // Zoomed, the big tile takes the whole box — and the others keep a
    // rectangle rather than being unmounted or hidden, because a `<video>`
    // that is covered goes on decoding and one that is taken out of the layout
    // does not. Coming back from a zoom has to be instant; re-buffering three
    // tiles would make it anything but.
    const full = gridBox({ width, height, count: 1, aspect })
    const behind = tileRects({ width, height, count: tiles, aspect })
    return behind.map((rect, index) => (index === zoomed ? full : rect))
  }

  if (tiles === 1) return [box]
  const halfWidth = box.w / 2
  const halfHeight = box.h / 2
  if (tiles === 2) {
    // Side by side, filling the height: two 16:9 pictures across a 32:9 box.
    return [
      { x: box.x, y: box.y, w: halfWidth, h: box.h },
      { x: box.x + halfWidth, y: box.y, w: halfWidth, h: box.h }
    ]
  }
  const quadrants: Rect[] = [
    { x: box.x, y: box.y, w: halfWidth, h: halfHeight },
    { x: box.x + halfWidth, y: box.y, w: halfWidth, h: halfHeight },
    { x: box.x, y: box.y + halfHeight, w: halfWidth, h: halfHeight },
    { x: box.x + halfWidth, y: box.y + halfHeight, w: halfWidth, h: halfHeight }
  ]
  return quadrants.slice(0, tiles)
}

/** Which tile a finger let go over, or null for none of them. */
export function dropTarget(rects: Rect[], at: Point): number | null {
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index]
    if (
      at.x >= rect.x &&
      at.x <= rect.x + rect.w &&
      at.y >= rect.y &&
      at.y <= rect.y + rect.h
    ) {
      return index
    }
  }
  return null
}

/**
 * Two tiles change places.
 *
 * A swap rather than an insert: four tiles are always four tiles, and sliding
 * the others along would move two pictures somebody did not touch.
 */
export function swap<T>(order: T[], from: number, to: number): T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= order.length ||
    to >= order.length
  ) {
    return order
  }
  const next = order.slice()
  next[from] = order[to]
  next[to] = order[from]
  return next
}
