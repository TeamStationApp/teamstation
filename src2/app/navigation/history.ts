import { type Route, routePath } from './routes'

/**
 * Everywhere the app has been this launch, and the rules for walking it.
 *
 * A browser keeps this and lends it out; a phone has to keep its own, and this
 * is it. Pure, and its own module rather than a few `let`s inside
 * `useAddressBar.native.ts`, because it went wrong twice while the app was
 * being built and both times the symptom was a Back button that appeared to do
 * nothing — which is indistinguishable from a hang, and which nothing but a
 * device could show.
 *
 * The rules are the browser's, deliberately:
 *
 * - **A move is a push, a correction is a replace.** Landing on `/` and
 *   resolving it, or the playhead moving inside a video, must not leave a step
 *   for Back to walk into — watch twenty highlights and Back would need twenty
 *   presses to leave the game.
 * - **The same address twice is one entry.** iOS can deliver one tap as both a
 *   universal link and a handoff activity, and somebody can tap the same link
 *   twice; either way a duplicate makes the next Back press a visible no-op.
 * - **Going back off the end is not this module's business.** It answers
 *   whether it moved, and the caller decides what that means — on Android,
 *   that the app should close rather than sit there ignoring the button.
 */
export interface History {
  /** The address the app was opened on, before anything renders. */
  seed: (route: Route) => void
  current: () => Route
  /** How many steps there are, which is only ever interesting in a test. */
  depth: () => number
  /** Records a move, or corrects the step already there. */
  show: (route: Route, replace?: boolean) => void
  /**
   * A step back. `false` means there was nowhere to go.
   *
   * Used by two callers that must agree: Android's system Back, and the
   * chevron in the header.
   */
  back: () => boolean
}

export function makeHistory(start: Route = { name: 'home' }): History {
  let entries: Route[] = [start]

  return {
    /** The address the app was opened on, before anything renders. */
    seed(route: Route): void {
      entries = [route]
    },

    current(): Route {
      return entries[entries.length - 1]
    },

    /** How many steps there are, which is only ever interesting in a test. */
    depth(): number {
      return entries.length
    },

    /** Records a move, or corrects the step already there. */
    show(route: Route, replace = false): void {
      if (routePath(route) === routePath(this.current())) return
      if (replace) entries[entries.length - 1] = route
      else entries.push(route)
    },

    /**
     * A step back. `false` means there was nowhere to go.
     *
     * Used by two callers that must agree: Android's system Back, and the
     * chevron in the header. The chevron pops the shell's own screen stack, so
     * if this did not follow it the two would drift and the next press of Back
     * would walk to a route the app is already on.
     */
    back(): boolean {
      if (entries.length <= 1) return false
      entries.pop()
      return true
    }
  }
}
