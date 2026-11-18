import type { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'

import {
  ClientClosedError,
  ClientOfflineError,
  ConnectionTimeoutError,
  DisconnectsClientError,
  SocketClosedUnexpectedlyError,
  SocketTimeoutError
} from 'redis'

export const VALKEY_PING_INTERVAL_MS = 60_000
export const VALKEY_COMMAND_TIMEOUT_MS = 500
/** How much longer than a keepalive a connection may hear and send nothing. */
export const VALKEY_SILENCE_GRACE_MS = 5000

export interface ValkeyClientOptions {
  name?: string
  pingInterval?: number
  /** Overrides `VALKEY_SILENCE_GRACE_MS`. */
  silenceGraceMs?: number
}

/** Application PING also works on node-redis's subscribed RESP2 connection. */
export function valkeyClientOptions(
  url: string,
  role: string,
  caFile = '',
  options: ValkeyClientOptions = {}
): {
  url: string
  name: string
  pingInterval: number
  socket?: { tls: true; ca: string }
  disableOfflineQueue: true
} {
  return {
    url,
    name: options.name ?? valkeyClientName(role),
    pingInterval: options.pingInterval ?? VALKEY_PING_INTERVAL_MS,
    socket: redisSocketOptions(caFile),
    disableOfflineQueue: true
  }
}

export type SilenceWatched = ValkeyConnection & {
  readonly options?: { pingInterval?: number }
  emit: (event: 'error', error: Error) => boolean
  destroy: () => void
  connect: () => Promise<unknown>
}

const silenceWatched = new WeakSet<SilenceWatched>()
/** Clients closeValkey has begun to close, which nothing may open again. */
const closing = new WeakSet<object>()

/**
 * Silence is judged by what is heard. A keepalive PING that goes unanswered
 * stops further PINGs, and commands written to a peer that drops packets keep
 * the socket's own idle timer from firing, so a ready connection whose
 * keepalive has not answered for a keepalive and the grace is destroyed and
 * connected again. node-redis keeps its subscriptions' listeners through
 * destroy() and subscribes them again on connect().
 */
export function reconnectWhenSilent(
  client: SilenceWatched,
  graceMs = VALKEY_SILENCE_GRACE_MS
): void {
  const interval = client.options?.pingInterval ?? 0
  if (interval <= 0 || silenceWatched.has(client)) return
  silenceWatched.add(client)
  // Cleared when the client ends, so it never holds a process open.
  let timer: ReturnType<typeof setTimeout> | undefined
  let restarting = false
  const heard = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      // A client being closed may still look ready, but is not ours to open.
      if (!client.isReady || !client.isOpen || closing.has(client)) return
      restarting = true
      client.destroy()
      restarting = false
      // Open again before saying so, so a waiter told of it sees a reconnect.
      client.connect().catch(() => undefined)
      client.emit('error', new ValkeyTimeout('answer its keepalive'))
    }, interval + graceMs)
  }
  client.on('ready', () => {
    // Opened again by its owner after a close.
    closing.delete(client)
    heard()
  })
  client.on('ping-interval', heard)
  client.on('end', () => {
    if (!restarting) clearTimeout(timer)
  })
}

export function valkeyClientName(role: string): string {
  return `${role.replace(/subscriber/g, 'sub').replace(/\s+/g, '-')}-${process.pid}`
}

