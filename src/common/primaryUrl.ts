/**
 * The site's name, and the URLs built from it.
 *
 * `PRIMARY_HOST` is the only place the address is written down. Everything
 * that needs to know where TeamStation answers — this server, the web app,
 * the Director app, the stream URL an operator pastes into a camera — starts
 * here, and a deployment that is not production says so once, in its own
 * `serverConfig.json`, rather than by editing a committed file.
 *
 * It used to be a URL in a committed `config.json`, and before that a literal
 * in the iOS app, a field saved on every iPad, and a line in each deployment's
 * config. When the site moved from `tube2.gamestation.co` to `gamestation.co`, and
 * then to `app.teamstation.app`,
 * the copies did not, and a Director spent a day asking PeerTube for its
 * games. One committed file was better than five, but it still meant a branch
 * that wanted a development server had to change a tracked file and then
 * remember not to land it.
 *
 * **A host, not a URL.** No scheme is written anywhere: `https` is implied,
 * and the one exception is the one people actually hit — an IP address or
 * `localhost`, which has no certificate anybody would accept, so those imply
 * `http`. RTMP is always `rtmp://`, because there is no encrypted RTMP here to
 * choose between.
 *
 * In `common/` because all three sides import it and it reads nothing: it is a
 * shared fact, not a file.
 */
export const PRIMARY_HOST = 'app.teamstation.app'

/**
 * An address as it is written down: a host, optionally with a port, and
 * nothing else. `app.teamstation.app`, `127.0.0.1:9100`, `[::1]:9100`.
 */
export type Authority = string

/**
 * The bare authority in whatever somebody wrote.
 *
 * Tolerant on the way in because the override is typed by hand into a JSON
 * file, and `https://develop2.teamstation.app/` is what a person pastes when
 * asked for an address. A scheme, a path, a query and a trailing slash are all
 * dropped rather than refused — refusing would mean a deployment that boots
 * and then serves links to nowhere.
 */
export function asAuthority(written: string): Authority {
  return written
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[/?#].*$/, '')
}

/** Just the host: the port, where there is one, taken off. */
export function hostOf(authority: Authority): string {
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']')
    return close === -1 ? authority : authority.slice(0, close + 1)
  }
  const colon = authority.indexOf(':')
  return colon === -1 ? authority : authority.slice(0, colon)
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * Whether this address implies `http` rather than `https`.
 *
 * An IP address and `localhost` are the two things nobody can get a
 * certificate for, and they are exactly the two things a local test server is
 * reached by. Everything else is a DNS name with TLS in front of it.
 */
export function isPlainHttp(authority: Authority): boolean {
  const host = hostOf(authority)
  if (host.startsWith('[')) return true // a literal IPv6 address
  return host === 'localhost' || IPV4.test(host)
}

/** `https://host[:port]`, or `http://` for an IP address or `localhost`. */
export function httpOrigin(authority: Authority): string {
  return `${isPlainHttp(authority) ? 'http' : 'https'}://${authority}`
}

/**
 * `rtmp://host:port`, with no trailing slash and no path.
 *
 * The host only: an authority carrying a port carries the *web* port, and the
 * ingest listens somewhere else entirely.
 */
export function rtmpOrigin(authority: Authority, port: number): string {
  return `rtmp://${hostOf(authority)}:${port}`
}
