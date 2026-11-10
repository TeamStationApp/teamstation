import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { userIdOfGumbo } from '../../common/userId'
import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migration077Venues } from './077venues'
import { migrations } from './index'

const ADMIN = userIdOfGumbo(101)

describe('077 venues', function () {
  this.timeout(60000)
  const name = `teamstation_venues_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool
  const refused = async (statement: string): Promise<string> => {
    let failure: unknown
    await pool.query(statement).catch((error: unknown) => {
      failure = error
    })
    expect(failure, statement).not.equals(undefined)
    return String(failure)
  }
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '077')
    )
    await pool.query(`insert into users (id, display_name) values ('${ADMIN}', 'Demo Admin');
      insert into leagues (id, name) values ('lea_demo', 'Demo League');`)
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('rolls back cleanly while no venue exists', async () => {
    await migrateUp(pool, [migration077Venues])
    await migrateDown(pool, [migration077Venues], 1)
    expect(
      (await pool.query(`select to_regclass('venues') as venues`)).rows[0]
        .venues
    ).equals(null)
    await migrateUp(pool, [migration077Venues])
  })
  it('keeps venues, fields and claims to their rules', async () => {
    await pool.query(`insert into venues (id, google_place_id, name, latitude, longitude, timezone, default_blackouts)
      values ('ven_demo', 'place-demo', 'Demo Park', 40, -75, 'America/New_York', '{2027-07-04}')`)
    const venue = (
      await pool.query(
        `select size_switch_minutes, default_hours, address from venues`
      )
    ).rows[0]
    expect(venue).deep.equals({
      size_switch_minutes: 0,
      default_hours: [],
      address: ''
    })
    expect(
      await refused(
        `insert into venues (id, google_place_id, name, latitude, longitude, timezone) values ('ven_twin', 'place-demo', 'Twin', 0, 0, 'UTC')`
      )
    ).includes('venues_google_place_id_key')
    expect(
      await refused(`update venues set size_switch_minutes = 241`)
    ).includes('check')
    await pool.query(
      `insert into venue_fields (id, venue_id, name, sizes) values ('fld_one', 'ven_demo', 'Field 1', '{46/60,50/70}')`
    )
    expect(
      await refused(
        `insert into venue_fields (id, venue_id, name, sizes) values ('fld_bad', 'ven_demo', 'Field 9', '{70/100}')`
      )
    ).includes('check')
    expect(
      await refused(
        `insert into venue_fields (id, venue_id, name, sizes) values ('fld_none', 'ven_demo', 'Field 9', '{}')`
      )
    ).includes('check')
    expect(await refused(`update venue_fields set pin_latitude = 40`)).includes(
      'venue_fields_pin'
    )
    expect(
      await refused(
        `update venue_fields set starts_on = '2027-03-01', ends_on = '2027-02-01'`
      )
    ).includes('venue_fields_dates')
    expect(
      await refused(`update venue_fields set starts_on = '2027-03-01'`)
    ).includes('venue_fields_dates')
    await pool.query(`insert into venue_claims (id, venue_id, league_id, kind, requested_by, approves_at)
      values ('vcl_one', 'ven_demo', 'lea_demo', 'claim', '${ADMIN}', now() + interval '7 days')`)
    expect(
      await refused(`insert into venue_claims (id, venue_id, league_id, kind, requested_by, approves_at)
        values ('vcl_two', 'ven_demo', 'lea_demo', 'coOwner', '${ADMIN}', now() + interval '7 days')`)
    ).includes('venue_claims_live')
    expect(
      await refused(`update venue_claims set status = 'approved'`)
    ).includes('venue_claims_decided')
    expect(
      await refused(
        `update venue_claims set approves_at = requested_at - interval '1 day'`
      )
    ).includes('venue_claims_window')
    // A claim that has ended frees the league to claim again.
    await pool.query(
      `update venue_claims set status = 'left', decided_at = now()`
    )
    await pool.query(`insert into venue_claims (id, venue_id, league_id, kind, requested_by, approves_at)
      values ('vcl_again', 'ven_demo', 'lea_demo', 'claim', '${ADMIN}', now() + interval '7 days')`)
  })
  it('refuses to roll back while venues exist, keeping them', async () => {
    let failure: unknown
    try {
      await migrateDown(pool, [migration077Venues], 1)
    } catch (error) {
      failure = error
    }
    expect(String(failure)).includes('Venues exist')
    expect(
      (await pool.query(`select count(*)::int as n from venues`)).rows[0].n
    ).equals(1)
  })
})
