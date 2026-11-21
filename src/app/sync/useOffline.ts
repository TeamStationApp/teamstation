import { useCallback, useEffect, useState } from 'react'

import type { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { CachingClient, OFFLINE_CREATE_MESSAGE } from './cachingClient'
import { EDITS_PLACE } from './editsPlace'
import type { HeldChain, OutboxNotice, OutboxSummary } from './outbox'

/**
 * What the shell and the screens say while the device is offline, on the
 * phone and the web alike: both keep documents and queue edits.
 */
export const OFFLINE_BANNER =
  "Offline. Edits will send when you're back online."

/** A live game read from the phone's copy: its stream cannot be played. */
export const OFFLINE_UNPLAYABLE = 'Not playable offline'
/** A game's queue parked by a stale lineup: the server's copy moved on. */
export const PARKED_GAME_MESSAGE = `The server's copy of this game changed. The innings scored here are still ${EDITS_PLACE.on} and were not sent.`
/** A discard went through, and the server's copy did not come back. */
export const SERVER_COPY_PENDING = `${EDITS_PLACE.changes} to the game are gone, and the server's copy has not arrived yet. Try again once ${EDITS_PLACE.backOnline}.`
/** A queued write the server refused without saying why. */
export const DEAD_GAME_FALLBACK =
  'The server would not take a change to this game.'
/** A held game or team the phone has no name for. */
export const HELD_GAME_UNNAMED = 'A game'
export const HELD_TEAM_UNNAMED = 'A team'

/** What signing out with edits still on the phone costs. */
export function unsentLossText(count: number): string {
  return `${count === 1 ? '1 change' : `${count} changes`} ${EDITS_PLACE.on} ${count === 1 ? 'has' : 'have'} not been sent and will be lost.`
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
  return `A player added ${EDITS_PLACE.on} was not saved: ${held.message ?? DEAD_GAME_FALLBACK}`
}

/** A game's or a team's queue the server stopped, as the banner lists it. */
export interface HeldEdit {
  kind: 'game' | 'team'
  id: string
  held: HeldChain
}

/** `game:<id>` or `team:<id>`: an edit's key among the others. */
export function heldEditKey(edit: Pick<HeldEdit, 'kind' | 'id'>): string {
  return `${edit.kind}:${edit.id}`
}

/** Every held queue on the phone: the games first, then the teams. */
export function heldEdits(summary: OutboxSummary | undefined): HeldEdit[] {
  const sorted = (
    kind: HeldEdit['kind'],
    held: Record<string, HeldChain> | undefined
  ): HeldEdit[] =>
    Object.keys(held ?? {})
      .sort()
      .map(id => ({ kind, id, held: held![id] }))
  return [...sorted('game', summary?.games), ...sorted('team', summary?.teams)]
}

/**
 * Whether the banner's list offers Try Again for a held queue, as the
 * game's own notice and the team's did: every game hold, and a team's only
 * once the server refused it.
 */
export function heldEditRetries(edit: HeldEdit): boolean {
  return edit.kind === 'game' || edit.held.state === 'dead'
}

/** What the banner's list says of one held queue. */
export function heldEditText(edit: HeldEdit): string {
  return edit.kind === 'game'
    ? heldGameText(edit.held)!
    : heldTeamText(edit.held)
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
 * Whether the device's last request failed to leave it, kept up to date.
 * A plain client, which queues nothing, is never offline here.
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
 * The queue as it stands, kept up to date; nothing for a plain client.
 * `owner` is whose cache is open: a new one reads the queue again.
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

/**
 * Asks the browser to warn before the page unloads while `summary` holds an
 * edit: the web's queue is in memory, and leaving loses it. Nothing on the
 * phone, which has no page to unload and keeps its queue in a file.
 */
export function useUnsentEditsWarning(
  summary: OutboxSummary | undefined
): void {
  // A save on its way counts: the tab's queue is lost with it.
  const waiting = (summary?.count ?? 0) + (summary?.inFlight ?? 0) > 0
  useEffect(() => {
    // React Native's `window` has no events.
    if (!waiting || typeof window?.addEventListener !== 'function') return
    const unload = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', unload)
    return () => {
      window.removeEventListener('beforeunload', unload)
    }
  }, [waiting])
}

/**
 * The last notice a queued write of `gameId`, or of one of its `teamIds`,
 * came to on the phone, until `dismiss`; nothing on the web.
 */
export function useOutboxNotice(
  client: TeamStationClient,
  gameId: string,
  teamIds: readonly string[] = []
): { text: string; reread: boolean; dismiss: () => void } | undefined {
  const [notice, setNotice] = useState<OutboxNotice>()
  const teams = teamIds.join('\u0000')
  useEffect(() => {
    setNotice(undefined)
    if (!(client instanceof CachingClient)) return
    const own = new Set(teams === '' ? [] : teams.split('\u0000'))
    return client.subscribeOutboxNotices(next => {
      if (next.reconcileScoring === true) return
      if (
        next.gameId === gameId ||
        (next.teamId != null && own.has(next.teamId))
      )
        setNotice(next)
    })
  }, [client, gameId, teams])
  const dismiss = useCallback(() => {
    setNotice(undefined)
  }, [])
  return notice == null
    ? undefined
    : { text: notice.message, reread: notice.reread === true, dismiss }
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

/** A game's or a team's held queue, what its screen says, and the way out. */
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

/** The same control, for a team's held queue as for a game's. */
export type HeldControl = HeldGameControl

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

/**
 * The name of each held game and team, by `heldEditKey`, read from the
 * phone's own copy while `shown`: read each time it is shown, and again
 * when the set of holds changes, so a document stored meanwhile names its
 * hold. Nothing on the web, and nothing for a hold the phone has no copy
 * to name.
 */
export function useHeldNames(
  client: TeamStationClient,
  edits: readonly HeldEdit[],
  shown = true
): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({})
  const keys = edits.map(heldEditKey).join('\u0000')
  useEffect(() => {
    if (!shown) return
    if (!(client instanceof CachingClient) || keys === '') {
      setNames(last => (Object.keys(last).length === 0 ? last : {}))
      return
    }
    let live = true
    const wanted = keys.split('\u0000').map(key => {
      const [kind, ...rest] = key.split(':')
      return { kind: kind as HeldEdit['kind'], id: rest.join(':') }
    })
    client
      .heldNames(wanted)
      .then(next => {
        if (live) setNames(next)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [client, keys, shown])
  return names
}

/** `teamId`'s held queue of new players on the phone, with its way out. */
export function useHeldTeamControl(
  client: TeamStationClient,
  teamId: string
): HeldControl | undefined {
  const held = useOutboxSummary(client)?.teams[teamId]
  if (held == null || !(client instanceof CachingClient)) return undefined
  return {
    state: held.state,
    text: heldTeamText(held),
    discard: async () => await client.discardTeam(teamId),
    // Only a refused team is sent again: a parked one waits on the game
    // that names its player, and sending it again would only park it again.
    ...(held.state === 'dead'
      ? {
          retry: async () => {
            await client.retryTeam(teamId)
          }
        }
      : {})
  }
}
