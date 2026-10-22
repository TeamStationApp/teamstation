import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import { nodeSqliteExecutor } from '../../test/nodeSqliteExecutor'
import { openDocumentCache } from './cache'
import { cacheFileName, openCacheStore } from './cacheStore'

describe('the phone document cache', function () {
  let dir: string
  beforeEach(function () {
    dir = mkdtempSync(join(tmpdir(), 'teamstation-cache-'))
  })
  afterEach(function () {
    rmSync(dir, { recursive: true, force: true })
  })

  it('names one file per user id', function () {
    expect(cacheFileName('usr_42')).equals('teamstation-usr_42.sqlite')
    expect(cacheFileName('a/b c')).equals('teamstation-a_b_c.sqlite')
  })

  it('stores an answer with its revision and digest, and replaces it with the next', async function () {
    const store = await openCacheStore(
      nodeSqliteExecutor(join(dir, 'one.sqlite'))
    )
    expect(await store.read('home.teams')).equals(undefined)
    const first = { body: '[1]', revision: '3', serverDigest: null }
    expect(await store.store('home.teams', first)).deep.equals({
      ...first,
      pending: false
    })
    await store.store('home.teams', {
      body: '[2]',
      revision: '4',
      serverDigest: 'd1'
    })
    expect(await store.read('home.teams')).deep.equals({
      body: '[2]',
      revision: '4',
      serverDigest: 'd1',
      pending: false
    })
    await store.close()
  })

  it('keeps a pending document over a server answer', async function () {
    const executor = nodeSqliteExecutor(join(dir, 'pending.sqlite'))
    const store = await openCacheStore(executor)
    await store.store('lineups.g1', {
      body: '{"mine":true}',
      revision: '5',
      serverDigest: 'local-1'
    })
    executor.db.exec(
      "UPDATE documents SET pending = 1 WHERE key = 'lineups.g1'"
    )
    const kept = await store.store('lineups.g1', {
      body: '{"server":true}',
      revision: '6',
      serverDigest: 'd2'
    })
    expect(kept).deep.equals({
      body: '{"mine":true}',
      revision: '5',
      serverDigest: 'local-1',
      pending: true
    })
    await store.close()
  })

  it('runs one transaction at a time, and goes on after one that failed', async function () {
    const executor = nodeSqliteExecutor(join(dir, 'serial.sqlite'))
    const store = await openCacheStore(executor)
    const writes = Array.from({ length: 8 }, async (_, index) => {
      await store.store(`game.g${index}`, {
        body: String(index),
        revision: '1',
        serverDigest: null
      })
    })
    await Promise.all(writes)
    executor.db.exec('DROP TABLE documents')
    let failure: unknown
    try {
      await store.read('game.g1')
    } catch (error) {
      failure = error
    }
    expect(failure).instanceOf(Error)
    executor.db.exec(
      'CREATE TABLE documents (key text PRIMARY KEY, body text NOT NULL, revision text NOT NULL, server_digest text, pending integer NOT NULL DEFAULT 0)'
    )
    expect(await store.read('game.g1')).equals(undefined)
    await store.close()
    // Closing twice is closing once.
    await store.close()
  })

  it('returns an inflight outbox row whose lease ran out to pending on open (Lease)', async function () {
    const path = join(dir, 'lease.sqlite')
    const first = nodeSqliteExecutor(path)
    await (await openCacheStore(first)).close()
    const db = nodeSqliteExecutor(path)
    const insert = db.db.prepare(
      `INSERT INTO outbox (id, idempotency_key, seq, chain, method, path, body,
         depends_on, state, attempts, lease_until, game_id)
       VALUES (?, ?, ?, 'game:g1', 'POST', '/games/g1/events', '{}', '[]', ?, 0, ?, 'g1')`
    )
    insert.run('expired', 'k1', 1, 'inflight', 1_000)
    insert.run('leased', 'k2', 2, 'inflight', 9_000)
    insert.run('unleased', 'k3', 3, 'inflight', null)
    insert.run('parked', 'k4', 4, 'parked', null)
    const store = await openCacheStore(db, { now: () => 5_000 })
    const states = db.db
      .prepare('SELECT id, state, lease_until FROM outbox ORDER BY seq')
      .all()
      .map(row => ({ ...row }))
    expect(states).deep.equals([
      { id: 'expired', state: 'pending', lease_until: null },
      { id: 'leased', state: 'inflight', lease_until: 9_000 },
      { id: 'unleased', state: 'pending', lease_until: null },
      { id: 'parked', state: 'parked', lease_until: null }
    ])
    const players = db.db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'local_players'")
      .all()
    expect(players).length(1)
    await store.close()
  })

  it('deletes the database file on sign-out (Sign-out)', async function () {
    const path = join(dir, cacheFileName('usr_7'))
    const store = await openCacheStore(nodeSqliteExecutor(path))
    await store.store('home.teams', {
      body: '[]',
      revision: '1',
      serverDigest: null
    })
    expect(existsSync(path)).equals(true)
    await store.destroy()
    expect(existsSync(path)).equals(false)
  })

  it('keeps nothing on the web', async function () {
    const web = await openDocumentCache('usr_1')
    const document = { body: '[]', revision: '1', serverDigest: null }
    expect(await web.store('home.teams', document)).deep.equals({
      ...document,
      pending: false
    })
    expect(await web.read('home.teams')).equals(undefined)
    let refused: unknown
    try {
      await web.atomically(async () => undefined)
    } catch (error) {
      refused = error
    }
    expect(refused).property('message').equals('The web keeps no outbox')
    await web.close()
    await web.destroy()
  })

  it('queues, updates and removes writes, and records players made on the phone', async function () {
    const store = await openCacheStore(
      nodeSqliteExecutor(join(dir, 'queue.sqlite'))
    )
    const row = {
      id: 'r1',
      idempotencyKey: 'k1',
      chain: 'game:g1',
      method: 'POST',
      path: '/games/g1/lineups',
      body: '{}',
      dependsOn: ['player-5'],
      gameId: 'g1'
    }
    const queued = await store.atomically(async tx => {
      await tx.write('lineups.g1', {
        body: '{"digest":"local-1"}',
        revision: '3',
        serverDigest: 'd0',
        pending: true
      })
      const first = await tx.enqueue(row)
      const second = await tx.enqueue({
        ...row,
        id: 'r2',
        idempotencyKey: 'k2',
        dependsOn: []
      })
      return [first, second]
    })
    expect(queued.map(item => item.seq)).deep.equals([1, 2])
    expect(queued[0]).deep.include({
      state: 'pending',
      attempts: 0,
      leaseUntil: null,
      message: null,
      dependsOn: ['player-5']
    })
    expect(await store.read('lineups.g1')).deep.include({ pending: true })
    await store.atomically(async tx => {
      await tx.update('r1', {})
      await tx.update('r1', { state: 'dead', message: 'No', attempts: 2 })
      await tx.removeKey('k2')
      await tx.addLocalPlayer({
        localId: 5,
        serverId: null,
        teamId: 't1',
        body: '{}'
      })
      await tx.landPlayer(5, 905, '{"gumboId":905}')
    })
    const [left, ...rest] = await store.atomically(
      async tx => await tx.outbox()
    )
    expect(rest).deep.equals([])
    expect(left).deep.include({ state: 'dead', message: 'No', attempts: 2 })
    expect(
      await store.atomically(async tx => await tx.localPlayers())
    ).deep.equals([
      { localId: 5, serverId: 905, teamId: 't1', body: '{"gumboId":905}' }
    ])
    await store.atomically(async tx => {
      await tx.remove('r1')
    })
    expect(await store.atomically(async tx => await tx.outbox())).deep.equals(
      []
    )
    await store.close()
  })

  it('adds the outbox message column to a file made before it, and reads a bad dependency list as none', async function () {
    const executor = nodeSqliteExecutor(join(dir, 'older.sqlite'))
    executor.db.exec(`CREATE TABLE outbox (
      id text PRIMARY KEY, idempotency_key text NOT NULL UNIQUE,
      seq integer NOT NULL, chain text NOT NULL, method text NOT NULL,
      path text NOT NULL, body text NOT NULL, depends_on text NOT NULL,
      state text NOT NULL, attempts integer NOT NULL, lease_until integer,
      game_id text)`)
    executor.db.exec(`INSERT INTO outbox VALUES ('r1', 'k1', 1, 'team:t1',
      'POST', '/teams/t1/roster-players', '{}', '{}', 'pending', 0, NULL, NULL)`)
    const store = await openCacheStore(executor)
    const [row] = await store.atomically(async tx => await tx.outbox())
    expect(row).deep.include({ message: null, dependsOn: [], gameId: null })
    await store.close()
    // Opened again, the column is there already.
    const again = await openCacheStore(
      nodeSqliteExecutor(join(dir, 'older.sqlite'))
    )
    await again.close()
  })
})
