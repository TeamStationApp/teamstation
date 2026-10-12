import { useEffect } from 'react'

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
    window.history.replaceState({ tsRouteIndex: position }, '')
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
  return parseRoute(window.location.pathname, window.location.search)
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
  if (path === window.location.pathname + window.location.search) return
  if (replace) window.history.replaceState({ tsRouteIndex: position }, '', path)
  else window.history.pushState({ tsRouteIndex: ++position }, '', path)
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
export function useBrowserBack(onRoute: (route: Route) => void): void {
  useEffect(() => {
    if (typeof window === 'undefined') return
    initializeHistory()
    let restoring: (() => void) | undefined
    let accepting = false
    const onPop = (): void => {
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
      const held = guard
      if (held == null || held.allow?.(currentRoute()) === true) {
        position = indexOfHistory() ?? position
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
            if (!accepted || guard !== held) return
            accepting = true
            const finish = (): void => {
              position = nextPosition
              showRoute(held.destination, true)
              held.onAccepted?.()
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
  }, [onRoute])
}
