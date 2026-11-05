import type { PlaylistSink } from '../live/originPublisher'
import type { ScoreboardClient } from '../scoreboard/scoreboardStore'
import type { VideoPath } from './videoPrefix'

/**
 * Live playlists through Valkey.
 *
 * The ingest pushes each piece of text a published `index.m3u8` adds onto a
 * list, `<prefix>:live:playlist:<videoId>`, and announces the list's new
 * length on `<prefix>:live:playlists` as `{"v":<video id>,"n":<length>,
 * "g":<generation>}`. A body that does not extend the last (the first, or a
 * reconnect's) replaces the list in one `MULTI` as a single entry and bumps
 * the generation, `<prefix>:live:playlistGen:<videoId>`.
 *
 * The notice goes through Valkey, never the change feed: in the feed's
 * `postgres` mode an ephemeral notice is a `pg_notify`, one database
 * statement per piece per stream.
 *
 * An API worker follows the channel for the playlists its viewers have open
 * and reads only the entries it has not seen, so it never reads the Space for
 * a live playlist while Valkey has it, and rewrites each line once.
 */

/**
 * How long a flush waits on Valkey before it goes on without it. A healthy
 * answer takes a millisecond; this is a connection that stopped answering.
 */
const SINK_TIMEOUT_MS = 1000

/** How long a list outlives its last push: longer than any game. */
export const LIVE_PLAYLIST_TTL_SEC = 12 * 60 * 60

export function livePlaylistKey(prefix: string, videoId: string): string {
  return `${prefix}:live:playlist:${videoId}`
}

export function livePlaylistGenKey(prefix: string, videoId: string): string {
  return `${prefix}:live:playlistGen:${videoId}`
}

export function livePlaylistChannel(prefix: string): string {
  return `${prefix}:live:playlists`
}

export interface LivePlaylistNotice {
  v: string
  n: number
  g: number
}

/** A notice off the channel, or undefined for anything else. */
export function parseLivePlaylistNotice(
  raw: string
): LivePlaylistNotice | undefined {
  try {
    const value = JSON.parse(raw) as Partial<LivePlaylistNotice>
    if (
      typeof value.v === 'string' &&
      Number.isSafeInteger(value.n) &&
      Number.isSafeInteger(value.g)
    )
      return { v: value.v, n: value.n!, g: value.g! }
  } catch {}
  return undefined
}

/**
 * The ingest's sink: each published body's added text to Valkey.
 *
 * It knows the length each list should have. A push that answers another
 * length (Valkey restarted, failed over or lost the key) is followed by a
 * replacement of the whole body with a new generation, so a worker never
 * serves a list that holds only the latest pieces. Valkey failing never fails
 * a flush: the Space write already happened, the sink forgets the list, and
 * the next body replaces it.
 *
 * Nor does Valkey stalling hold one. The client has no command timeout, and a
 * connection that stays open without answering would keep every video's
 * flush, and so its pieces and its playlist in the Space, waiting until TCP
 * gives up, minutes later. A call that has not answered in `timeoutMs` is
 * left behind: the flush goes on, every list is forgotten, and until that call
 * settles no command is sent, since each would queue behind it on the same
 * connection. Once it settles, the next body of each video replaces its list.
 */
export class ValkeyPlaylistSink implements PlaylistSink {
  private readonly lists = new Map<string, { length: number; gen: number }>()
  private down = false
  /** A call that outlasted its timeout and has not settled yet. */
  private stalled: Promise<void> | undefined

  constructor(
    private readonly client: ScoreboardClient,
    private readonly prefix: string,
    private readonly log: (message: string) => void = () => {},
    private readonly timeoutMs = SINK_TIMEOUT_MS
  ) {}

  async append(videoId: string, text: string, body: string): Promise<void> {
    const held = this.lists.get(videoId)
    if (held == null) {
      await this.replace(videoId, body)
      return
    }
    const key = livePlaylistKey(this.prefix, videoId)
    await this.attempt(videoId, async () => {
      const [length] = (await this.client
        .multi()
        .rPush(key, text)
        .expire(key, LIVE_PLAYLIST_TTL_SEC)
        .expire(livePlaylistGenKey(this.prefix, videoId), LIVE_PLAYLIST_TTL_SEC)
        .exec()) as unknown as [number, unknown, unknown]
      if (length !== held.length + 1) {
        this.lists.delete(videoId)
        await this.write(videoId, body)
        return
      }
      held.length = length
      await this.announce(videoId, held)
    })
  }

