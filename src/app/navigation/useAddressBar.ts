import { useEffect } from 'react'

import { type ClearedFrame, frameMatchesPath, suffixDropCount } from './history'
import { noteHistoryMove } from './historyMotion'
import { parseRoute, type Route, routePath } from './routes'

let guard:
  | {
      check: () => Promise<boolean>
      destination: Route
      allow?: (route: Route) => boolean
      onAccepted?: () => void
    }
  | undefined
let position = 0
/** The addresses `showRoute` has written, beside `position`. */
const trail: string[] = []

function locationPath(): string {
  return window.location.pathname + window.location.search
}

function noteTrail(path: string): void {
  trail[position] = path
}

export function setNavigationGuard(
  check: () => Promise<boolean>,
  destination: Route,
  allow?: (route: Route) => boolean,
  onAccepted?: () => void
): () => void {
  const held = { check, destination, allow, onAccepted }
  guard = held
  return () => {
    if (guard === held) guard = undefined
  }
}

function indexOfHistory(): number | undefined {
  const index: unknown = window.history.state?.tsRouteIndex
  return typeof index === 'number' ? index : undefined
}

function initializeHistory(): void {
  position = indexOfHistory() ?? 0
  if (indexOfHistory() == null)
    window.history.replaceState(
      { ...window.history.state, tsRouteIndex: position },
      ''
    )
}

/**
 * Keeps the address bar and the screen you are on saying the same thing.
 *
 * Deliberately the browser's own History API rather than React Navigation.
 * The plan asks for React Navigation so that one description of the routes
 * serves the web and a native app, and it still should — but swapping the
 * navigator in is a rewrite of the shell, and this is the half that anybody
 * actually notices: a game can be linked, a reload keeps your place, and Back
 * goes back a screen instead of leaving the app.
 *
 * `routes.ts` is the part that would be handed to a navigator, so nothing here
 * has to be unpicked when that happens.
 */

/** Never anything: the browser walks its own history. */
export function previousRoute(): Route | undefined {
  return undefined
}

/**
 * The address the app was opened on.
 *
 * Nothing, here. A browser's address bar is readable the moment the page
 * exists, so there is nothing to settle first; the native sibling has to ask
 * the operating system and cannot do it synchronously, and this is the
 * declaration that keeps the two modules exporting the same names.
 */
export function seedRoute(_url: string | null | undefined): void {
  // The address bar is the state.
}

/** Where the address bar currently points. */
export function currentRoute(): Route {
  if (typeof window === 'undefined') return { name: 'home' }
  const route = parseRoute(window.location.pathname, window.location.search)
  if (route.name === 'player' || route.name === 'person') {
    const path = window.location.pathname.replace(
      /(?<=\/)([1-9][0-9]*)(?=\/?$)/,
      route.userId
    )
    if (path !== window.location.pathname) {
      window.history.replaceState(
        window.history.state,
        '',
        path + window.location.search + window.location.hash
      )
    }
  }
  return route
}

/**
 * Writes a route to the address bar without reloading.
 *
 * `replace` is for a route that corrects the one already there — landing on
 * `/` and resolving it to the home screen — so it does not leave a step in
 * the history that Back would walk into.
 */
export function showRoute(route: Route, replace = false): void {
  if (typeof window === 'undefined') return
  initializeHistory()
  const path = routePath(route)
  // Mounting the upgraded person screen must not discard URL metadata that
  // currentRoute preserved while replacing the legacy identity.
  if (
    (route.name === 'player' || route.name === 'person') &&
    path ===
      routePath(parseRoute(window.location.pathname, window.location.search))
  ) {
    noteTrail(path)
    return
  }
  if (path === locationPath()) {
    noteTrail(path)
    return
  }
  if (replace) {
    window.history.replaceState({ tsRouteIndex: position }, '', path)
    noteTrail(path)
  } else {
    window.history.pushState({ tsRouteIndex: ++position }, '', path)
    noteTrail(path)
    trail.length = position + 1
  }
}

/**
 * A step back, taken by something other than the Back button.
 *
 * Nothing, here. The browser keeps the history and the effect that follows a
 * pop writes the address it arrives at; the native sibling has to keep its own
 * and this is where it does so.
 */
export function popRoute(): void {
  // The browser is the history.
}

/** Where a step back taken by `stepBackTo` is to land, until it has. */
let landing: Route | null = null

/**
 * Drops a straight-line history suffix of `frames` when what remains is the
 * tab root. A mirror that disagrees with the address bar drops nothing, and
 * so does a suffix that would uncover a different screen: the address effect
 * pushes the root instead.
 */
