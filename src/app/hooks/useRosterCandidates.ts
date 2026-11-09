import { asArray, asMaybe, asString, type Cleaner } from 'cleaners'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  asRosterCandidate,
  type RosterCandidate,
  type TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { candidatesKey, searchWords } from '../sync/documentKeys'
import { useDebouncedValue } from './useDebouncedValue'

/** Rows asked for at a time; a shorter page is the last. */
export const CANDIDATE_PAGE = 30
/** How long typing must pause before the server is asked. */
export const CANDIDATE_DEBOUNCE_MS = 500

export interface RosterCandidates {
  rows: RosterCandidate[]
  /** The first page of the current search is on its way. */
  loading: boolean
  /** A further page is on its way. */
  loadingMore: boolean
  /** Why the last page failed; the rows already shown stay. */
  error?: string
  /** Every row the search has is shown. */
  ended: boolean
  /** The client cannot reach the server, so nothing is asked. */
  offline: boolean
  /** The settled search the rows answer. */
  query: string
  loadMore: () => void
  retry: () => void
}

/**
 * A person the phone keeps for a team, with the words of the searches that
 * found him (`matched`): the server matched each to the start of one of his
 * names, which his short name (`Jordan Q`) may not show.
 */
export type KeptCandidate = RosterCandidate & { matched?: string[] }

/** A kept person as the phone stored him, his search words with him. */
const asKeptCandidate: Cleaner<KeptCandidate> = raw => {
  const candidate = asRosterCandidate(raw)
  const matched = asMaybe(asArray(asString))(
    raw != null && typeof raw === 'object'
      ? (raw as { matched?: unknown }).matched
      : undefined
  )
  return matched == null || matched.length === 0
    ? candidate
    : { ...candidate, matched }
}

/**
 * Whether a person the phone keeps answers `query`, as the server matches:
 * each word starts one of his shown names, or starts a word of a search the
 * server already found him by (a name of his that starts with that word
 * starts with this one too).
 */
export function candidateMatches(
  candidate: KeptCandidate,
  query: string
): boolean {
  const words = searchWords(query)
  if (words.length === 0) return true
  const names = [
    candidate.shortName,
    candidate.shortParts.first,
    candidate.shortParts.last,
    ...(candidate.matched ?? [])
  ]
    .join(' ')
    .toLowerCase()
    .split(/\s+/)
  return words.every(word => names.some(name => name.startsWith(word)))
}

/** A kept person as a row to list, without his search words. */
function listedRow(candidate: KeptCandidate): RosterCandidate {
  if (candidate.matched == null) return candidate
  const { matched: _matched, ...row } = candidate
  return row
}

/**
 * The people each client's searches found this session, by the session's
 * token and the team: the scoring screen's at-once list where the client
 * keeps no file (the web), and before the phone's file is read.
 */
const found = new WeakMap<object, Map<string, KeptCandidate[]>>()

function foundFor(client: TeamStationClient, teamId: string): KeptCandidate[] {
  return found.get(client)?.get(`${client.token ?? ''} ${teamId}`) ?? []
}

/**
 * Keeps `rows`, the answer to a search for `query`, as found for `teamId`,
 * newest first and each once, with the words that found each.
 */
