import { useEffect, useState } from 'react'

import { lstrings } from '../locales/strings'
import { OFFLINE_BANNER } from '../sync/useOffline'

/** What the save is doing, as the scoring screen reads it from the session. */
export interface SaveStatus {
  pending: number
  offline: boolean
  readOnly: boolean
  problem: string | null
}

export interface ScoringNotice {
  text: string
  kind: 'held' | 'report'
}

export function scoringNotice(input: {
  held?: string
  status: SaveStatus
  rosterConflict?: boolean
  event?: string
  phoneOffline: boolean
  reconnecting: boolean
}): ScoringNotice | null {
  const { held, status } = input
  if (status.readOnly) return null
  if (held != null) return { text: held, kind: 'held' }
  let text: string
  if (status.problem != null) text = `Not saved: ${status.problem}`
  else if (input.rosterConflict === true)
    text = lstrings.scoring_roster_conflict
  else if (input.event != null) text = input.event
  else if (input.phoneOffline) text = OFFLINE_BANNER
  else if (status.offline && status.pending > 0)
    text = `Offline — ${status.pending} ${status.pending === 1 ? 'play' : 'plays'} waiting`
  else if (input.reconnecting) text = 'Saving…'
  else return null
  return { text, kind: 'report' }
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
