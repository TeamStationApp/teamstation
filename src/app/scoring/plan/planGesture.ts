import type { PlanCell } from '../../../common/gamePlan'

/**
 * A phone's hold-and-drag assignment on the game plan, without React: a
 * finger held on a cell opens the field picker, moves over its targets, and
 * lets go on one to write it. Points and rectangles are in window
 * coordinates, as the responder reports a touch and `measureInWindow` a view.
 */
export interface PlanPoint {
  x: number
  y: number
}
export interface PlanRect extends PlanPoint {
  width: number
  height: number
}
/** One of the picker's positions, and where it is drawn. */
export interface PickerTarget {
  value: PlanCell
  rect: PlanRect
}
/** A cell of the sheet: its row, in batting order, and its inning from 0. */
export interface PlanCellAddress {
  row: number
  inning: number
}

/** A finger travelling this far from where it held has moved. */
export const ASSIGN_MOVE_DISTANCE = 6

const contains = (rect: PlanRect, point: PlanPoint): boolean =>
  point.x >= rect.x &&
  point.x <= rect.x + rect.width &&
  point.y >= rect.y &&
  point.y <= rect.y + rect.height

/** The picker's position under the point, or null over none. */
export function pickerHit(
  point: PlanPoint,
  targets: readonly PickerTarget[]
): PlanCell | null {
  return targets.find(target => contains(target.rect, point))?.value ?? null
}

/** The enlarged box is half as large again as the target it shows. */
export const ENLARGED_SCALE = 1.5
/** Its bottom edge sits this share of the target's height above the target. */
export const ENLARGED_LIFT = 0.75

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value))

/**
 * Where the enlarged box of a held or hovered target is drawn: 1.5 times its
 * size, centred over it, its bottom edge three quarters of the target's
 * height above the target's top, so a finger on the target never hides it,
 * and kept inside `bounds`. It is only drawn: `pickerHit` tests the targets
 * themselves, so a finger moving up under the box still reaches the targets
 * it covers.
 */
export function enlargedRect(target: PlanRect, bounds: PlanRect): PlanRect {
  const width = target.width * ENLARGED_SCALE
  const height = target.height * ENLARGED_SCALE
  return {
    x: clamp(
      target.x + (target.width - width) / 2,
      bounds.x,
      bounds.x + bounds.width - width
    ),
    y: clamp(
      target.y - ENLARGED_LIFT * target.height - height,
      bounds.y,
      bounds.y + bounds.height - height
    ),
    width,
    height
  }
}

export interface AssignDrag {
  cell: PlanCellAddress
  start: PlanPoint
  /** The target under the finger, which the picker highlights. */
  over: PlanCell | null
  moved: boolean
}

/**
 * A hold begun: on a cell, over nothing yet; on one of the picker's
 * targets, over that target.
 */
export function startAssignDrag(
  cell: PlanCellAddress,
  start: PlanPoint,
  over: PlanCell | null = null
): AssignDrag {
  return { cell, start, over, moved: false }
}

export function moveAssignDrag(
  drag: AssignDrag,
  point: PlanPoint,
  targets: readonly PickerTarget[]
): AssignDrag {
  return {
    ...drag,
    over: pickerHit(point, targets),
    moved:
      drag.moved ||
      Math.hypot(point.x - drag.start.x, point.y - drag.start.y) >
        ASSIGN_MOVE_DISTANCE
  }
}

/**
 * What letting go does. Over a target, the cell takes it and the picker
 * closes. Anywhere else after a move, the cell is unchanged and the picker
 * closes; let go where it was held, the picker stays open for a tap, as a
 * tap would have left it.
 */
export function releaseAssignDrag(
  drag: AssignDrag,
  point: PlanPoint,
  targets: readonly PickerTarget[]
): { write: PlanCell | null; close: boolean } {
  const write = pickerHit(point, targets)
  if (write != null) return { write, close: true }
  return { write: null, close: moveAssignDrag(drag, point, targets).moved }
}
