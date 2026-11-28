import { useCallback, useEffect, useState } from 'react'

import type { TeamStationClient } from '../../common/api'
import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'

/** The game's plays as the Plays tab last read them. */
export type PlaysRead =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; plays: GumboPlay[]; currentPlay: CurrentPlay | null }

export interface UsePlaysOptions {
  client: Pick<TeamStationClient, 'gameEvents'>
  gameId: string
  /**
   * False for a viewer who may not read the plays — signed out, or a member of
   * neither team — and then nothing is asked for: the server would refuse it.
   */
  enabled: boolean
}

/**
 * A game's stored plays and the at-bat in progress, read once with
 * `gameEvents` (`GET /games/:gameId/events`), named as the reader reads them.
 * `retry` reads again after a failure.
 */
export function usePlays(options: UsePlaysOptions): {
  read: PlaysRead
  retry: () => void
} {
  const { client, gameId, enabled } = options
  const [read, setRead] = useState<PlaysRead>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) return
    // A read still out for a game left behind lands nowhere.
    let live = true
    setRead(current =>
      current.state === 'loading' ? current : { state: 'loading' }
    )
    client
      .gameEvents(gameId)
      .then(stored => {
        if (!live) return
        setRead({
          state: 'ready',
          plays: stored.plays,
          currentPlay: stored.currentPlay
        })
      })
      .catch(() => {
        if (live) setRead({ state: 'failed' })
      })
    return () => {
      live = false
    }
  }, [client, gameId, enabled, attempt])
  const retry = useCallback(() => {
    setAttempt(value => value + 1)
  }, [])
  return { read, retry }
}
