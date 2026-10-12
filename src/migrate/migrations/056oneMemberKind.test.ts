import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../migrations'
import { migrateDown, migrateUp } from '../runner'
import { type SchemaSnapshot, schemaSnapshot } from '../schemaSnapshot'
import { testDatabaseUrl } from '../testDatabase'

const subjectMigrations = migrations.filter(m => m.name <= '056oneMemberKind')

describe('056 makes one kind of member at every level', function () {
  this.timeout(60000)
  const name = `teamstation_one_member_kind_${Date.now()}`
  const watcher = mintUserId(() => false)
  let admin: Pool
  let pool: Pool
  let before056: SchemaSnapshot

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '056oneMemberKind')
    )
    before056 = await schemaSnapshot(pool)
    await pool.query(
      `insert into users (id, "legacyId", display_name) values ($1, $2, 'Wren Watcher')`,
      [watcher.userId, watcher.legacyId]
    )
    await pool.query(`
      insert into leagues (id, name) values ('lea_one', 'League One');
      insert into seasons (id, name, year, league_id)
        values ('sea_one', 'Season One', 2026, 'lea_one'),
          ('sea_two', 'Season Two', 2026, 'lea_one');
      insert into teams (id, name) values ('tem_one', 'Team One');
    `)
    await pool.query(
      `insert into season_members (id, user_id, season_id, role)
        values ('smb_spectator', $1, 'sea_one', 'spectator'),
          ('smb_default', $1, 'sea_two', default)`,
      [watcher.userId]
    )
    await pool.query(
      `insert into league_members (id, user_id, league_id)
        values ('lmb_default', $1, 'lea_one')`,
      [watcher.userId]
    )
    await pool.query(
      `insert into memberships (id, user_id, team_id, is_spectator)
        values ('mem_watcher', $1, 'tem_one', true)`,
      [watcher.userId]
    )
  })

  after(async function () {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  const roles = async (table: string): Promise<string[]> =>
    (await pool.query(`select role from ${table} order by id`)).rows.map(
      row => row.role
    )
  const refusal = async (statement: string): Promise<string> => {
    let refused: unknown
    await pool.query(statement, [watcher.userId]).catch((error: unknown) => {
      refused = error
    })
    return String(refused)
  }

  it('turns every season and league spectator into a member, and allows nothing else', async () => {
    expect((await migrateUp(pool, subjectMigrations)).applied).deep.equals([
      '056oneMemberKind'
    ])
    expect(await roles('season_members')).deep.equals(['member', 'member'])
    expect(await roles('league_members')).deep.equals(['member'])
    expect(
      await refusal(
        `insert into season_members (id, user_id, season_id, role)
          values ('smb_again', $1, 'sea_one', 'spectator')`
      )
    ).contains('season_members_role_check')
    expect(
      await refusal(
        `insert into league_members (id, user_id, league_id, role)
          values ('lmb_again', $1, 'lea_one', 'spectator')`
      )
    ).contains('league_members_role_check')
    // A row written with no role is a member.
    await pool.query(`delete from league_members`)
    await pool.query(
      `insert into league_members (id, user_id, league_id)
        values ('lmb_default', $1, 'lea_one')`,
      [watcher.userId]
    )
    expect(await roles('league_members')).deep.equals(['member'])
  })

  it('drops the spectator flag from team memberships, keeping the membership', async () => {
    const { rows } = await pool.query(
      `select column_name from information_schema.columns
        where table_name = 'memberships' and column_name = 'is_spectator'`
    )
    expect(rows).deep.equals([])
    expect(
      (await pool.query(`select id, role from memberships`)).rows
    ).deep.equals([{ id: 'mem_watcher', role: 'member' }])
  })

  it('rolls down to the earlier shape, every member a spectator again', async () => {
    expect(
      await migrateDown(
        pool,
        migrations.filter(m => m.name <= '056oneMemberKind'),
        1
      )
    ).deep.equals(['056oneMemberKind'])
    expect(await schemaSnapshot(pool)).deep.equals(before056)
    expect(await roles('season_members')).deep.equals([
      'spectator',
      'spectator'
    ])
    expect(await roles('league_members')).deep.equals(['spectator'])
    expect(
      (await pool.query(`select is_spectator from memberships`)).rows
    ).deep.equals([{ is_spectator: false }])
    await migrateUp(pool, subjectMigrations)
  })
})
