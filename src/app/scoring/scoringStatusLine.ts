import { useEffect, useState } from 'react'

import { OFFLINE_BANNER } from '../sync/useOffline'

/** What the save is doing, as the scoring screen reads it from the session. */
export interface SaveStatus {
  pending: number
  offline: boolean
  readOnly: boolean
  problem: string | null
}

/**
 * Where the line sits: `top` across the very top, above the scoreboard, for
 * being offline; `save` where a save's line always sat, for the rest.
 */
export type StatusPlace = 'top' | 'save'

export interface StatusLine {
  text: string
  place: StatusPlace
}

/**
 * The scoring screen's status line, or nothing. A tap's own save says
 * nothing: it is part of the tap. Being offline says so at the top; coming
 * back says `Saving…` while what was queued goes out; a save that failed
 * says why.
 */
export function scoringStatusLine(input: {
  /** A held game's own line, which is a button. */
  held?: string
  status: SaveStatus
  /** The phone's client could not reach the server. */
  phoneOffline: boolean
  /** Back online, with edits made while offline still going out. */
  reconnecting: boolean
}): StatusLine | null {
  const { held, status } = input
  if (held != null) return { text: held, place: 'save' }
  if (status.readOnly) return null
  if (status.problem != null)
    return { text: `Not saved: ${status.problem}`, place: 'save' }
  if (input.phoneOffline) return { text: OFFLINE_BANNER, place: 'top' }
  if (status.offline && status.pending > 0)
    return {
      text: `Offline — ${status.pending} ${status.pending === 1 ? 'play' : 'plays'} waiting`,
      place: 'top'
    }
  if (input.reconnecting) return { text: 'Saving…', place: 'save' }
  return null
}

/**
 * Whether the screen is still owed a `Saving…` for having been offline: set
 * once it is offline, kept while it is back with something going out, and
 * cleared when it is back with nothing left to send.
 */
export function nextReconnect(
  wasOffline: boolean,
  offline: boolean,
  busy: boolean
): boolean {
  if (offline) return true
  return wasOffline && busy
}

/**
 * `true` from the moment the screen is back online after being offline until
 * what was waiting has gone out.
 */
export function useReconnectSaving(offline: boolean, busy: boolean): boolean {
  const [wasOffline, setWasOffline] = useState(offline)
  useEffect(() => {
    setWasOffline(shown => nextReconnect(shown, offline, busy))
  }, [offline, busy])
  return wasOffline && !offline && busy
}
