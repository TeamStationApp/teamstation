import type { Kysely, Selectable } from 'kysely'

import { systemCancelled } from '../../common/gameApprovals'
import type { GameChange, PlayEditsData } from '../../common/gameSocket'
import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import { teamsOfRow } from '../../common/teamLists'
import type { WalkUpSong } from '../../common/walkUpSong'
import type { GameScope } from '../access'
import type { ValkeyCache } from '../cache/valkeyCache'
import type { ChangeFeed } from '../changeFeed/feed'
import { atomic } from '../db/atomic'
import {
  type Database,
  type GamesTable,
  isConnectionUnavailable
} from '../db/database'
import { atBatOf } from '../events/atBatInProgress'
import { playEditsOf, playsDigest, readPlays } from '../events/postPlays'
import {
  type LineupsGame,
  lineupsRead,
  namedLineups
} from '../events/teamLineups'
import { playForWire } from '../events/wireRecords'
import { readWalkUpSong } from '../routes/walkUpSongs'
import { resolveScoringPlays } from '../scoring/openRow'
import {
  asGameChangePayload,
  GAME_CHANGES_CHANNEL,
  type GameChangePayload,
  playEditsKey,
  type PlayEditsNotice
} from './gameChanges'

/** Somebody subscribed to a game in this worker: one socket. */
export interface FanoutSubscriber {
  send: (message: GameChange) => void
  /** The credential this socket opened with, asked about at each delivery. */
  token: string
  /** Who it was opened as. */
  userId: string
  /** The credential no longer answers as this person: ends the socket. */
  signedOut: () => void
  /** A change could not be sent, so this socket's client reads again. */
  resync: () => void
}

/**
 * Which of these subscribers may see the game now, in their order, read on
 * this delivery's connection. Costs the same however many there are.
 */
export type FanoutAuthorize = (
  subscribers: FanoutSubscriber[],
  game: GameScope,
  db: Kysely<Database>
) => Promise<boolean[]>

/** A walk-up song change, read once for all of the team's games. */
interface FanoutSong {
  teamId: string
  userId: string
  song: WalkUpSong | null
}

/** A game this worker has subscribers for; scope refreshes before delivery. */
interface Watched {
  scope: GameScope
  subscribers: Set<FanoutSubscriber>
}

/** A player's walk-up song on a team, as the socket sends it. */
export type SongReader = (
  db: Kysely<Database>,
  teamId: string,
  userId: string
) => Promise<WalkUpSong | null>

export interface GameFanoutOptions {
  db: Kysely<Database>
  /** The process's feed, on the same database as `db`. */
  feed: ChangeFeed
  /** Current rights, asked before every send. */
  authorize: FanoutAuthorize
  /**
   * Identical notifies within this long are sent once, unless they carry a
   * live post's edits (`fromDigest`), which are each sent, in order.
   */
  coalesceMs?: number
  readSong?: SongReader
  /**
   * Where a live post leaves the frame of its edits (`playEditsKey`), asked
   * once per notice. Without it, or without the frame, a worker reads and
   * names the noticed plays itself.
   */
  cache?: ValkeyCache
  now?: () => Date
  log?: (message: string) => void
  /**
   * The feed has returned after a gap, so changes may have gone unheard.
   * Whoever holds the sockets closes them, and their clients resync.
   */
  onResync?: () => void
}

/**
 * One worker's end of `game_changes`.
 *
 * It hears the worker's feed, and knows which games its
 * sockets are subscribed to and each game's teams. On a notify it finds the
 * subscriptions the payload concerns — that game, or for a team's change
 * every subscribed game the team plays in — and if there are any, reads the
 * data once and sends it to each subscriber who may still see the game.
 * Notifies with the same payload within `coalesceMs` are sent once, with the
 * data as it stands at the end of that window, unless they carry a live
 * post's edits: those are ordered steps between digests, and one that repeats
 * an earlier step still waiting may follow another that undid it, so each is
 * sent, in the order heard. A delivery that cannot get a
 * connection in time resyncs the game's subscribers instead of losing the
 * change.
 */
