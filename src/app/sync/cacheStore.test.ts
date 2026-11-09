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
      pending: false,
      serverBody: '[1]'
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
      pending: false,
      serverBody: '[2]'
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
      pending: true,
      serverBody: '{"mine":true}'
    })
    // The server's own answer is recorded beside the pending body.
    expect(
      await store.storeServer('lineups.g1', {
        body: '{"server":true}',
        revision: '6',
        serverDigest: 'd2'
      })
    ).deep.equals({
      body: '{"mine":true}',
      revision: '5',
      serverDigest: 'd2',
      pending: true,
      serverBody: '{"server":true}'
    })
    // A local write leaves the server's body as it was.
    await store.atomically(async tx => {
      await tx.write('lineups.g1', {
        body: '{"mine":2}',
        revision: '5',
        serverDigest: 'd2',
        pending: true
      })
    })
    expect(await store.read('lineups.g1')).deep.include({
      body: '{"mine":2}',
      serverBody: '{"server":true}'
    })
    // With no queued write, the server's answer is the body.
    executor.db.exec(
      "UPDATE documents SET pending = 0 WHERE key = 'lineups.g1'"
    )
    expect(
      await store.storeServer('lineups.g1', {
        body: '{"server":3}',
        revision: '7',
        serverDigest: 'd3'
      })
    ).deep.include({ body: '{"server":3}', serverDigest: 'd3', pending: false })
    expect(
      await store.storeServer('game.g1', {
        body: '{}',
        revision: '0',
        serverDigest: null
      })
    ).deep.include({ body: '{}', serverBody: '{}' })
    await store.close()
  })

  it('adds the server body column and the schedule tables to a file made before them, and keeps a schedule page with its cursors', async function () {
    const executor = nodeSqliteExecutor(join(dir, 'before.sqlite'))
    executor.db.exec(`CREATE TABLE documents (
      key text PRIMARY KEY, body text NOT NULL, revision text NOT NULL,
      server_digest text, pending integer NOT NULL DEFAULT 0)`)
    executor.db.exec(
      "INSERT INTO documents VALUES ('lineups.g1', '{}', '0', 'd1', 1)"
    )
    const store = await openCacheStore(executor)
    expect(await store.read('lineups.g1')).deep.include({ serverBody: null })
    await store.storeServer('lineups.g1', {
      body: '{"s":1}',
      revision: '0',
      serverDigest: 'd2'
    })
    expect(await store.read('lineups.g1')).deep.include({
      body: '{}',
      serverDigest: 'd2',
      serverBody: '{"s":1}'
    })
    const page = {
      scope: 'team:t1',
      window: 'all+asc',
      cursor: 'first',
      gameIds: ['g1', 'g2'],
      meta: { nextCursor: 'n1', prevCursor: 'p1', anchorId: 'g1', counts: null }
    }
    await store.atomically(async tx => {
      await tx.writeSchedule('GameSummary', page, [
        { id: 'g1', body: '{"id":"g1"}' },
        { id: 'g2', body: '{"id":"g2"}' }
      ])
      await tx.writeSchedule('GameSummary', { ...page, gameIds: ['g2'] }, [
        { id: 'g2', body: '{"id":"g2","v":2}' }
      ])
    })
    const read = await store.atomically(async tx => ({
      pages: await tx.schedulePages('team:t1', ['all+asc']),
      none: await tx.schedulePages('team:t1', []),
      rows: await tx.scheduleRows('GameSummary', ['g2', 'g1', 'g2', 'g9']),
      next: await tx.scheduleWindowOf('team:t1', 'n1'),
      prev: await tx.scheduleWindowOf('team:t1', 'p1'),
      other: await tx.scheduleWindowOf('team:t2', 'n1')
    }))
    expect(read.pages).deep.equals([{ ...page, gameIds: ['g2'] }])
    expect(read.none).deep.equals([])
    expect(read.rows).deep.equals([
      { id: 'g2', body: '{"id":"g2","v":2}' },
      { id: 'g1', body: '{"id":"g1"}' }
    ])
    expect([read.next, read.prev, read.other]).deep.equals([
      'all+asc',
      'all+asc',
      undefined
    ])
    await store.close()
    // Opened again, the columns and tables are there already.
    await (
      await openCacheStore(nodeSqliteExecutor(join(dir, 'before.sqlite')))
    ).close()
  })

  it('reads the schedule list documents an older build kept into the set once', async function () {
    const executor = nodeSqliteExecutor(join(dir, 'legacy.sqlite'))
    executor.db.exec(`CREATE TABLE documents (
      key text PRIMARY KEY, body text NOT NULL, revision text NOT NULL,
      server_digest text, pending integer NOT NULL DEFAULT 0)`)
    const insert = executor.db.prepare(
      "INSERT INTO documents (key, body, revision) VALUES (?, ?, '0')"
    )
    const game = (id: string): Record<string, unknown> => ({ id })
    insert.run('games.upcoming', JSON.stringify([game('u1')]))
    insert.run(
      'games.past.page',
      JSON.stringify({
        items: [game('p1'), game('p2')],
        nextCursor: 'n',
        prevCursor: null,
        anchorId: null,
        counts: { total: 2 }
      })
    )
    insert.run('games.videos.page', JSON.stringify({ items: [game('p2')] }))
    insert.run('games.all', '{broken')
    insert.run('games.all.page', JSON.stringify({ items: [{ noId: 1 }] }))
    const store = await openCacheStore(executor)
    const pages = (): unknown =>
      executor.db
        .prepare(
          'SELECT scope, "window", cursor, game_ids, page_meta FROM schedule_pages ORDER BY "window", cursor'
        )
        .all()
        .map(row => ({ ...row }))
    expect(pages()).deep.equals([
      {
        scope: 'me',
        window: 'all+videos',
        cursor: 'first',
        game_ids: '["p2"]',
        page_meta:
          '{"nextCursor":null,"prevCursor":null,"anchorId":null,"counts":null}'
      },
      {
        scope: 'me',
        window: 'past',
        cursor: 'first',
        game_ids: '["p1","p2"]',
        page_meta:
          '{"nextCursor":"n","prevCursor":null,"anchorId":null,"counts":{"total":2}}'
      },
      {
        scope: 'me',
        window: 'upcoming',
        cursor: 'list',
        game_ids: '["u1"]',
        page_meta:
          '{"nextCursor":null,"prevCursor":null,"anchorId":null,"counts":null}'
      }
    ])
    expect(
      executor.db
        .prepare(
          "SELECT COUNT(*) AS n FROM schedule_games WHERE shape = 'SeasonGame'"
        )
        .get()
    ).property('n', 3)
    // The documents stay, and a second open reads them into nothing.
    expect(await store.read('games.upcoming')).not.equals(undefined)
    executor.db.exec('DELETE FROM schedule_pages WHERE "window" = \'past\'')
    await store.close()
    const again = nodeSqliteExecutor(join(dir, 'legacy.sqlite'))
    await (await openCacheStore(again)).close()
    const left = nodeSqliteExecutor(join(dir, 'legacy.sqlite'))
    expect(
      left.db.prepare('SELECT COUNT(*) AS n FROM schedule_pages').get()
    ).property('n', 2)
    left.db.close()
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
      'CREATE TABLE documents (key text PRIMARY KEY, body text NOT NULL, revision text NOT NULL, server_digest text, pending integer NOT NULL DEFAULT 0, server_body text)'
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
    expect(await web.storeServer('home.teams', document)).deep.equals({
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
        dependsOn: [],
        names: '{"12":"Juan Soto"}'
      })
      return [first, second]
    })
    expect(queued.map(item => item.seq)).deep.equals([1, 2])
    expect(queued[0]).deep.include({
      state: 'pending',
      attempts: 0,
      leaseUntil: null,
      message: null,
      names: null,
      background: false,
      dependsOn: ['player-5']
    })
    expect(queued[1]).deep.include({ names: '{"12":"Juan Soto"}' })
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

  it('adds the outbox message, names and background columns to a file made before them, and reads a bad dependency list as none (U36)', async function () {
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
    expect(row).deep.include({
      message: null,
      names: null,
      background: false,
      dependsOn: [],
      gameId: null
    })
    // A row queued in the background reads back as one.
    await store.atomically(async tx => {
      await tx.enqueue({
        id: 'r2',
        idempotencyKey: 'k2',
        chain: 'game:g1',
        method: 'PUT',
        path: '/games/g1/unroster',
        body: '{}',
        dependsOn: [],
        gameId: 'g1',
        background: true
      })
    })
    const rows = await store.atomically(async tx => await tx.outbox())
    expect(rows.map(each => each.background)).deep.equals([false, true])
    await store.close()
    // Opened again, the column is there already.
    const again = await openCacheStore(
      nodeSqliteExecutor(join(dir, 'older.sqlite'))
    )
    await again.close()
  })
})
