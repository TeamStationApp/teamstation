import { AccessibilityInfo } from 'react-native'

/** Live settings win over a delayed initial native preference query. */
export function watchReducedTransparency(
  accept: (reduced: boolean) => void
): () => void {
  let active = true
  let changed = false
  const subscription = AccessibilityInfo.addEventListener(
    'reduceTransparencyChanged',
    value => {
      changed = true
      if (active) accept(value)
    }
  )
  const initial = (value: boolean): void => {
    if (active && !changed) accept(value)
  }
  AccessibilityInfo.isReduceTransparencyEnabled()
    .then(initial)
    .catch(() => {
      initial(false)
    })
  return () => {
    active = false
    subscription.remove()
  }
}
