import { expect } from 'chai'
import { describe, it } from 'mocha'
import { Pool } from 'pg'

import { openChatFixture } from '../server/chat/chatTestFixture'
import { migration091ChatLinkDecisions } from './migrations/091ChatLinkDecisions'

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
      await pool.query(migration091ChatLinkDecisions.down)
      expect(
        (
          await pool.query(
            "select column_name from information_schema.columns where table_name='chat_links' and column_name='declined_at'"
          )
        ).rows
      ).length(0)
      await pool.query(migration091ChatLinkDecisions.up)
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
})
