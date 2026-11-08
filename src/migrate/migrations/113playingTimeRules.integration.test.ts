import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrateDown, migrateUp } from '../runner'
import { dropScratchDatabase, testDatabaseUrl } from '../testDatabase'
import { migration113PlayingTimeRules } from './113playingTimeRules'
import { migrations } from './index'

/** 113: a nullable JSON set of Playing Time Rules on seasons and teams. */
describe('113 Playing Time Rules', function () {
  this.timeout(60000)
  const name = `teamstation_playing_time_rules_${process.pid}_${Date.now()}`
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  const through = migrations.filter(
    migration => migration.name <= migration113PlayingTimeRules.name
  )
  let admin: Pool
  let pool: Pool

  const columns = async (): Promise<string[]> =>
    (
      await pool.query<{
        table_name: string
        data_type: string
        is_nullable: string
      }>(
        `select table_name, data_type, is_nullable
           from information_schema.columns
          where column_name = 'playing_time_rules' order by table_name`
      )
    ).rows.map(row => `${row.table_name}:${row.data_type}:${row.is_nullable}`)

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({ connectionString: url })
    await migrateUp(pool, through.slice(0, -1))
    await pool.query(`
      insert into teams (id, name) values ('tem_hawks', 'Hawks');
      insert into seasons (id, name, year, starts_on, ends_on)
        values ('sea_spring', 'Spring', 2027, '2027-03-01', '2027-05-31')`)
  })
  after(async function () {
    await pool?.end()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
  })

  it('adds a nullable jsonb column to seasons and teams, null on every row', async function () {
    expect(await columns()).deep.equals([])
    await migrateUp(pool, through)
    expect(await columns()).deep.equals([
      'seasons:jsonb:YES',
      'teams:jsonb:YES'
    ])
    const { rows } = await pool.query(
      `select playing_time_rules from seasons
       union all select playing_time_rules from teams`
    )
    expect(rows).deep.equals([
      { playing_time_rules: null },
      { playing_time_rules: null }
    ])
  })

  it('holds a set, and drops both columns on the way down', async function () {
    await pool.query(
      `update teams set playing_time_rules = $1 where id = 'tem_hawks'`,
      [JSON.stringify({ mandatoryPlay: true })]
    )
    const { rows } = await pool.query(
      `select playing_time_rules from teams where id = 'tem_hawks'`
    )
    expect(rows[0].playing_time_rules).deep.equals({ mandatoryPlay: true })
    expect(await migrateDown(pool, through, 1)).deep.equals([
      migration113PlayingTimeRules.name
    ])
    expect(await columns()).deep.equals([])
    expect(
      (await pool.query(`select name from teams`)).rows.map(row => row.name)
    ).deep.equals(['Hawks'])
  })
})
