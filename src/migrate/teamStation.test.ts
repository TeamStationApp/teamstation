import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from './migrations'
import { migration047TeamStation } from './migrations/047teamStation'
import { migrateDown, migrateUp } from './runner'
import { schemaSnapshot } from './schemaSnapshot'
import { testDatabaseUrl } from './testDatabase'

/**
 * 047 over a database whose plays were stored under the old names: built to
 * 046, given a scored game in every shape the names are stored in, then
 * migrated.
 */
const adminUrl = testDatabaseUrl
const stamp = Date.now()
const upgradedName = `teamstation_names_${stamp}`
const freshName = `teamstation_names_fresh_${stamp}`
const urlOf = (name: string): string => adminUrl.replace(/\/[^/]*$/, `/${name}`)

const through046 = migrations.filter(
  migration => migration.name < migration047TeamStation.name
)
// What this file tests ends at 047; later migrations have their own tests.
const through047 = migrations.filter(
  migration => migration.name <= migration047TeamStation.name
)

/** A scored play as an app before TeamStation stored it. */
const OLD_PLAY = {
  about: { atBatIndex: 0, halfInning: 'top', inning: 1 },
  result: { eventType: 'gs_batter_out', description: 'out' },
  runners: [
    { details: { eventType: 'gs_manual_placement', runner: { id: null } } },
    { details: { eventType: 'single', runner: { id: null } } }
  ],
  playEvents: [
    { details: { eventType: 'gs_batting_order', code: 'gs_batting_order' } }
  ],
  credits: [{ eventType: 'gs_batter_out', label: 'Batter' }],
  gameStation: {
    version: 1,
    detail: {
      source: { system: 'gamestation', gamestation: { outcome: 'out' } }
    }
  },
  note: 'A person wrote gs_batter_out and gamestation here, not as tokens'
}

