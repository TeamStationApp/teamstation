import { asArray, type Cleaner } from 'cleaners'

import {
  asGameDetail,
  asHomeLists,
  asMyRoles,
  asPage,
  asSeasonGame,
  type ClientOptions,
  type GameDetail,
  type HomeLists,
  IDEMPOTENCY_HEADER,
  type MyRoles,
  type Page,
  type RequestOptions,
  type SeasonGame,
  storedGameOfEvents,
  type SwapSidesAnswer,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { managesRoster } from '../../common/roles'
import type { StoredGame } from '../../common/scoring/session'
import type { SwapDocumentsEffect } from '../../common/scoring/swapDocuments'
import {
  type CacheTransaction,
  type DocumentStore,
  type SchedulePage,
  schedulePageOf,
  type ServerDocument,
  type StoredDocument
} from './cacheStore'
import {
  CANDIDATES_KEPT,
  candidatesKey,
  candidatesTeamOf,
  candidatesWordsOf,
  documentKeyOf,
  fallbackKeyOf,
  gameKey,
  HOME_LISTS
} from './documentKeys'
import { type PictureDirectories, pictureDirectories } from './imageCache'
import {
  Outbox,
  type OutboxListener,
  type OutboxNoticeListener,
  type OutboxOptions,
  type OutboxSummary,
  queuedCallOf
} from './outbox'
import {
  FIRST_PAGE,
  ME_SCOPE,
  type ScheduleRead,
  scheduleReadOf,
  type ScheduleShape,
  shapeOfScope,
  WHOLE_LIST,
  windowName
} from './scheduleReads'

/** One person's file, open or opening. */
interface Opened {
  userId: string
  store: Promise<DocumentStore | undefined>
}

/** Opens one person's cache file. */
export type OpenDocumentCache = (userId: string) => Promise<DocumentStore>

export interface CachingClientOptions extends ClientOptions {
  openCache: OpenDocumentCache
  /** The outbox's clock, chance and timers, swapped out in tests. */
  outbox?: Pick<OutboxOptions, 'now' | 'random' | 'setTimer' | 'clearTimer'>
  /** The person's picture files; the platform's own unless a test swaps it. */
  pictureFiles?: PictureDirectories
}

/**
 * What a new team, season or game says while the last request could not
 * leave the device: they are made on the server, and never queued.
 */
export const OFFLINE_CREATE_MESSAGE = "Available when you're back online."

/** How many prefetch reads are out at once. */
export const PREFETCH_CONCURRENCY = 4

const asRaw: Cleaner<unknown> = raw => raw

/** A page as the server sends one, before its items are cleaned. */
type RawPage = Omit<Page<unknown>, 'counts'> & { counts: unknown }

const emptyPage = (): RawPage => ({
  items: [],
  nextCursor: null,
  prevCursor: null,
  anchorId: null,
  counts: null
})

/** When a game starts, for the All and Videos stand-ins; none sorts last. */
function startOf(game: unknown): number | undefined {
  const startAt =
    game != null && typeof game === 'object'
      ? (game as { startAt?: unknown }).startAt
      : undefined
  const time = typeof startAt === 'string' ? Date.parse(startAt) : NaN
  return Number.isNaN(time) ? undefined : time
}

/** Newest first, as the server orders All and Videos; no start time last. */
function newestFirst(a: unknown, b: unknown): number {
  const at = startOf(a)
  const bt = startOf(b)
  if (at == null || bt == null) return at == null ? (bt == null ? 0 : 1) : -1
  return bt - at
}

function isOffline(error: unknown): boolean {
  return error instanceof HttpError && error.code === 'offline'
}

/** The server's word that a record is gone, or not this person's to read. */
function isGone(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    (error.code === 'notFound' || error.code === 'forbidden')
  )
}

/** The game a stored-first read is of, or none for a person's or a team's. */
function gameOfPath(path: string): string | undefined {
  const match = /^\/games\/([^/?]+)/.exec(path)
  if (match == null) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return undefined
  }
}

/**
 * A swap queued on the phone: its answer, and the game and plays it wrote
 * swapped onto the phone, which the scoring screen opens again on at once.
 */
export interface QueuedSwap {
  answer: SwapSidesAnswer
  /** None when what it wrote is not a whole game: the screen reads it. */
  swapped?: { game: GameDetail; events: StoredGame }
}

