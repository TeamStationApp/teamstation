import {
  asScoreboardState,
  type ScoreboardState
} from '../../common/scoreboard'

/**
 * A scoreboard socket that keeps coming back.
 *
 * A board on a ball field loses its signal as a matter of course, and the
 * server restarts on every deploy. Every close is therefore followed by
 * another try 3 s later, except the closes that say trying again cannot
 * help: the board has closed (4404) or, for the dashboard, the caller is
 * signed out (4401) or does not run the game (4403).
 */
export const RECONNECT_MS = 3000

/** The one member of a WebSocket each client needs, so a test can fake it. */
export interface SocketLike {
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  onerror: ((event: unknown) => void) | null
  readyState: number
  send: (data: string) => void
  close: (code?: number) => void
}
export type SocketConstructor = new (url: string) => SocketLike

/** Runs `run` after `ms`, and returns how to call that off. */
export type Schedule = (run: () => void, ms: number) => () => void

export const realSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms)
  return () => {
    clearTimeout(timer)
  }
}

function realSocket(): SocketConstructor {
  return globalThis.WebSocket as unknown as SocketConstructor
}

const OPEN = 1

export interface ReconnectingSocket {
  /** Sends now when the socket is open; reports whether it went. */
  send: (data: string) => boolean
  /** Closes for good: no more tries, no more callbacks. */
  close: () => void
}

/**
 * Opens `url` and reopens it 3 s after any close whose code is not in
 * `stopOn`. A socket that could not even be constructed counts as a close.
 */
export function openReconnecting(options: {
  url: string
  stopOn: readonly number[]
  onOpen?: () => void
  onMessage: (data: unknown) => void
  onStop: (code: number) => void
  WebSocketImpl?: SocketConstructor
  schedule?: Schedule
}): ReconnectingSocket {
  const Impl = options.WebSocketImpl ?? realSocket()
  const schedule = options.schedule ?? realSchedule
  let socket: SocketLike | undefined
  let cancel: (() => void) | undefined
  let done = false

  const retry = (): void => {
    cancel = schedule(() => {
      cancel = undefined
      connect()
    }, RECONNECT_MS)
  }
  const connect = (): void => {
    if (done) return
    let next: SocketLike
    try {
      next = new Impl(options.url)
    } catch {
      retry()
      return
    }
    socket = next
    next.onopen = () => {
      if (!done) options.onOpen?.()
    }
    next.onmessage = event => {
      if (!done) options.onMessage(event.data)
    }
    next.onerror = () => undefined
    next.onclose = event => {
      if (done || socket !== next) return
      socket = undefined
      if (options.stopOn.includes(event.code)) {
        done = true
        options.onStop(event.code)
        return
      }
      retry()
    }
  }
  connect()

  return {
    send: data => {
      if (socket?.readyState !== OPEN) return false
      socket.send(data)
      return true
    },
    close: () => {
      done = true
      cancel?.()
      cancel = undefined
      const held = socket
      socket = undefined
      held?.close(1000)
    }
  }
}

/**
 * The viewer socket: every state the board should show, from the first one
 * the server sends on open, until the board closes (4404).
 */
export function connectScoreboard(options: {
  url: string
  onState: (state: ScoreboardState) => void
  onClosed: () => void
  WebSocketImpl?: SocketConstructor
  schedule?: Schedule
}): { close: () => void } {
  const socket = openReconnecting({
    url: options.url,
    stopOn: [4404],
    WebSocketImpl: options.WebSocketImpl,
    schedule: options.schedule,
    onMessage: data => {
      let state: ScoreboardState
      try {
        state = asScoreboardState(JSON.parse(String(data)))
      } catch {
        // A message this page cannot read changes nothing on the board.
        return
      }
      options.onState(state)
    },
    onStop: () => {
      options.onClosed()
    }
  })
  return { close: socket.close }
}
