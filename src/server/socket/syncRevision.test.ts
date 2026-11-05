import { expect } from 'chai'
import { type Kysely, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import { migrations } from '../../migrate/migrations'
import { migrateDown, migrateUp } from '../../migrate/runner'
import {
  dropScratchDatabase,
  testDatabaseUrl
} from '../../migrate/testDatabase'
import { recordStatements, type SentStatement } from '../../test/pgStatements'
import { atomic } from '../db/atomic'
import { type Database, makeDatabase } from '../db/database'
import {
  announceNoted,
  announceNotedScopes,
  noteScopeChange,
  SCREEN_SCOPES_CHANNEL,
  type ScreenScopePayload
} from './syncRevision'

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** The payloads of each `pg_notify` statement among `sent`. */
const notifies = (sent: readonly SentStatement[]): ScreenScopePayload[][] =>
  sent
    .filter(
      statement =>
        statement.text.includes('pg_notify(') &&
        statement.values[0] === SCREEN_SCOPES_CHANNEL
    )
    .map(statement =>
      (statement.values[1] as string[]).map(
        payload => JSON.parse(payload) as ScreenScopePayload
      )
    )

describe('announcing screen scope changes', function () {
  this.timeout(60000)
  const name = `teamstation_scope_notes_${process.pid}_${Date.now()}`
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  let admin: Pool
  let db: Kysely<Database>
  let listener: Client
  const heard: ScreenScopePayload[] = []

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
        { id: 'tem_notes_a', name: 'Before A', kind: 'full' },
        { id: 'tem_notes_b', name: 'Before B', kind: 'full' }
      ])
      .execute()
    listener = new Client({ connectionString: url })
    await listener.connect()
    listener.on('notification', message => {
      if (message.payload != null)
        heard.push(JSON.parse(message.payload) as ScreenScopePayload)
    })
    await listener.query(`listen ${SCREEN_SCOPES_CHANNEL}`)
  })

  after(async () => {
    await listener?.end()
    await db?.destroy()
    await dropScratchDatabase(admin, name)
    await admin.end()
  })

  /**
   * Waits for a notify naming exactly `ids` among those from `from` on, which
   * arrives after its commit.
   */
  async function heardNamed(
    ids: ScreenScopePayload,
    from: number
  ): Promise<ScreenScopePayload> {
    const deadline = Date.now() + 3000
    for (;;) {
      const found = heard
        .slice(from)
        .find(payload => JSON.stringify(payload) === JSON.stringify(ids))
      if (found != null) return found
      if (Date.now() > deadline)
        throw new Error(
          `No notice for ${JSON.stringify(ids)} in ${JSON.stringify(heard)}`
        )
      await wait(10)
    }
  }

  it('has no sync clock once migrated, and gets it back at 0 on the way down', async function () {
    const { rows: none } = await sql`
      select 1 from pg_tables where tablename = 'sync_clock'`.execute(db)
    expect(none).deep.equals([])
    const scratch = `${name}_down`
    await admin.query(`create database ${scratch}`)
    const pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${scratch}`)
    })
    const clock = async (): Promise<unknown[]> =>
      (
        await pool.query(
          "select 1 from pg_tables where tablename = 'sync_clock'"
        )
      ).rows
    try {
      const before = migrations.filter(m => m.name < '110dropSyncClock')
      await migrateUp(pool, before)
      await pool.query('update sync_clock set value = 41 where id = 1')
      await migrateUp(pool, migrations)
      expect(await clock()).deep.equals([])
      expect(await migrateDown(pool, migrations, 1)).deep.equals([
        '110dropSyncClock'
      ])
      expect(
        (await pool.query('select id, value::text from sync_clock')).rows
      ).deep.equals([{ id: 1, value: '0' }])
      await migrateUp(pool, migrations)
      expect(await clock()).deep.equals([])
    } finally {
      await pool.end()
      await dropScratchDatabase(admin, scratch)
    }
  })

  it('announces the ids, with no revision, in one statement, on commit', async function () {
    const count = heard.length
    const { sent } = await recordStatements(async () => {
      await db.transaction().execute(async trx => {
        await trx
          .updateTable('teams')
          .set({ name: 'Renamed' })
          .where('id', '=', 'tem_notes_a')
          .execute()
        await announceNotedScopes(trx, [
          { teamId: 'tem_notes_a', gameId: undefined },
          { teamId: 'tem_notes_a' },
          { gameId: 'gam_announced' }
        ])
      })
    })
    // One notify per distinct set of ids, all in one statement.
    expect(notifies(sent)).deep.equals([
      [{ teamId: 'tem_notes_a' }, { gameId: 'gam_announced' }]
    ])
    expect(
      sent.some(statement => statement.text.includes('sync_clock'))
    ).equals(false)
    await heardNamed({ gameId: 'gam_announced' }, count)
    expect(heard.slice(count)).deep.equals([
      { teamId: 'tem_notes_a' },
      { gameId: 'gam_announced' }
    ])
  })

  it('refuses to announce outside a transaction', async function () {
    let failure: unknown
    try {
      await announceNotedScopes(db, { userId: '1' })
    } catch (error) {
      failure = error
    }
    expect(String(failure)).includes('inside the writing transaction')
  })

  it('announces once, as the opener’s last statement before its commit, for every change noted in its transaction', async function () {
    const count = heard.length
    const { sent } = await recordStatements(async () => {
      await atomic(db, async outer => {
        // A function given the transaction notes; it does not announce.
        await atomic(outer, async inner => {
          noteScopeChange(inner, { teamId: 'tem_notes_a', userId: '3' })
          noteScopeChange(inner, {})
        })
        noteScopeChange(outer, { teamId: 'tem_notes_a', userId: '3' })
        noteScopeChange(outer, { gameId: 'gam_noted' })
        await outer
          .updateTable('teams')
          .set({ name: 'Noted' })
          .where('id', '=', 'tem_notes_b')
          .execute()
      })
    })
    const texts = sent.map(statement => statement.text)
    expect(notifies(sent)).deep.equals([
      [{ teamId: 'tem_notes_a', userId: '3' }, { gameId: 'gam_noted' }]
    ])
    expect(texts.at(-2)).includes('pg_notify(')
    expect(texts.at(-1)).equals('commit')
    await heardNamed({ gameId: 'gam_noted' }, count)
    await wait(50)
    expect(heard.slice(count)).deep.equals([
      { teamId: 'tem_notes_a', userId: '3' },
      { gameId: 'gam_noted' }
    ])
  })

  it('sends nothing for a transaction that noted nothing, and refuses a note outside one', async function () {
    const { sent } = await recordStatements(async () => {
      await db.transaction().execute(async trx => {
        await announceNoted(trx)
      })
      await atomic(db, async trx => {
        noteScopeChange(trx, { gameId: undefined })
      })
    })
    expect(notifies(sent)).deep.equals([])
    expect(() => {
      noteScopeChange(db, { userId: '1' })
    }).throws('inside its transaction')
  })

  it('refuses a note in a transaction atomic did not open, which nothing would announce', async function () {
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
    const count = heard.length
    await atomic(db, async trx => {
      await atomic(trx, async joined => {
        noteScopeChange(joined, { userId: 'joined' })
      })
    })
    await heardNamed({ userId: 'joined' }, count)
  })

  it('announces nothing when the write rolls back (Rollback)', async function () {
    const count = heard.length
    let failure: unknown
    // Its foreign key is checked at commit, after the notify was sent.
    await sql`create table refuse_at_commit (
      id integer primary key,
      parent integer references refuse_at_commit (id)
        deferrable initially deferred
    )`.execute(db)
    const { sent } = await recordStatements(async () => {
      try {
        await atomic(db, async trx => {
          noteScopeChange(trx, { gameId: 'gam_rolled_back' })
          await sql`insert into refuse_at_commit values (1, 2)`.execute(trx)
        })
      } catch (error) {
        failure = error
      }
    })
    expect(String(failure)).includes('foreign key')
    // The notify statement ran, and the rollback dropped what it sent.
    expect(notifies(sent)).deep.equals([[{ gameId: 'gam_rolled_back' }]])
    // A later commit is heard, so anything from the rollback would be too.
    await db.transaction().execute(async trx => {
      await announceNotedScopes(trx, { userId: '7' })
    })
    await heardNamed({ userId: '7' }, count)
    expect(heard.slice(count)).deep.equals([{ userId: '7' }])
  })

  it('lets a second writer announce and commit while the first is still open (Concurrent writers)', async function () {
    const count = heard.length
    let releaseA!: () => void
    const aMayCommit = new Promise<void>(resolve => {
      releaseA = resolve
    })
    let aAnnounced!: () => void
    const aHasAnnounced = new Promise<void>(resolve => {
      aAnnounced = resolve
    })
    const writerA = atomic(db, async trx => {
      await trx
        .updateTable('teams')
        .set({ name: 'Written by A' })
        .where('id', '=', 'tem_notes_a')
        .execute()
      noteScopeChange(trx, { teamId: 'tem_notes_a' })
      await announceNoted(trx)
      aAnnounced()
      await aMayCommit
    })
    await aHasAnnounced
    try {
      // B writes, announces and commits with A open: no row in common.
      await atomic(db, async trx => {
        await trx
          .updateTable('teams')
          .set({ name: 'Written by B' })
          .where('id', '=', 'tem_notes_b')
          .execute()
        noteScopeChange(trx, { teamId: 'tem_notes_b' })
      })
      const { rows } = await sql<{ waiting: number }>`
        select count(*)::integer as waiting from pg_locks where not granted`.execute(
        db
      )
      expect(rows[0].waiting).equals(0)
      await heardNamed({ teamId: 'tem_notes_b' }, count)
      // A's notice is not out until A commits.
      expect(heard.slice(count)).deep.equals([{ teamId: 'tem_notes_b' }])
    } finally {
      releaseA()
      await writerA
    }
    await heardNamed({ teamId: 'tem_notes_a' }, count)
    expect(heard.slice(count)).deep.equals([
      { teamId: 'tem_notes_b' },
      { teamId: 'tem_notes_a' }
    ])
  })
})
