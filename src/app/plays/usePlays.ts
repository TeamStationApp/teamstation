import { useCallback, useEffect, useRef, useState } from 'react'

import type { TeamStationClient } from '../../common/api'
import type { GameSocket, GameSocketEvent } from '../../common/gameSocket'
import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import { applyPlayEdits, type HeldPlays } from '../../common/playEdits'
import { withReaderNames } from '../../common/scoring/readerNames'

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
   * neither team — and then nothing is asked for and the socket is not heard:
   * the server would refuse it.
   */
  enabled: boolean
  /** The game socket, to follow the plays as they are scored. */
  socket?: Pick<GameSocket, 'subscribe'>
}

/** What is held of the last read: the plays, what they were read as, and the names. */
type Held = HeldPlays & { readerNames?: Record<string, string> }

/**
 * A game's stored plays and the at-bat in progress, read with `gameEvents`
 * (`GET /games/:gameId/events`), named as the reader reads them, and kept up
 * from the game socket: each `playEdits` change is applied to what is held
 * (`applyPlayEdits`), so an edited play changes in place and a new one is
 * added without a read. A change that does not apply, a `resync`, a
 * `subscribed` after a refusal, or a change heard while a read is still out,
 * reads the game again. `retry` reads again after a failure.
 */
export function usePlays(options: UsePlaysOptions): {
  read: PlaysRead
  retry: () => void
} {
  const { client, gameId, enabled, socket } = options
  const [read, setRead] = useState<PlaysRead>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  /** What the last read and the changes since hold; null until a read lands. */
  const held = useRef<Held | null>(null)
  /** A read is out, and whether a change was heard while it was. */
  const reading = useRef(false)
  const stale = useRef(false)
  const live = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!enabled) return
    // A read still out for a game left behind lands nowhere.
    let current = true
    held.current = null
    setRead(shown => (shown.state === 'loading' ? shown : { state: 'loading' }))
    const readNow = (): void => {
      reading.current = true
      stale.current = false
      client
        .gameEvents(gameId)
        .then(stored => {
          if (!current) return
          reading.current = false
          held.current = {
            plays: stored.plays,
            currentPlay: stored.currentPlay,
            ...(stored.playsDigest == null
              ? {}
              : { playsDigest: stored.playsDigest }),
            ...(stored.namesDigest == null
              ? {}
              : { namesDigest: stored.namesDigest }),
            ...(stored.generation == null
              ? {}
              : { generation: stored.generation }),
            ...(stored.readerNames == null
              ? {}
              : { readerNames: stored.readerNames })
          }
          setRead({
            state: 'ready',
            plays: stored.plays,
            currentPlay: stored.currentPlay
          })
          // What changed while it was out may not be in it.
          if (stale.current) readNow()
        })
        .catch(() => {
          if (!current) return
          reading.current = false
          // A change heard meanwhile is news a new read would carry.
          if (stale.current) readNow()
          else if (held.current == null) setRead({ state: 'failed' })
        })
    }
    live.current = readNow
    readNow()
    return () => {
      current = false
      reading.current = false
      stale.current = false
      live.current = null
    }
  }, [client, gameId, enabled, attempt])

  useEffect(() => {
    if (!enabled || socket == null) return
    const again = (): void => {
      if (reading.current) stale.current = true
      else live.current?.()
    }
    let refused = false
    const hear = (event: GameSocketEvent): void => {
      if (event.type === 'error' || event.type === 'updateRequired') {
        refused = true
        return
      }
      if (event.type === 'subscribed') {
        // Changes sent while it was refused never came.
        if (refused) again()
        refused = false
        return
      }
      if (event.type === 'resync') {
        again()
        return
      }
      if (event.type !== 'change' || event.kind !== 'playEdits') return
      const now = held.current
      if (reading.current || now == null) {
        again()
        return
      }
      const next = applyPlayEdits(now, event.data)
      if (next == null) {
        again()
        return
      }
      // The edits' plays are named as the public reads them.
      const named = withReaderNames(next, next.readerNames)
      held.current = named
      setRead({
        state: 'ready',
        plays: named.plays,
        currentPlay: named.currentPlay
      })
    }
    let unsubscribe: () => void
    try {
      unsubscribe = socket.subscribe(gameId, hear)
    } catch {
      // A host without a socket transport shows the plays as last read.
      return undefined
    }
    return () => {
      unsubscribe()
    }
  }, [socket, gameId, enabled])

  const retry = useCallback(() => {
    setAttempt(value => value + 1)
  }, [])
  return { read, retry }
}
