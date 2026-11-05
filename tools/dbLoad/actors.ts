import { type ChildProcess, spawn } from 'node:child_process'
import {
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingHttpHeaders
} from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { resolve } from 'node:path'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

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

/**
 * A frame's type from its first bytes: the server writes it first. A rig with
 * thousands of sockets must not spend its event loop reading what it only
 * counts, or its own queue reads as the server's delivery lag.
 */
const FRAME_TYPE = /^\{"type":"([a-zA-Z]+)"/

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
  postAt: number[] = []
  frameSeconds: number[] = []
  viewersStarted = 0
  playlistRequests = 0
  playlistBytesByViewer: number[] = []
  mediaRequestsByCache: Record<string, number> = {}
  private lastFrameSecond = 0
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
    else if (
      error instanceof HttpError &&
      error.body.toLowerCase().includes('too many clients')
    )
      this.fail('too-many-clients')
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
    const second = Math.floor(Date.now() / 1000)
    if (second !== this.lastFrameSecond) {
      this.lastFrameSecond = second
      this.frameSeconds.push(second)
    }
  }

  /** One playlist answer to viewer `viewer`, by the bytes that came over the wire. */
  notePlaylist(viewer: number, wireBytes: number): void {
    this.playlistRequests += 1
    this.playlistBytesByViewer[viewer] =
      (this.playlistBytesByViewer[viewer] ?? 0) + wireBytes
  }

  /** One media answer, by the cache status its CDN gave it. */
  noteMedia(cacheStatus: string): void {
    this.mediaRequestsByCache[cacheStatus] =
      (this.mediaRequestsByCache[cacheStatus] ?? 0) + 1
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
      headers: { authorization: `Bearer ${this.account.token}` },
      // A frame is counted and not read, so nothing checks what is in it.
      skipUTF8Validation: true
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
      this.onFrame(data as Buffer)
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

  private onFrame(data: Buffer): void {
    const type = FRAME_TYPE.exec(data.toString('latin1', 0, 32))?.[1]
    if (type === 'change' || type === 'changed')
      this.tally.noteFrame(this.gameId)
    else if (type === 'resync') this.tally.fail('socket-resync')
    else if (type == null || type === 'error') this.onUnusualFrame(data)
  }

  /** The whole of a frame, only for one that has something to say. */
  private onUnusualFrame(data: Buffer): void {
    let frame: { type?: string; code?: string }
    try {
      frame = JSON.parse(data.toString()) as typeof frame
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
      tally.postAt.push(Date.now())
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
  /** The live video the stream records into, which viewers watch. */
  videoId: string | null
}

/** A game being streamed, by the video one of its cameras records. */
export interface LiveVideo {
  gameId: string
  videoId: string
  /** The label of the videographer whose camera it is. */
  videographer: string
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
  )) as { id: string; videoId?: string | null }
  const revealed = (await request(
    server,
    account,
    'POST',
    `/games/${gameId}/live-streams/${created.id}/reveal`,
    { route: '/games/:id/live-streams/:id/reveal', tally }
  )) as { url: string }
  return {
    streamId: created.id,
    url: revealed.url,
    videoId: created.videoId ?? null
  }
}

/**
 * The live videos of the seeded live games, as a member of each sees them in
 * `GET /games/:id`: for a rig whose viewers watch streams another rig
 * publishes. A game nobody can be asked about, or that does not answer, is
 * left out of this look.
 */
export async function findLiveVideos(
  servers: string[],
  tokens: Pick<TokensFile, 'accounts' | 'games'>,
  tally: Tally
): Promise<LiveVideo[]> {
  const found = await Promise.all(
    tokens.games.map(async (game, index) => {
      const member = tokens.accounts.find(
        account =>
          (account.kind === 'viewer' || account.kind === 'videographer') &&
          (account.gameIndex ?? 0) === index
      )
      if (member == null) return []
      try {
        const answer = (await request(
          serverFor(servers, index),
          member,
          'GET',
          `/games/${game.id}`,
          { route: '/games/:id (live videos)', tally }
        )) as { videos?: Array<{ id: string; status: string }> }
        return (answer.videos ?? [])
          .filter(video => video.status === 'live')
          .map(video => ({
            gameId: game.id,
            videoId: video.id,
            videographer: ''
          }))
      } catch (error) {
        tally.failure(error)
        return []
      }
    })
  )
  return found.flat()
}

