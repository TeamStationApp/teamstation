import { type RunnerDragView, runnerDragView } from '../scoring/runnerDrag'
import { BASES, type FieldPlayer, type GroundPoint } from './fieldModel'
import type { FieldCanvasProps } from './fieldTypes'
const keyboardDrags = new WeakMap<FieldPlayer, RunnerDragView>()
/** Keyboard input uses the same eligibility and accepted-placement boundary as pointers. */
export interface KeyboardProjection {
  project: (point: GroundPoint) => { x: number; y: number }
  width: number
  height: number
}
export function fieldKey(
  props: FieldCanvasProps,
  key: string,
  projection?: KeyboardProjection
): boolean {
  const policy = props.interaction
  if (policy?.gestures.includes('trajectory') === true && props.arc != null) {
    if (key === 'Enter')
      props.onTrajectoryAccepted?.(props.arc.angle, policy.generation)
    else if (key === 'ArrowUp' || key === 'ArrowDown')
      props.onArcChange?.({
        ...props.arc,
        angle: Math.max(
          -45,
          Math.min(70, props.arc.angle + (key === 'ArrowUp' ? 1 : -1))
        )
      })
    else return false
    return true
  }
  if (policy != null && !policy.gestures.includes('place')) return false
  const eligible = props.players.filter(player =>
    policy != null
      ? policy.selectableIds.includes(player.id)
      : props.selectableIds == null || props.selectableIds.includes(player.id)
  )
  if (eligible.length === 0) return false
  const index = eligible.findIndex(player => player.id === props.selected)
  const player = eligible[Math.max(0, index)]
  const cancel = (): void => {
    if (player.keyboardOrigin != null) {
      player.position = { ...player.keyboardOrigin }
      player.target = { ...player.keyboardOrigin }
      delete player.keyboardOrigin
    }
    keyboardDrags.delete(player)
    props.onRunnerDrag?.(null)
    props.onGestureActive?.(false)
    props.onSelect('')
  }
  if (key === '[' || key === ']') {
    cancel()
    props.onSelect(
      eligible[
        (index < 0
          ? key === ']'
            ? 0
            : eligible.length - 1
          : index + (key === ']' ? 1 : eligible.length - 1)) % eligible.length
      ].id
    )
  } else if (key === ' ' && player.keyboardOrigin == null) {
    keyboardDrags.delete(player)
    player.keyboardOrigin = { ...player.position }
    props.onSelect(player.id)
    props.onGestureActive?.(true)
  } else if (key === 'Escape') cancel()
  else if (player.keyboardOrigin == null) return false
  else if (key === 'Enter') {
    if (policy?.runnerIds?.includes(player.id) === true) {
      const view = keyboardDrags.get(player)
      if (view?.hovered == null) {
        cancel()
        return true
      }
      props.onRunnerDrop?.(player.id, view.to, view.hovered, policy.generation)
      cancel()
    } else {
      delete player.keyboardOrigin
      props.onPlayerPlacement?.(player.id, { ...player.target })
      props.onFieldPlacement?.({
        entityId: player.id,
        point: { ...player.target },
        generation: policy?.generation ?? 0,
        gestureId: 0
      })
      props.onSelect('')
      props.onGestureActive?.(false)
    }
  } else if (
    ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 's', 'o'].includes(key)
  ) {
    if (policy?.runnerIds?.includes(player.id) === true) {
      if (projection == null) return false
      const from = player.runnerBase ?? (player.batting === true ? 0 : 1)
      const start = BASES[from % 4]
      const end = BASES[(from + 1) % 4]
      const previous = keyboardDrags.get(player)
      const progress = Math.max(
        0,
        Math.min(
          1,
          (previous?.progress ?? 0) +
            (key === 'ArrowRight' || key === 'ArrowUp'
              ? 0.1
              : key === 'ArrowLeft' || key === 'ArrowDown'
                ? -0.1
                : 0)
        )
      )
      const view = runnerDragView(
        player.id,
        from,
        {
          x: start.x + (end.x - start.x) * progress,
          z: start.z + (end.z - start.z) * progress
        },
        projection.project,
        projection.width,
        projection.height
      )
      view.keyboard = true
      view.safeDisabled = props.runnerSafeError?.(player.id, view.to)
      view.hovered =
        key === 's' && view.safeDisabled == null
          ? 'safe'
          : key === 'o'
            ? 'out'
            : undefined
      keyboardDrags.set(player, view)
      player.target = { ...view.point }
      props.onRunnerDrag?.(view)
    } else {
      if (key === 's' || key === 'o') return false
      player.target = {
        x:
          player.target.x +
          (key === 'ArrowLeft' ? -3 : key === 'ArrowRight' ? 3 : 0),
        z:
          player.target.z +
          (key === 'ArrowUp' ? -3 : key === 'ArrowDown' ? 3 : 0)
      }
    }
  } else return false
  return true
}
