import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrateDown, migrateUp } from '../runner'
import { dropScratchDatabase, testDatabaseUrl } from '../testDatabase'
import { migration098PlayerNamePrivacy } from './098playerNamePrivacy'
import { migrations } from './index'

/** 098: three nullable columns that hold a format or nothing. */
describe('098 player name privacy', function () {
  this.timeout(60000)
  const name = `teamstation_player_name_privacy_${process.pid}_${Date.now()}`
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  const through = migrations.filter(
    migration => migration.name <= migration098PlayerNamePrivacy.name
  )
  let admin: Pool
  let pool: Pool

  const columns = async (): Promise<string[]> =>
    (
      await pool.query<{ table_name: string; is_nullable: string }>(
        `select table_name, is_nullable from information_schema.columns
          where column_name = 'player_name_privacy' order by table_name`
      )
    ).rows.map(row => `${row.table_name}:${row.is_nullable}`)

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({ connectionString: url })
    await migrateUp(pool, through)
  })
  after(async function () {
    await pool?.end()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
  })

  it('adds a nullable column to all three levels', async function () {
    expect(await columns()).deep.equals([
      'leagues:YES',
      'seasons:YES',
      'teams:YES'
    ])
  })

  it('takes the four formats and nothing else', async function () {
    await pool.query(`insert into leagues (id, name) values ('lea_one', 'One')`)
    for (const format of [
      'firstLastInitial',
      'initialLast',
      'initials',
      'full'
    ])
      await pool.query(`update leagues set player_name_privacy = $1`, [format])
    await pool.query(`update leagues set player_name_privacy = null`)
    let refused = false
    await pool
      .query(`update leagues set player_name_privacy = 'everything'`)
      .catch(() => {
        refused = true
      })
    expect(refused).equals(true)
  })

  it('drops the columns on the way down', async function () {
    await migrateDown(pool, through, 1)
    expect(await columns()).deep.equals([])
  })
})
