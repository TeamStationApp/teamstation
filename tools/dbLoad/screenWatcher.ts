import { WebSocket } from 'ws'

import {
  GAME_SOCKET_PROTOCOL,
  type GameSocketErrorCode,
  RECONNECT_DELAYS_MS,
  type ScreenScope,
  type ScreenScopeListener,
  type ScreenScopeName
} from '../../src/common/gameSocket'
import { ScreenScopeGate } from '../../src/common/screenScope'
import {
  type Actor,
  FollowedConnection,
  request,
  serverFor,
  type Tally
} from './actors'
import type { SeededAccount, SeededGame } from './fixture'
import { SCREEN_ROUTE_PREFIX } from './report'

/**
 * A screen that holds a scope on the socket, as Home, Schedule or an event's
 * screen does. No scope frame carries a record, so each notice costs the
 * server the screen's reads: this is what the rig measures.
 */

/** The routes each scope's screen reads, as paths and the pattern of each. */
export function screenRoutes(
  scope: ScreenScopeName,
  gameId: string
): Array<{ path: string; route: string }> {
  if (scope === 'event')
    return [{ path: `/games/${gameId}`, route: '/games/:id' }]
  if (scope === 'schedule') return [{ path: '/events', route: '/events' }]
  return [
    '/events?played=1&limit=1',
    '/live',
    '/teams',
    '/seasons',
    '/me/groups',
    '/me/follows'
  ].map(path => ({ path, route: path }))
}

/** The scopes watchers take in turn: most people watching a game are on it. */
export const SCOPE_TURN: readonly ScreenScopeName[] = [
  'event',
  'event',
  'home',
  'schedule',
  'home'
]

/**
 * Who watches which scope: `count` watchers dealt over `accounts`, taking
 * `SCOPE_TURN` in turn, each on its account's game.
 */
export function screenWatchersFor(
  accounts: readonly SeededAccount[],
  games: readonly SeededGame[],
  count: number
): Array<{ account: SeededAccount; scope: ScreenScopeName; game: SeededGame }> {
  if (accounts.length === 0 || games.length === 0) return []
  return Array.from({ length: count }, (_, i) => {
    const account = accounts[i % accounts.length]
    return {
      account,
      scope: SCOPE_TURN[i % SCOPE_TURN.length],
      game: games[(account.gameIndex ?? 0) % games.length]
    }
  })
}

interface ScopeFrame {
  type?: string
  id?: string
  scope?: string
  gameId?: string
  code?: string
  reason?: string
  message?: string
}

export interface ScreenWatcherOptions {
  /** The gate's window, `COALESCE_MS` unless given: for a test's short run. */
  coalesceMs?: number
}

/**
 * One signed-in socket holding one screen scope, read through the app's own
 * gate (`ScreenScopeGate`): the scope's routes are read when the subscribe
 * is answered, and on a `changed` at once or, within the gate's window of
 * the last read, once that has passed, one read covering every notice
 * since. A `resync` subscribes again, and its `subscribed` reads. A lost
 * connection is retried as the app retries it, and the new `subscribed`
 * reads. A refused subscribe reads as the app's does, at once and on each
 * notice, and the scope is asked for again on the next connection; only
 * `updateRequired` stops the watcher for good.
 */
export class ScreenWatcher implements Actor {
  private ws: WebSocket | undefined
  private stopped = false
  private opened = false
  private attempt = 0
  private timer: NodeJS.Timeout | undefined
  private frameId = 0
  private subscribeId: string | undefined
  private readonly gate: ScreenScopeGate
  /** What the gate hears from the scope while it holds it. */
  private listener: ScreenScopeListener | undefined
  private hasRead = false
  /** The scope was refused once: as in the gate, every notice now reads. */
  private direct = false
  private reading: Promise<void> | undefined
  /** When the first notice not yet covered by a read arrived. */
  private owed: number | undefined

  constructor(
    private readonly server: string,
    private readonly account: Pick<SeededAccount, 'token' | 'kind'>,
    readonly scope: ScreenScopeName,
    private readonly gameId: string,
    private readonly tally: Tally,
    options: ScreenWatcherOptions = {}
  ) {
    this.gate = new ScreenScopeGate({
      load: async () => {
        await this.read()
      },
      socket: {
        subscribeScope: (_scope: ScreenScope, listener) => {
          this.listener = listener
          if (this.ws?.readyState === WebSocket.OPEN) this.subscribe()
          return () => {
            this.listener = undefined
          }
        }
      },
      coalesceMs: options.coalesceMs
    })
  }

  start(): void {
    this.connect()
  }