/**
 * Asks for the live videos every `pollMs` until `expected` are live or
 * `timeoutMs` has passed, and answers what it found last: the viewers of a
 * viewer-only rig wait for the publishing rig's streams.
 */
export async function awaitLiveVideos(
  find: () => Promise<LiveVideo[]>,
  expected: number,
  {
    pollMs = 5000,
    timeoutMs = 300_000
  }: { pollMs?: number; timeoutMs?: number } = {}
): Promise<LiveVideo[]> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const videos = await find()
    if (videos.length >= expected || performance.now() + pollMs > deadline)
      return videos
    await new Promise(done => {
      setTimeout(done, pollMs)
    })
  }
}

/** At most this many cameras per person on a game, as the route allows. */
export const CAMERAS_PER_PERSON = 4

export type SpawnPattern = (url: string, seconds: number) => ChildProcess

/** A URL's host in lower case, which a scheme like `rtmp:` is not put in. */
function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase()
}

/**
 * Refuses a stream URL for a host this run is not testing. A server with no
 * `primaryUrlOverride` names the production host in the URLs it mints, and a
 * publisher would push its test pattern there. The message names the host and
 * not the URL, whose path is a live stream key.
 */
export function requireServerHost(url: string, servers: string[]): void {
  const hosts = servers.map(hostOf)
  const host = URL.canParse(url) ? hostOf(url) : 'something unreadable'
  if (hosts.includes(host)) return
  throw new Error(
    `Refusing to publish: the server minted a stream URL for ${host}, which is not a --server host (${hosts.join(', ')}). Set the server's primaryUrlOverride to the name it is tested on.`
  )
}

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
      '10',
      // The ingest takes HEVC and hangs up on anything else.
      '--codec',
      'libx265'
    ],
    { stdio: 'ignore' }
  )

/** How long a stream is asked for again after a 5xx or a lost connection. */
export const MINT_RETRY_MS = 120_000
/** The first wait between tries, doubled each time up to `MINT_BACKOFF_MAX_MS`. */
export const MINT_BACKOFF_MS = 1000
export const MINT_BACKOFF_MAX_MS = 15_000
/** Streams asked for at once. */
export const MINT_CONCURRENCY = 10
/**
 * What a pattern runs for beyond the load's minutes, since the patterns start
 * before the rest of the load has connected. `stop()` ends them with the run.
 */
export const PATTERN_MARGIN_SEC = 1800

export interface MintRetry {
  retryMs?: number
  backoffMs?: number
  backoffMaxMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** A refusal that will not mend by asking again: any answer below 500. */
function retryable(error: unknown): boolean {
  return !(error instanceof HttpError) || error.status >= 500
}

/**
 * `mintStream`, asked again after a 5xx or a lost connection, with a doubling
 * wait, until `retryMs` has passed. Each try that is retried counts as
 * `stream-mint-retry`; a refusal below 500 is not retried.
 */
export async function mintWithRetry(
  server: string,
  account: Pick<SeededAccount, 'token' | 'kind'>,
  gameId: string,
  tally: Tally,
  options: MintRetry = {}
): Promise<MintedStream> {
  const retryMs = options.retryMs ?? MINT_RETRY_MS
  const backoffMax = options.backoffMaxMs ?? MINT_BACKOFF_MAX_MS
  const sleep =
    options.sleep ??
    (async (ms: number) => {
      await new Promise(done => {
        setTimeout(done, ms)
      })
    })
  const deadline = performance.now() + retryMs
  let wait = options.backoffMs ?? MINT_BACKOFF_MS
  for (;;) {
    try {
      return await mintStream(server, account, gameId, tally)
    } catch (error) {
      if (!retryable(error) || performance.now() + wait > deadline) throw error
      tally.fail('stream-mint-retry')
      await sleep(wait)
      wait = Math.min(wait * 2, backoffMax)
    }
  }
}

/**
 * `streams` publishers: each seeded videographer's cameras in turn, up to the
 * limit, pushing a test pattern until the run ends. They are minted before the
 * rest of the load starts, a few at a time, each retried through 5xx answers
 * and lost connections. A stream that could not be minted counts once as
 * `stream-mint`.
 */
export class Publishers implements Actor {
  readonly children: ChildProcess[] = []
  readonly minted: MintedStream[] = []
  /** The videos being streamed, for viewers to watch. */
  readonly videos: LiveVideo[] = []

