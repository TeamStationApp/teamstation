import { useEffect, useState } from 'react'

import type { TeamStationClient } from '../../common/api'

export type LeagueAdmin = 'loading' | 'admin' | 'not-admin'

/**
 * Whether the signed-in person manages the league, from its group read.
 * A read that fails counts as not.
 */
export function useLeagueAdmin(
  client: Pick<TeamStationClient, 'group'>,
  league: string
): LeagueAdmin {
  const [admin, setAdmin] = useState<LeagueAdmin>('loading')
  useEffect(() => {
    let live = true
    setAdmin('loading')
    client
      .group({ kind: 'league', id: league })
      .then(detail => {
        if (live) setAdmin(detail.canManage ? 'admin' : 'not-admin')
      })
      .catch(() => {
        if (live) setAdmin('not-admin')
      })
    return () => {
      live = false
    }
  }, [client, league])
  return admin
}
