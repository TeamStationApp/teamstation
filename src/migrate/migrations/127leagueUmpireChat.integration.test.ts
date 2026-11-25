import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { userIdOfGumbo } from '../../common/userId'
import { migrateDown, migrateUp } from '../runner'
import { schemaSnapshot } from '../schemaSnapshot'
import { dropScratchDatabase, testDatabaseUrl } from '../testDatabase'
import { migration127AgeBands } from './127ageBands'
import { migration127LeagueUmpireChat } from './127leagueUmpireChat'
import { migrations } from './index'

/**
 * 127: the league umpire chat's kind, and the marks that keep it: the
 * umpire role and the league's umpire management.
 */
describe('127 the league umpire chat', function () {
  this.timeout(60000)
  const name = `teamstation_league_umpire_chat_${process.pid}_${Date.now()}`
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  const umpire = userIdOfGumbo(101)
  const admin = userIdOfGumbo(102)
  let server: Pool
  let pool: Pool
  const marks = async (): Promise<string[]> =>
    (
      await pool.query<{ mark: string }>(
        // Which scopes are marked; a row may be marked more than once.
        `select distinct scope_type || ':' || scope_id as mark from chat_dirty
          order by mark`
      )
    ).rows.map(row => row.mark)
  const fresh = async (): Promise<void> => {
    await pool.query('delete from chat_dirty')
  }
  const umpireChat = async (): Promise<unknown> =>
    await pool.query(
      `insert into chat_conversations (id, kind, scope_type, scope_id)
        values ('cnv_umpires', 'leagueUmpires', 'league', 'lea_managed')`
    )

  before(async function () {
    server = new Pool({ connectionString: testDatabaseUrl })
    await server.query(`create database ${name}`)
    pool = new Pool({ connectionString: url })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < migration127LeagueUmpireChat.name)
    )
    await pool.query(
      `insert into users (id, display_name) values ($1, 'Demo Umpire'), ($2, 'Demo Admin')`,
      [umpire, admin]
    )
    await pool.query(
      `insert into leagues (id, name, umpire_management) values
         ('lea_managed', 'Demo League A', true),
         ('lea_unmanaged', 'Demo League B', false)`
    )
    await fresh()
  })
  after(async function () {
    await pool?.end()
    if (server != null) {
      await dropScratchDatabase(server, name)
      await server.end()
    }
  })

  it('is registered in name order, right after 127ageBands', function () {
    const at = migrations.indexOf(migration127LeagueUmpireChat)
    expect(migrations[at - 1]).equals(migration127AgeBands)
  })

  it('refuses an umpire chat before it, and marks the leagues that manage umpires when it runs', async function () {
    const failure = await umpireChat().then(
      () => undefined,
      (error: unknown) => error
    )
    expect(String(failure)).contains('chat_conversations_kind_check')
    await migrateUp(pool, [migration127LeagueUmpireChat])
    expect(await marks()).deep.equals(['league:lea_managed'])
    await fresh()
    await umpireChat()
    await pool.query(`delete from chat_conversations where id = 'cnv_umpires'`)
  })

  it('marks the person when the umpire role is granted, changed or taken away', async function () {
    await pool.query(
      `insert into league_umpires (league_id, user_id, granted_by) values ('lea_managed', $1, $2)`,
      [umpire, admin]
    )
    expect(await marks()).deep.equals([`user:${umpire}`])
    await fresh()
    await pool.query(
      `update league_umpires set granted_by = $1 where league_id = 'lea_managed'`,
      [umpire]
    )
    expect(await marks()).deep.equals([`user:${umpire}`])
    await fresh()
    await pool.query(
      `delete from league_umpires where league_id = 'lea_managed'`
    )
    expect(await marks()).deep.equals([`user:${umpire}`])
    await fresh()
  })

  it('marks the league when its umpire management or SafeSport setting changes, and only then', async function () {
    await pool.query(
      `update leagues set umpire_management = false where id = 'lea_managed'`
    )
    expect(await marks()).deep.equals(['league:lea_managed'])
    await fresh()
    await pool.query(
      `update leagues set safesport_lao = not coalesce(safesport_lao, false) where id = 'lea_managed'`
    )
    expect(await marks()).deep.equals(['league:lea_managed'])
    await fresh()
    await pool.query(
      `update leagues set name = 'Demo League C' where id = 'lea_managed'`
    )
    expect(await marks()).deep.equals([])
  })

  it('marks the person when they become a site administrator or stop being one', async function () {
    await pool.query(`update users set is_admin = true where id = $1`, [umpire])
    expect(await marks()).deep.equals([`user:${umpire}`])
    await fresh()
    await pool.query(`update users set is_admin = false where id = $1`, [
      umpire
    ])
    expect(await marks()).deep.equals([`user:${umpire}`])
    await fresh()
    await pool.query(
      `update users set display_name = 'Demo Ump' where id = $1`,
      [umpire]
    )
    expect(await marks()).deep.equals([])
  })

  it('marks the league a season leaves, by moving or by being deleted', async function () {
    await pool.query(
      `insert into seasons (id, name, year, league_id, starts_on, ends_on) values ('sea_moving', 'Demo Season', 2027, 'lea_managed', '2027-03-01', '2027-06-30')`
    )
    await fresh()
    await pool.query(
      `update seasons set league_id = 'lea_unmanaged' where id = 'sea_moving'`
    )
    expect(await marks()).includes('league:lea_managed')
    expect(await marks()).includes('league:lea_unmanaged')
    await fresh()
    await pool.query(`delete from seasons where id = 'sea_moving'`)
    expect(await marks()).includes('league:lea_unmanaged')
    await fresh()
  })

  it('goes down by deleting the umpire chats, and leaves the schema as it was before it', async function () {
    await migrateDown(pool, [migration127LeagueUmpireChat], 1)
    const before = await schemaSnapshot(pool)
    await migrateUp(pool, [migration127LeagueUmpireChat])
    await umpireChat()
    await migrateDown(pool, [migration127LeagueUmpireChat], 1)
    expect(
      (
        await pool.query(
          `select count(*)::int as n from chat_conversations where kind = 'leagueUmpires'`
        )
      ).rows[0].n
    ).equals(0)
    expect(await schemaSnapshot(pool)).deep.equals(before)
    // The umpire role marks nothing once it is gone.
    await fresh()
    await pool.query(
      `insert into league_umpires (league_id, user_id, granted_by) values ('lea_managed', $1, $2)`,
      [umpire, admin]
    )
    expect(await marks()).deep.equals([])
  })
})
