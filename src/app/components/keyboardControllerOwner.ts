/**
 * A browser has no keyboard of its own to coordinate with: nothing to hold
 * (`keyboardControllerOwner.native.ts` is the phone's).
 */
export function useKeyboardControllerOwner(_active: boolean): void {}
