import React from 'react'

import type { TeamStationClient } from '../../common/api'
import {
  SearchSocket,
  type SearchSocketOptions,
  searchSocketUrl
} from '../../common/searchSocket'

/** Makes a search socket: a real one, or a test's. */
export type SearchSocketFactory = (options: SearchSocketOptions) => SearchSocket

/** The app's own: a real socket. */
export const openSearchSocket: SearchSocketFactory = options =>
  new SearchSocket(options)

/**
 * How the screens below the app make their search sockets: the Search tab
 * and Add Existing Player share it. `App` provides its `searchSocketFactory`
 * prop, or `openSearchSocket`; a screen rendered on its own, with none
 * provided, has no socket to search over (Add Existing Player then asks
 * `GET /users?forTeam=`).
 */
export const SearchSocketFactoryContext = React.createContext<
  SearchSocketFactory | undefined
>(undefined)

/** The page's address, which a relative API address resolves against. */
export function pageHref(): string | undefined {
  const scope = globalThis as {
    location?: { href?: string }
    window?: { location?: { href?: string } }
  }
  return scope.location?.href ?? scope.window?.location?.href
}

/**
 * A socket for this client's server, made by `factory`: with the session's
 * token when `signedIn`, else searching signed out. Throws where there is
 * no address or no WebSocket to make one with.
 */
export function makeSearchSocket(
  factory: SearchSocketFactory,
  client: TeamStationClient,
  signedIn: boolean
): SearchSocket {
  return factory({
    url: searchSocketUrl(client.baseUrl, pageHref()),
    ...(signedIn ? { token: () => client.token ?? null } : {})
  })
}