  async replace(videoId: string, body: string): Promise<void> {
    await this.attempt(videoId, async () => {
      await this.write(videoId, body)
    })
  }

  /** Deletes a closed video's list, once its closed body is in the Space. */
  async forget(videoId: string): Promise<void> {
    this.lists.delete(videoId)
    await this.attempt(videoId, async () => {
      await this.client.del(livePlaylistKey(this.prefix, videoId))
    })
  }

  private async write(videoId: string, body: string): Promise<void> {
    const key = livePlaylistKey(this.prefix, videoId)
    const genKey = livePlaylistGenKey(this.prefix, videoId)
    const [, length, , gen] = (await this.client
      .multi()
      .del(key)
      .rPush(key, body)
      .expire(key, LIVE_PLAYLIST_TTL_SEC)
      .incr(genKey)
      .expire(genKey, LIVE_PLAYLIST_TTL_SEC)
      .exec()) as unknown as [unknown, number, unknown, number, unknown]
    const held = { length, gen }
    this.lists.set(videoId, held)
    await this.announce(videoId, held)
  }

  private async announce(
    videoId: string,
    held: { length: number; gen: number }
  ): Promise<void> {
    await this.client.publish(
      livePlaylistChannel(this.prefix),
      JSON.stringify({ v: videoId, n: held.length, g: held.gen })
    )
  }

  private async attempt(
    videoId: string,
    run: () => Promise<void>
  ): Promise<void> {
    if (this.stalled != null) {
      this.lists.delete(videoId)
      return
    }
    const running = run()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const answered = await Promise.race([
        running.then(() => true),
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => {
            resolve(false)
          }, this.timeoutMs)
        })
      ])
      if (!answered) {
        this.leaveBehind(running)
        return
      }
      if (this.down) this.log('live playlists: Valkey answers again')
      this.down = false
    } catch (error) {
      // The next body replaces the whole list.
      this.lists.delete(videoId)
      if (!this.down) this.log(`live playlists: ${String(error)}`)
      this.down = true
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Gives up waiting on a call Valkey has not answered. Whatever it did to a
   * list when it settles is forgotten with the rest, so every next body
   * replaces its list.
   */
  private leaveBehind(running: Promise<void>): void {
    this.lists.clear()
    if (!this.down)
      this.log(
        `live playlists: Valkey did not answer in ${this.timeoutMs} ms; sending nothing until it does`
      )
    this.down = true
    this.stalled = running
      .catch(() => {})
      .finally(() => {
        this.stalled = undefined
        this.lists.clear()
      })
  }
}

/** What an API worker follows live playlists with. */
export interface LivePlaylistClients {
  /** Reads the lists. */
  client: ScoreboardClient
  /** Subscribed to the channel, so a connection of its own. */
  subscriber: ScoreboardClient
  prefix: string
}

export interface LivePlaylistOptions extends LivePlaylistClients {
  /** Whether to follow at all: off until the worker's change feed exists. */
  enabled?: () => boolean
  log?: (message: string) => void
  now?: () => number
  /** How long a read waits on Valkey before the Space is read instead. */
  readTimeoutMs?: number
}

/** A rewritten copy is kept this long after its playlist closes. */
const CLOSED_KEEP_MS = 60_000
/** A copy nobody has asked for in this long is dropped, and read again. */
const IDLE_KEEP_MS = 10 * 60_000
/** How long a list found missing, or Valkey failing, is not asked again. */
const RETRY_MS = 1000
/**
 * How long a viewer waits on Valkey. The client has no command timeout, so a
 * connection that stalls while staying open would otherwise hold every viewer
 * of the video on this worker.
 */
const READ_TIMEOUT_MS = 1000
/** A video whose reads keep timing out is logged this often. */
const STALL_LOG_MS = 60_000
/**
 * How long a copy of an open playlist is vouched for after it last grew.
 * Pieces arrive every few seconds; a list that stopped growing may be one the
 * ingest can no longer write (its Valkey connection stalled or failing, while
 * this worker's still answers), and the Space, which the ingest keeps
 * current regardless, is read instead until the list grows again.
 */
const STILL_MS = 15_000

interface Followed {
  video: VideoPath
  /** Changes when the rewrite of a line would (a signing window). */
  epoch: number
  rewrite: (text: string) => string
  gen: number
  count: number
  rewritten: string
  closedAt?: number
  readAt: number
  /** The read or update in progress; updates are applied in order. */
  chain: Promise<void>
}

