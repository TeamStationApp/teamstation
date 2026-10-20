import { expect } from 'chai'
import { type Kysely, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { userIdOfValue } from '../../common/userId'
import { closeInto } from '../../server/admin/people'
import { settleAccount } from '../../server/auth/settleAccount'
import { type Database, makeDatabase } from '../../server/db/database'
import { resolveGumboIds } from '../../server/scoring/gumboIds'
import {
  ensureGumboId,
  gumboIdOf,
  insertUser
} from '../../server/users/insertUser'
import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migration070PlayerGumboIds } from './070playerGumboIds'
import { migrations } from './index'

describe('070 scoring identities only when needed', function () {
  this.timeout(60000)
  const name = `teamstation_playerids_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool
  let db: Kysely<Database>
  let sequence = 0
  const person = async (): Promise<string> =>
    await insertUser(db, { display_name: 'Hank Aaron' }, () =>
      userIdOfValue((1n << 90n) + BigInt(++sequence))
    )
  const rejected = async (operation: Promise<unknown>): Promise<void> => {
    let error: any
    try {
      await operation
    } catch (caught) {
      error = caught
    }
    expect(error?.code).equals('TSG01')
  }
  const forceExhaustion = async (trx: Kysely<Database>): Promise<void> => {
    await sql`alter function ts_ensure_gumbo_id(text,bigint[]) rename to fixture_ensure_gumbo_id`.execute(
      trx
    )
    await sql`create function ts_ensure_gumbo_id(value text, draws bigint[] default null) returns bigint
      language sql as 'select fixture_ensure_gumbo_id(value,array[0,0,0,0,0]::bigint[])'`.execute(
      trx
    )
  }
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    pool = new Pool({ connectionString: url })
    await migrateUp(pool, migrations)
    db = makeDatabase(url)
    await db
      .insertInto('teams')
      .values({ id: 'tem_identity', name: 'Hosts' })
      .execute()
  })
  after(async () => {
    await db?.destroy()
    await pool?.end()
    await admin?.query(`drop database if exists ${name}`)
    await admin?.end()
  })
  it('sign-in creates an adult without a scoring identity', async () => {
    const account = await settleAccount(db, 'account@example.test', {
      displayName: 'Babe Ruth'
    })
    expect(account.createdAccount).equals(true)
    expect(await gumboIdOf(db, account.userId)).equals(null)
    expect((await settleAccount(db, 'account@example.test')).userId).equals(
      account.userId
    )
    expect(await gumboIdOf(db, account.userId)).equals(null)
  })
  it('allocates on player insertion and promotion, preserves on demotion/removal, and handles a moved membership', async () => {
    const adult = await person()
    const player = await person()
    const moved = await person()
    await db
      .insertInto('memberships')
      .values([
        {
          id: 'mem_adult',
          team_id: 'tem_identity',
          user_id: adult,
          is_player: false
        },
        {
          id: 'mem_player',
          team_id: 'tem_identity',
          user_id: player,
          is_player: true
        }
      ])
      .execute()
    expect(await gumboIdOf(db, adult)).equals(null)
    const playerId = await gumboIdOf(db, player)
    expect(playerId).greaterThan(0)
    await db
      .updateTable('memberships')
      .set({ is_player: true })
      .where('id', '=', 'mem_adult')
      .execute()
    const adultId = await gumboIdOf(db, adult)
    expect(adultId).greaterThan(0)
    await db
      .updateTable('memberships')
      .set({ is_player: false })
      .where('id', '=', 'mem_adult')
      .execute()
    expect(await gumboIdOf(db, adult)).equals(adultId)
    await db
      .updateTable('memberships')
      .set({ is_player: true })
      .where('id', '=', 'mem_adult')
      .execute()
    expect(await gumboIdOf(db, adult)).equals(adultId)
    await db
      .updateTable('memberships')
      .set({ user_id: moved })
      .where('id', '=', 'mem_player')
      .execute()
    expect(await gumboIdOf(db, moved)).greaterThan(0)
    expect(await gumboIdOf(db, player)).equals(playerId)
    await db
      .deleteFrom('memberships')
      .where('id', 'in', ['mem_adult', 'mem_player'])
      .execute()
    expect(await gumboIdOf(db, adult)).equals(adultId)
  })
  it('merges a guest into an adult without membership, retains history, and resolves through a second merge', async () => {
    const guest = await person()
    const adult = await person()
    const final = await person()
    const historical = await ensureGumboId(db, guest)
    await closeInto(db, guest, adult)
    const survivor = await gumboIdOf(db, adult)
    expect(survivor).greaterThan(0)
    expect(await gumboIdOf(db, guest)).equals(historical)
    expect((await resolveGumboIds(db, [historical])).get(historical)).equals(
      survivor
    )
    await closeInto(db, adult, final)
    const finalId = await gumboIdOf(db, final)
    expect(finalId).greaterThan(0)
    expect([
      ...(await resolveGumboIds(db, [historical, survivor!]))
    ]).deep.equals([
      [historical, finalId],
      [survivor, finalId]
    ])
    expect(
      await db
        .selectFrom('memberships')
        .selectAll()
        .where('user_id', 'in', [guest, adult, final])
        .execute()
    ).length(0)
    expect(await gumboIdOf(db, guest)).equals(historical)
  })
  it('inherits a merged descendant mapping and reuses an existing final mapping', async () => {
    const descendant = await person()
    const closing = await person()
    const final = await person()
    const historical = await ensureGumboId(db, descendant)
    await db
      .updateTable('users')
      .set({ merged_into: closing })
      .where('id', '=', descendant)
      .execute()
    expect(await gumboIdOf(db, closing)).equals(null)
    const finalId = await ensureGumboId(db, final)
    await closeInto(db, closing, final)
    expect(await gumboIdOf(db, final)).equals(finalId)
    expect((await resolveGumboIds(db, [historical])).get(historical)).equals(
      finalId
    )
  })
  it('moves player memberships onto a newly allocated survivor but leaves adult-only merges without a mapping', async () => {
    const player = await person()
    const survivor = await person()
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_merge',
        team_id: 'tem_identity',
        user_id: player,
        is_player: true
      })
      .execute()
    await closeInto(db, player, survivor)
    expect(await gumboIdOf(db, survivor)).greaterThan(0)
    expect(
      (
        await db
          .selectFrom('memberships')
          .selectAll()
          .where('id', '=', 'mem_merge')
          .executeTakeFirstOrThrow()
      ).user_id
    ).equals(survivor)
    const a = await person()
    const b = await person()
    await closeInto(db, a, b)
    expect(await gumboIdOf(db, a)).equals(null)
    expect(await gumboIdOf(db, b)).equals(null)
  })
  it('exhausted draws roll back account and player membership together', async () => {
    const id = userIdOfValue((1n << 100n) + 1n)
    await rejected(
      db.transaction().execute(async trx => {
        await forceExhaustion(trx)
        await insertUser(trx, { display_name: 'Babe Ruth' }, () => id)
        await trx
          .insertInto('memberships')
          .values({
            id: 'mem_failed',
            team_id: 'tem_identity',
            user_id: id,
            is_player: true
          })
          .execute()
      })
    )
    expect(
      await db.selectFrom('users').select('id').where('id', '=', id).execute()
    ).length(0)
    expect(
      await db
        .selectFrom('memberships')
        .select('id')
        .where('id', '=', 'mem_failed')
        .execute()
    ).length(0)
    expect(await gumboIdOf(db, id)).equals(null)
  })
  it('exhausted draws roll back the entire merge and preserve the historical mapping', async () => {
    const guest = await person()
    const survivor = await person()
    const historical = await ensureGumboId(db, guest)
    await rejected(
      db.transaction().execute(async trx => {
        await forceExhaustion(trx)
        await closeInto(trx, guest, survivor)
      })
    )
    expect(
      (
        await db
          .selectFrom('users')
          .select('merged_into')
          .where('id', '=', guest)
          .executeTakeFirstOrThrow()
      ).merged_into
    ).equals(null)
    expect(await gumboIdOf(db, survivor)).equals(null)
    expect(await gumboIdOf(db, guest)).equals(historical)
  })
  it('refuses down without allocating mappings or altering the schema', async () => {
    const before = await db
      .selectFrom('gumbo_ids')
      .selectAll()
      .orderBy('gumbo_id')
      .execute()
    let failure: unknown
    try {
      await migrateDown(pool, [migration070PlayerGumboIds])
    } catch (error) {
      failure = error
    }
    expect(String(failure)).includes('Restore the verified pre-cutover backup')
    expect(
      await db.selectFrom('gumbo_ids').selectAll().orderBy('gumbo_id').execute()
    ).deep.equals(before)
    expect(
      (
        await pool.query(
          "select 1 from pg_trigger where tgname='memberships_player_gumbo_id'"
        )
      ).rowCount
    ).equals(1)
  })
})
