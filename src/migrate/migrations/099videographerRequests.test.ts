import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { mintUserId } from '../../server/users/mintUserId'
import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migration099VideographerRequests } from './099videographerRequests'
import { migrations } from './index'

describe('099 videographer requests', function () {
  this.timeout(60000)
  const name = `teamstation_videographerrequests_${process.pid}_${Date.now()}`
  const USER = mintUserId()
  let admin: Pool
  let pool: Pool
  const failure = async (statement: string): Promise<string> => {
    let caught: unknown
    await pool.query(statement).catch((error: unknown) => {
      caught = error
    })
    expect(caught, statement).not.equals(undefined)
    return String(caught)
  }
  const request = (id: string, kind: string): string =>
    `insert into group_requests
       (id, kind, sender_id, sender_scope_type, sender_scope_id, terms, status,
        sent_at, expires_at)
     values ('${id}', '${kind}', '${USER}', null, null, '{}', 'pending', now(),
             now() + interval '7 days')`
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '099')
    )
    await pool.query(
      `insert into users (id, display_name) values ('${USER}', 'Mookie Betts')`
    )
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('takes a request with no sending group, and rolls back only once none is left', async () => {
    expect(await failure(request('inv_early', 'videographer'))).includes(
      'group_requests_kind_check'
    )
    await migrateUp(pool, [migration099VideographerRequests])
    await pool.query(request('inv_one', 'videographer'))
    // The other kinds still hold: a membership needs no group, a person does.
    await pool.query(request('inv_two', 'membership'))
    expect(await failure(request('inv_three', 'person'))).includes(
      'group_requests_sender_scope_check'
    )

    let refused: unknown
    await migrateDown(pool, [migration099VideographerRequests], 1).catch(
      (error: unknown) => {
        refused = error
      }
    )
    expect(String(refused)).includes('Videographer requests are recorded')
    expect(
      (await pool.query(`select id from group_requests where id = 'inv_one'`))
        .rowCount
    ).equals(1)

    await pool.query(`delete from group_requests where kind = 'videographer'`)
    await migrateDown(pool, [migration099VideographerRequests], 1)
    expect(await failure(request('inv_late', 'videographer'))).includes(
      'group_requests_kind_check'
    )
    await pool.query(request('inv_four', 'membership'))
  })
})
