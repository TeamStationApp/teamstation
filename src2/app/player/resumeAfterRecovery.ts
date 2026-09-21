/**
 * Shared by both `attachHls` files, so it lives in neither.
 *
 * A native sibling that imports from its own web twin imports *itself*:
 * Metro resolves `./attachHls` inside `attachHls.native.ts` back to
 * `attachHls.native.ts`, and the binding is `undefined` at run time. Anything
 * two siblings share therefore has to sit in a third module that is neither
 * of them.
 */

/**
 * Whether a stumble in the stream should be followed by playing again.
 *
 * Three things have to be true at once, and the third is the one that keeps
 * this honest: **a pause the viewer asked for is left alone.** Only a pause
 * that arrived while a recovery was in flight is the recovery's doing, and only
 * that one is undone.
 */
export function shouldResumeAfterRecovery(state: {
  /** A recovery is in flight, so a pause now was not the viewer's. */
  recovering: boolean
  /** What the viewer last asked for. */
  wantsToPlay: boolean
  /** What the element is actually doing. */
  paused: boolean
}): boolean {
  return state.recovering && state.wantsToPlay && state.paused
}
