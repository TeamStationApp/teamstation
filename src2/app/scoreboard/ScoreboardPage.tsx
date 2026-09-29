import React, { useEffect, useState } from 'react'

import {
  SAMPLE_SCOREBOARD,
  type ScoreboardState
} from '../../common/scoreboard'
import { ThemeProvider } from '../theme/ThemeContext'
import { ScoreboardBoard } from './ScoreboardBoard'
import { ScoreboardNotFound } from './ScoreboardNotFound'
import {
  type PageOrigin,
  type ScoreboardPageKind,
  socketUrlFor
} from './scoreboardRoute'
import {
  connectScoreboard,
  type Schedule,
  type SocketConstructor
} from './scoreboardSocket'

export interface ScoreboardPageProps {
  page: ScoreboardPageKind
  apiBaseUrl: string
  /** Where the page was loaded from, for a relative API base. */
  origin?: PageOrigin
  /** A test's socket and clock; the browser's otherwise. */
  WebSocketImpl?: SocketConstructor
  schedule?: Schedule
}

/**
 * A scoreboard page: the sample, or a game's live board.
 *
 * The live page opens the viewer socket straight away and asks for nothing
 * else: the server sends the board on open and after every change, and
 * closes with 4404 when the board is closed. Until the first state it keeps
 * the box and paints nothing. A socket that fails, however it fails, is
 * tried again every 3 s, so a page opened at a field with no signal fills in
 * when the signal comes back. Once closed, it shows the branded 404, or with
 * `quiet` keeps painting nothing, which is what a programme wants.
 */
export function ScoreboardPage(props: ScoreboardPageProps): React.ReactElement {
  const { page, apiBaseUrl, origin, WebSocketImpl, schedule } = props
  const [state, setState] = useState<ScoreboardState | undefined>(undefined)
  const [closed, setClosed] = useState(false)
  const gameId = page.kind === 'live' ? page.gameId : undefined
  // By value, so a caller that builds the origin afresh on every render does
  // not reconnect on every render.
  const protocol = origin?.protocol
  const host = origin?.host

  useEffect(() => {
    if (gameId == null) return
    const socket = connectScoreboard({
      url: socketUrlFor(
        protocol == null || host == null ? undefined : { protocol, host },
        apiBaseUrl,
        gameId
      ),
      onState: setState,
      onClosed: () => {
        setClosed(true)
      },
      WebSocketImpl,
      schedule
    })
    return () => {
      socket.close()
    }
  }, [gameId, apiBaseUrl, protocol, host, WebSocketImpl, schedule])

  if (page.kind === 'sample')
    return <ScoreboardBoard state={SAMPLE_SCOREBOARD} />
  if (!closed) return <ScoreboardBoard state={state} />
  if (page.quiet) return <ScoreboardBoard />
  return (
    <ThemeProvider>
      <ScoreboardNotFound />
    </ThemeProvider>
  )
}
