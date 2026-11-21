import { asArray, asObject, asString, type Cleaner } from 'cleaners'

import {
  asGameDetail,
  asHomeLists,
  asMyRoles,
  asPage,
  asRosterEntry,
  asSeasonGame,
  asStoredGameAnswer,
  type ClientOptions,
  eventInfoPath,
  type GameDetail,
  type HomeLists,
  IDEMPOTENCY_HEADER,
  type MyRoles,
  type Page,
  type RequestOptions,
  type RosterCandidate,
  type SeasonGame,
  type StoredChange,
  storedGameOfEvents,
  type SwapSidesAnswer,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { managesRoster } from '../../common/roles'
import type { StoredGame } from '../../common/scoring/session'
import type { SwapDocumentsEffect } from '../../common/scoring/swapDocuments'
import {
  defaultsOf,
  olderSaveFoldsAlike,
  rebuildGameEvents
} from '../scoring/scoringSource'
import { matchupLines, matchupTitle } from '../screens/format'
import { deleteDocumentCaches } from './cache'
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
  candidatesQueryOf,
  candidatesTeamOf,
  documentKeyOf,
  fallbackKeyOf,
  foundWords,
  gameKey,
  HOME_LISTS,
  HOME_TEAMS,
  PLACEHOLDER_TEAMS,
  PLACEHOLDERS_KEPT
} from './documentKeys'
import { type PictureDirectories, pictureDirectories } from './imageCache'
import {
  confirmedPlays,
  type DiscardOutcome,
  GAME_NOT_STORED_MESSAGE,
  type GivenUp,
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

/** Opens one person's cache for the API origin this client sends to. */
export type OpenDocumentCache = (
  userId: string,
  apiBaseUrl: string
) => Promise<DocumentStore>

export interface CachingClientOptions extends ClientOptions {
  openCache: OpenDocumentCache
  /** Account-wide file cleanup, independent of opening; defaults to the platform. */
  deleteCache?: (userId: string) => Promise<void>
  /** The outbox's clock, chance and timers, swapped out in tests. */
  outbox?: Pick<OutboxOptions, 'now' | 'random' | 'setTimer' | 'clearTimer'>
  /** The person's picture files; the platform's own unless a test swaps it. */
  pictureFiles?: PictureDirectories
  /** `REFRESH_RETRY_MS` unless a test shortens it. */
  refreshRetryMs?: number
}

/**
 * How long a read behind a stored answer that the server refused for now (a
 * 5xx, too many requests) first waits before it is tried again: twice as
 * long each time after, and given up after `REFRESH_TRIES`.
 */
export const REFRESH_RETRY_MS = 5000

/** How many refusals for now a read behind a stored answer is tried for. */
export const REFRESH_TRIES = 4

/**
 * What a new team, season or game says while the last request could not
 * leave the device: they are made on the server, and never queued.
 */
export const OFFLINE_CREATE_MESSAGE = "Available when you're back online."

/** How many prefetch reads are out at once. */
export const PREFETCH_CONCURRENCY = 4

/**
 * The games read ahead beside the upcoming ones: every game from this many
 * hours ago on, scored or not. Upcoming is a game with no score whose start
 * is still ahead, so neither the game under way at the field nor one scored
 * before its start is one.
 */
export const PREFETCH_STARTED_HOURS = 6

/** That read: `when=all` with a look-back is every game from then on. */
export const PREFETCH_NEAR_PATH = `/events?when=all&lookbackHours=${PREFETCH_STARTED_HOURS}`

/**
 * How far ahead a game's page and plans are read ahead: the games the phone
 * may be at with no signal, not the rest of the season.
 */
export const PREFETCH_DETAIL_HOURS = 48

const HOUR_MS = 3_600_000

const asRaw: Cleaner<unknown> = raw => raw
/** A stored team list's entry, for its name alone. */
const asNamedTeam = asObject({ id: asString, name: asString })

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

/** A refusal the server may lift soon: a 5xx, or too many requests. */
function refusedForNow(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    (error.status >= 500 || error.code === 'rateLimited')
  )
}

/** The server's word that a record is gone, or not this person's to read. */
function isGone(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    (error.code === 'notFound' || error.code === 'forbidden')
  )
}

/**
 * An answer of `GET /users?forTeam=` to `query`, each row's `matched` (the
 * folded words the server says found him) made the words of `query` that
 * did, as the search socket's rows are kept; none kept when none did.
 */
