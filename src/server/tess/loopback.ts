import type { Request } from 'express'

import { bearerToken, cookieValue, SESSION_COOKIE } from '../auth/tokens'
import { TESS_HEADER } from '../middleware/withAuth'
import { type ApiMethod, checkApiRequest } from './denyList'

/**
 * Tess reaches the API the way the app does: a real HTTP request to this
 * server's own `/api/v1`, carrying the credentials of the person she is
 * answering. Every middleware runs on it — who is calling, each route's own
 * permission checks, the audit of writes — so she can read and change
 * exactly what they can, and nothing else. She holds no token of her own.
 * Each request carries `TESS_HEADER`, so a route for the person alone
 * refuses it as a machine's (`isMachine`), whether or not the deny list
 * caught it first.
 */

/** An answer longer than this reaches the model cut, with a note saying so. */
export const MAX_RESULT_CHARS = 60000

/** How long a loopback request may take. */
export const LOOPBACK_DEADLINE_MS = 30000

/** The person's own session, as their request to Tess carried it. */
export interface Credentials {
  /** `Bearer <token>`, from a phone or another client without cookies. */
  authorization?: string
  /** The session cookie alone, from the web app; never its other cookies. */
  cookie?: string
  /** Where they called from, so the API's limits and logs see them. */
  forwardedFor?: string
}

/** What the API answered: its status, and the body as text, maybe cut. */
export interface ApiAnswer {
  status: number
  body: string
  truncated: boolean
}

/** The credentials a request to Tess carried, as `withActor` read them. */
export function credentialsOf(req: Request): Credentials {
  const authorization = req.header('authorization')
  const ip = req.ip
  const forwardedFor = ip == null || ip === '' ? {} : { forwardedFor: ip }
  if (bearerToken(authorization) != null)
    return { authorization: authorization?.trim(), ...forwardedFor }
  const session = cookieValue(req.header('cookie'), SESSION_COOKIE)
  return session == null
    ? forwardedFor
    : {
        cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}`,
        ...forwardedFor
      }
}

/**
 * This server's own address, from where it listens. A wildcard listen host
 * is reached on the loopback address, and an IPv6 address is bracketed.
 */
export function loopbackOrigin(config: {
  listenHost: string
  listenPort: number
}): string {
  const host =
    config.listenHost === '' ||
    config.listenHost === '0.0.0.0' ||
    config.listenHost === '::' ||
    config.listenHost === '[::]'
      ? '127.0.0.1'
      : config.listenHost
  const bracketed =
    host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${bracketed}:${config.listenPort}`
}

export interface ApiCallOptions {
  fetch?: typeof fetch
  deadlineMs?: number
}

/**
 * One request to `origin` + `/api/v1` + `path`, with `query` added to
 * whatever query `path` carries. The deny list is checked again here, on the
 * path as the URL has normalized it, which is the path the server routes:
 * a refused one is answered 403 and never sent, whoever the caller is.
 * A refusal or a failure is an answer like any other: the status and its
 * body. Only an API that cannot be reached at all answers status 0. A
 * redirect is not followed: it is answered with its status and where it
 * points, since following it would fetch from outside the API.
 */
export async function apiCall(
  origin: string,
  credentials: Credentials,
  method: ApiMethod,
  path: string,
  query?: Record<string, unknown>,
  body?: unknown,
  options: ApiCallOptions = {}
): Promise<ApiAnswer> {
  const url = new URL(`/api/v1${path}`, origin)
  const refusal = refusalAt(method, url)
  if (refusal != null) return { status: 403, body: refusal, truncated: false }
  for (const [key, value] of Object.entries(query ?? {})) {
    for (const each of Array.isArray(value) ? value : [value]) {
      if (each == null) continue
      url.searchParams.append(
        key,
        typeof each === 'object' ? JSON.stringify(each) : String(each)
      )
    }
  }
  const headers: Record<string, string> = {
    accept: 'application/json',
    [TESS_HEADER]: '1'
  }
  if (credentials.authorization != null)
    headers.authorization = credentials.authorization
  if (credentials.cookie != null) headers.cookie = credentials.cookie
  if (credentials.forwardedFor != null)
    headers['x-forwarded-for'] = credentials.forwardedFor
  const sendsBody = method !== 'GET' && body !== undefined
  if (sendsBody) headers['content-type'] = 'application/json'
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, options.deadlineMs ?? LOOPBACK_DEADLINE_MS)
  try {
    const response = await (options.fetch ?? fetch)(url, {
      method,
      headers,
      signal: controller.signal,
      body: sendsBody ? JSON.stringify(body) : undefined,
      redirect: 'manual'
    })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      return {
        status: response.status,
        body: redirectNote(url, response.headers.get('location')),
        truncated: false
      }
    }
    return { status: response.status, ...cut(await response.text()) }
  } catch {
    return {
      status: 0,
      body: 'TeamStation did not answer that request',
      truncated: false
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Why the normalized `url` may not be sent, or null. It must still be under
 * `/api/v1`, and the path below it passes the deny list.
 */
function refusalAt(method: ApiMethod, url: URL): string | null {
  const { pathname } = url
  if (pathname !== '/api/v1' && !pathname.startsWith('/api/v1/'))
    return 'That path is not allowed'
  const checked = checkApiRequest(method, pathname)
  return typeof checked === 'string' ? checked : null
}

/**
 * Where a redirect points, for the model. An address on this server is
 * given whole; one elsewhere without its query, which can carry a signature.
 */
function redirectNote(from: URL, location: string | null): string {
  if (location == null || location === '') return 'Redirected, to nowhere'
  let target: URL
  try {
    target = new URL(location, from)
  } catch {
    return 'Redirected, to an address that cannot be read'
  }
  return target.origin === from.origin
    ? `Redirected to ${target.pathname}${target.search}, not followed`
    : `Redirected to ${target.origin}${target.pathname}, outside TeamStation, not followed`
}

/** A body cut to `MAX_RESULT_CHARS`, with a note when it was. */
function cut(text: string): { body: string; truncated: boolean } {
  if (text.length <= MAX_RESULT_CHARS) return { body: text, truncated: false }
  return {
    body: `${text.slice(0, MAX_RESULT_CHARS)}\n[Cut at ${MAX_RESULT_CHARS} of ${text.length} characters. Ask for less, with a narrower path or query.]`,
    truncated: true
  }
}
