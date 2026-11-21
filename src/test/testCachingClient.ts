import { openCacheStore } from '../app/sync/cacheStore'
import {
  CachingClient,
  type CachingClientOptions
} from '../app/sync/cachingClient'
import { testSqliteExecutor } from './testSqliteExecutor'

/**
 * The queued client a scoring screen that saves needs, on the web as on the
 * phone, for a Node suite: its documents and outbox in an in-memory SQLite
 * database of its own, opened for `userId`. The outbox's timers never fire
 * unless the suite passes its own. A request a suite does not answer itself
 * reaches a server that has nothing (404): the client stays online, as a
 * plain client's failed request never said otherwise. Any other client
 * option passes through.
 */
export function testCachingClient(
  options: Partial<CachingClientOptions> & { userId?: string } = {}
): CachingClient {
  const { userId = 'usr_scorer', ...rest } = options
  const client = new CachingClient({
    baseUrl: '/api/v1',
    token: 'token',
    openCache: async () => await openCacheStore(testSqliteExecutor(':memory:')),
    outbox: { setTimer: () => 0, clearTimer: () => undefined },
    fetch: async () =>
      new Response(JSON.stringify({ code: 'notFound', message: 'Not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      }),
    ...rest
  })
  client.openFor(userId)
  return client
}
