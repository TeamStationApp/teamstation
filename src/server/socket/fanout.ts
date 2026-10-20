import type { Kysely } from 'kysely'
import { Client } from 'pg'

import type { GameChange } from '../../common/gameSocket'
import type { WalkUpSong } from '../../common/walkUpSong'
import type { GameScope } from '../access'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { playJson, playsDigest, readPlays } from '../events/postPlays'
import { lineupsAnswer } from '../events/teamLineups'
import { readWalkUpSong } from '../routes/walkUpSongs'
import {
  asGameChangePayload,
  GAME_CHANGES_CHANNEL,
  type GameChangePayload
} from './gameChanges'

/** Somebody subscribed to a game in this worker: one socket. */
export interface FanoutSubscriber {
  send: (message: GameChange) => void
  /** Check current rights using this delivery's connection, before each send. */
  maySee: (game: GameScope, db: Kysely<Database>) => Promise<boolean>
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
  /** Where the `LISTEN` connection goes: the same database as `db`. */
  databaseUrl: string
  /** Identical notifies within this long are sent once. */
  coalesceMs?: number
  /** How long to wait before listening again after the connection is lost. */
  retryMs?: number
  readSong?: SongReader
  now?: () => Date
  log?: (message: string) => void
  /**
   * The `LISTEN` connection was lost, so changes may have gone unheard.
   * Whoever holds the sockets closes them, and their clients resync.
   */
  onLost?: () => void
}

/**
 * One worker's end of `game_changes`.
 *
 * It holds one `LISTEN` connection for the worker, and knows which games its
 * sockets are subscribed to and each game's teams. On a notify it finds the
 * subscriptions the payload concerns — that game, or for a team's change
 * every subscribed game the team plays in — and if there are any, reads the
 * data once and sends it to each subscriber who may still see the game.
 * Notifies with the same payload within `coalesceMs` are sent once, with the
 * data as it stands at the end of that window.
 */
export class GameFanout {
  /** Settles once the first `LISTEN` is in place, or has failed. */
  readonly listening: Promise<void>
  private readonly db: Kysely<Database>
  private readonly databaseUrl: string
  private readonly coalesceMs: number
  private readonly retryMs: number
  private readonly readSong: SongReader
  private readonly now: () => Date
  private readonly log: (message: string) => void
  private readonly onLost: (() => void) | undefined
  private readonly watched = new Map<string, Watched>()
  private readonly waiting = new Map<string, ReturnType<typeof setTimeout>>()
  private client: Client | undefined
  /** Lost connections still hanging up, which close() waits for too. */
  private readonly hangingUp = new Set<Promise<void>>()
  private retry: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(options: GameFanoutOptions) {
    this.db = options.db
    this.databaseUrl = options.databaseUrl
    this.coalesceMs = options.coalesceMs ?? 100
    this.retryMs = options.retryMs ?? 1000
    this.readSong = options.readSong ?? readWalkUpSong
    this.now = options.now ?? (() => new Date())
    this.log =
      options.log ??
      (message => {
        console.error(`game socket: ${message}`)
      })
    this.onLost = options.onLost
    this.listening = this.listen()
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
    clearTimeout(this.retry)
    for (const timer of this.waiting.values()) clearTimeout(timer)
    this.waiting.clear()
    this.watched.clear()
    const client = this.client
    this.client = undefined
    if (client != null) this.hangUp(client)
    await Promise.all([...this.hangingUp])
  }

  /** Ends a connection, remembered until it has. */
  private hangUp(client: Client): void {
    const ending: Promise<void> = client
      .end()
      .catch(() => undefined)
      .finally(() => {
        this.hangingUp.delete(ending)
      })
    this.hangingUp.add(ending)
  }

  /** A notify, as the `LISTEN` connection hands it over. */
  notified(payload: string | undefined): void {
    if (payload == null || this.closed) return
    if (this.waiting.has(payload)) return
    this.waiting.set(
      payload,
      setTimeout(() => {
        this.waiting.delete(payload)
        this.deliver(payload).catch((error: unknown) => {
          this.log(`sending ${payload}: ${String(error)}`)
        })
      }, this.coalesceMs)
    )
  }

  /** Reads what a payload announces and sends it to its subscribers. */
  async deliver(payload: string): Promise<void> {
    let change: GameChangePayload
    try {
      change = asGameChangePayload(JSON.parse(payload))
    } catch {
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
    const song =
      'team' in change
        ? {
            teamId: change.team,
            userId: change.userId,
            song: await this.readSong(this.db, change.team, change.userId)
          }
        : undefined
    for (const gameId of games) {
      await atomic(this.db, async trx => {
        // Hold the current matchup while reading and authorizing its private
        // data. A revision cannot swap opponents between these two reads.
        const game = await trx
          .selectFrom('games')
          .selectAll()
          .where('id', '=', gameId)
          .forShare()
          .executeTakeFirst()
        const watched = this.watched.get(gameId)
        if (game == null || watched == null) return
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
          return
        const plays =
          change.kind === 'plays' ? await readPlays(trx, gameId) : []
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
                    homeScore: game.home_score
                  }
                }
              : change.kind === 'lineups'
                ? {
                    ...head,
                    kind: 'lineups',
                    data: await lineupsAnswer(trx, {
                      id: gameId,
                      home_team_id: game.home_team_id,
                      away_team_id: game.away_team_id,
                      currentPlay: game.currentPlay,
                      lineups_digest: game.lineups_digest
                    })
                  }
                : {
                    ...head,
                    kind: 'plays',
                    data: {
                      plays: plays.map(playJson),
                      currentPlay: game.currentPlay ?? null,
                      digest: playsDigest(plays, game.currentPlay)
                    }
                  }
        await Promise.all(
          [...watched.subscribers].map(async subscriber => {
            if (await subscriber.maySee(scope, trx)) subscriber.send(message)
          })
        )
      })
    }
  }

  private async listen(): Promise<void> {
    if (this.closed) return
    const client = new Client({ connectionString: this.databaseUrl })
    this.client = client
    client.on('notification', message => {
      if (this.client === client) this.notified(message.payload)
    })
    client.on('error', error => {
      this.lost(client, String(error))
    })
    client.on('end', () => {
      this.lost(client, 'the connection ended')
    })
    try {
      await client.connect()
      await client.query(`listen ${GAME_CHANGES_CHANNEL}`)
    } catch (error) {
      this.lost(client, String(error))
    }
  }

  /**
   * The `LISTEN` connection failed or went. Whatever was notified meanwhile
   * was never heard, so the sockets are told, and it listens again.
   */
  private lost(client: Client, why: string): void {
    if (this.client !== client || this.closed) return
    this.client = undefined
    this.log(`lost the ${GAME_CHANGES_CHANNEL} listener: ${why}`)
    this.hangUp(client)
    this.onLost?.()
    this.retry = setTimeout(() => {
      this.listen().catch(() => undefined)
    }, this.retryMs)
  }
}
