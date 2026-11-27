import { useCallback, useMemo, useRef, useState } from 'react'

import type { TeamStationClient } from '../../common/api'
import type {
  SponsoredRow,
  SponsorRowsQuery
} from '../../common/sponsors/types'

export interface SponsoredRowsHandle {
  /** The Schedule's sponsored rows; none until they are read. */
  rows: SponsoredRow[]
  /** Reads them again, as the screen's own refresh reads its games. */
  refresh: () => Promise<void>
}

const NONE: SponsoredRow[] = []

/** One key for a query, so a new object asking the same is the same read. */
function keyOf(query: SponsorRowsQuery | null): string | null {
  if (query == null) return null
  if ('scope' in query) return 'scope:me'
  const kind = 'team' in query ? 'team' : 'season'
  const id = 'team' in query ? query.team : query.season
  return `${kind}:${id}:${query.public === true ? 'public' : 'own'}`
}

/**
 * The sponsored rows of a Schedule (`GET /sponsor-rows`), kept for the
 * screen's life. They are read when the screen calls `refresh`: beside the
 * read that opens its games, and on each notice that reads them again. A new
 * query's rows start empty until it does. `null` reads nothing: a list that
 * shows no sponsored rows. A failed read keeps what was read before, so a
 * Schedule never loses its games for it.
 */
export function useSponsoredRows(
  client: TeamStationClient,
  query: SponsorRowsQuery | null
): SponsoredRowsHandle {
  const key = keyOf(query)
  const asked = useRef(query)
  asked.current = query
  const [held, setHeld] = useState<{
    key: string
    rows: SponsoredRow[]
  } | null>(null)
  const current = useRef(key)
  current.current = key

  const refresh = useCallback(async (): Promise<void> => {
    const ask = asked.current
    if (key == null || ask == null) return
    try {
      const rows = await client.sponsorRows(ask)
      if (current.current === key) setHeld({ key, rows })
    } catch {
      // The next refresh asks again.
    }
  }, [client, key])

  const rows = held?.key === key ? held.rows : NONE
  return useMemo(() => ({ rows, refresh }), [rows, refresh])
}
