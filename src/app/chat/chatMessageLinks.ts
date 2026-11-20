import { LinkifyIt, REBuilder } from 'linkify-it'
import tlds from 'tlds'

import { MAX_BODY } from '../../common/chatContent'
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

// Chat accepts 8,000 code points. One astral character occupies two UTF-16 units.
const maxTokenLength = MAX_BODY * 2
const links = new LinkifyIt({
  maxLength: maxTokenLength,
  rebuilder: new ChatLinkGrammar(),
  fuzzyLink: true,
  fuzzyEmail: false,
  fuzzyIP: false,
  // Recognize the entire authority so credentials can be refused as a unit.
  urlAuth: true
}).tlds(tlds)

const filename =
  /^[^/?#:@]+\.(?:zip|mov|sh|md|pl|rs|py|ai|ps|so|ts|cc|cab|java|properties|pub|mobi)$/i
const unsafeCharacters =
  /[\\\p{Cc}\p{Cs}\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u
// Host normalization can discard these characters. Emoji variation selectors
// in a path or query remain part of the visible destination.
const unsafeAuthority = /[%@\p{Default_Ignorable_Code_Point}]/u
// A data URL's payload can contain commas, other URLs and closing punctuation.
// Its end without a whitespace boundary is ambiguous, so keep that tail plain.
const schemeCandidate =
  /(^|[^\p{L}\p{N}.+-])(data:\S*|[a-z][a-z\d+.-]*:(?:\/\/\[[^\]\s]*\])?[^\s,;，；、)\]}>"'”’]*)/giu

function authorityOf(address: string): string {
  return address.replace(/^https?:\/\//i, '').split(/[/?#]/, 1)[0]
}

/** Refuse an explicit address when link recognition stopped inside its authority. */
function completeAuthority(address: string): boolean {
  const authority = authorityOf(address)
  if (authority === '' || unsafeAuthority.test(authority)) return false
  const hit = links.matchAtStart(address)
  if (hit == null) return false
  const recognized = authorityOf(hit.raw)
  if (authority === recognized) return true
  // Sentence punctuation can follow a standalone host without belonging to it.
  return (
    address.endsWith(authority) &&
    authority.startsWith(recognized) &&
    /^[.!:…]+$/u.test(authority.slice(recognized.length))
  )
}

export interface ChatLinkSpan {
  start: number
  end: number
  text: string
}

/** Parse the visible address again at the point where it leaves the chat. */
export function chatLinkAddress(text: string): URL | undefined {
  if (
    text === '' ||
    text.length > maxTokenLength ||
    unsafeCharacters.test(text) ||
    /\s/.test(text)
  )
    return
  const explicit = /^https?:\/\//i.test(text)
  if (!explicit && !/^[^.:/?#]+\.[^:/?#]+(?::\d+)?(?:[/?#]|$)/.test(text))
    return
  const address = explicit ? text : 'https://' + text
  const authority = authorityOf(address)
  if (authority === '' || unsafeAuthority.test(authority)) return
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
  for (const token of body.matchAll(/(?:\S|\uFEFF)+/gu)) {
    const raw = token[0]
    if (!raw.includes('.') && !/https?:\/\//i.test(raw)) continue
    if (raw.length > maxTokenLength || unsafeCharacters.test(raw)) continue
    const original = links.match(raw) ?? []
    let index = 0
    const searchable = raw.replace(
      schemeCandidate,
      (match: string, boundary: string, candidate: string, offset: number) => {
        if (
          (/^https?:\/\//i.test(candidate) && completeAuthority(candidate)) ||
          /^[^.:]+\.[^:]+:\d/.test(candidate)
        )
          return match
        const start = offset + boundary.length
        while (index < original.length && original[index].lastIndex <= start)
          index++
        const outer = original[index]
        // A nested scheme can be ordinary data in a recognized web URL.
        if (
          outer != null &&
          outer.index < start &&
          (outer.schema === '' || /^https?:$/i.test(outer.schema))
        )
          return match
        return boundary + ' '.repeat(candidate.length)
      }
    )
    const candidates =
      searchable === raw ? original : (links.match(searchable) ?? [])
    for (const hit of candidates) {
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