function keepFound(
  client: TeamStationClient,
  teamId: string,
  rows: readonly RosterCandidate[],
  query: string
): void {
  if (rows.length === 0) return
  const byTeam = found.get(client) ?? new Map<string, KeptCandidate[]>()
  found.set(client, byTeam)
  const key = `${client.token ?? ''} ${teamId}`
  const words = searchWords(query)
  const answered = rows.map(row =>
    words.length === 0 ? row : { ...row, matched: words }
  )
  byTeam.set(key, merged(answered, byTeam.get(key) ?? []).slice(0, 500))
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

/**
 * `first`, then each of `then` it does not list, by user id. A person in
 * both keeps the search words of both.
 */
function merged<T extends KeptCandidate>(
  first: readonly T[],
  then: readonly T[]
): T[] {
  const later = new Map(then.map(row => [row.userId, row]))
  const listed = new Set(first.map(row => row.userId))
  return [
    ...first.map(row => {
      const words = [
        ...new Set([
          ...(row.matched ?? []),
          ...(later.get(row.userId)?.matched ?? [])
        ])
      ]
      return words.length === (row.matched?.length ?? 0)
        ? row
        : { ...row, matched: words }
    }),
    ...then.filter(row => !listed.has(row.userId))
  ]
}

function problemOf(error: unknown): string {
  return error instanceof HttpError
    ? error.message
    : 'Unable to load players. Please try again.'
}

/**
 * The players a roster manager may add to `teamId` (and, with `gameId`, to
 * its side of that game), nearest first, searched by `query` once typing
 * pauses for half a second, 30 at a time. Both the scoring sheet and the
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
 * game) is listed, since the phone's kept rows, and a server page read
 * before an add landed, may still hold him.
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
  const [kept, setKept] = useState<KeptCandidate[]>(() =>
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
          await client.cached(candidatesKey(teamId), asArray(asKeptCandidate))
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
    ? kept
        .filter(candidate => candidateMatches(candidate, typed))
        .map(listedRow)
    : []
  /** The cursor of the server's last row, which a further page follows. */
  const serverCursor = useRef<string | undefined>(undefined)
  useEffect(() => {
    setOffline(client.offline)
    return client.subscribeOffline(setOffline)
  }, [client])

  const [rows, setRows] = useState<RosterCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string>()
  const [failedPage, setFailedPage] = useState<'first' | 'more'>()
  const [ended, setEnded] = useState(false)
  const [attempt, setAttempt] = useState(0)
  /** The search in flight; a page for any other is dropped. */
  const current = useRef<AbortController | null>(null)
  const more = useRef(false)
  /** The current search's first page is still on its way. */
  const first = useRef(false)
  const latest = useRef({ rows, ended, settled })
  latest.current = { rows, ended, settled }

  useEffect(() => {
    if (offline) return
    if (cacheFirst && phoneOffline) {
      // The phone's people are the whole list until the signal is back.
      current.current = null
      setRows([])
      setLoading(false)
      setLoadingMore(false)
      setError(undefined)
      setEnded(true)
      return
    }
    const controller = new AbortController()
    current.current = controller
    more.current = false
    // A further page follows this search's own rows, never the last one's.
    serverCursor.current = undefined
    first.current = true
    setLoading(true)
    setLoadingMore(false)
    setError(undefined)
    setFailedPage(undefined)
    setRows([])
    setEnded(false)
    client
      .rosterCandidates({
        teamId,
        gameId,
        q: settled,
        limit: CANDIDATE_PAGE,
        signal: controller.signal
      })
      .then(
        page => {
          if (current.current !== controller) return
          first.current = false
          keepFound(client, teamId, page, settled)
          serverCursor.current = page[page.length - 1]?.cursor
          setRows(page)
          setEnded(page.length < CANDIDATE_PAGE)
          setLoading(false)
        },
        (caught: unknown) => {
          if (current.current !== controller) return
          first.current = false
          // With the phone's people shown, no signal is no failure.
          if (
            cacheFirst &&
            caught instanceof HttpError &&
            caught.code === 'offline'
          ) {
            setEnded(true)
            setLoading(false)
            return
          }
          setError(problemOf(caught))
          setFailedPage('first')
          setLoading(false)
        }
      )
    return () => {
      if (current.current === controller) current.current = null
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

  const loadMore = useCallback((): void => {
    const controller = current.current
    const { rows: shown, ended: done, settled: q } = latest.current
    const after = cacheFirst
      ? serverCursor.current
      : shown[shown.length - 1]?.cursor
    if (
      controller == null ||
      first.current ||
      more.current ||
      done ||
      after == null
    )
      return
    more.current = true
    setLoadingMore(true)
    setError(undefined)
    setFailedPage(undefined)
    client
      .rosterCandidates({
        teamId,
        gameId,
        q,
        after,
        limit: CANDIDATE_PAGE,
        signal: controller.signal
      })
      .then(
        page => {
          if (current.current !== controller) return
          keepFound(client, teamId, page, q)
          if (page.length > 0)
            serverCursor.current = page[page.length - 1].cursor
          setRows(previous => [...previous, ...page])
          setEnded(page.length < CANDIDATE_PAGE)
        },
        (caught: unknown) => {
          if (current.current !== controller) return
          setError(problemOf(caught))
          setFailedPage('more')
        }
      )
      .finally(() => {
        if (current.current !== controller) return
        more.current = false
        setLoadingMore(false)
      })
  }, [client, teamId, gameId, cacheFirst])

  const retry = useCallback((): void => {
    if (failedPage === 'more') loadMore()
    else setAttempt(count => count + 1)
  }, [failedPage, loadMore])

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
    // The server's first page still coming under the phone's rows.
    loadingMore: loadingMore || (loading && shownRows.length > 0),
    error,
    ended,
    offline,
    query: settled,
    loadMore,
    retry
  }
}
