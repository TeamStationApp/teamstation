import type { AnalyticsSink } from './apiEvents'
import {
  ANONYMOUS_EVENTS,
  type EventName,
  type EventRecord,
  PAGE_NAMES,
  parseEvent,
  type Property,
  SERVER_EVENTS
} from './contract'
import { EventQueue, type QueueStorage } from './queue'

// Hermes supplies this monotonic timer, but React Native's types omit it.
declare const performance: { now: () => number }

export interface AnalyticsOptions {
  endpoint: string
  app: 'TS' | 'TS web'
  version: string
  storage: QueueStorage
  id: () => string
  request?: typeof fetch
  now?: () => number
  monotonic?: () => number
}

/** Explicit events only. Identity changes cancel the previous authenticated queue. */
export class AnalyticsClient {
  private readonly anonymous: EventQueue
  private authenticated?: EventQueue
  private identity?: string
  private token?: string
  private generation = 0
  private transition: Promise<void> = Promise.resolve()
  private session: string
  private startedAt: number
  private page?: { name: string; at: number }
  private active = true
  private closed = false
  private readonly now: () => number
  private readonly monotonic: () => number

  get app(): 'TS' | 'TS web' {
    return this.options.app
  }

  constructor(private readonly options: AnalyticsOptions) {
    this.now = options.now ?? Date.now
    this.monotonic = options.monotonic ?? (() => performance.now())
    this.session = options.id()
    this.startedAt = this.monotonic()
    this.anonymous = this.queue()
    this.anonymous.start()
    this.emit('session_started').catch(() => {})
  }

  private queue(identity?: string, token?: string): EventQueue {
    const request = this.options.request ?? fetch
    return new EventQueue({
      key: `analytics-v1:${this.options.app}:${this.options.endpoint}:${identity ?? 'anonymous'}`,
      storage: this.options.storage,
      now: this.now,
      send: async (body, signal) => {
        if (identity != null && this.identity !== identity) return 401
        const response = await request(this.options.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(identity != null && token != null && token !== ''
              ? { authorization: `Bearer ${token}` }
              : {})
          },
          credentials: identity == null ? 'omit' : 'include',
          body: JSON.stringify(
            body
              .trim()
              .split('\n')
              .map(line => JSON.parse(line))
          ),
          signal
        })
        return response.status
      }
    })
  }

  /** Call synchronously when changing credentials, before any new-user events. */
  identify(identity?: string, token?: string): void {
    if (this.closed || (identity === this.identity && token === this.token))
      return
    const old = this.authenticated
    this.authenticated = undefined
    old?.stop()
    this.identity = identity
    this.token = token
    const generation = ++this.generation
    this.session = this.options.id()
    this.startedAt = this.monotonic()
    this.page = undefined
    this.transition = this.transition
      .then(async () => {
        await old?.clear()
        if (generation !== this.generation || this.closed) return
        if (identity != null) {
          this.authenticated = this.queue(identity, token)
          this.authenticated.start()
        }
      })
      .catch(() => {})
    this.emit('session_started').catch(() => {})
  }

  async emit(
    event: EventName,
    properties: Record<string, Property> = {}
  ): Promise<void> {
    if (this.closed || SERVER_EVENTS.has(event)) return
    const generation = this.generation
    const identity = this.identity
    if (identity == null && !ANONYMOUS_EVENTS.has(event)) return
    let row: EventRecord
    try {
      row = parseEvent(
        {
          D: new Date(this.now()).toISOString(),
          A: this.options.app,
          I: this.options.id(),
          E: event,
          L: 'info',
          R: 1,
          S: this.session,
          ...(/^[0-9][0-9A-Za-z.+_-]{0,63}$/.test(this.options.version)
            ? { V: this.options.version }
            : {}),
          P: properties
        },
        this.now()
      )
      await this.transition
      if (this.closed || generation !== this.generation) return
      await (identity == null ? this.anonymous : this.authenticated)?.enqueue(
        row
      )
    } catch {
      /* Analytics never interrupts application behavior. */
    }
  }

  /** A request started by one account cannot finish as a different account. */
  capture(): AnalyticsSink {
    const generation = this.generation
    return (event, properties) => {
      if (generation === this.generation)
        this.emit(event, properties).catch(() => {})
    }
  }

  navigate(name: string): void {
    // Unknown names collapse to a constant; chat routes generate no event at all.
    if (/chat|message/i.test(name)) {
      this.leavePage()
      return
    }
    const safe = PAGE_NAMES.includes(name as never) ? name : 'other'
    // The anonymous intake deliberately admits only public pages.
    if (
      this.identity == null &&
      [
        'account',
        'player',
        'create',
        'notifications',
        'settings',
        'scoring',
        'stream'
      ].includes(safe)
    ) {
      this.leavePage()
      return
    }
    if (this.page?.name === safe) return
    this.leavePage()
    this.page = { name: safe, at: this.monotonic() }
    this.emit('page_viewed', { pg: safe }).catch(() => {})
  }

  private leavePage(): void {
    if (this.page == null) return
    this.emit('page_left', {
      pg: this.page.name,
      ms: Math.max(0, Math.min(86400000, this.monotonic() - this.page.at))
    }).catch(() => {})
    this.page = undefined
  }

  foreground(active: boolean): void {
    if (this.closed || active === this.active) return
    this.active = active
    this.emit(active ? 'app_foreground' : 'app_background').catch(() => {})
    if (!active) this.flush().catch(() => {})
  }

  async flush(): Promise<void> {
    await this.transition
    await Promise.all([this.anonymous.flush(), this.authenticated?.flush()])
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.leavePage()
    await this.emit('session_ended', {
      ms: Math.max(0, Math.min(86400000, this.monotonic() - this.startedAt))
    })
    this.closed = true
    await this.flush()
    this.anonymous.stop()
    this.authenticated?.stop()
  }
}