  constructor(
    private readonly servers: string[],
    private readonly tokens: Pick<TokensFile, 'accounts' | 'games'>,
    private readonly tally: Tally,
    private readonly streams: number,
    private readonly seconds: number,
    private readonly spawnPattern: SpawnPattern = spawnTestPattern,
    private readonly retry: MintRetry & { concurrency?: number } = {}
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
    const wanted = Array.from({ length: this.streams }, (_, i) => {
      const account = videographers[i % videographers.length]
      return { i, account, game: this.tokens.games[account.gameIndex ?? 0] }
    })
    const results: Array<MintedStream | undefined> = new Array(this.streams)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < wanted.length) {
        const { i, account, game } = wanted[next++]
        try {
          results[i] = await mintWithRetry(
            serverFor(this.servers, i),
            account,
            game.id,
            this.tally,
            this.retry
          )
        } catch {
          this.tally.fail('stream-mint')
        }
      }
    }
    const concurrency = Math.max(
      1,
      Math.min(this.retry.concurrency ?? MINT_CONCURRENCY, wanted.length)
    )
    await Promise.all(Array.from({ length: concurrency }, worker))
    // Stops the run before any pattern starts: every stream the server mints
    // would go the same way.
    for (const stream of results)
      if (stream != null) requireServerHost(stream.url, this.servers)
    for (const { i, account, game } of wanted) {
      const stream = results[i]
      if (stream == null) continue
      this.minted.push(stream)
      if (stream.videoId != null)
        this.videos.push({
          gameId: game.id,
          videoId: stream.videoId,
          videographer: account.label
        })
      try {
        const child = this.spawnPattern(
          stream.url,
          this.seconds + PATTERN_MARGIN_SEC
        )
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

/** An answer as it came over the wire: its body decoded, its size as sent. */
export interface RawResponse {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
  /** The body's bytes before decoding, which is what compression saves. */
  wireBytes: number
}

const AGENTS = {
  http: new HttpAgent({ keepAlive: true }),
  https: new HttpsAgent({ keepAlive: true })
}

function decoded(encoding: string | undefined, body: Buffer): Buffer {
  if (encoding === 'gzip') return gunzipSync(body)
  if (encoding === 'deflate') return inflateSync(body)
  if (encoding === 'br') return brotliDecompressSync(body)
  return body
}

/**
 * One GET by plain HTTP rather than `fetch`, which decodes a compressed body
 * and so hides how many bytes it was. A failure carries its code as `cause`,
 * as `fetch`'s do, so the tally counts it by kind.
 */
export async function getRaw(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 15_000
): Promise<RawResponse> {
  const target = new URL(url)
  const secure = target.protocol === 'https:'
  const send = secure ? httpsRequest : httpRequest
  return await new Promise((done, fail) => {
    const failed = (error: Error & { code?: string }): void => {
      fail(
        new Error(`GET ${target.pathname}: ${error.message}`, { cause: error })
      )
    }
    const req = send(
      target,
      { headers, agent: secure ? AGENTS.https : AGENTS.http },
      res => {
        const chunks: Buffer[] = []
        let wireBytes = 0
        res.on('data', (chunk: Buffer) => {
          wireBytes += chunk.length
          chunks.push(chunk)
        })
        res.on('end', () => {
          try {
            done({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: decoded(
                res.headers['content-encoding'],
                Buffer.concat(chunks)
              ),
              wireBytes
            })
          } catch (error) {
            failed(error as Error)
          }
        })
        res.on('error', failed)
      }
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))
    })
    req.on('error', failed)
    req.end()
  })
}

