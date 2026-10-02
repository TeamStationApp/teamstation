import { useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'

/** Observe live accessibility changes without a stale initial query winning. */
export function useMotionPreference(): boolean {
  const [reduced, setReduced] = useState(true)
  useEffect(() => {
    let active = true
    let changed = false
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      value => {
        changed = true
        setReduced(value)
      }
    )
    const accept = (value: boolean): void => {
      if (active && !changed) setReduced(value)
    }
    AccessibilityInfo.isReduceMotionEnabled()
      .then(accept)
      .catch(() => {
        accept(false)
      })
    return () => {
      active = false
      subscription.remove()
    }
  }, [])
  return reduced
}
