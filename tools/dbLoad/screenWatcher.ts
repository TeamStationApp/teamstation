import { WebSocket } from 'ws'

import {
  RECONNECT_DELAYS_MS,
  type ScreenScopeName
} from '../../src/common/gameSocket'
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
  revision?: string
  gameId?: string
  code?: string
}

/**
 * One signed-in socket holding one screen scope. It reads the scope's routes
 * when the subscribe is answered, on each `changed` newer than the newest it
 * has read for, and on `resync`, which also subscribes again. Notices that
 * land while it reads are read once, after it. A lost connection is retried
 * as the app retries it, and the new `subscribed` reads only when it is newer
 * than the newest read.
 */
export class ScreenWatcher implements Actor {
  private ws: WebSocket | undefined
  private stopped = false
  private opened = false
  private attempt = 0
  private timer: NodeJS.Timeout | undefined
  private frameId = 0
  private subscribeId: string | undefined
  /** The newest revision a read has started for. */
  private revision: bigint | undefined
  private hasRead = false
  private reading: Promise<void> | undefined
  /** When the first notice that is owed a read once this one ends arrived. */
  private owed: number | undefined

  constructor(
    private readonly server: string,
    private readonly account: Pick<SeededAccount, 'token' | 'kind'>,
    readonly scope: ScreenScopeName,
    private readonly gameId: string,
    private readonly tally: Tally
  ) {}

  start(): void {
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
      if (!this.opened) this.tally.screenWatchers += 1
      this.opened = true
      this.subscribe()
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
      const delay =
        RECONNECT_DELAYS_MS[
          Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)
        ]
      this.attempt += 1
      this.timer = setTimeout(() => {
        this.start()
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
              id: this.subscribeId
            }
          : { type: 'subscribe', scope: this.scope, id: this.subscribeId }
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
    if (frame.type === 'subscribed' && frame.id === this.subscribeId) {
      if (this.newer(frame.revision)) this.read(heardAt)
    } else if (frame.type === 'changed' && this.mine(frame)) {
      this.tally.screenNotices += 1
      if (this.newer(frame.revision)) this.read(heardAt)
    } else if (frame.type === 'resync') {
      this.tally.screenNotices += 1
      this.read(heardAt)
      this.subscribe()
    } else if (frame.type === 'error' && frame.id === this.subscribeId)
      this.tally.fail(`screen-${frame.code ?? 'error'}`)
  }

  /** A `changed` of this scope, and on an event of this game. */
  private mine(frame: ScopeFrame): boolean {
    if (frame.scope !== this.scope) return false
    return this.scope !== 'event' || frame.gameId === this.gameId
  }

  /** Whether a revision is past the newest read for, taking it if so. */
  private newer(text: string | undefined): boolean {
    if (text == null || !/^\d+$/.test(text)) {
      this.tally.fail('screen-malformed')
      return false
    }
    const revision = BigInt(text)
    if (this.revision != null && revision <= this.revision) return false
    this.revision = revision
    return true
  }

  /** Reads the scope, or owes a read once the one under way ends. */
  private read(heardAt: number): void {
    if (this.reading != null) {
      this.owed ??= heardAt
      return
    }
    // The first read answers the subscribe; every later one, a notice.
    const timed = this.hasRead
    this.hasRead = true
    this.reading = this.readRoutes()
      .then(() => {
        if (!timed) return
        this.tally.screenReReads += 1
        this.tally.screenReadMs.push(performance.now() - heardAt)
      })
      .finally(() => {
        this.reading = undefined
        const owed = this.owed
        this.owed = undefined
        if (owed != null && !this.stopped) this.read(owed)
      })
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
