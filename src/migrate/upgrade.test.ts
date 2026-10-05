import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { mintUserId } from '../common/mintUserId'
import { migrations as allMigrations } from './migrations'
import { migration046ExternalCleanup } from './migrations/046externalCleanup'
import { migration048DropStatRollups } from './migrations/048dropStatRollups'
import { BASELINE, migrateDown, migrateUp } from './runner'
import { schemaSnapshot } from './schemaSnapshot'
import { testDatabaseUrl } from './testDatabase'

// These scenarios exercise schema history only through migration 048.
const migrations = allMigrations.filter(
  migration => migration.name <= '048dropStatRollups'
)

/**
 * 046 over a database that ran an outside integration.
 *
 * `runner.test.ts` applies every migration to an empty database, where 046
 * finds nothing. Here a database is built to 045, then given the history 046
 * exists for — under stand-in names, because the point is that 046 finds what
 * it removes by what it carries:
 *
 * - four tables carrying the signature columns;
 * - the relay pair on `live_streams`, prefixed `x`;
 * - every provenance column allowing, and holding, a value the new lists do
 *   not name;
 * - a stored play with a `source` key, and the bookkeeping rows of two
 *   migrations whose files are gone;
 * - audit rows about the stand-in accounts, one of them for an account no
 *   longer in the table, and audit rows that flipped the relay switch.
 *
 * After 046 the database must have exactly the schema of one built empty.
 */
const adminUrl = testDatabaseUrl
const stamp = Date.now()
const upgradedName = `teamstation_upgrade_${stamp}`
const freshName = `teamstation_fresh_${stamp}`
const urlOf = (name: string): string => adminUrl.replace(/\/[^/]*$/, `/${name}`)

const throughBaseline = migrations.filter(
  migration => migration.name <= BASELINE
)

const PROVENANCE = [
  ['teams', 'created_from', 'import'],
  ['teams', 'logo_source', 'import'],
  ['seasons', 'logo_source', 'import'],
  ['leagues', 'logo_source', 'import'],
  ['users', 'avatar_source', 'import'],
  ['users', 'bats_source', 'import'],
  ['user_emails', 'source', 'import'],
  ['season_members', 'source', 'import'],
  ['league_members', 'source', 'import'],
  ['events', 'source', 'external']
] as const

const ada = mintUserId(() => false)

describe('046 over a database with an outside integration', function () {
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
    await migrateUp(pool, throughBaseline)
    await migrateUp(fresh, migrations)
    await giveItHistory(pool)
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

  it('applies 046, and 047 after it', async function () {
    const result = await migrateUp(pool, migrations)
    expect(result.applied).deep.equals([
      migration046ExternalCleanup.name,
      '047teamStation',
      '048dropStatRollups'
    ])
  })

  it('drops the four tables and the relay pair', async function () {
    const { rows } = await pool.query<{ name: string | null }>(
      `select to_regclass(name)::text as name
       from unnest(array['x_accounts', 'x_jobs', 'x_targets', 'x_archive'])
         as t(name)`
    )
    expect(rows.map(row => row.name)).deep.equals([null, null, null, null])
    const columns = await pool.query<{ name: string }>(
      `select column_name as name from information_schema.columns
       where table_name = 'live_streams' and column_name like 'x\\_%'`
    )
    expect(columns.rows).deep.equals([])
  })

  it('turns every value the lists no longer name into import or external', async function () {
    for (const [table, column, value] of PROVENANCE) {
      const { rows } = await pool.query<{ value: string }>(
        `select ${column} as value from ${table} where ${column} is not null`
      )
      const values = rows.map(row => row.value)
      expect(values, `${table}.${column}`).to.include(value)
      expect(values, `${table}.${column}`).not.to.include('legacyValue')
    }
  })

  it('leaves the schema exactly as a fresh build has it', async function () {
    expect(await schemaSnapshot(pool)).deep.equals(await schemaSnapshot(fresh))
  })

  it('strips a stored play of its source, and forgets two removed migrations', async function () {
    const plays = await pool.query<{ has: boolean }>(
      `select gumbo ? 'source' as has from events`
    )
    expect(plays.rows).deep.equals([{ has: false }])
    const names = await pool.query<{ name: string }>(
      `select name from schema_migrations where name ~ '^(016|032)'`
    )
    expect(names.rows).deep.equals([])
  })

  it('deletes the audit rows about the dropped tables, and the relay switch from the rest', async function () {
    const { rows } = await pool.query<{
      id: string
      before: unknown
      after: unknown
    }>('select id, before, after from audit_log order by id')
    expect(rows).deep.equals([
      { id: 'aud_label', before: { label: 'Dugout' }, after: {} },
      { id: 'aud_team', before: null, after: { name: 'Hawks' } }
    ])
  })

  it('refuses a database where two tables carry one signature, and changes nothing', async function () {
    const name = `teamstation_twice_${stamp}`
    await admin.query(`create database ${name}`)
    const twice = new Pool({ connectionString: urlOf(name) })
    try {
      await migrateUp(twice, throughBaseline)
      await twice.query(`
        create table x_one (id text primary key, pending_state text);
        create table x_two (id text primary key, pending_state text);
      `)
      const refused = await migrateUp(twice, migrations).then(
        () => undefined,
        (error: unknown) => error
      )
      expect(refused)
        .instanceOf(Error)
        .property('message')
        .contains('More than one table carries')
      const { rows } = await twice.query<{ count: string }>(
        `select count(*) from schema_migrations where name = $1`,
        [migration046ExternalCleanup.name]
      )
      expect(rows[0].count).equals('0')
      const tables = await twice.query<{ name: string | null }>(
        `select to_regclass('x_one')::text as name`
      )
      expect(tables.rows[0].name).equals('x_one')
    } finally {
      await twice.end()
      await admin.query(`drop database if exists ${name}`)
    }
  })

  it('changes nothing on a fresh build', async function () {
    const name = `teamstation_noop_${stamp}`
    await admin.query(`create database ${name}`)
    const noop = new Pool({ connectionString: urlOf(name) })
    try {
      await migrateUp(noop, throughBaseline)
      const before = await schemaSnapshot(noop)
      await migrateUp(
        noop,
        migrations.filter(
          migration => migration.name <= migration046ExternalCleanup.name
        )
      )
      expect(await schemaSnapshot(noop)).deep.equals(before)
    } finally {
      await noop.end()
      await admin.query(`drop database if exists ${name}`)
    }
  })
})

