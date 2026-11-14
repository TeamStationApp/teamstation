import { asArray } from 'cleaners'
import { useCallback, useEffect, useState } from 'react'

import {
  asRosterCandidate,
  ROSTER_CANDIDATE_MAX,
  type RosterCandidate,
  type TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { candidatesKey } from '../sync/documentKeys'
import { useDebouncedValue } from './useDebouncedValue'

/** How long typing must pause before the server is asked. */
export const CANDIDATE_DEBOUNCE_MS = 500

export interface RosterCandidates {
  rows: RosterCandidate[]
  /** The current search's answer is on its way, with nothing shown yet. */
  loading: boolean
  /** The server's answer is on its way under the phone's rows. */
  updating: boolean
  /** Why the search failed; the phone's rows shown stay. */
  error?: string
  /**
   * The server answered as many as one search answers
   * (`ROSTER_CANDIDATE_MAX`): more may match, and typing more narrows them.
   */
  capped: boolean
  /** The client cannot reach the server, so nothing is asked. */
  offline: boolean
  /** The settled search the rows answer. */
  query: string
  retry: () => void
}

/** Whether a person the phone keeps answers `query`, as the server matches. */
export function candidateMatches(
  candidate: RosterCandidate,
  query: string
): boolean {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter(word => word !== '')
  if (words.length === 0) return true
  const names = [
    candidate.shortName,
    candidate.shortParts.first,
    candidate.shortParts.last
  ]
    .join(' ')
    .toLowerCase()
    .split(/\s+/)
  return words.every(word => names.some(name => name.startsWith(word)))
}

/**
 * The people each client's searches found this session, by the session's
 * token and the team: the scoring screen's at-once list where the client
 * keeps no file (the web), and before the phone's file is read.
 */
const found = new WeakMap<object, Map<string, RosterCandidate[]>>()

function foundFor(
  client: TeamStationClient,
  teamId: string
): RosterCandidate[] {
  return found.get(client)?.get(`${client.token ?? ''} ${teamId}`) ?? []
}

/** Keeps `rows` as found for `teamId`, newest first and each once. */
function keepFound(
  client: TeamStationClient,
  teamId: string,
  rows: readonly RosterCandidate[]
): void {
  if (rows.length === 0) return
  const byTeam = found.get(client) ?? new Map<string, RosterCandidate[]>()
  found.set(client, byTeam)
  const key = `${client.token ?? ''} ${teamId}`
  byTeam.set(key, merged(rows, byTeam.get(key) ?? []).slice(0, 500))
}

/**
 * Forgets `userId` from the people found for `teamId`, kept in memory and on
 * the phone: once he is added he is no longer somebody to add.
 */
export function forgetFound(
  client: TeamStationClient,
  teamId: string,
  userId: string
): void {
  const byTeam = found.get(client)
  const key = `${client.token ?? ''} ${teamId}`
  const rows = byTeam?.get(key)
  if (rows != null)
    byTeam!.set(
      key,
      rows.filter(row => row.userId !== userId)
    )
}

/** `first`, then each of `then` it does not list, by user id. */
function merged(
  first: readonly RosterCandidate[],
  then: readonly RosterCandidate[]
): RosterCandidate[] {
  const listed = new Set(first.map(row => row.userId))
  return [...first, ...then.filter(row => !listed.has(row.userId))]
}

function problemOf(error: unknown): string {
  return error instanceof HttpError
    ? error.message
    : 'Unable to load players. Please try again.'
}

/**
 * The players a roster manager may add to `teamId` (and, with `gameId`, to
 * its side of that game), nearest first, searched by `query` once typing
 * pauses for half a second: one request per search, whose answer of at most
 * `ROSTER_CANDIDATE_MAX` is the list, with no further pages. Both the scoring sheet and the
 * team's Add Player scene draw it.
 *
 * Each settled search aborts the one before it, and an answer for anything
 * but the current search is dropped, so a slow reply never replaces a newer
 * one.
 *
 * `cacheFirst` (the scoring screen, which never waits on the network): the
 * people the phone keeps for the team that match the query are listed at
 * once, and the server's matches join them when they come. With no signal
 * the phone's are the list, and the search is not `offline`. Nobody in
 * `excluded` (by user id: those already on the team's roster or in the
 * game) is listed, since the phone's kept rows, and an answer read before an
 * add landed, may still hold him.
 */
export function useRosterCandidates({
  client,
  teamId,
  gameId,
  query,
  cacheFirst = false,
  excluded
}: {
  client: TeamStationClient
  teamId: string
  gameId?: string
  query: string
  cacheFirst?: boolean
  excluded?: ReadonlySet<string>
}): RosterCandidates {
  const settled = useDebouncedValue(query.trim(), CANDIDATE_DEBOUNCE_MS)
  const [phoneOffline, setOffline] = useState(client.offline)
  const offline = phoneOffline && !cacheFirst
  // The people found before for the team: this session's at once, then
  // those the phone keeps.
  const [kept, setKept] = useState<RosterCandidate[]>(() =>
    cacheFirst ? foundFor(client, teamId) : []
  )
  useEffect(() => {
    if (!cacheFirst) return
    let current = true
    setKept(foundFor(client, teamId))
    // A cache that cannot be read is one that holds nobody.
    Promise.resolve()
      .then(
        async () =>
          await client.cached(candidatesKey(teamId), asArray(asRosterCandidate))
      )
      .then(
        stored => {
          if (current && stored != null && stored.length > 0)
            setKept(held => merged(held, stored))
        },
        () => undefined
      )
    return () => {
      current = false
    }
  }, [client, teamId, cacheFirst])
  // Those matching what is typed, as it is typed.
  const typed = query.trim()
  const cachedRows = cacheFirst
    ? kept.filter(candidate => candidateMatches(candidate, typed))
    : []
  useEffect(() => {
    setOffline(client.offline)
    return client.subscribeOffline(setOffline)
  }, [client])

  const [rows, setRows] = useState<RosterCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (offline) return
    if (cacheFirst && phoneOffline) {
      // The phone's people are the whole list until the signal is back.
      setRows([])
      setLoading(false)
      setError(undefined)
      return
    }
    const controller = new AbortController()
    let current = true
    setLoading(true)
    setError(undefined)
    setRows([])
    client
      .rosterCandidates({
        teamId,
        gameId,
        q: settled,
        // It draws `capped` when the answer is full.
        capped: true,
        signal: controller.signal
      })
      .then(
        found => {
          if (!current) return
          keepFound(client, teamId, found)
          setRows(found)
          setLoading(false)
        },
        (caught: unknown) => {
          if (!current) return
          setLoading(false)
          // With the phone's people shown, no signal is no failure.
          if (
            cacheFirst &&
            caught instanceof HttpError &&
            caught.code === 'offline'
          )
            return
          setError(problemOf(caught))
        }
      )
    return () => {
      current = false
      controller.abort()
    }
  }, [
    client,
    teamId,
    gameId,
    settled,
    offline,
    attempt,
    cacheFirst,
    phoneOffline
  ])

  const retry = useCallback((): void => {
    setAttempt(count => count + 1)
  }, [])

  // The server's rows first, nearest first, then the phone's it has not
  // listed; the phone's alone while the server's are on their way.
  const listed = cacheFirst ? merged(rows, cachedRows) : rows
  const shownRows =
    excluded == null || excluded.size === 0
      ? listed
      : listed.filter(row => !excluded.has(row.userId))
  return {
    rows: shownRows,
    loading: loading && shownRows.length === 0,
    // The server's answer still coming under the phone's rows.
    updating: loading && shownRows.length > 0,
    error,
    capped: !loading && rows.length >= ROSTER_CANDIDATE_MAX,
    offline,
    query: settled,
    retry
  }
}
