import { expect } from 'chai'
import { describe, it } from 'mocha'
import { Pool } from 'pg'

import { newEpochKey } from '../common/chatCrypto/keys'
import { ChatDevices, ok } from '../server/chat/chatTestDevices'
import { openChatFixture } from '../server/chat/chatTestFixture'
import { migration105ChatHistoryRecovery as migration } from './migrations/105chatHistoryRecovery'

describe('chat history recovery migration', function () {
  this.timeout(120000)
  it('preserves legacy bytes, deterministically numbers boxes, and serializes later deliveries', async function () {
    const f = await openChatFixture('history_migration')
    if (f == null) throw new Error('PostgreSQL 18 is required')
    const pool = new Pool({ connectionString: f.url })
    try {
      await pool.query(migration.down)
      const d = new ChatDevices(f)
      const a = await d.enrol('Ha')
      await d.enrol('Hc')
      const chats = ok(await f.call('Ha', 'GET', '/chat/conversations'))
      const id = chats.find(
        (c: { title: string }) => c.title === 'Hawks Staff'
      ).id
      const body = d.epochBody({
        conversationId: id,
        epoch: 1,
        creator: a.keys,
        epochKey: newEpochKey(),
        previousEpochKey: null,
        recipients: await d.recipients('Ha', id, 'eligible')
      })
      ok(
        await f.call('Ha', 'POST', `/chat/conversations/${id}/epochs`, body),
        201
      )
      const snapshot = async (): Promise<unknown> =>
        (
          await pool.query(`
        select epoch,signature,previous_key_box,chain_break from chat_epochs order by conversation_id,epoch
      `)
        ).rows
      const before = await snapshot()
      const boxes = (
        await pool.query('select * from chat_epoch_boxes order by user_id')
      ).rows
      await pool.query(migration.up)
      expect(await snapshot()).deep.equals(before)
      const after = (
        await pool.query('select * from chat_epoch_boxes order by user_id')
      ).rows
      expect(after.map(({ delivery_seq: _, ...row }) => row)).deep.equals(boxes)
      expect(after.map(row => Number(row.delivery_seq))).deep.equals([1, 2])
      expect(
        (
          await pool.query('select requires_approval from chat_history_access')
        ).rows.every(row => row.requires_approval === false)
      ).equals(true)
      // Precision does not pass through the process-wide int8 number parser.
      await pool.query(
        'update chat_conversations set next_box_delivery_seq=$1 where id=$2',
        ['9007199254740993', id]
      )
      const b = boxes[0]
      await pool.query(
        `delete from chat_epoch_boxes where conversation_id=$1 and user_id=$2`,
        [id, b.user_id]
      )
      await pool.query(
        `insert into chat_epoch_boxes(conversation_id,epoch,user_id,identity_id,generation,box)
        values($1,$2,$3,$4,$5,$6)`,
        [id, b.epoch, b.user_id, b.identity_id, b.generation, b.box]
      )
      expect(
        (
          await pool.query(
            'select delivery_seq::text as seq from chat_epoch_boxes where user_id=$1',
            [b.user_id]
          )
        ).rows[0].seq
      ).equals('9007199254740993')
      const first = await pool.connect()
      const second = await pool.connect()
      try {
        await first.query('begin')
        const insert = `insert into chat_epoch_boxes(conversation_id,epoch,user_id,identity_id,generation,box)
          values($1,$2,$3,$4,$5,$6) on conflict do nothing`
        const values = [
          id,
          b.epoch,
          b.user_id,
          b.identity_id,
          b.generation,
          b.box
        ]
        await first.query(insert, values)
        const firstPid = (await first.query('select pg_backend_pid() as pid'))
          .rows[0].pid
        const secondPid = (await second.query('select pg_backend_pid() as pid'))
          .rows[0].pid
        const delayed = second.query(insert, values)
        let blocked = false
        for (let attempt = 0; attempt < 100; attempt++) {
          const row = (
            await pool.query('select $1=any(pg_blocking_pids($2)) as blocked', [
              firstPid,
              secondPid
            ])
          ).rows[0]
          if (row.blocked === true) {
            blocked = true
            break
          }
        }
        expect(
          blocked,
          'later allocation waits for the conversation transaction'
        ).equals(true)
        await first.query('commit')
        await delayed
        expect(
          (
            await pool.query(
              'select next_box_delivery_seq::text as seq from chat_conversations where id=$1',
              [id]
            )
          ).rows[0].seq
        ).equals('9007199254740996')
      } finally {
        await first.query('rollback')
        first.release()
        second.release()
      }
      // Down is safe only before any recovery requests or approvals exist.
      await pool.query(
        `insert into chat_history_requests(conversation_id,user_id,identity_id,generation,
        segment_start_epoch,target_epoch,covered_through_epoch) values($1,$2,$3,$4,1,1,0)`,
        [id, b.user_id, b.identity_id, b.generation]
      )
      let refused = false
      try {
        await pool.query(migration.down)
      } catch (e) {
        refused = String(e).includes('recovery is in use')
      }
      expect(refused).equals(true)
      expect(
        (await pool.query('select count(*)::int as n from chat_epoch_boxes'))
          .rows[0].n
      ).equals(2)
    } finally {
      await pool.end()
      await f.close()
    }
  })
})
