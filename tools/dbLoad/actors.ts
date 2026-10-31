import { type ChildProcess, spawn } from 'node:child_process'
import { resolve } from 'node:path'

import { WebSocket } from 'ws'

import { RECONNECT_DELAYS_MS } from '../../src/common/gameSocket'
import type { ScoringAction } from '../../src/common/scoring/actions'
import {
  type SaveChange,
  ScoringSession,
  type StoredGame
} from '../../src/common/scoring/session'
import type { GameState } from '../../src/common/scoring/state'
import type { SeededAccount, SeededGame, TokensFile } from './fixture'
import type { Measurements } from './report'
import { batterActions, contextOf, randomFrom } from './scoredGames'

/**
 * What a run's people do, each over the same HTTP and socket a client uses, so
 * the rig can drive any server, including one that has none of this code.
 */

/** The rig's tally. Anything that goes wrong is counted here by kind. */
export class Tally implements Measurements {
  postMs: number[] = []
  deliveryLagMs: number[] = []
  requests: Measurements['requests'] = []
  framesDelivered = 0
  errors: Record<string, number> = {}
  socketOpensBySecond: Record<number, number> = {}
  socketsOpened = 0
  streamsStarted = 0
  private readonly posted = new Map<string, number>()
  private readonly startedAt = Date.now()

  fail(kind: string): void {
    this.errors[kind] = (this.errors[kind] ?? 0) + 1
  }

  /** Counts a failure by what it was: a status, a refused connection. */
  failure(error: unknown): void {
    const code = (error as { cause?: { code?: string } }).cause?.code
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND')
      this.fail('unreachable')
    else if (error instanceof HttpError) this.fail(`http-${error.status}`)
    else this.fail(code ?? (error as Error).name ?? 'error')
  }

  notePost(gameId: string): void {
    this.posted.set(gameId, performance.now())
  }

  noteFrame(gameId: string): void {
    this.framesDelivered += 1
    const sent = this.posted.get(gameId)
    if (sent != null) this.deliveryLagMs.push(performance.now() - sent)
  }

