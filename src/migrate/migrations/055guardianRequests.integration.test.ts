import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { mintUserId } from '../../test/historicalUserIds'
import { migrations as allMigrations } from '../migrations'
import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'

// Exercise this historical migration independently of later identity changes.
const migrations = allMigrations.filter(m => m.name <= '055guardianRequests')

describe('055 adds guardian requests', function () {
  this.timeout(60000)
  const name = `teamstation_guardian_requests_${Date.now()}`
  const sender = mintUserId(() => false)
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
      migrations.filter(m => m.name < '055guardianRequests')
    )
    await pool.query(
      `insert into users (id, "legacyId", display_name) values ($1, $2, 'Casey Sender')`,
      [sender.userId, sender.legacyId]
    )
  })

  after(async function () {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  const send = async (
    id: string,
    kind: string,
    scope: [string, string] | null
  ): Promise<void> => {
    await pool.query(
      `insert into group_requests
        (id, kind, sender_id, sender_scope_type, sender_scope_id, terms, sent_at, expires_at)
        values ($1, $2, $3, $4, $5, '{}', now(), now() + interval '7 days')`,
      [id, kind, sender.userId, scope?.[0] ?? null, scope?.[1] ?? null]
    )
    await pool.query(
      `insert into notification_events
        (id, source_type, source_id, revision, actor_id, metadata, recorded_recipients)
        values ($1, 'groupRequest', $2, 1, $3, '{}', ARRAY[$3]::bigint[])`,
      [`aud_${id}`, id, sender.userId]
    )
  }
  const refusal = async (
    id: string,
    kind: string,
    scope: [string, string] | null
  ): Promise<string> => {
    let refused: unknown
    await send(id, kind, scope).catch((error: unknown) => {
      refused = error
    })
    return String(refused)
  }
  const requests = async (): Promise<string[]> =>
    (await pool.query(`select id from group_requests order by id`)).rows.map(
      row => row.id
    )

  it('refuses a guardian request, and a missing sender scope, before it runs', async () => {
    expect(
      await refusal('grq_early', 'guardian', ['team', 'tem_one'])
    ).contains('group_requests_kind_check')
    expect(await refusal('grq_scopeless', 'person', null)).contains(
      'sender_scope_type'
    )
  })

  it('accepts guardian requests with or without a sender scope, and no other kind without one', async () => {
    expect((await migrateUp(pool, migrations)).applied).includes(
      '055guardianRequests'
    )
    await send('grq_invitation', 'guardian', ['team', 'tem_one'])
    await send('grq_request', 'guardian', null)
    await send('grq_person', 'person', ['team', 'tem_one'])
    expect(await refusal('grq_bad', 'person', null)).contains(
      'group_requests_sender_scope_check'
    )
    expect(await requests()).deep.equals([
      'grq_invitation',
      'grq_person',
      'grq_request'
    ])
    const index = await pool.query(
      `select indexdef from pg_indexes where indexname = 'group_requests_guardian_sender'`
    )
    expect(index.rows[0].indexdef).contains(
      '(sender_id, kind, status, resolved_at)'
    )
  })

  it('rolls down by deleting guardian requests and refusing new ones', async () => {
    expect(
      await migrateDown(
        pool,
        migrations,
        migrations.filter(m => m.name >= '055guardianRequests').length
      )
    ).includes('055guardianRequests')
    expect(await requests()).deep.equals(['grq_person'])
    expect(
      (
        await pool.query(
          `select source_id from notification_events order by source_id`
        )
      ).rows.map(row => row.source_id)
    ).deep.equals(['grq_person'])
    expect(
      await refusal('grq_again', 'guardian', ['team', 'tem_one'])
    ).contains('group_requests_kind_check')
    expect(await refusal('grq_scopeless_again', 'person', null)).contains(
      'sender_scope_type'
    )
    await migrateUp(pool, migrations)
  })
})
