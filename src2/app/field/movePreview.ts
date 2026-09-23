import {
  clampToField,
  type FieldPlayer,
  type GroundPoint,
  nextBase
} from './fieldModel'

export interface MoveDraft {
  touch?: boolean
  id: string
  pointer: number
  origin: GroundPoint
  goal: GroundPoint
  offset: GroundPoint
  next: GroundPoint | null
  commit: boolean
}
export function beginMove(
  player: FieldPlayer,
  pointer: number,
  ground: GroundPoint,
  grabbed = true
): MoveDraft {
  player.dragging = true
  player.speed = 0
  return {
    id: player.id,
    pointer,
    origin: { ...player.position },
    goal: { ...player.position },
    offset: grabbed
      ? { x: player.position.x - ground.x, z: player.position.z - ground.z }
      : { x: 0, z: 0 },
    next:
      player.team === 'runner' && player.batting !== true
        ? nextBase(player)
        : null,
    commit: false
  }
}
export function previewMove(draft: MoveDraft, point: GroundPoint): void {
  const target = { x: point.x + draft.offset.x, z: point.z + draft.offset.z }
  if (draft.next == null) {
    draft.goal = clampToField(target)
    draft.commit = true
    return
  }
  const dx = draft.next.x - draft.origin.x
  const dz = draft.next.z - draft.origin.z
  const progress = Math.max(
    0,
    Math.min(
      1,
      ((target.x - draft.origin.x) * dx + (target.z - draft.origin.z) * dz) /
        Math.max(0.01, dx * dx + dz * dz)
    )
  )
  draft.commit = progress > 0.5
  draft.goal = draft.commit
    ? { ...draft.next }
    : { x: draft.origin.x + progress * dx, z: draft.origin.z + progress * dz }
}
export function finishMove(
  player: FieldPlayer,
  draft: MoveDraft,
  cancel = false
): void {
  player.dragging = false
  if (cancel) {
    player.position = { ...draft.origin }
    player.target = { ...draft.origin }
  }
  if (!cancel) player.target = { ...(draft.commit ? draft.goal : draft.origin) }
}
