import type { Request } from 'express'

import { bearerToken, cookieValue, SESSION_COOKIE } from '../auth/tokens'
import type { ApiMethod } from './denyList'

/**
 * Tess reaches the API the way the app does: a real HTTP request to this
 * server's own `/api/v1`, carrying the credentials of the person she is
 * answering. Every middleware runs on it — who is calling, each route's own
 * permission checks, the audit of writes — so she can read and change
 * exactly what they can, and nothing else. She holds no token of her own.
 */

/** A request Tess sends says so, and her own routes refuse one that does. */
export const TESS_HEADER = 'x-teamstation-tess'

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
 * One request to `origin` + `/api/v1` + `path` (`path` already checked by
 * the deny list), with `query` added to whatever query `path` carries.
 * A refusal or a failure is an answer like any other: the status and its
 * body. Only an API that cannot be reached at all answers status 0.
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
      body: sendsBody ? JSON.stringify(body) : undefined
    })
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

/** A body cut to `MAX_RESULT_CHARS`, with a note when it was. */
function cut(text: string): { body: string; truncated: boolean } {
  if (text.length <= MAX_RESULT_CHARS) return { body: text, truncated: false }
  return {
    body: `${text.slice(0, MAX_RESULT_CHARS)}\n[Cut at ${MAX_RESULT_CHARS} of ${text.length} characters. Ask for less, with a narrower path or query.]`,
    truncated: true
  }
}
