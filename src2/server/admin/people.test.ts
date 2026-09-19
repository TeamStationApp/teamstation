import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import type { Database } from '../db/database'
import { onePerson } from './people'

const adminUrl =
  process.env.GS_TEST_DATABASE_URL ?? 'postgres://localhost:5432/postgres'
const scratchName = `gamestation_people_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

describe('one person, however many rows', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let pool: Pool | undefined
  let db: Kysely<Database> | undefined
  const survivor = makeId('user')
  const closed = makeId('user')
  const closedTwice = makeId('user')
  const stranger = makeId('user')

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query('select 1')
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
      return
    }
    await admin.query(`create database ${scratchName}`)
    pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })

    await db
      .insertInto('users')
      .values([
        { id: survivor, display_name: 'Jensen Puey' },
        // Closed into the survivor, and one closed into that one: a child can
        // be merged twice as more teams turn up.
        { id: closed, display_name: 'Jensen Puey', merged_into: survivor },
        { id: closedTwice, display_name: 'Jensen Puey', merged_into: closed },
        { id: stranger, display_name: 'Somebody Else' }
      ])
      .execute()
  })

  after(async function () {
    if (db != null) await db.destroy()
    else if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  it('gathers every row from the open one', async function () {
    if (db == null) this.skip()
    const person = await onePerson(db, survivor)
    expect(person.userId).equals(survivor)
    expect([...person.userIds].sort()).deep.equals(
      [survivor, closed, closedTwice].sort()
    )
  })

  it('answers the same from a closed one, whichever end it is asked from', async function () {
    if (db == null) this.skip()
    // A link sent last year names a row that has since been closed. It has to
    // land on the whole person, not on a fifth of them.
    for (const id of [closed, closedTwice]) {
      const person = await onePerson(db, id)
      expect(person.userId).equals(survivor)
      expect(person.userIds.length).equals(3)
    }
  })

  it('leaves somebody else alone', async function () {
    if (db == null) this.skip()
    const person = await onePerson(db, stranger)
    expect(person.userIds).deep.equals([stranger])
  })
})
