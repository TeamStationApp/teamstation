import type { NativeCameraFocus } from './NativePhoneStream'

export interface FocusPoint {
  x: number
  y: number
}

export const focusLabels = {
  auto: 'Auto Focus',
  focusing: 'Focusing',
  locked: 'Focus locked',
  failed: 'Focus failed',
  unsupported: 'Focus unavailable',
  reset: 'Focus reset'
} as const

export const focusDurationMs = 2000
const validId = /^[A-Za-z0-9_-]{1,64}$/

export function focusLabel(focus?: NativeCameraFocus): string {
  return focus != null && Object.hasOwn(focusLabels, focus.phase)
    ? focusLabels[focus.phase as keyof typeof focusLabels]
    : focusLabels.unsupported
}

/** A point in the encoded image. Only preview mirroring is removed here. */
export function focusImagePoint(
  x: number,
  y: number,
  width: number,
  height: number,
  imageWidth: number,
  imageHeight: number,
  mirrored = false,
  fill = false
): FocusPoint | null {
  if (
    ![x, y, width, height, imageWidth, imageHeight].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    imageWidth <= 0 ||
    imageHeight <= 0
  )
    return null
  if (x < 0 || y < 0 || x > width || y > height) return null
  const scale = (fill ? Math.max : Math.min)(
    width / imageWidth,
    height / imageHeight
  )
  const dx = (width - imageWidth * scale) / 2
  const dy = (height - imageHeight * scale) / 2
  const px = (x - dx) / (imageWidth * scale)
  const py = (y - dy) / (imageHeight * scale)
  if (px < 0 || px > 1 || py < 0 || py > 1) return null
  return { x: mirrored ? 1 - px : px, y: py }
}

export function focusCommand(
  focus: NativeCameraFocus | undefined,
  point: FocusPoint | null,
  token: string
): string | null {
  if (
    focus?.supported !== true ||
    !validId.test(focus.generation) ||
    !validId.test(token)
  )
    return null
  if (point == null) return `auto:${focus.generation}:${token}`
  if (
    ![point.x, point.y].every(
      value => Number.isFinite(value) && value >= 0 && value <= 1
    )
  )
    return null
  return `point:${focus.generation}:${token}:${point.x}:${point.y}`
}

export function focusOpacity(elapsedMs: number): number {
  if (elapsedMs < 0 || elapsedMs >= focusDurationMs) return 0
  return 0.35 + (0.65 * (1 + Math.cos((elapsedMs * Math.PI) / 250))) / 2
}

/** A cancelled, held, dragged or multi-finger gesture must never focus on release. */
export function focusTap(
  onTap: (point: FocusPoint) => void,
  now = Date.now
): {
  start: (points: FocusPoint[]) => void
  move: (points: FocusPoint[]) => void
  end: () => void
  cancel: () => void
} {
  let origin: FocusPoint | undefined
  let began = 0
  return {
    start: points => {
      origin = points.length === 1 ? points[0] : undefined
      began = now()
    },
    move: points => {
      if (origin == null) return
      if (
        points.length !== 1 ||
        Math.hypot(points[0].x - origin.x, points[0].y - origin.y) > 6
      )
        origin = undefined
    },
    end: () => {
      const point = origin
      origin = undefined
      if (point != null && now() - began <= 350) onTap(point)
    },
    cancel: () => {
      origin = undefined
    }
  }
}
