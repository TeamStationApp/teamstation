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
  /**
   * The arrangement, when it is decided by a larger box than this one: the
   * screen, of which this is what the scoreboard's band leaves.
   */
  shape?: { columns: number; rows: number }
  /**
   * Where the grid goes up and down a box taller than it: in the middle, at
   * the top (the portrait stack, butted against what is above it), or at the
   * bottom (two angles sideways, leaving the space above them whole).
   */
  align?: VerticalAlign
}): Rect {
  const { width, height, count, aspect, align = 'centre' } = options
  const { columns, rows } = options.shape ?? gridShape(width, height, count)
  const wanted = (aspect * columns) / rows

  let w = width
  let h = width / wanted
  if (h > height) {
    h = height
    w = height * wanted
  }
  const y =
    align === 'top' ? 0 : align === 'bottom' ? height - h : (height - h) / 2
  return { x: (width - w) / 2, y, w, h }
}

/** Where a grid goes up and down the box it is laid out in. */
export type VerticalAlign = 'centre' | 'top' | 'bottom'

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
  /**
   * A band this tall across the top that the tiles stay below: the portrait
   * grid's scoreboard. The tiles are laid out in what is left exactly as
   * they would be in a screen that size, and the shape is still the whole
   * screen's, so a band never turns a column into a grid.
   */
  top?: number
  /** The arrangement, when the whole screen decides it rather than the box. */
  shape?: { columns: number; rows: number }
  /**
   * Three angles in two rows of two leave the top-left quadrant to the
   * scoreboard: they take the other three, in reading order.
   */
  boardCell?: boolean
  /** Where the grid goes up and down the box (`gridBox`). */
  align?: VerticalAlign
}): Rect[] {
  const {
    width,
    height,
    count,
    aspect = 16 / 9,
    zoomed = null,
    top = 0
  } = options
  const tiles = Math.max(0, Math.min(MAX_TILES, count))
  if (tiles === 0) return []
  if (top > 0) {
    return tileRects({
      ...options,
      height: Math.max(0, height - top),
      top: 0,
      shape: gridShape(width, height, tiles)
    }).map(rect => ({ ...rect, y: rect.y + top }))
  }

  const { shape, align } = options
  const box = gridBox({ width, height, count: tiles, aspect, shape, align })
  if (zoomed != null && zoomed >= 0 && zoomed < tiles) {
    // Zoomed, the big tile takes the whole box — and the others keep a
    // rectangle rather than being unmounted or hidden, because a `<video>`
    // that is covered goes on decoding and one that is taken out of the layout
    // does not. Coming back from a zoom has to be instant; re-buffering three
    // tiles would make it anything but.
    const full = gridBox({ width, height, count: 1, aspect })
    const behind = tileRects({
      width,
      height,
      count: tiles,
      aspect,
      shape,
      boardCell: options.boardCell
    })
    return behind.map((rect, index) => (index === zoomed ? full : rect))
  }

  if (tiles === 1) return [box]
  // Side by side, or one above another, filling the box: two 16:9 pictures
  // across a 32:9 box, or down a 9:32 one.
  const { columns, rows } = shape ?? gridShape(width, height, tiles)
  const w = box.w / columns
  const h = box.h / rows
  const skip =
    options.boardCell === true && tiles === 3 && columns === 2 && rows === 2
      ? 1
      : 0
  return Array.from({ length: tiles }, (unused, index) => ({
    x: box.x + ((index + skip) % columns) * w,
    y: box.y + Math.floor((index + skip) / columns) * h,
    w,
    h
  }))
}

/**
 * The phone's grid edge to edge, each picture at its own shape. Sideways the
 * pictures have the whole screen, under a notch, the Dynamic Island and the
 * rounded corners; upright they start below the top of the safe area, below
 * the board's band when there is one, and run on into the bottom of it, past
 * the home indicator, to the screen's edge. The controls and the board keep
 * to `safe`, what the hardware leaves. `top` is where the pictures start.
 */
