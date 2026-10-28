/**
 * What a press means, on the event page's card and in the full-screen player
 * alike: four by four squares over a box — the card's picture, or the block
 * of videos the full-screen player lays its controls on (`videoBlock`).
 *
 * | audio    | reveal   | reveal   | corner   |
 * | seekBack | toggle   | toggle   | seekFwd  |
 * | seekBack | toggle   | toggle   | seekFwd  |
 * | scrub    | scrub    | scrub    | scrub    |
 *
 * The corner is the card's way into full screen and the full-screen player's
 * way out (✕). The two top-centre squares run nothing: they bring the
 * controls up. A hold on fast forward is slow motion for as long as it lasts.
 */
import type { Rect } from './multiCam/layout'

export type GridZone =
  | 'audio'
  | 'reveal'
  | 'corner'
  | 'seekBack'
  | 'toggle'
  | 'seekForward'
  | 'scrub'

/**
 * Which of the two groups of controls a zone belongs to: the scrub line on
 * its own, or every control above it, which show together.
 */
export type ControlGroup = 'controls' | 'scrub'

/** The square a point is in, by column and row, each 0 to 3. */
function cellOf(at: number, from: number, size: number): number {
  if (size <= 0) return 0
  return Math.min(3, Math.max(0, Math.floor(((at - from) / size) * 4)))
}

/**
 * The zone of a point. A point outside the box takes the nearest square, so
 * anywhere below the block of videos is the scrub, and anywhere beside it
 * the nearest column.
 */
export function gridZoneFor(x: number, y: number, box: Rect): GridZone {
  const column = cellOf(x, box.x, box.w)
  const row = cellOf(y, box.y, box.h)
  if (row === 3) return 'scrub'
  if (row === 0) {
    if (column === 0) return 'audio'
    if (column === 3) return 'corner'
    return 'reveal'
  }
  if (column === 0) return 'seekBack'
  if (column === 3) return 'seekForward'
  return 'toggle'
}

export function zoneGroup(zone: GridZone): ControlGroup {
  return zone === 'scrub' ? 'scrub' : 'controls'
}

/**
 * Where on the drawn scrub line a point is, from 0 to 1: measured on the line
 * itself, so a press lands where the line says, and a press beyond either end
 * lands at that end.
 */
export function scrubFraction(x: number, track: Rect): number {
  if (track.w <= 0) return 0
  return Math.min(1, Math.max(0, (x - track.x) / track.w))
}

/** The centre of a square, for the icon drawn in it. */
export function cellCentre(
  box: Rect,
  column: number,
  row: number
): { x: number; y: number } {
  return {
    x: box.x + ((column + 0.5) * box.w) / 4,
    y: box.y + ((row + 0.5) * box.h) / 4
  }
}

/** One of the controls group's icons, where it is drawn. */
export interface PlacedIcon {
  /** What a press on it runs. */
  zone: GridZone
  /** Its centre, and the radius of its circle. */
  x: number
  y: number
  r: number
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  )
}

/**
 * Where the controls group's icons are drawn. The sound and the corner's own
 * (where it has one) sit in the box's top corners, centred `inset.x` in from
 * the side and `inset.y` down from the top, level with the full-screen
 * player's ✕ wherever the board has put it: over the
 * board, if it is there, while they show. Ten seconds back and on sit down
 * the sides and play or pause in the middle, each in the middle of its
 * squares and moved just below anything it would sit on: the board, its box
 * score, or an icon placed before it. A moved icon can land in another
 * square; while the controls show, a press on it is still its own
 * (`zoneAt`).
 */
export function placeIcons(
  box: Rect,
  size: number,
  covers: Array<Rect | null>,
  gap: number,
  corner: boolean,
  inset: { x: number; y: number }
): PlacedIcon[] {
  const middle = box.y + box.h / 2
  const pinned: Array<{ zone: GridZone; x: number; y: number }> = [
    { zone: 'audio', x: box.x + inset.x, y: box.y + inset.y }
  ]
  if (corner)
    pinned.push({
      zone: 'corner',
      x: box.x + box.w - inset.x,
      y: box.y + inset.y
    })
  const wanted: Array<{ zone: GridZone; x: number; y: number }> = [
    { zone: 'seekBack', x: cellCentre(box, 0, 1).x, y: middle },
    { zone: 'toggle', x: box.x + box.w / 2, y: middle },
    { zone: 'seekForward', x: cellCentre(box, 3, 1).x, y: middle }
  ]
  const keptClear = [
    ...covers.filter((cover): cover is Rect => cover != null),
    ...pinned.map(icon => ({
      x: icon.x - size / 2,
      y: icon.y - size / 2,
      w: size,
      h: size
    }))
  ]
  const placed = wanted.map(icon => {
    let top = icon.y - size / 2
    for (let moved = true; moved;) {
      moved = false
      for (const cover of keptClear) {
        const spot = { x: icon.x - size / 2, y: top, w: size, h: size }
        if (!overlaps(spot, cover)) continue
        top = cover.y + cover.h + gap
        moved = true
      }
    }
    keptClear.push({ x: icon.x - size / 2, y: top, w: size, h: size })
    return { zone: icon.zone, x: icon.x, y: top + size / 2, r: size / 2 }
  })
  return [...pinned.map(icon => ({ ...icon, r: size / 2 })), ...placed]
}

/**
 * What a press does: the icon it lands on while the controls are showing —
 * where they are drawn is what a viewer aims at — and otherwise its square,
 * except the way out, which is only ever a press on it.
 */
export function zoneAt(
  x: number,
  y: number,
  box: Rect,
  shown: PlacedIcon[] | null
): GridZone {
  const hit = shown?.find(
    icon => (x - icon.x) ** 2 + (y - icon.y) ** 2 <= icon.r ** 2
  )
  if (hit != null) return hit.zone
  const square = gridZoneFor(x, y, box)
  // The way out only on the way out: where it has been moved off its
  // square, a press on the square — the board, say — only shows the controls.
  if (
    square === 'corner' &&
    shown?.some(icon => icon.zone === 'corner') === true
  )
    return 'reveal'
  return square
}
