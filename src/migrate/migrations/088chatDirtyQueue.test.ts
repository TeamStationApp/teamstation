import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrateDown, migrateUp } from '../runner'
import { dropScratchDatabase, testDatabaseUrl } from '../testDatabase'
import { migration088ChatDirtyQueue } from './088chatDirtyQueue'
import { migrations } from './index'

/**
 * 088: a chat mark is an append that never waits on another transaction,
 * and the queue keeps every mark until a drain takes it.
 */
describe('088 the chat dirty queue', function () {
  this.timeout(60000)
  const name = `teamstation_chat_dirty_queue_${process.pid}_${Date.now()}`
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  const through = migrations.filter(
    migration => migration.name <= migration088ChatDirtyQueue.name
  )
  let admin: Pool
  let pool: Pool
  const marks = async (): Promise<string[]> =>
    (
      await pool.query<{ mark: string }>(
        `select scope_type || ':' || scope_id as mark from chat_dirty
          order by mark`
      )
    ).rows.map(row => row.mark)

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({ connectionString: url })
    await migrateUp(pool, through)
    await pool.query('delete from chat_dirty')
  })
  after(async function () {
    await pool?.end()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
  })

  it('appends every mark, the same scope as often as it is marked', async function () {
    await pool.query(`select chat_mark_dirty('user', 'usr_a')`)
    await pool.query(`select chat_mark_dirty('user', 'usr_a')`)
    await pool.query(`select chat_mark_dirty('team', 'tem_a')`)
    await pool.query(`select chat_mark_dirty('user', null)`)
    expect(await marks()).deep.equals([
      'team:tem_a',
      'user:usr_a',
      'user:usr_a'
    ])
    await pool.query('delete from chat_dirty')
  })

  it('never waits on another transaction’s mark of the same scope, nor a drain on it', async function () {
    const first = await pool.connect()
    const second = await pool.connect()
    try {
      await first.query('begin')
      await first.query(`select chat_mark_dirty('user', 'usr_b')`)
      // Any wait for the first transaction fails here instead of hanging.
      await second.query(`set lock_timeout = '2s'`)
      await second.query('begin')
      await second.query(`select chat_mark_dirty('user', 'usr_b')`)
      await second.query('commit')
      const drained = await second.query<{ id: string }>(
        `delete from chat_dirty returning scope_id as id`
      )
      expect(drained.rows.map(row => row.id)).deep.equals(['usr_b'])
      await first.query('commit')
      // The mark made while the drain ran is kept for the next one.
      expect(await marks()).deep.equals(['user:usr_b'])
    } finally {
      await first.query('rollback').catch(() => undefined)
      first.release()
      second.release()
    }
    await pool.query('delete from chat_dirty')
  })

  it('coalesces the queue to one mark per scope on the way down, and appends again on the way up', async function () {
    await pool.query(
      `insert into chat_dirty (scope_type, scope_id, marked_at) values
        ('user', 'usr_c', now() - interval '2 minutes'),
        ('user', 'usr_c', now() - interval '1 minute'),
        ('team', 'tem_c', now())`
    )
    expect(await migrateDown(pool, through, 1)).deep.equals([
      migration088ChatDirtyQueue.name
    ])
    expect(await marks()).deep.equals(['team:tem_c', 'user:usr_c'])
    await pool.query(`select chat_mark_dirty('user', 'usr_c')`)
    expect(await marks()).deep.equals(['team:tem_c', 'user:usr_c'])
    expect((await migrateUp(pool, through)).applied).deep.equals([
      migration088ChatDirtyQueue.name
    ])
    await pool.query(`select chat_mark_dirty('user', 'usr_c')`)
    expect(await marks()).deep.equals([
      'team:tem_c',
      'user:usr_c',
      'user:usr_c'
    ])
  })
})