/** A swap's answer as the queue gives it, with the documents it wrote. */
const asQueuedSwap: Cleaner<QueuedSwap> = raw => {
  const { documents, ...answer } = raw as SwapSidesAnswer & {
    documents?: { game: unknown; events: unknown }
  }
  // The swap is queued whatever its documents hold.
  try {
    return {
      answer,
      ...(documents == null
        ? {}
        : {
            swapped: {
              game: asGameDetail(documents.game),
              events: storedGameOfEvents(documents.events)
            }
          })
    }
  } catch {
    return { answer }
  }
}

/** The digest a stored answer carries, for a queued write to build on. */
function digestOf(raw: unknown): string | null {
  if (raw == null || typeof raw !== 'object') return null
  const { lineupsDigest, digest } = raw as Record<string, unknown>
  if (typeof lineupsDigest === 'string') return lineupsDigest
  if (typeof digest === 'string') return digest
  return null
}

/**
 * The phone's client: the same calls as `TeamStationClient`, with the GETs
 * the phone can show offline kept as documents in the signed-in person's
 * SQLite file (see `documentKeys.ts`).
 *
 * A GET of a document goes to the server as before. Its answer replaces the
 * document, with its digest, unless a queued write holds the
 * document (`pending`), in which case the stored body is the answer, whatever
 * the server said. A GET that cannot leave the device answers the stored
 * body, the first time as any other, and throws the usual offline error when
 * there is none.
 *
 * One of these lives as long as the app. The file stays closed until a user
 * id is known (`openFor`), and sign-out closes and deletes it.
 */
export class CachingClient extends TeamStationClient {
  private readonly openCache: OpenDocumentCache
  private opened: Opened | undefined

  private prefetching: Promise<void> | undefined
  private readonly outbox: Outbox
  /** Who hears that a stored-first read came back different, by game. */
  private readonly storedListeners = new Map<string, Set<() => void>>()

  /** The signed-in person's picture files, opened and deleted with the cache. */
  readonly pictureFiles: PictureDirectories

  constructor(options: CachingClientOptions) {
    super(options)
    this.openCache = options.openCache
    this.pictureFiles = options.pictureFiles ?? pictureDirectories
    // A picture is fetched again only while the server answers.
    this.pictureFiles.offline = this.offline
    this.subscribeOffline(offline => {
      this.pictureFiles.offline = offline
    })
    this.outbox = new Outbox({
      store: async () => await this.owned?.store,
      // Checked again just before each send: a sign-in that set another
      // person's token while the queue read its file sends nothing of it.
      owns: () => this.owned != null,
      // Every send of the queue gives up as no signal at the deadline.
      send: async (method, path, body, key) =>
        await super.request(method, path, asRaw, body, {
          deadline: true,
          ...(key == null ? {} : { headers: { [IDEMPOTENCY_HEADER]: key } })
        }),
      token: () => this.token,
      // A re-read is the server's copy, never the phone's pending one.
      read: async path => {
        await this.serverRead(path)
      },
      ...options.outbox
    })
  }

  /** The queue as it stands: how many writes, and which games are held. */
  async outboxSummary(): Promise<OutboxSummary> {
    return await this.outbox.summary()
  }

  /** Tells `listener` the queue each time it changes, until unsubscribed. */
  subscribeOutbox(listener: OutboxListener): () => void {
    return this.outbox.subscribe(listener)
  }

  /**
   * Tells `listener` what a queued write came to that its screen should say
   * (a lineup another device changed later, an add waiting on approval).
   */
  subscribeOutboxNotices(listener: OutboxNoticeListener): () => void {
    return this.outbox.subscribeNotices(listener)
  }

  /**
   * Sends what is queued, as far as it goes: the app came to the front, or
   * the network came back. Never called from the background.
   */
  async drainOutbox(): Promise<void> {
    await this.outbox.drain()
  }

  /**
   * Starts a drain without waiting for it. `reachable`, from the network
   * coming back, ends a wait that no signal began.
   */
  wakeOutbox(reachable = false): void {
    this.outbox.wake(reachable)
  }

  /**
   * Gives up the edits the phone still holds for a game the server stopped
   * (a stale lineup, a refusal) and reads the server's copy of what they
   * held: its plays, its lineups, and a refused player's roster. Answers
   * whether that copy came back; until it does, the phone has none.
   */
  async discardGame(gameId: string): Promise<boolean> {
    return await this.outbox.discard(`game:${gameId}`)
  }

