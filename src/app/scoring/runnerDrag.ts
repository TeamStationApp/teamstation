import { BASES, type GroundPoint } from '../field/fieldModel'
export type RunnerDecision = 'safe' | 'out'
export interface TargetRect {
  x: number
  y: number
  width: number
  height: number
}
export interface RunnerDragView {
  keyboard?: boolean
  id: string
  from: number
  to: number
  progress: number
  point: GroundPoint
  safe: TargetRect
  out: TargetRect
  hovered?: RunnerDecision
  safeDisabled?: string
}
export function runnerProgress(
  from: GroundPoint,
  to: GroundPoint,
  point: GroundPoint
): number {
  const dx = to.x - from.x
  const dz = to.z - from.z
  return Math.max(
    0,
    Math.min(
      1,
      ((point.x - from.x) * dx + (point.z - from.z) * dz) /
        Math.max(0.001, dx * dx + dz * dz)
    )
  )
}
export function runnerTargets(
  anchor: { x: number; y: number },
  width: number,
  height: number,
  base = 2
): { safe: TargetRect; out: TargetRect } {
  const vertical = base % 4 !== 2
  const span = vertical ? 80 : 168
  const tall = vertical ? 140 : 66
  const desiredX = vertical
    ? base % 4 === 3
      ? anchor.x - 100
      : anchor.x + 20
    : anchor.x - 84
  const x = Math.max(8, Math.min(width - span - 8, desiredX))
  const y = Math.max(
    8,
    Math.min(height - 128 - tall, anchor.y - (vertical ? 70 : 80))
  )
  return {
    safe: { x, y, width: 80, height: 66 },
    out: {
      x: vertical ? x : x + 88,
      y: vertical ? y + 74 : y,
      width: 80,
      height: 66
    }
  }
}
export function runnerTargetAt(
  view: Pick<RunnerDragView, 'safe' | 'out' | 'safeDisabled'>,
  pointer: { x: number; y: number }
): RunnerDecision | undefined {
  return (['safe', 'out'] as const).find(key => {
    if (key === 'safe' && view.safeDisabled != null) return false
    const r = view[key]
    return (
      pointer.x >= r.x &&
      pointer.x <= r.x + r.width &&
      pointer.y >= r.y &&
      pointer.y <= r.y + r.height
    )
  })
}
export function runnerDragView(
  id: string,
  from: number,
  point: GroundPoint,
  project: (point: GroundPoint) => { x: number; y: number },
  width: number,
  height: number,
  canRetreat = false,
  /** When false, forward drag past the start base is ignored (homeDecision retreat). */
  canAdvance = true
): RunnerDragView {
  const start = BASES[from % 4]
  const forward = BASES[(from + 1) % 4]
  const forwardProgress = canAdvance
    ? runnerProgress(start, forward, point)
    : 0
  if (canRetreat && from > 1) {
    const back = BASES[(from - 1) % 4]
    const backProgress = runnerProgress(start, back, point)
    if (
      (!canAdvance && backProgress > 0.5 + 1e-12) ||
      (backProgress > forwardProgress && backProgress > 0.5 + 1e-12)
    ) {
      return {
        id,
        from,
        to: from - 1,
        progress: backProgress,
        point: {
          x: start.x + (back.x - start.x) * backProgress,
          z: start.z + (back.z - start.z) * backProgress
        },
        hovered: 'safe',
        ...runnerTargets(project(BASES[(from - 1) % 4]), width, height, from - 1)
      }
    }
  }
  if (!canAdvance) {
    return {
      id,
      from,
      to: from,
      progress: 0,
      point: { ...start },
      ...runnerTargets(project(start), width, height, from)
    }
  }
  const progress = forwardProgress
  const to = progress > 0.5 + 1e-12 ? from + 1 : from
  return {
    id,
    from,
    to,
    progress,
    point: {
      x: start.x + (forward.x - start.x) * progress,
      z: start.z + (forward.z - start.z) * progress
    },
    ...runnerTargets(project(BASES[to % 4]), width, height, to)
  }
}
