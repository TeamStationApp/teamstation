import { WebSocket } from 'ws'

import {
  asDashboardCommand,
  asScoreboardUpdate,
  carriesContested,
  type DashboardOverrides,
  NO_OVERRIDES,
  type ScoreboardState,
  type ScoreboardUpdate,
  withoutTeamNames
} from '../../src/common/scoreboard'

/**
 * Node clients for a scoreboard's publish and dashboard sockets, as TS
 * Watcher and the override dashboard use them.
 *
 *   node -r sucrase/register e2e/rigs/scoreboardPublish.ts \
 *     <host> <gameId> <token> '<json>'
 *
 * publishes one partial and prints what happened. `host` is the server's
 * origin, `http://127.0.0.1:9100` or `https://<seat>`, and the socket is the
 * matching `ws:` or `wss:` one. An empty token sends no Authorization.
 */

/**
 * How one socket's messages went: whether they were delivered, the replies,
 * and how the server closed it if it did.
 */
export interface SocketOutcome {
  /**
   * The messages are stored: the socket was open when every message was
   * sent and through the settle that followed, and afterwards the game's
   * dashboard state (`GET /scoreboard/<id>/dashboard`) shows what they said.
   * A socket the server closes straight after the handshake (1011 while
   * Redis comes back) never is: its messages were dropped unwritten, and
   * `closeCode` says why. One whose messages never show up in the stored
   * board within `STORED_MS` is not either, and `notStored` says what was
   * missing.
   */
  delivered: boolean
  replies: unknown[]
  closeCode?: number
  closeReason?: string
  /** Why messages sent on an open socket do not count as delivered. */
  notStored?: string
}

/** How long a sent message has to show up in the stored board. */
const STORED_MS = 5000

/** What `GET /scoreboard/<id>/dashboard` answers. */
interface DashboardView {
  automated: ScoreboardState
  overrides: DashboardOverrides
  watcherAt: number | null
}

