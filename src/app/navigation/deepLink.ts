import { parseRoute, type Route } from './routes'

/**
 * A whole URL to a route, whichever kind of URL it is.
 *
 * Three forms reach an installed app and all three mean the same place:
 * `https://app.teamstation.app/games/g1?t=30`, which is what people paste to each
 * other and what the sign-in mail carries; `teamstation://games/g1?t=30`, the
 * app's own scheme; and occasionally a bare path.
 *
 * Split by hand, and deliberately not with `URL`. React Native's `URL` is a
 * set of regular expressions over `https?://` and nothing else: handed
 * `teamstation://games/g1` it returns an empty `host`, an empty `pathname` and
 * an empty `search`, so every deep link through the app's own scheme would
 * arrive as the home screen with no error anywhere to say why. Four lines of
 * string handling cannot be wrong in that way.
 *
 * The scheme form has no authority between the slashes, so its first segment
 * is a path segment and not a host — `teamstation://games/g1` and
 * `https://app.teamstation.app/games/g1` both have to come out as `/games/g1`.
 */
export function routeOfUrl(url: string): Route {
  const [address, search = ''] = stripFragment(url).split('?')

  const scheme = address.indexOf('://')
  let path = address
  if (scheme >= 0) {
    const rest = address.slice(scheme + 3)
    const slash = rest.indexOf('/')
    // Lowercased, because Android's `Intent.getDataString()` does not always
    // normalise and `HTTPS://Teamstation.co/games/g1` would otherwise fall
    // into the wrong branch and resolve to the home screen.
    const protocol = address.slice(0, scheme).toLowerCase()
    path =
      protocol === 'https' || protocol === 'http'
        ? // An http address' first segment is the host, and belongs to nobody.
          slash < 0
          ? '/'
          : rest.slice(slash)
        : // Any other scheme has no authority, so the whole of it is the path.
          `/${rest}`
  }

  return parseRoute(path.startsWith('/') ? path : `/${path}`, search)
}

/** The part after `#` addresses nothing this app knows about. */
function stripFragment(url: string): string {
  const hash = url.indexOf('#')
  return hash < 0 ? url : url.slice(0, hash)
}
