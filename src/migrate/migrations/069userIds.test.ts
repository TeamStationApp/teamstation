import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { asUserId, userIdOfGumbo, userIdOfValue } from '../../common/userId'
import vectors from '../../common/userId.vectors.json'
import { attachInt8Parser } from '../../server/db/int8'
import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migration069UserIds } from './069userIds'
import { migrations } from './index'

describe('069 canonical account identities', function () {
  this.timeout(60000)
  const name = `teamstation_textids_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool
  let historical: unknown
  const one = userIdOfGumbo(11)
  const two = userIdOfGumbo(12)
  const fails = async (run: Promise<unknown>, text: string): Promise<void> => {
    let failure: unknown
    try {
      await run
    } catch (error) {
      failure = error
    }
    expect(String(failure)).includes(text)
  }
  before(async () => {
    attachInt8Parser()
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '069')
    )
    await pool.query(`insert into users(id,"legacyId",display_name) values
      (11,'usr_AAAAAAAAAAAAAAAA','Hank Aaron'),(12,'usr_BBBBBBBBBBBBBBBB','Babe Ruth');
      update users set merged_into=12 where id=11;
      insert into teams(id,name) values('tem_home','Hosts'),('tem_away','Visitors');
      insert into memberships(id,user_id,team_id,is_player) values('mem_one',11,'tem_home',true);
      insert into user_links(id,user_id,related_user_id,kind) values('lnk_one',11,12,'guardian');
      insert into external_ids(id,entity_type,entity_id,system,kind,external_id) values
      ('ext_one','user','11','external','user','one'),
      ('ext_two','user','usr_BBBBBBBBBBBBBBBB','external','user','two'),
      ('ext_three','user','unmatched','external','user','three');
      insert into group_requests(id,kind,sender_id,sender_scope_type,sender_scope_id,terms,expires_at)
      values('grq_one','guardian',11,'team','tem_home','{"userId":11,"recipientUserId":12,"playerUserId":11,"guardian":{"userId":12,"age":40},"hostingAuthorizerUserId":11,"count":11}',now()+interval '1 day');
      insert into group_request_sides(request_id,scope_type,scope_id) values('grq_one','user','11'),('grq_one','user','email:demo@example.test');
      insert into notification_events(id,source_type,source_id,revision,actor_id,recorded_recipients)
      values('ntf_one','groupRequest','grq_one',1,11,array[11,12]);
      insert into audit_log(id,method,path,entity_type,entity_id,before,after) values('aud_one','POST','/users/11','user','11','{"userId":11}','{"userId":12}');
      insert into games(id,home_team_id,away_team_id,start_at) values('gam_one','tem_home','tem_away',now());
      insert into events(id,"gameId",gumbo) values('evt_one','gam_one','{"about":{"atBatIndex":0},"matchup":{"batter":{"id":11}},"credits":[{"creditUserId":12,"eventType":"field_out","credit":{"name":"Babe Ruth"}}]}');`)
    historical = await preserved()
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  const preserved = async (): Promise<unknown> => ({
    audit: (await pool.query('select * from audit_log order by id')).rows,
    plays: (await pool.query('select gumbo::text from events order by id'))
      .rows,
    credits: (await pool.query('select * from "eventCredits" order by id')).rows
  })
  it('rolls back a failure after column conversion and before allocation is installed', async () => {
    await fails(
      migrateUp(pool, [
        {
          ...migration069UserIds,
          up: migration069UserIds.up.replace(
            'create function ts_ensure_gumbo_id',
            "do $fail$ begin raise exception 'Injected conversion failure'; end $fail$; create function ts_ensure_gumbo_id"
          )
        }
      ]),
      'Injected conversion failure'
    )
    expect(
      (await pool.query('select id from users order by id')).rows
    ).deep.equals([{ id: 11 }, { id: 12 }])
    expect(await preserved()).deep.equals(historical)
    expect(
      (
        await pool.query(
          "select to_regprocedure('ts_is_user_id(text)') as name"
        )
      ).rows[0].name
    ).equals(null)
  })
  it('converts every user foreign key and specified holder while preserving scoring and audit history', async () => {
    await migrateUp(pool, [migration069UserIds])
    expect(
      (
        await pool.query(
          'select id,merged_into,"legacyId" from users order by id'
        )
      ).rows
    ).deep.equals([
      { id: one, merged_into: two, legacyId: 'usr_AAAAAAAAAAAAAAAA' },
      { id: two, merged_into: null, legacyId: 'usr_BBBBBBBBBBBBBBBB' }
    ])
    expect(
      (
        await pool.query(
          'select gumbo_id,user_id from gumbo_ids order by gumbo_id'
        )
      ).rows
    ).deep.equals([
      { gumbo_id: 11, user_id: one },
      { gumbo_id: 12, user_id: two }
    ])
    expect(
      (await pool.query('select user_id,related_user_id from user_links'))
        .rows[0]
    ).deep.equals({ user_id: one, related_user_id: two })
    expect(
      (await pool.query('select user_id from memberships')).rows[0].user_id
    ).equals(one)
    expect(
      (
        await pool.query('select entity_id from external_ids order by id')
      ).rows.map(row => row.entity_id)
    ).deep.equals([one, 'unmatched', two])
    expect(
      (
        await pool.query(
          'select scope_id from group_request_sides order by scope_id'
        )
      ).rows.map(row => row.scope_id)
    ).deep.equals(['email:demo@example.test', one])
    expect(
      (await pool.query('select terms from group_requests')).rows[0].terms
    ).deep.equals({
      userId: one,
      recipientUserId: two,
      playerUserId: one,
      guardian: { userId: two, age: 40 },
      hostingAuthorizerUserId: one,
      count: 11
    })
    expect(
      (await pool.query('select recorded_recipients from notification_events'))
        .rows[0].recorded_recipients
    ).deep.equals([one, two])
    const refs = (
      await pool.query(
        `select a.atttypid::regtype::text as type from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey) where c.contype='f' and c.confrelid='users'::regclass`
      )
    ).rows
    expect(refs.length).greaterThan(20)
    expect(refs.every(row => row.type === 'text')).equals(true)
    expect(await preserved()).deep.equals(historical)
    await fails(
      pool.query('update user_links set related_user_id=user_id'),
      'user_links_not_self'
    )
    await fails(
      migrateDown(pool, [migration069UserIds]),
      'Restore the pre-cutover'
    )
    expect(await preserved()).deep.equals(historical)
  })
  it('agrees with the shared validation corpus on SQL inserts, updates and derivation', async () => {
    for (const { userId, value } of vectors.accepted) {
      expect(asUserId(userId)).equals(userId)
      expect(
        (await pool.query('select ts_is_user_id($1) as valid', [userId]))
          .rows[0].valid,
        userId
      ).equals(true)
      await pool.query(
        "insert into users(id,display_name) values($1,'Mookie Betts')",
        [userId]
      )
      if (BigInt(value) < 2n ** 53n)
        expect(
          (await pool.query('select ts_user_id_of_gumbo($1) as id', [value]))
            .rows[0].id
        ).equals(userId)
    }
    for (const userId of [...vectors.rejected, null]) {
      expect(
        (await pool.query('select ts_is_user_id($1) as valid', [userId]))
          .rows[0].valid
      ).equals(false)
      await fails(
        pool.query(
          "insert into users(id,display_name) values($1,'Mookie Betts')",
          [userId]
        ),
        userId == null ? 'not-null' : 'users_id_format'
      )
      await fails(
        pool.query('update users set id=$1 where id=$2', [userId, one]),
        userId == null ? 'not-null' : 'users_id_format'
      )
    }
    for (const value of [null, '0', '-1', '9007199254740992'])
      await fails(
        pool.query('select ts_user_id_of_gumbo($1)', [value]),
        'positive safe-integer'
      )
    await fails(
      pool.query(
        "insert into users(id,display_name) values($1,'Mookie Betts')",
        [one]
      ),
      'users_pkey'
    )
    const cases = ['usr_111111111111111111111A', 'usr_111111111111111111111a']
    for (const id of cases) {
      expect(asUserId(id)).equals(id)
      await pool.query(
        "insert into users(id,display_name) values($1,'Hank Aaron')",
        [id]
      )
    }
    expect(
      (
        await pool.query('select id from users where id=any($1::text[])', [
          cases
        ])
      ).rows
    ).length(2)
  })
  it('allocates on insert, retries collisions and invalid draws, and preserves existing mappings', async () => {
    const user = vectors.accepted.find(
      row => row.value === '9007199254740992'
    )!.userId
    expect(
      (
        await pool.query(
          'select ts_ensure_gumbo_id($1,array[11,0,42]::bigint[]) as id',
          [user]
        )
      ).rows[0].id
    ).equals(42)
    expect(
      (
        await pool.query(
          'select ts_ensure_gumbo_id($1,array[]::bigint[]) as id',
          [user]
        )
      ).rows[0].id
    ).equals(42)
    const other = vectors.accepted.at(-1)!.userId
    await fails(
      pool.query(
        'select ts_ensure_gumbo_id($1,array[11,12,0,-1,42]::bigint[])',
        [other]
      ),
      'Five scoring identity allocations exhausted'
    )
    expect(
      (await pool.query('select * from gumbo_ids where user_id=$1', [other]))
        .rows
    ).length(0)
    await fails(
      pool.query('select ts_ensure_gumbo_id($1,array[55]::bigint[])', [
        userIdOfGumbo(999)
      ]),
      'Unknown user identity'
    )
    const random = (
      await pool.query('select ts_ensure_gumbo_id($1) as id', [other])
    ).rows[0].id
    expect(Number.isSafeInteger(random) && random > 0).equals(true)
  })
  it('serializes two callers for one user and retries two users sharing a candidate', async () => {
    const ids = [1n, 2n, 3n].map(n => userIdOfValue((1n << 80n) + n))
    for (const id of ids)
      await pool.query(
        "insert into users(id,display_name) values($1,'Mookie Betts')",
        [id]
      )
    const a = await pool.connect()
    const b = await pool.connect()
    const aPid = (await a.query('select pg_backend_pid() as pid')).rows[0].pid
    const bPid = (await b.query('select pg_backend_pid() as pid')).rows[0].pid
    const waitForLock = async (): Promise<void> => {
      const deadline = Date.now() + 5000
      while (true) {
        const blockers = (
          await pool.query<{ ids: number[] }>(
            'select pg_blocking_pids($1) as ids',
            [bPid]
          )
        ).rows[0].ids
        if (blockers.includes(aPid)) return
        if (Date.now() > deadline)
          throw new Error('The second allocator did not reach the lock barrier')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    try {
      await a.query('begin')
      expect(
        (
          await a.query(
            'select ts_ensure_gumbo_id($1,array[501]::bigint[]) as id',
            [ids[0]]
          )
        ).rows[0].id
      ).equals(501)
      const same = b.query(
        'select ts_ensure_gumbo_id($1,array[502]::bigint[]) as id',
        [ids[0]]
      )
      await waitForLock()
      await a.query('commit')
      expect((await same).rows[0].id).equals(501)
      await a.query('begin')
      expect(
        (
          await a.query(
            'select ts_ensure_gumbo_id($1,array[503]::bigint[]) as id',
            [ids[1]]
          )
        ).rows[0].id
      ).equals(503)
      const competing = b.query(
        'select ts_ensure_gumbo_id($1,array[503,504]::bigint[]) as id',
        [ids[2]]
      )
      await waitForLock()
      await a.query('commit')
      expect((await competing).rows[0].id).equals(504)
    } finally {
      await a.query('rollback')
      a.release()
      b.release()
    }
    const reconnected = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    try {
      expect(
        (
          await reconnected.query(
            'select user_id,gumbo_id from gumbo_ids where user_id=any($1::text[]) order by user_id',
            [ids]
          )
        ).rows
      ).deep.equals(
        ids.map((userId, i) => ({
          user_id: userId,
          gumbo_id: [501, 503, 504][i]
        }))
      )
    } finally {
      await reconnected.end()
    }
  })
  it('propagates unrelated insert failures and rolls back the enclosing account creation', async () => {
    const id = userIdOfValue((1n << 90n) + 1n)
    await pool.query(
      'alter table gumbo_ids add constraint fixture_forbidden check(gumbo_id<>601)'
    )
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(
        "insert into users(id,display_name) values($1,'Mookie Betts')",
        [id]
      )
      await fails(
        client.query('select ts_ensure_gumbo_id($1,array[601,602]::bigint[])', [
          id
        ]),
        'fixture_forbidden'
      )
      await client.query('rollback')
      expect(
        (await pool.query('select id from users where id=$1', [id])).rows
      ).length(0)
    } finally {
      await client.query('rollback')
      client.release()
    }
    await pool.query('alter table gumbo_ids drop constraint fixture_forbidden')
  })
})
