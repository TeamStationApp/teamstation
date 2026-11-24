import { useEffect, useRef, useState } from 'react'

import type { LineScoreStep, TeamStationClient } from '../../../common/api'
import { type PageOrigin, socketUrlFor } from '../../scoreboard/scoreboardRoute'
import {
  openReconnecting,
  realSchedule,
  type Schedule,
  type SocketConstructor
} from '../../scoreboard/scoreboardSocket'
import { latestQueue } from './latestQueue'
import {
  BOARD_SOCKET_STOP,
  isChangeNotice,
  NOTICE_DEBOUNCE_MS,
  pageOrigin
} from './useBoardTimeline'

export interface LineScoreOptions {
  client: TeamStationClient
  /** The game the angles are of; no game, no box score. */
  gameId: string | null | undefined
  /**
   * Streaming now, and nothing else watching the game for it: the box score
   * opens its own change-notice socket and poll. A grid whose board already
   * watches the game says false, and calls `refetch` on the board's changes,
   * so one socket and one poll serve both.
   */
  live: boolean
  WebSocketImpl?: SocketConstructor
  schedule?: Schedule
  origin?: PageOrigin
}

export interface LineScoreHandle {
  /** The game's line score at every moment; null until the first answer. */
  steps: LineScoreStep[] | null
  /** The teams' names, the box score's rows; null until the first answer. */
  teams: { away: string; home: string } | null
  /** Ask again: the viewer moved, or the game may have been corrected. */
  refetch: () => void
}

/**
 * A game's line score at every moment, from its events alone
 * (`GET /games/:gameId/box-score?view=line`), kept up to date.
 *
 * A game's line score is small, a step an action at most, so it is asked for
 * whole. While a take is live it is asked again on each change notice of
 * the board's socket (`?timeline=1`, which every play post sends),
 * debounced, once when that socket drops (its reconnect asks again), and on
 * a seek, through `refetch`, which picks up a correction made since. Nothing
 * asks on a timer.
 */
export function useLineScore(options: LineScoreOptions): LineScoreHandle {
  const {
    client,
    gameId,
    live,
    WebSocketImpl,
    schedule = realSchedule
  } = options
  const [answer, setAnswer] = useState<{
    gameId: string
    steps: LineScoreStep[]
    teams: { away: string; home: string }
  } | null>(null)
  const origin = useRef(options.origin)
  origin.current = options.origin
  const refetch = useRef<() => void>(() => undefined)

  useEffect(() => {
    if (gameId == null) {
      refetch.current = () => undefined
      return
    }
    let done = false
    // One request at a time, and only the newest of those asked for while one
    // is out: a scrub asks on every frame (`latestQueue`).
    const queue = latestQueue()
    const load = (): void => {
      queue(async () => {
        if (done) return
        try {
          const fetched = await client.lineScore(gameId)
          if (done) return
          setAnswer({ gameId, steps: fetched.steps, teams: fetched.teams })
        } catch {
          // The next notice, poll or seek asks again.
        }
      })
    }
    refetch.current = load

    let open = false
    let gathering: (() => void) | undefined
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
            load()
          },
          // Dropped: asked once for the outage. A retry that fails again
          // asks nothing; the next open asks.
          onClose: () => {
            if (open) load()
            open = false
          },
          onMessage: data => {
            if (!isChangeNotice(data)) return
            gathering?.()
            gathering = schedule(() => {
              gathering = undefined
              load()
            }, NOTICE_DEBOUNCE_MS)
          },
          onStop: () => {
            open = false
          }
        })
      } catch {
        // No address for a socket: the first read and seeks are all there is.
      }
    }
    load()
    return () => {
      done = true
      refetch.current = () => undefined
      gathering?.()
      socket?.close()
    }
  }, [client, gameId, live, schedule, WebSocketImpl])

  const mine = answer != null && answer.gameId === gameId ? answer : null
  return {
    steps: mine?.steps ?? null,
    teams: mine?.teams ?? null,
    refetch: () => {
      refetch.current()
    }
  }
}
