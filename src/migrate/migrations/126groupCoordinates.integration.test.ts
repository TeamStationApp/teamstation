import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrateDown, migrateUp } from '../runner'
import {
  createMigratedDatabase,
  dropScratchDatabase,
  testDatabaseUrl,
  testDatabaseUrlOf
} from '../testDatabase'
import { migration126GroupCoordinates as migration } from './126groupCoordinates'
import { migrations as every } from './index'

/**
 * Every league and team with a locality gets its city's coordinates: a
 * GeoNames id maps directly, a Google id or a locality without an id takes
 * the most populous catalog city of the same name, region and country, and a
 * city the catalog does not hold stays null.
 */

// Through this migration: later ones have their own tests.
const migrations = every.filter(m => m.name <= migration.name)

const sanDiego = { latitude: 32.71571, longitude: -117.16472 }
const nowhere = { latitude: null, longitude: null }

const locality = (
  city: string,
  region: string,
  country: string,
  placeId: string | null
): string => JSON.stringify({ city, region, country, placeId, timezone: 'UTC' })

describe('group coordinates from their localities', function () {
  this.timeout(120000)
  const name = `teamstation_group_coordinates_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool

  const coordinates = async (
    table: 'leagues' | 'teams',
    id: string
  ): Promise<unknown> =>
    (
      await pool.query(
        `select latitude, longitude from ${table} where id = $1`,
        [id]
      )
    ).rows[0]

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await createMigratedDatabase(
      admin,
      name,
      migrations.filter(m => m.name !== migration.name)
    )
    pool = new Pool({ connectionString: testDatabaseUrlOf(name) })
    await pool.query(
      `insert into leagues(id, name, locality) values
         ('lea_geonames', 'Demo League A', $1),
         ('lea_unknown', 'Demo League B', $2),
         ('lea_unplaced', 'Demo League C', null)`,
      [
        locality('San Diego', 'California', 'US', 'geonames:5391811'),
        locality('Demo City', 'Demo Region', 'US', null)
      ]
    )
    await pool.query(
      `insert into teams(id, name, locality) values
         ('tem_bare', 'Demo Hawks', $1),
         ('tem_google', 'Demo Eagles', $2),
         ('tem_manual', 'Demo Visitors', $3),
         ('tem_unknown', 'Demo Owls', $4),
         ('tem_broken', 'Demo Wrens', $5),
         ('tem_text', 'Demo Jays', $6),
         ('tem_unplaced', 'Demo Larks', null)`,
      [
        locality('San Diego', 'California', 'US', '5391811'),
        locality(
          'San Diego',
          'California',
          'United States',
          'google:demo-place'
        ),
        locality('San Diego', 'CA', 'US', null),
        locality('Demo City', 'Demo Region', 'US', null),
        JSON.stringify({ city: 'San Diego' }),
        JSON.stringify('San Diego')
      ]
    )
  })

  after(async function () {
    await pool?.end()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
  })

  it('backfills each located league and team, and leaves the rest null', async function () {
    expect(await migrateUp(pool, migrations))
      .property('applied')
      .deep.equals([migration.name])
    expect(await coordinates('leagues', 'lea_geonames')).deep.equals(sanDiego)
    expect(await coordinates('teams', 'tem_bare')).deep.equals(sanDiego)
    // San Diego, Texas is smaller: the California city is the one meant.
    expect(await coordinates('teams', 'tem_google')).deep.equals(sanDiego)
    expect(await coordinates('teams', 'tem_manual')).deep.equals(sanDiego)
    expect(await coordinates('leagues', 'lea_unknown')).deep.equals(nowhere)
    expect(await coordinates('teams', 'tem_unknown')).deep.equals(nowhere)
    expect(await coordinates('teams', 'tem_broken')).deep.equals(nowhere)
    expect(await coordinates('teams', 'tem_text')).deep.equals(nowhere)
    expect(await coordinates('leagues', 'lea_unplaced')).deep.equals(nowhere)
    expect(await coordinates('teams', 'tem_unplaced')).deep.equals(nowhere)
  })

  it('drops the columns going down, and backfills them again going up', async function () {
    expect(await migrateDown(pool, migrations)).deep.equals([migration.name])
    const columns = async (): Promise<string[]> =>
      (
        await pool.query<{ name: string }>(
          `select table_name || '.' || column_name as name
             from information_schema.columns
            where column_name in ('latitude', 'longitude')
              and table_name in ('leagues', 'teams')
            order by 1`
        )
      ).rows.map(row => row.name)
    expect(await columns()).deep.equals([])
    await migrateUp(pool, migrations)
    expect(await columns()).deep.equals([
      'leagues.latitude',
      'leagues.longitude',
      'teams.latitude',
      'teams.longitude'
    ])
    expect(await coordinates('teams', 'tem_google')).deep.equals(sanDiego)
  })

  it('writes nothing when no locality has a catalog city', async function () {
    await migrateDown(pool, migrations)
    await pool.query(
      `update leagues set locality = null; update teams set locality = null`
    )
    await migrateUp(pool, migrations)
    expect(
      (
        await pool.query(
          `select count(*)::int as n from teams where latitude is not null`
        )
      ).rows[0]
    ).deep.equals({ n: 0 })
  })
})