/**
 * The CDN's word on whether it had the object: whichever of `cf-cache-status`
 * and `x-cache` the answer carries, upper-cased, or `NONE` with neither (the
 * Space itself, with no CDN in front).
 */
export function cacheStatusOf(headers: IncomingHttpHeaders): string {
  const raw = headers['cf-cache-status'] ?? headers['x-cache']
  const text = (Array.isArray(raw) ? raw.join(', ') : raw)?.trim()
  return text == null || text === '' ? 'NONE' : text.toUpperCase()
}

/** A master playlist's first variant, or null for a media playlist. */
export function masterVariant(text: string): string | null {
  const lines = text.split('\n').map(line => line.trim())
  const at = lines.findIndex(line => line.startsWith('#EXT-X-STREAM-INF'))
  if (at < 0) return null
  return (
    lines.slice(at + 1).find(line => line !== '' && !line.startsWith('#')) ??
    null
  )
}

export interface MediaPlaylist {
  targetSeconds: number
  ended: boolean
  /** Init files, from `EXT-X-MAP`, in order. */
  maps: string[]
  /** Pieces, in order. */
  pieces: string[]
}

/** A playlist with no target duration is reloaded at what HLS suggests for one. */
const DEFAULT_TARGET_SECONDS = 6

export function parseMediaPlaylist(text: string): MediaPlaylist {
  const playlist: MediaPlaylist = {
    targetSeconds: DEFAULT_TARGET_SECONDS,
    ended: false,
    maps: [],
    pieces: []
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const target = /^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/.exec(line)
    const map = /^#EXT-X-MAP:.*URI="([^"]+)"/.exec(line)
    if (target != null && Number(target[1]) > 0)
      playlist.targetSeconds = Number(target[1])
    else if (map != null) playlist.maps.push(map[1])
    else if (line === '#EXT-X-ENDLIST') playlist.ended = true
    else if (line !== '' && !line.startsWith('#')) playlist.pieces.push(line)
  }
  return playlist
}

/** A piece's URL without its query, so a piece signed afresh is the same piece. */
function pieceKey(url: string): string {
  const parsed = new URL(url)
  parsed.search = ''
  return parsed.href
}

/** A player joining live starts this many pieces from the edge, as hls.js does. */
export const LIVE_EDGE_PIECES = 3

/** How long a viewer waits before asking again for a video that is not there yet. */
export const VIEWER_RETRY_MS = 2000

export interface ViewerTimers {
  set: (run: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const REAL_TIMERS: ViewerTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: handle => {
    clearTimeout(handle as NodeJS.Timeout)
  }
}

/**
 * Somebody watching a live video as a player does: `/playback`, then the
 * master playlist, then `index.m3u8` once per target duration. For each piece
 * it has not seen it sends one ranged GET of a single byte, so the CDN is asked
 * for every piece by every viewer without the rig downloading video. It counts
 * the playlist bytes it was sent and each media answer by its cache status.
 *
 * A 403 on a playlist is an expired token: it asks `/playback` again, as the
 * web player does.
 */
export class LiveViewer implements Actor {
  private stopped = false
  private timer: unknown
  private playlistUrl: string | undefined
  /** Whether a playlist has been read since `/playback` last answered. */
  private freshUrl = false
  private joined = false
  private running: Promise<void> | undefined
  private readonly seen = new Set<string>()
  readonly media = new Set<Promise<void>>()
  private readonly timers: ViewerTimers
  private readonly retryMs: number
  private readonly timeoutMs: number

