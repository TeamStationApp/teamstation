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
  height: number
): { safe: TargetRect; out: TargetRect } {
  const x = Math.max(8, Math.min(width - 176, anchor.x - 84))
  const y = Math.max(66, Math.min(height - 56, anchor.y - 58))
  return {
    safe: { x, y, width: 80, height: 44 },
    out: { x: x + 88, y, width: 80, height: 44 }
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
  height: number
): RunnerDragView {
  const start = BASES[from % 4]
  const end = BASES[(from + 1) % 4]
  const progress = runnerProgress(start, end, point)
  const to = progress > 0.5 + 1e-12 ? from + 1 : from
  return {
    id,
    from,
    to,
    progress,
    point: {
      x: start.x + (end.x - start.x) * progress,
      z: start.z + (end.z - start.z) * progress
    },
    ...runnerTargets(project(BASES[to % 4]), width, height)
  }
}
