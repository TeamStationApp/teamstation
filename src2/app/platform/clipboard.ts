/**
 * Copy, where this app runs.
 *
 * A browser has `navigator.clipboard`, and it is not there at all on an
 * insecure origin, so the absence is ordinary rather than an error worth
 * reporting: the string is on the screen and can be selected by hand.
 */
export function copyToClipboard(text: string): void {
  const clipboard = (globalThis as { navigator?: Navigator }).navigator
    ?.clipboard
  if (clipboard == null) return
  clipboard.writeText(text).catch(() => undefined)
}
