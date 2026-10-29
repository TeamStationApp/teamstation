import type { Request } from 'express'

import { TESS_HEADER } from '../middleware/withAuth'
import { credentialsOf } from '../tess/loopback'

/**
 * How GraphQL reads: a `GET` of the REST route that serves a field, sent back
 * to this same server as the caller, so every field is what that route would
 * give them — its own access checks, its non-member view, its short names,
 * and the ceiling of an API key. GraphQL decides nothing about access itself.
 */

/** Reads one query may make, so a query cannot fan out without end. */
export const MAX_READS = 100

/** Reads one query has in flight at once. */
export const MAX_CONCURRENT_READS = 8

/** How long one read may take. */
const READ_DEADLINE_MS = 30000

/** A refusal or failure from the REST route behind a field. */
export class RestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface RestReader {
  /** The route's JSON, or a `RestError` with its status and message. */
  get: (
    path: string,
    query?: Record<string, string | undefined>
  ) => Promise<unknown>
}

/** Headers that make a read the caller's own: their credentials, and Tess's mark. */
export function readerHeaders(req: Request): Record<string, string> {
  const credentials = credentialsOf(req)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (credentials.authorization != null)
    headers.authorization = credentials.authorization
  if (credentials.cookie != null) headers.cookie = credentials.cookie
  if (credentials.forwardedFor != null)
    headers['x-forwarded-for'] = credentials.forwardedFor
  // Only when the GraphQL request had it: Tess's reads stay Tess's, and the
  // person's own stay theirs.
  if (req.header(TESS_HEADER) != null) headers[TESS_HEADER] = '1'
  return headers
}

/**
 * A reader for one query: each path read once, at most `MAX_READS` paths.
 */
export interface RestReaderOptions {
  fetch?: typeof fetch
  /** How long one read may take. */
  deadlineMs?: number
  /**
   * Ends the whole query: its reads in flight are given up and those not yet
   * started are not sent. The route aborts it at the query's deadline, and
   * when the caller hangs up.
   */
  signal?: AbortSignal
}

export function restReader(
  origin: string,
  headers: Record<string, string>,
  options: RestReaderOptions = {}
): RestReader {
  const fetcher = options.fetch ?? fetch
  const deadlineMs = options.deadlineMs ?? READ_DEADLINE_MS
  const ending = options.signal
  const ended = (): RestError =>
    new RestError(504, 'The query ran out of time, or its caller left')
  const reads = new Map<string, Promise<unknown>>()
  // A small pool: a query's reads run a few at a time, not all at once.
  let running = 0
  const waiting: Array<() => void> = []
  const pooled = async <T>(work: () => Promise<T>): Promise<T> => {
    // A read that waits is handed its slot by the one that finishes, so
    // no read started meanwhile can take it.
    if (running >= MAX_CONCURRENT_READS)
      await new Promise<void>(resolve => {
        waiting.push(resolve)
      })
    else running++
    try {
      if (ending?.aborted === true) throw ended()
      return await work()
    } finally {
      const next = waiting.shift()
      if (next == null) running--
      else next()
    }
  }
  /** A read, its answer and its body together, within the deadline. */
  const read = async (url: URL, redirects: number): Promise<unknown> => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const late = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        controller.abort()
        reject(ended())
      }
      ending?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => {
        controller.abort()
        reject(
          new RestError(504, 'TeamStation took too long to answer that read')
        )
      }, deadlineMs)
    })
    try {
      return await Promise.race([
        readAt(url, redirects, controller.signal),
        late
      ])
    } finally {
      clearTimeout(timer)
      if (onAbort != null) ending?.removeEventListener('abort', onAbort)
    }
  }
  const readAt = async (
    url: URL,
    redirects: number,
    signal: AbortSignal
  ): Promise<unknown> => {
    let response: Response
    try {
      response = await fetcher(url, {
        headers,
        redirect: 'manual',
        signal
      })
    } catch {
      throw new RestError(502, 'TeamStation did not answer that read')
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      // A merged player's id answers with their open row: read it there,
      // once, and only on this server's own API.
      const location = response.headers.get('location')
      const next = location == null ? undefined : new URL(location, url)
      if (
        redirects > 0 ||
        next?.origin !== url.origin ||
        !next.pathname.startsWith('/api/v1/')
      )
        throw new RestError(response.status, 'That read was redirected')
      return await read(next, redirects + 1)
    }
    const text = await response.text()
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        const body = JSON.parse(text) as { message?: unknown }
        if (typeof body.message === 'string') message = body.message
      } catch {}
      throw new RestError(response.status, message)
    }
    return text === '' ? null : (JSON.parse(text) as unknown)
  }
  return {
    get: async (path, query = {}) => {
      const url = new URL(`/api/v1${path}`, origin)
      for (const [key, value] of Object.entries(query))
        if (value != null) url.searchParams.set(key, value)
      const key = `${url.pathname}${url.search}`
      if (ending?.aborted === true) throw ended()
      const held = reads.get(key)
      if (held != null) return await held
      if (reads.size >= MAX_READS)
        throw new RestError(
          400,
          `This query reads more than ${MAX_READS} routes. Ask for less`
        )
      const pending = pooled(async () => await read(url, 0))
      reads.set(key, pending)
      return await pending
    }
  }
}