export function dropRouteSuffix(
  frames: readonly ClearedFrame[],
  rootPath: string
): void {
  if (typeof window === 'undefined') return
  initializeHistory()
  if (trail[position] !== locationPath()) return
  const count = suffixDropCount(
    trail.slice(0, position + 1),
    path => frames.some(frame => frameMatchesPath(frame, path)),
    rootPath
  )
  if (count <= 0) return
  const queryAt = rootPath.indexOf('?')
  landing =
    queryAt < 0
      ? parseRoute(rootPath, '')
      : parseRoute(rootPath.slice(0, queryAt), rootPath.slice(queryAt))
  window.history.go(-count)
}

/**
 * Back to the step this one was pushed over, with `route` as its address: a
 * page closed by its own button — the full-screen player opened from the
 * videos page — so the history keeps one videos page, not a copy of it for
 * Back to walk into. The shell has already drawn `route`; the pop that
 * follows is not handed back to it.
 */
export function stepBackTo(route: Route): void {
  if (typeof window === 'undefined') return
  initializeHistory()
  landing = route
  window.history.back()
}

/**
 * A `stepBackTo` has not landed yet. The shell writes no address meanwhile:
 * `history.back()` lands later, and a write now would go over the entry being
 * left — the player's — and leave a copy of the videos page for Forward.
 */
export function steppingBack(): boolean {
  return landing != null
}

/** A scoring child uses a real Back step so Forward can reopen the visit. */
export function scoringOriginHistory(): number {
  initializeHistory()
  return position
}
export function backFromScoringPlayer(origin?: number): boolean {
  const steps =
    origin == null ? 1 : Math.max(1, (indexOfHistory() ?? position) - origin)
  window.history.go(-steps)
  return false
}

/** Calls back when the reader presses Back or Forward. */
export function useBrowserBack(
  onRoute: (route: Route) => void,
  beforeLeave?: () => Promise<boolean>
): void {
  useEffect(() => {
    if (typeof window === 'undefined') return
    initializeHistory()
    let restoring: (() => void) | undefined
    let accepting = false
    const onPop = (event?: PopStateEvent): void => {
      if (landing != null) {
        const route = landing
        landing = null
        position = indexOfHistory() ?? position - 1
        const path = routePath(route)
        noteTrail(path)
        trail.length = position + 1
        window.history.replaceState({ tsRouteIndex: position }, '', path)
        return
      }
      if (restoring != null) {
        const done = restoring
        restoring = undefined
        done()
        return
      }
      if (accepting) {
        accepting = false
        position = indexOfHistory() ?? position
        return
      }
      const registeredGuard = guard
      const held: typeof guard =
        guard ??
        (beforeLeave == null
          ? undefined
          : {
              check: beforeLeave,
              destination: currentRoute()
            })
      if (held == null || held.allow?.(currentRoute()) === true) {
        // Read before `position` moves: afterwards every move looks forward.
        // An entry this app did not write (a hash change, another script's
        // `pushState`) has no index to say which way it lies, and one at the
        // same index has not gone either way: no move.
        const landed = indexOfHistory()
        noteHistoryMove({
          direction:
            landed == null || landed === position
              ? 'none'
              : landed < position
                ? 'back'
                : 'forward',
          drawn:
            (event as { hasUAVisualTransition?: boolean } | undefined)
              ?.hasUAVisualTransition === true
        })
        position = indexOfHistory() ?? position
        noteTrail(locationPath())
        onRoute(currentRoute())
        return
      }
      const nextPosition = indexOfHistory() ?? position - 1
      const delta = nextPosition - position
      // Restore the current entry before presenting a decision. Declining does
      // not push a duplicate entry or discard the browser's forward history.
      const decide = (): void => {
        held
          .check()
          .then(accepted => {
            if (!accepted || guard !== registeredGuard) return
            accepting = true
            const finish = (): void => {
              position = nextPosition
              showRoute(held.destination, true)
              held.onAccepted?.()
              noteHistoryMove({
                direction: delta < 0 ? 'back' : delta > 0 ? 'forward' : 'none',
                drawn: false
              })
              onRoute(held.destination)
            }
            if (delta !== 0) {
              window.addEventListener('popstate', finish, { once: true })
              window.history.go(delta)
            } else {
              accepting = false
              finish()
            }
          })
          .catch(() => undefined)
      }
      if (delta !== 0) {
        restoring = decide
        window.history.go(-delta)
      } else decide()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
    }
  }, [onRoute, beforeLeave])
}
