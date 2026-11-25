import type { CachingClient, OfflineSetSocket } from '../app/sync/cachingClient'
import type { OfflineScoringSet } from '../app/sync/offlineSet'

/** A socket that follows nothing: the set reads its choice once. */
const QUIET: OfflineSetSocket = {
  subscribe: () => () => undefined,
  onUserChanged: () => () => undefined
}

/**
 * Prepares the games the server chooses for this client's person to score
 * with no signal, as the phone's shell does once signed in, and waits for
 * the first preparation to end.
 */
export async function prepareOffline(
  client: CachingClient,
  socket: OfflineSetSocket = QUIET
): Promise<OfflineScoringSet> {
  const set = client.startOfflineSet(socket)
  await set.started
  return set
}