export class GameFanout {
  /** Settles once the channel is first in place, or that attempt has failed. */
  readonly listening: Promise<void>
  private readonly db: Kysely<Database>
  private readonly authorize: FanoutAuthorize
  private readonly coalesceMs: number
  private readonly readSong: SongReader
  private readonly cache: ValkeyCache | undefined
  private readonly now: () => Date
  private readonly log: (message: string) => void
  private readonly stopListening: () => void
  private readonly watched = new Map<string, Watched>()
  private readonly waiting = new Map<string, ReturnType<typeof setTimeout>>()
  /** Counts the edits notices waiting, each under a key of its own. */
  private heard = 0
  /** Each game's last delivery under way (`inTurn`). */
  private readonly turns = new Map<string, Promise<void>>()
  private closed = false

  constructor(options: GameFanoutOptions) {
    this.db = options.db
    this.authorize = options.authorize
    this.coalesceMs = options.coalesceMs ?? 100
    this.readSong = options.readSong ?? readWalkUpSong
    this.cache = options.cache
    this.now = options.now ?? (() => new Date())
    this.log =
      options.log ??
      (message => {
        console.error(`game socket: ${message}`)
      })
    const subscription = options.feed.subscribe(GAME_CHANGES_CHANNEL, {
      onPayload: payload => {
        this.notified(payload)
      },
      onListening: first => {
        if (!first) options.onResync?.()
      }
    })
    this.listening = subscription.listening
    this.stopListening = subscription.stop
  }

  /** Subscribes one socket to one game. Twice is once. */
  watch(gameId: string, scope: GameScope, subscriber: FanoutSubscriber): void {
    let watched = this.watched.get(gameId)
    if (watched == null) {
      watched = { scope, subscribers: new Set() }
      this.watched.set(gameId, watched)
    }
    watched.subscribers.add(subscriber)
  }

  unwatch(gameId: string, subscriber: FanoutSubscriber): void {
    const watched = this.watched.get(gameId)
    if (watched == null) return
    watched.subscribers.delete(subscriber)
    if (watched.subscribers.size === 0) this.watched.delete(gameId)
  }

  /** Every game this worker has at least one subscriber for. */
  games(): string[] {
    return [...this.watched.keys()]
  }

  async close(): Promise<void> {
    this.closed = true
    this.stopListening()
    for (const timer of this.waiting.values()) clearTimeout(timer)
    this.waiting.clear()
    this.watched.clear()
  }

  /**
   * A notify, as the feed hands it over. It is read once, here, and what it
   * reads as is what is delivered.
   */
  notified(payload: string | undefined): void {
    if (payload == null || this.closed) return
    const change = cleanedPayload(payload)
    // Every notice waits the same time, so they leave in the order heard; a
    // payload is JSON, so a counted key never meets one. A notify that does
    // not read is merged, and logged once when it is delivered.
    const key =
      change != null && carriesEdits(change) ? `${this.heard++}` : payload
    if (this.waiting.has(key)) return
    this.waiting.set(
      key,
      setTimeout(() => {
        this.waiting.delete(key)
        this.deliverChange(change, payload).catch((error: unknown) => {
          this.log(`sending ${payload}: ${String(error)}`)
        })
      }, this.coalesceMs)
    )
  }

  /** Reads what a payload announces and sends it to its subscribers. */
  async deliver(payload: string): Promise<void> {
    await this.deliverChange(cleanedPayload(payload), payload)
  }

