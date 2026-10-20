import { expect } from 'chai'
import { type Kysely, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { userIdOfValue } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { type Database, makeDatabase } from '../db/database'
import { ensureGumboId, gumboIdOf, insertUser } from './insertUser'

describe('atomic account creation', function () {
  this.timeout(60000)
  const name = `teamstation_accountids_${process.pid}_${Date.now()}`
  let admin: Pool
  let db: Kysely<Database>
  const id = (n: number): string => userIdOfValue((1n << 80n) + BigInt(n))
  const rejects = async (
    operation: Promise<unknown>,
    message: string
  ): Promise<void> => {
    let failure: unknown
    try {
      await operation
    } catch (error) {
      failure = error
    }
    expect(String(failure)).includes(message)
  }
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    const pool = new Pool({ connectionString: url })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '070')
    )
    await pool.end()
    db = makeDatabase(url)
  })
  after(async () => {
    await db?.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('reserves the account through an insert, retries collisions, and returns its mapping', async () => {
    await insertUser(db, { display_name: 'Hank Aaron' }, () => id(1))
    const draws = [id(1), id(2)]
    expect(
      await insertUser(db, { display_name: 'Babe Ruth' }, () => draws.shift()!)
    ).equals(id(2))
    expect(draws).deep.equals([])
    const gumboId = await gumboIdOf(db, id(2))
    expect(gumboId).greaterThan(0)
    expect(await ensureGumboId(db, id(2))).equals(gumboId)
    expect(await gumboIdOf(db, id(99))).equals(null)
  })
  it('stops after five collisions and never retries unrelated constraints', async () => {
    let attempts = 0
    await rejects(
      insertUser(db, { display_name: 'Mike Trout' }, () => {
        attempts++
        return id(1)
      }),
      'Five account identity'
    )
    expect(attempts).equals(5)
    await sql`alter table users add constraint fixture_name_rejected check(display_name <> 'rejected')`.execute(
      db
    )
    attempts = 0
    await rejects(
      insertUser(db, { display_name: 'rejected' }, () => {
        attempts++
        return id(3)
      }),
      'fixture_name_rejected'
    )
    expect(attempts).equals(1)
    expect(
      await db
        .selectFrom('users')
        .select('id')
        .where('id', '=', id(3))
        .execute()
    ).deep.equals([])
    await rejects(
      insertUser(db, { display_name: 'Mike Trout' }, () => '123'),
      'canonical user id'
    )
  })
  it('rolls back account and mapping with its enclosing transaction', async () => {
    await rejects(
      db.transaction().execute(async trx => {
        expect(
          await insertUser(trx, { display_name: 'Ichiro Suzuki' }, () => id(4))
        ).equals(id(4))
        expect(await gumboIdOf(trx, id(4))).greaterThan(0)
        throw new Error('later operation refused')
      }),
      'later operation refused'
    )
    expect(
      await db
        .selectFrom('users')
        .select('id')
        .where('id', '=', id(4))
        .execute()
    ).deep.equals([])
    expect(await gumboIdOf(db, id(4))).equals(null)
  })
  it('rolls back the user when its scoring identity cannot be inserted', async () => {
    await sql`alter table gumbo_ids add constraint fixture_mapping_rejected check(user_id <> ${sql.lit(id(5))})`.execute(
      db
    )
    await rejects(
      insertUser(db, { display_name: 'Lou Gehrig' }, () => id(5)),
      'fixture_mapping_rejected'
    )
    expect(
      await db
        .selectFrom('users')
        .select('id')
        .where('id', '=', id(5))
        .execute()
    ).deep.equals([])
  })
})
