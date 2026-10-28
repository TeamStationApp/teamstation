import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { userIdOfGumbo } from '../../common/userId'
import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migration087LoginOffOnly } from './087loginOffOnly'
import { migrations } from './index'

/**
 * 087: `login_enabled` is written by whoever switches an account, and the
 * triggers only switch it off when the account's last way to sign in goes.
 */
describe('087 login switched off only with the last way in', function () {
  this.timeout(60000)
  const name = `teamstation_login_off_${process.pid}_${Date.now()}`
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  const through = migrations.filter(
    migration => migration.name <= migration087LoginOffOnly.name
  )
  let admin: Pool
  let pool: Pool
  let next = 4400
  const sql = async (text: string, values: unknown[] = []): Promise<void> => {
    await pool.query(text, values)
  }
  const enabled = async (id: string): Promise<boolean> =>
    (
      await pool.query<{ on: boolean }>(
        'select login_enabled as on from users where id = $1',
        [id]
      )
    ).rows[0].on
  /** A user, switched on or off, with the ways in it is given. */
  const user = async (
    on: boolean,
    way: { email?: string; password?: string } = {}
  ): Promise<string> => {
    const id = userIdOfGumbo(++next)
    await sql(
      `insert into users (id, "legacyId", display_name, login_enabled, password_hash)
        values ($1, $2, 'Fixture', $3, $4)`,
      [id, `usr_login_off_${next}`, on, way.password ?? null]
    )
    if (way.email != null)
      await sql(
        `insert into user_emails (id, user_id, email) values ($1, $2, $3)`,
        [`uem_login_off_${next}`, id, way.email]
      )
    return id
  }

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({ connectionString: url })
    await migrateUp(pool, through)
  })
  after(async function () {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name} with (force)`)
      await admin.end()
    }
  })

  it('keeps an account switched on before its address arrives, as one settles', async function () {
    const id = await user(true)
    expect(await enabled(id)).equals(true)
    await sql(
      `insert into user_emails (id, user_id, email) values ('uem_settle', $1, 'settle@example.test')`,
      [id]
    )
    expect(await enabled(id)).equals(true)
  })

  it('leaves a new address or password from switching an account on', async function () {
    const id = await user(false)
    await sql(
      `insert into user_emails (id, user_id, email) values ('uem_new', $1, 'new@example.test')`,
      [id]
    )
    expect(await enabled(id)).equals(false)
    await sql(`update users set password_hash = 'x' where id = $1`, [id])
    expect(await enabled(id)).equals(false)
  })

  it('keeps an account switched off that still has its address and password', async function () {
    const id = await user(true, { email: 'off@example.test', password: 'x' })
    await sql(`update users set login_enabled = false where id = $1`, [id])
    expect(await enabled(id)).equals(false)
    await sql(`update users set login_enabled = true where id = $1`, [id])
    expect(await enabled(id)).equals(true)
  })

  it('switches an account off when its last address goes, and not before', async function () {
    const id = await user(true, { email: 'one@example.test' })
    await sql(
      `insert into user_emails (id, user_id, email) values ('uem_two', $1, 'two@example.test')`,
      [id]
    )
    await sql(`delete from user_emails where email = 'one@example.test'`)
    expect(await enabled(id)).equals(true)
    const other = await user(false)
    await sql(`update user_emails set user_id = $1 where id = 'uem_two'`, [
      other
    ])
    expect(await enabled(id)).equals(false)
    expect(await enabled(other)).equals(false)
  })

  it('switches an account off when its password is cleared with no address left', async function () {
    const kept = await user(true, { email: 'kept@example.test', password: 'x' })
    await sql(`update users set password_hash = null where id = $1`, [kept])
    expect(await enabled(kept)).equals(true)
    const bare = await user(true, { password: 'x' })
    await sql(`update users set password_hash = null where id = $1`, [bare])
    expect(await enabled(bare)).equals(false)
  })

  it('takes no notice of a merge or of undoing it', async function () {
    const into = await user(true, { email: 'into@example.test' })
    const closed = await user(true, { email: 'closed@example.test' })
    await sql(`update users set merged_into = $1 where id = $2`, [into, closed])
    expect(await enabled(closed)).equals(true)
    await sql(`update users set merged_into = null where id = $1`, [closed])
    expect(await enabled(closed)).equals(true)
  })

  it("puts back 075's derived switch on the way down, and its own on the way up", async function () {
    expect(await migrateDown(pool, through, 1)).deep.equals([
      migration087LoginOffOnly.name
    ])
    const derived = await user(true)
    expect(await enabled(derived)).equals(false)
    expect((await migrateUp(pool, through)).applied).deep.equals([
      migration087LoginOffOnly.name
    ])
    expect(await enabled(await user(true))).equals(true)
  })
})