  noteSocketOpen(): void {
    this.socketsOpened += 1
    const second = Math.floor((Date.now() - this.startedAt) / 1000)
    this.socketOpensBySecond[second] =
      (this.socketOpensBySecond[second] ?? 0) + 1
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`)
    this.name = 'HttpError'
  }
}

/** One request as somebody, timed under its route's pattern. */
export async function request(
  server: string,
  account: Pick<SeededAccount, 'token' | 'kind'>,
  method: string,
  path: string,
  options: { route?: string; body?: unknown; tally?: Tally } = {}
): Promise<unknown> {
  const started = performance.now()
  const response = await fetch(`${server}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${account.token}`,
      ...(options.body === undefined
        ? {}
        : { 'content-type': 'application/json' })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  })
  const text = await response.text()
  options.tally?.requests.push({
    route: `${method} ${options.route ?? path}`,
    accountKind: account.kind,
    ms: performance.now() - started
  })
  if (!response.ok) throw new HttpError(response.status, text)
  return text === '' ? null : JSON.parse(text)
}

/** Each server's health, or which of them could not be reached. */
export async function reachable(servers: string[]): Promise<string[]> {
  const down: string[] = []
  await Promise.all(
    servers.map(async server => {
      try {
        const response = await fetch(`${server}/api/v1/health`)
        if (!response.ok) down.push(server)
      } catch {
        down.push(server)
      }
    })
  )
  return down.sort()
}

/** The n-th of anything dealt evenly across the servers. */
export function serverFor(servers: string[], index: number): string {
  return servers[index % servers.length]
}

export interface Actor {
  stop: () => void | Promise<void>
}

/**
 * A signed-in socket watching one game. It answers a lost connection as the
 * app does: the same schedule of retries, subscribing again each time.
 */
export class SocketViewer implements Actor {
  private ws: WebSocket | undefined
  private stopped = false
  private attempt = 0
  private timer: NodeJS.Timeout | undefined
  private frameId = 0

  constructor(
    private readonly server: string,
    private readonly account: Pick<SeededAccount, 'token'>,
    private readonly gameId: string,
    private readonly tally: Tally,
    /** The socket's path and query; the game socket unless told otherwise. */
    private readonly path = '/socket'
  ) {}

  start(): void {
    const url = `${this.server.replace(/^http/, 'ws')}${this.path}`
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.account.token}` }
    })
    this.ws = ws
    ws.on('open', () => {
      this.attempt = 0
      this.tally.noteSocketOpen()
      if (this.path === '/socket') {
        this.frameId += 1
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            gameId: this.gameId,
            id: `s${this.frameId}`
          })
        )
      }
    })
    ws.on('message', data => {
      this.onFrame(String(data))
    })
    ws.on('error', (error: Error & { code?: string }) => {
      const status = /Unexpected server response: (\d+)/.exec(error.message)
      if (status != null) this.tally.fail(`socket-http-${status[1]}`)
      else if (error.code === 'ECONNREFUSED') this.tally.fail('unreachable')
      else this.tally.fail('socket-error')
    })
    ws.on('close', code => {
      if (this.stopped) return
      this.tally.fail(`socket-close-${code}`)
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

  private onFrame(text: string): void {
    let frame: { type?: string; code?: string; gameId?: string }
    try {
      frame = JSON.parse(text) as typeof frame
    } catch {
      this.tally.fail('socket-malformed')
      return
    }
    if (frame.type === 'change' || frame.type === 'changed')
      this.tally.noteFrame(this.gameId)
    else if (frame.type === 'error')
      this.tally.fail(`socket-${frame.code ?? 'error'}`)
    else if (frame.type === 'resync') this.tally.fail('socket-resync')
  }

  stop(): void {
    this.stopped = true
    if (this.timer != null) clearTimeout(this.timer)
    this.ws?.close(1000)
  }
}

/** The game's plays over its route, as the scoring screen reads and saves them. */
export function httpStore(
  server: string,
  account: Pick<SeededAccount, 'token' | 'kind'>,
  tally: Tally
): {
  load: (gameId: string) => Promise<StoredGame>
  save: (gameId: string, change: SaveChange) => Promise<StoredGame>
} {
  const stored = (raw: unknown): StoredGame => {
    const read = raw as {
      plays: Array<{ gumbo: StoredGame['plays'][number] }>
    } & Omit<StoredGame, 'plays'>
    return { ...read, plays: read.plays.map(row => row.gumbo) }
  }
  return {
    load: async gameId =>
      stored(
        await request(server, account, 'GET', `/games/${gameId}/events`, {
          route: '/games/:id/events'
        })
      ),
    save: async (gameId, change) => {
      const started = performance.now()
      tally.notePost(gameId)
      let answer: unknown
      try {
        answer = await request(
          server,
          account,
          'POST',
          `/games/${gameId}/events`,
          {
            route: '/games/:id/events',
            tally,
            body: {
              mode: 'live',
              source: { system: 'teamstation' },
              plays: change.plays,
              remove: change.remove,
              ...(change.currentPlay === undefined
                ? {}
                : { currentPlay: change.currentPlay }),
              ...(change.lineupsBase === undefined
                ? {}
                : { lineupsBase: change.lineupsBase }),
              ...(change.generation === undefined
                ? {}
                : { generation: change.generation })
            }
          }
        )
      } catch (error) {
        // The session keeps the change and sends it again, saying nothing.
        tally.failure(error)
        throw error
      }
      tally.postMs.push(performance.now() - started)
      return stored(answer)
    }
  }
}

/**
 * What ends a batter a previous run left at the plate: his turn is walked out,
 * since the script he was on has gone with that run.
 */
export function finishBatter(state: GameState): ScoringAction[] {
  const count = state.liveData.plays.currentPlay?.count
  const balls = count?.balls ?? 0
  const strikes = count?.strikes ?? 0
  if (balls === 0 && strikes === 0) return []
  const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
  if (balls >= 4 || strikes >= 3) return [close]
  return [
    ...Array.from({ length: 4 - balls }, (): ScoringAction => ({
      type: 'pitch',
      call: 'B'
    })),
    close
  ]
}

/**
 * Scores one game a pitch at a time through the scoring screen's own session.
 * A batter's actions are taken up to and including a pitch, then saved, which
 * is one post and one delivery, as a scorer's tap is.
 */
export class Scorekeeper implements Actor {
  private session: ScoringSession | undefined
  private queue: ScoringAction[] = []
  private timer: NodeJS.Timeout | undefined
  private busy = false
  private readonly random: () => number

  constructor(
    private readonly server: string,
    private readonly account: Pick<SeededAccount, 'token' | 'kind' | 'label'>,
    private readonly game: SeededGame,
    private readonly tally: Tally,
    private readonly pitchMs: number
  ) {
    let seed = 7
    for (const char of game.id) seed = Math.imul(seed ^ char.charCodeAt(0), 31)
    this.random = randomFrom(seed)
  }

  async open(): Promise<void> {
    this.session = await ScoringSession.open(
      httpStore(this.server, this.account, this.tally),
      this.game.id,
      contextOf(this.game.id, this.game.sides),
      {
        now: () => new Date(),
        setTimer: () => null,
        clearTimer: () => undefined
      }
    )
    this.queue = finishBatter(this.session.state)
  }

  /** Scores one pitch, whatever else that batter's turn needs, and saves it. */
  async pitch(): Promise<void> {
    const session = this.session
    if (session == null) throw new Error('The scorekeeper has not opened')
    if (this.queue.length === 0)
      this.queue = batterActions(session.state, this.random)
    for (;;) {
      const action = this.queue.shift()
      if (action == null) break
      const applied = session.apply(action)
      if (applied.problems.length > 0) {
        this.tally.fail('scoring-problem')
        this.queue = []
        break
      }
      if (action.type === 'pitch' || this.queue.length === 0) break
    }
    await session.flush()
  }

  start(): void {
    this.timer = setInterval(() => {
      if (this.busy) return
      this.busy = true
      this.pitch()
        .catch((error: unknown) => {
          this.tally.failure(error)
        })
        .finally(() => {
          this.busy = false
        })
    }, this.pitchMs)
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer)
    this.session?.close()
  }
}

