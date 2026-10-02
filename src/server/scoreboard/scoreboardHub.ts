import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import type { Kysely } from 'kysely'
import { type RawData, WebSocket, WebSocketServer } from 'ws'

import {
  asDashboardCommand,
  asScoreboardUpdate,
  composeScoreboard,
  NO_OVERRIDES,
  SCOREBOARD_CLOSE,
  scoreboardOpen
} from '../../common/scoreboard'
import { adminScopes } from '../access'
import { actorForToken } from '../auth/sessions'
import { sessionToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { mayRunGame } from '../director/runGames'
import { type GameRecord, gameRecord, mayBeGameId } from './gameRecord'
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
 */

type Kind = 'viewer' | 'publisher' | 'dashboard'

interface Member {
  socket: WebSocket
  kind: Kind
  /** The version of the last state this socket was sent; -1 for none. */
  lastVersion: number
  /** Answered the last ping. */
  alive: boolean
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
   * drops the number.
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

export function makeScoreboardHub(
  options: ScoreboardHubOptions
): ScoreboardHub {
  const { db, store, subscriber, log } = options
  const now = options.now ?? store.now
  const speedHoldMs = options.speedHoldMs ?? 5000
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
        .catch((error: unknown) => {
          if (error instanceof ScoreboardUnavailable) return
          log(`scoreboard ${gameId}: pitch speed: ${describe(error)}`)
        })
    }, speedHoldMs)
    speedHolds.set(gameId, timer)
  }

  /** Runs a step on the game's chain; a failed step is logged, not fatal. */
  function enqueue(room: Room, step: () => Promise<void>): void {
    room.chain = room.chain.then(step).catch((error: unknown) => {
      if (error instanceof ScoreboardUnavailable) return
      log(`scoreboard ${room.gameId}: ${describe(error)}`)
    })
  }

  /** Sends each of the room's sockets the state, unless it has newer. */
  function deliver(room: Room, hash: ScoreboardHash, only?: Member): void {
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
      if (member.kind === 'publisher') continue
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
    deliver(room, hash, only)
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
      deliver(room, message)
    })
  }

  /**
   * Messages published while a connection was down are lost, so each game
   * with sockets is read once whenever either connection is ready again.
   */
  function resync(): void {
    for (const room of rooms.values()) {
      enqueue(room, async () => {
        await catchUp(room)
      })
    }
  }

  subscriber.subscribe(store.channel, onMessage).catch((error: unknown) => {
    log(`scoreboard: subscribe: ${describe(error)}`)
  })
  subscriber.on('ready', resync)
  store.onReady(resync)

  /** Every 60 s: a game whose board has closed loses its sockets, 4404. */
  const checker = setInterval(() => {
    for (const room of rooms.values()) {
      enqueue(room, async () => {
        const record = await gameRecord(db, room.gameId)
        const keyExists = await store.exists(room.gameId)
        if (record != null) room.record = record
        if (scoreboardOpen(record, keyExists, now())) return
        for (const member of room.members) {
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
      if (kind !== 'viewer') {
        const token = sessionToken(
          headerOf(req.headers.authorization),
          headerOf(req.headers.cookie)
        )
        runner = token == null ? undefined : await actorForToken(db, token)
        if (runner == null) {
          shut(socket, SCOREBOARD_CLOSE.notSignedIn, 'Sign in to continue')
          return undefined
        }
      }
      const record = await gameRecord(db, gameId)
      const keyExists = record == null ? false : await store.exists(gameId)
      if (record == null || !scoreboardOpen(record, keyExists, now())) {
        shut(socket, SCOREBOARD_CLOSE.closed, 'The scoreboard is closed')
        return undefined
      }
      if (
        runner != null &&
        !mayRunGame(
          await adminScopes(db, runner.userId, runner.isAdmin),
          record
        )
      ) {
        shut(socket, SCOREBOARD_CLOSE.notAllowed, 'You do not run this game')
        return undefined
      }
      // A socket that closed while it was being admitted joins nothing and is
      // sent nothing, but what it sent before closing is still written, in
      // order, against a room of its own that no socket is in.
      if (socket.readyState !== WebSocket.OPEN) {
        return { gameId, record, members: new Set(), chain: Promise.resolve() }
      }
      const room = join(gameId, record, member)
      if (kind !== 'publisher') {
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

  /** One message from a publisher or a dashboard, written in its turn. */
  async function receive(
    room: Room,
    member: Member,
    data: RawData
  ): Promise<void> {
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
    let pitchSpeed: number | undefined
    try {
      if (member.kind === 'publisher') {
        const update = asScoreboardUpdate(raw)
        if (typeof update.pitchSpeed === 'number')
          pitchSpeed = update.pitchSpeed
        write = async () =>
          await store.mergeWatcher(room.gameId, update, room.record.startAt)
      } else {
        const command = asDashboardCommand(raw)
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
      if (pitchSpeed == null) return
      if (pitchSpeed > 0) armSpeedHold(room.gameId, room.record.startAt)
      else clearSpeedHold(room.gameId)
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
    kind: Kind
  ): void {
    const member: Member = { socket, kind, lastVersion: -1, alive: true }
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
        const match = SOCKET_PATH.exec(
          new URL(req.url ?? '/', 'http://localhost').pathname
        )
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
        wss.handleUpgrade(req, socket, head, ws => {
          try {
            connected(ws, req, gameId, kind)
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
