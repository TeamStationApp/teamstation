import { SEARCH_SOCKET_PATH } from '../../common/search/types'

export const GAME_SOCKET_PATH = '/socket'
export const DICTATION_PATH = '/api/v1/dictation'
export const SCOREBOARD_SOCKET_PATH =
  /^\/api\/v1\/scoreboard\/([^/]+)\/(socket|publish|dashboard)$/

/** Search and dictation also accept trailing slashes. */
export function apiSocketPath(url: string | undefined): string {
  return (url ?? '').split('?')[0].replace(/\/+$/, '')
}

/** Use each protocol's matcher before admission looks up the account. */
export function supportsUpgrade(
  url: string | undefined,
  dictation: boolean
): boolean {
  const apiPath = apiSocketPath(url)
  if (
    apiPath === SEARCH_SOCKET_PATH ||
    (dictation && apiPath === DICTATION_PATH)
  )
    return true
  try {
    const path = new URL(url ?? '/', 'http://socket.invalid').pathname
    return path === GAME_SOCKET_PATH || SCOREBOARD_SOCKET_PATH.test(path)
  } catch {
    return false
  }
}
