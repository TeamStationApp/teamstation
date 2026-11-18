import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { nodeSqliteExecutor } from '../../test/nodeSqliteExecutor'
import { type CacheFiles, openFileCache } from './cacheFiles'
import { legacyCacheFileName, openCacheStore } from './cacheStore'
import { CachingClient } from './cachingClient'

describe('one phone account on two real API origins', function () {
  this.timeout(60000)
  let a: GroupFixture
  let b: GroupFixture
  let dir: string
  let files: CacheFiles
  const clients: CachingClient[] = []
  const user = userIdOfGumbo(101)
  // Both independent fixtures contain this same team ID and roster URL.
  const team = 'tem_account'

  before(async () => {
    a = await groupFixture()
    b = await groupFixture()
    dir = mkdtempSync(join(tmpdir(), 'server-cache-scope-'))
    files = {
      list: async () => readdirSync(dir),
      remove: async name => {
        rmSync(join(dir, name))
      },
      open: name => nodeSqliteExecutor(join(dir, name))
    }
  })
  after(async () => {
    for (const client of clients) await client.sessionRefused()
    await a?.h.close()
    await b?.h.close()
    if (dir != null) rmSync(dir, { recursive: true, force: true })
  })

  const phone = (
    f: GroupFixture
  ): { client: CachingClient; transport: { held: boolean; posts: number } } => {
    const transport = { held: false, posts: 0 }
    const client = new CachingClient({
      baseUrl: `${f.h.origin}/api/v1`,
      token: f.h.tokens.get(101),
      fetch: async (url, init) => {
        if (transport.held) throw new TypeError('No connection')
        if (init?.method === 'POST') transport.posts++
        return await fetch(url, init)
      },
      openCache: async (id, url) => await openFileCache(id, url, files),
      outbox: { setTimer: () => 0, clearTimer: () => undefined }
    })
    client.openFor(user)
    clients.push(client)
    return { client, transport }
  }
  const server = (f: GroupFixture): TeamStationClient =>
    new TeamStationClient({
      baseUrl: `${f.h.origin}/api/v1`,
      token: f.h.tokens.get(101)
    })

  it('drops unscoped legacy edits, keeps A pending across B restarts, sends only to A, and clears every own store on sign-out', async () => {
    const legacy = await openCacheStore(files.open(legacyCacheFileName(user)))
    await legacy.atomically(async tx => {
      await tx.write('legacy', {
        body: 'untrusted',
        revision: '1',
        serverDigest: null,
        pending: true
      })
      await tx.enqueue({
        id: 'old',
        idempotencyKey: 'old-key',
        chain: 'team:old',
        method: 'POST',
        path: '/invalid-legacy',
        body: '{}',
        dependsOn: [],
        gameId: null
      })
    })
    await legacy.close()
    const first = phone(a)
    expect((await first.client.outboxSummary()).count).equals(0)
    const beforeA = await first.client.roster(team)
    await server(b).createRosterPlayer(team, {
      firstName: 'Shohei',
      lastName: 'Ohtani',
      jersey: '17',
      positions: ['P'],
      bats: 'left',
      throws: 'right'
    })
    const beforeB = await server(b).roster(team)
    expect(beforeB).not.deep.equals(beforeA)
    first.transport.held = true
    await first.client.createRosterPlayer(team, {
      firstName: 'Mookie',
      lastName: 'Betts',
      jersey: '50',
      positions: ['RF'],
      bats: 'right',
      throws: 'right'
    })
    expect((await first.client.outboxSummary()).count).equals(1)
    expect((await first.client.roster(team)).length).equals(beforeA.length + 1)
    await first.client.sessionRefused()

    for (let restart = 0; restart < 2; restart++) {
      const other = phone(b)
      other.transport.held = true
      // Before B can refresh, its identical key must not reveal A's pending
      // roster. A subsequent B restart can read only B's previously kept copy.
      if (restart === 0) {
        const error = await other.client
          .roster(team)
          .catch((error: unknown) => error)
        expect(error).property('code', 'offline')
      } else expect(await other.client.roster(team)).deep.equals(beforeB)
      other.transport.held = false
      other.client.wakeOutbox(true)
      await other.client.drainOutbox()
      expect((await other.client.outboxSummary()).count).equals(0)
      expect(await other.client.roster(team)).deep.equals(beforeB)
      expect(other.transport.posts).equals(0)
      await other.client.sessionRefused()
    }

    const reopened = phone(a)
    expect((await reopened.client.outboxSummary()).count).equals(1)
    reopened.client.wakeOutbox(true)
    await reopened.client.drainOutbox()
    expect((await reopened.client.outboxSummary()).count).equals(0)
    expect((await server(a).roster(team)).length).equals(beforeA.length + 1)
    expect(await server(b).roster(team)).deep.equals(beforeB)
    expect(reopened.transport.posts).equals(1)
    await reopened.client.discard(user)
    expect(readdirSync(dir)).deep.equals([])
  })
})