/** What a viewer reads, as paths and the pattern each is reported under. */
export function readsFor(
  account: Pick<SeededAccount, 'teamId'>,
  game: Pick<SeededGame, 'id' | 'seasonId'>
): Array<{ path: string; route: string }> {
  const team = account.teamId
  return [
    { path: `/games/${game.id}`, route: '/games/:id' },
    { path: `/games/${game.id}/events`, route: '/games/:id/events' },
    { path: `/games/${game.id}/box-score`, route: '/games/:id/box-score' },
    {
      path: `/seasons/${game.seasonId}/standings`,
      route: '/seasons/:id/standings'
    },
    { path: `/chat/conversations`, route: '/chat/conversations' },
    { path: `/me/roles`, route: '/me/roles' },
    ...(team == null
      ? []
      : [
          { path: `/teams/${team}/roster`, route: '/teams/:id/roster' },
          { path: `/teams/${team}/games`, route: '/teams/:id/games' },
          { path: `/teams/${team}/stats`, route: '/teams/:id/stats' }
        ])
  ]
}

/** `rate` reads a second in all, each by the next account, round the screens. */
export class RestReaders implements Actor {
  private timer: NodeJS.Timeout | undefined
  private turn = 0
  readonly inFlight = new Set<Promise<void>>()

  constructor(
    private readonly servers: string[],
    private readonly accounts: SeededAccount[],
    private readonly games: SeededGame[],
    private readonly tally: Tally,
    private readonly rate: number
  ) {}

  read(): Promise<void> {
    const turn = this.turn++
    const account = this.accounts[turn % this.accounts.length]
    const game = this.games[(account.gameIndex ?? 0) % this.games.length]
    const reads = readsFor(account, game)
    const { path, route } = reads[turn % reads.length]
    const reading = request(
      serverFor(this.servers, turn),
      account,
      'GET',
      path,
      { route, tally: this.tally }
    )
      .then(() => undefined)
      .catch((error: unknown) => {
        this.tally.failure(error)
      })
      .finally(() => {
        this.inFlight.delete(reading)
      })
    this.inFlight.add(reading)
    return reading
  }

