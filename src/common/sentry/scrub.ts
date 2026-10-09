import type { Breadcrumb, DataCollection, Event } from '@sentry/core'

/**
 * What a Sentry event may not carry, applied in every SDK's `beforeSend` and
 * `beforeBreadcrumb`.
 *
 * These rules are the only scrub: the Sentry server's own is turned off, because
 * its card-number pattern hides 16-digit account ids. Nothing that signs a person
 * in leaves the device or the server: no session
 * token, password hash, email sign-in code or link, invite code, OAuth approval
 * handle, stream key, media signature, CSRF token, cookie or `Authorization`
 * header, and no email
 * address. A request keeps its method and path; its body, cookies, query
 * string and every secret-named header go.
 * Console lines go entirely, because the server logs sign-in codes and email
 * addresses when it has no mail to send them with.
 */

export const FILTERED = '[Filtered]'

/**
 * Names that may hold a secret. A bare `code` and anything `session` stay in,
 * though they also name harmless things, because the sign-in code and the
 * session token travel under exactly those names.
 */
const SECRET_KEY =
  /token|secret|passw|clienthash|code|cookie|authorization|bearer|session|credential|csrf|api[-_]?key|private[-_]?key|stream[-_]?key|dsn|email/i

/** Names that contain a secret's word but hold none: status and error codes. */
const SAFE_KEY = /^(http\.(response\.)?)?status_?code$|^(error|exit)_?code$/i

/** Whether a key or header of this name is filtered whatever it holds. */
export function isSecretKey(name: string): boolean {
  return SECRET_KEY.test(name) && !SAFE_KEY.test(name)
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/** A URL, or any text containing URLs, with the secrets in it filtered. */
export function scrubText(text: string): string {
  return (
    text
      .replace(/(rtmps?:\/\/[^\s/]+(?:\/[^\s/]+)*)\/[^\s/]+/g, `$1/${FILTERED}`)
      // A query follows a URL or path character and starts with a word character,
      // so `a?.b()` and `'?'` in an error message are left alone.
      .replace(/([\w/.%-])\?[\w%-][^\s#'"()]*/g, '$1')
      .replace(/\/signin\/[^\s/?#]+/g, `/signin/${FILTERED}`)
      .replace(
        /\/(i|join|invite|approvals|native-approval)\/[^\s/?#]+/g,
        `/$1/${FILTERED}`
      )
      .replace(/\/media\/[^\s/?#]+\/[^\s/?#]+\//g, `/media/${FILTERED}/`)
      .replace(EMAIL, '[email]')
  )
}

/** A copy of any JSON-like value with secret-named keys and URLs filtered. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value)
  if (value == null || typeof value !== 'object') return value
  if (depth > 8) return FILTERED
  if (Array.isArray(value))
    return value.map(item => scrubValue(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? FILTERED : scrubValue(item, depth + 1)
  }
  return out
}

function scrubHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (headers == null) return undefined
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!isSecretKey(name)) out[name] = scrubText(value)
  }
  return out
}

/** The event as it may be sent. */
export function scrubEvent<T extends Event>(event: T): T {
  if (event.message != null) event.message = scrubText(event.message)
  // A server names its transaction after the raw request path.
  if (event.transaction != null)
    event.transaction = scrubText(event.transaction)
  for (const exception of event.exception?.values ?? []) {
    if (exception.value != null) exception.value = scrubText(exception.value)
  }
  if (event.request != null) {
    const { method, url, headers } = event.request
    event.request = {
      method,
      url: url == null ? undefined : scrubText(url),
      headers: scrubHeaders(headers)
    }
  }
  // The machine's own name says nothing about the failure.
  if (event.server_name != null) event.server_name = undefined
  if (event.user != null)
    event.user = event.user.id == null ? undefined : { id: event.user.id }
  if (event.extra != null)
    event.extra = scrubValue(event.extra) as Event['extra']
  if (event.contexts != null)
    event.contexts = scrubValue(event.contexts) as Event['contexts']
  if (event.breadcrumbs != null) {
    event.breadcrumbs = event.breadcrumbs
      .map(scrubBreadcrumb)
      .filter((crumb): crumb is Breadcrumb => crumb != null)
  }
  return event
}

/** The breadcrumb as it may be kept, or `null` to drop it. */
export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  if (crumb.category === 'console') return null
  const out: Breadcrumb = { ...crumb }
  if (out.message != null) out.message = scrubText(out.message)
  if (out.data != null) out.data = scrubValue(out.data) as Breadcrumb['data']
  return out
}

/**
 * What the SDKs may collect on their own, before the scrub sees it: no user
 * fields, cookies, bodies, query strings, database queries or local
 * variables. The scrub stays the last word; this keeps most of it from being
 * gathered at all.
 */
export const DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpBodies: [],
  urlQueryParams: false,
  databaseQueryData: false,
  stackFrameVariables: false
} satisfies DataCollection