export function edgeToEdge(
  screen: { width: number; height: number },
  insets: { top: number; right: number; bottom: number; left: number },
  /** The board's band, upright; 0 sideways or with no board. */
  band: number,
  /** Sideways, as the caller decided it, so the two never disagree. */
  landscape: boolean
): { safe: Rect; top: number } {
  const safe = {
    x: insets.left,
    y: insets.top,
    w: Math.max(0, screen.width - insets.left - insets.right),
    h: Math.max(0, screen.height - insets.top - insets.bottom)
  }
  return { safe, top: landscape ? 0 : safe.y + band }
}

/** The angles' shared shape: the first one whose size is known, else 16:9. */
export function aspectOf(
  videos: ReadonlyArray<{ width?: number | null; height?: number | null }>
): number {
  for (const video of videos) {
    if (video.width != null && video.height != null && video.height > 0) {
      return video.width / video.height
    }
  }
  return 16 / 9
}

/**
 * How the tiles are arranged: side by side in a box wider than it is tall —
 * two across, and two rows from a third angle on — and one above another in a
 * box taller than it is wide.
 *
 * The second is a phone held upright, which is how the app is held: a two-by-
 * two grid there used a strip across the middle of the screen, each picture a
 * quarter of its width, with the rest black. Stacked, each picture is the
 * screen's width.
 */
export function gridShape(
  width: number,
  height: number,
  count: number
): { columns: number; rows: number } {
  if (count <= 1) return { columns: 1, rows: 1 }
  if (height > width) return { columns: 1, rows: count }
  return { columns: 2, rows: count <= 2 ? 1 : 2 }
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
 * The grid's rule, sideways: in two rows of two there is no "along" for the
 * others to slide, so the one dropped on takes the gap and nothing else
 * moves. The upright column inserts instead (`move`).
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

/**
 * One tile taken out and put back at `to`, the ones between moving up one.
 *
 * The upright column's rule: a picture dragged down a stack of four is put
 * where it was let go and the others close up behind it, which is what a
 * list on a phone does. Sideways, a grid swaps (`swap`).
 */
export function move<T>(order: T[], from: number, to: number): T[] {
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
  const [taken] = next.splice(from, 1)
  next.splice(to, 0, taken)
  return next
}

/** Where everything is while one tile is being dragged. */
export interface DragSlots {
  /** The slot the dragged tile lands in if it is let go now, or null. */
  target: number | null
  /** For each tile, the slot it is drawn in meanwhile (the dragged one's own). */
  slots: number[]
}

/**
 * The tiles while `index` is dragged `offset` from its slot: which slot it
 * would land in, and where the others stand aside to show it.
 *
 * In one column the target is the row under the dragged tile's centre,
 * clamped to the first and last, and the rows between slide one slot towards
 * the gap it left — an insert, as `move` does on the drop. In a grid the
 * target is the tile under its centre, and that one alone slides into the
 * gap — a swap, as `swap` does. Over no tile, nothing moves.
 */
export function dragSlots(
  rects: Rect[],
  columns: number,
  index: number,
  offset: Point
): DragSlots {
  const resting = rects.map((unused, slot) => slot)
  const rect = rects[index]
  if (rect == null) return { target: null, slots: resting }
  const centre = {
    x: rect.x + rect.w / 2 + offset.x,
    y: rect.y + rect.h / 2 + offset.y
  }

  if (columns === 1) {
    let target = rects.findIndex(
      one => centre.y >= one.y && centre.y < one.y + one.h
    )
    if (target < 0) {
      target = centre.y < (rects[0]?.y ?? 0) ? 0 : rects.length - 1
    }
    // Where each tile ends up if the dragged one is put at `target`.
    const after = move(resting, index, target)
    const slots = resting.slice()
    after.forEach((tile, slot) => {
      slots[tile] = slot
    })
    slots[index] = index
    return { target, slots }
  }

  const target = dropTarget(rects, centre)
  if (target == null || target === index) {
    return { target, slots: resting }
  }
  const slots = resting.slice()
  slots[target] = index
  return { target, slots }
}