describe('047: the stored names become TeamStation’s', function () {
  this.timeout(120000)

  let admin: Pool
  let pool: Pool
  let fresh: Pool

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`create database ${upgradedName}`)
    await admin.query(`create database ${freshName}`)
    pool = new Pool({ connectionString: urlOf(upgradedName) })
    fresh = new Pool({ connectionString: urlOf(freshName) })
    await migrateUp(pool, through046)
    await migrateUp(fresh, through047)
    await pool.query(
      `
      insert into teams (id, name) values ('tm_home', 'Home'), ('tm_away', 'Away');
      insert into games (id, home_team_id, away_team_id, start_at, "scoringOwner", "currentPlay")
      values ('gm_1', 'tm_home', 'tm_away', now(), 'gamestation', $1::jsonb),
             ('gm_2', 'tm_home', 'tm_away', now(), null, null);
      insert into events (id, "gameId", gumbo, source)
      values ('ev_1', 'gm_1', $1::jsonb, 'gamestation'),
             ('ev_2', 'gm_2', '{"about": {"atBatIndex": 0}, "result": {"eventType": "single"}}'::jsonb, 'external');
      insert into legacy_event_type_renames (event_id, old_event_type, new_event_type)
      values ('ev_1', 'manual_placement', 'gs_manual_placement');
    `.replace(/\$1/g, `'${JSON.stringify(OLD_PLAY)}'`)
    )
    const user = await pool.query<{ id: string }>(
      `insert into users (id, display_name, "legacyId") values (12345, 'Ada', 'u1') returning id`
    )
    await pool.query(
      `insert into auth_sessions (id, user_id, token_hash, expires_at, device_name)
       values ('ses_1', $1, 'hash1', now() + interval '1 day', 'GS Director'),
              ('ses_2', $1, 'hash2', now() + interval '1 day', 'Paul''s iPhone')`,
      [user.rows[0].id]
    )
  })

  after(async function () {
    if (pool != null) await pool.end()
    if (fresh != null) await fresh.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${upgradedName}`)
      await admin.query(`drop database if exists ${freshName}`)
      await admin.end()
    }
  })

  it('applies 047 alone, leaving the schema as a fresh build has it', async function () {
    const before047 = await pool.query<{ eventType: string }>(
      `select "eventType" from "eventCredits" where "eventId" = 'ev_1'`
    )
    expect(before047.rows.map(row => row.eventType)).deep.equals([
      'gs_batter_out'
    ])
    const result = await migrateUp(pool, through047)
    expect(result.applied).deep.equals([migration047TeamStation.name])
    expect(await schemaSnapshot(pool)).deep.equals(await schemaSnapshot(fresh))
  })

  it('renames every stored code, the record key and the system', async function () {
    const { rows } = await pool.query<{
      gumbo: typeof OLD_PLAY
      eventType: string
    }>(`select gumbo, "eventType" from events where id = 'ev_1'`)
    const play = rows[0].gumbo as unknown as Record<string, any>
    expect(rows[0].eventType).equals('ts_batter_out')
    expect(play.result.eventType).equals('ts_batter_out')
    expect(play.runners.map((r: any) => r.details.eventType)).deep.equals([
      'ts_manual_placement',
      'single'
    ])
    expect(play.playEvents[0].details).deep.equals({
      eventType: 'ts_batting_order',
      code: 'ts_batting_order'
    })
    expect(play.credits[0].eventType).equals('ts_batter_out')
    expect(play.gameStation).equals(undefined)
    expect(play.teamStation.detail.source).deep.equals({
      system: 'teamstation',
      teamstation: { outcome: 'out' }
    })
    expect(play.note).equals(OLD_PLAY.note)
    const game = await pool.query<{ currentPlay: any; scoringOwner: string }>(
      `select "currentPlay", "scoringOwner" from games where id = 'gm_1'`
    )
    expect(game.rows[0].currentPlay.result.eventType).equals('ts_batter_out')
    expect(game.rows[0].currentPlay.teamStation.version).equals(1)
    expect(game.rows[0].scoringOwner).equals('teamstation')
  })

  it('renames the copied credits, the rename record, the source and the sessions', async function () {
    const credits = await pool.query<{ eventType: string }>(
      `select "eventType" from "eventCredits" where "eventId" = 'ev_1'`
    )
    expect(credits.rows.map(row => row.eventType)).deep.equals([
      'ts_batter_out'
    ])
    const renames = await pool.query<{ new_event_type: string }>(
      'select new_event_type from legacy_event_type_renames'
    )
    expect(renames.rows[0].new_event_type).equals('ts_manual_placement')
    const sources = await pool.query<{ id: string; source: string }>(
      'select id, source from events order by id'
    )
    expect(sources.rows).deep.equals([
      { id: 'ev_1', source: 'teamstation' },
      { id: 'ev_2', source: 'external' }
    ])
    const sessions = await pool.query<{ device_name: string }>(
      'select device_name from auth_sessions order by id'
    )
    expect(sessions.rows.map(row => row.device_name)).deep.equals([
      'TS Director',
      "Paul's iPhone"
    ])
  })

  it('refuses the old system name, and fills credits through ts_make_id', async function () {
    let refused: unknown
    try {
      await pool.query(
        `update events set source = 'gamestation' where id = 'ev_2'`
      )
    } catch (error) {
      refused = error
    }
    expect(String(refused)).contains('events_source_check')
    await pool.query(
      `insert into events (id, "gameId", gumbo)
       values ('ev_3', 'gm_2', '{"about": {"atBatIndex": 1}, "credits": [{"eventType": "ts_batter_out", "label": "Batter"}]}'::jsonb)`
    )
    const credit = await pool.query<{ id: string }>(
      `select id from "eventCredits" where "eventId" = 'ev_3'`
    )
    expect(credit.rows[0].id).match(/^evc_[A-Za-z0-9_-]{16}$/)
    const functions = await pool.query<{ proname: string }>(
      `select proname from pg_proc where proname ~ '^(gs|ts)_(make_id|user_id_number)$' order by proname`
    )
    expect(functions.rows.map(row => row.proname)).deep.equals([
      'ts_make_id',
      'ts_user_id_number'
    ])
    await pool.query(`delete from events where id = 'ev_3'`)
  })

  it('goes back to the old names, and forward again', async function () {
    expect(await migrateDown(pool, through047)).deep.equals([
      migration047TeamStation.name
    ])
    const back = await pool.query<{ gumbo: any; source: string }>(
      `select gumbo, source from events where id = 'ev_1'`
    )
    expect(back.rows[0].gumbo).deep.equals(OLD_PLAY)
    expect(back.rows[0].source).equals('gamestation')
    const owner = await pool.query<{ scoringOwner: string }>(
      `select "scoringOwner" from games where id = 'gm_1'`
    )
    expect(owner.rows[0].scoringOwner).equals('gamestation')
    const functions = await pool.query<{ proname: string }>(
      `select proname from pg_proc where proname ~ '^(gs|ts)_make_id$'`
    )
    expect(functions.rows.map(row => row.proname)).deep.equals(['gs_make_id'])
    const sessions = await pool.query<{ device_name: string }>(
      `select device_name from auth_sessions where id = 'ses_1'`
    )
    expect(sessions.rows[0].device_name).equals('GS Director')
    await migrateUp(pool, through047)
    expect(await schemaSnapshot(pool)).deep.equals(await schemaSnapshot(fresh))
  })
})
