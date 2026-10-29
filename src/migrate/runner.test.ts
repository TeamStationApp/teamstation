import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { userIdOfGumbo } from '../common/userId'
import { migrations } from './migrations'
import {
  BASELINE,
  migrateDown,
  migrateUp,
  type Migration,
  rewriteJson,
  STEP_BATCH
} from './runner'
import { schemaSnapshot } from './schemaSnapshot'
import { dropScratchDatabase, testDatabaseUrl } from './testDatabase'

/**
 * Runs the real migrations against a scratch database, so the SQL itself is
 * tested and not just the runner's bookkeeping. Postgres 18 on port 5433 is
 * required; a closed port fails the suite.
 */
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_test_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

describe('migrations', function () {
  this.timeout(60000)

  let admin: Pool
  let pool: Pool

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query('select 1')
    await admin.query(`create database ${scratchName}`)
    pool = new Pool({ connectionString: scratchUrl })
  })

  after(async function () {
    if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  it('refuses a server older than Postgres 18 before it runs anything', async function () {
    const asked: string[] = []
    const old = {
      query: async (text: string) => {
        asked.push(text)
        return { rows: [{ server_version_num: '160015' }] }
      }
    } as unknown as Pool
    const refused = await migrateUp(old, migrations).then(
      () => undefined,
      (error: unknown) => error
    )
    expect(refused)
      .instanceOf(Error)
      .property('message')
      .equals(
        'Postgres 16 is too old: the migrations need Postgres 18 or later ' +
          '(server_version_num 160015)'
      )
    expect(asked).deep.equals(['show server_version_num'])
  })

  it('applies every migration, then reports them as already applied', async function () {
    const first = await migrateUp(pool, migrations)
    expect(first.applied).deep.equals(migrations.map(item => item.name).sort())
    expect(first.alreadyApplied).deep.equals([])

    const second = await migrateUp(pool, migrations)
    expect(second.applied).deep.equals([])
    expect(second.alreadyApplied.length).equals(migrations.length)
  })

  it('creates the tables the app expects', async function () {
    const { rows } = await pool.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public'"
    )
    const names = new Set(rows.map(row => row.tablename))
    for (const table of [
      'users',
      'teams',
      'leagues',
      'seasons',
      'season_teams',
      'memberships',
      'games',
      'videos',
      'events',
      'event_players',
      'audit_log',
      'system_settings',
      'invites',
      'invite_redemptions',
      'league_members'
    ]) {
      expect(names.has(table), `missing table ${table}`).equals(true)
    }
  })

  it('seeds the highlight timing settings', async function () {
    const { rows } = await pool.query<{ key: string; value: unknown }>(
      'select key, value from system_settings order by key'
    )
    const keys = rows.map(row => row.key)
    expect(keys).deep.equals(
      [
        'highlights.lagSec',
        'highlights.leadSecByEventType',
        'highlights.leadSec',
        'mail.accountMessages'
      ].sort()
    )
  })

  it('refuses reverse migrations that cannot put back what they took, without changing the applied schema', async () => {
    // Migrations added after the identity cutovers reverse on their own up to
    // 091, which took names out of default lineups: it refuses, as 090 and
    // the cutovers do. By name, the order the runner applies and reverses
    // them in.
    const later = migrations
      .filter(migration => migration.name > '093defaultLineupIds')
      .map(migration => migration.name)
      .sort()
    await migrateDown(pool, migrations, later.length)
    const before = (
      await pool.query('select name from schema_migrations order by name')
    ).rows
    const schema = await schemaSnapshot(pool)
    let failure: unknown
    try {
      await migrateDown(pool, migrations, migrations.length)
    } catch (error) {
      failure = error
    }
    expect(String(failure)).contains('Restore the verified pre-cutover')
    expect(
      (await pool.query('select name from schema_migrations order by name'))
        .rows
    ).deep.equals(before)
    expect(await schemaSnapshot(pool)).deep.equals(schema)
    expect((await migrateUp(pool, migrations)).applied).deep.equals(later)
  })
})