/** A private authority, when the URL's TLS needs one. */
export function redisSocketOptions(
  caFile: string
): { tls: true; ca: string } | undefined {
  if (caFile === '') return undefined
  try {
    return { tls: true, ca: readFileSync(caFile, 'utf8') }
  } catch (error) {
    throw new Error(
      `redis.caFile ${caFile} cannot be read: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/** Says whether the message went out. */
export function onceAMinute(
  log: (message: string) => void,
  now: () => number = Date.now
): (message: string) => boolean {
  let loggedAt: number | undefined
  return message => {
    const at = now()
    if (loggedAt != null && at - loggedAt < 60_000) return false
    loggedAt = at
    log(message)
    return true
  }
}

export type ValkeyConnection = Pick<EventEmitter, 'on' | 'once' | 'off'> & {
  readonly isReady: boolean
  readonly isOpen: boolean
}

/** What enqueueWithin asks of a connection, independent of node-redis. */
export interface EnqueueConnection {
  ready: () => boolean
  /** Connecting for the first time, or a freshly lost connection. */
  coming: () => boolean
  /** Wake on readiness, a failed connection attempt, or closing. */
  next: (then: () => void) => () => void
}

const connections = new WeakMap<ValkeyConnection, EnqueueConnection>()

/** Track once per client, including failures before the first command. */
export function valkeyConnection(client: ValkeyConnection): EnqueueConnection {
  const held = connections.get(client)
  if (held != null) return held
  let up = client.isReady
  let away = false
  let lastError: unknown
  const waiting = new Set<() => void>()
  const wake = (): void => {
    for (const then of waiting) then()
    waiting.clear()
  }
  client.on('ready', () => {
    up = true
    away = false
    lastError = undefined
    wake()
  })
  client.on('error', error => {
    if (client.isReady) return
    // Our own destroy() rejecting a keepalive in flight: no attempt failed.
    if (error instanceof DisconnectsClientError) return
    // node-redis emits the socket error again if an in-flight PING fails.
    if (error != null && error === lastError) return
    lastError = error
    if (up) up = false
    else away = true
    if (away) wake()
  })
  client.on('end', wake)
  const connection: EnqueueConnection = {
    ready: () => client.isReady,
    coming: () => client.isOpen && !away,
    next: then => {
      waiting.add(then)
      return () => {
        waiting.delete(then)
      }
    }
  }
  connections.set(client, connection)
  return connection
}

export function watchValkeyConnection(
  client: ValkeyConnection,
  log: (message: string) => void,
  role: string
): void {
  valkeyConnection(client)
  const say = onceAMinute(log)
  const sayReady = onceAMinute(log)
  let down = false
  client.on('error', (error: unknown) => {
    if (error instanceof DisconnectsClientError) return
    down = true
    say(
      `redis ${role}: ${error instanceof Error ? error.message : String(error)}`
    )
  })
  client.on('ready', () => {
    if (down) sayReady(`redis ${role}: connected again`)
    down = false
  })
}

export class ValkeyUnavailable extends Error {
  constructor(message = 'Valkey is not connected') {
    super(message)
    this.name = 'ValkeyUnavailable'
  }
}

export class ValkeyTimeout extends ValkeyUnavailable {
  /**
   * What was waited for: `answer` means the command was sent, and `budget`
   * that the budget ran out before anything was.
   */
  readonly what: string

  constructor(what: string) {
    super(
      what === 'budget'
        ? 'Valkey had no time left to send the command'
        : `Valkey did not ${what} in time`
    )
    this.name = 'ValkeyTimeout'
    this.what = what
  }
}

const CONNECTION_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN'
])

/** Server replies (WRONGTYPE, script errors, etc.) must never be retried. */
export function isConnectionError(error: unknown): boolean {
  if (
    error instanceof ClientClosedError ||
    error instanceof ClientOfflineError ||
    error instanceof SocketClosedUnexpectedlyError ||
    error instanceof ConnectionTimeoutError ||
    error instanceof SocketTimeoutError ||
    error instanceof DisconnectsClientError
  )
    return true
  if (!(error instanceof Error) || !('code' in error)) return false
  const code = String(error.code)
  return (
    CONNECTION_CODES.has(code) ||
    code.startsWith('ERR_TLS_') ||
    code.startsWith('ERR_SSL_')
  )
}

/** Publications sent so far on one ordered stream of notices. */
export interface PublicationOrder {
  last: number
}

/**
 * An attempt that may be retried only while it is still the latest notice:
 * healthy notices pipeline in socket order, and an uncertain older one must
 * fail rather than replay after a newer one was sent.
 */
export function inPublicationOrder<T>(
  order: PublicationOrder,
  send: () => Promise<T>
): () => Promise<T> {
  let sent: number | undefined
  return async () => {
    if (sent != null && sent !== order.last)
      throw new ValkeyUnavailable('A later notice was published')
    sent = ++order.last
    return await send()
  }
}

/** Whether a command sent now could be answered, at once or after a reconnect. */
export function valkeyReachable(client: ValkeyConnection): boolean {
  const connection = valkeyConnection(client)
  return connection.ready() || connection.coming()
}

/**
 * One deadline for waiting and, when the caller says a replay is safe, up to
 * two attempts. Extracted from the push enqueuer: an initially offline
 * connection gets one attempt once ready. A connection lost under an attempt
 * leaves its result uncertain, so only a `replaySafe` operation (a read, or a
 * write that recognizes its own replay) is sent again.
 */
export async function enqueueWithin<T>(
  connection: EnqueueConnection,
  attempt: (timeoutMs: number) => Promise<T>,
  budgetMs: number,
  now: () => number = Date.now,
  replaySafe = false
): Promise<T> {
  const deadline = now() + budgetMs
  const tried = async (): Promise<T> => {
    const remaining = deadline - now()
    if (remaining <= 0) throw new ValkeyTimeout('budget')
    return await within(attempt(remaining), deadline - now(), 'answer')
  }
  const triedOnceReady = async (): Promise<T> => {
    if (!connection.ready()) {
      if (!connection.coming()) throw new ValkeyUnavailable()
      let stop = (): void => undefined
      const next = new Promise<void>(resolve => {
        stop = connection.next(resolve)
      })
      await within(next, deadline - now(), 'reconnect').finally(stop)
      if (!connection.ready()) throw new ValkeyUnavailable()
    }
    return await tried()
  }
  if (!connection.ready()) return await triedOnceReady()
  try {
    return await tried()
  } catch (error) {
    // A reconnect may already be ready before the failed promise is handled.
    if (
      !replaySafe ||
      !isConnectionError(error) ||
      (!connection.ready() && !connection.coming())
    )
      throw error
    return await triedOnceReady()
  }
}

export async function runValkey<T>(
  client: ValkeyConnection,
  attempt: (timeoutMs: number) => Promise<T>,
  budgetMs = VALKEY_COMMAND_TIMEOUT_MS,
  replaySafe = false
): Promise<T> {
  return await enqueueWithin(
    valkeyConnection(client),
    attempt,
    budgetMs,
    Date.now,
    replaySafe
  )
}

/**
 * PING drains preceding commands, including on a subscribed connection. Keep
 * the client open until that barrier answers or expires: node-redis's close()
 * clears isOpen before draining, so destroy() can no longer cut it short.
 */
export async function closeValkey(
  client: {
    readonly isReady: boolean
    readonly isOpen: boolean
    ping: () => Promise<unknown>
    destroy: () => void
  },
  budgetMs = VALKEY_COMMAND_TIMEOUT_MS
): Promise<void> {
  closing.add(client)
  if (client.isReady)
    await within(client.ping(), budgetMs, 'finish commands').catch(
      () => undefined
    )
  if (client.isOpen) client.destroy()
}

/** Leaves late answers observed, and always removes the deadline timer. */
export async function within<T>(
  work: Promise<T>,
  ms: number,
  what: string
): Promise<T> {
  work.catch(() => undefined)
  if (ms <= 0) throw new ValkeyTimeout(what)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ValkeyTimeout(what))
        }, ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
