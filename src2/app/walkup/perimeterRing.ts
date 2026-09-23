import { AT_BAT_BLUE, AT_BAT_GREEN, AT_BAT_PURPLE } from './atBatColors'

/** Room outside the card so the glow is not cut off by the drawing box. */
export const RING_PAD = 14
/** The string sits just inside the card edge. */
export const RING_INSET = 2
export const RING_RADIUS = 12
export const RING_SAMPLES = 96

const STOPS = [AT_BAT_BLUE, AT_BAT_PURPLE, AT_BAT_GREEN, AT_BAT_BLUE]

export interface RingPoint {
  x: number
  y: number
}

export interface RingSegment {
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
}

/**
 * Points around a rounded rectangle, clockwise from the top edge's left end:
 * along the top to the right, down the right side, back along the bottom,
 * and up the left side.
 */
export function roundedRectPoints(
  width: number,
  height: number,
  radius: number,
  count: number
): RingPoint[] {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  const perimeter = ringPerimeter(width, height, r)
  const points: RingPoint[] = []
  for (let i = 0; i < count; i++) {
    points.push(pointAt(width, height, r, (i / count) * perimeter))
  }
  return points
}

/** One smooth blend of blue, purple and green. `t` is a turn around the card. */
export function ringColor(t: number): string {
  const x = ((t % 1) + 1) % 1
  const scaled = x * (STOPS.length - 1)
  const index = Math.min(STOPS.length - 2, Math.floor(scaled))
  const mix = scaled - index
  const from = rgb(STOPS[index])
  const to = rgb(STOPS[index + 1])
  const channel = (i: number): number =>
    Math.round(from[i] + (to[i] - from[i]) * mix)
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`
}

/**
 * The string laid around the card. Raising `offset` pulls every color
 * clockwise: the color at a point is the one that was just behind it.
 */
export function ringSegments(
  width: number,
  height: number,
  offset: number
): RingSegment[] {
  const innerW = Math.max(1, width - RING_INSET * 2)
  const innerH = Math.max(1, height - RING_INSET * 2)
  const radius = Math.max(0, RING_RADIUS - RING_INSET)
  const points = roundedRectPoints(innerW, innerH, radius, RING_SAMPLES).map(
    point => ({
      x: point.x + RING_INSET + RING_PAD,
      y: point.y + RING_INSET + RING_PAD
    })
  )
  return points.map((point, index) => {
    const next = points[(index + 1) % points.length]
    return {
      x1: point.x,
      y1: point.y,
      x2: next.x,
      y2: next.y,
      color: ringColor(index / points.length - offset)
    }
  })
}

export function ringCanvasSize(
  width: number,
  height: number
): { width: number; height: number } {
  return { width: width + RING_PAD * 2, height: height + RING_PAD * 2 }
}

function ringPerimeter(width: number, height: number, radius: number): number {
  const straightW = Math.max(0, width - 2 * radius)
  const straightH = Math.max(0, height - 2 * radius)
  return 2 * (straightW + straightH) + 2 * Math.PI * radius
}

function pointAt(
  width: number,
  height: number,
  radius: number,
  distance: number
): RingPoint {
  const straightW = Math.max(0, width - 2 * radius)
  const straightH = Math.max(0, height - 2 * radius)
  const corner = (Math.PI * radius) / 2
  let left = distance
  if (left <= straightW) return { x: radius + left, y: 0 }
  left -= straightW
  if (left <= corner)
    return arc(width - radius, radius, radius, -Math.PI / 2, left)
  left -= corner
  if (left <= straightH) return { x: width, y: radius + left }
  left -= straightH
  if (left <= corner)
    return arc(width - radius, height - radius, radius, 0, left)
  left -= corner
  if (left <= straightW) return { x: width - radius - left, y: height }
  left -= straightW
  if (left <= corner)
    return arc(radius, height - radius, radius, Math.PI / 2, left)
  left -= corner
  if (left <= straightH) return { x: 0, y: height - radius - left }
  left -= straightH
  return arc(radius, radius, radius, Math.PI, left)
}

function arc(
  cx: number,
  cy: number,
  radius: number,
  start: number,
  distance: number
): RingPoint {
  const angle = start + (radius === 0 ? 0 : distance / radius)
  return {
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle)
  }
}

function rgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16)
  ]
}
