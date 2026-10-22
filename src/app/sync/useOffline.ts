import { useEffect, useState } from 'react'

import type { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { CachingClient, OFFLINE_CREATE_MESSAGE } from './cachingClient'
import type { HeldChain, OutboxSummary } from './outbox'

/**
 * What the shell and the screens say while the phone is offline. The web
 * keeps no documents and queues nothing, so it says none of it.
 */
export const OFFLINE_BANNER =
  "Offline. Edits will send when you're back online."
/** A live game read from the phone's copy: its stream cannot be played. */
export const OFFLINE_UNPLAYABLE = 'Not playable offline'
/** A game's queue parked by a stale lineup: the server's copy moved on. */
export const PARKED_GAME_MESSAGE =
  "The server's copy of this game changed. The innings scored here are still on this phone and were not sent."
/** A discard went through, and the server's copy did not come back. */
export const SERVER_COPY_PENDING =
  "This phone's changes to the game are gone, and the server's copy has not arrived yet. Try again once the phone is back online."
/** A queued write the server refused without saying why. */
export const DEAD_GAME_FALLBACK =
  'The server would not take a change to this game.'

/** What signing out with edits still on the phone costs. */
export function unsentLossText(count: number): string {
  return `${count === 1 ? '1 change' : `${count} changes`} on this phone ${count === 1 ? 'has' : 'have'} not been sent and will be lost.`
}

/** `1 edit`, `2 edits`. */
export function editCount(count: number): string {
  return `${count} ${count === 1 ? 'edit' : 'edits'}`
}

/**
 * The phone's banner line: offline, with what is waiting; online, what is
 * still on its way or held; nothing once the queue is empty.
 */
export function offlineBannerText(
  offline: boolean,
  summary: OutboxSummary | undefined
): string | undefined {
  const count = summary?.count ?? 0
  if (offline)
    return count > 0
      ? `${OFFLINE_BANNER} · ${editCount(count)} waiting`
      : OFFLINE_BANNER
  if (count === 0) return undefined
  const held =
    Object.keys(summary?.games ?? {}).length +
      Object.keys(summary?.teams ?? {}).length >
    0
  return held ? `${editCount(count)} not sent` : `Sending ${editCount(count)}…`
}

/** What the banner says of a team whose new players the server refused. */
export function heldTeamText(held: HeldChain): string {
  return `A player added on this phone was not saved: ${held.message ?? DEAD_GAME_FALLBACK}`
}

/** What a game's screen says of its held queue, if it is held. */
export function heldGameText(held: HeldChain | undefined): string | undefined {
  if (held == null) return undefined
  // A stale lineup says the server's copy moved on; a park behind a player
  // says why that player was not saved.
  if (held.state === 'parked' && held.cause !== 'player')
    return PARKED_GAME_MESSAGE
  return `Not sent: ${held.message ?? DEAD_GAME_FALLBACK}`
}

/**
 * Whether the phone's last request failed to leave it, kept up to date. The
 * web's client is never offline here: its screens behave as they always
 * have.
 */
export function usePhoneOffline(client: TeamStationClient): boolean {
  const phone = client instanceof CachingClient
  const [offline, setOffline] = useState(phone && client.offline)
  useEffect(() => {
    if (!phone) {
      setOffline(false)
      return
    }
    setOffline(client.offline)
    return client.subscribeOffline(setOffline)
  }, [client, phone])
  return offline
}

/**
 * The phone's queue as it stands, kept up to date; nothing on the web.
 * `owner` is whose file is open: a new one reads the queue again.
 */
export function useOutboxSummary(
  client: TeamStationClient,
  owner?: string
): OutboxSummary | undefined {
  const [summary, setSummary] = useState<OutboxSummary>()
  useEffect(() => {
    setSummary(undefined)
    if (!(client instanceof CachingClient)) return
    let live = true
    const unsubscribe = client.subscribeOutbox(next => {
      if (live) setSummary(next)
    })
    client
      .outboxSummary()
      .then(next => {
        if (live) setSummary(next)
      })
      .catch(() => undefined)
    return () => {
      live = false
      unsubscribe()
    }
  }, [client, owner])
  return summary
}

/** Why `gameId`'s queued writes are held on the phone, if they are. */
export function useHeldGame(
  client: TeamStationClient,
  gameId: string
): HeldChain | undefined {
  return useOutboxSummary(client)?.games[gameId]
}

/**
 * What a create's form says when its request could not leave the phone:
 * the same sentence its button gives offline. Nothing on the web, whose
 * forms keep the message they had.
 */
export function offlineCreateFailure(
  client: TeamStationClient,
  caught: unknown
): string | undefined {
  return client instanceof CachingClient &&
    caught instanceof HttpError &&
    caught.code === 'offline'
    ? OFFLINE_CREATE_MESSAGE
    : undefined
}

/** A game's held queue, what its screen says of it, and the way out. */
export interface HeldGameControl {
  state: HeldChain['state']
  text: string
  /**
   * Deletes what the phone holds for the game and reads the server's;
   * whether the server's copy came back.
   */
  discard: () => Promise<boolean>
  /** Sends the game's held edits again, from where the server stopped. */
  retry?: () => Promise<void>
}

/** `gameId`'s held queue on the phone, with its discard and retry. */
export function useHeldGameControl(
  client: TeamStationClient,
  gameId: string
): HeldGameControl | undefined {
  const held = useHeldGame(client, gameId)
  if (held == null || !(client instanceof CachingClient)) return undefined
  return {
    state: held.state,
    text: heldGameText(held)!,
    discard: async () => await client.discardGame(gameId),
    // Every hold can be tried again: a refusal may not repeat, a player's
    // create may land now, and a stale lineup simply parks again.
    retry: async () => {
      await client.retryGame(gameId)
    }
  }
}
