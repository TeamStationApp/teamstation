import { LinkifyIt } from 'linkify-it'
import tlds from 'tlds'

import { PRIMARY_HOST, WEB_HOST } from '../../common/primaryUrl'
import { routeOfUrl } from '../navigation/deepLink'
import { type Route, routePath } from '../navigation/routes'
import { CacheUrl } from '../sync/cacheUrl'
import { chatAppOrigin, openChatBrowser } from './chatBrowser'

const links = new LinkifyIt({
  fuzzyLink: true,
  fuzzyEmail: false,
  fuzzyIP: false,
  // Recognize the entire authority so credentials can be refused as a unit.
  urlAuth: true
}).tlds(tlds)

const filename = /\.(?:zip|mov|sh|md|pl|rs|py|ai|ps|so|ts|cc|cab)$/i
// Reject invisible formatting and control characters before a browser normalizes them.
const unsafeCharacters =
  // eslint-disable-next-line no-control-regex
  /[\\\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u
const scheme = /^[\s("'[{<]*([a-z][a-z\d+.-]*):/i

export interface ChatLinkSpan {
  start: number
  end: number
  text: string
}

/** Parse the visible address again at the point where it leaves the chat. */
export function chatLinkAddress(text: string): URL | undefined {
  if (text === '' || unsafeCharacters.test(text) || /\s/.test(text)) return
  const explicit = /^https?:\/\//i.test(text)
  if (!explicit && (!/^[^:/?#]+\.[^:/?#]+/.test(text) || text.includes('://')))
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
    const word = token[0]
    if (!word.includes('.') && !/https?:\/\//i.test(word)) continue
    if (word.length > 16000 || unsafeCharacters.test(word)) continue
    const protocol = scheme.exec(word)?.[1]
    // A bare host followed by a port also has the shape of a URI scheme.
    // Validate the host independently before asking the explicit URL grammar
    // to match its port and path.
    const portPrefix =
      protocol != null &&
      word.startsWith(protocol + ':') &&
      /^:\d+(?:[/?#]|$)/.test(word.slice(protocol.length)) &&
      links.match(protocol)?.[0]?.raw === protocol
        ? 'https://'
        : ''
    if (protocol != null && !/^https?$/i.test(protocol) && portPrefix === '')
      continue
    for (const hit of links.match(portPrefix + word) ?? []) {
      if (hit.schema !== '' && !/^https?:$/i.test(hit.schema)) continue
      const start = Math.max(0, hit.index - portPrefix.length)
      const end = hit.lastIndex - portPrefix.length
      const text = word.slice(start, end)
      if (
        hit.schema === '' &&
        !/^www\./i.test(hit.raw) &&
        filename.test(hit.raw)
      )
        continue
      if (chatLinkAddress(text) == null) continue
      spans.push({
        start: token.index + start,
        end: token.index + end,
        text
      })
    }
  }
  return spans
}

/** The router accepts old spellings as well as the canonical share links. */
function routeAddress(path: string): string {
  return path
    .replace(/\/+$/, '')
    .replace(/^\/(?:video-channels|c)\/invite\//, '/i/')
    .replace(/^\/signin-browser(?=\/|$)/, '/signin')
    .replace(/^\/signin$/, '/sign-in')
    .replace(/^\/account\/tv$/, '/tv-login')
}

/** An unknown suffix on a known route still belongs to the browser. */
export function chatLinkRoute(
  url: URL,
  activeOrigin: string | undefined,
  verifiedOrigin: string
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
    const route = routeOfUrl(url.href, { appOrigin: verifiedOrigin })
    if (route.name === 'signInLink' && url.origin !== verifiedOrigin)
      return { name: 'signIn' }
    const path = routeAddress(decodeURI(url.pathname))
    const canonical = routeAddress(decodeURI(routePath(route).split('?')[0]))
    if (canonical === path) return route
    // A build must not spend a token issued to a different link origin.
    if (/^\/signin\/[^/]+$/.test(path) && route.name === 'signIn') return route
    // Some supported addresses select a more specific route via their query
    // (e.g. /games/<id>?tab=score). Ignored trailing segments resolve exactly
    // like their parent; a complete alias resolves differently.
    const parent = path.slice(0, path.lastIndexOf('/'))
    const parentRoute = routeOfUrl(url.origin + parent + url.search, {
      appOrigin: verifiedOrigin
    })
    if (route.name !== 'home' && routePath(parentRoute) !== routePath(route))
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
  const verified = chatAppOrigin()
  const active = chatLinkAddress(apiBaseUrl)?.origin ?? verified
  const route = chatLinkRoute(url, active, verified)
  if (route != null) navigate(route)
  else await openChatBrowser(url.href)
}
