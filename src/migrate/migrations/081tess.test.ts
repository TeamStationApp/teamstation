import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { userIdOfGumbo } from '../../common/userId'
import { migrateDown, migrateUp } from '../runner'
import { schemaSnapshot } from '../schemaSnapshot'
import { testDatabaseUrl } from '../testDatabase'
import { migration081Tess } from './081tess'
import { migrations } from './index'

const TABLES = [
  'tess_attachments',
  'tess_changes',
  'tess_conversations',
  'tess_messages',
  'tess_usage_weeks'
]

describe('081 Tess', function () {
  this.timeout(60000)
  const name = `teamstation_tess_${process.pid}_${Date.now()}`
  const owner = userIdOfGumbo(4301)
  const other = userIdOfGumbo(4302)
  let admin: Pool
  let pool: Pool
  const refused = async (statement: string): Promise<string> => {
    let failure: unknown
    await pool.query(statement).catch((error: unknown) => {
      failure = error
    })
    expect(failure, statement).not.equals(undefined)
    return String(failure)
  }
  const tables = async (): Promise<string[]> =>
    (
      await pool.query<{ tablename: string }>(
        `select tablename from pg_tables
          where schemaname = 'public' and tablename like 'tess\\_%'
          order by tablename`
      )
    ).rows.map(row => row.tablename)
  const count = async (table: string, userId: string): Promise<number> =>
    Number(
      (
        await pool.query<{ n: string }>(
          `select count(*)::text as n from ${table} where user_id = $1`,
          [userId]
        )
      ).rows[0].n
    )
  /** One row in each table for this person. */
  const fill = async (userId: string, n: number): Promise<void> => {
    const uuid = (k: number): string =>
      `00000000-0000-4000-8000-${String(n * 10 + k).padStart(12, '0')}`
    await pool.query(`insert into tess_conversations (user_id) values ($1)`, [
      userId
    ])
    await pool.query(
      `insert into tess_messages (user_id, role, content) values ($1, 'user', $2)`,
      [userId, JSON.stringify([{ type: 'text', text: 'Where is it?' }])]
    )
    await pool.query(
      `insert into tess_attachments (id, user_id, name, media_type, kind, data)
        values ($1, $2, 'roster.csv', 'text/csv', 'csv', $3)`,
      [uuid(1), userId, Buffer.from('name\n')]
    )
    await pool.query(
      `insert into tess_changes (id, user_id, method, path, summary, expires_at)
        values ($1, $2, 'POST', '/teams/tem_one/games', 'Add a game', now())`,
      [uuid(2), userId]
    )
    await pool.query(
      `insert into tess_usage_weeks (user_id, week_start, input_tokens, output_tokens, requests)
        values ($1, '2026-10-19', 1200, 300, 1)`,
      [userId]
    )
  }

  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '081')
    )
    await pool.query(
      `insert into users (id, display_name) values ($1, 'Demo Owner'), ($2, 'Demo Other')`,
      [owner, other]
    )
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  it('is registered after every earlier migration', () => {
    expect(migrations.at(-1)).equals(migration081Tess)
  })

  it('creates the five tables with their checks, and rolls back to the schema before it', async () => {
    const before = await schemaSnapshot(pool)
    expect(await tables()).deep.equals([])
    await migrateUp(pool, [migration081Tess])
    expect(await tables()).deep.equals(TABLES)

    await fill(owner, 1)
    expect(
      (
        await pool.query(
          `select summary, context_tokens from tess_conversations`
        )
      ).rows
    ).deep.equals([{ summary: null, context_tokens: 0 }])
    expect(
      (await pool.query(`select status, result from tess_changes`)).rows
    ).deep.equals([{ status: 'pending', result: null }])

    expect(
      await refused(
        `insert into tess_messages (user_id, role, content) values ('${owner}', 'tool', '[]')`
      )
    ).includes('tess_messages_role_check')
    expect(
      await refused(
        `insert into tess_attachments (id, user_id, name, media_type, kind, data)
          values ('00000000-0000-4000-8000-000000000099', '${owner}', 'a.pdf', 'application/pdf', 'pdf', 'x'::bytea)`
      )
    ).includes('tess_attachments_kind_check')
    // An attachment always has its bytes or, after compaction, a description.
    expect(
      await refused(
        `insert into tess_attachments (id, user_id, name, media_type, kind)
          values ('00000000-0000-4000-8000-000000000098', '${owner}', 'a.png', 'image/png', 'image')`
      )
    ).includes('tess_attachments_content')
    await pool.query(
      `update tess_attachments set description = 'A roster of one', data = null`
    )
    expect(
      await refused(
        `update tess_changes set status = 'cancelled' where user_id = '${owner}'`
      )
    ).includes('tess_changes_status_check')
    expect(
      await refused(
        `insert into tess_changes (id, user_id, method, path, summary, expires_at)
          values ('00000000-0000-4000-8000-000000000097', '${owner}', 'GET', '/api/v1/teams', 'Read', now())`
      )
    ).includes('tess_changes_method_check')

    // One row per person per week, and a week starts on a Monday.
    expect(
      await refused(
        `insert into tess_usage_weeks (user_id, week_start) values ('${owner}', '2026-10-19')`
      )
    ).includes('tess_usage_weeks_pkey')
    expect(
      await refused(
        `insert into tess_usage_weeks (user_id, week_start) values ('${owner}', '2026-10-25')`
      )
    ).includes('tess_usage_weeks_monday')
    expect(
      await refused(
        `insert into tess_usage_weeks (user_id, week_start, input_tokens) values ('${other}', '2026-10-19', -1)`
      )
    ).includes('tess_usage_weeks_input_tokens_check')
    expect(
      await refused(
        `insert into tess_conversations (user_id) values ('${owner}')`
      )
    ).includes('tess_conversations_pkey')

    // Removing a person's row takes every Tess row of theirs, and no one else's.
    await fill(other, 2)
    await pool.query(`delete from users where id = $1`, [owner])
    for (const table of TABLES) {
      expect(await count(table, owner), table).equals(0)
      expect(await count(table, other), table).equals(1)
    }

    await migrateDown(pool, [migration081Tess], 1)
    expect(await tables()).deep.equals([])
    expect(await schemaSnapshot(pool)).deep.equals(before)
    await migrateUp(pool, [migration081Tess])
    expect(await tables()).deep.equals(TABLES)
  })
})
