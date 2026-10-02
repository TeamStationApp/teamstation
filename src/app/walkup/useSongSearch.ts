import { useCallback, useEffect, useRef, useState } from 'react'

import type { SongCandidate, WalkUpMusic } from './walkUpMusicTypes'

/** How long typing must pause before a search goes out. */
export const SEARCH_DELAY_MS = 300
/** The shortest term worth searching for. */
export const SEARCH_MIN_LENGTH = 2

export type SearchStatus = 'idle' | 'searching' | 'done' | 'error'

export interface SongSearch {
  term: string
  setTerm: (term: string) => void
  status: SearchStatus
  results: SongCandidate[]
  /** The store's own words, when the search failed. */
  error: string | null
  /** Search the same term again, at once. */
  retry: () => void
}

/**
 * The picker's search: it waits for typing to pause, needs two characters,
 * and shows only the answer to the latest term, however the answers arrive.
 */
export function useSongSearch(music: WalkUpMusic, enabled = true): SongSearch {
  const [term, setTerm] = useState('')
  const [status, setStatus] = useState<SearchStatus>('idle')
  const [results, setResults] = useState<SongCandidate[]>([])
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const latest = useRef(0)

  useEffect(() => {
    const trimmed = term.trim()
    const asked = ++latest.current
    if (!enabled || trimmed.length < SEARCH_MIN_LENGTH) {
      setStatus('idle')
      setResults([])
      setError(null)
      return
    }
    const timer = setTimeout(
      () => {
        setStatus('searching')
        setError(null)
        music
          .search(trimmed)
          .then(found => {
            if (asked !== latest.current) return
            setResults(found)
            setStatus('done')
          })
          .catch((caught: unknown) => {
            if (asked !== latest.current) return
            setResults([])
            setError(caught instanceof Error ? caught.message : String(caught))
            setStatus('error')
          })
      },
      attempt === 0 ? SEARCH_DELAY_MS : 0
    )
    return () => {
      clearTimeout(timer)
    }
  }, [music, term, enabled, attempt])

  const retry = useCallback(() => {
    setAttempt(count => count + 1)
  }, [])
  const change = useCallback((next: string) => {
    setAttempt(0)
    setTerm(next)
  }, [])

  return { term, setTerm: change, status, results, error, retry }
}