  /** Sends what a payload, read as `change`, announces to its subscribers. */
  private async deliverChange(
    change: GameChangePayload | undefined,
    payload: string
  ): Promise<void> {
    if (change == null) {
      this.log(`ignoring a notify that does not read: ${payload}`)
      return
    }
    const games =
      'game' in change
        ? this.watched.has(change.game)
          ? [change.game]
          : []
        : [...this.watched.keys()]
    if (games.length === 0) return
    let song: FanoutSong | undefined
    if ('team' in change) {
      try {
        song = {
          teamId: change.team,
          userId: change.userId,
          song: await this.readSong(this.db, change.team, change.userId)
        }
      } catch (error) {
        if (!isConnectionUnavailable(error)) throw error
        for (const gameId of games) {
          const scope = this.watched.get(gameId)?.scope
          if (
            scope?.homeTeamId === change.team ||
            scope?.awayTeamId === change.team
          )
            this.resync(gameId)
        }
        return
      }
    }
    for (const gameId of games)
      await this.inTurn(gameId, async () => {
        try {
          await this.deliverGame(gameId, change, song)
        } catch (error) {
          if (!isConnectionUnavailable(error)) throw error
          this.resync(gameId)
        }
      })
  }

  /** A game's change went unsent: its subscribers read the game again. */
  private resync(gameId: string): void {
    const watched = this.watched.get(gameId)
    if (watched == null) return
    this.log(`resyncing ${gameId}: no database connection in time`)
    for (const subscriber of [...watched.subscribers]) subscriber.resync()
  }

  /**
   * Runs `step` once every delivery for `gameId` already under way is done.
   * The game row is let go once its subscribers are authorized, before the
   * plays or lineups are named and the message built and sent, so without
   * this a later notice could overtake an earlier one; in turn, each game's
   * notices go out in the order their data was read.
   */
  private async inTurn(
    gameId: string,
    step: () => Promise<void>
  ): Promise<void> {
    const turn = (this.turns.get(gameId) ?? Promise.resolve()).then(step)
    const settled = turn.catch(() => undefined)
    this.turns.set(gameId, settled)
    try {
      await turn
    } finally {
      if (this.turns.get(gameId) === settled) this.turns.delete(gameId)
    }
  }

  /** Reads one game's change and sends it to whoever may see it. */
  private async deliverGame(
    gameId: string,
    change: GameChangePayload,
    song: FanoutSong | undefined
  ): Promise<void> {
    // The frame a post left of its edits, asked for before the row is held.
    const frame =
      change.kind === 'playEdits' ? await this.postedFrame(change) : undefined
    const held = await atomic(this.db, async trx => {
      // Hold the current matchup while reading and authorizing its private
      // data. A revision cannot swap opponents between these two reads.
      // Naming and building wait for the commit, so a post's lock on the
      // row waits only for these reads.
      const game = await trx
        .selectFrom('games')
        .selectAll()
        .where('id', '=', gameId)
        .forShare()
        .executeTakeFirst()
      const watched = this.watched.get(gameId)
      if (game == null || watched == null) return undefined
      const scope: GameScope = {
        homeTeamId: game.home_team_id,
        awayTeamId: game.away_team_id,
        seasonId: game.season_id
      }
      watched.scope = scope
      if (
        'team' in change &&
        scope.homeTeamId !== change.team &&
        scope.awayTeamId !== change.team
      )
        return undefined
      // Taken once: a subscriber refused here closes, leaving the set.
      const subscribers = [...watched.subscribers]
      const seeing = await this.authorize(subscribers, scope, trx)
      return {
        game,
        lineups:
          change.kind === 'lineups'
            ? await lineupsRead(trx, lineupsGameOf(game))
            : undefined,
        recipients: subscribers.filter((_, i) => seeing[i])
      }
    })
    // Nobody here may see it: nothing to read, name or build.
    if (held == null || held.recipients.length === 0) return
    const { game } = held
    const head = {
      type: 'change' as const,
      gameId,
      at: this.now().toISOString()
    }
    const message: GameChange =
      change.kind === 'walkUpSong'
        ? { ...head, kind: 'walkUpSong', data: song! }
        : change.kind === 'game'
          ? {
              ...head,
              kind: 'game',
              data: {
                status: game.status,
                awayScore: game.away_score,
                homeScore: game.home_score,
                homeTeamId: game.home_team_id,
                awayTeamId: game.away_team_id,
                generation: game.play_generation,
                withdrawn: systemCancelled(game.cancellation_reason)
              }
            }
          : change.kind === 'lineups'
            ? {
                ...head,
                kind: 'lineups',
                data: await namedLineups(
                  this.db,
                  lineupsGameOf(game),
                  held.lineups!
                )
              }
            : {
                ...head,
                kind: 'playEdits',
                data:
                  game.play_generation !== change.generation
                    ? readAgain(game.play_generation)
                    : (frame ?? (await this.readEdits(game, change)))
              }
    for (const subscriber of held.recipients) subscriber.send(message)
  }

