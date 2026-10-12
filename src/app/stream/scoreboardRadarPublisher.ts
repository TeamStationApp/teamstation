import { useEffect, useRef } from 'react'

import type { RadarState } from './phoneStreamClient'

/** How long a pitch speed stays on the board before the clear, as in TS Cameraman. */
export const PITCH_HOLD_MS = 5000
/** The clear: no pitch speed. Exit velocity is left as it is. */
export const PITCH_CLEAR = '{"pitchSpeed":0}'
/** The longest wait between two tries at the socket. */
const RETRY_MAX_MS = 30000
/** The server's refusals: signed out, not this person's game, no open board. Retrying repeats them. */
const REFUSALS = new Set([4401, 4403, 4404])
const OPEN = 1

/** The part of a WebSocket the publisher uses. */
export interface PublisherSocket {
  readonly readyState: number
  send: (text: string) => void
  close: () => void
  onopen: (() => void) | null
  onclose: ((event: { code?: number }) => void) | null
  onerror: ((event: unknown) => void) | null
}

/** Opens a socket to `url`, saying `headers` at the door. */
export type OpenPublisherSocket = (
  url: string,
  headers: Record<string, string>
) => PublisherSocket

export interface PublisherTimers {
  setTimeout: (work: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}

export interface ScoreboardRadarPublisherOptions {
  /** The API's base, `https://<host>/api/v1`. */
  apiBase: string
  gameId: string
  token: string
  open?: OpenPublisherSocket
  timers?: PublisherTimers
  now?: () => number
  holdMs?: number
}

export interface ScoreboardRadarPublisher {
  /** The radars as the engine reports them; each new reading is sent. */
  update: (state: RadarState | null) => void
  /** Closes the socket and drops anything waiting. */
  stop: () => void
}

/**
 * `wss://<host>/api/v1/scoreboard/<gameId>/publish` for an `https://` API
 * (`ws://` for `http://`), or null for an API with no host of its own.
 */
export function scoreboardPublishUrl(
  apiBase: string,
  gameId: string
): string | null {
  const base = apiBase.replace(/\/+$/, '')
  const match = /^(https?):\/\/(.+)$/i.exec(base)
  if (match == null) return null
  const scheme = match[1].toLowerCase() === 'https' ? 'wss' : 'ws'
  return `${scheme}://${match[2]}/scoreboard/${encodeURIComponent(gameId)}/publish`
}

/**
 * What a reading puts on the wire, as Cameraman words it: the pitch speed and
 * exit velocity that just arrived, each only when above zero. Null when there
 * is nothing to say.
 */
export function readingPayload(
  pitchMph: number | null,
  exitMph: number | null
): string | null {
  const parts: string[] = []
  if (pitchMph != null && pitchMph > 0)
    parts.push(`"pitchSpeed":${Math.round(pitchMph)}`)
  if (exitMph != null && exitMph > 0)
    parts.push(`"exitVelocity":${Math.round(exitMph)}`)
  return parts.length === 0 ? null : `{${parts.join(',')}}`
}

interface Seen {
  readingAt: number | null
  pitchMph: number | null
  exitMph: number | null
}

const defaultTimers: PublisherTimers = {
  setTimeout: (work, ms) => setTimeout(work, ms),
  clearTimeout: timer => {
    clearTimeout(timer as ReturnType<typeof setTimeout>)
  }
}

const defaultOpen: OpenPublisherSocket = (url, headers) =>
  // React Native's WebSocket takes the headers as its third argument.
  new (
    WebSocket as unknown as new (
      url: string,
      protocols: null,
      options: { headers: Record<string, string> }
    ) => PublisherSocket
  )(url, null, { headers })

/**
 * Sends the radars' readings to the game's scoreboard while a radar is
 * paired, as TS Cameraman does: `{"pitchSpeed":N,"exitVelocity":M}` for each
 * reading, and `{"pitchSpeed":0}` five seconds after a pitch unless another
 * comes first. With several radars, the latest reading across them wins: one
 * older than a reading already sent is not sent.
 *
 * The engine reports each radar's last pitch and exit with the time of the
 * latest of them, so a reading is a new `readingAt`, and of its two numbers
 * the one that changed is the one that arrived (both, when neither did: the
 * same speed twice). Readings from before the publisher started are not sent.
 *
 * The socket opens with the bearer token and is opened again, backing off,
 * when it drops; a refusal (signed out, not this person's game, no open
 * board) ends the tries.
 */
export function makeScoreboardRadarPublisher(
  options: ScoreboardRadarPublisherOptions
): ScoreboardRadarPublisher {
  const {
    apiBase,
    gameId,
    token,
    open = defaultOpen,
    timers = defaultTimers,
    now = Date.now,
    holdMs = PITCH_HOLD_MS
  } = options
  const url = scoreboardPublishUrl(apiBase, gameId)
  const since = now()
  const seen = new Map<string, Seen>()
  let lastSentAt = -Infinity
  let socket: PublisherSocket | null = null
  let pending: string[] = []
  let active = false
  let refused = false
  let stopped = false
  let attempts = 0
  let retry: unknown = null
  let hold: unknown = null

  const connect = (): void => {
    if (url == null || socket != null || refused || stopped || !active) return
    const opened = open(url, { Authorization: `Bearer ${token}` })
    socket = opened
    opened.onopen = () => {
      attempts = 0
      const waiting = pending
      pending = []
      for (const text of waiting) opened.send(text)
    }
    opened.onerror = () => {}
    opened.onclose = event => {
      if (socket !== opened) return
      socket = null
      if (event.code != null && REFUSALS.has(event.code)) {
        refused = true
        pending = []
        return
      }
      if (!active || stopped) return
      const wait = Math.min(1000 * 2 ** attempts, RETRY_MAX_MS)
      attempts += 1
      retry = timers.setTimeout(() => {
        retry = null
        connect()
      }, wait)
    }
  }

  const disconnect = (): void => {
    if (retry != null) {
      timers.clearTimeout(retry)
      retry = null
    }
    const closing = socket
    socket = null
    pending = []
    closing?.close()
  }

  const send = (text: string, reading: boolean): void => {
    if (url == null || refused) return
    if (socket?.readyState === OPEN) {
      socket.send(text)
      return
    }
    // A newer reading replaces one still waiting for the socket.
    pending = reading ? [text] : [...pending, text]
    connect()
  }

  const clearHold = (): void => {
    if (hold == null) return
    timers.clearTimeout(hold)
    hold = null
  }

  return {
    update: state => {
      if (stopped) return
      const devices = state?.enabled === true ? state.devices : []
      active = devices.length > 0
      if (!active) {
        disconnect()
      } else {
        connect()
      }
      let latest: {
        at: number
        pitch: number | null
        exit: number | null
      } | null = null
      for (const device of devices) {
        const before = seen.get(device.serial)
        seen.set(device.serial, {
          readingAt: device.readingAt,
          pitchMph: device.pitchMph,
          exitMph: device.exitMph
        })
        const at = device.readingAt
        if (at == null || at <= since) continue
        if (before?.readingAt != null && at <= before.readingAt) continue
        if (latest != null && at <= latest.at) continue
        // Undefined before the first report: a first reading is all new.
        const pitchChanged = device.pitchMph !== before?.pitchMph
        const exitChanged = device.exitMph !== before?.exitMph
        const same = !pitchChanged && !exitChanged
        latest = {
          at,
          pitch: pitchChanged || same ? device.pitchMph : null,
          exit: exitChanged || same ? device.exitMph : null
        }
      }
      if (latest == null || latest.at <= lastSentAt) return
      const text = readingPayload(latest.pitch, latest.exit)
      if (text == null) return
      lastSentAt = latest.at
      if (latest.pitch != null && latest.pitch > 0) {
        clearHold()
        hold = timers.setTimeout(() => {
          hold = null
          send(PITCH_CLEAR, false)
        }, holdMs)
      }
      send(text, true)
    },
    stop: () => {
      stopped = true
      clearHold()
      disconnect()
    }
  }
}

export interface ScoreboardRadarPublisherHookOptions {
  apiBase: string
  gameId: string
  /** The session's bearer token; without one nothing is sent. */
  token: string | null | undefined
  radar: RadarState | null
  open?: OpenPublisherSocket
  timers?: PublisherTimers
}

/**
 * The publisher for as long as the streaming screen is up: it opens the
 * socket once a radar is paired and closes it when none is, or the screen
 * goes.
 */
export function useScoreboardRadarPublisher(
  options: ScoreboardRadarPublisherHookOptions
): void {
  const { apiBase, gameId, token, radar, open, timers } = options
  const publisher = useRef<ScoreboardRadarPublisher | null>(null)
  const latest = useRef(radar)
  latest.current = radar
  useEffect(() => {
    if (token == null || token === '') return
    const made = makeScoreboardRadarPublisher({
      apiBase,
      gameId,
      token,
      open,
      timers
    })
    publisher.current = made
    made.update(latest.current)
    return () => {
      made.stop()
      publisher.current = null
    }
    // One publisher a screen: a new radar state is an update, not a new socket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, gameId, token])
  useEffect(() => {
    publisher.current?.update(radar)
  }, [radar])
}
