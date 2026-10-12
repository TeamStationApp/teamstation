import type { PhoneZoomScale } from '../phoneStreamClient'
import { ZOOM } from './overlayTheme'

/**
 * The zoom rail's arithmetic, ported from TS Cameraman's `ZoomMapping` so the
 * phone's rail reads and moves exactly as Cameraman's does. Everything is in
 * displayed zoom, the number on the pills (0.5x, 1x, 3x), which is what the
 * engine's `zoomScale()` reports.
 */

/** Which mark lights for a zoom: a pill, or one of a segment's five ticks. */
export type ScaleHighlight =
  | { kind: 'preset'; value: number }
  | { kind: 'tick'; segment: number; index: number }

/** `0.5x`, `1x`, `2.5x`, `10x`, the way the Camera app writes a zoom. */
export function zoomLabel(displayed: number): string {
  const rounded = Math.round(displayed * 10) / 10
  if (Math.abs(rounded - Math.round(rounded)) < 0.05)
    return `${Math.round(rounded)}x`
  return `${rounded.toFixed(1)}x`
}

/** The rail's labels: whole numbers from 1x up, a tenth below it. */
export function sliderLabel(displayed: number): string {
  if (displayed < 1) return zoomLabel(displayed)
  return `${Math.round(displayed)}x`
}

/** The longest lens: the widest one, or the last switch-over past it. */
function longestLens(scale: PhoneZoomScale): number {
  return Math.max(scale.minimum, ...scale.switchOvers)
}

/**
 * Past the longest lens, where the camera (or the engine) crops instead of
 * changing lens. Its pills, ticks and readout are yellow.
 */
export function isDigitalZoom(
  scale: PhoneZoomScale,
  displayed: number
): boolean {
  const longest = longestLens(scale)
  return zoomLabel(displayed) !== zoomLabel(longest) && displayed > longest
}

/** A segment that ends past the longest lens. */
export function isDigitalSegment(
  scale: PhoneZoomScale,
  segment: number
): boolean {
  const next = scale.presets[segment + 1]
  return segment >= 0 && next != null && isDigitalZoom(scale, next)
}

export function clampZoom(scale: PhoneZoomScale, displayed: number): number {
  if (!Number.isFinite(displayed)) return scale.minimum
  return Math.min(Math.max(displayed, scale.minimum), scale.maximum)
}

/** How many segments the rail draws between its pills. */
export function segmentCount(scale: PhoneZoomScale): number {
  return Math.max(scale.presets.length - 1, 0)
}

/**
 * The pill whose label the zoom rounds to, or else the tick of the segment
 * it is in, so a zoom between two pills never leaves the rail dark.
 */
export function scaleHighlight(
  scale: PhoneZoomScale,
  displayed: number
): ScaleHighlight {
  const zoom = clampZoom(scale, displayed)
  const presets = scale.presets
  const last = presets.at(-1)
  if (last == null) return { kind: 'preset', value: zoom }
  const match = presets.find(preset => zoomLabel(preset) === zoomLabel(zoom))
  if (match != null) return { kind: 'preset', value: match }
  const segments = segmentCount(scale)
  if (segments === 0) return { kind: 'preset', value: last }
  if (zoom >= last)
    return {
      kind: 'tick',
      segment: segments - 1,
      index: ZOOM.ticksPerSegment - 1
    }
  for (let segment = 0; segment < segments; segment++) {
    // In thousandths, so 0.7 − 0.5 lands on the right tick.
    const lo = Math.round(presets[segment] * 1000)
    const hi = Math.round(presets[segment + 1] * 1000)
    const milli = Math.round(zoom * 1000)
    if (milli < lo || milli >= hi || hi <= lo) continue
    const index = Math.floor(((milli - lo) * ZOOM.ticksPerSegment) / (hi - lo))
    return {
      kind: 'tick',
      segment,
      index: Math.min(Math.max(index, 0), ZOOM.ticksPerSegment - 1)
    }
  }
  return { kind: 'preset', value: last }
}

/**
 * Where a zoom sits along the drawn rail, 0 at the widest pill and 1 at the
 * tightest. Segments are equal on the screen, not in zoom ratio.
 */
export function scaleProgress(
  scale: PhoneZoomScale,
  displayed: number
): number {
  const presets = scale.presets
  if (presets.length < 2) return 0
  const zoom = clampZoom(scale, displayed)
  const last = presets.length - 1
  if (zoom <= presets[0]) return 0
  if (zoom >= presets[last]) return 1
  for (let index = 0; index < last; index++) {
    const lo = presets[index]
    const hi = presets[index + 1]
    if (hi <= lo || zoom < lo || zoom > hi) continue
    return (index + (zoom - lo) / (hi - lo)) / last
  }
  return 1
}

export function zoomAtProgress(
  scale: PhoneZoomScale,
  progress: number
): number {
  const presets = scale.presets
  if (presets.length === 0) return 1
  if (presets.length < 2) return presets[0]
  const scaled = Math.min(Math.max(progress, 0), 1) * (presets.length - 1)
  const index = Math.min(Math.floor(scaled), presets.length - 2)
  const t = scaled - index
  return presets[index] + (presets[index + 1] - presets[index]) * t
}

/**
 * The zoom a vertical drag has walked to: `draggedUp` points up from where
 * it began, where one `pointsPerSegment` moves from one pill to the next.
 */
export function zoomDraggedFrom(
  scale: PhoneZoomScale,
  start: number,
  draggedUp: number,
  pointsPerSegment: number
): number {
  if (
    !Number.isFinite(draggedUp) ||
    !Number.isFinite(pointsPerSegment) ||
    pointsPerSegment <= 0
  )
    return clampZoom(scale, start)
  const segments = Math.max(segmentCount(scale), 1)
  const progress =
    scaleProgress(scale, start) + draggedUp / (pointsPerSegment * segments)
  return clampZoom(scale, zoomAtProgress(scale, progress))
}