for (const cutover of ['069userIds', '071deletedAccounts']) {
  describe(`reverse at the ${cutover} identity boundary`, function () {
    this.timeout(60000)
    it('refuses through the runner without changing its schema or ledger', async () => {
      const name = `teamstation_cutover_${cutover.toLowerCase()}_${process.pid}_${Date.now()}`
      const admin = new Pool({ connectionString: adminUrl, max: 1 })
      let pool: Pool | undefined
      try {
        await admin.query(`create database "${name}"`)
        pool = new Pool({
          connectionString: adminUrl.replace(/\/[^/]*$/, `/${name}`),
          max: 1
        })
        const history = migrations.filter(
          migration => migration.name <= cutover
        )
        await migrateUp(pool, history)
        const schema = await schemaSnapshot(pool)
        const ledger = (
          await pool.query('select name from schema_migrations order by name')
        ).rows
        const failure = await migrateDown(pool, history, 1).then(
          () => undefined,
          (error: unknown) => error
        )
        expect(String(failure)).matches(/Restore the (?:verified )?pre-cutover/)
        expect(await schemaSnapshot(pool)).deep.equals(schema)
        expect(
          (await pool.query('select name from schema_migrations order by name'))
            .rows
        ).deep.equals(ledger)
        expect((await migrateUp(pool, history)).applied).deep.equals([])
      } finally {
        await pool?.end()
        await dropScratchDatabase(admin, name)
        await admin.end()
      }
    })
  })
}

describe('reversible migration history before persistent guest identities', function () {
  this.timeout(60000)
  const name = `teamstation_history_${process.pid}_${Date.now()}`
  const history = migrations.filter(m => m.name < '066')
  let admin: Pool
  let pool: Pool
  before(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: adminUrl.replace(/\/[^/]*$/, `/${name}`)
    })
  })
  after(async () => {
    await pool?.end()
    await admin.query(`drop database if exists ${name}`)
    await admin.end()
  })
  it('rolls back and reapplies historical schemas, including below the baseline', async () => {
    await migrateUp(pool, history)
    expect(await migrateDown(pool, history, history.length)).length(
      history.length
    )
    const tables = await pool.query(
      "select tablename from pg_tables where schemaname = 'public'"
    )
    expect(tables.rows.map(row => row.tablename)).deep.equals([
      'schema_migrations'
    ])
    expect((await migrateUp(pool, history)).applied).deep.equals(
      history.map(m => m.name).sort()
    )
    const down = await migrateDown(
      pool,
      history,
      history.filter(m => m.name >= BASELINE).length
    )
    expect(down.at(-1)).equals(BASELINE)
    expect((await migrateUp(pool, history)).applied).deep.equals(
      [...down].reverse()
    )
  })
  it('refuses to cross the persistent guest boundary even before the account cutover', async () => {
    const throughGuests = migrations.filter(m => m.name < '067')
    await migrateUp(pool, throughGuests)
    const before = (
      await pool.query('select name from schema_migrations order by name')
    ).rows
    let failure: unknown
    try {
      await migrateDown(pool, throughGuests, throughGuests.length)
    } catch (error) {
      failure = error
    }
    expect(String(failure)).includes('Restore the pre-cutover database backup')
    expect(
      (await pool.query('select name from schema_migrations order by name'))
        .rows
    ).deep.equals(before)
    expect((await migrateUp(pool, throughGuests)).applied).deep.equals([])
  })
})

