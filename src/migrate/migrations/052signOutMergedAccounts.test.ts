import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../migrations'
import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'

describe('052 signs out accounts that were already merged', function () {
  this.timeout(60000)
  const name = `teamstation_signout_merged_${Date.now()}`
  const kept = mintUserId(() => false)
  const closed = mintUserId(id => id === kept.userId)
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
      migrations.filter(m => m.name < '052signOutMergedAccounts')
    )
    await pool.query(
      `insert into users (id, "legacyId", display_name) values
        ($1, $2, 'Mookie Betts'), ($3, $4, 'Mookie Betts')`,
      [kept.userId, kept.legacyId, closed.userId, closed.legacyId]
    )
    await pool.query(`update users set merged_into = $1 where id = $2`, [
      kept.userId,
      closed.userId
    ])
    for (const [who, id] of [
      ['kept', kept.userId],
      ['closed', closed.userId]
    ] as const) {
      await pool.query(
        `insert into auth_sessions (id, user_id, token_hash, expires_at)
          values ($1, $2, $3, now() + interval '1 day')`,
        [`ses_${who}`, id, `hash_session_${who}`]
      )
      await pool.query(
        `insert into api_tokens (id, user_id, label, token_hash)
          values ($1, $2, 'Distributor', $3)`,
        [`atk_${who}`, id, `hash_token_${who}`]
      )
      await pool.query(
        `insert into oauth_grant_sessions (grant_hash, client_id, user_id, session_id)
          values ($1, 'assistant', $2, $3)`,
        [`grant_${who}`, id, `ses_${who}`]
      )
      await pool.query(
        `insert into oauth_records (model, id_hash, payload, grant_hash) values
          ('Grant', $1, 'sealed', null),
          ('AccessToken', $2, 'sealed', $1),
          ('RefreshToken', $3, 'sealed', $1)`,
        [`grant_${who}`, `access_${who}`, `refresh_${who}`]
      )
    }
    // Revoked long ago: the migration leaves the time it was revoked alone.
    await pool.query(
      `insert into auth_sessions (id, user_id, token_hash, expires_at, revoked_at)
        values ('ses_old', $1, 'hash_session_old', now() + interval '1 day', '2020-01-01')`,
      [closed.userId]
    )
  })

  after(async function () {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  const state = async (): Promise<unknown> => ({
    sessions: (
      await pool.query(
        `select id, revoked_at is not null as revoked from auth_sessions order by id`
      )
    ).rows,
    tokens: (
      await pool.query(
        `select id, revoked_at is not null as revoked from api_tokens order by id`
      )
    ).rows,
    records: (
      await pool.query(`select id_hash from oauth_records order by id_hash`)
    ).rows.map(row => row.id_hash),
    grants: (
      await pool.query(
        `select grant_hash from oauth_grant_sessions order by grant_hash`
      )
    ).rows.map(row => row.grant_hash)
  })

  it('revokes what the merged account held and nothing of the kept one', async () => {
    expect((await migrateUp(pool, migrations)).applied).includes(
      '052signOutMergedAccounts'
    )
    expect(await state()).deep.equals({
      sessions: [
        { id: 'ses_closed', revoked: true },
        { id: 'ses_kept', revoked: false },
        { id: 'ses_old', revoked: true }
      ],
      tokens: [
        { id: 'atk_closed', revoked: true },
        { id: 'atk_kept', revoked: false }
      ],
      records: ['access_kept', 'grant_kept', 'refresh_kept'],
      grants: ['grant_kept']
    })
    const old = await pool.query(
      `select revoked_at from auth_sessions where id = 'ses_old'`
    )
    expect(new Date(old.rows[0].revoked_at).getUTCFullYear()).equals(2020)
  })

  it('rolls down without bringing anything back', async () => {
    const before = await state()
    expect(
      await migrateDown(
        pool,
        migrations,
        migrations.filter(m => m.name >= '052signOutMergedAccounts').length
      )
    ).includes('052signOutMergedAccounts')
    expect(await state()).deep.equals(before)
    await migrateUp(pool, migrations)
  })
})
