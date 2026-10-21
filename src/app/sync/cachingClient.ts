import { asArray, type Cleaner } from 'cleaners'

import {
  asMyRoles,
  asSeasonGame,
  asTeamSummary,
  type ClientOptions,
  type MyRoles,
  type RequestOptions,
  type SeasonGame,
  TeamStationClient,
  type TeamSummary
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { managesRoster } from '../../common/roles'
import type { DocumentStore, StoredDocument } from './cacheStore'
import {
  documentKeyOf,
  fallbackKeyOf,
  GAMES_UPCOMING,
  HOME_TEAMS
} from './documentKeys'

/** One person's file, open or opening. */
interface Opened {
  userId: string
  store: Promise<DocumentStore | undefined>
}

/** Opens one person's cache file. */
export type OpenDocumentCache = (userId: string) => Promise<DocumentStore>

export interface CachingClientOptions extends ClientOptions {
  openCache: OpenDocumentCache
}

/** How many prefetch reads are out at once. */
export const PREFETCH_CONCURRENCY = 4

const asRaw: Cleaner<unknown> = raw => raw

function isOffline(error: unknown): boolean {
  return error instanceof HttpError && error.code === 'offline'
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
 * document, with its revision and digest, unless a queued write holds the
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

  constructor(options: CachingClientOptions) {
    super(options)
    this.openCache = options.openCache
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
    this.ownerToken = this.token
    if (this.opened?.userId === userId) return
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
  }

  /** Sign-out: closes and deletes the open file, and leaves none open. */
  async signedOut(): Promise<void> {
    const opened = this.opened
    this.opened = undefined
    this.ownerToken = undefined
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
   * each side's default lineup. Four at a time, without collecting
   * revisions into a screen's load; a read that fails is left for the next
   * time. One prefetch runs at a time, and none while offline.
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
    const key = method === 'GET' ? documentKeyOf(path) : undefined
    if (key == null || opened == null)
      return await super.request(method, path, cleaner, body, options)

    let answered: { raw: unknown; revision: string } | undefined
    let value: T
    try {
      value = await super.request(
        method,
        path,
        raw => {
          const cleaned = cleaner(raw)
          answered = { raw, revision: this.revisionFor(path) ?? '0' }
          return cleaned
        },
        body,
        options
      )
    } catch (error: unknown) {
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
    if (answered?.raw === undefined) return value
    const kept = await this.storeTo(opened.store, key, {
      body: JSON.stringify(answered.raw),
      revision: answered.revision,
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
    const read = async <T>(
      path: string,
      cleaner: Cleaner<T>
    ): Promise<T | undefined> => {
      try {
        return await this.request('GET', path, cleaner, undefined, {
          collect: false
        })
      } catch {
        return undefined
      }
    }
    const [roles, teams, fetched] = await Promise.all([
      read<MyRoles>('/me/roles', asMyRoles),
      this.cached<TeamSummary[]>(HOME_TEAMS, asArray(asTeamSummary)),
      read<SeasonGame[]>('/events?when=upcoming', asArray(asSeasonGame))
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
    for (const summary of teams ?? []) team(summary.id)
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
