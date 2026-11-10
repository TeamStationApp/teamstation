import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { calendarDateText } from '../../common/groupCreation'
import { userIdOfGumbo } from '../../common/userId'
import { createTeam } from '../../server/teams/createTeam'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { migrateDown, migrateUp } from '../runner'
import { type SchemaSnapshot, schemaSnapshot } from '../schemaSnapshot'
import { testDatabaseUrl } from '../testDatabase'
import { migrations as allMigrations } from './index'

const migrations = allMigrations.filter(m => m.name <= '072seasonDates')
describe('072seasonDates required season ranges', function () {
  this.timeout(60000)
  const name = `umpire_dates_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool
  let snapshot: SchemaSnapshot
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '072seasonDates')
    )
    snapshot = await schemaSnapshot(pool)
    await pool.query(`insert into seasons (id, name, year, starts_on, ends_on) values
      ('both', 'Both', 2027, '2027-04-01', '2027-08-01'),
      ('reversed', 'Reversed', 2027, '2027-08-01', '2027-04-01'),
      ('start', 'Start', 2027, '2027-04-01', null),
      ('end', 'End', 2027, null, '2027-08-01'),
      ('neither', 'Neither', 2027, null, null)`)
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('backfills all missing and reversed ranges while preserving valid dates', async () => {
    await migrateUp(pool, migrations)
    const result = await pool.query(
      'select id, starts_on::text as start, ends_on::text as end from seasons order by id'
    )
    expect(result.rows).deep.equals([
      { id: 'both', start: '2027-04-01', end: '2027-08-01' },
      { id: 'end', start: '2027-08-01', end: '2027-08-01' },
      { id: 'neither', start: '2027-03-01', end: '2027-05-31' },
      { id: 'reversed', start: '2027-08-01', end: '2027-08-01' },
      { id: 'start', start: '2027-04-01', end: '2027-04-01' }
    ])
    for (const [assignment, code] of [
      ['starts_on = null', '23502'],
      ['ends_on = null', '23502'],
      ["ends_on = '2026-01-01'", '23514']
    ]) {
      const error = await pool
        .query(`update seasons set ${assignment} where id = 'both'`)
        .then(
          () => null,
          (e: unknown) => e
        )
      expect(error).property('code', code)
    }
  })
  it('down restores the prior schema', async () => {
    await migrateDown(pool, migrations, 1)
    expect(await schemaSnapshot(pool)).deep.equals(snapshot)
  })
})

describe('072seasonDates HTTP update', function () {
  this.timeout(60000)
  let f: GroupFixture
  before(async () => {
    f = await groupFixture()
  })
  after(async () => {
    await f?.h.close()
  })
  it('refuses either explicit null and reversed ranges without changing a valid season', async () => {
    const path = `/groups/season/${f.seasonA}`
    for (const body of [
      { startsOn: null },
      { endsOn: null },
      { startsOn: null, endsOn: null }
    ]) {
      const response = await f.h.request('PUT', path, body, 101)
      expect(response.status).equals(400)
      expect(JSON.stringify(await response.json())).includes(
        'A season needs a start and an end'
      )
    }
    expect(
      (await f.h.request('PUT', path, { endsOn: '2020-01-01' }, 101)).status
    ).equals(400)
    expect(
      (
        await f.h.request(
          'PUT',
          path,
          { startsOn: '2027-04-01', endsOn: '2027-06-01' },
          101
        )
      ).status
    ).equals(200)
    expect(
      (await f.h.request('PUT', path, { startsOn: '2027-05-01' }, 101)).status
    ).equals(200)
    const row = await f.h.db
      .selectFrom('seasons')
      .select(['starts_on', 'ends_on'])
      .where('id', '=', f.seasonA)
      .executeTakeFirstOrThrow()
    expect(calendarDateText(row.starts_on)).equals('2027-05-01')
    expect(calendarDateText(row.ends_on)).equals('2027-06-01')
  })
  it('creates a named season with the requested year spring dates', async () => {
    const team = await createTeam(
      f.h.db,
      {
        name: 'Demo New Team',
        externalIds: [],
        season: { name: 'Demo New Season', year: 2029 }
      },
      { userId: userIdOfGumbo(101), isAdmin: false }
    )
    expect(team.season).not.equals(null)
    const row = await f.h.db
      .selectFrom('seasons')
      .selectAll()
      .where('id', '=', team.season!.id)
      .executeTakeFirstOrThrow()
    expect(calendarDateText(row.starts_on)).equals('2029-03-01')
    expect(calendarDateText(row.ends_on)).equals('2029-05-31')
    expect(row.league_id).equals(null)
  })
})
