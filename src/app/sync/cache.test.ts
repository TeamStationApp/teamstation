import { expect } from 'chai'
import { before, describe, it } from 'mocha'

import { deleteDocumentCaches, openDocumentCache } from './cache'
import { CachingClient } from './cachingClient'
import { wasmSqliteReady } from './wasmSqliteExecutor'

describe("the web's document cache", function () {
  before(wasmSqliteReady)

  it('keeps documents and an outbox in a database of the tab’s own', async function () {
    const web = await openDocumentCache('usr_1', '/api/v1')
    const document = { body: '[]', revision: '1', serverDigest: null }
    expect(await web.store('home.teams', document)).deep.include({
      body: '[]',
      pending: false
    })
    expect(await web.read('home.teams')).deep.include({ body: '[]' })
    const queued = await web.atomically(async tx => {
      await tx.enqueue({
        id: 'r1',
        idempotencyKey: 'k1',
        chain: 'team:tem_1',
        method: 'POST',
        path: '/teams/tem_1/roster-players',
        body: '{}',
        dependsOn: [],
        gameId: null
      })
      return await tx.outbox()
    })
    expect(queued.map(row => [row.id, row.state])).deep.equals([
      ['r1', 'pending']
    ])
    // Another open is another database: nothing is shared or kept.
    const next = await openDocumentCache('usr_1', '/api/v1')
    expect(await next.read('home.teams')).equals(undefined)
    expect(await next.atomically(async tx => await tx.outbox())).deep.equals([])
    await web.close()
    await web.destroy()
    await next.close()
    await deleteDocumentCaches('usr_1')
  })

  /** Queues one write on `store`, as the outbox would. */
  const queueOne = async (
    store: Awaited<ReturnType<typeof openDocumentCache>>,
    id: string
  ): Promise<void> => {
    await store.atomically(async tx => {
      await tx.enqueue({
        id,
        idempotencyKey: `k-${id}`,
        chain: 'team:tem_1',
        method: 'POST',
        path: '/teams/tem_1/roster-players',
        body: '{}',
        dependsOn: [],
        gameId: null
      })
    })
  }
  /** Whether leaving the page now asks first. */
  const leaveAsks = (): boolean => {
    const event = new window.Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }

  it('keeps a database its session closed for that person’s next open in the tab, warning on leave while it holds unsent writes (1.harness-review.1)', async function () {
    const first = await openDocumentCache('usr_kept', '/api/v1')
    await first.store('home.teams', {
      body: '[1]',
      revision: '1',
      serverDigest: null
    })
    await queueOne(first, 'r1')
    expect(leaveAsks(), 'open: the queue’s own warning counts it').equals(false)
    await first.close()
    expect(leaveAsks(), 'kept with a write unsent').equals(true)
    // Another person opens a database of their own.
    const other = await openDocumentCache('usr_other', '/api/v1')
    expect(await other.atomically(async tx => await tx.outbox())).deep.equals(
      []
    )
    await other.destroy()
    // The same person, signed in again: what they queued is there.
    const again = await openDocumentCache('usr_kept', '/api/v1')
    expect(leaveAsks(), 'open again').equals(false)
    expect(await again.read('home.teams')).deep.include({ body: '[1]' })
    expect(
      (await again.atomically(async tx => await tx.outbox())).map(row => row.id)
    ).deep.equals(['r1'])
    // Signed out: destroyed, and gone.
    await again.destroy()
    expect(leaveAsks()).equals(false)
    const fresh = await openDocumentCache('usr_kept', '/api/v1')
    expect(await fresh.read('home.teams')).equals(undefined)
    await fresh.close()
    // A kept database with nothing unsent warns of nothing, and the
    // account's removal drops it.
    expect(leaveAsks()).equals(false)
    await deleteDocumentCaches('usr_kept')
    const dropped = await openDocumentCache('usr_kept', '/api/v1')
    expect(await dropped.atomically(async tx => await tx.outbox())).deep.equals(
      []
    )
    await dropped.destroy()
  })

  it('sends what was queued once the person whose session the server refused signs in again in the tab (1.harness-review.1)', async function () {
    const seeded = await openDocumentCache('usr_refused', '/api/v1')
    await queueOne(seeded, 'r1')
    await seeded.close()
    const client = new CachingClient({
      baseUrl: '/api/v1',
      token: 'token',
      openCache: openDocumentCache,
      deleteCache: deleteDocumentCaches,
      outbox: { setTimer: () => 0, clearTimer: () => undefined },
      fetch: async () => {
        throw new TypeError('Failed to fetch')
      }
    })
    client.openFor('usr_refused')
    expect((await client.outboxSummary()).count).equals(1)
    await client.sessionRefused()
    expect(leaveAsks(), 'refused, the write still waits').equals(true)
    client.openFor('usr_refused')
    expect((await client.outboxSummary()).count).equals(1)
    await client.signedOut()
    expect(leaveAsks()).equals(false)
  })

  it('keeps a database, and its leave warning, when opening it again fails (2.harness-review.6)', async function () {
    const first = await openDocumentCache('usr_retry', '/api/v1')
    await queueOne(first, 'r1')
    await first.close()
    let refused: unknown
    try {
      await openDocumentCache('usr_retry', '/api/v1', async () => {
        throw new Error('no schema')
      })
    } catch (error) {
      refused = error
    }
    expect(refused).property('message').equals('no schema')
    expect(leaveAsks(), 'still kept with its write').equals(true)
    const again = await openDocumentCache('usr_retry', '/api/v1')
    expect(leaveAsks()).equals(false)
    expect(
      (await again.atomically(async tx => await tx.outbox())).map(row => row.id)
    ).deep.equals(['r1'])
    await again.destroy()
  })
})
