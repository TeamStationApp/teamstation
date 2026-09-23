import type { FieldCanvasProps } from './fieldTypes'
/** Keyboard input uses the same eligibility and accepted-placement boundary as pointers. */
export function fieldKey(props: FieldCanvasProps, key: string): boolean {
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
  if (key === '[' || key === ']')
    props.onSelect(
      eligible[
        (Math.max(0, index) + (key === ']' ? 1 : eligible.length - 1)) %
          eligible.length
      ].id
    )
  else if (key === 'Enter') {
    delete player.keyboardOrigin
    props.onPlayerPlacement?.(player.id, { ...player.target })
    props.onFieldPlacement?.({
      entityId: player.id,
      point: { ...player.target },
      generation: policy?.generation ?? 0,
      gestureId: 0
    })
    props.onGestureActive?.(false)
  } else if (key === 'Escape') {
    player.target = { ...(player.keyboardOrigin ?? player.position) }
    delete player.keyboardOrigin
    props.onGestureActive?.(false)
  } else if (
    ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)
  ) {
    player.keyboardOrigin ??= { ...player.position }
    props.onGestureActive?.(true)
    props.onSelect(player.id)
    player.target = {
      x:
        player.target.x +
        (key === 'ArrowLeft' ? -3 : key === 'ArrowRight' ? 3 : 0),
      z:
        player.target.z + (key === 'ArrowUp' ? -3 : key === 'ArrowDown' ? 3 : 0)
    }
  } else return false
  return true
}
