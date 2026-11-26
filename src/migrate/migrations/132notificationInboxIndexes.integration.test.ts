import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { userIdOfGumbo } from '../../common/userId'
import { migrateDown, migrateUp } from '../runner'
import {
  createMigratedDatabase,
  dropScratchDatabase,
  testDatabaseUrl,
  testDatabaseUrlOf
} from '../testDatabase'
import { migration132NotificationInboxIndexes as migration } from './132notificationInboxIndexes'
import { migrations as all } from './index'

const migrations = all.slice(
  0,
  all.findIndex(m => m.name === migration.name) + 1
)

describe('notification inbox indexes on existing rows', function () {
  this.timeout(120000)
  const name = `teamstation_notification_indexes_${process.pid}_${Date.now()}`
  const reader = userIdOfGumbo(900001)
  let admin: Pool
  let pool: Pool
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await createMigratedDatabase(admin, name, migrations.slice(0, -1))
    pool = new Pool({ connectionString: testDatabaseUrlOf(name) })
    await pool.query(
      "insert into users (id, display_name) values ($1, 'Synthetic reader')",
      [reader]
    )
    await pool.query(
      `insert into group_requests (id, kind, sender_id, sender_scope_type, sender_scope_id, terms, status, sent_at, expires_at)
      values ('index-add', 'playerAdd', $1, 'team', 'index-team', $2, 'applied', now(), now() + interval '1 day')`,
      [
        reader,
        JSON.stringify({ userId: reader, teamId: 'index-team', mode: 'roster' })
      ]
    )
    await pool.query(
      `insert into notification_events (id, source_type, source_id, revision, recorded_recipients)
      values ('index-event', 'groupRequest', 'index-add', 1, $1::text[])`,
      [[reader]]
    )
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
  })
  it('indexes existing rows, supports live lookup predicates, and rolls back without changing data', async () => {
    const data = async (): Promise<unknown[]> =>
      (
        await pool.query(`
      select to_jsonb(g) as row from group_requests g union all
      select to_jsonb(e) as row from notification_events e
    `)
      ).rows
    const before = await data()
    expect((await migrateUp(pool, migrations)).applied).deep.equals([
      migration.name
    ])
    expect((await migrateUp(pool, migrations)).applied).deep.equals([])
    const names = [
      'group_requests_player_add_later',
      'notification_events_recipients'
    ]
    const indexes = async (): Promise<string[]> =>
      (
        await pool.query(
          'select indexname from pg_indexes where indexname = any($1::text[]) order by indexname',
          [names]
        )
      ).rows.map(row => row.indexname)
    expect(await indexes()).deep.equals(names)
    // On a two-row fixture a sequential scan is legitimately cheaper. Force
    // its alternative only to prove both production predicates can use these
    // indexes; the large inbox fixtures enforce real planner/time budgets.
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query('set local enable_seqscan = off')
      const later = await client.query(
        `explain select id from group_requests
        where kind = 'playerAdd' and status in ('applied', 'accepted')
          and terms->>'userId' = any($1::text[]) and sent_at > $2`,
        [[reader], new Date(0)]
      )
      expect(JSON.stringify(later.rows)).contains(names[0])
      const recipient = await client.query(
        `explain select id from notification_events
        where recorded_recipients @> $1::text[]`,
        [[reader]]
      )
      expect(JSON.stringify(recipient.rows)).contains(names[1])
      await client.query('rollback')
    } finally {
      client.release()
    }
    expect(await data()).deep.equals(before)
    expect(await migrateDown(pool, migrations, 1)).deep.equals([migration.name])
    expect(await indexes()).deep.equals([])
    expect(await data()).deep.equals(before)
    expect((await migrateUp(pool, migrations)).applied).deep.equals([
      migration.name
    ])
    expect(await indexes()).deep.equals(names)
    expect(await data()).deep.equals(before)
  })
})
