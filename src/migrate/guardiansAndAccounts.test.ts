import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from './migrations'
import { migration051GuardiansAndAccounts } from './migrations/051guardiansAndAccounts'
import { migrateDown, migrateUp } from './runner'
import { testDatabaseUrl } from './testDatabase'

/**
 * U2: 051 over a database with users in every state, then its triggers.
 *
 * `login_enabled` must come out true exactly for unmerged users with an
 * address or a password, and stay so whatever writes to `users` or
 * `user_emails` afterwards.
 */
const adminUrl = testDatabaseUrl
const name = `teamstation_050_${Date.now()}_${process.pid}`
const url = adminUrl.replace(/\/[^/]*$/, `/${name}`)

const before050 = migrations.filter(
  migration => migration.name < migration051GuardiansAndAccounts.name
)

// Users, by what they hold before 051 runs.
const WITH_EMAIL = 101
const WITH_PASSWORD = 102
const WITH_NOTHING_BUT_ENABLED = 103
const MERGED_WITH_EMAIL = 104
const WITH_NOTHING = 105
const LATER = 106

describe('051: accounts are users with a way to sign in', function () {
  this.timeout(120000)

  let admin: Pool | undefined
  let pool: Pool | undefined
  const live = (): Pool => {
    if (pool == null) throw new Error('no database')
    return pool
  }

  const enabled = async (id: number): Promise<boolean> => {
    const { rows } = await live().query<{ on: boolean }>(
      'select login_enabled as on from users where id = $1',
      [id]
    )
    return rows[0].on
  }
  const sql = async (text: string, values: unknown[] = []): Promise<void> => {
    await live().query(text, values)
  }
  const refused = async (text: string): Promise<string> => {
    try {
      await sql(text)
    } catch (error) {
      return String(error)
    }
    return 'accepted'
  }

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query('select 1')
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
      return
    }
    await admin.query(`create database ${name}`)
    pool = new Pool({ connectionString: url })
    await migrateUp(pool, before050)
    await sql(`
      insert into users (id, "legacyId", display_name, password_hash, login_enabled) values
        (${WITH_EMAIL}, 'u101', 'Email', null, false),
        (${WITH_PASSWORD}, 'u102', 'Password', 'hash', false),
        (${WITH_NOTHING_BUT_ENABLED}, 'u103', 'Imported', null, true),
        (${MERGED_WITH_EMAIL}, 'u104', 'Closed', null, true),
        (${WITH_NOTHING}, 'u105', 'Nothing', null, false);
      update users set merged_into = ${WITH_EMAIL} where id = ${MERGED_WITH_EMAIL};
      insert into user_emails (id, user_id, email) values
        ('uem_1', ${WITH_EMAIL}, 'one@example.com'),
        ('uem_4', ${MERGED_WITH_EMAIL}, 'four@example.com');
    `)
    expect(
      await migrateUp(pool, migrations).then(result => result.applied)
    ).deep.equals([migration051GuardiansAndAccounts.name])
  })

  after(async function () {
    if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name} with (force)`)
      await admin.end()
    }
  })

  it('sets login_enabled exactly for unmerged users with an address or a password', async function () {
    expect(await enabled(WITH_EMAIL)).equals(true)
    expect(await enabled(WITH_PASSWORD)).equals(true)
    expect(await enabled(WITH_NOTHING_BUT_ENABLED)).equals(false)
    expect(await enabled(MERGED_WITH_EMAIL)).equals(false)
    expect(await enabled(WITH_NOTHING)).equals(false)
  })

  it('follows the last address in and out', async function () {
    await sql(`delete from user_emails where user_id = ${WITH_EMAIL}`)
    expect(await enabled(WITH_EMAIL)).equals(false)
    await sql(
      `insert into user_emails (id, user_id, email) values ('uem_1b', ${WITH_EMAIL}, 'one@example.com')`
    )
    expect(await enabled(WITH_EMAIL)).equals(true)
  })

  it('follows an address moved from one user to another', async function () {
    await sql(
      `update user_emails set user_id = ${WITH_NOTHING} where id = 'uem_1b'`
    )
    expect(await enabled(WITH_EMAIL)).equals(false)
    expect(await enabled(WITH_NOTHING)).equals(true)
    await sql(
      `update user_emails set user_id = ${WITH_EMAIL} where id = 'uem_1b'`
    )
    expect(await enabled(WITH_EMAIL)).equals(true)
    expect(await enabled(WITH_NOTHING)).equals(false)
  })

  it('follows a password set and cleared', async function () {
    await sql(`update users set password_hash = 'x' where id = ${WITH_NOTHING}`)
    expect(await enabled(WITH_NOTHING)).equals(true)
    await sql(
      `update users set password_hash = null where id = ${WITH_NOTHING}`
    )
    expect(await enabled(WITH_NOTHING)).equals(false)
  })

  it('turns it off on a merge and back on when the merge is undone', async function () {
    await sql(
      `update users set merged_into = ${WITH_EMAIL} where id = ${WITH_PASSWORD}`
    )
    expect(await enabled(WITH_PASSWORD)).equals(false)
    await sql(`update users set merged_into = null where id = ${WITH_PASSWORD}`)
    expect(await enabled(WITH_PASSWORD)).equals(true)
  })

  it('reads back false when it is written true on a user with no way in', async function () {
    await sql(
      `insert into users (id, "legacyId", display_name, login_enabled) values (${LATER}, 'u106', 'Later', true)`
    )
    expect(await enabled(LATER)).equals(false)
    await sql(`update users set login_enabled = true where id = ${LATER}`)
    expect(await enabled(LATER)).equals(false)
    await sql(
      `update users set login_enabled = false where id = ${WITH_PASSWORD}`
    )
    expect(await enabled(WITH_PASSWORD)).equals(true)
    // Something else about the user changes nothing.
    await sql(
      `update users set display_name = 'Pass' where id = ${WITH_PASSWORD}`
    )
    expect(await enabled(WITH_PASSWORD)).equals(true)
  })

  it('keeps a birth month to a year and a month, both or neither', async function () {
    expect(
      await refused(`update users set birth_year = 2012 where id = ${LATER}`)
    ).contains('users_birth_month_both')
    expect(
      await refused(
        `update users set birth_year = 2012, birth_month = 13 where id = ${LATER}`
      )
    ).contains('check')
    await sql(
      `update users set birth_year = 2012, birth_month = 12 where id = ${LATER}`
    )
  })

  it('sets a guardian invite’s player and kind together, on a team invite only', async function () {
    let n = 0
    const invite = (scope: string, player: string, kind: string): string => {
      n += 1
      return `insert into invites (id, code, scope_type, scope_id, guardian_of_user_id, relative_kind)
       values ('inv_${n}', 'code${n}', '${scope}', 'x', ${player}, ${kind})`
    }
    expect(
      await refused(invite('season', String(LATER), "'guardian'"))
    ).contains('invites_guardian_of_team')
    expect(await refused(invite('team', String(LATER), 'null'))).contains(
      'invites_guardian_of_team'
    )
    expect(await refused(invite('team', 'null', "'family'"))).contains(
      'invites_guardian_of_team'
    )
    expect(await refused(invite('team', String(LATER), "'aunt'"))).contains(
      'check'
    )
    await sql(invite('team', String(LATER), "'family'"))
    await sql(`delete from invites`)
  })

  it('says no league is a SafeSport LAO until told', async function () {
    await sql(`insert into leagues (id, name) values ('lea_x', 'X')`)
    const { rows } = await live().query<{ lao: boolean }>(
      `select safesport_lao as lao from leagues where id = 'lea_x'`
    )
    expect(rows).deep.equals([{ lao: false }])
  })

  it('rolls back and applies again', async function () {
    const down = await migrateDown(pool!, migrations, 1)
    expect(down).deep.equals([migration051GuardiansAndAccounts.name])
    const { rows } = await live().query<{ n: number }>(
      `select count(*)::int as n from information_schema.columns
       where column_name in ('birth_year', 'birth_month', 'safesport_lao',
         'guardian_of_user_id', 'relative_kind')`
    )
    expect(rows[0].n).equals(0)
    await sql(`update users set login_enabled = true where id = ${LATER}`)
    expect(await enabled(LATER)).equals(true)
    await migrateUp(pool!, migrations)
    expect(await enabled(LATER)).equals(false)
  })
})
