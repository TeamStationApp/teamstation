import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../migrations'
import { migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migration057ChatMasterCompatibility } from './057chatMasterCompatibility'

describe('057 preserves and synchronizes existing team follows', function () {
  this.timeout(60000)
  const name = `teamstation_chat_master_${Date.now()}`
  const person = mintUserId(() => false)
  let admin: Pool
  let pool: Pool
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < migration057ChatMasterCompatibility.name)
    )
    await pool.query(
      'insert into users (id, "legacyId", display_name) values ($1, $2, $3)',
      [person.userId, person.legacyId, 'Example Follower']
    )
    await pool.query(
      "insert into teams (id, name) values ('tem_legacy', 'Legacy'), ('tem_public', 'Public'), ('tem_next', 'Next')"
    )
    await pool.query(
      "insert into team_follows (user_id, team_id, created_at) values ($1, 'tem_legacy', '2026-01-01T00:00:00Z')",
      [person.userId]
    )
    await pool.query(
      "insert into follows (user_id, group_type, group_id) values ($1, 'team', 'tem_public'), ($1, 'league', 'lea_unchanged')",
      [person.userId]
    )
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  const teams = async (): Promise<string[]> =>
    (
      await pool.query('select team_id from team_follows order by team_id')
    ).rows.map(r => r.team_id)
  const publicTeams = async (): Promise<string[]> =>
    (
      await pool.query(
        "select group_id from follows where group_type = 'team' order by group_id"
      )
    ).rows.map(r => r.group_id)
  it('backfills both directions without changing identity, timestamps, or league follows', async () => {
    expect((await migrateUp(pool, migrations)).applied).deep.equals([
      migration057ChatMasterCompatibility.name
    ])
    expect(await teams()).deep.equals(['tem_legacy', 'tem_public'])
    expect(await publicTeams()).deep.equals(await teams())
    expect(
      (
        await pool.query(
          "select created_at from follows where group_id = 'tem_legacy'"
        )
      ).rows[0].created_at.toISOString()
    ).equals('2026-01-01T00:00:00.000Z')
    expect(
      (
        await pool.query(
          "select group_id from follows where group_type = 'league'"
        )
      ).rows.map(r => r.group_id)
    ).deep.equals(['lea_unchanged'])
    expect(
      (await pool.query('select id from users')).rows.map(r => Number(r.id))
    ).deep.equals([person.userId])
  })
  it('mirrors normal adds, removals, and target changes exactly once in either API', async () => {
    await pool.query(
      "insert into follows (user_id, group_type, group_id) values ($1, 'team', 'tem_next') on conflict do nothing",
      [person.userId]
    )
    expect(await teams()).deep.equals(['tem_legacy', 'tem_next', 'tem_public'])
    await pool.query("delete from follows where group_id = 'tem_next'")
    expect(await teams()).deep.equals(['tem_legacy', 'tem_public'])
    await pool.query(
      "update team_follows set team_id = 'tem_next' where team_id = 'tem_legacy'"
    )
    expect(await publicTeams()).deep.equals(['tem_next', 'tem_public'])
    await pool.query("delete from team_follows where team_id = 'tem_next'")
    expect(await publicTeams()).deep.equals(['tem_public'])
    expect(
      (
        await pool.query(
          "select group_id from follows where group_type = 'league'"
        )
      ).rows
    ).length(1)
  })
  it('marks a disabled account for reconciliation while keeping its stored follows', async () => {
    await pool.query('delete from chat_dirty')
    await pool.query('update users set disabled_at = now() where id = $1', [
      person.userId
    ])
    expect(
      (
        await pool.query(
          "select scope_id from chat_dirty where scope_type = 'user'"
        )
      ).rows.map(r => r.scope_id)
    ).deep.equals([String(person.userId)])
    expect(await teams()).deep.equals(['tem_public'])
  })
})
