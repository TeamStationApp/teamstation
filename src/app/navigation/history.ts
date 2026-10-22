import { type Route, routePath } from './routes'

/**
 * A screen a navbar clear is leaving, named only by what its address uses.
 *
 * A section change writes `?tab=` and is still this screen. Matching is the
 * pathname, so those entries count as the screen they belong to.
 */
export interface ClearedFrame {
  name: string
  team?: { id: string }
  gameId?: string
  userId?: string
  season?: { id: string }
  kind?: string
  id?: string
}

/** Whether `path` is this frame's screen, query included or not. */
export function frameMatchesPath(frame: ClearedFrame, path: string): boolean {
  const pathname = path.split('?')[0]
  switch (frame.name) {
    case 'team':
      return frame.team != null && pathname === `/teams/${frame.team.id}`
    case 'game':
      return frame.gameId != null && pathname === `/games/${frame.gameId}`
    case 'player':
      return frame.userId != null && pathname === `/players/${frame.userId}`
    case 'season':
      return (
        frame.season != null && pathname === `/seasons/${frame.season.id}`
      )
    case 'group':
      return (
        frame.kind != null &&
        frame.id != null &&
        pathname === `/groups/${frame.kind}/${encodeURIComponent(frame.id)}`
      )
    default:
      return false
  }
}

/**
 * How many trailing entries a clear may drop.
 *
 * The run stops at the first entry, which is the seed and is never dropped.
 * It also stops at a slot this launch never recorded. A reload keeps the
 * browser's index and forgets the mirror, and a Forward that skips a truncated
 * slot leaves the same hole. Either one is an unknown boundary, not a screen,
 * so the suffix is not a straight line. The count is kept only when the entry
 * that would remain is `rootPath`. Anything else drops nothing, and the
 * address effect pushes the root instead.
 */
export function suffixDropCount(
  entries: readonly string[],
  matches: (path: string) => boolean,
  rootPath: string
): number {
  let count = 0
  for (let index = entries.length - 1; index >= 1; index--) {
    const entry = entries[index]
    if (typeof entry !== 'string' || !matches(entry)) break
    count++
  }
  if (count === 0) return 0
  return entries[entries.length - 1 - count] === rootPath ? count : 0
}

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
  /**
   * Drops a straight-line suffix of `frames` when what remains is `rootPath`.
   * Returns how many entries were dropped.
   */
  dropSuffix: (frames: readonly ClearedFrame[], rootPath: string) => number
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
    },

    dropSuffix(frames: readonly ClearedFrame[], rootPath: string): number {
      const count = suffixDropCount(
        entries.map(route => routePath(route)),
        path => frames.some(frame => frameMatchesPath(frame, path)),
        rootPath
      )
      for (let index = 0; index < count; index++) entries.pop()
      return count
    }
  }
}