  /**
   * The frame a live post left in Valkey of the edits a notice names, or
   * nothing: a notice naming none, no cache, or the entry gone or unread.
   */
  private async postedFrame(
    change: PlayEditsNotice
  ): Promise<PlayEditsData | undefined> {
    const { fromDigest, digest, namesDigest } = change
    if (
      this.cache == null ||
      fromDigest == null ||
      digest == null ||
      namesDigest == null
    )
      return
    const raw = await this.cache.get(
      playEditsKey({ ...change, fromDigest, digest, namesDigest })
    )
    if (raw == null) return
    try {
      return JSON.parse(raw) as PlayEditsData
    } catch {
      return undefined
    }
  }

  /**
   * The edits a notice names, read and named here as the post named them
   * for everybody, once the row is let go: the game's plays are read and,
   * when they are still the ones the notice left, only the noticed indexes
   * and the at-bat are named. Otherwise, as for a notice naming no edits,
   * the subscribers read the game again. The edits carry the digest of the
   * book they are named from here, which a lapsed hold since the post may
   * have moved from the notice's: a viewer holding the notice's reads again.
   */
  private async readEdits(
    game: Selectable<GamesTable>,
    change: PlayEditsNotice
  ): Promise<PlayEditsData> {
    const { fromDigest, digest, namesDigest } = change
    if (fromDigest == null || digest == null)
      return readAgain(game.play_generation, digest, namesDigest)
    const rows = await readPlays(this.db, game.id)
    const whole = {
      plays: rows.map(row => row.gumbo as GumboPlay),
      currentPlay: atBatOf(game, rows.length > 0) as CurrentPlay | null
    }
    if (playsDigest(rows, whole.currentPlay) !== digest)
      return readAgain(game.play_generation, digest, namesDigest)
    const resolved = await resolveScoringPlays(this.db, whole, {
      only: change.indexes ?? [],
      gameId: game.id
    })
    const named = resolved.public
    const sides = teamsOfRow(game)
    return {
      generation: game.play_generation,
      fromDigest,
      digest,
      namesDigest: resolved.namesDigest,
      edits: playEditsOf(rows, named, change.removed ?? [], sides),
      currentPlay: playForWire(named.currentPlay, sides)
    }
  }
}

/** The fields of a game row its lineups are read and named from. */
function lineupsGameOf(game: Selectable<GamesTable>): LineupsGame {
  return {
    id: game.id,
    home_team_id: game.home_team_id,
    away_team_id: game.away_team_id,
    currentPlay: game.currentPlay,
    pregame: game.pregame,
    lineups_digest: game.lineups_digest,
    play_generation: game.play_generation
  }
}

/** A notify's payload as it reads, or nothing for one that does not. */
function cleanedPayload(payload: string): GameChangePayload | undefined {
  try {
    return asGameChangePayload(JSON.parse(payload))
  } catch {
    return undefined
  }
}

/**
 * Whether a notice carries a live post's edits, digests and all: one that is
 * not to be merged with an identical one.
 */
function carriesEdits(change: GameChangePayload): boolean {
  return change.kind === 'playEdits' && change.fromDigest != null
}

/**
 * A `playEdits` change that only says to read the game again, with the
 * digest the write left the plays at, and the book's it named them from,
 * when the notice names them: a screen that holds the plays' digest, as the
 * writer's own does, has nothing to read. Not across a generation, whose
 * reset sends its own notice.
 */
function readAgain(
  generation: number,
  digest: string | null = null,
  namesDigest: string | null = null
): PlayEditsData {
  return { generation, fromDigest: null, digest, namesDigest, edits: null }
}