/**
 * An API worker's copies of the live playlists its viewers have open.
 *
 * For each it keeps `{ gen, count, rewritten }`. A notice with its own `g`
 * and an `n` beyond its count reads only the new entries and rewrites only
 * them; one with another `g`, or an `n` below its count, reads the whole list
 * and the generation again in one `MULTI`. A subscriber that reconnects may
 * have missed notices, so every copy is dropped. Valkey is never polled: a
 * copy changes only on a notice.
 *
 * `read` answers undefined whenever it cannot vouch for a copy (not
 * following, Valkey failing or slower than `readTimeoutMs`, no list), and the
 * caller reads the Space. A read that times out drops the copy, so a late
 * answer lands on a copy nobody holds and is ignored.
 */
export class LivePlaylists {
  private readonly followed = new Map<string, Followed>()
  /** Videos whose list was missing, or whose read failed, and when. */
  private readonly missing = new Map<string, number>()
  /** When each video's last stalled read was logged. */
  private readonly stalls = new Map<string, number>()
  /**
   * Each followed list's generation and length, and when it last changed.
   * Kept across a drop: a list read again after a subscriber reconnect is
   * not growth.
   */
  private readonly grown = new Map<
    string,
    { gen: number; count: number; at: number }
  >()

  /** When each video's still list was last logged. */
  private readonly stills = new Map<string, number>()
  private following = false
  private down = false
  private readonly now: () => number

  constructor(private readonly options: LivePlaylistOptions) {
    this.now = options.now ?? Date.now
    const { subscriber } = options
    const lost = (): void => {
      this.down = true
      this.following = false
      this.drop()
    }
    subscriber.on('error', lost)
    subscriber.on('end', lost)
    subscriber.on('reconnecting', lost)
    let subscribed = false
    subscriber.on('ready', () => {
      // node-redis subscribes again before it is ready, so notices from here
      // on are heard; any while it was away were missed.
      if (this.down) this.drop()
      this.down = false
      this.following = subscribed
    })
    subscriber
      .subscribe(livePlaylistChannel(options.prefix), message => {
        this.hear(message)
      })
      .then(
        () => {
          // Its reply can come before the connection says it is ready.
          subscribed = true
          this.following = !this.down
        },
        (error: unknown) => {
          this.options.log?.(`live playlists: subscribe: ${String(error)}`)
        }
      )
  }

  /** Forgets every copy, as after a gap in the notices. */
  drop(): void {
    this.followed.clear()
    this.missing.clear()
  }

  /** How many videos this worker holds a copy of. */
  get size(): number {
    return this.followed.size
  }

  /**
   * The rewritten open playlist, or undefined when Valkey cannot give it and
   * the Space must be read.
   */
  async read(
    video: VideoPath,
    rewrite: (text: string) => string,
    epoch = 0
  ): Promise<string | undefined> {
    if (!this.usable()) return undefined
    const at = this.now()
    this.sweep(at)
    const failedAt = this.missing.get(video.id)
    if (failedAt != null && at - failedAt < RETRY_MS) return undefined
    let held = this.followed.get(video.id)
    if (
      held != null &&
      (held.video.spaceSecret !== video.spaceSecret || held.epoch !== epoch)
    ) {
      this.followed.delete(video.id)
      held = undefined
    }
    if (held == null) {
      const fresh: Followed = {
        video,
        epoch,
        rewrite,
        gen: 0,
        count: 0,
        rewritten: '',
        readAt: at,
        chain: Promise.resolve()
      }
      fresh.chain = this.reload(fresh)
      this.followed.set(video.id, fresh)
      held = fresh
    }
    held.readAt = at
    if (!(await this.settles(held.chain))) {
      this.stalled(held)
      return undefined
    }
    if (this.followed.get(video.id) !== held || held.count === 0)
      return undefined
    if (held.closedAt == null && this.stillFor(video.id, at)) return undefined
    return held.rewritten
  }

  /**
   * Whether an open playlist's list has not grown in `STILL_MS`. The copy is
   * kept, so a notice that extends it brings the worker back to Valkey.
   */
  private stillFor(id: string, at: number): boolean {
    const grew = this.grown.get(id)
    if (grew == null || at - grew.at <= STILL_MS) return false
    const loggedAt = this.stills.get(id)
    if (loggedAt == null || at - loggedAt >= STALL_LOG_MS) {
      this.stills.set(id, at)
      this.options.log?.(
        `live playlists: ${id} has not grown in ${STILL_MS / 1000} s; reading the Space`
      )
    }
    return true
  }

