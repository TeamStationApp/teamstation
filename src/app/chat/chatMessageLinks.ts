import { LinkifyIt, REBuilder } from 'linkify-it'
import tlds from 'tlds'

import { PRIMARY_HOST, WEB_HOST } from '../../common/primaryUrl'
import { routeOfUrl } from '../navigation/deepLink'
import { type Route, routePath } from '../navigation/routes'
import { CacheUrl } from '../sync/cacheUrl'
import { chatLinkOrigins, openChatBrowser } from './chatBrowser'

// Linkify excludes ports from its bare-domain grammar. Reuse the same port
// and boundary rules as explicit URLs, including for each link in a list.
class ChatLinkGrammar extends REBuilder {
  override get_fuzzy_url_host_port(): RegExp {
    const label = this.get_domain().source
    const tld = this.get_tld().source
    return new RegExp(
      `(?:(?:${label})\\.){1,10}(?:${tld})` +
        this.get_port().source +
        this.get_host_terminator().source
    )
  }
}

const links = new LinkifyIt({
  rebuilder: new ChatLinkGrammar(),
  fuzzyLink: true,
  fuzzyEmail: false,
  fuzzyIP: false,
  // Recognize the entire authority so credentials can be refused as a unit.
  urlAuth: true
}).tlds(tlds)

const filename =
  /\.(?:zip|mov|sh|md|pl|rs|py|ai|ps|so|ts|cc|cab|java|properties|pub)$/i
// Reject invisible formatting and control characters before a browser normalizes them.
const unsafeCharacters =
  // eslint-disable-next-line no-control-regex
  /[\\\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u
// Preserve offsets while hiding unsupported schemes, including their nested URLs.
// A data URL's first comma separates its metadata and payload.
const schemeCandidate =
  /(^|[("'“‘[{<,;])((?:data:[^,\s)\]}>"']*,|[a-z][a-z\d+.-]*:)[^\s,;)\]}>"'”’]*)/gi

export interface ChatLinkSpan {
  start: number
  end: number
  text: string
}

/** Parse the visible address again at the point where it leaves the chat. */
export function chatLinkAddress(text: string): URL | undefined {
  if (text === '' || unsafeCharacters.test(text) || /\s/.test(text)) return
  const explicit = /^https?:\/\//i.test(text)
  if (!explicit && !/^[^.:/?#]+\.[^:/?#]+(?::\d+)?(?:[/?#]|$)/.test(text))
    return
  const address = explicit ? text : 'https://' + text
  const authority = address
    .slice(address.indexOf('://') + 3)
    .split(/[/?#]/, 1)[0]
  if (authority === '' || authority.includes('@')) return
  try {
    const url = new CacheUrl(address)
    if (
      url.hostname !== '' &&
      (url.protocol === 'https:' || url.protocol === 'http:')
    )
      return url
  } catch {
    // A malformed destination remains ordinary message text.
  }
}

/** UTF-16 offsets into the unmodified body, suitable for both text and captions. */
export function chatLinkSpans(body: string): ChatLinkSpan[] {
  const spans: ChatLinkSpan[] = []
  for (const token of body.matchAll(/\S+/gu)) {
    const raw = token[0]
    if (!raw.includes('.') && !/https?:\/\//i.test(raw)) continue
    if (raw.length > 16000 || unsafeCharacters.test(raw)) continue
    const searchable = raw.replace(
      schemeCandidate,
      (match: string, boundary: string, candidate: string) =>
        /^https?:/i.test(candidate) || /^[^.:]+\.[^:]+:\d/.test(candidate)
          ? match
          : boundary + ' '.repeat(candidate.length)
    )
    for (const hit of links.match(searchable) ?? []) {
      if (hit.schema !== '' && !/^https?:$/i.test(hit.schema)) continue
      const text = hit.raw
      if (
        hit.schema === '' &&
        !/^www\./i.test(hit.raw) &&
        filename.test(hit.raw)
      )
        continue
      if (chatLinkAddress(text) == null) continue
      spans.push({
        start: token.index + hit.index,
        end: token.index + hit.lastIndex,
        text
      })
    }
  }
  return spans
}

/** Normalize only equivalent paths. Escaped separators stay inside their segment. */
function normalizedPath(path: string): string {
  const normalized = path
    .replace(/\/+$/, '')
    .replace(/%[\da-f]{2}/gi, escape => {
      const character = String.fromCharCode(parseInt(escape.slice(1), 16))
      return /^[a-z\d._~-]$/i.test(character) ? character : escape.toUpperCase()
    })
  return normalized === '' ? '/' : normalized
}

/** Canonical share paths and the complete older spellings the router still reads. */
function matchesRoute(path: string, route: Route): boolean {
  const canonical = normalizedPath(routePath(route).split('?')[0])
  if (canonical === path) return true
  switch (route.name) {
    case 'join':
      return (
        path.replace(/^\/(?:video-channels|c)\/invite\//, '/i/') === canonical
      )
    case 'signInLink':
      return path.replace(/^\/signin-browser\//, '/signin/') === canonical
    case 'signIn':
      return /^\/signin(?:-browser)?(?:\/[^/]+)?$/.test(path)
    case 'teamStationTv':
      return path === '/account/tv' || path === '/tv-login'
    case 'scoreOptions':
      return path === '/games/' + route.gameId
    case 'groupSettings':
      return path === '/' + route.kind + 's/' + route.id + '/manage'
    // parseRoute already validated the legacy numeric account IDs in these aliases.
    case 'adminAccount':
      return /^\/node\/users\/[1-9]\d*\/account$/.test(path)
    case 'player':
      return /^\/players\/[1-9]\d*$/.test(path)
    case 'person':
      return /^\/(?:leagues|seasons|teams)\/[^/]+\/people\/[1-9]\d*$/.test(path)
    default:
      return false
  }
}

/** An unknown suffix on a known route still belongs to the browser. */
export function chatLinkRoute(
  url: URL,
  activeOrigin: string | undefined,
  verifiedOrigin: string | undefined
): Route | undefined {
  if (
    url.origin !== activeOrigin &&
    url.origin !== verifiedOrigin &&
    ![PRIMARY_HOST, WEB_HOST, 'teamstation.app'].some(
      host => url.origin === 'https://' + host
    )
  )
    return
  try {
    // Some routes retain their ID verbatim. Validate every path's escapes first.
    decodeURI(url.pathname)
    const path = normalizedPath(url.pathname)
    const route = routeOfUrl(url.origin + path + url.search, {
      appOrigin: verifiedOrigin
    })
    if (!matchesRoute(path, route)) return
    if (url.origin !== verifiedOrigin) {
      if (route.name === 'signInLink') return { name: 'signIn' }
      if (route.name === 'teamStationTv') return { name: 'teamStationTv' }
    }
    return route
  } catch {
    // Invalid escaped route components must not interrupt the conversation.
  }
}

/** Open immediately on the user gesture so browsers permit the new tab. */
export async function openChatMessageLink(
  text: string,
  apiBaseUrl: string,
  navigate: (route: Route) => void
): Promise<void> {
  const url = chatLinkAddress(text)
  if (url == null) return
  const { active, verified } = chatLinkOrigins(apiBaseUrl)
  const route = chatLinkRoute(url, active, verified)
  if (route != null) navigate(route)
  else await openChatBrowser(url.href)
}