  private connect(): void {
    const url = `${this.server.replace(/^http/, 'ws')}/socket`
    const connection = new FollowedConnection(this.server, this.tally)
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.account.token}` },
      createConnection: connection.connect
    })
    this.ws = ws
    ws.on('upgrade', () => {
      connection.answer()
    })
    ws.on('open', () => {
      this.attempt = 0
      this.tally.noteSocketOpen()
      if (this.opened) {
        // Not once it is refused as too old, as the app's socket asks no more.
        if (this.listener != null) this.subscribe()
        return
      }
      this.tally.screenWatchers += 1
      this.opened = true
      // Held from the first connection, whose subscribe this sends: a watcher
      // that never connects reads nothing.
      this.gate.enter(
        this.scope === 'event'
          ? { scope: 'event', gameId: this.gameId }
          : { scope: this.scope }
      )
    })
    ws.on('message', data => {
      this.onFrame(String(data))
    })
    ws.on('error', (error: Error & { code?: string }) => {
      const status = /Unexpected server response: (\d+)/.exec(error.message)
      if (status != null) this.tally.fail(`screen-http-${status[1]}`)
      else if (error.code === 'ECONNREFUSED') this.tally.fail('unreachable')
      else this.tally.fail('screen-error')
    })
    ws.on('close', code => {
      if (this.stopped) return
      this.tally.fail(`screen-close-${code}`)
      // As the app's socket does: the acknowledgement is gone, and the
      // reconnect's `subscribed` reads.
      this.subscribeId = undefined
      this.owed = undefined
      this.listener?.({ type: 'resync' })
      const delay =
        RECONNECT_DELAYS_MS[
          Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)
        ]
      this.attempt += 1
      this.timer = setTimeout(() => {
        this.connect()
      }, delay)
    })
  }

  private subscribe(): void {
    this.frameId += 1
    this.subscribeId = `w${this.frameId}`
    this.ws?.send(
      JSON.stringify(
        this.scope === 'event'
          ? {
              type: 'subscribe',
              scope: 'event',
              gameId: this.gameId,
              id: this.subscribeId,
              protocol: GAME_SOCKET_PROTOCOL
            }
          : {
              type: 'subscribe',
              scope: this.scope,
              id: this.subscribeId,
              protocol: GAME_SOCKET_PROTOCOL
            }
      )
    )
  }

  private onFrame(text: string): void {
    const heardAt = performance.now()
    let frame: ScopeFrame
    try {
      frame = JSON.parse(text) as ScopeFrame
    } catch {
      this.tally.fail('screen-malformed')
      return
    }
    // An answer to the subscribe out now: none is once one was refused.
    const answers = frame.id != null && frame.id === this.subscribeId
    if (frame.type === 'subscribed' && answers) {
      this.owed ??= heardAt
      this.listener?.({ type: 'subscribed' })
    } else if (frame.type === 'changed' && this.mine(frame)) {
      this.tally.screenNotices += 1
      // Before the acknowledgement the gate drops it, and the read the
      // acknowledgement starts is timed from that.
      if (this.gate.acknowledged || this.direct) this.owed ??= heardAt
      this.listener?.({ type: 'changed' })
    } else if (frame.type === 'resync') {
      this.tally.screenNotices += 1
      this.subscribeId = undefined
      this.owed = undefined
      this.listener?.({ type: 'resync' })
      this.subscribe()
    } else if (frame.type === 'error' && answers) {
      this.tally.fail(`screen-${frame.code ?? 'error'}`)
      this.subscribeId = undefined
      // Too old: as the app, nothing is asked for again, and no notice comes.
      if (frame.reason === 'updateRequired') {
        this.gate.leave()
        return
      }
      // Refused (`internal` is the server failing): as the app's gate, it
      // reads at once and on each notice, and the scope stays held, so the
      // next connection asks again and its `subscribed` reads.
      this.direct = true
      this.listener?.({
        type: 'error',
        code: (frame.code ?? 'internal') as GameSocketErrorCode,
        message: frame.message ?? ''
      })
    }
  }

  /** A `changed` of this scope, and on an event of this game. */
  private mine(frame: ScopeFrame): boolean {
    if (frame.scope !== this.scope) return false
    return this.scope !== 'event' || frame.gameId === this.gameId
  }

  /**
   * The gate's load: reads the scope, timed from the first notice it covers.
   * The first read answers the first subscribe and is not timed.
   */
  private async read(): Promise<void> {
    const heardAt = this.owed ?? performance.now()
    this.owed = undefined
    const timed = this.hasRead
    this.hasRead = true
    this.reading = this.readRoutes()
    try {
      await this.reading
    } finally {
      this.reading = undefined
    }
    if (!timed) return
    this.tally.screenReReads += 1
    this.tally.screenReadMs.push(performance.now() - heardAt)
  }

  private async readRoutes(): Promise<void> {
    await Promise.all(
      screenRoutes(this.scope, this.gameId).map(async ({ path, route }) => {
        await request(this.server, this.account, 'GET', path, {
          label: `${SCREEN_ROUTE_PREFIX}${this.scope} GET ${route}`,
          tally: this.tally
        }).catch((error: unknown) => {
          this.tally.failure(error)
        })
      })
    )
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.gate.leave()
    if (this.timer != null) clearTimeout(this.timer)
    this.ws?.close(1000)
    await this.reading
  }
}

/** Starts `count` watchers over the servers, as `screenWatchersFor` deals them. */
export function screenWatchers(
  servers: string[],
  accounts: readonly SeededAccount[],
  games: readonly SeededGame[],
  count: number,
  tally: Tally
): ScreenWatcher[] {
  return screenWatchersFor(accounts, games, count).map(
    ({ account, scope, game }, i) =>
      new ScreenWatcher(serverFor(servers, i), account, scope, game.id, tally)
  )
}
