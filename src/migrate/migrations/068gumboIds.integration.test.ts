import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { attachInt8Parser } from '../../server/db/int8'
import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migration068GumboIds } from './068gumboIds'
import { migrations } from './index'

describe('068 independent scoring identities', function () {
  this.timeout(60000)
  const name = `teamstation_gumbo_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool
  before(async () => {
    attachInt8Parser()
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '068')
    )
    await pool.query(`insert into users(id,"legacyId",display_name) values
      (11,'usr_AAAAAAAAAAAAAAAA','Hank Aaron'),(12,'usr_BBBBBBBBBBBBBBBB','Babe Ruth');
      insert into teams(id,name,default_lineup) values
      ('tem_home','Hosts','{"batters":[{"userId":11,"name":"Aaron","jersey":"1"}],"defense":{"P":{"userId":11,"name":"Aaron","jersey":"1"},"C":null}}'),
      ('tem_away','Visitors','{"gameId":"gam_previous","takenAt":"2026-01-01","lineup":{"batters":[{"userId":12,"name":"Ruth","jersey":"2"}],"defense":{}}}');
      insert into games(id,home_team_id,away_team_id,start_at) values('gam_one','tem_home','tem_away',now());
      insert into events(id,"gameId",gumbo) values('evt_one','gam_one',
        '{"about":{"atBatIndex":0},"matchup":{"batter":{"id":11}},"credits":[{"creditUserId":12,"eventType":"field_out","credit":{"name":"Ruth"}}]}');
      insert into game_player_stats(id,game_id,user_id,team_id) values('gps_one','gam_one',11,'tem_home');`)
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  const refused = async (
    run: () => Promise<unknown>,
    message: string
  ): Promise<void> => {
    let error: unknown
    try {
      await run()
    } catch (caught) {
      error = caught
    }
    expect(String(error)).includes(message)
  }
  it('rejects zero before creating mappings or renaming columns', async () => {
    await pool.query(
      `insert into users(id,"legacyId",display_name) values(0,'usr_CCCCCCCCCCCCCCCC','Mookie Betts')`
    )
    await refused(
      async () => await migrateUp(pool, [migration068GumboIds]),
      'Invalid user ids (1): {0}'
    )
    expect(
      (await pool.query("select to_regclass('gumbo_ids') as name")).rows[0].name
    ).equals(null)
    expect(
      (await pool.query('select user_id from game_player_stats')).rows[0]
        .user_id
    ).equals(11)
    await pool.query('delete from users where id=0')
  })
  it('refuses broken references even when their foreign key was left unvalidated', async () => {
    await pool.query(`alter table event_players drop constraint event_players_user_id_fkey;
      update event_players set user_id=999;
      alter table event_players add constraint event_players_user_id_fkey foreign key(user_id) references users(id) on delete cascade not valid;`)
    await refused(
      async () => await migrateUp(pool, [migration068GumboIds]),
      'Broken user references in event_players.user_id (1): {999}'
    )
    expect(
      (await pool.query("select to_regclass('gumbo_ids') as name")).rows[0].name
    ).equals(null)
    await pool.query(
      'update event_players set user_id=11; alter table event_players validate constraint event_players_user_id_fkey'
    )
  })
  it('preserves every numeric identity and play, moves foreign keys, and renames only lineup identity keys', async () => {
    const before = (await pool.query('select gumbo::text from events')).rows
    await migrateUp(pool, [migration068GumboIds])
    expect(
      (
        await pool.query(
          'select gumbo_id,user_id from gumbo_ids order by gumbo_id'
        )
      ).rows
    ).deep.equals([
      { gumbo_id: 11, user_id: 11 },
      { gumbo_id: 12, user_id: 12 }
    ])
    expect(
      (await pool.query('select gumbo::text from events')).rows
    ).deep.equals(before)
    expect(
      (await pool.query('select gumbo_id from game_player_stats')).rows[0]
        .gumbo_id
    ).equals(11)
    const fks = (
      await pool.query(
        `select conrelid::regclass::text as relation,confdeltype from pg_constraint where confrelid='gumbo_ids'::regclass order by relation`
      )
    ).rows
    expect(fks).deep.equals([
      { relation: '"eventCredits"', confdeltype: 'a' },
      { relation: 'event_players', confdeltype: 'c' },
      { relation: 'game_player_stats', confdeltype: 'c' }
    ])
    expect(
      (await pool.query("select default_lineup from teams where id='tem_home'"))
        .rows[0].default_lineup
    ).deep.equals({
      batters: [{ gumboId: 11, name: 'Aaron', jersey: '1' }],
      defense: { P: { gumboId: 11, name: 'Aaron', jersey: '1' }, C: null }
    })
    expect(
      (await pool.query("select default_lineup from teams where id='tem_away'"))
        .rows[0].default_lineup
    ).deep.equals({
      gameId: 'gam_previous',
      takenAt: '2026-01-01',
      lineup: {
        batters: [{ gumboId: 12, name: 'Ruth', jersey: '2' }],
        defense: {}
      }
    })
    await pool.query('update events set gumbo=gumbo')
    expect(
      (await pool.query('select gumbo_id from event_players')).rows[0].gumbo_id
    ).equals(11)
    expect(
      (await pool.query('select "creditGumboId" from "eventCredits"')).rows[0]
        .creditGumboId
    ).equals(12)
    await refused(
      async () =>
        await pool.query(
          'insert into gumbo_ids(gumbo_id,user_id) values(11,12)'
        ),
      'duplicate key'
    )
    await refused(
      async () =>
        await pool.query(
          'insert into gumbo_ids(gumbo_id,user_id) values(13,11)'
        ),
      'duplicate key'
    )
    await refused(
      async () =>
        await pool.query('update gumbo_ids set gumbo_id=0 where user_id=11'),
      'check constraint'
    )
    await refused(
      async () => await pool.query('update game_player_stats set gumbo_id=999'),
      'foreign key constraint'
    )
  })
  it('gives new numeric users a mapping until selective allocation and refuses down without changes', async () => {
    await pool.query(
      `insert into users(id,"legacyId",display_name) values(13,'usr_DDDDDDDDDDDDDDDD','Mookie Betts')`
    )
    expect(
      (await pool.query('select gumbo_id from gumbo_ids where user_id=13'))
        .rows[0].gumbo_id
    ).equals(13)
    await refused(
      async () => await migrateDown(pool, [migration068GumboIds]),
      'Restore the pre-cutover database backup'
    )
    expect(
      (await pool.query('select count(*)::int as count from gumbo_ids')).rows[0]
        .count
    ).equals(3)
  })
})