describe('the baseline', function () {
  this.timeout(60000)

  const name = `teamstation_baseline_${Date.now()}`
  let admin: Pool
  let pool: Pool

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: adminUrl.replace(/\/[^/]*$/, `/${name}`)
    })
  })

  after(async function () {
    if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  it('refuses a database with history from before the rewrite, and touches nothing', async function () {
    const early = migrations.filter(migration => migration.name < '031')
    await migrateUp(pool, early)
    await pool.query(`insert into schema_migrations (name) values ('016x')`)
    const tablesBefore = await pool.query<{ count: string }>(
      "select count(*) from pg_tables where schemaname = 'public'"
    )

    const refused = await migrateUp(pool, migrations).then(
      () => undefined,
      (error: unknown) => error
    )
    expect(refused)
      .instanceOf(Error)
      .property('message')
      .equals(
        `${name} predates ${BASELINE}: migrations before it were rewritten ` +
          'for empty databases; restore a production dump instead'
      )
    const { rows } = await pool.query<{ count: string | number }>(
      'select count(*) from schema_migrations'
    )
    expect(Number(rows[0].count)).equals(early.length + 1)
    const tablesAfter = await pool.query<{ count: string }>(
      "select count(*) from pg_tables where schemaname = 'public'"
    )
    expect(tablesAfter.rows[0].count).equals(tablesBefore.rows[0].count)
  })

  it('does not guard a list that stops short of the baseline', async function () {
    const short = migrations.filter(migration => migration.name < '032')
    const result = await migrateUp(pool, short)
    expect(result.applied).deep.equals(['031scoring'])
  })
})

// The original fork histories and the already-deployed combined chat history
// must all upgrade without renaming an applied migration.
for (const history of ['oauth', 'chat', 'deployed'] as const) {
  describe(`upgrade from the ${history} migration history`, function () {
    this.timeout(60000)
    const name = `teamstation_upgrade_${history}_${Date.now()}_${process.pid}`
    let admin: Pool
    let pool: Pool

    before(async function () {
      admin = new Pool({ connectionString: adminUrl })
      await admin.query(`create database ${name}`)
      pool = new Pool({
        connectionString: adminUrl.replace(/\/[^/]*$/, `/${name}`)
      })
    })

    after(async function () {
      if (pool != null) await pool.end()
      if (admin != null) {
        await admin.query(`drop database if exists ${name}`)
        await admin.end()
      }
    })

    it('applies only the missing migrations and preserves existing users', async function () {
      const prior = migrations.filter(migration => {
        if (history === 'deployed')
          return migration.name <= '057chatMasterCompatibility'
        if (history === 'oauth') return migration.name <= '050oauth'
        return (
          migration.name < '050' ||
          ['050teamFollows', '051guardiansAndAccounts', '052chat'].includes(
            migration.name
          )
        )
      })
      await migrateUp(pool, prior)
      await pool.query(
        'insert into users (id, "legacyId", display_name) values (1001, $1, $2)',
        ['upgrade-fixture', 'Upgrade fixture']
      )
      const result = await migrateUp(pool, migrations)
      const priorNames = prior.map(migration => migration.name).sort()
      expect(result.applied).deep.equals(
        migrations
          .map(migration => migration.name)
          .filter(name => !priorNames.includes(name))
          .sort()
      )
      if (history === 'deployed')
        expect(result.applied).deep.equals([
          '057eventInfo',
          '058eventDetails',
          '059accountMail',
          '060scoreboardLog',
          '061videoWallTimeline',
          '062phoneStreams',
          '063gameStarted',
          '064membershipRequests',
          '065radarReadings',
          '066gameGuests',
          '067gameUnroster',
          '068chatUserIdBridge',
          '068gumboIds',
          '069userIds',
          '070playerGumboIds',
          '071deletedAccounts',
          '072narrationAudio',
          '072seasonDates',
          '073syncClock',
          '073umpireManagement',
          '074optionalUmpires',
          '074syncIdempotency',
          '075chatCanonicalUserIds',
          '075umpireTypes',
          '076umpireNotes',
          '077analyticsEvents',
          '077venues',
          '078gameFields',
          '079seasonScheduling',
          '080schedulePreviews',
          '081teamKeyedAvailability',
          '082gamePregame',
          '083playGeneration',
          '084gamePlayArchives',
          '085tess',
          '086fieldSizes',
          '087loginOffOnly',
          '088chatDirtyQueue',
          '089userApiKeys',
          '090plateAppearances',
          '091structuredCredits',
          '092playerNamesFromUsers',
          '093defaultLineupIds'
        ])
      expect(result.alreadyApplied).deep.equals(priorNames)
      const { rows } = await pool.query(
        'select id, display_name from users where id = $1',
        [userIdOfGumbo(1001)]
      )
      expect(rows).deep.equals([
        { id: userIdOfGumbo(1001), display_name: 'Upgrade fixture' }
      ])
      expect((await migrateUp(pool, migrations)).applied).deep.equals([])
    })
  })
}

