import { useEffect } from 'react'
import { AppState } from 'react-native'

/**
 * Runs `action` once now, again whenever it changes (a sign-in makes a new
 * one), and each time the app comes to the foreground: when `AppState` turns
 * `active` from anything else. Never on a timer, unlike
 * `useForegroundRefresh`, which also reads every thirty seconds while
 * visible: what runs here may ask the person something, or ask the server,
 * and a phone left open must not be asked twice a minute.
 */
export function useForegroundEntry(action: () => Promise<void>): void {
  useEffect(() => {
    let last = AppState.currentState
    action().catch(() => undefined)
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active' && last !== 'active')
        action().catch(() => undefined)
      last = state
    })
    return () => {
      subscription.remove()
    }
  }, [action])
}
