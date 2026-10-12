import { useEffect } from 'react'
import { BackHandler, Linking, Platform } from 'react-native'

import { appOrigin } from '../native/config'
import { routeOfUrl } from './deepLink'
import { makeHistory } from './history'
import { type Route, routePath } from './routes'

/**
 * Keeps the app's idea of where it is, and a history to go back through.
 *
 * The web twin of this file hands both jobs to the browser: `pushState` writes
 * the address, and the Back button walks the stack the browser keeps. A phone
 * has neither, so the same two things are kept here — a current route and the
 * steps that led to it — and Android's system Back walks them.
 *
 * Deliberately the same shape as the web file rather than a navigator. The
 * shell in `App.tsx` already owns a stack per tab; a second stack inside a
 * navigator would be a second answer to the question of where you are, and
 * the two would disagree the first time anything got out of step.
 *
 * `routes.ts` does the parsing for both, so a link works the same on a page
 * and on a handset.
 */

/**
 * Everywhere the app has been this launch.
 *
 * The rules it walks by — a move pushes, a correction replaces, the same
 * address twice is one step — are a browser's, and they are in `history.ts`
 * where they can be tested. They went wrong twice while this was being built
 * and both times the symptom was a Back button that appeared to do nothing.
 */
const history = makeHistory()

/**
 * The address the app was opened on, before anything renders.
 *
 * `App.tsx` reads `currentRoute()` inside `useState` initialisers, which run
 * once and cannot wait for anything; `Linking.getInitialURL()` is a promise.
 * So the promise is settled first — by `app/native/index.tsx`, before it
 * mounts the app at all — and what it found is put here.
 */
export function seedRoute(url: string | null | undefined): void {
  history.seed(url == null ? { name: 'home' } : routeOfUrl(url, { appOrigin }))
}

/** Where the app currently is. */
export function currentRoute(): Route {
  return history.current()
}

/**
 * Records where the app has moved to.
 *
 * `replace` corrects the step already there rather than adding one, exactly as
 * it does in a browser: landing on `/` and resolving it, or moving the
 * playhead, must not leave something for Back to walk into.
 */
export function showRoute(route: Route, replace = false): void {
  history.show(route, replace)
}

/**
 * A step back, taken by something other than the system Back button.
 *
 * The chevron in the header pops the shell's own stack, and if the history
 * did not follow, the two would drift apart: pushing a team and then tapping
 * the chevron would leave a step behind, so the next press of Android's Back
 * would walk to a route the app is already on and appear to do nothing — and
 * the press after that would close the app.
 */
export function popRoute(): void {
  history.back()
}

export function scoringOriginHistory(): number {
  return history.depth()
}
export function backFromScoringPlayer(origin?: number): boolean {
  const steps = origin == null ? 1 : Math.max(1, history.depth() - origin)
  for (let index = 0; index < steps; index++) history.back()
  return true
}

/**
 * Calls back when the reader goes back, or follows a link into the app.
 *
 * Two sources, one callback, because to the shell they are the same event: the
 * address it is on has changed and it should render what the new one says.
 *
 * Android's Back is answered `false` at the bottom of the history, which is
 * what closes the app — the alternative is a Back button that does nothing on
 * the home screen, which reads as a hang. iOS has no system Back; the chevron
 * in the header is it.
 */
export function useBrowserBack(
  onRoute: (route: Route, onHandled?: (accepted: boolean) => void) => void
): void {
  useEffect(() => {
    let pending = false
    const deliver = (route: Route, restore: () => void): void => {
      pending = true
      const handled = (accepted: boolean): void => {
        if (!accepted && routePath(history.current()) === routePath(route))
          restore()
        pending = false
      }
      try {
        onRoute(route, handled)
      } catch {
        handled(false)
      }
    }
    const opened = (event: { url: string }): void => {
      if (pending) return
      const route = routeOfUrl(event.url, { appOrigin })
      const previous = history.current()
      const depth = history.depth()
      history.show(route)
      deliver(route, () => {
        if (history.depth() > depth) history.back()
        else history.show(previous, true)
      })
    }
    const link = Linking.addEventListener('url', opened)

    if (Platform.OS !== 'android') {
      return () => {
        link.remove()
      }
    }
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (pending) return true
      // `false` closes the app, which is what should happen at the bottom of
      // the history: a Back button that does nothing on the home screen reads
      // as a hang.
      const previous = history.current()
      if (!history.back()) return false
      deliver(history.current(), () => {
        history.show(previous)
      })
      return true
    })
    return () => {
      link.remove()
      back.remove()
    }
  }, [onRoute])
}
