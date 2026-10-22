import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import { notFound } from '../../common/errors'
import { migrations } from '../../migrate/migrations'
import { migrateDown, migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { atomic } from '../db/atomic'
import { type Database, makeDatabase } from '../db/database'
import { errorHandler } from '../middleware/withErrors'
import {
  bumpNotedScopes,
  bumpSyncClock,
  noteScopeChange,
  readSyncClock,
  REVISION_HEADER,
  SCREEN_SCOPES_CHANNEL,
  type ScreenScopePayload,
  withRevision,
  withRevisionThen
} from './syncRevision'

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('the sync clock', function () {
  this.timeout(60000)
  const name = `teamstation_sync_clock_${process.pid}_${Date.now()}`
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  let admin: Pool
  let db: Kysely<Database>
  let listener: Client
  let server: ReturnType<express.Express['listen']>
  let base = ''
  const heard: ScreenScopePayload[] = []
  /** Lets the test hold a GET between its clock read and its own reads. */
  let holdRead: Promise<void> | undefined

  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    const pool = new Pool({ connectionString: url })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(url)
    await db
      .insertInto('teams')
      .values([
        { id: 'tem_clock_a', name: 'Before A', kind: 'full' },
        { id: 'tem_clock_b', name: 'Before B', kind: 'full' }
      ])
      .execute()
    listener = new Client({ connectionString: url })
    await listener.connect()
    listener.on('notification', message => {
      if (message.payload != null)
        heard.push(JSON.parse(message.payload) as ScreenScopePayload)
    })
    await listener.query(`listen ${SCREEN_SCOPES_CHANNEL}`)

    const app = express()
    app.get(
      '/teams',
      withRevision(db, async (trx, req, res) => {
        await holdRead
        if (req.query.missing != null) throw notFound()
        res.json(
          await trx
            .selectFrom('teams')
            .select(['id', 'name'])
            .orderBy('id')
            .execute()
        )
      })
    )
    // Its second step runs once the transaction is over: whether `trx` can
    // still be read through is what it answers.
    app.get(
      '/after',
      withRevisionThen(db, async (trx, _req, res) => {
        const read = await readSyncClock(trx)
        return async () => {
          const open = await readSyncClock(trx).then(
            () => true,
            () => false
          )
          res.json({ read, open })
        }
      })
    )
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    await new Promise<void>(resolve =>
      server?.close(() => {
        resolve()
      })
    )
    await listener?.end()
    await db?.destroy()
    await admin.query(`drop database if exists ${name} with (force)`)
    await admin.end()
  })

  /** Waits for a notify, which arrives after its commit. */
  async function heardRevision(revision: string): Promise<ScreenScopePayload> {
    const deadline = Date.now() + 3000
    for (;;) {
      const found = heard.find(payload => payload.revision === revision)
      if (found != null) return found
      if (Date.now() > deadline)
        throw new Error(`No notice for ${revision} in ${JSON.stringify(heard)}`)
      await wait(10)
    }
  }

  it('is seeded at 0, and its migration drops it on the way down', async function () {
    const scratch = `${name}_down`
    await admin.query(`create database ${scratch}`)
    const pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${scratch}`)
    })
    try {
      const upTo = migrations.filter(m => m.name <= '073syncClock')
      await migrateUp(pool, upTo)
      expect(
        (await pool.query('select id, value::text from sync_clock')).rows
      ).deep.equals([{ id: 1, value: '0' }])
      expect(await migrateDown(pool, upTo, 1)).deep.equals(['073syncClock'])
      const { rows } = await pool.query(
        "select 1 from pg_tables where tablename = 'sync_clock'"
      )
      expect(rows).deep.equals([])
    } finally {
      await pool.end()
      await admin.query(`drop database if exists ${scratch} with (force)`)
    }
  })

  it('takes the next revision and announces it with the ids, on commit', async function () {
    const before = await readSyncClock(db)
    const revision = await db.transaction().execute(async trx => {
      await trx
        .updateTable('teams')
        .set({ name: 'Renamed' })
        .where('id', '=', 'tem_clock_a')
        .execute()
      return await bumpSyncClock(trx, {
        teamId: 'tem_clock_a',
        gameId: undefined
      })
    })
    expect(BigInt(revision)).equals(BigInt(before) + 1n)
    expect(await heardRevision(revision)).deep.equals({
      revision,
      teamId: 'tem_clock_a'
    })
  })

  it('refuses to bump outside a transaction', async function () {
    let failure: unknown
    try {
      await bumpSyncClock(db, { userId: '1' })
    } catch (error) {
      failure = error
    }
    expect(String(failure)).includes('inside the writing transaction')
  })

  it('bumps once, as the opener’s last statements, for every change noted in its transaction', async function () {
    const before = await readSyncClock(db)
    const count = heard.length
    const revision = await atomic(db, async outer => {
      // A function given the transaction notes; it does not bump.
      await atomic(outer, async inner => {
        noteScopeChange(inner, { teamId: 'tem_clock_a', userId: '3' })
        noteScopeChange(inner, {})
      })
      expect(await readSyncClock(outer)).equals(before)
      noteScopeChange(outer, { teamId: 'tem_clock_a', userId: '3' })
      noteScopeChange(outer, { gameId: 'gam_noted' })
      return BigInt(before) + 1n
    })
    expect(await readSyncClock(db)).equals(String(revision))
    await heardRevision(String(revision))
    await wait(50)
    expect(heard.slice(count)).deep.equals([
      { revision: String(revision), teamId: 'tem_clock_a', userId: '3' },
      { revision: String(revision), gameId: 'gam_noted' }
    ])
  })

  it('takes no revision for a transaction that noted nothing, and refuses a note outside one', async function () {
    const before = await readSyncClock(db)
    expect(
      await db.transaction().execute(async trx => await bumpNotedScopes(trx))
    ).equals(undefined)
    await atomic(db, async trx => {
      noteScopeChange(trx, { gameId: undefined })
    })
    expect(await readSyncClock(db)).equals(before)
    expect(() => {
      noteScopeChange(db, { userId: '1' })
    }).throws('inside its transaction')
  })

  it('refuses a note in a transaction atomic did not open, which nothing would announce', async function () {
    const before = await readSyncClock(db)
    let refused: unknown
    await db.transaction().execute(async trx => {
      try {
        noteScopeChange(trx, { userId: '1' })
      } catch (error) {
        refused = error
      }
    })
    expect(refused)
      .instanceOf(Error)
      .property('message')
      .equals(
        'A screen scope change is noted inside a transaction atomic opened'
      )
    // Joined from inside one atomic opened, a note is kept for its opener.
    await atomic(db, async trx => {
      await atomic(trx, async joined => {
        noteScopeChange(joined, { userId: '1' })
      })
    })
    expect(BigInt(await readSyncClock(db))).equals(BigInt(before) + 1n)
  })

  it('announces nothing when the write rolls back (Rollback)', async function () {
    const before = await readSyncClock(db)
    const count = heard.length
    let failure: unknown
    try {
      await db.transaction().execute(async trx => {
        await bumpSyncClock(trx, { gameId: 'gam_rolled_back' })
        throw new Error('the write failed')
      })
    } catch (error) {
      failure = error
    }
    expect(String(failure)).includes('the write failed')
    // A later commit is heard, so anything from the rollback would be too.
    const after = await db
      .transaction()
      .execute(async trx => await bumpSyncClock(trx, { userId: '7' }))
    await heardRevision(after)
    expect(heard.slice(count).map(payload => payload.revision)).deep.equals([
      after
    ])
    expect(BigInt(after)).equals(BigInt(before) + 1n)
  })

  it('makes a second writer wait for the first to commit, so revisions show in commit order (Concurrent writers)', async function () {
    const start = BigInt(await readSyncClock(db))
    let releaseA!: () => void
    const aMayCommit = new Promise<void>(resolve => {
      releaseA = resolve
    })
    let aBumped!: () => void
    const aHasBumped = new Promise<void>(resolve => {
      aBumped = resolve
    })
    const writerA = db.transaction().execute(async trx => {
      await trx
        .updateTable('teams')
        .set({ name: 'Written by A' })
        .where('id', '=', 'tem_clock_a')
        .execute()
      const revision = await bumpSyncClock(trx, { teamId: 'tem_clock_a' })
      aBumped()
      await aMayCommit
      return revision
    })
    await aHasBumped
    let bDone = false
    const writerB = db.transaction().execute(async trx => {
      await trx
        .updateTable('teams')
        .set({ name: 'Written by B' })
        .where('id', '=', 'tem_clock_b')
        .execute()
      const revision = await bumpSyncClock(trx, { teamId: 'tem_clock_b' })
      bDone = true
      return revision
    })
    await wait(300)
    // B's update of the clock is still waiting on A's row lock.
    expect(bDone).equals(false)
    // A snapshot now sees neither write, at the revision before both.
    const early = await db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async trx => ({
        revision: await readSyncClock(trx),
        names: await trx
          .selectFrom('teams')
          .select(['id', 'name'])
          .where('id', 'in', ['tem_clock_a', 'tem_clock_b'])
          .orderBy('id')
          .execute()
      }))
    expect(BigInt(early.revision)).equals(start)
    expect(early.names.map(row => row.name)).not.includes('Written by A')
    releaseA()
    const [a, b] = await Promise.all([writerA, writerB])
    expect(BigInt(a)).equals(start + 1n)
    expect(BigInt(b)).equals(start + 2n)

    // Any snapshot at B's revision holds A's rows as well.
    const late = await db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async trx => ({
        revision: await readSyncClock(trx),
        names: await trx
          .selectFrom('teams')
          .select('name')
          .where('id', 'in', ['tem_clock_a', 'tem_clock_b'])
          .orderBy('id')
          .execute()
      }))
    expect(late.revision).equals(b)
    expect(late.names.map(row => row.name)).deep.equals([
      'Written by A',
      'Written by B'
    ])
  })

  it('answers a GET with the revision its reads were taken at (Commit order)', async function () {
    const revision = await db.transaction().execute(async trx => {
      await trx
        .updateTable('teams')
        .set({ name: 'Committed' })
        .where('id', '=', 'tem_clock_a')
        .execute()
      return await bumpSyncClock(trx, { teamId: 'tem_clock_a' })
    })
    const notice = await heardRevision(revision)
    const response = await fetch(`${base}/teams`)
    expect(response.status).equals(200)
    expect(response.headers.get(REVISION_HEADER)).equals(notice.revision)
    const teams = (await response.json()) as Array<{ name: string }>
    expect(teams[0].name).equals('Committed')
  })

  it('reads every row of a GET in the snapshot its revision came from', async function () {
    let release!: () => void
    holdRead = new Promise<void>(resolve => {
      release = resolve
    })
    const reading = fetch(`${base}/teams`)
    // The GET has read the clock and is held before its own reads.
    await wait(200)
    const revision = await db.transaction().execute(async trx => {
      await trx
        .updateTable('teams')
        .set({ name: 'After the snapshot' })
        .where('id', '=', 'tem_clock_a')
        .execute()
      return await bumpSyncClock(trx, { teamId: 'tem_clock_a' })
    })
    release()
    const response = await reading
    holdRead = undefined
    const header = response.headers.get(REVISION_HEADER)!
    const teams = (await response.json()) as Array<{ name: string }>
    // The response predates the write, and says so: its notice is newer.
    expect(teams[0].name).not.equals('After the snapshot')
    expect(BigInt(revision) > BigInt(header)).equals(true)
  })

  it('runs a route’s step after its reads once the transaction has committed', async function () {
    const response = await fetch(`${base}/after`)
    expect(response.status).equals(200)
    const revision = await readSyncClock(db)
    expect(response.headers.get(REVISION_HEADER)).equals(revision)
    expect(await response.json()).deep.equals({ read: revision, open: false })
  })

  it('passes a handler’s error on, with the revision still on the answer', async function () {
    const response = await fetch(`${base}/teams?missing=1`)
    expect(response.status).equals(404)
    expect(response.headers.get(REVISION_HEADER)).equals(
      await readSyncClock(db)
    )
  })
})