/** The socket URL for one of a game's scoreboard paths. */
export function scoreboardSocketUrl(
  host: string,
  gameId: string,
  path: 'socket' | 'publish' | 'dashboard'
): string {
  const url = new URL(host)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/api/v1/scoreboard/${encodeURIComponent(gameId)}/${path}`
  return url.toString()
}

/**
 * Opens a socket, sends each message in order, and waits `settleMs` for a
 * reply or a close before closing it. Only messages that were sent on a
 * socket that stayed open through the settle, and then show up in the
 * stored board, are `delivered`; a socket refused at the door, or closed by
 * the server during the settle, comes back with its close code instead.
 */
export async function sendOver(
  url: string,
  token: string,
  messages: unknown[],
  settleMs = 500
): Promise<SocketOutcome> {
  const stored = await storedCheck(url, token, messages)
  const socket = new WebSocket(url, {
    headers: token === '' ? {} : { authorization: `Bearer ${token}` }
  })
  const outcome: SocketOutcome = { delivered: false, replies: [] }
  let serverClosed = false
  socket.on('message', data => {
    outcome.replies.push(JSON.parse((data as Buffer).toString('utf8')))
  })
  const closed = new Promise<void>(resolve => {
    socket.on('close', (code, reason) => {
      serverClosed = true
      outcome.closeCode = code
      outcome.closeReason = reason.toString('utf8')
      resolve()
    })
  })
  socket.on('error', () => undefined)
  await new Promise<void>(resolve => {
    socket.once('open', () => {
      resolve()
    })
    socket.once('close', () => {
      resolve()
    })
  })
  if (socket.readyState === WebSocket.OPEN) {
    for (const message of messages) socket.send(JSON.stringify(message))
    await Promise.race([
      closed,
      new Promise(resolve => setTimeout(resolve, settleMs))
    ])
    // Still open, with no close frame from the server on its way in.
    outcome.delivered = socket.readyState === WebSocket.OPEN && !serverClosed
  }
  if (socket.readyState === WebSocket.OPEN) {
    socket.close(1000)
    await closed
    // Our own close, not the server's: keep what the settle found.
    if (outcome.delivered) {
      delete outcome.closeCode
      delete outcome.closeReason
    }
  }
  if (outcome.delivered) {
    const missing = await stored()
    if (missing != null) {
      outcome.delivered = false
      outcome.notStored = missing
    }
  }
  return outcome
}

/**
 * Reads the game's dashboard state now, before the messages go, and returns
 * a check that waits up to `STORED_MS` for them to show in it: undefined
 * once they do, or what is still missing.
 *
 * - Publishes: each field they sent, but the team names, is in `automated`,
 *   and when one carries a contested field, `watcherAt` has moved on from
 *   what it was before, so a board that already read that way does not pass
 *   for a write.
 * - Dashboard messages: `overrides` is the last overrides sent, or after a
 *   reset, none, with no Watcher state.
 */
async function storedCheck(
  url: string,
  token: string,
  messages: unknown[]
): Promise<() => Promise<string | undefined>> {
  const parsed = new URL(url)
  const match = /^\/api\/v1\/scoreboard\/([^/]+)\/(publish|dashboard)$/.exec(
    parsed.pathname
  )
  if (match == null) return async () => undefined
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
  parsed.pathname = `/api/v1/scoreboard/${match[1]}/dashboard`
  const read = async (): Promise<DashboardView | undefined> => {
    try {
      const response = await fetch(parsed, {
        headers: token === '' ? {} : { authorization: `Bearer ${token}` }
      })
      if (response.status !== 200) return undefined
      return (await response.json()) as DashboardView
    } catch {
      return undefined
    }
  }
  let took: (view: DashboardView) => string | undefined
  try {
    if (match[2] === 'publish') {
      const sent: ScoreboardUpdate = {}
      for (const message of messages) {
        Object.assign(sent, withoutTeamNames(asScoreboardUpdate(message)))
      }
      const before = carriesContested(sent) ? (await read())?.watcherAt : null
      took = view => {
        const differs = Object.entries(sent).filter(
          ([key, value]) =>
            value !== undefined &&
            JSON.stringify(view.automated[key as keyof ScoreboardState]) !==
              JSON.stringify(value)
        )
        if (differs.length > 0) {
          return `the board does not show ${JSON.stringify(Object.fromEntries(differs))}`
        }
        if (
          before !== null &&
          (view.watcherAt == null ||
            (before != null && view.watcherAt <= before))
        ) {
          return `watcherAt did not move on from ${before}`
        }
        return undefined
      }
    } else {
      let wanted: DashboardOverrides | undefined
      let reset = false
      for (const message of messages) {
        const command = asDashboardCommand(message)
        reset = command.type === 'reset'
        wanted = command.type === 'overrides' ? command.data : NO_OVERRIDES
      }
      if (wanted == null) return async () => undefined
      const overrides = wanted
      took = view => {
        if (JSON.stringify(view.overrides) !== JSON.stringify(overrides)) {
          return `the overrides are ${JSON.stringify(view.overrides)}`
        }
        if (reset && view.watcherAt != null)
          return 'Watcher’s state is still there'
        return undefined
      }
    }
  } catch (error) {
    // A message the server refuses is never stored.
    const why = `a message is not valid: ${error instanceof Error ? error.message : String(error)}`
    return async () => why
  }
  return async () => {
    const deadline = Date.now() + STORED_MS
    let missing = 'the board could not be read'
    for (;;) {
      const view = await read()
      if (view != null) {
        const result = took(view)
        if (result == null) return undefined
        missing = result
      }
      if (Date.now() > deadline) return missing
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

/** Publishes one partial state, as TS Watcher does. */
export async function publish(
  host: string,
  gameId: string,
  token: string,
  partial: ScoreboardUpdate
): Promise<SocketOutcome> {
  return await sendOver(scoreboardSocketUrl(host, gameId, 'publish'), token, [
    partial
  ])
}

/** Sends the dashboard's whole overrides object. */
export async function override(
  host: string,
  gameId: string,
  token: string,
  overrides: DashboardOverrides
): Promise<SocketOutcome> {
  return await sendOver(scoreboardSocketUrl(host, gameId, 'dashboard'), token, [
    { type: 'overrides', data: overrides }
  ])
}

async function main(): Promise<void> {
  const [host, gameId, token, json] = process.argv.slice(2)
  if (host == null || gameId == null || token == null || json == null) {
    throw new Error(
      "Usage: node -r sucrase/register e2e/rigs/scoreboardPublish.ts <host> <gameId> <token> '<json>'"
    )
  }
  const outcome = await publish(
    host,
    gameId,
    token,
    JSON.parse(json) as ScoreboardUpdate
  )
  console.log(JSON.stringify(outcome))
}

if ((process.argv[1] ?? '').endsWith('/scoreboardPublish.e2e.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
