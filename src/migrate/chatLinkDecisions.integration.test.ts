import { expect } from 'chai'
import { describe, it } from 'mocha'
import { Pool } from 'pg'

import { openChatFixture } from '../server/chat/chatTestFixture'
import { migration099ChatLinkDecisions } from './migrations/099ChatLinkDecisions'

describe('chat device decision migration', function () {
  this.timeout(120000)
  it('round-trips the decision column and constraint without removing chat data', async function () {
    const fixture = await openChatFixture('link_decisions_migration')
    if (fixture == null) {
      this.skip()
      return
    }
    const pool = new Pool({ connectionString: fixture.url })
    try {
      const before = (
        await pool.query('select id from chat_conversations order by id')
      ).rows
      await pool.query(migration099ChatLinkDecisions.down)
      expect(
        (
          await pool.query(
            "select column_name from information_schema.columns where table_name='chat_links' and column_name='declined_at'"
          )
        ).rows
      ).length(0)
      await pool.query(migration099ChatLinkDecisions.up)
      expect(
        (
          await pool.query(
            "select is_nullable from information_schema.columns where table_name='chat_links' and column_name='declined_at'"
          )
        ).rows
      ).deep.equals([{ is_nullable: 'YES' }])
      expect(
        (
          await pool.query(
            "select conname from pg_constraint where conname='chat_link_one_decision'"
          )
        ).rows
      ).length(1)
      expect(
        (await pool.query('select id from chat_conversations order by id')).rows
      ).deep.equals(before)
    } finally {
      await pool.end()
      await fixture.close()
    }
  })

  it('backfills a notification only for a link that is still pending', async function () {
    const fixture = await openChatFixture('link_decisions_backfill')
    if (fixture == null) {
      this.skip()
      return
    }
    const pool = new Pool({ connectionString: fixture.url })
    try {
      await pool.query(migration099ChatLinkDecisions.down)
      const userId = (await pool.query('select id from users limit 1')).rows[0]
        .id as string
      const key = (mark: string): Buffer => Buffer.alloc(32, mark)
      await pool.query(
        `insert into chat_devices
          (id, user_id, name, platform, box_public_key, sign_public_key, revoked_at)
         values
          ('cdv_live', $1, 'Live phone', 'ios', $2, $2, null),
          ('cdv_approved', $1, 'Old phone', 'web', $2, $2, null),
          ('cdv_expired', $1, 'Expired phone', 'android', $2, $2, null),
          ('cdv_revoked', $1, 'Revoked phone', 'ios', $2, $2, now())`,
        [userId, key('k')]
      )
      await pool.query(
        `insert into chat_links
          (id, user_id, new_device_id, box, created_at, expires_at)
         values
          ('clk_live', $1, 'cdv_live', null, now(), now() + interval '10 minutes'),
          ('clk_approved', $1, 'cdv_approved', $2, now(), now() + interval '10 minutes'),
          ('clk_expired', $1, 'cdv_expired', null, now() - interval '20 minutes', now() - interval '1 minute'),
          ('clk_revoked', $1, 'cdv_revoked', null, now(), now() + interval '10 minutes')`,
        [userId, key('b')]
      )
      await pool.query(migration099ChatLinkDecisions.up)
      const notices = (
        await pool.query(
          `select source_id, metadata->>'description' as description
           from notification_events
           where source_type = 'chatDeviceApproval'
           order by source_id`
        )
      ).rows
      expect(notices).deep.equals([
        {
          source_id: 'clk_live',
          description: 'Live phone (ios) asks to read your chats.'
        }
      ])
    } finally {
      await pool.end()
      await fixture.close()
    }
  })
})