  start(): void {
    if (this.rate <= 0 || this.accounts.length === 0) return
    this.timer = setInterval(() => {
      void this.read()
    }, 1000 / this.rate)
  }

  async stop(): Promise<void> {
    if (this.timer != null) clearInterval(this.timer)
    await Promise.all(this.inFlight)
  }
}

/** A camera a videographer was given: its row and where to send the stream. */
export interface MintedStream {
  streamId: string
  url: string
}

/**
 * Asks for a stream as the app does, then for its URL again: the two routes a
 * publisher's screen calls. It goes only as far as the server lets them, so one
 * without the role is refused here.
 */
export async function mintStream(
  server: string,
  account: Pick<SeededAccount, 'token' | 'kind'>,
  gameId: string,
  tally: Tally
): Promise<MintedStream> {
  const created = (await request(
    server,
    account,
    'POST',
    `/games/${gameId}/live-streams`,
    { route: '/games/:id/live-streams', body: {}, tally }
  )) as { id: string }
  const revealed = (await request(
    server,
    account,
    'POST',
    `/games/${gameId}/live-streams/${created.id}/reveal`,
    { route: '/games/:id/live-streams/:id/reveal', tally }
  )) as { url: string }
  return { streamId: created.id, url: revealed.url }
}

/** At most this many cameras per person on a game, as the route allows. */
export const CAMERAS_PER_PERSON = 4

export type SpawnPattern = (url: string, seconds: number) => ChildProcess

/** The repository's test pattern, pushing to the URL for the whole run. */
export const spawnTestPattern: SpawnPattern = (url, seconds) =>
  spawn(
    process.execPath,
    [
      resolve(__dirname, '../streamTestPattern.js'),
      '--url',
      url,
      '--duration',
      String(seconds),
      '--size',
      '320x180',
      '--rate',
      '10'
    ],
    { stdio: 'ignore' }
  )

/**
 * `streams` publishers: each seeded videographer's cameras in turn, up to the
 * limit, pushing a test pattern until the run ends.
 */
export class Publishers implements Actor {
  readonly children: ChildProcess[] = []
  readonly minted: MintedStream[] = []

  constructor(
    private readonly servers: string[],
    private readonly tokens: Pick<TokensFile, 'accounts' | 'games'>,
    private readonly tally: Tally,
    private readonly streams: number,
    private readonly seconds: number,
    private readonly spawnPattern: SpawnPattern = spawnTestPattern
  ) {}

  async start(): Promise<void> {
    const videographers = this.tokens.accounts.filter(
      account => account.kind === 'videographer'
    )
    const most = videographers.length * CAMERAS_PER_PERSON
    if (this.streams > most)
      throw new Error(
        `--streams ${this.streams} is above the ${most} that ${videographers.length} seeded videographers may hold`
      )
    for (let i = 0; i < this.streams; i++) {
      const account = videographers[i % videographers.length]
      const game = this.tokens.games[account.gameIndex ?? 0]
      try {
        const stream = await mintStream(
          serverFor(this.servers, i),
          account,
          game.id,
          this.tally
        )
        this.minted.push(stream)
        const child = this.spawnPattern(stream.url, this.seconds)
        child.on('error', () => {
          this.tally.fail('stream-spawn')
        })
        this.children.push(child)
        this.tally.streamsStarted += 1
      } catch (error) {
        this.tally.failure(error)
      }
    }
  }

  stop(): void {
    for (const child of this.children) child.kill('SIGINT')
  }
}

/** Runs `work` for each item at about `perSecond`, so a crowd arrives over time. */
export async function paced<T>(
  items: readonly T[],
  perSecond: number,
  work: (item: T, index: number) => void
): Promise<void> {
  const gap = 1000 / perSecond
  const started = performance.now()
  for (const [index, item] of items.entries()) {
    work(item, index)
    const due = started + (index + 1) * gap - performance.now()
    if (due > 0)
      await new Promise(done => {
        setTimeout(done, due)
      })
  }
}
