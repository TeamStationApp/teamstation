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
import { migration131SponsorFeatures as migration } from './131sponsorFeatures'
import { migrations as all } from './index'

// Through this migration: those after it are another test's.
const migrations = all.slice(
  0,
  all.findIndex(m => m.name === migration.name) + 1
)

const TABLES = [
  'game_half_ends',
  'game_reel_placements',
  'game_sponsor_logos',
  'league_sponsor_credits',
  'sponsor_logos',
  'sponsor_media',
  'sponsor_reels',
  'sponsor_rows'
]

/** U4: every league holds its sponsor credits, and the checks hold. */
describe('U4 the sponsor features migration', function () {
  this.timeout(120000)
  const name = `teamstation_sponsor_features_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool

  const tables = async (): Promise<string[]> =>
    (
      await pool.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname = 'public'
        and tablename = any($1) order by 1`,
        [TABLES]
      )
    ).rows.map(row => row.tablename)

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await createMigratedDatabase(
      admin,
      name,
      migrations.filter(m => m.name !== migration.name)
    )
    pool = new Pool({ connectionString: testDatabaseUrlOf(name) })
    await pool.query(
      `insert into leagues (id, name) values
        ('lea_sponsor_a', 'American League'),
        ('lea_sponsor_b', 'National League')`
    )
  })

  after(async function () {
    await pool?.end()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
  })

  it('gives every existing league 300 game logos, 1,000 reel broadcasts and 10 slots', async function () {
    expect(await tables()).deep.equals([])
    await migrateUp(pool, migrations)
    expect(await tables()).deep.equals(TABLES)
    const { rows } = await pool.query(
      `select league_id, logo_credits, reel_credits, event_slots, kept_slots,
        logo_turn, reel_turn
      from league_sponsor_credits order by league_id`
    )
    expect(rows).deep.equals(
      ['lea_sponsor_a', 'lea_sponsor_b'].map(leagueId => ({
        league_id: leagueId,
        logo_credits: 300,
        reel_credits: 1000,
        event_slots: 10,
        kept_slots: 0,
        logo_turn: 0,
        reel_turn: 0
      }))
    )
  })

  it('refuses a logo or reel that used more than its allocation, or none allocated', async function () {
    await pool.query(
      `insert into sponsor_media (id, league_id, purpose, object_key,
        content_type, bytes, sha256, width, height, duration_ms)
      values
        ('smd_logo', 'lea_sponsor_a', 'logo', 'sponsors/a/logo.png',
          'image/png', 100, 'x', 480, 270, null),
        ('smd_reel', 'lea_sponsor_a', 'reel', 'sponsors/a/reel.mp4',
          'video/mp4', 100, 'x', 640, 360, 12000)`
    )
    await pool.query(
      `insert into sponsor_logos (id, league_id, media_id, name, allocation,
        used, position) values ('slg_a', 'lea_sponsor_a', 'smd_logo', 'Harbor', 5, 5, 1)`
    )
    const refused = async (statement: string): Promise<string> =>
      await pool.query(statement).then(
        () => 'accepted',
        (error: unknown) => (error as Error).message
      )
    expect(
      await refused(`update sponsor_logos set used = 6 where id = 'slg_a'`)
    ).matches(/check constraint/)
    expect(
      await refused(
        `update sponsor_logos set allocation = 0 where id = 'slg_a'`
      )
    ).matches(/check constraint/)
    expect(
      await refused(
        `insert into sponsor_reels (id, league_id, media_id, name, allocation,
          used, position, duration_ms)
        values ('srl_a', 'lea_sponsor_a', 'smd_reel', 'Harbor', 5, 6, 1, 12000)`
      )
    ).matches(/check constraint/)
    expect(
      await refused(
        `insert into sponsor_media (id, league_id, purpose, object_key,
          content_type, bytes, sha256, width, height)
        values ('smd_gif', 'lea_sponsor_a', 'gif', 'sponsors/a/x.gif',
          'image/gif', 100, 'x', 1, 1)`
      )
    ).matches(/check constraint/)
    expect(
      await refused(
        `update league_sponsor_credits set kept_slots = -1
        where league_id = 'lea_sponsor_a'`
      )
    ).matches(/check constraint/)
  })

  it('drops cleanly, and goes up again', async function () {
    expect(await migrateDown(pool, migrations)).deep.equals([migration.name])
    expect(await tables()).deep.equals([])
    expect((await migrateUp(pool, migrations)).applied).deep.equals([
      migration.name
    ])
    expect(await tables()).deep.equals(TABLES)
    const { rows } = await pool.query(
      'select count(*)::int as count from league_sponsor_credits'
    )
    expect(rows).deep.equals([{ count: 2 }])
  })
})
