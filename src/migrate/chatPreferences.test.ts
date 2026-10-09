import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import {
  type ChatFixture,
  openChatFixture
} from '../server/chat/chatTestFixture'
import { migrations } from './migrations'
import { migration053ChatPreferences } from './migrations/053chatPreferences'
import { migrateDown, migrateUp } from './runner'

describe('053: personal chat metadata migration', function () {
  this.timeout(120000)
  let fixture: ChatFixture
  let pool: Pool
  before(async function () {
    const opened = await openChatFixture('preferences_migration')
    if (opened == null) {
      this.skip()
      return
    }
    fixture = opened
    pool = new Pool({ connectionString: fixture.url })
  })
  after(async function () {
    await pool?.end()
    await fixture?.close()
  })
  it('round-trips personal tables without touching conversations or existing crypto tables', async function () {
    const before = (
      await pool.query('select count(*)::int as count from chat_conversations')
    ).rows[0].count
    const id = (await pool.query('select id from chat_conversations limit 1'))
      .rows[0].id
    await pool.query(
      'insert into chat_conversation_preferences (user_id, conversation_id) values ($1, $2)',
      [fixture.id('Hc'), id]
    )
    const defaults = (
      await pool.query(
        'select pinned, muted, manual_unread, manual_unread_revision from chat_conversation_preferences'
      )
    ).rows[0]
    expect(defaults).includes({
      pinned: false,
      muted: false,
      manual_unread: false
    })
    expect(Number(defaults.manual_unread_revision)).equals(0)
    expect(await migrateDown(pool, migrations, 1)).deep.equals([
      migration053ChatPreferences.name
    ])
    expect(
      (
        await pool.query(
          'select count(*)::int as count from chat_conversations'
        )
      ).rows[0].count
    ).equals(before)
    expect((await migrateUp(pool, migrations)).applied).deep.equals([
      migration053ChatPreferences.name
    ])
    expect(
      (
        await pool.query(
          'select count(*)::int as count from chat_conversation_preferences'
        )
      ).rows[0].count
    ).equals(0)
    await pool.query('select * from chat_identities limit 1')
    await pool.query('select * from chat_message_pins limit 1')
  })
})
