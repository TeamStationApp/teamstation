/**
 * A browser has no keyboard of its own to coordinate with: nothing to hold
 * (`keyboardControllerOwner.native.ts` is the phone's).
 */
export function useKeyboardControllerOwner(_active: boolean): void {}

/** Nothing to hold, so nothing to wait for. */
export function useKeyboardControllerHeld(): boolean {
  return true
}
