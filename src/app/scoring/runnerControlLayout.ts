import type { BaseProjection } from '../field/fieldTypes'

const BUTTON_WIDTH = 68
const BUTTON_HEIGHT = 44
const GAP = 8
const SIDE_OFFSET = 32
const ROW_WIDTH = BUTTON_WIDTH * 2 + GAP
const PAIR_HEIGHT = BUTTON_HEIGHT * 2 + GAP

interface Point {
  x: number
  y: number
}
export interface DecisionFrame {
  position: 'absolute'
  left: number
  top: number
  width: number
}

/** Shared with a runner reaching home on a hit; independent of drag targets. */
export function homeDecisionFrame(
  projection: BaseProjection | undefined,
  anchor: Point | null,
  back: boolean
): DecisionFrame | undefined {
  const point = projection?.bases[0] ?? anchor
  if (point == null) return undefined
  const tall = back ? BUTTON_HEIGHT * 3 + GAP * 2 : PAIR_HEIGHT
  const top = Math.max(
    8,
    Math.min((projection?.height ?? 10000) - 128 - tall, point.y - tall / 2)
  )
  let left = point.x + SIDE_OFFSET
  const second = projection?.heads?.[2]
  // A short field can bring the above-second pair alongside home. Keep
  // home on the right, with a gap between the two sets of hit targets.
  if (
    second != null &&
    top < second.y - GAP &&
    top + tall > second.y - BUTTON_HEIGHT - GAP &&
    left < second.x + ROW_WIDTH / 2 + GAP &&
    left + BUTTON_WIDTH > second.x - ROW_WIDTH / 2 - GAP
  )
    left = Math.max(left, second.x + ROW_WIDTH / 2 + GAP)
  return {
    position: 'absolute',
    width: BUTTON_WIDTH,
    left: Math.max(
      GAP,
      Math.min((projection?.width ?? 10000) - BUTTON_WIDTH - GAP, left)
    ),
    top
  }
}

/** Controls stay beside their destination runner, including narrow fields. */
export function choiceDecisionFrame(
  projection: BaseProjection,
  to: number,
  slot = 0
): DecisionFrame {
  const base = to % 4
  const point = projection.bases[base]
  const head = projection.heads?.[base] ?? point
  const feet = projection.feet?.[base] ?? point
  const width = base === 2 ? ROW_WIDTH : BUTTON_WIDTH
  const height = base === 2 ? BUTTON_HEIGHT : PAIR_HEIGHT
  const home =
    base === 0 ? homeDecisionFrame(projection, null, false)! : undefined
  const left =
    home?.left ??
    (base === 2
      ? head.x - width / 2
      : base === 3
        ? feet.x - width - SIDE_OFFSET
        : feet.x + SIDE_OFFSET)
  const initialTop =
    home?.top ??
    (base === 2 ? head.y - height - 8 : (head.y + feet.y) / 2 - height / 2)
  const after = initialTop + slot * (height + 8)
  const top =
    after + height <= projection.height - 8
      ? after
      : initialTop - slot * (height + 8)
  return {
    position: 'absolute',
    width,
    left: Math.max(8, Math.min(projection.width - width - 8, left)),
    top: Math.max(8, Math.min(projection.height - height - 8, top))
  }
}
