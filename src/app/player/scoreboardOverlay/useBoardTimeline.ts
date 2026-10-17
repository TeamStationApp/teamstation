import { useEffect, useRef, useState } from 'react'

import type { BoardStep, TeamStationClient } from '../../../common/api'
import { type PageOrigin, socketUrlFor } from '../../scoreboard/scoreboardRoute'
import {
  openReconnecting,
  realSchedule,
  type Schedule,
  type SocketConstructor
} from '../../scoreboard/scoreboardSocket'
import { mergeSteps } from './boardAt'

/** How far before the frame on screen a refetch starts. */
export const LOOK_BACK_MS = 60_000

/** How long a burst of change notices is gathered into one refetch. */
export const NOTICE_DEBOUNCE_MS = 250

/** How often a live board is asked for again while it has no socket. */
export const BOARD_POLL_MS = 10_000

/**
 * The closes after which the notice socket is not tried again: 4401 (not
 * signed in), 4403 (cannot see the game) and 4404 (no such game). The poll
 * carries on after any of them, so the board still moves; the fetch it makes
 * is asked the same questions, and answers what it may.
 */
export const BOARD_SOCKET_STOP = [4401, 4403, 4404] as const

export interface BoardTimelineOptions {
  client: TeamStationClient
  /** The game the video is of; no game, no board. */
  gameId: string | null | undefined
  /** Where the video's wall window starts; null until its timeline is in. */
  fromMs: number | null
  /** Streaming now: the board is still being written. */
  live: boolean
  /** The wall-clock instant of the frame on screen, or null. */
  playheadWall: () => number | null
  /** A test's socket and clock; the platform's otherwise. */
  WebSocketImpl?: SocketConstructor
  schedule?: Schedule
  /** Where the page was loaded from, for a relative API base. */
  origin?: PageOrigin
}

export interface BoardTimelineHandle {
  /** The steps held, in time order; null until the first answer. */
  steps: BoardStep[] | null
  /**
   * The viewer went somewhere else in the video: ask again for the steps
   * around the new position, so a correction made further back since the
   * board was fetched is picked up there.
   */
  refetchAround: (wallMs: number | null) => void
}

/**
 * A game's board over one video's wall window, kept up to date.
 *
 * Fetched from the window's start. While live, the change-notice socket
 * (`?timeline=1`) is opened first, so nothing written between the fetch and
 * the socket is missed, and each notice — debounced — refetches from a
 * minute before the frame on screen (never before the window), replacing
 * what was held from there and keeping what came before. An undo, a late
 * post and a correction all arrive that way, as the server's recomputed
 * truth. A lost socket never freezes the board: while it is closed the same
 * refetch runs every `BOARD_POLL_MS`, and every reopen runs it once.
 *
 * The notices are for the game's members, as the timeline is, so the socket
 * is signed in as `connectDashboard`'s is: a browser sends its session cookie
 * by itself, and a phone sends its token as `Authorization`.
 */
export function useBoardTimeline(
  options: BoardTimelineOptions
): BoardTimelineHandle {
  const {
    client,
    gameId,
    fromMs,
    live,
    WebSocketImpl,
    schedule = realSchedule
  } = options
  const [steps, setSteps] = useState<BoardStep[] | null>(null)
  /** What is held, and for which game, across a change of window or live. */
  const kept = useRef<{ gameId: string; steps: BoardStep[] } | null>(null)
  const playhead = useRef(options.playheadWall)
  playhead.current = options.playheadWall
  const origin = useRef(options.origin)
  origin.current = options.origin
  const refetch = useRef<(wallMs: number | null) => void>(() => undefined)

  useEffect(() => {
    // Another game's steps are no use; the same game's stay on screen while
    // a new window or a stream's end is fetched, and are merged into.
    if (kept.current != null && kept.current.gameId !== gameId) {
      kept.current = null
      setSteps(null)
    }
    if (gameId == null || fromMs == null) {
      refetch.current = () => undefined
      return
    }
    let done = false
    let held: BoardStep[] | null = kept.current?.steps ?? null
    // One request at a time, applied in the order asked, so an older answer
    // never lands on top of a newer one.
    let chain = Promise.resolve()
    const load = (from: number): void => {
      chain = chain.then(async () => {
        if (done) return
        const whole = held == null
        const start = whole ? fromMs : from
        try {
          const answer = await client.scoreboardTimeline(gameId, {
            fromMs: start
          })
          if (done) return
          held = whole
            ? answer.steps
            : mergeSteps(held ?? [], start, answer.steps)
          kept.current = { gameId, steps: held }
          setSteps(held)
        } catch {
          // The next notice, poll or seek asks again.
        }
      })
    }
    const around = (wallMs: number | null): void => {
      load(Math.max(fromMs, (wallMs ?? fromMs) - LOOK_BACK_MS))
    }
    refetch.current = around

    let open = false
    let gathering: (() => void) | undefined
    let polling: (() => void) | undefined
    let socket: { close: () => void } | undefined
    if (live) {
      try {
        socket = openReconnecting({
          url: `${socketUrlFor(pageOrigin(origin.current), client.baseUrl, gameId)}?timeline=1`,
          stopOn: BOARD_SOCKET_STOP,
          token: client.token,
          WebSocketImpl,
          schedule,
          onOpen: () => {
            open = true
            around(playhead.current())
          },
          onClose: () => {
            open = false
          },
          onMessage: data => {
            if (!isChangeNotice(data)) return
            gathering?.()
            gathering = schedule(() => {
              gathering = undefined
              around(playhead.current())
            }, NOTICE_DEBOUNCE_MS)
          },
          onStop: () => {
            open = false
          }
        })
      } catch {
        // No address for a socket (a relative API base with no page to
        // resolve it against): the poll below is all there is.
      }
      const poll = (): void => {
        polling = schedule(() => {
          if (!open) around(playhead.current())
          poll()
        }, BOARD_POLL_MS)
      }
      poll()
    }
    load(fromMs)

    return () => {
      done = true
      refetch.current = () => undefined
      gathering?.()
      polling?.()
      socket?.close()
    }
  }, [client, gameId, fromMs, live, schedule, WebSocketImpl])

  return {
    steps,
    refetchAround: wallMs => {
      refetch.current(wallMs)
    }
  }
}

/** `{"type":"changed"}`, and nothing else the socket might send. */
function isChangeNotice(data: unknown): boolean {
  try {
    const message = JSON.parse(String(data)) as { type?: unknown } | null
    return message?.type === 'changed'
  } catch {
    return false
  }
}

/** The page's own origin, where there is a page. */
function pageOrigin(given: PageOrigin | undefined): PageOrigin | undefined {
  if (given != null) return given
  const location = (globalThis as { location?: Partial<PageOrigin> }).location
  if (location?.protocol == null || location.host == null) return undefined
  return { protocol: location.protocol, host: location.host }
}
