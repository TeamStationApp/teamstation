import { useEffect, useRef } from 'react'

import { type GameChanges, listen } from './rosterLive'

/** A game's two teams, by side. */
export interface GameSides {
  homeTeamId: string
  awayTeamId: string
}

/**
 * Calls `onSwap` once the game's teams are no longer the ones `opened`
 * names: when a `game` notice names others, or when `read` finds them
 * changed. `read` is asked as soon as the screen listens (a swap that
 * committed while it was opening, its notice sent before anybody here
 * listened) and on every `resync` (a swap made while the socket was down,
 * whose notice was never sent). A notice naming the same teams, or none (an
 * older server), changes nothing.
 */
export function useSidesSwapped(
  socket: GameChanges | undefined,
  gameId: string,
  opened: GameSides | undefined,
  read: () => Promise<GameSides>,
  onSwap: () => void
): void {
  const latest = useRef({ read, onSwap })
  latest.current = { read, onSwap }
  const home = opened?.homeTeamId
  const away = opened?.awayTeamId
  useEffect(() => {
    if (home == null || away == null) return
    let live = true
    let fired = false
    const check = (teams: Partial<GameSides>): void => {
      if (!live || fired) return
      if (teams.homeTeamId == null || teams.awayTeamId == null) return
      if (teams.homeTeamId === home && teams.awayTeamId === away) return
      fired = true
      latest.current.onSwap()
    }
    const readAgain = (): void => {
      latest.current
        .read()
        .then(check)
        .catch(() => undefined)
    }
    const stop =
      socket == null
        ? () => undefined
        : listen(socket, gameId, event => {
            if (event.type === 'change' && event.kind === 'game')
              check(event.data)
            else if (event.type === 'resync') readAgain()
          })
    readAgain()
    return () => {
      live = false
      stop()
    }
  }, [socket, gameId, home, away])
}
