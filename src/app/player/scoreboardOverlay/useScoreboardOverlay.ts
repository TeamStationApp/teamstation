import { useEffect, useState } from 'react'

import type { TeamStationClient } from '../../../common/api'
import { HttpError } from '../../../common/errors'
import type { ScoreboardOverlay } from '../../../common/nodeSettings'

/**
 * The asks in flight, by client and game, so players opening together share
 * one request. An ask is forgotten once it settles: the next video asks again.
 */
const asking = new WeakMap<
  TeamStationClient,
  Map<string, Promise<ScoreboardOverlay>>
>()

/**
 * The newest answer each game has had this session, so a player opened again
 * on it has an answer on its first render while it asks again: a board kept
 * from an earlier player never blinks out while a new one asks.
 */
const answered = new WeakMap<
  TeamStationClient,
  Map<string, ScoreboardOverlay>
>()

/** How long a failed ask waits before the next, doubling up to the most. */
export const overlayRetry = { firstMs: 2000, mostMs: 30000 }

async function ask(
  client: TeamStationClient,
  gameId: string
): Promise<ScoreboardOverlay> {
  let games = asking.get(client)
  if (games == null) {
    games = new Map()
    asking.set(client, games)
  }
  let answer = games.get(gameId)
  if (answer == null) {
    answer = client.scoreboardOverlay(gameId)
    games.set(gameId, answer)
    answer.then(
      value => {
        games.delete(gameId)
        let values = answered.get(client)
        if (values == null) {
          values = new Map()
          answered.set(client, values)
        }
        values.set(gameId, value)
      },
      () => games.delete(gameId)
    )
  }
  return await answer
}

/**
 * Whether a game's board shows over its videos, and where: null until the
 * server has said, for no game, and while it cannot say. Null draws no
 * board.
 *
 * It is asked for again each time `videoId` changes, so a player reads the
 * node's settings when a video loads and a moved start date or placement
 * reaches it on the next video. Until the new answer comes, the game's last
 * one stands. An ask that failed on the way (its body included), that the
 * server was too busy for (429), or that it could not answer (5xx), is tried
 * again, each wait twice the last, while the player is open. Anything else
 * is a refusal (signed out, not the viewer's game, no such game, an answer
 * this app cannot read): it is not asked again, and the game's last answer
 * is forgotten, so no board is drawn on it.
 */
export function useScoreboardOverlay(
  client: TeamStationClient,
  gameId: string | null | undefined,
  videoId?: string | null
): ScoreboardOverlay | null {
  const [overlay, setOverlay] = useState<{
    gameId: string
    value: ScoreboardOverlay | null
  }>()
  useEffect(() => {
    if (gameId == null) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt = (waitMs: number): void => {
      ask(client, gameId)
        .then(value => {
          if (live) setOverlay({ gameId, value })
        })
        .catch((error: unknown) => {
          if (!live) return
          // Not reached, too busy, or failing: worth asking again. Anything
          // else is the server's answer about this game.
          const passing =
            error instanceof HttpError &&
            (error.code === 'offline' ||
              error.code === 'rateLimited' ||
              error.status >= 500)
          if (!passing) {
            answered.get(client)?.delete(gameId)
            setOverlay({ gameId, value: null })
            return
          }
          timer = setTimeout(() => {
            attempt(Math.min(waitMs * 2, overlayRetry.mostMs))
          }, waitMs)
        })
    }
    attempt(overlayRetry.firstMs)
    return () => {
      live = false
      if (timer != null) clearTimeout(timer)
    }
  }, [client, gameId, videoId])
  if (overlay != null && overlay.gameId === gameId) return overlay.value
  return gameId == null ? null : (answered.get(client)?.get(gameId) ?? null)
}
