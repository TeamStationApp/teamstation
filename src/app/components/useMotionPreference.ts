import { useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'

/** The last answer any caller heard. */
let known: boolean | undefined

/**
 * Observe live accessibility changes without a stale initial query winning.
 *
 * Until its own query returns a view assumes reduced motion. One that is
 * `remembered` starts from the last answer instead, so a view that moves to
 * another screen tree (the tab bar) can animate on its first frame.
 */
export function useMotionPreference(remembered = false): boolean {
  const [reduced, setReduced] = useState(remembered ? (known ?? true) : true)
  useEffect(() => {
    let active = true
    let changed = false
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      value => {
        changed = true
        known = value
        setReduced(value)
      }
    )
    const accept = (value: boolean): void => {
      if (active && !changed) {
        known = value
        setReduced(value)
      }
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