describe("a migration's step", function () {
  this.timeout(60000)
  const name = `teamstation_steps_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
  })

  after(async function () {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  it("runs after up's SQL, in its transaction", async function () {
    let seen: { table: string | null; same: boolean } | undefined
    const probe: Migration = {
      name: '001probe',
      up: `create table probe (id text primary key, doc jsonb);
        insert into probe values ('xid', to_jsonb(txid_current()::text));`,
      down: 'drop table probe;',
      steps: async client => {
        const { rows } = await client.query<{
          table: string | null
          same: boolean
        }>(
          `select to_regclass('probe')::text as table,
             (select doc #>> '{}' from probe where id = 'xid')
               = txid_current()::text as same`
        )
        seen = rows[0]
      }
    }
    expect((await migrateUp(pool, [probe])).applied).deep.equals(['001probe'])
    expect(seen).deep.equals({ table: 'probe', same: true })
    expect(await migrateDown(pool, [probe], 1)).deep.equals(['001probe'])
  })

  it("rolls back up's SQL when its step throws", async function () {
    const doomed: Migration = {
      name: '002doomed',
      up: 'create table doomed (id text primary key);',
      down: 'drop table doomed;',
      steps: async client => {
        await client.query(`insert into doomed values ('one')`)
        throw new Error('boom')
      }
    }
    const refused = await migrateUp(pool, [doomed]).then(
      () => undefined,
      (error: unknown) => error
    )
    expect(refused)
      .instanceOf(Error)
      .property('message')
      .equals('Migration 002doomed failed: boom')
    const { rows } = await pool.query<{ table: string | null }>(
      "select to_regclass('doomed')::text as table"
    )
    expect(rows[0].table).equals(null)
    const recorded = await pool.query(
      `select 1 from schema_migrations where name = '002doomed'`
    )
    expect(recorded.rowCount).equals(0)
  })

  it('rewrites a JSON column in keyset batches, writing only the rows it changes', async function () {
    await pool.query(`
      create table pages (id text primary key, doc jsonb);
      create table page_writes (id text);
      create function page_written() returns trigger language plpgsql as $fn$
      begin
        insert into page_writes values (new.id);
        return new;
      end
      $fn$;
      create trigger page_written after update on pages
        for each row execute function page_written();
      insert into pages
        select lpad(n::text, 5, '0'), jsonb_build_object('n', n, 'keep', n % 3 = 0)
        from generate_series(1, ${STEP_BATCH * 2 + 1}) as n;
      insert into pages values ('zzzzz', null);`)
    const client = await pool.connect()
    try {
      const written = await rewriteJson(
        client,
        { table: 'pages', column: 'doc', where: 'doc is not null' },
        doc => {
          const page = doc as { n: number; keep: boolean }
          // A copy with its keys in another order is the same JSON.
          if (page.keep) return { keep: page.keep, n: page.n }
          return { ...page, doubled: page.n * 2 }
        }
      )
      const changed = Math.ceil(((STEP_BATCH * 2 + 1) * 2) / 3)
      expect(written).equals(changed)
      // A null row is read only without the condition, and a change that
      // answers nothing writes JSON null over it: no change.
      expect(
        await rewriteJson(
          client,
          { table: 'pages', column: 'doc' },
          (doc): unknown => (doc === null ? undefined : doc)
        )
      ).equals(0)
    } finally {
      client.release()
    }
    const writes = await pool.query<{ count: string }>(
      'select count(*) from page_writes'
    )
    expect(Number(writes.rows[0].count)).equals(
      Math.ceil(((STEP_BATCH * 2 + 1) * 2) / 3)
    )
    const sample = await pool.query<{ doc: unknown }>(
      `select doc from pages where id in ('00002', '00003') order by id`
    )
    expect(sample.rows.map(row => row.doc)).deep.equals([
      { n: 2, keep: false, doubled: 4 },
      { n: 3, keep: true }
    ])
  })
})