  constructor(
    private readonly server: string,
    private readonly account: Pick<SeededAccount, 'token' | 'kind'>,
    private readonly videoId: string,
    private readonly tally: Tally,
    /** This viewer's number, which its playlist bytes are counted under. */
    private readonly index: number,
    options: {
      timers?: ViewerTimers
      retryMs?: number
      timeoutMs?: number
    } = {}
  ) {
    this.timers = options.timers ?? REAL_TIMERS
    this.retryMs = options.retryMs ?? VIEWER_RETRY_MS
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  start(): void {
    this.tally.viewersStarted += 1
    this.tally.playlistBytesByViewer[this.index] ??= 0
    this.schedule(0)
  }

  private schedule(ms: number): void {
    if (this.stopped) return
    this.timer = this.timers.set(() => {
      this.timer = undefined
      this.running = this.step()
    }, ms)
  }

  /** One turn, then the next at the time it answered; none once the video ends. */
  async step(): Promise<void> {
    let next: number | null
    try {
      next = await this.turn()
    } catch (error) {
      this.tally.failure(error)
      next = this.retryMs
    }
    if (next != null) this.schedule(next)
  }

  private async turn(): Promise<number | null> {
    if (this.playlistUrl == null) {
      const answer = (await request(
        this.server,
        this.account,
        'GET',
        `/videos/${this.videoId}/playback`,
        { route: '/videos/:id/playback', tally: this.tally }
      )) as { url: string | null }
      // Not live yet: its first pieces have not reached the Space.
      if (answer.url == null) return this.retryMs
      this.playlistUrl = answer.url
      this.freshUrl = true
    }
    const url = this.playlistUrl
    const response = await getRaw(
      url,
      { 'accept-encoding': 'gzip' },
      this.timeoutMs
    )
    this.tally.notePlaylist(this.index, response.wireBytes)
    if (response.status === 403) {
      this.playlistUrl = undefined
      // A URL `/playback` has only just given out should not be refused.
      if (!this.freshUrl) return 0
      this.tally.fail('playlist-http-403')
      return this.retryMs
    }
    if (response.status !== 200) {
      this.tally.fail(`playlist-http-${response.status}`)
      return this.retryMs
    }
    this.freshUrl = false
    const text = response.body.toString('utf8')
    const variant = masterVariant(text)
    if (variant != null) {
      this.playlistUrl = new URL(variant, url).href
      return 0
    }
    const playlist = parseMediaPlaylist(text)
    this.fetchNew(url, playlist)
    return playlist.ended ? null : playlist.targetSeconds * 1000
  }

  /**
   * One ranged GET for each piece not seen before. On joining, only the init
   * files and the last few pieces: a player starts at the live edge.
   */
  private fetchNew(base: string, playlist: MediaPlaylist): void {
    const fresh = (uris: string[]): string[] =>
      uris
        .map(uri => new URL(uri, base).href)
        .filter(url => {
          const key = pieceKey(url)
          if (this.seen.has(key)) return false
          this.seen.add(key)
          return true
        })
    const maps = fresh(playlist.maps)
    const pieces = fresh(playlist.pieces)
    const wanted = this.joined
      ? [...maps, ...pieces]
      : [...maps, ...pieces.slice(-LIVE_EDGE_PIECES)]
    this.joined = true
    for (const url of wanted) {
      const asking = this.piece(url).finally(() => {
        this.media.delete(asking)
      })
      this.media.add(asking)
    }
  }

  private async piece(url: string): Promise<void> {
    try {
      const response = await getRaw(url, { range: 'bytes=0-0' }, this.timeoutMs)
      this.tally.noteMedia(cacheStatusOf(response.headers))
      if (response.status !== 200 && response.status !== 206)
        this.tally.fail(`media-http-${response.status}`)
    } catch (error) {
      this.tally.failure(error)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer != null) this.timers.clear(this.timer)
    await this.running
    await Promise.all(this.media)
  }
}
