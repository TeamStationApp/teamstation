import { AccessibilityInfo, Platform } from 'react-native'

export function watchReducedTransparency(
  accept: (reduced: boolean) => void
): () => void {
  const android = Platform.OS === 'android'
  let active = true
  let changed = false
  const subscription = AccessibilityInfo.addEventListener(
    android ? 'highTextContrastChanged' : 'reduceTransparencyChanged',
    value => {
      changed = true
      if (active) accept(value)
    }
  )
  const initial = android
    ? AccessibilityInfo.isHighTextContrastEnabled()
    : AccessibilityInfo.isReduceTransparencyEnabled()
  const apply = (value: boolean): void => {
    if (active && !changed) accept(value)
  }
  initial.then(apply, () => {
    apply(false)
  })
  return () => {
    active = false
    subscription.remove()
  }
}
