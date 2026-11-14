import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { userIdOfGumbo } from '../../common/userId'
import { migrateDown, migrateUp } from '../runner'
import { schemaSnapshot } from '../schemaSnapshot'
import { testDatabaseUrl } from '../testDatabase'
import { migration118PushNotifications } from './118pushNotifications'
import { migrations } from './index'

const TABLES = [
  'push_registrations',
  'push_reminders_sent',
  'user_notification_settings'
]

describe('118 push notifications', function () {
  this.timeout(60000)
  const name = `teamstation_push_${process.pid}_${Date.now()}`
  const owner = userIdOfGumbo(4401)
  const other = userIdOfGumbo(4402)
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
          where schemaname = 'public'
            and tablename in ('push_registrations', 'push_reminders_sent', 'user_notification_settings')
          order by tablename`
      )
    ).rows.map(row => row.tablename)
  const register = async (
    id: string,
    userId: string,
    session: string,
    platform: string,
    key: string
  ): Promise<void> => {
    await pool.query(
      `insert into push_registrations (id, user_id, session_id, platform, address_key, address, environment)
        values ($1, $2, $3, $4, $5, $5, 'production')`,
      [id, userId, session, platform, key]
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
      migrations.filter(m => m.name < '118')
    )
    await pool.query(
      `insert into users (id, display_name) values ($1, 'Demo Owner'), ($2, 'Demo Other')`,
      [owner, other]
    )
    await pool.query(
      `insert into auth_sessions (id, user_id, token_hash, expires_at)
        values ('ses_owner', $1, 'hash_owner', now() + interval '1 day'),
               ('ses_other', $2, 'hash_other', now() + interval '1 day')`,
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
    const at = migrations.indexOf(migration118PushNotifications)
    expect(at).equals(migrations.length - 1)
    expect(
      migrations
        .slice(at + 1)
        .filter(item => item.name < migration118PushNotifications.name)
    ).deep.equals([])
  })

  it('creates the three tables with their checks, and rolls back to the schema before it', async () => {
    const before = await schemaSnapshot(pool)
    expect(await tables()).deep.equals([])
    await migrateUp(pool, [migration118PushNotifications])
    expect(await tables()).deep.equals(TABLES)

    // Both switches start off.
    await pool.query(
      `insert into user_notification_settings (user_id) values ($1)`,
      [owner]
    )
    expect(
      (
        await pool.query(
          `select messages, rsvp_events from user_notification_settings`
        )
      ).rows
    ).deep.equals([{ messages: false, rsvp_events: false }])

    // One row per address: the same token on another platform is another.
    await register('psh_1', owner, 'ses_owner', 'ios', 'token-a')
    await register('psh_2', owner, 'ses_owner', 'android', 'token-a')
    expect(
      await refused(
        `insert into push_registrations (id, user_id, session_id, platform, address_key, address, environment)
          values ('psh_3', '${other}', 'ses_other', 'ios', 'token-a', 'token-a', 'production')`
      )
    ).includes('push_registrations_platform_address_key_key')
    expect(
      await refused(
        `insert into push_registrations (id, user_id, session_id, platform, address_key, address, environment)
          values ('psh_4', '${owner}', 'ses_owner', 'watch', 'token-b', 'token-b', 'production')`
      )
    ).includes('push_registrations_platform_check')
    expect(
      await refused(
        `insert into push_registrations (id, user_id, session_id, platform, address_key, address, environment)
          values ('psh_5', '${owner}', 'ses_owner', 'web', 'https://push.example.test/1', '{}', 'staging')`
      )
    ).includes('push_registrations_environment_check')

    // A reminder is sent once for each start of an event.
    const remind = `insert into push_reminders_sent (event_kind, event_id, user_id, start_at)
      values ('game', 'gam_1', '${owner}', '2026-11-12T18:00:00Z')`
    await pool.query(remind)
    expect(await refused(remind)).includes('push_reminders_sent_pkey')
    await pool.query(
      `insert into push_reminders_sent (event_kind, event_id, user_id, start_at)
        values ('game', 'gam_1', '${owner}', '2026-11-12T19:00:00Z')`
    )
    expect(
      await refused(
        `insert into push_reminders_sent (event_kind, event_id, user_id, start_at)
          values ('practice', 'tev_1', '${owner}', now())`
      )
    ).includes('push_reminders_sent_event_kind_check')

    // A session's end takes its addresses; a person's removal takes theirs.
    await register(
      'psh_6',
      other,
      'ses_other',
      'web',
      'https://push.example.test/2'
    )
    await pool.query(`delete from auth_sessions where id = 'ses_other'`)
    expect(
      (await pool.query(`select id from push_registrations order by id`)).rows
    ).deep.equals([{ id: 'psh_1' }, { id: 'psh_2' }])
    await pool.query(`delete from auth_sessions where user_id = $1`, [owner])
    await pool.query(`delete from users where id = $1`, [owner])
    expect(
      (
        await pool.query(
          `select count(*)::int as n from user_notification_settings`
        )
      ).rows[0].n
    ).equals(0)
    expect(
      (await pool.query(`select count(*)::int as n from push_registrations`))
        .rows[0].n
    ).equals(0)

    await migrateDown(pool, [migration118PushNotifications], 1)
    expect(await tables()).deep.equals([])
    expect(await schemaSnapshot(pool)).deep.equals(before)
    await migrateUp(pool, [migration118PushNotifications])
    expect(await tables()).deep.equals(TABLES)
  })
})
