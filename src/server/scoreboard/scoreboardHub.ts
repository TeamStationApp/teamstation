import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import { captureException } from '@sentry/node'
import { asObject, asString } from 'cleaners'
import type { Kysely } from 'kysely'
import { type RawData, WebSocket, WebSocketServer } from 'ws'

import { defaultScoreboardSettings } from '../../common/nodeSettings'
import {
  asDashboardCommand,
  asScoreboardUpdate,
  composeScoreboard,
  NO_OVERRIDES,
  SCOREBOARD_CLOSE,
  scoreboardOpen
} from '../../common/scoreboard'
import { adminScopes, canSeeGame, visibleScopes } from '../access'
import { actorForToken } from '../auth/sessions'
import { sessionToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { mayRunGame } from '../director/runGames'
import { speedHoldMs as nodeSpeedHoldMs } from '../nodeSettings'
import { type GameRecord, gameRecord, mayBeGameId } from './gameRecord'
import { logScoreboard, type ScoreboardLogCause } from './scoreboardLog'
import {
  parseScoreboardMessage,
  quit,
  type ScoreboardClient,
  type ScoreboardHash,
  type ScoreboardStore,
  ScoreboardUnavailable,
  type WriteResult
} from './scoreboardStore'

/**
 * A game's scoreboard over WebSockets, on one worker.
 *
 *   /api/v1/scoreboard/<gameId>/socket     anybody: the board as drawn
 *   …/socket?timeline=1                    the game's members: notice of each change
 *   /api/v1/scoreboard/<gameId>/publish    TS Watcher: partial states in
 *   /api/v1/scoreboard/<gameId>/dashboard  the override dashboard
 *
 * Every write, on any worker, is published on one Redis channel with the
 * whole hash after it, so each worker sends every state to its own sockets
 * without reading Redis again. Pub/sub keeps one channel's messages in
 * order, and each game's work here runs on one promise chain, so its sockets
 * see its states in the order they were written. Each socket remembers the
 * last version it was sent and is never sent one that is not newer: a socket
 * that opens mid-burst gets its first state and then only newer ones.
 *
 * Every write the hub makes, which is everything but the game's own scoring,
 * is also logged in Postgres (`scoreboardLog.ts`) by the worker that made it.
 *
 * A `timeline=1` socket is sent no boards. It is a player that draws the
 * board from `GET /games/:gameId/scoreboard-timeline`, and it is sent
 * `{"type":"changed"}` each time that timeline changes, on any worker, so it
 * fetches again. That notice is announced on a channel of its own once
 * everything the timeline reads has committed: by the play post's hook for a
 * game's scoring, and here after the log for every other write. The timeline
 * is read from Postgres and outlives the board in Redis, so such a socket is
 * admitted and kept for as long as the game exists, whether or not its live
 * board is open. What it is told, when a game is being scored and when its
 * dashboard moves, is the timeline's own business, so it is admitted on the
 * timeline's terms: signed in (cookie or `Authorization`, as the publisher
 * and the dashboard are), and able to see the game. The 60 s check asks
 * again. A plain viewer socket stays public, as the board it draws is.
 */

type Kind = 'viewer' | 'publisher' | 'dashboard'

interface Member {
  socket: WebSocket
  kind: Kind
  /** The version of the last state this socket was sent; -1 for none. */
  lastVersion: number
  /** Answered the last ping. */
  alive: boolean
  /** A `timeline=1` viewer: sent change notices, never boards. */
  timeline: boolean
  token?: string
  userId?: number
}

interface Room {
  gameId: string
  record: GameRecord
  members: Set<Member>
  /** This game's work, one step at a time, in order. */
  chain: Promise<void>
}

export interface ScoreboardHubOptions {
  db: Kysely<Database>
  store: ScoreboardStore
  /** A connection of its own that the hub subscribes on; already connecting. */
  subscriber: ScoreboardClient
  log: (message: string) => void
  now?: () => number
  /** How often each game with sockets is checked for having closed. */
  checkMs?: number
  /** How often every socket is pinged; one that missed the last is dropped. */
  pingMs?: number
  /**
   * How long a pitch speed stays on the board. A newer speed starts this
   * over. When it ends, the hub writes `pitchSpeed: 0` so every listener
   * drops the number. Without it, the node's `scoreboard.speedHoldSec`
   * setting, read again every `SETTINGS_MS`.
   */
  speedHoldMs?: number
}

export interface ScoreboardHub {
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  /** Closes every socket with 1001 and quits both Redis connections. */
  close: () => Promise<void>
}

const SOCKET_PATH =
  /^\/api\/v1\/scoreboard\/([^/]+)\/(socket|publish|dashboard)$/
const KIND_OF: Record<string, Kind> = {
  socket: 'viewer',
  publish: 'publisher',
  dashboard: 'dashboard'
}
/** Close code for a server that cannot reach Redis: retry, as after 1006. */
const UNAVAILABLE = 1011
const GOING_AWAY = 1001
const BAD_REQUEST = 'HTTP/1.1 400 Bad Request\r\n\r\n'
const CHANGED = JSON.stringify({ type: 'changed' })
/** How often the node's pitch-speed hold setting is read again. */
const SETTINGS_MS = 30000

export function makeScoreboardHub(
  options: ScoreboardHubOptions
): ScoreboardHub {
  const { db, store, subscriber, log } = options
  const now = options.now ?? store.now
  // The node's setting unless a test fixes it, kept current here because a
  // hold is armed in the middle of a message, with nothing to await.
  let speedHoldMs =
    options.speedHoldMs ?? defaultScoreboardSettings.speedHoldSec * 1000
  const readHold = (): void => {
    if (options.speedHoldMs != null) return
    nodeSpeedHoldMs(db)
      .then(ms => {
        speedHoldMs = ms
      })
      .catch((error: unknown) => {
        log(`scoreboard: the pitch-speed hold setting: ${describe(error)}`)
      })
  }
  readHold()
  const holdReader = setInterval(readHold, SETTINGS_MS)
  holdReader.unref?.()
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })
  const rooms = new Map<string, Room>()
  const everyone = new Set<Member>()
  /** One hold per game, armed only by a publisher's own pitch speed. */
  const speedHolds = new Map<string, ReturnType<typeof setTimeout>>()
  let closing = false

  function clearSpeedHold(gameId: string): void {
    const timer = speedHolds.get(gameId)
    if (timer == null) return
    clearTimeout(timer)
    speedHolds.delete(gameId)
  }

  /**
   * A pitch reading is good for `speedHoldMs`, then the board shows no speed.
   *
   * Armed here, on the worker that took the publisher's message, and never
   * from the pub/sub echo of that write — including the zero this timer
   * writes, which would otherwise clear itself forever. The timer is not the
   * socket's: a camera that drops off still owes the listeners a zero.
   */
  function armSpeedHold(gameId: string, startAt: number): void {
    clearSpeedHold(gameId)
    const timer = setTimeout(() => {
      speedHolds.delete(gameId)
      store
        .mergeWatcher(gameId, { pitchSpeed: 0 }, startAt)
        .then(async result => {
          await logWrite(gameId, result, 'speedHold', null)
        })
        .catch((error: unknown) => {
          if (error instanceof ScoreboardUnavailable) return
          log(`scoreboard ${gameId}: pitch speed: ${describe(error)}`)
        })
    }, speedHoldMs)
    speedHolds.set(gameId, timer)
  }

  /**
   * Logs a write in the scoreboard log once it has gone through. A failure
   * is reported and costs only the row: the board has changed whether or not
   * the log says so, and the publisher or dashboard that wrote it is not
   * told otherwise.
   */
  async function logWrite(
    gameId: string,
    result: WriteResult,
    cause: ScoreboardLogCause,
    actorId: number | null
  ): Promise<void> {
    if (result.kind !== 'written') return
    try {
      await logScoreboard(db, {
        gameId,
        version: result.message.version,
        at: result.now,
        cause,
        actorId,
        publisher: result.message.watcher,
        overrides: result.message.overrides ?? NO_OVERRIDES
      })
    } catch (error) {
      log(`scoreboard ${gameId}: scoreboard log: ${describe(error)}`)
      captureException(error)
      return
    }
    // The row has committed, or was not needed: either way a timeline read
    // from now on holds this write.
    try {
      await store.announceTimeline(gameId)
    } catch (error) {
      if (!(error instanceof ScoreboardUnavailable))
        log(`scoreboard ${gameId}: timeline notice: ${describe(error)}`)
    }
  }

  /** Runs a step on the game's chain; a failed step is logged, not fatal. */
  function enqueue(room: Room, step: () => Promise<void>): void {
    room.chain = room.chain.then(step).catch((error: unknown) => {
      if (error instanceof ScoreboardUnavailable) return
      log(`scoreboard ${room.gameId}: ${describe(error)}`)
    })
  }

  /** Sends each of the room's sockets the state, unless it has newer. */
  async function deliver(
    room: Room,
    hash: ScoreboardHash,
    only?: Member
  ): Promise<void> {
    for (const member of only == null ? room.members : [only])
      if (member.kind === 'dashboard') await authorizeCurrent(room, member)
    const overrides = hash.overrides ?? NO_OVERRIDES
    const { automated, final } = composeScoreboard({
      baseline: room.record,
      game: hash.game,
      watcher: hash.watcher,
      overrides
    })
    const viewerText = JSON.stringify(final)
    const dashboardText = JSON.stringify({
      type: 'state',
      automated,
      overrides,
      final,
      gameAt: hash.game?.receivedAt ?? null,
      watcherAt: hash.watcher?.receivedAt ?? null
    })
    for (const member of only == null ? room.members : [only]) {
      if (member.kind === 'publisher' || member.timeline) continue
      if (hash.version <= member.lastVersion) continue
      if (member.socket.readyState !== WebSocket.OPEN) continue
      member.lastVersion = hash.version
      member.socket.send(member.kind === 'viewer' ? viewerText : dashboardText)
    }
  }

  /** Reads a game's hash and sends it to whoever has not seen it. */
  async function catchUp(room: Room, only?: Member): Promise<void> {
    const hash = (await store.readScoreboard(room.gameId)) ?? {
      gameId: room.gameId,
      version: 0
    }
    await deliver(room, hash, only)
  }

  function onMessage(text: string): void {
    let message: ReturnType<typeof parseScoreboardMessage>
    try {
      message = parseScoreboardMessage(text)
    } catch (error) {
      log(`scoreboard: unreadable message: ${describe(error)}`)
      return
    }
    const room = rooms.get(message.gameId)
    if (room == null) return
    enqueue(room, async () => {
      if (message.field === 'game') {
        // A scored game may have changed its score or its teams too.
        try {
          room.record = (await gameRecord(db, room.gameId)) ?? room.record
        } catch (error) {
          log(`scoreboard ${room.gameId}: record: ${describe(error)}`)
        }
      }
      await deliver(room, message)
    })
  }

  /** A game's timeline changed: each of its `timeline=1` sockets is told. */
  function onTimeline(text: string): void {
    let gameId: string
    try {
      gameId = asTimelineNotice(JSON.parse(text)).gameId
    } catch (error) {
      log(`scoreboard: unreadable timeline notice: ${describe(error)}`)
      return
    }
    const room = rooms.get(gameId)
    if (room != null) noticeTimeline(room)
  }

  function noticeTimeline(room: Room): void {
    for (const member of room.members) {
      if (!member.timeline) continue
      if (member.socket.readyState !== WebSocket.OPEN) continue
      member.socket.send(CHANGED)
    }
  }

  /**
   * Messages published while a connection was down are lost, so each game
   * with sockets is read once whenever either connection is ready again. A
   * timeline notice lost the same way cannot be read back, so each
   * `timeline=1` socket is told its timeline may have changed: its socket
   * stayed open throughout, so nothing else would make it fetch again.
   */
  function resync(): void {
    for (const room of rooms.values()) {
      noticeTimeline(room)
      enqueue(room, async () => {
        await catchUp(room)
      })
    }
  }

  subscriber.subscribe(store.channel, onMessage).catch((error: unknown) => {
    log(`scoreboard: subscribe: ${describe(error)}`)
  })
  subscriber
    .subscribe(store.timelineChannel, onTimeline)
    .catch((error: unknown) => {
      log(`scoreboard: subscribe: ${describe(error)}`)
    })
  subscriber.on('ready', resync)
  store.onReady(resync)

  /**
   * Every 60 s: a game whose board has closed loses its sockets, 4404, but
   * for its `timeline=1` sockets, which stay until the game is gone.
   */
  const checker = setInterval(() => {
    for (const room of rooms.values()) {
      enqueue(room, async () => {
        const record = await gameRecord(db, room.gameId)
        const keyExists = await store.exists(room.gameId)
        if (record != null) room.record = record
        if (scoreboardOpen(record, keyExists, now())) {
          for (const member of room.members) {
            if (member.kind !== 'viewer') await authorizeCurrent(room, member)
            else if (member.timeline) await stillSees(room, member)
          }
          return
        }
        for (const member of room.members) {
          if (member.timeline && record != null) {
            await stillSees(room, member)
            continue
          }
          shut(
            member.socket,
            SCOREBOARD_CLOSE.closed,
            'The scoreboard is closed'
          )
        }
      })
    }
  }, options.checkMs ?? 60_000)

  /** Every 30 s: a socket that missed the last ping is gone. */
  const pinger = setInterval(() => {
    for (const member of everyone) {
      if (!member.alive) {
        member.socket.terminate()
        continue
      }
      if (member.socket.readyState !== WebSocket.OPEN) continue
      member.alive = false
      member.socket.ping()
    }
  }, options.pingMs ?? 30_000)

  function join(gameId: string, record: GameRecord, member: Member): Room {
    let room = rooms.get(gameId)
    if (room == null) {
      room = { gameId, record, members: new Set(), chain: Promise.resolve() }
      rooms.set(gameId, room)
    }
    room.record = record
    room.members.add(member)
    return room
  }

  function leave(gameId: string, member: Member): void {
    everyone.delete(member)
    const room = rooms.get(gameId)
    if (room == null) return
    room.members.delete(member)
    if (room.members.size === 0) rooms.delete(gameId)
  }

  /**
   * Decides whether a socket may stay, and joins it to its game. The first
   * state is read on the game's chain, after the socket has joined, so it is
   * ordered with every message around it.
   */
  async function admit(
    req: IncomingMessage,
    member: Member,
    gameId: string
  ): Promise<Room | undefined> {
    const { socket, kind } = member
    // No game has an id like this, so there is nothing to sign in to or to
    // wait for Redis about: it is unknown, and the client should stop.
    if (!mayBeGameId(gameId)) {
      shut(socket, SCOREBOARD_CLOSE.closed, 'The scoreboard is closed')
      return undefined
    }
    try {
      if (!store.isReady()) throw new ScoreboardUnavailable()
      let runner: { userId: number; isAdmin: boolean } | undefined
      if (kind !== 'viewer' || member.timeline) {
        const token = sessionToken(
          headerOf(req.headers.authorization),
          headerOf(req.headers.cookie)
        )
        runner = token == null ? undefined : await actorForToken(db, token)
        if (runner == null) {
          shut(socket, SCOREBOARD_CLOSE.notSignedIn, 'Sign in to continue')
          return undefined
        }
        member.token = token
        member.userId = runner.userId
      }
      const record = await gameRecord(db, gameId)
      const open = member.timeline
        ? record != null
        : scoreboardOpen(
            record,
            record == null ? false : await store.exists(gameId),
            now()
          )
      if (record == null || !open) {
        shut(socket, SCOREBOARD_CLOSE.closed, 'The scoreboard is closed')
        return undefined
      }
      if (
        kind !== 'viewer' &&
        runner != null &&
        !mayRunGame(
          await adminScopes(db, runner.userId, runner.isAdmin),
          record
        )
      ) {
        shut(socket, SCOREBOARD_CLOSE.notAllowed, 'You do not run this game')
        return undefined
      }
      if (
        member.timeline &&
        runner != null &&
        !(await maySeeGame(runner, gameId))
      ) {
        shut(socket, SCOREBOARD_CLOSE.notAllowed, 'This game is for members')
        return undefined
      }
      // A socket that closed while it was being admitted joins nothing and is
      // sent nothing, but what it sent before closing is still written, in
      // order, against a room of its own that no socket is in.
      if (socket.readyState !== WebSocket.OPEN) {
        return { gameId, record, members: new Set(), chain: Promise.resolve() }
      }
      const room = join(gameId, record, member)
      if (kind !== 'publisher' && !member.timeline) {
        enqueue(room, async () => {
          try {
            await catchUp(room, member)
          } catch (error) {
            if (error instanceof ScoreboardUnavailable) {
              shut(socket, UNAVAILABLE, 'The scoreboard is unavailable')
            }
            throw error
          }
        })
      }
      return room
    } catch (error) {
      if (!(error instanceof ScoreboardUnavailable)) {
        log(`scoreboard ${gameId}: admitting a socket: ${describe(error)}`)
      }
      shut(socket, UNAVAILABLE, 'The scoreboard is unavailable')
      return undefined
    }
  }

  /**
   * Whether this person may see the game: what `GET /games/:gameId/
   * scoreboard-timeline` asks before it answers, asked of the socket that
   * tells a player when to call it.
   */
  async function maySeeGame(
    actor: { userId: number; isAdmin: boolean },
    gameId: string
  ): Promise<boolean> {
    const game = await db
      .selectFrom('games')
      .select([
        'home_team_id as homeTeamId',
        'away_team_id as awayTeamId',
        'season_id as seasonId'
      ])
      .where('id', '=', gameId)
      .executeTakeFirst()
    if (game == null) return false
    return canSeeGame(
      await visibleScopes(db, actor.userId, actor.isAdmin),
      game
    )
  }

  /**
   * A `timeline=1` socket outlives the board, so the credential it opened
   * with and the membership it was admitted on are asked again at each check:
   * a session signed out, or a team left, ends it.
   */
  async function stillSees(room: Room, member: Member): Promise<void> {
    try {
      const actor =
        member.token == null
          ? undefined
          : await actorForToken(db, member.token, { recordUse: false })
      if (actor == null || actor.userId !== member.userId) {
        shut(member.socket, SCOREBOARD_CLOSE.notSignedIn, 'Sign in to continue')
        return
      }
      if (!(await maySeeGame(actor, room.gameId))) {
        shut(
          member.socket,
          SCOREBOARD_CLOSE.notAllowed,
          'This game is for members'
        )
      }
    } catch (error) {
      log(`scoreboard ${room.gameId}: authorization: ${describe(error)}`)
      shut(member.socket, UNAVAILABLE, 'The scoreboard is unavailable')
    }
  }

  /** Recheck the credential and current matchup before a private read or write. */
  async function authorizeCurrent(
    room: Room,
    member: Member
  ): Promise<boolean> {
    try {
      const actor =
        member.token == null
          ? undefined
          : await actorForToken(db, member.token, { recordUse: false })
      if (actor == null || actor.userId !== member.userId) {
        shut(member.socket, SCOREBOARD_CLOSE.notSignedIn, 'Sign in to continue')
        return false
      }
      const record = await gameRecord(db, room.gameId)
      if (
        record == null ||
        !scoreboardOpen(record, await store.exists(room.gameId), now())
      ) {
        shut(member.socket, SCOREBOARD_CLOSE.closed, 'The scoreboard is closed')
        return false
      }
      room.record = record
      if (
        !mayRunGame(await adminScopes(db, actor.userId, actor.isAdmin), record)
      ) {
        shut(
          member.socket,
          SCOREBOARD_CLOSE.notAllowed,
          'You do not run this game'
        )
        return false
      }
      return true
    } catch (error) {
      log(`scoreboard ${room.gameId}: authorization: ${describe(error)}`)
      shut(member.socket, UNAVAILABLE, 'The scoreboard is unavailable')
      return false
    }
  }

  /** One message from a publisher or a dashboard, written in its turn. */
  async function receive(
    room: Room,
    member: Member,
    data: RawData
  ): Promise<void> {
    if (!(await authorizeCurrent(room, member))) return
    const { socket } = member
    const refuse = (message: string): void => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ error: message }))
      }
    }
    let raw: unknown
    try {
      raw = JSON.parse(textOf(data))
    } catch {
      refuse('That message is not JSON')
      return
    }
    let write: () => Promise<WriteResult>
    let cause: ScoreboardLogCause
    let pitchSpeed: number | undefined
    try {
      if (member.kind === 'publisher') {
        const update = asScoreboardUpdate(raw)
        if (typeof update.pitchSpeed === 'number')
          pitchSpeed = update.pitchSpeed
        cause = 'publisher'
        write = async () =>
          await store.mergeWatcher(room.gameId, update, room.record.startAt)
      } else {
        const command = asDashboardCommand(raw)
        cause = command.type === 'overrides' ? 'dashboard' : 'reset'
        write = async () =>
          command.type === 'overrides'
            ? await store.writeOverrides(
                room.gameId,
                command.data,
                room.record.startAt
              )
            : await store.resetScoreboard(room.gameId, room.record.startAt)
      }
    } catch (error) {
      refuse(describe(error))
      return
    }
    try {
      const result = await write()
      if (result.kind === 'closed') {
        shut(socket, SCOREBOARD_CLOSE.closed, 'The scoreboard is closed')
        return
      }
      // A balls update is not a speed update, so it leaves the hold alone.
      // Zero cancels it: the publisher already said there is no speed, and
      // arming on zero would broadcast another zero when the timer fired.
      if (pitchSpeed != null) {
        if (pitchSpeed > 0) armSpeedHold(room.gameId, room.record.startAt)
        else clearSpeedHold(room.gameId)
      }
      // Logged before this socket's next message is written, so one socket's
      // rows arrive in the order of its writes.
      await logWrite(room.gameId, result, cause, member.userId ?? null)
    } catch (error) {
      if (!(error instanceof ScoreboardUnavailable)) {
        log(`scoreboard ${room.gameId}: write: ${describe(error)}`)
      }
      shut(socket, UNAVAILABLE, 'The scoreboard is unavailable')
    }
  }

  function connected(
    socket: WebSocket,
    req: IncomingMessage,
    gameId: string,
    kind: Kind,
    timeline: boolean
  ): void {
    const member: Member = {
      socket,
      kind,
      lastVersion: -1,
      alive: true,
      timeline
    }
    everyone.add(member)
    socket.on('pong', () => {
      member.alive = true
    })
    socket.on('error', (error: Error) => {
      log(`scoreboard ${gameId}: socket: ${error.message}`)
    })
    socket.on('close', () => {
      leave(gameId, member)
    })
    // Messages are listened for from the first moment and written one at a
    // time, in the order they came: `ws` does not wait for a handler, so
    // without this chain two partials could land out of order, and one sent
    // while the socket was still being admitted would be lost. A message that
    // arrived is written even when its socket has closed since, during its
    // admission or after it: it was sent. Only the replies are skipped.
    let inbound = admit(req, member, gameId)
    socket.on('message', (data: RawData) => {
      if (kind === 'viewer') return
      inbound = inbound.then(async room => {
        if (room == null) return room
        try {
          await receive(room, member, data)
        } catch (error) {
          log(`scoreboard ${gameId}: receiving: ${describe(error)}`)
        }
        return room
      })
    })
  }

  return {
    // This runs inside the server's `upgrade` listener, where anything thrown
    // would end the worker, so nothing may escape it: a failure is logged
    // and costs only this one socket.
    handleUpgrade: (req, socket, head) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const match = SOCKET_PATH.exec(url.pathname)
        if (match == null || closing) {
          socket.destroy()
          return
        }
        let gameId: string
        try {
          gameId = decodeURIComponent(match[1])
        } catch {
          refuseUpgrade(socket, BAD_REQUEST)
          return
        }
        const kind = KIND_OF[match[2]]
        const timeline =
          kind === 'viewer' && url.searchParams.get('timeline') === '1'
        wss.handleUpgrade(req, socket, head, ws => {
          try {
            connected(ws, req, gameId, kind, timeline)
          } catch (error) {
            log(`scoreboard ${gameId}: connecting a socket: ${describe(error)}`)
            ws.terminate()
          }
        })
      } catch (error) {
        log(`scoreboard: refusing an upgrade: ${describe(error)}`)
        socket.destroy()
      }
    },
    close: async () => {
      closing = true
      clearInterval(checker)
      clearInterval(pinger)
      clearInterval(holdReader)
      for (const timer of speedHolds.values()) clearTimeout(timer)
      speedHolds.clear()
      for (const member of everyone) {
        shut(member.socket, GOING_AWAY, 'The server is going away')
      }
      wss.close()
      await quit(subscriber)
      await store.close()
    }
  }
}

/**
 * Answers an upgrade with a plain HTTP status and closes it. The error
 * listener keeps a client that resets the connection meanwhile from throwing.
 */
function refuseUpgrade(socket: Duplex, response: string): void {
  socket.on('error', () => {})
  socket.once('finish', () => socket.destroy())
  socket.end(response)
}

const asTimelineNotice = asObject({ gameId: asString })

function shut(socket: WebSocket, code: number, reason: string): void {
  if (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  ) {
    socket.close(code, reason)
  }
}

function headerOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
