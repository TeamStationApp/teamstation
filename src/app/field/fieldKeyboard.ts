import { type RunnerDragView, runnerDragView } from '../scoring/runnerDrag'
import { MAX_LAUNCH_ANGLE } from './ballArcModel'
import { BASES, type FieldPlayer, type GroundPoint } from './fieldModel'
import type { FieldCanvasProps } from './fieldTypes'
import { homeRunLanding } from './stadiumBoundary'
const keyboardDrags = new WeakMap<FieldPlayer, RunnerDragView>()
/** Signed drag progress for runners: +forward, −retreat. Survives near-zero flips. */
const keyboardAlong = new WeakMap<FieldPlayer, number>()
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
    if (props.arcMode === 'aim') {
      if (key === 'Enter')
        props.onLandingAccepted?.(props.arc, policy.generation)
      else if (
        ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)
      ) {
        const target = {
          x:
            props.arc.target.x +
            (key === 'ArrowLeft' ? -3 : key === 'ArrowRight' ? 3 : 0),
          z:
            props.arc.target.z +
            (key === 'ArrowUp' ? -3 : key === 'ArrowDown' ? 3 : 0)
        }
        props.onArcChange?.({
          ...props.arc,
          target:
            props.homeRunPlacement === true ? homeRunLanding(target) : target
        })
      } else if (key !== ' ') return false
      return true
    }
    if (key === 'Enter')
      props.onTrajectoryAccepted?.(props.arc.angle, policy.generation)
    else if (key === 'ArrowUp' || key === 'ArrowDown')
      props.onArcChange?.({
        ...props.arc,
        angle: Math.max(
          -45,
          Math.min(
            MAX_LAUNCH_ANGLE,
            props.arc.angle + (key === 'ArrowUp' ? 1 : -1)
          )
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
    keyboardAlong.delete(player)
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
      keyboardAlong.delete(player)
      cancel()
    } else {
      const destination = { ...player.target }
      if (props.deferDefenderPlacement === true && player.team === 'defense') {
        player.position = { ...player.keyboardOrigin }
        player.target = { ...player.keyboardOrigin }
      }
      delete player.keyboardOrigin
      props.onPlayerPlacement?.(player.id, destination)
      props.onFieldPlacement?.({
        entityId: player.id,
        point: props.constrainPlacement?.(destination) ?? {
          ...destination
        },
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
      const canRetreat = policy?.retreatIds?.includes(player.id) === true
      const canAdvance =
        policy?.advanceIds == null || policy.advanceIds.includes(player.id)
      // Signed progress: +forward toward the next base, −back when retreat
      // is allowed. Kept in its own map so a small back step is not rewritten
      // as a forward progress when runnerDragView still reports to === from.
      const delta =
        key === 'ArrowRight' || key === 'ArrowUp'
          ? 0.1
          : key === 'ArrowLeft' || key === 'ArrowDown'
            ? -0.1
            : 0
      const along = Math.max(
        canRetreat && from > 1 ? -1 : 0,
        Math.min(canAdvance ? 1 : 0, (keyboardAlong.get(player) ?? 0) + delta)
      )
      keyboardAlong.set(player, along)
      const end = along >= 0 ? BASES[(from + 1) % 4] : BASES[(from - 1) % 4]
      const progress = Math.abs(along)
      const view = runnerDragView(
        player.id,
        from,
        {
          x: start.x + (end.x - start.x) * progress,
          z: start.z + (end.z - start.z) * progress
        },
        projection.project,
        projection.width,
        projection.height,
        canRetreat,
        canAdvance
      )
      view.keyboard = true
      view.safeDisabled = props.runnerSafeError?.(player.id, view.to)
      // Retreat commits without S/O, but not onto an occupied start base.
      // Retreat-only runners (no advanceIds) also have no Safe/Out at rest.
      view.hovered =
        view.to < from
          ? view.safeDisabled == null
            ? 'safe'
            : undefined
          : !canAdvance
            ? undefined
            : key === 's' && view.safeDisabled == null
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
      if (props.constrainPlacement != null)
        player.target = props.constrainPlacement(player.target)
    }
  } else return false
  return true
}
