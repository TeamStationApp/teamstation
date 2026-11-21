import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { userIdOfValue } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import {
  createMigratedDatabase,
  dropScratchDatabase,
  testDatabaseUrl,
  testDatabaseUrlOf
} from '../../migrate/testDatabase'
import { type Database, makeDatabase } from '../db/database'
import { ageBandOfUser, ageBandsOf } from './age'

describe('ageBandsOf', function () {
  this.timeout(120000)
  const name = `teamstation_age_bands_of_${process.pid}_${Date.now()}`
  const id = (n: number): string => userIdOfValue((1n << 80n) + BigInt(n))
  const now = new Date('2026-11-20T12:00:00Z')
  let admin: Pool
  let db: Kysely<Database>

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await createMigratedDatabase(admin, name, migrations)
    db = makeDatabase(testDatabaseUrlOf(name))
    await db
      .insertInto('users')
      .values([
        { id: id(1), display_name: 'Demo Unknown' },
        { id: id(2), display_name: 'Demo Adult Flag', is_adult: true },
        {
          id: id(3),
          display_name: 'Demo Child',
          birth_year: 2015,
          birth_month: 1
        },
        {
          id: id(4),
          display_name: 'Demo Teen',
          birth_year: 2010,
          birth_month: 1,
          // A birth month wins over the flag.
          is_adult: true
        },
        {
          id: id(5),
          display_name: 'Demo Grown',
          birth_year: 1990,
          birth_month: 6
        },
        {
          id: id(6),
          display_name: 'Demo Merged',
          is_adult: true,
          merged_into: id(5)
        }
      ])
      .execute()
  })

  after(async function () {
    await db?.destroy()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
  })

  it('reads every band in one call, leaving out ids with no row', async function () {
    const bands = await ageBandsOf(
      db,
      [id(1), id(2), id(3), id(4), id(5), id(6), id(99), id(1)],
      now
    )
    expect(Object.fromEntries(bands)).deep.equals({
      [id(1)]: 'unknown',
      [id(2)]: 'adult',
      [id(3)]: 'under13',
      [id(4)]: 'minor',
      [id(5)]: 'adult',
      // As the row is: a merged account keeps its own band.
      [id(6)]: 'adult'
    })
  })

  it('answers nothing for no ids, and one band for one user', async function () {
    expect((await ageBandsOf(db, [], now)).size).equals(0)
    expect(await ageBandOfUser(db, id(4), now)).equals('minor')
    expect(await ageBandOfUser(db, id(99), now)).equals(undefined)
  })
})
