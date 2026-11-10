import { asArray, type Cleaner } from 'cleaners'

import {
  asGameDetail,
  asHomeLists,
  asMyRoles,
  asPage,
  asRosterEntry,
  asSeasonGame,
  asStoredGameAnswer,
  type ClientOptions,
  type HomeLists,
  IDEMPOTENCY_HEADER,
  type MyRoles,
  type RequestOptions,
  type SeasonGame,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { managesRoster } from '../../common/roles'
import {
  defaultsOf,
  olderSaveFoldsAlike,
  rebuildGameEvents
} from '../scoring/scoringSource'
import type { DocumentStore, StoredDocument } from './cacheStore'
import {
  CANDIDATES_KEPT,
  candidatesKey,
  candidatesTeamOf,
  documentKeyOf,
  fallbackKeyOf,
  GAMES_UPCOMING,
  HOME_LISTS
} from './documentKeys'
import {
  Outbox,
  type OutboxListener,
  type OutboxNoticeListener,
  type OutboxOptions,
  type OutboxSummary,
  queuedCallOf
} from './outbox'

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
}

/**
 * What a new team, season or game says while the last request could not
 * leave the device: they are made on the server, and never queued.
 */
export const OFFLINE_CREATE_MESSAGE = "Available when you're back online."

/** How many prefetch reads are out at once. */
export const PREFETCH_CONCURRENCY = 4

const asRaw: Cleaner<unknown> = raw => raw

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

  constructor(options: CachingClientOptions) {
    super(options)
    this.openCache = options.openCache
    this.outbox = new Outbox({
      store: async () => await this.owned?.store,
      // Checked again just before each send: a sign-in that set another
      // person's token while the queue read its file sends nothing of it.
      owns: () => this.owned != null,
      send: async (method, path, body, key) =>
        await super.request(
          method,
          path,
          asRaw,
          body,
          key == null ? {} : { headers: { [IDEMPOTENCY_HEADER]: key } }
        ),
      token: () => this.token,
      read: async path => {
        await this.request('GET', path, asRaw)
      },
      // The game and its rosters from the phone's copy; its plays from the
      // server, past this client, which answers the phone's copy while a save
      // of them is queued.
      rebuildEvents: async (gameId, log) => {
        const kept = async <T>(
          path: string,
          cleaner: Cleaner<T>
        ): Promise<T | undefined> => {
          const key = documentKeyOf(path)
          return key == null ? undefined : await this.cached(key, cleaner)
        }
        const id = encodeURIComponent(gameId)
        return await rebuildGameEvents(gameId, log, {
          game: async () => await kept(`/games/${id}`, asGameDetail),
          roster: async teamId => {
            const path = `/teams/${encodeURIComponent(teamId)}/roster`
            return (
              (await kept(
                `${path}?includeFullNames=true`,
                asArray(asRosterEntry)
              )) ?? (await kept(path, asArray(asRosterEntry)))
            )
          },
          defaults: async game => await defaultsOf(this, game),
          server: async () =>
            await super.request(
              'GET',
              `/games/${id}/events`,
              asStoredGameAnswer
            )
        })
      },
      olderSave: async (gameId, foldVersion) => {
        const id = encodeURIComponent(gameId)
        const key = documentKeyOf(`/games/${id}/events`)
        return await olderSaveFoldsAlike(foldVersion, {
          held: async () =>
            key == null
              ? undefined
              : await this.cached(key, asStoredGameAnswer),
          server: async () =>
            await super.request(
              'GET',
              `/games/${id}/events`,
              asStoredGameAnswer
            )
        })
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

  /** Sign-out: closes and deletes the open file, and leaves none open. */
  async signedOut(): Promise<void> {
    const opened = this.opened
    this.opened = undefined
    this.ownerToken = undefined
    this.outbox.reset()
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
    await this.closeQuietly(opened?.store)
  }

  /** Deletes `userId`'s file, whether it is the open one or not. */
  async discard(userId: string): Promise<void> {
    if (this.opened?.userId === userId) {
      await this.signedOut()
      return
    }
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
            options?.deviceLog
          )
    if (queued != null)
      return cleaner(
        background
          ? await this.outbox.submitBackground(queued)
          : await this.outbox.submit(queued)
      )
    const key = method === 'GET' ? documentKeyOf(path) : undefined
    if (key == null || opened == null) {
      const value = await super.request(method, path, cleaner, body, options)
      this.outbox.wake(true)
      const team = method === 'GET' ? candidatesTeamOf(path) : undefined
      if (team != null && opened != null)
        await this.keepCandidates(opened.store, team, value)
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
      fetched ?? (await this.cached(GAMES_UPCOMING, asArray(asSeasonGame)))

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

  /**
   * Adds the people a search for `teamId` found to the ones the phone keeps
   * for it, each once, the newest answer's first: what Add Existing Player
   * lists at once, and offline.
   */
  private async keepCandidates(
    store: Promise<DocumentStore | undefined>,
    teamId: string,
    found: unknown
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
        const fresh = new Set(found.map(idOf))
        const next = [
          ...found,
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
