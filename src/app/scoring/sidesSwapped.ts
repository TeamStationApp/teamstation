import { useEffect, useRef } from 'react'

import { type GameChanges, listen } from './rosterLive'

/** A game's two teams, by side. */
export interface GameSides {
  homeTeamId: string
  awayTeamId: string
}

/** The teams a screen opened a game on, and the play generation. */
export interface OpenedGame extends GameSides {
  /** Absent when the server named none. */
  generation?: number
}

/** What changed under the open game. */
export interface GameReplaced {
  /** Home and away were swapped. */
  swapped: boolean
  /** Its plays were reset: the generation moved on. */
  reset: boolean
}

/**
 * Calls `onReplace` once the game is no longer the one `opened` names: when
 * a `game` notice names other teams or another play generation, or when
 * `read` finds them changed. `read` is asked as soon as the screen listens
 * (a swap or reset that committed while it was opening, its notice sent
 * before anybody here listened) and on every `resync` (one made while the
 * socket was down, whose notice was never sent). A notice naming the same
 * teams and generation, or none (an older server), changes nothing.
 */
export function useGameReplaced(
  socket: GameChanges | undefined,
  gameId: string,
  opened: OpenedGame | undefined,
  read: () => Promise<Partial<OpenedGame>>,
  onReplace: (change: GameReplaced) => void
): void {
  const latest = useRef({ read, onReplace })
  latest.current = { read, onReplace }
  const home = opened?.homeTeamId
  const away = opened?.awayTeamId
  const generation = opened?.generation
  useEffect(() => {
    if (home == null || away == null) return
    let live = true
    let fired = false
    const check = (game: Partial<OpenedGame>): void => {
      if (!live || fired) return
      if (game.homeTeamId == null || game.awayTeamId == null) return
      const swapped = game.homeTeamId !== home || game.awayTeamId !== away
      const reset =
        generation != null &&
        game.generation != null &&
        game.generation !== generation
      if (!swapped && !reset) return
      fired = true
      latest.current.onReplace({ swapped, reset })
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
  }, [socket, gameId, home, away, generation])
}

/**
 * What the scorer is told once the game opens again. `lost` counts the
 * changes it had not saved, which are not kept; a phone's queue given up
 * counts as one, since it cannot tell how many it held.
 */
export function replacedNotice(change: GameReplaced, lost: number): string {
  if (!change.reset)
    return lost > 0
      ? 'Home and away were swapped, so changes not yet saved before the swap were not kept.'
      : 'Home and away were swapped.'
  const what = change.swapped
    ? 'Home and away were swapped and the game was reset'
    : 'This game was reset'
  if (lost === 0) return `${what}.`
  const changes = lost === 1 ? '1 change' : `${lost} changes`
  return `${what}, so ${changes} not yet saved before the reset ${lost === 1 ? 'was' : 'were'} not kept.`
}
