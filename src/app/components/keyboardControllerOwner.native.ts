import { useEffect } from 'react'
import { Platform } from 'react-native'
import {
  KeyboardController,
  KeyboardEvents,
  useKeyboardController
} from 'react-native-keyboard-controller'

/** The screens that currently hold the Android keyboard coordination. */
const owners = new Set<object>()

/**
 * Holds react-native-keyboard-controller enabled on Android while `active`.
 *
 * Android resizes the window for the keyboard unless the controller is
 * enabled, and every other screen relies on that resize, so the root
 * provider starts disabled there (`ChatKeyboardProvider`) and a screen that
 * moves with the keyboard itself enables it only while it is on show. Two
 * such screens (a conversation over Search) share it: it stays enabled until
 * the last lets go. iOS never resizes its window; the root keeps it on.
 *
 * A screen lets go only once the keyboard has finished going away: leaving
 * Search, by a push, its back chevron or another tab, puts the keyboard away
 * as it goes, and a controller turned off mid-hide keeps the keyboard's
 * height where the hide stopped, which the next screen to take it up would
 * draw as a raised dock with no keyboard.
 */
export function useKeyboardControllerOwner(active: boolean): void {
  const { setEnabled } = useKeyboardController()
  useEffect(() => {
    if (Platform.OS !== 'android' || !active) return
    const owner = {}
    owners.add(owner)
    setEnabled(true)
    return () => {
      releaseOnceHidden(() => {
        owners.delete(owner)
        if (owners.size === 0) setEnabled(false)
      })
    }
  }, [active, setEnabled])
}

/** How long a release waits for a keyboard that never says it hid. */
export const RELEASE_FALLBACK_MS = 1000

function releaseOnceHidden(release: () => void): void {
  if (!KeyboardController.isVisible?.()) {
    release()
    return
  }
  let released = false
  const once = (): void => {
    if (released) return
    released = true
    hidden.remove()
    clearTimeout(fallback)
    release()
  }
  const hidden = KeyboardEvents.addListener('keyboardDidHide', once)
  const fallback = setTimeout(once, RELEASE_FALLBACK_MS)
}
