import { useCallback, useEffect, useRef, useState } from 'react'

import type { RosterCandidate, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
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
 */
export function useRosterCandidates({
  client,
  teamId,
  gameId,
  query
}: {
  client: TeamStationClient
  teamId: string
  gameId?: string
  query: string
}): RosterCandidates {
  const settled = useDebouncedValue(query.trim(), CANDIDATE_DEBOUNCE_MS)
  const [offline, setOffline] = useState(client.offline)
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
  const latest = useRef({ rows, ended, settled })
  latest.current = { rows, ended, settled }

  useEffect(() => {
    if (offline) return
    const controller = new AbortController()
    current.current = controller
    more.current = false
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
          setRows(page)
          setEnded(page.length < CANDIDATE_PAGE)
          setLoading(false)
        },
        (caught: unknown) => {
          if (current.current !== controller) return
          setError(problemOf(caught))
          setFailedPage('first')
          setLoading(false)
        }
      )
    return () => {
      if (current.current === controller) current.current = null
      controller.abort()
    }
  }, [client, teamId, gameId, settled, offline, attempt])

  const loadMore = useCallback((): void => {
    const controller = current.current
    const { rows: shown, ended: done, settled: q } = latest.current
    if (controller == null || more.current || done || shown.length === 0) return
    more.current = true
    setLoadingMore(true)
    setError(undefined)
    setFailedPage(undefined)
    client
      .rosterCandidates({
        teamId,
        gameId,
        q,
        after: shown[shown.length - 1].cursor,
        limit: CANDIDATE_PAGE,
        signal: controller.signal
      })
      .then(
        page => {
          if (current.current !== controller) return
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
  }, [client, teamId, gameId])

  const retry = useCallback((): void => {
    if (failedPage === 'more') loadMore()
    else setAttempt(count => count + 1)
  }, [failedPage, loadMore])

  return {
    rows,
    loading,
    loadingMore,
    error,
    ended,
    offline,
    query: settled,
    loadMore,
    retry
  }
}
