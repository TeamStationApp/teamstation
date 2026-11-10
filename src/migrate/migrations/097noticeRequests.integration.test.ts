import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { mintUserId } from '../../server/users/mintUserId'
import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migration097NoticeRequests } from './097noticeRequests'
import { migrations } from './index'

describe('097 notice requests', function () {
  this.timeout(60000)
  const name = `teamstation_noticerequests_${process.pid}_${Date.now()}`
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
  const request = (id: string, kind: string, status: string): string =>
    `insert into group_requests
       (id, kind, sender_id, sender_scope_type, sender_scope_id, terms, status,
        sent_at, expires_at)
     values ('${id}', '${kind}', '${USER}', 'team', 'tem_home', '{}',
             '${status}', now(), now() + interval '90 days')`
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '090')
    )
    await pool.query(`insert into users (id, display_name) values ('${USER}', 'Mookie Betts');
      insert into teams (id, name) values ('tem_home', 'Hosts'), ('tem_away', 'Visitors');
      insert into games (id, home_team_id, away_team_id, start_at) values ('gam_one', 'tem_home', 'tem_away', now());
      insert into game_guest_details (game_id, user_id, jersey) values ('gam_one', '${USER}', '50');`)
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('takes an applied player add, marks pool guests and records withdrawals, and rolls back only once none is left', async () => {
    expect(
      await failure(request('inv_early', 'playerAdd', 'pending'))
    ).includes('group_requests_kind_check')
    expect(await failure(request('inv_early', 'person', 'applied'))).includes(
      'group_requests_status_check'
    )
    await migrateUp(pool, [migration097NoticeRequests])
    // A guest already stored was not a pool player.
    const kept = await pool.query(`select pool from game_guest_details`)
    expect(kept.rows).deep.equals([{ pool: false }])
    await pool.query(request('inv_one', 'playerAdd', 'applied'))
    // The kinds and statuses before it still hold.
    await pool.query(request('inv_old', 'person', 'pending'))
    await pool.query(`insert into game_withdrawn_players
      (game_id, user_id, side, request_id, label)
      values ('gam_one', '${USER}', 'home', 'inv_one', 'Hosts A')`)
    expect(
      await failure(`insert into game_withdrawn_players
        (game_id, user_id, side, request_id, label)
        values ('gam_one', '${USER}', 'middle', 'inv_one', 'Hosts B')`)
    ).includes('check')

    let refused: unknown
    await migrateDown(pool, [migration097NoticeRequests], 1).catch(
      (error: unknown) => {
        refused = error
      }
    )
    expect(String(refused)).includes('Player additions are recorded')
    await pool.query(`delete from group_requests where kind = 'playerAdd'`)
    // The withdrawal goes with its request.
    expect(
      (await pool.query(`select * from game_withdrawn_players`)).rowCount
    ).equals(0)
    await migrateDown(pool, [migration097NoticeRequests], 1)
    const table = await pool.query(
      `select 1 from information_schema.tables where table_name = 'game_withdrawn_players'`
    )
    expect(table.rowCount).equals(0)
    expect(await failure(request('inv_late', 'playerAdd', 'pending'))).includes(
      'group_requests_kind_check'
    )
  })
})
