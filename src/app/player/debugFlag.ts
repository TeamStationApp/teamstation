/**
 * `?debug=1`: the player draws what each tile is doing.
 *
 * Remembered for the tab, not read off the address when the grid opens. The
 * app rewrites the address as it navigates and as the moment moves, and a
 * game route has no place for the flag, so by the time somebody taps Watch
 * the `debug=1` they typed is gone. `?debug=1` on any address turns it on
 * until the tab closes; `?debug=0` turns it off.
 */
const KEY = 'teamstation.playerDebug'

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** Applies this address's `debug` to the tab, and says whether it is on. */
export function rememberDebug(search: string, store: Store | null): boolean {
  const asked = new URLSearchParams(search).get('debug')
  try {
    if (asked === '1') store?.setItem(KEY, '1')
    if (asked === '0') store?.removeItem(KEY)
    return store?.getItem(KEY) === '1' || asked === '1'
  } catch {
    // Storage refused (a private window, blocked site data): the address
    // still counts for this page.
    return asked === '1'
  }
}

/** The tab's own storage, or nothing where there is none or it is refused. */
export function tabStore(): Store | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/**
 * Read once when the bundle loads, before the app's first navigation rewrites
 * the address: the page's own address is the one somebody typed.
 */
const atLoad =
  typeof location === 'undefined'
    ? false
    : rememberDebug(location.search, tabStore())

/** Whether the readout is on for this tab. */
export function playerDebug(): boolean {
  return typeof location === 'undefined'
    ? atLoad
    : rememberDebug(location.search, tabStore()) || atLoad
}