/**
 * The integration's footprint, as a database that ran it holds it, under
 * stand-in names.
 */
async function giveItHistory(pool: Pool): Promise<void> {
  await pool.query(`
    create table x_accounts (
      id text primary key,
      owner bigint references users (id) on delete cascade,
      pending_state text
    );
    create table x_jobs (
      id text primary key,
      account_id text not null references x_accounts (id) on delete cascade,
      cancel_requested boolean not null default false
    );
    create table x_targets (
      id text primary key,
      game_id text references games (id) on delete cascade,
      ingest_url_cipher text not null
    );
    create table x_archive (
      id text primary key,
      media_type text,
      payload jsonb
    );
    create index x_archive_media on x_archive (media_type);
    alter table live_streams
      add column x_target_id text references x_targets (id) on delete set null,
      add column x_enabled boolean not null default false;
  `)

  for (const [table, column] of PROVENANCE) {
    const { rows } = await pool.query<{ name: string; def: string }>(
      `select k.conname as name, pg_get_constraintdef(k.oid) as def
       from pg_constraint k
       join pg_attribute a on a.attrelid = k.conrelid
       where k.conrelid = $1::regclass and k.contype = 'c'
         and a.attname = $2 and k.conkey = array[a.attnum]`,
      [table, column]
    )
    const [check] = rows
    const widened = check.def.replace(/ARRAY\[/, "ARRAY['legacyValue'::text, ")
    await pool.query(`alter table ${table} drop constraint ${check.name}`)
    await pool.query(
      `alter table ${table} add constraint ${check.name} ${widened}`
    )
  }

  await pool.query(
    `insert into users (id, "legacyId", display_name, avatar_source, bats_source)
     values ($1, $2, 'Ada', 'legacyValue', 'legacyValue')`,
    [ada.userId, ada.legacyId]
  )
  await pool.query(`
    insert into leagues (id, name, logo_source)
      values ('lea_1', 'League', 'legacyValue');
    insert into seasons (id, league_id, name, year, logo_source)
      values ('sea_1', 'lea_1', 'Spring', 2026, 'legacyValue');
    insert into teams (id, name, created_from, logo_source)
      values ('tem_1', 'Hawks', 'legacyValue', 'legacyValue');
    insert into teams (id, name, created_from)
      values ('tem_2', 'Ravens', 'manual');
    insert into games (id, home_team_id, away_team_id, season_id, start_at)
      values ('gam_1', 'tem_1', 'tem_2', 'sea_1', '2026-05-02T18:30:00Z');
  `)
  await pool.query(
    `insert into user_emails (id, user_id, email, source)
       values ('uem_1', $1, 'ada@example.com', 'legacyValue');
     insert into season_members (id, user_id, season_id, source)
       values ('smb_1', $1, 'sea_1', 'legacyValue');
     insert into league_members (id, user_id, league_id, source)
       values ('lmb_1', $1, 'lea_1', 'legacyValue');
     insert into x_accounts (id, owner, pending_state)
       values ('xac_live', $1, null);`.replace(/\$1/g, String(ada.userId))
  )
  await pool.query(
    `insert into events (id, "gameId", "battingTeamId", gumbo, source)
     values ('evt_1', 'gam_1', 'tem_2', $1::jsonb, 'legacyValue')`,
    [
      JSON.stringify({
        about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
        result: { eventType: 'single', awayScore: 0, homeScore: 0 },
        source: { kind: 'play' }
      })
    ]
  )
  await pool.query(`
    insert into x_jobs (id, account_id) values ('xjb_1', 'xac_live');
    insert into x_targets (id, game_id, ingest_url_cipher)
      values ('xtg_1', 'gam_1', 'v1.a.b.c');
    insert into x_archive (id, media_type, payload)
      values ('xar_1', 'application/json', '{}');
    insert into schema_migrations (name) values ('016x'), ('032x');
    insert into audit_log (id, method, path, entity_type, entity_id, after)
      values
        ('aud_live', 'POST', '/x/account', 'xAccount', 'xac_live', '{}'),
        ('aud_gone', 'POST', '/x/account', 'xAccount', 'xac_gone', '{}'),
        ('aud_job', 'POST', '/x/refresh', 'xJob', 'xjb_1', null),
        ('aud_team', 'POST', '/teams', 'team', 'tem_1', '{"name": "Hawks"}');
    insert into audit_log (id, method, path, entity_type, entity_id, before, after)
      values
        ('aud_label', 'PATCH', '/x', 'liveStream', 'liv_1',
          '{"label": "Dugout", "xEnabled": false}', '{"xEnabled": true}'),
        ('aud_flip', 'PATCH', '/x', 'liveStream', 'liv_1',
          '{"xEnabled": false}', '{"xEnabled": true}');
  `)
}

/**
 * 048 over a database whose season caches hold rows.
 *
 * Both tables go, and nothing else changes: the upgraded schema is exactly a
 * fresh build's. Rolled back, both come back empty, exactly as 047 left them.
 */
describe('048 over a database with filled season caches', function () {
  this.timeout(120000)

  const name = `teamstation_rollups_${stamp}`
  const through047Name = `teamstation_rollups047_${stamp}`
  const freshAllName = `teamstation_rollupsall_${stamp}`
  const through047 = migrations.filter(
    migration => migration.name < migration048DropStatRollups.name
  )
  const bea = mintUserId(() => false)

  let admin: Pool
  let pool: Pool
  let fresh047: Pool
  let freshAll: Pool

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    for (const db of [name, through047Name, freshAllName]) {
      await admin.query(`create database ${db}`)
    }
    pool = new Pool({ connectionString: urlOf(name) })
    fresh047 = new Pool({ connectionString: urlOf(through047Name) })
    freshAll = new Pool({ connectionString: urlOf(freshAllName) })
    await migrateUp(pool, through047)
    await migrateUp(fresh047, through047)
    await migrateUp(freshAll, migrations)
    await pool.query(
      `insert into users (id, "legacyId", display_name) values ($1, $2, 'Bea')`,
      [bea.userId, bea.legacyId]
    )
    await pool.query(`
      insert into seasons (id, name, year) values ('sea_1', 'Spring', 2026);
      insert into teams (id, name) values ('tem_1', 'Hawks');
      insert into team_season_records (id, team_id, season_id, w, l)
        values ('tsr_1', 'tem_1', 'sea_1', 3, 1);
    `)
    await pool.query(
      `insert into player_season_stats (id, user_id, season_id, team_id, pa)
       values ('pss_1', $1, 'sea_1', 'tem_1', 12)`,
      [bea.userId]
    )
  })

  after(async function () {
    for (const open of [pool, fresh047, freshAll]) await open?.end()
    if (admin != null) {
      for (const db of [name, through047Name, freshAllName]) {
        await admin.query(`drop database if exists ${db}`)
      }
      await admin.end()
    }
  })

  const tables = async (): Promise<Array<string | null>> => {
    const { rows } = await pool.query<{ name: string | null }>(
      `select to_regclass(name)::text as name
       from unnest(array['team_season_records', 'player_season_stats'])
         as t(name)`
    )
    return rows.map(row => row.name)
  }

  it('drops both caches, and leaves the schema a fresh build has', async function () {
    const result = await migrateUp(pool, migrations)
    expect(result.applied).deep.equals([migration048DropStatRollups.name])
    expect(await tables()).deep.equals([null, null])
    expect(await schemaSnapshot(pool)).deep.equals(
      await schemaSnapshot(freshAll)
    )
  })

  it('puts both back empty, exactly as 047 left them, and drops them again', async function () {
    expect(await migrateDown(pool, migrations)).deep.equals([
      migration048DropStatRollups.name
    ])
    expect(await tables()).deep.equals([
      'team_season_records',
      'player_season_stats'
    ])
    const counts = await pool.query<{ n: string }>(
      `select (select count(*) from team_season_records)
            + (select count(*) from player_season_stats) as n`
    )
    expect(Number(counts.rows[0].n)).equals(0)
    expect(await schemaSnapshot(pool)).deep.equals(
      await schemaSnapshot(fresh047)
    )
    await migrateUp(pool, migrations)
    expect(await tables()).deep.equals([null, null])
  })
})