function withFoundWords(answer: unknown, query: string): unknown {
  if (!Array.isArray(answer)) return answer
  return answer.map((entry: unknown) => {
    if (entry == null || typeof entry !== 'object') return entry
    const { matched, ...row } = entry as { matched?: unknown }
    const words = foundWords(
      query,
      Array.isArray(matched)
        ? matched.filter(word => typeof word === 'string')
        : []
    )
    return words.length === 0 ? row : { ...row, matched: words }
  })
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
 * `work`, or an abort once `signal` aborts first: for work that takes no
 * signal itself, such as a read of the defaults.
 */
export async function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (signal == null) return await work
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  let stop = (): void => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => {
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', stop, { once: true })
  })
  try {
    return await Promise.race([work, aborted])
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

/** A presigned URL's query: its signature, which carries the time it was made. */
const SIGNED_QUERY = /\?[^"\\\s]*X-Amz-Signature=[^"\\\s]*/g

/**
 * A stored body with every presigned URL's signature taken off. A picture the
 * server signs is signed again on each read, at that moment, so two answers
 * that differ only by it say the same thing.
 */
export function unsignedBody(body: string): string {
  return body.replace(SIGNED_QUERY, '')
}

/**
 * Whether a presigned URL in `body` has expired by `now` (its `X-Amz-Date`
 * plus `X-Amz-Expires`): a picture drawn from it no longer downloads, so a
 * body signed again is news, however alike.
 */
export function expiredSignature(body: string, now: number): boolean {
  for (const [query] of body.matchAll(SIGNED_QUERY)) {
    const date = /X-Amz-Date=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(
      query
    )
    const expires = /X-Amz-Expires=(\d+)/.exec(query)
    if (date == null || expires == null) continue
    const [, y, mo, d, h, mi, se] = date.map(Number)
    const signed = Date.UTC(y, mo - 1, d, h, mi, se)
    if (signed + Number(expires[1]) * 1000 <= now) return true
  }
  return false
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
  private readonly deleteCache: (userId: string) => Promise<void>
  private readonly cacheCleanups = new Map<string, Promise<void>>()
  private opened: Opened | undefined

  private prefetching: Promise<void> | undefined
  /**
   * The stored answers whose read behind them did not reach the server,
   * by document: read again when the signal comes back, or after
   * `refreshRetryMs` when the server refused for now.
   */
  private readonly unrefreshed = new Map<
    string,
    {
      opened: Opened
      path: string
      shown: string
      options: RequestOptions
      /** How many reads of it in a row the server refused for now. */
      refused: number
    }
  >()

  /** The documents whose read behind is out: never sent twice at once. */
  private readonly refreshing = new Set<string>()

  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private readonly refreshRetryMs: number
  private readonly outbox: Outbox
  /** Who hears that a stored-first read came back different, by game. */
  private readonly storedListeners = new Map<
    string,
    Set<(change: StoredChange) => void>
  >()

  /**
   * What came back different while nobody listened for it, by game, and for
   * every game (`details`): a screen that opened on the stored copies
   * subscribes once it has drawn them, after its reads' refreshes may have
   * landed. Its first listener hears it then.
   */
  private readonly missedChanges = new Map<string, StoredChange>()
  private missedDetails = false

  /** The signed-in person's picture files, opened and deleted with the cache. */
  readonly pictureFiles: PictureDirectories

  constructor(options: CachingClientOptions) {
    super(options)
    this.openCache = options.openCache
    this.deleteCache = options.deleteCache ?? deleteDocumentCaches
    this.refreshRetryMs = options.refreshRetryMs ?? REFRESH_RETRY_MS
    // The signal back: what the phone showed with none is read again.
    this.subscribeOffline(offline => {
      if (!offline) this.refreshUnrefreshed()
    })
    this.pictureFiles = options.pictureFiles ?? pictureDirectories
    // A picture is fetched again only while the server answers.
    this.pictureFiles.offline = this.offline
    this.subscribeOffline(offline => {
      this.pictureFiles.offline = offline
    })
    this.outbox = new Outbox({
      store: async () => await this.owned?.store,
      ...(options.requestDeadlineMs == null
        ? {}
        : { requestDeadlineMs: options.requestDeadlineMs }),
      // A give-up's deadline cut off a request with no answer: as for any
      // request that misses its deadline.
      onCutOff: () => {
        this.deadlineMissed()
      },
      // Checked again just before each send: a sign-in that set another
      // person's token while the queue read its file sends nothing of it.
      owns: () => this.owned != null,
      // Every send of the queue gives up as no signal at the deadline, and
      // is aborted once a game given up stops waiting for it.
      send: async (method, path, body, key, signal) =>
        await super.request(method, path, asRaw, body, {
          deadline: true,
          ...(key == null ? {} : { headers: { [IDEMPOTENCY_HEADER]: key } }),
          ...(signal == null ? {} : { signal })
        }),
      token: () => this.token,
      // A re-read is the server's copy, never the phone's pending one.
      read: async path => {
        await this.serverRead(path)
      },
      // The game and its rosters from the phone's copy; its plays from the
      // server, past this client, which answers the phone's copy while a save
      // of them is queued.
      rebuildEvents: async (gameId, log, signal) => {
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
          defaults: async game =>
            await untilAborted(defaultsOf(this, game), signal),
          server: async () =>
            await super.request(
              'GET',
              `/games/${id}/events`,
              asStoredGameAnswer,
              undefined,
              signal == null ? {} : { signal }
            )
        })
      },
      olderSave: async (gameId, foldVersion, signal) => {
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
              asStoredGameAnswer,
              undefined,
              signal == null ? {} : { signal }
            )
        })
      },
      readCanonical: async (gameId, signal) => {
        const read = async (path: string): Promise<unknown> =>
          await super.request(
            'GET',
            path,
            asRaw,
            undefined,
            signal == null ? {} : { signal }
          )
        const id = encodeURIComponent(gameId)
        const [game, events] = await Promise.all([
          read(`/games/${id}`),
          read(`/games/${id}/events`)
        ])
        return { game, events }
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
   * Gives up every write the phone holds for a game another device swapped
   * or reset, once those of them already on their way are answered: the
   * queue sends no more of them from the call on, a send in flight lands as
   * the server judges it, and every one left is dropped and its documents
   * read again. Answers how many were given up: those the server did not
   * take, and those sent with no answer that its copy does not tell of.
   */
  async giveUpGame(gameId: string): Promise<GivenUp> {
    return await this.outbox.giveUp(`game:${gameId}`)
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
      throw new HttpError('unavailable', GAME_NOT_STORED_MESSAGE)
    // A reset names the plays it confirmed losing: the digest and
    // generation of the server's last answer. The queue puts the ones the
    // writes ahead of it answered in their place when it sends; these go
    // when it cannot read the file then.
    const confirmed =
      effect === 'reset'
        ? await confirmedPlays(async key => await this.read(key), gameId)
        : {}
    return await this.request(
      'POST',
      `/games/${encodeURIComponent(gameId)}/swap-sides`,
      asQueuedSwap,
      {
        homeTeamId: sides.homeTeamId,
        awayTeamId: sides.awayTeamId,
        ...confirmed,
        effect
      },
      { queue: 'swap' }
    )
  }

  /**
   * Tells `listener` when a read scoring took stored-first for `gameId`
   * (the game, its plays, its rosters, the person's roles, the defaults)
   * came back from the server different from what the phone showed, until
   * unsubscribed: the screen reads the game again, as after a socket notice.
   */
  override onStoredChanged(
    gameId: string,
    listener: (change: StoredChange) => void
  ): () => void {
    let listeners = this.storedListeners.get(gameId)
    if (listeners == null) {
      listeners = new Set()
      this.storedListeners.set(gameId, listeners)
    }
    listeners.add(listener)
    const missed = this.missedDetails
      ? 'details'
      : this.missedChanges.get(gameId)
    this.missedChanges.delete(gameId)
    this.missedDetails = false
    if (missed != null)
      queueMicrotask(() => {
        if (listeners.has(listener)) listener(missed)
      })
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

  /**
   * Gives up a held game's or team's edits as `discardGame` and
   * `discardTeam` do, answering what that came to: nothing dropped because
   * part of it was on its way, or dropped with the server's copy back, or
   * dropped without it.
   */
  async discardHeld(edit: {
    kind: 'game' | 'team'
    id: string
  }): Promise<DiscardOutcome> {
    return await this.outbox.discardOutcome(`${edit.kind}:${edit.id}`)
  }

  /** Sends a team's refused players again. */
  async retryTeam(teamId: string): Promise<void> {
    await this.outbox.retry(`team:${teamId}`)
  }

  /**
   * The names of held games and teams, by `game:<id>` and `team:<id>`, from
   * the phone's own documents and never the network: a game by its stored
   * matchup; a team by the person's stored team list, else as a side of a
   * held game, else as a side of any game a stored schedule holds (an
   * opponent whose new player was never put in a lineup). One the phone
   * cannot name is left out.
   */
  async heldNames(
    edits: ReadonlyArray<{ kind: 'game' | 'team'; id: string }>
  ): Promise<Record<string, string>> {
    const names: Record<string, string> = {}
    const sides = new Map<string, string>()
    const games = edits.filter(edit => edit.kind === 'game')
    const teamIds = edits
      .filter(edit => edit.kind === 'team')
      .map(edit => edit.id)
    const [details, teams] = await Promise.all([
      Promise.all(
        games.map(
          async edit => await this.cached(gameKey(edit.id), asGameDetail)
        )
      ),
      teamIds.length === 0
        ? []
        : this.cached(HOME_TEAMS, asArray(asNamedTeam)).then(
            listed => listed ?? []
          )
    ])
    games.forEach((edit, index) => {
      const game = details[index]
      if (game == null) return
      names[`game:${edit.id}`] = matchupTitle(matchupLines(game))
      sides.set(game.homeTeamId, game.homeTeamName)
      sides.set(game.awayTeamId, game.awayTeamName)
    })
    const unnamed: string[] = []
    for (const id of teamIds) {
      const name = teams.find(team => team.id === id)?.name ?? sides.get(id)
      if (name != null) names[`team:${id}`] = name
      else unnamed.push(id)
    }
    if (unnamed.length > 0) {
      const opened = this.owned
      const scheduled =
        opened == null
          ? undefined
          : await this.inStore(
              opened.store,
              async tx => await tx.scheduleTeamNames(unnamed)
            )
      for (const [id, name] of Object.entries(scheduled ?? {}))
        names[`team:${id}`] = name
    }
    return names
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
    this.forgetUnrefreshed()
    this.pictureFiles.open(userId)
    const previous = this.opened
    // Capture only cleanup already pending. A later sign-out may itself
    // await this open, so looking up its barrier later would deadlock.
    const cleanup = this.cacheCleanups.get(userId)
    this.opened = {
      userId,
      store: (async () => {
        await this.closeQuietly(previous?.store)
        await cleanup?.catch(() => undefined)
        try {
          return await this.openCache(userId, this.baseUrl)
        } catch (error) {
          // The session runs uncached; say why, or it looks like a cache bug.
          console.warn('Offline document cache unavailable:', error)
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
    this.forgetUnrefreshed()
    const pictures = opened?.userId ?? this.pictureFiles.userId
    if (pictures == null) return
    await this.cleanupCache(pictures, async () => {
      await this.pictureFiles.remove(pictures)
      const store = await opened?.store
      await store?.destroy().catch(() => undefined)
      await this.deleteCache(pictures).catch(() => undefined)
    })
  }

  /** Register before yielding so a new session cannot open into this sweep. */
  private async cleanupCache(
    userId: string,
    work: () => Promise<void>
  ): Promise<void> {
    const previous = this.cacheCleanups.get(userId)
    const pending = (async () => {
      await previous?.catch(() => undefined)
      await work()
    })()
    this.cacheCleanups.set(userId, pending)
    await pending.finally(() => {
      if (this.cacheCleanups.get(userId) === pending)
        this.cacheCleanups.delete(userId)
    })
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
    this.forgetUnrefreshed()
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
    await this.cleanupCache(userId, async () => {
      await this.pictureFiles.remove(userId)
      let store: DocumentStore | undefined
      try {
        store = await this.openCache(userId, this.baseUrl)
      } catch {
        // The file may be corrupt; account-wide removal does not need it open.
      }
      await store?.destroy().catch(() => undefined)
      await this.deleteCache(userId).catch(() => undefined)
    })
  }

  override async keepRosterCandidates(
    teamId: string,
    rows: ReadonlyArray<RosterCandidate & { matched?: string[] }>
  ): Promise<void> {
    const opened = this.owned
    if (opened == null) return
    await this.keepCandidates(opened.store, teamId, rows)
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
   * Reads into the cache what the phone needs to open, score and coach a
   * game with no signal, beside what Home stored: the person's roles, every
   * team's roster (whole names only where they manage it), and for each
   * game that starts from `PREFETCH_STARTED_HOURS` ago on, upcoming or
   * not: the game, and unless it was called off both sides' rosters, its
   * lineups, its plays and each side's default lineup; for one starting
   * within `PREFETCH_DETAIL_HOURS`, its event information (the game page's
   * first tab) and, for a game, its plans (Coach Game); and for a game
   * begun, its box score.
   * Also the first pages of Schedule's Upcoming and Past, so that they paint
   * without having been opened, and a game that has started is listed. Four at a time; a read that fails
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
            options?.deviceLog,
            options?.queue
          )
    if (queued?.kind === 'events')
      queued.lineupRecovery = options?.deviceLineupRecovery
    if (queued != null)
      return cleaner(
        background
          ? await this.outbox.submitBackground(queued)
          : await this.outbox.submit(queued, options?.handoff)
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
    // `offlineFirst`, with no signal already known: a stored read answers
    // at once, and a placeholder opponent's, never stored, fails as offline
    // at once, where waiting out its deadline first kept the screen on its
    // spinner for as many deadlines as it reads. The network is still asked, behind it,
    // and its answer brings the phone back online.
    const offlineFirst = options?.offlineFirst === true && this.offline
    if (
      key != null &&
      opened != null &&
      (options?.storedFirst === true || offlineFirst)
    ) {
      const shown =
        (await this.readFrom(opened.store, key)) ??
        (offlineFirst
          ? await this.readFallback(opened.store, fallbackKeyOf(key))
          : undefined)
      let value: { cleaned: T } | undefined
      try {
        if (shown != null) value = { cleaned: cleaner(JSON.parse(shown.body)) }
      } catch {
        value = undefined
      }
      if (shown != null && value != null) {
        const {
          storedFirst: _first,
          offlineFirst: _offline,
          ...rest
        } = options ?? {}
        this.refreshStored(opened, key, path, shown.body, rest).catch(
          () => undefined
        )
        return value.cleaned
      }
      // Nothing stored for a placeholder opponent, whose roster and default
      // lineup the phone never has: no signal is the answer, at once. The
      // server is still asked, behind it. Any other read asks it now.
      if (offlineFirst && (await this.placeholderRead(path))) {
        const { storedFirst: _first, offlineFirst: _offline, ...rest } = options
        this.request(method, path, asRaw, body, rest).catch(() => undefined)
        throw new HttpError(
          'offline',
          'Cannot reach TeamStation. Check your connection and try again.'
        )
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
          withFoundWords(value, candidatesQueryOf(path))
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
      if (options?.fromServer === true) throw error
      const held = await this.readFrom(opened.store, key)
      const stored =
        held?.pending === true
          ? held
          : !isOffline(error)
            ? undefined
            : (held ??
              (await this.readFallback(opened.store, fallbackKeyOf(key))))
      if (stored == null) throw error
      let answer: T
      try {
        answer = cleaner(JSON.parse(stored.body))
      } catch {
        // A document this version cannot read is no document.
        throw error
      }
      // A screen that opens on the phone's copies learned of no signal as
      // it read: the copy is read again once the signal comes back.
      if (
        options?.offlineFirst === true &&
        isOffline(error) &&
        !stored.pending
      ) {
        const { storedFirst: _first, offlineFirst: _offline, ...rest } = options
        this.unrefreshed.set(key, {
          opened,
          path,
          shown: stored.body,
          options: rest,
          refused: 0
        })
      }
      return answer
    }
    this.outbox.wake(true)
    const team = candidatesTeamOf(path)
    if (team != null)
      await this.keepCandidates(
        opened.store,
        team,
        withFoundWords(value, candidatesQueryOf(path))
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
   * Whether `path` reads a roster or default lineup of a team the schedule
   * has listed as a placeholder (`PLACEHOLDER_TEAMS`): one the server
   * answers no one, so the phone never stores it.
   */
  private async placeholderRead(path: string): Promise<boolean> {
    const match = /^\/teams\/([^/?]+)\/(roster|default-lineup)(\?|$)/.exec(path)
    if (match == null) return false
    let teamId: string
    try {
      teamId = decodeURIComponent(match[1])
    } catch {
      return false
    }
    const kept =
      (await this.cached<string[]>(PLACEHOLDER_TEAMS, asArray(asString))) ?? []
    return kept.includes(teamId)
  }

  /**
   * Adds the placeholder sides `games` list to the ones kept, newest first:
   * from the read-ahead's games and from every schedule page stored, so a
   * placeholder seen only on a team's or a past page is known too. A row
   * that does not say is no placeholder.
   */
  private async keepPlaceholders(
    games: readonly unknown[],
    store: Promise<DocumentStore | undefined> | undefined = this.owned?.store
  ): Promise<void> {
    const listed = games.flatMap(raw => {
      if (raw == null || typeof raw !== 'object') return []
      const game = raw as Record<string, unknown>
      return [
        ...(game.homeTeamExternal === true &&
        typeof game.homeTeamId === 'string'
          ? [game.homeTeamId]
          : []),
        ...(game.awayTeamExternal === true &&
        typeof game.awayTeamId === 'string'
          ? [game.awayTeamId]
          : [])
      ]
    })
    if (listed.length === 0) return
    try {
      await (
        await store
      )?.atomically(async tx => {
        const held = await tx.read(PLACEHOLDER_TEAMS)
        let kept: string[] = []
        try {
          kept = held == null ? [] : asArray(asString)(JSON.parse(held.body))
        } catch {
          kept = []
        }
        const next = [...new Set([...listed, ...kept])].slice(
          0,
          PLACEHOLDERS_KEPT
        )
        // The same teams, newest first: nothing to write.
        if (
          next.length === kept.length &&
          next.every((id, at) => id === kept[at])
        )
          return
        await tx.write(PLACEHOLDER_TEAMS, {
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

  /** Another person's file, or none: nothing of the last one is read again. */
  private forgetUnrefreshed(): void {
    this.unrefreshed.clear()
    this.refreshing.clear()
    if (this.refreshTimer != null) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
  }

  /** Reads again every stored answer whose read behind it had no answer. */
  private refreshUnrefreshed(): void {
    if (this.refreshTimer != null) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
    for (const [key, held] of [...this.unrefreshed]) {
      // Another person's, or no screen's now: nobody to tell.
      if (held.opened !== this.owned || !this.heardFor(held.path)) {
        this.unrefreshed.delete(key)
        continue
      }
      // Still out: its answer, or its deadline, settles it.
      if (this.refreshing.has(key)) continue
      this.refreshStored(
        held.opened,
        key,
        held.path,
        held.shown,
        held.options
      ).catch(() => undefined)
    }
  }

  /**
   * Once, after `refreshRetryMs`, twice as long for each refusal before: a
   * server that refused for now.
   */
  private refreshLater(): void {
    if (this.refreshTimer != null) return
    const refused = Math.max(
      1,
      ...[...this.unrefreshed.values()].map(held => held.refused)
    )
    this.refreshTimer = setTimeout(
      () => {
        this.refreshTimer = undefined
        if (!this.offline) this.refreshUnrefreshed()
      },
      this.refreshRetryMs * 2 ** (refused - 1)
    )
    ;(this.refreshTimer as { unref?: () => void }).unref?.()
  }

  /** Whether a screen listens for what a read of `path` changes. */
  private heardFor(path: string): boolean {
    const gameId = gameOfPath(path)
    return gameId == null
      ? this.storedListeners.size > 0
      : (this.storedListeners.get(gameId)?.size ?? 0) > 0
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
    this.refreshing.add(key)
    try {
      await this.request('GET', path, asRaw, undefined, {
        ...options,
        fromServer: true
      })
    } catch (error: unknown) {
      // Not read from the server: read again once it can be (no signal, or
      // the server refusing for now, a few times, waiting longer each), so a
      // screen that showed the phone's copy hears what changed. Any other
      // refusal is the server's word.
      const refused =
        (this.unrefreshed.get(key)?.refused ?? 0) +
        (refusedForNow(error) ? 1 : 0)
      if (
        this.owned === opened &&
        (isOffline(error) || refusedForNow(error)) &&
        refused < REFRESH_TRIES
      )
        this.unrefreshed.set(key, { opened, path, shown, options, refused })
      else this.unrefreshed.delete(key)
      if (refusedForNow(error) && !this.offline) this.refreshLater()
      return
    } finally {
      this.refreshing.delete(key)
    }
    this.unrefreshed.delete(key)
    // Tag choices change no game.
    if (this.owned !== opened || path.startsWith('/tags')) return
    const now = await this.readFrom(opened.store, key)
    if (
      now == null ||
      (unsignedBody(now.body) === unsignedBody(shown) &&
        !expiredSignature(shown, Date.now()))
    )
      return
    const gameId = gameOfPath(path)
    const told =
      gameId == null
        ? [...this.storedListeners.values()].flatMap(set => [...set])
        : [...(this.storedListeners.get(gameId) ?? [])]
    // Roles, rosters and default lineups are no one game's.
    const change: StoredChange = gameId == null ? 'details' : 'game'
    if (told.length === 0) {
      // Kept for the screen that is still opening on what it showed.
      if (gameId == null) this.missedDetails = true
      else if (this.missedChanges.get(gameId) !== 'details')
        this.missedChanges.set(gameId, change)
      return
    }
    for (const listener of told) listener(change)
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
      // Every game from the look-back on, upcoming or not: these choose
      // what is stored for scoring.
      read<SeasonGame[]>(PREFETCH_NEAR_PATH, asArray(asSeasonGame)),
      read('/events?paged=1&when=upcoming', asPage(asSeasonGame)),
      // Past's first page, where a game is listed once it has started: so
      // the game under way is there to tap with no signal.
      read('/events?paged=1&when=past', asPage(asSeasonGame))
    ])
    const now = Date.now()
    const since = now - PREFETCH_STARTED_HOURS * HOUR_MS
    // The games last stored stand in for a list that would not load: the
    // list's own copy, cut to the look-back again, else Upcoming's.
    const stored = await this.cached<SeasonGame[]>(
      PREFETCH_NEAR_PATH,
      asArray(asSeasonGame)
    )
    if (fetched != null) await this.keepPlaceholders(fetched)
    const games =
      fetched ??
      stored?.filter(
        game => game.startAt == null || Date.parse(game.startAt) >= since
      ) ??
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
    for (const game of games) {
      const id = encodeURIComponent(game.id)
      paths.add(`/games/${id}`)
      const startMs = game.startAt == null ? NaN : Date.parse(game.startAt)
      const soon =
        Number.isNaN(startMs) ||
        startMs <= now + PREFETCH_DETAIL_HOURS * HOUR_MS
      // A game called off opens on its page and its information (where the
      // call-off is), and nothing more.
      if (game.status === 'cancelled') {
        if (soon) paths.add(eventInfoPath(game.id))
        continue
      }
      paths.add(`/games/${id}/lineups`)
      paths.add(`/games/${id}/events`)
      // The game page opens on Info, and Coach Game reads the plans; the
      // server answers each person the sides they may plan.
      if (soon) {
        paths.add(eventInfoPath(game.id))
        if (game.eventKind !== 'event') paths.add(`/games/${id}/plans`)
      }
      // A game not begun has an empty box score, which Coach Game shows
      // without one; an event that is not a game has none.
      if (
        game.eventKind !== 'event' &&
        (game.homeScore != null || game.awayScore != null || startMs <= now)
      )
        paths.add(`/games/${id}/box-score`)
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
    // The window that issued the cursor. Two windows of a scope whose
    // pages end on the same game issue the same cursor: the read's own
    // window, when it is one of them, is the one.
    const linked = read.cursorOnly
      ? await this.inStore(
          opened.store,
          async tx =>
            await tx.scheduleWindowOf(read.scope, read.cursor, read.window)
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
    if (kept != null) {
      await this.inStore(opened.store, async tx => {
        await tx.writeSchedule(read.shape, kept.page, kept.games)
      })
      const raw = answered?.raw
      // Into the file the page went to, and not waited for.
      this.keepPlaceholders(
        Array.isArray(raw)
          ? raw
          : Array.isArray((raw as { items?: unknown } | undefined)?.items)
            ? (raw as { items: unknown[] }).items
            : [],
        opened.store
      ).catch(() => undefined)
    }
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
   * (a row's own `matched`), so the phone finds him again by them offline
   * although his short name may not show the name they matched.
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
            ...new Set([
              ...matchedOf(before.get(idOf(entry))),
              ...matchedOf(entry)
            ])
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
