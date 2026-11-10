import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { mintUserId } from '../../test/historicalUserIds'
import { migrations as allMigrations } from '../migrations'
import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'

// Exercise this historical migration independently of later identity changes.
const migrations = allMigrations.filter(m => m.name <= '054assistantRole')

describe('054 adds the assistant role flag', function () {
  this.timeout(60000)
  const name = `teamstation_assistant_role_${Date.now()}`
  const coach = mintUserId(() => false)
  let admin: Pool
  let pool: Pool

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '054assistantRole')
    )
    await pool.query(
      `insert into users (id, "legacyId", display_name) values ($1, $2, 'Casey Coach')`,
      [coach.userId, coach.legacyId]
    )
  })

  after(async function () {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  const grant = async (id: string, role: string): Promise<void> => {
    await pool.query(
      `insert into scope_roles (id, user_id, scope_type, scope_id, role)
        values ($1, $2, 'team', 'tem_one', $3)`,
      [id, coach.userId, role]
    )
  }
  const roles = async (): Promise<string[]> =>
    (await pool.query(`select role from scope_roles order by role`)).rows.map(
      row => row.role
    )

  it('refuses an assistant row before it runs', async () => {
    let refused: unknown
    await grant('scr_early', 'assistant').catch((error: unknown) => {
      refused = error
    })
    expect(String(refused)).contains('scope_roles_role_check')
  })

  it('accepts an assistant row beside the other roles', async () => {
    expect((await migrateUp(pool, migrations)).applied).includes(
      '054assistantRole'
    )
    await grant('scr_coach', 'coach')
    await grant('scr_assistant', 'assistant')
    expect(await roles()).deep.equals(['assistant', 'coach'])
  })

  it('rolls down by deleting assistant rows and refusing new ones', async () => {
    expect(
      await migrateDown(
        pool,
        migrations,
        migrations.filter(m => m.name >= '054assistantRole').length
      )
    ).includes('054assistantRole')
    expect(await roles()).deep.equals(['coach'])
    let refused: unknown
    await grant('scr_again', 'assistant').catch((error: unknown) => {
      refused = error
    })
    expect(String(refused)).contains('scope_roles_role_check')
    await migrateUp(pool, migrations)
  })
})
