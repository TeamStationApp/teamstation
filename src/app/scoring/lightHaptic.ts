/** Browsers may refuse or omit vibration; either case leaves the drag alone. */
export function lightHaptic(_view?: unknown): void {
  try {
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.vibrate === 'function'
    )
      navigator.vibrate(8)
  } catch {
    // Vibration is optional and can be unavailable in this browsing context.
  }
}
