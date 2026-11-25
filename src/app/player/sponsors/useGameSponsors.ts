import { useEffect, useRef, useState } from 'react'

import type { TeamStationClient } from '../../../common/api'
import type { GameSponsors } from '../../../common/sponsors/types'
import { type PageOrigin, socketUrlFor } from '../../scoreboard/scoreboardRoute'
import {
  openReconnecting,
  realSchedule,
  type Schedule,
  type SocketConstructor
} from '../../scoreboard/scoreboardSocket'
import { latestQueue } from '../scoreboardOverlay/latestQueue'
import {
  BOARD_POLL_MS,
  BOARD_SOCKET_STOP,
  isChangeNotice,
  NOTICE_DEBOUNCE_MS,
  pageOrigin
} from '../scoreboardOverlay/useBoardTimeline'

export interface GameSponsorsOptions {
  /**
   * False where the player asks again on its own refresh, through
   * `refetch` (the TV, which has no socket): no socket and no poll.
   */
  socket?: boolean
  /** A test's socket and clock; the platform's otherwise. */
  WebSocketImpl?: SocketConstructor
  schedule?: Schedule
  /** Where the page was loaded from, for a relative API base. */
  origin?: PageOrigin
}

export interface GameSponsorsHandle {
  /** The game's sponsorship; null until it is read, or when it cannot be. */
  sponsors: GameSponsors | null
  /** Ask again. */
  refetch: () => void
}

/**
 * The sponsorship a game's players draw (`GET /games/:gameId/sponsors`):
 * its league's logo and reels, and where the node puts them.
 *
 * Read once a game; a caller asks only for a viewer who is signed in, as
 * playback needs (on the web by the session's cookie, on a phone or the TV
 * by its token). While the game is live
 * it is read again on every change notice of the game's own socket
 * (`?timeline=1`), gathered for `NOTICE_DEBOUNCE_MS`, and every
 * `BOARD_POLL_MS` while that socket is down: after a stop close
 * (`BOARD_SOCKET_STOP`), for the rest of the game. The
 * socket is its own, open whatever the scoreboard overlay says, since the
 * board's opens only while the board shows. A failed read keeps what was
 * read before, and before anything was, there is nothing to draw.
 */
export function useGameSponsors(
  client: TeamStationClient,
  gameId: string | null | undefined,
  live: boolean,
  options: GameSponsorsOptions = {}
): GameSponsorsHandle {
  const {
    socket: withSocket = true,
    WebSocketImpl,
    schedule = realSchedule
  } = options
  const [answer, setAnswer] = useState<{
    gameId: string
    sponsors: GameSponsors
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
    const queue = latestQueue()
    const load = (): void => {
      queue(async () => {
        if (done) return
        try {
          const sponsors = await client.gameSponsors(gameId)
          if (!done) setAnswer({ gameId, sponsors })
        } catch {
          // The next notice, poll or refresh asks again.
        }
      })
    }
    refetch.current = load

    let open = false
    let gathering: (() => void) | undefined
    let polling: (() => void) | undefined
    let socket: { close: () => void } | undefined
    if (live && withSocket) {
      try {
        socket = openReconnecting({
          url: `${socketUrlFor(pageOrigin(origin.current), client.baseUrl, gameId)}?timeline=1`,
          stopOn: BOARD_SOCKET_STOP,
          token: client.token,
          WebSocketImpl,
          schedule,
          onOpen: () => {
            open = true
          },
          onClose: () => {
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
        // No address for a socket: the poll below is all there is.
      }
      const poll = (): void => {
        polling = schedule(() => {
          if (!open) load()
          poll()
        }, BOARD_POLL_MS)
      }
      poll()
    }
    load()
    return () => {
      done = true
      refetch.current = () => undefined
      gathering?.()
      polling?.()
      socket?.close()
    }
  }, [client, gameId, live, withSocket, schedule, WebSocketImpl])

  const mine = answer != null && answer.gameId === gameId ? answer : null
  return {
    sponsors: mine?.sponsors ?? null,
    refetch: () => {
      refetch.current()
    }
  }
}