  /**
   * Queues a swap of the game's home and away behind every write already
   * queued for it, and answers it at once from the phone's copy of the game
   * (`swappedDocuments`): the stored game, lineups and plays are written
   * swapped, and with `reset` the plays are gone; those swapped documents
   * come back with the answer, so the screen opens on them without reading
   * them again. Refused when the game is not on the phone, which it is once
   * scoring has opened it.
   */
  async queueSwap(
    gameId: string,
    effect: SwapDocumentsEffect
  ): Promise<QueuedSwap> {
    const game = await this.cached(gameKey(gameId), asRaw)
    const sides = (game ?? {}) as { homeTeamId?: unknown; awayTeamId?: unknown }
    if (
      typeof sides.homeTeamId !== 'string' ||
      typeof sides.awayTeamId !== 'string'
    )
      throw new HttpError(
        'unavailable',
        'This game is not on the phone yet. Try again in a moment.'
      )
    return await this.request(
      'POST',
      `/games/${encodeURIComponent(gameId)}/swap-sides`,
      asQueuedSwap,
      { homeTeamId: sides.homeTeamId, awayTeamId: sides.awayTeamId, effect },
      { queue: 'swap' }
    )
  }

  /**
   * Tells `listener` when a read scoring took stored-first for `gameId`
   * (the game, its plays, its rosters, the person's roles, the defaults)
   * came back from the server different from what the phone showed, until
   * unsubscribed: the screen reads the game again, as after a socket notice.
   */
  override onStoredChanged(gameId: string, listener: () => void): () => void {
    let listeners = this.storedListeners.get(gameId)
    if (listeners == null) {
      listeners = new Set()
      this.storedListeners.set(gameId, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.storedListeners.delete(gameId)
    }
  }

  /** Sends a game's held edits again, as they are, from the one refused. */
  async retryGame(gameId: string): Promise<void> {
    await this.outbox.retry(`game:${gameId}`)
  }

  /**
   * Gives up the players the phone added to a team and the server refused,
   * and reads the team's roster from the server. A game naming one of them
   * waits, parked, to be given up too.
   */
  async discardTeam(teamId: string): Promise<boolean> {
    return await this.outbox.discard(`team:${teamId}`)
  }

  /** Sends a team's refused players again. */
  async retryTeam(teamId: string): Promise<void> {
    await this.outbox.retry(`team:${teamId}`)
  }

  /** Whether the app is in front; the queue sends nothing behind it. */
  setActive(active: boolean): void {
    this.outbox.setActive(active)
  }

  override async createGroup(
    body: Parameters<TeamStationClient['createGroup']>[0]
  ): ReturnType<TeamStationClient['createGroup']> {
    this.refuseOffline()
    return await super.createGroup(body)
  }

  override async createTeamEvent(
    body: Parameters<TeamStationClient['createTeamEvent']>[0]
  ): ReturnType<TeamStationClient['createTeamEvent']> {
    this.refuseOffline()
    return await super.createTeamEvent(body)
  }

  override async proposeGame(
    body: Parameters<TeamStationClient['proposeGame']>[0]
  ): ReturnType<TeamStationClient['proposeGame']> {
    this.refuseOffline()
    return await super.proposeGame(body)
  }

  /**
   * A team, a season, an event and a game are made on the server, and only
   * there: with no signal they are refused before anything is sent or kept.
   */
  private refuseOffline(): void {
    if (this.offline) throw new HttpError('offline', OFFLINE_CREATE_MESSAGE)
  }

  /** Whose file is open, if any. */
  get cacheUser(): string | undefined {
    return this.opened?.userId
  }

  /**
   * The open file, while the client still holds the token it was opened
   * under: that person's session. A token set for anybody else (a sign-in
   * on its way to `openFor`) reads, stores and sends nothing through it.
   */
  private get owned(): Opened | undefined {
    const opened = this.opened
    return opened != null && this.token === this.ownerToken ? opened : undefined
  }

  /** The token `opened` belongs to. */
  private ownerToken: string | undefined

  /**
   * Opens `userId`'s file for the session the client's token now holds,
   * unless it is the one already open, closing any other. A file that will
   * not open is a cache that misses.
   */
  openFor(userId: string): void {
    const token = this.ownerToken
    this.ownerToken = this.token
    if (this.opened?.userId === userId) {
      // The same person, signed in again: what waited sends now.
      if (token !== this.token) this.outbox.wake()
      return
    }
    this.outbox.reset()
    this.pictureFiles.open(userId)
    const previous = this.opened
    this.opened = {
      userId,
      store: (async () => {
        await this.closeQuietly(previous?.store)
        try {
          return await this.openCache(userId)
        } catch {
          return undefined
        }
      })()
    }
    // What the last launch left queued goes as soon as it can.
    this.outbox.wake()
  }

  /**
   * Sign-out: closes and deletes the open file and the person's pictures,
   * and leaves none open.
   */
  async signedOut(): Promise<void> {
    const opened = this.opened
    this.opened = undefined
    this.ownerToken = undefined
    this.outbox.reset()
    const pictures = opened?.userId ?? this.pictureFiles.userId
    if (pictures != null) await this.pictureFiles.remove(pictures)
    const store = await opened?.store
    await store?.destroy().catch(() => undefined)
  }

  /**
   * The server refused the session: closes the person's file and keeps it,
   * and leaves none open. Nothing in it is read or sent until `openFor`
   * opens it again for that person's next session.
   */
  async sessionRefused(): Promise<void> {
    const opened = this.opened
    this.opened = undefined
    this.ownerToken = undefined
    this.outbox.reset()
    this.pictureFiles.close()
    await this.closeQuietly(opened?.store)
  }

  /**
   * Deletes `userId`'s file and pictures, whether they are the open ones or
   * not.
   */
  async discard(userId: string): Promise<void> {
    if (this.opened?.userId === userId) {
      await this.signedOut()
      return
    }
    await this.pictureFiles.remove(userId)
    let store: DocumentStore | undefined
    try {
      store = await this.openCache(userId)
    } catch {
      return
    }
    await store.destroy().catch(() => undefined)
  }

  override async cached<T>(
    key: string,
    cleaner: Cleaner<T>
  ): Promise<T | undefined> {
    const stored = await this.read(key)
    if (stored == null) return undefined
    try {
      return cleaner(JSON.parse(stored.body))
    } catch {
      return undefined
    }
  }

  /**
   * The games the phone stored for one schedule's window, as the `Page` its
   * screen paints before its own read returns: the stored first page and
   * every stored page its cursors reach, in order, each game once, with the
   * first page's counts and anchor. With no first page, the whole list
   * stored for it. Personal All and Videos, never read, stand in with the
   * games Upcoming and Past stored. Anything else stored nothing: an empty
   * page.
   */
  override async scheduleGames<T>(
    scope: string,
    window: string,
    cleaner: Cleaner<T>
  ): Promise<Page<T>> {
    const opened = this.owned
    const raw =
      opened == null
        ? undefined
        : await this.inStore(
            opened.store,
            async tx => await chainOf(tx, scope, window)
          )
    try {
      return asPage(cleaner)(raw ?? emptyPage())
    } catch {
      return asPage(cleaner)(emptyPage())
    }
  }

  /**
   * The outbox's read: always the server, whatever the phone holds. The
   * answer is recorded as the server's (`storeServer`), beside a body a
   * queued write still holds, and returned.
   */
  async serverRead(path: string): Promise<unknown> {
    const opened = this.owned
    const key = documentKeyOf(path)
    let raw: unknown
    try {
      raw = await super.request('GET', path, asRaw)
    } catch (error: unknown) {
      if (isGone(error) && opened != null && key != null)
        await this.forgetIn(opened.store, key)
      throw error
    }
    this.outbox.wake(true)
    if (opened != null && key != null && raw !== undefined)
      await this.storeServerTo(opened.store, key, {
        body: JSON.stringify(raw),
        revision: '0',
        serverDigest: digestOf(raw)
      })
    return raw
  }

  /**
   * Reads into the cache what the phone needs to score an upcoming game
   * with no signal, beside what Home stored: the person's roles, every
   * team's roster (whole names only where they manage it), and for each
   * upcoming game both sides' rosters, the game, its lineups, its plays and
   * each side's default lineup, and the first page Schedule opens on, so that
   * it paints without having been opened. Four at a time; a read that fails
   * is left for the next time. One prefetch runs at a time, and none while
   * offline.
   */
  async prefetch(): Promise<void> {
    if (this.owned == null || this.offline) return
    this.prefetching ??= this.prefetchOnce().finally(() => {
      this.prefetching = undefined
    })
    await this.prefetching
  }

  protected override async request<T>(
    method: string,
    path: string,
    cleaner: Cleaner<T>,
    body?: unknown,
    options?: RequestOptions
  ): Promise<T> {
    const opened = this.owned
    // A roster player, a lineup, a live play and a game-only player's
    // rename go through the queue, with the names kept beside a play. A
    // screen that does not wait queues its write and takes the phone's
    // answer at once, written onto the phone's documents as it is queued.
    const background = options?.background === true
    const queued =
      opened == null
        ? undefined
        : queuedCallOf(
            method,
            path,
            body,
            options?.deviceNames,
            background,
            options?.queue
          )
    if (queued != null)
      return cleaner(
        background
          ? await this.outbox.submitBackground(queued)
          : await this.outbox.submit(queued)
      )
    const schedule =
      method === 'GET' && opened != null ? scheduleReadOf(path) : undefined
    if (schedule != null && opened != null)
      return await this.scheduleRequest(
        opened,
        schedule,
        path,
        cleaner,
        body,
        options
      )
    const key = method === 'GET' ? documentKeyOf(path) : undefined
    if (key != null && opened != null && options?.storedFirst === true) {
      const shown = await this.readFrom(opened.store, key)
      let value: { cleaned: T } | undefined
      try {
        if (shown != null) value = { cleaned: cleaner(JSON.parse(shown.body)) }
      } catch {
        value = undefined
      }
      if (shown != null && value != null) {
        const { storedFirst: _first, ...rest } = options
        this.refreshStored(opened, key, path, shown.body, rest).catch(
          () => undefined
        )
        return value.cleaned
      }
    }
    if (key == null || opened == null) {
      const value = await super.request(method, path, cleaner, body, options)
      this.outbox.wake(true)
      const team = method === 'GET' ? candidatesTeamOf(path) : undefined
      if (team != null && opened != null)
        await this.keepCandidates(
          opened.store,
          team,
          value,
          candidatesWordsOf(path)
        )
      return value
    }

    let answered: { raw: unknown } | undefined
    let value: T
    try {
      value = await super.request(
        method,
        path,
        raw => {
          const cleaned = cleaner(raw)
          answered = { raw }
          return cleaned
        },
        body,
        options
      )
    } catch (error: unknown) {
      // The server says the record is gone, or no longer this person's: so
      // is the phone's copy, unless a queued write still holds it.
      if (isGone(error)) await this.forgetIn(opened.store, key)
      const held = await this.readFrom(opened.store, key)
      const stored =
        held?.pending === true
          ? held
          : !isOffline(error)
            ? undefined
            : (held ??
              (await this.readFallback(opened.store, fallbackKeyOf(key))))
      if (stored == null) throw error
      try {
        return cleaner(JSON.parse(stored.body))
      } catch {
        // A document this version cannot read is no document.
        throw error
      }
    }
    this.outbox.wake(true)
    const team = candidatesTeamOf(path)
    if (team != null)
      await this.keepCandidates(
        opened.store,
        team,
        value,
        candidatesWordsOf(path)
      )
    if (answered?.raw === undefined) return value
    const kept = await this.storeTo(opened.store, key, {
      body: JSON.stringify(answered.raw),
      // Answers carry no revision; the column stays for phones' files.
      revision: '0',
      serverDigest: digestOf(answered.raw)
    })
    if (kept?.pending !== true) return value
    try {
      return cleaner(JSON.parse(kept.body))
    } catch {
      return value
    }
  }

  /**
   * The read behind a stored-first answer: to the server, stored as any
   * read is, and told to the game's listeners when what the phone now holds
   * differs from what it showed. A read that fails changes nothing.
   */
  private async refreshStored(
    opened: Opened,
    key: string,
    path: string,
    shown: string,
    options: RequestOptions
  ): Promise<void> {
    try {
      await this.request('GET', path, asRaw, undefined, options)
    } catch {
      return
    }
    // Tag choices change no game.
    if (this.owned !== opened || path.startsWith('/tags')) return
    const now = await this.readFrom(opened.store, key)
    if (now == null || now.body === shown) return
    const gameId = gameOfPath(path)
    const told =
      gameId == null
        ? [...this.storedListeners.values()].flatMap(set => [...set])
        : [...(this.storedListeners.get(gameId) ?? [])]
    for (const listener of told) listener()
  }

  private async prefetchOnce(): Promise<void> {
    // Push before pull: what is queued goes first, so the reads find it.
    // The server answers, so a wait that no signal began is over.
    this.outbox.wake(true)
    await this.outbox.drain()
    const read = async <T>(
      path: string,
      cleaner: Cleaner<T>
    ): Promise<T | undefined> => {
      try {
        return await this.request('GET', path, cleaner)
      } catch {
        return undefined
      }
    }
    const [roles, lists, fetched] = await Promise.all([
      read<MyRoles>('/me/roles', asMyRoles),
      this.cached<HomeLists>(HOME_LISTS, asHomeLists),
      // Every upcoming game: these choose what is stored for scoring.
      read<SeasonGame[]>('/events?when=upcoming', asArray(asSeasonGame)),
      read('/events?paged=1&when=upcoming', asPage(asSeasonGame))
    ])
    // The games last stored stand in for a list that would not load.
    const upcoming =
      fetched ??
      (
        await this.scheduleGames(
          ME_SCOPE,
          windowName({ when: 'upcoming' }),
          asSeasonGame
        )
      ).items

    const paths = new Set<string>()
    const team = (teamId: string): void => {
      const id = encodeURIComponent(teamId)
      paths.add(`/teams/${id}/roster`)
      if (managesRoster(roles, teamId))
        paths.add(`/teams/${id}/roster?includeFullNames=true`)
    }
    for (const summary of lists?.teams ?? []) team(summary.id)
    for (const game of upcoming ?? []) {
      const id = encodeURIComponent(game.id)
      paths.add(`/games/${id}`)
      paths.add(`/games/${id}/lineups`)
      paths.add(`/games/${id}/events`)
      for (const [teamId, external] of [
        [game.homeTeamId, game.homeTeamExternal],
        [game.awayTeamId, game.awayTeamExternal]
      ] as const) {
        // A placeholder opponent has no roster of its own.
        if (external) continue
        team(teamId)
        paths.add(`/teams/${encodeURIComponent(teamId)}/default-lineup`)
      }
    }

    const queue = [...paths]
    const worker = async (): Promise<void> => {
      for (let path = queue.shift(); path != null; path = queue.shift())
        await read(path, asRaw)
    }
    await Promise.all(
      Array.from({ length: PREFETCH_CONCURRENCY }, async () => {
        await worker()
      })
    )
  }

  /**
   * A schedule read: to the server as before, its answer kept as one row per
   * game and the page it returned. With no signal, a first page answers
   * what `scheduleGames` paints (an empty page, not an error, when nothing
   * was stored), another page the stored page of that cursor, and a later
   * page never stored the offline error, for the list's Retry.
   */
  private async scheduleRequest<T>(
    opened: Opened,
    read: ScheduleRead,
    path: string,
    cleaner: Cleaner<T>,
    body: unknown,
    options: RequestOptions | undefined
  ): Promise<T> {
    const linked = read.cursorOnly
      ? await this.inStore(
          opened.store,
          async tx => await tx.scheduleWindowOf(read.scope, read.cursor)
        )
      : undefined
    const at = {
      scope: read.scope,
      window: linked ?? read.window,
      cursor: read.cursor
    }
    let answered: { raw: unknown } | undefined
    let value: T
    try {
      value = await super.request(
        'GET',
        path,
        raw => {
          const cleaned = cleaner(raw)
          answered = { raw }
          return cleaned
        },
        body,
        options
      )
    } catch (error: unknown) {
      if (!isOffline(error)) throw error
      const stored = await this.inStore(
        opened.store,
        async tx => await storedAnswer(tx, read, at.window)
      )
      if (stored === undefined) throw error
      try {
        return cleaner(stored)
      } catch {
        throw error
      }
    }
    this.outbox.wake(true)
    const kept = answered == null ? undefined : schedulePageOf(answered.raw, at)
    if (kept != null)
      await this.inStore(opened.store, async tx => {
        await tx.writeSchedule(read.shape, kept.page, kept.games)
      })
    return value
  }

  /** Runs `work` in the file; a file that cannot be read or written misses. */
  private async inStore<R>(
    store: Promise<DocumentStore | undefined>,
    work: (tx: CacheTransaction) => Promise<R>
  ): Promise<R | undefined> {
    try {
      return await (await store)?.atomically(work)
    } catch {
      return undefined
    }
  }

  private async read(key: string): Promise<StoredDocument | undefined> {
    const opened = this.owned
    return opened == null ? undefined : await this.readFrom(opened.store, key)
  }

  private async readFallback(
    store: Promise<DocumentStore | undefined>,
    key: string | undefined
  ): Promise<StoredDocument | undefined> {
    return key == null ? undefined : await this.readFrom(store, key)
  }

  /** A cache that cannot be read is one that misses. */
  private async readFrom(
    store: Promise<DocumentStore | undefined>,
    key: string
  ): Promise<StoredDocument | undefined> {
    try {
      return await (await store)?.read(key)
    } catch {
      return undefined
    }
  }

  /** A cache that cannot be written keeps what it held. */
  private async forgetIn(
    store: Promise<DocumentStore | undefined>,
    key: string
  ): Promise<void> {
    try {
      await (
        await store
      )?.atomically(async tx => {
        await tx.forget(key)
      })
    } catch {
      // Kept, then: the next answer from the server replaces it.
    }
  }

  /** A cache that cannot be written leaves the server's answer as it was. */
  private async storeTo(
    store: Promise<DocumentStore | undefined>,
    key: string,
    document: Omit<StoredDocument, 'pending'>
  ): Promise<StoredDocument | undefined> {
    try {
      return await (await store)?.store(key, document)
    } catch {
      return undefined
    }
  }

  /** A cache that cannot be written leaves the server's answer as it was. */
  private async storeServerTo(
    store: Promise<DocumentStore | undefined>,
    key: string,
    document: ServerDocument
  ): Promise<void> {
    try {
      await (await store)?.storeServer(key, document)
    } catch {
      // Kept as it was: the next answer from the server replaces it.
    }
  }

  /**
   * Adds the people a search for `teamId` found to the ones the phone keeps
   * for it, each once, the newest answer's first: what Add Existing Player
   * lists at once, and offline. Every answer counts, a typed search's as
   * much as the list with nothing typed, up to `CANDIDATES_KEPT`. Each
   * person keeps, as `matched`, the words of every search that found him
   * (`words`), so the phone finds him again by them offline although his
   * short name may not show the name they matched.
   */
  private async keepCandidates(
    store: Promise<DocumentStore | undefined>,
    teamId: string,
    found: unknown,
    words: readonly string[] = []
  ): Promise<void> {
    if (!Array.isArray(found) || found.length === 0) return
    const key = candidatesKey(teamId)
    try {
      await (
        await store
      )?.atomically(async tx => {
        const held = await tx.read(key)
        let kept: unknown[] = []
        try {
          const raw: unknown = held == null ? [] : JSON.parse(held.body)
          if (Array.isArray(raw)) kept = raw
        } catch {
          kept = []
        }
        const idOf = (raw: unknown): unknown =>
          raw != null && typeof raw === 'object'
            ? (raw as { userId?: unknown }).userId
            : undefined
        const matchedOf = (raw: unknown): string[] => {
          const matched =
            raw != null && typeof raw === 'object'
              ? (raw as { matched?: unknown }).matched
              : undefined
          return Array.isArray(matched)
            ? matched.filter(word => typeof word === 'string')
            : []
        }
        const before = new Map(kept.map(entry => [idOf(entry), entry]))
        const answered = found.map(entry => {
          const matched = [
            ...new Set([...matchedOf(before.get(idOf(entry))), ...words])
          ]
          return matched.length === 0 ||
            entry == null ||
            typeof entry !== 'object'
            ? entry
            : { ...entry, matched }
        })
        const fresh = new Set(found.map(idOf))
        const next = [
          ...answered,
          ...kept.filter(entry => !fresh.has(idOf(entry)))
        ].slice(0, CANDIDATES_KEPT)
        await tx.write(key, {
          body: JSON.stringify(next),
          revision: '0',
          serverDigest: null,
          pending: false
        })
      })
    } catch {
      // A file that cannot be written keeps what it held.
    }
  }

  private async closeQuietly(
    store: Promise<DocumentStore | undefined> | undefined
  ): Promise<void> {
    try {
      await (await store)?.close()
    } catch {
      // A file that will not close is let go.
    }
  }
}

/** The stored games of `ids` in `shape`, in that order, each once. */
async function gamesOf(
  tx: CacheTransaction,
  shape: ScheduleShape,
  ids: string[]
): Promise<unknown[]> {
  const order = [...new Set(ids)]
  const rows = new Map(
    (await tx.scheduleRows(shape, order)).map(row => [row.id, row.body])
  )
  const games: unknown[] = []
  for (const id of order) {
    const body = rows.get(id)
    if (body == null) continue
    try {
      games.push(JSON.parse(body))
    } catch {
      // A row this version cannot read is no row.
    }
  }
  return games
}

/** One stored page as the `Page` its read answered. */
async function pageOf(
  tx: CacheTransaction,
  shape: ScheduleShape,
  page: SchedulePage
): Promise<RawPage> {
  return { ...page.meta, items: await gamesOf(tx, shape, page.gameIds) }
}

/**
 * The stored first page of `scope`'s `window` and every stored page its
 * cursors lead to, as one page; else its whole list; else, for personal All
 * and Videos, the games Upcoming and Past stored; else an empty page.
 */
async function chainOf(
  tx: CacheTransaction,
  scope: string,
  window: string
): Promise<RawPage> {
  const shape = shapeOfScope(scope)
  const pages = new Map(
    (await tx.schedulePages(scope, [window])).map(page => [page.cursor, page])
  )
  const first = pages.get(FIRST_PAGE)
  if (first != null) {
    const seen = new Set<SchedulePage>([first])
    const follow = (
      from: SchedulePage,
      next: (page: SchedulePage) => string | null
    ): SchedulePage[] => {
      const reached: SchedulePage[] = []
      for (
        let page = pages.get(next(from) ?? '');
        page != null && !seen.has(page);
        page = pages.get(next(page) ?? '')
      ) {
        seen.add(page)
        reached.push(page)
      }
      return reached
    }
    const after = follow(first, page => page.meta.nextCursor)
    const before = follow(first, page => page.meta.prevCursor).reverse()
    const chain = [...before, first, ...after]
    return {
      items: await gamesOf(
        tx,
        shape,
        chain.flatMap(page => page.gameIds)
      ),
      nextCursor: (after.at(-1) ?? first).meta.nextCursor,
      prevCursor: (before[0] ?? first).meta.prevCursor,
      anchorId: first.meta.anchorId,
      counts: first.meta.counts
    }
  }
  const list = pages.get(WHOLE_LIST)
  if (list != null)
    return { ...emptyPage(), items: await gamesOf(tx, shape, list.gameIds) }
  const all = windowName({})
  const videos = windowName({ videos: true })
  if (scope !== ME_SCOPE || (window !== all && window !== videos))
    return emptyPage()
  // Never read: what Upcoming and Past stored, newest first.
  const shown = await tx.schedulePages(ME_SCOPE, [
    windowName({ when: 'upcoming' }),
    windowName({ when: 'past' })
  ])
  const games = (
    await gamesOf(
      tx,
      shape,
      shown.flatMap(page => page.gameIds)
    )
  ).filter(
    game =>
      window === all ||
      (game != null &&
        typeof game === 'object' &&
        Number((game as { videoCount?: unknown }).videoCount) > 0)
  )
  return { ...emptyPage(), items: games.sort(newestFirst) }
}

/**
 * What a schedule read answers with no signal: a first page as the screen
 * paints it, empty when nothing was stored; another page as stored, or none,
 * so that a list read past its last stored page fails as offline and offers
 * its Retry; a whole list as stored or none.
 */
async function storedAnswer(
  tx: CacheTransaction,
  read: ScheduleRead,
  window: string
): Promise<unknown> {
  if (read.paged && read.cursor === FIRST_PAGE)
    return await chainOf(tx, read.scope, window)
  const page = (await tx.schedulePages(read.scope, [window])).find(
    stored => stored.cursor === read.cursor
  )
  if (page == null) return undefined
  const stored = await pageOf(tx, read.shape, page)
  return read.paged ? stored : stored.items
}
