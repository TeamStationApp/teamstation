import { createHash } from 'node:crypto'

/**
 * The web page's Content-Security-Policy and Subresource Integrity, as pure
 * functions `build.mjs` calls (and `buildCsp.test.ts` checks).
 *
 * The page may run only its own script, load styles from itself and Google
 * Fonts, fonts from Google Fonts, pictures and video from itself, `blob:`
 * and `data:` URLs and the media origins the deployment names, and talk to
 * itself, its API, the API's socket and those media origins. Workers come
 * from itself or `blob:` (hls.js builds its transmuxer from a Blob). No
 * plugins and no `<base>`. Framing is refused by the reverse proxy's
 * response headers, because browsers ignore `frame-ancestors` in a
 * `<meta>` policy and log an error for it on every page.
 *
 * - `<api>` is the origin of the build's `TS_API_BASE_URL` when it is
 *   absolute (a relative one is the page's own origin, `'self'`).
 * - `<socket>` is that origin with `ws:` or `wss:`.
 * - `<media>` is `TS_MEDIA_ORIGINS`, space-separated, which a deployment
 *   takes from `src/deploy/mediaOrigins.mjs`.
 */

/** The origin of an absolute http(s) URL, or undefined for a relative one. */
export function originOf(url) {
  if (url == null || !/^https?:\/\//i.test(url)) return undefined
  return new URL(url).origin
}

/** `http://host` → `ws://host`, `https://host` → `wss://host`. */
export function socketOriginOf(origin) {
  return origin.replace(/^http/i, 'ws')
}

/** The origins a build allows, from its API URL and its media list. */
export function originsFor(apiBaseUrl, mediaOrigins = '') {
  const api = originOf(apiBaseUrl)
  return {
    api,
    socket: api == null ? undefined : socketOriginOf(api),
    media: mediaOrigins.split(/\s+/).filter(origin => origin !== '')
  }
}

/** The policy for these origins, as the `<meta>` carries it. */
export function cspFor(origins) {
  const media = origins.media ?? []
  const list = (...parts) =>
    [...new Set(parts.flat().filter(part => part != null && part !== ''))].join(
      ' '
    )
  return [
    "default-src 'self'",
    "script-src 'self'",
    `style-src ${list("'self'", "'unsafe-inline'", 'https://fonts.googleapis.com')}`,
    'font-src https://fonts.gstatic.com',
    `img-src ${list("'self'", 'data:', 'blob:', media)}`,
    `media-src ${list("'self'", 'blob:', media)}`,
    `connect-src ${list("'self'", origins.api, origins.socket, media)}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'"
  ].join('; ')
}

const escapeAttribute = text =>
  text.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

/**
 * The page with the policy in a `<meta http-equiv>` right after its
 * `<meta charset>`, before anything the policy governs.
 */
export function withCsp(html, policy) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}" />`
  const charset = /<meta charset="[^"]*"\s*\/?>/i.exec(html)
  if (charset == null) throw new Error('index.html has no <meta charset>')
  const at = charset.index + charset[0].length
  return `${html.slice(0, at)}\n    ${meta}${html.slice(at)}`
}

/** `sha384-<base64>` of some bytes, as an `integrity` attribute holds it. */
export function integrityOf(bytes) {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`
}

/**
 * The page with `integrity` on every `<script src>` it loads from itself.
 * `files` maps a script's `src` (`/app-ABC.js`) to its bytes; a script with
 * no entry is an error, since the browser would then run it unchecked.
 */
export function withIntegrity(html, files) {
  return html.replace(
    /<script src="([^"]+)"([^>]*)><\/script>/g,
    (tag, src, rest) => {
      if (/\sintegrity=/.test(rest)) return tag
      const bytes = files[src]
      if (bytes == null) throw new Error(`No bytes for the script ${src}`)
      return `<script src="${src}" integrity="${integrityOf(bytes)}"${rest}></script>`
    }
  )
}
