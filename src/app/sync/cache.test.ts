import { expect } from 'chai'
import { before, describe, it } from 'mocha'

import { deleteDocumentCaches, openDocumentCache } from './cache'
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
})