  /** Whether `chain` settles within the read timeout. */
  private async settles(chain: Promise<void>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        chain.then(() => true),
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => {
            resolve(false)
          }, this.options.readTimeoutMs ?? READ_TIMEOUT_MS)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Valkey did not answer a read in time: drop the copy, ask again in a second. */
  private stalled(held: Followed): void {
    const { id } = held.video
    if (this.followed.get(id) === held) this.followed.delete(id)
    const at = this.now()
    this.missing.set(id, at)
    const loggedAt = this.stalls.get(id)
    if (loggedAt != null && at - loggedAt < STALL_LOG_MS) return
    this.stalls.set(id, at)
    this.options.log?.(
      `live playlists: Valkey did not answer for ${id} in ${
        this.options.readTimeoutMs ?? READ_TIMEOUT_MS
      } ms; reading the Space`
    )
  }

  private usable(): boolean {
    return (
      this.following &&
      this.options.client.isReady &&
      (this.options.enabled?.() ?? true)
    )
  }

  private hear(message: string): void {
    const notice = parseLivePlaylistNotice(message)
    if (notice == null) return
    const held = this.followed.get(notice.v)
    if (held == null) return
    held.chain = held.chain.then(async () => {
      await this.update(held, notice)
    })
  }

  private async update(
    held: Followed,
    notice: LivePlaylistNotice
  ): Promise<void> {
    if (this.followed.get(held.video.id) !== held) return
    if (notice.g === held.gen && notice.n === held.count) return
    if (notice.g !== held.gen || notice.n < held.count) {
      await this.reload(held)
      return
    }
    const key = livePlaylistKey(this.options.prefix, held.video.id)
    try {
      // Only up to the notice's own length: a later push has its own notice.
      const entries = await this.options.client.lRange(
        key,
        held.count,
        notice.n - 1
      )
      if (this.followed.get(held.video.id) !== held) return
      if (entries.length !== notice.n - held.count) {
        await this.reload(held)
        return
      }
      this.take(held, entries)
    } catch (error) {
      this.fail(held, error)
    }
  }

  /** Reads the whole list and its generation, in one `MULTI`. */
  private async reload(held: Followed): Promise<void> {
    const { client, prefix } = this.options
    try {
      const [entries, gen] = (await client
        .multi()
        .lRange(livePlaylistKey(prefix, held.video.id), 0, -1)
        .get(livePlaylistGenKey(prefix, held.video.id))
        .exec()) as unknown as [string[], string | null]
      if (this.followed.get(held.video.id) !== held) return
      if (entries.length === 0) {
        this.followed.delete(held.video.id)
        this.missing.set(held.video.id, this.now())
        return
      }
      held.gen = Number(gen ?? 0)
      held.count = 0
      held.rewritten = ''
      held.closedAt = undefined
      this.take(held, entries)
    } catch (error) {
      this.fail(held, error)
    }
  }

  private take(held: Followed, entries: string[]): void {
    for (const text of entries) {
      held.rewritten += held.rewrite(text)
      if (held.closedAt == null && text.includes('#EXT-X-ENDLIST'))
        held.closedAt = this.now()
    }
    held.count += entries.length
    const { id } = held.video
    const grew = this.grown.get(id)
    if (grew?.gen !== held.gen || grew.count !== held.count)
      this.grown.set(id, { gen: held.gen, count: held.count, at: this.now() })
  }

  private fail(held: Followed, error: unknown): void {
    // A late failure of a copy already dropped says nothing about the next.
    if (this.followed.get(held.video.id) !== held) return
    this.followed.delete(held.video.id)
    this.missing.set(held.video.id, this.now())
    this.options.log?.(`live playlists: ${String(error)}`)
  }

  private sweep(at: number): void {
    for (const [id, held] of this.followed)
      if (
        (held.closedAt != null && at - held.closedAt > CLOSED_KEEP_MS) ||
        at - held.readAt > IDLE_KEEP_MS
      )
        this.followed.delete(id)
    for (const [id, failedAt] of this.missing)
      if (at - failedAt >= RETRY_MS) this.missing.delete(id)
    for (const [id, loggedAt] of this.stalls)
      if (at - loggedAt >= STALL_LOG_MS) this.stalls.delete(id)
    for (const [id, grew] of this.grown)
      if (!this.followed.has(id) && at - grew.at > IDLE_KEEP_MS)
        this.grown.delete(id)
    for (const [id, loggedAt] of this.stills)
      if (at - loggedAt >= STALL_LOG_MS) this.stills.delete(id)
  }
}
