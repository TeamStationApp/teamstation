import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migration066GameGuests } from './066gameGuests'
import { migrations } from './index'

describe('066 historical game guests', function () {
  this.timeout(60000)
  const name = `teamstation_guests_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool
  const setup = {
    players: {
      1: { id: 1, userId: null, fullName: 'Babe Ruth' },
      2: { id: 2, userId: null, fullName: 'Willie Mays' },
      3: { id: 3, userId: 123, fullName: 'Hank Aaron' }
    },
    sides: { away: { players: [1, 2] }, home: { players: [3] } },
    identities: {
      sessionToSource: { 1: null, 2: null, 3: 123 },
      sourceToSession: { 'number:123': 3 },
      nextId: 4
    }
  }
  const document = {
    about: { atBatIndex: 0 },
    result: { eventType: 'single' },
    matchup: { batter: { id: 123, fullName: 'Hank Aaron' } },
    credits: [
      {
        eventType: 'single',
        label: 'Single',
        creditUserId: 123,
        credit: { name: 'Hank Aaron' }
      }
    ],
    teamStation: {
      version: 1,
      setupBefore: setup,
      actions: [{ type: 'lineup', kind: 'roster', setup }]
    }
  }
  let children: unknown
  beforeEach(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '066')
    )
    await pool.query(`insert into users (id,"legacyId",display_name) values (123,'usr_AAAAAAAAAAAAAAAA','Hank Aaron');
      insert into teams (id,name) values ('tem_away','Visitors'),('tem_home','Hosts');
      insert into games(id,home_team_id,away_team_id,start_at) values
        ('gam_one','tem_home','tem_away',now()),('gam_two','tem_home','tem_away',now());`)
    await pool.query(
      'insert into events (id,"gameId",gumbo) values ($1,$2,$3)',
      ['evt_one', 'gam_one', document]
    )
    await pool.query('update games set "currentPlay"=$1', [document])
    children = await readChildren()
    await pool.query(
      `insert into games(id,home_team_id,away_team_id,start_at) values ('gam_new','tem_home','tem_away',now())`
    )
  })
  afterEach(async function () {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  async function readChildren(): Promise<unknown> {
    return [
      (await pool.query('select * from "eventCredits" order by id')).rows,
      (await pool.query('select * from event_players order by id')).rows
    ]
  }
  it('mints distinct guests per game, updates every setup, and preserves all scoring rows', async function () {
    await migrateUp(pool, [migration066GameGuests])
    const guests = (
      await pool.query(
        'select * from game_placeholder_guests order by game_id,session_id'
      )
    ).rows
    expect(guests).length(4)
    expect(new Set(guests.map(g => g.user_id)).size).equals(4)
    for (const game of ['gam_one', 'gam_two']) {
      const row = (
        await pool.query('select guests,"currentPlay" from games where id=$1', [
          game
        ])
      ).rows[0]
      const map = guests.filter(g => g.game_id === game)
      expect(row.guests).deep.equals({
        away: map.map(g => Number(g.user_id)),
        home: []
      })
      const record = row.currentPlay.teamStation
      for (const held of [record.setupBefore, record.actions[0].setup]) {
        for (const guest of map) {
          expect(held.identities.sessionToSource[guest.session_id]).equals(
            Number(guest.user_id)
          )
          expect(
            held.identities.sourceToSession['number:' + guest.user_id]
          ).equals(Number(guest.session_id))
          expect(held.players[guest.session_id].userId).equals(
            Number(guest.user_id)
          )
        }
      }
      const users = (
        await pool.query(
          'select display_name,first_name,last_name,login_enabled from users where id=any($1::bigint[]) order by display_name',
          [map.map(g => g.user_id)]
        )
      ).rows
      expect(users).deep.equals([
        {
          display_name: 'Babe Ruth',
          first_name: 'Babe',
          last_name: 'Ruth',
          login_enabled: false
        },
        {
          display_name: 'Willie Mays',
          first_name: 'Willie',
          last_name: 'Mays',
          login_enabled: false
        }
      ])
    }
    expect((await pool.query('select * from memberships')).rows).deep.equals([])
    const { teamStation, ...gumbo } = (
      await pool.query('select gumbo from events')
    ).rows[0].gumbo
    const { teamStation: original, ...originalGumbo } = document
    expect(gumbo).deep.equals(originalGumbo)
    expect(teamStation.setupBefore.players[1].userId).not.equals(null)
    expect(await readChildren()).deep.equals(children)
    expect(
      (await pool.query("select guests from games where id='gam_new'")).rows[0]
        .guests
    ).deep.equals({ away: [], home: [] })
  })
  it('refuses down while preserving guest identities, history, schema and migration state', async function () {
    await migrateUp(pool, [migration066GameGuests])
    const snapshot = async (): Promise<unknown[]> =>
      await Promise.all(
        [
          'users',
          'games',
          'events',
          'game_placeholder_guests',
          'schema_migrations'
        ].map(
          async table =>
            (
              await pool.query(
                `select to_jsonb(t) as row from ${table} t order by to_jsonb(t)::text`
              )
            ).rows
        )
      )
    const before = await snapshot()
    let failure: unknown
    try {
      await migrateDown(pool, [migration066GameGuests], 1)
    } catch (error) {
      failure = error
    }
    expect(String(failure)).contains(
      'Restore the pre-cutover database backup and matching code'
    )
    expect(await snapshot()).deep.equals(before)
    expect(await readChildren()).deep.equals(children)
  })

  for (const evidence of ['retained team', 'another snapshot'] as const) {
    it(`preserves an inactive guest using its ${evidence}`, async function () {
      const removed = structuredClone(document)
      removed.teamStation.setupBefore = structuredClone(setup)
      removed.teamStation.setupBefore.sides.away.players = [2]
      if (evidence === 'retained team') {
        Object.assign(removed.teamStation.setupBefore.players[1], {
          teamId: 'tem_away'
        })
        removed.teamStation.actions = []
      }
      await pool.query('update games set "currentPlay"=$1 where id=$2', [
        removed,
        'gam_new'
      ])
      await migrateUp(pool, [migration066GameGuests])
      const row = (
        await pool.query('select guests,"currentPlay" from games where id=$1', [
          'gam_new'
        ])
      ).rows[0]
      const saved = row.currentPlay.teamStation.setupBefore
      const id = saved.players[1].userId
      expect(row.guests.away).includes(id)
      expect(saved.identities.sessionToSource[1]).equals(id)
      expect(saved.sides.away.players).deep.equals([2])
      expect(saved.players[1].fullName).equals('Babe Ruth')
      expect(await readChildren()).deep.equals(children)
    })
  }

  it('keeps both identities when a historical rename replaced a placeholder', async function () {
    const renamed = structuredClone(document)
    const next = structuredClone(setup)
    Object.assign(next.players, {
      4: {
        id: 4,
        userId: null,
        fullName: 'Jackie Robinson',
        teamId: 'tem_away'
      }
    })
    Object.assign(next.identities.sessionToSource, { 4: null })
    next.identities.nextId = 5
    next.sides.away.players = [4, 2]
    renamed.teamStation.actions[0].setup = next
    await pool.query('update games set "currentPlay"=$1 where id=$2', [
      renamed,
      'gam_new'
    ])
    await migrateUp(pool, [migration066GameGuests])
    const row = (
      await pool.query('select guests,"currentPlay" from games where id=$1', [
        'gam_new'
      ])
    ).rows[0]
    const saved = row.currentPlay.teamStation.actions[0].setup
    expect(row.guests.away).length(3)
    expect(saved.players[1].userId).not.equals(saved.players[4].userId)
    expect(saved.identities.sessionToSource[1]).equals(saved.players[1].userId)
    expect(saved.identities.sessionToSource[4]).equals(saved.players[4].userId)
    expect(saved.sides.away.players).deep.equals([4, 2])
    expect(await readChildren()).deep.equals(children)
  })

  it('rejects conflicting side evidence across snapshots', async function () {
    const conflicting = structuredClone(document)
    conflicting.teamStation.actions[0].setup = structuredClone(setup)
    conflicting.teamStation.actions[0].setup.sides.away.players = [2]
    conflicting.teamStation.actions[0].setup.sides.home.players.push(1)
    await pool.query('update games set "currentPlay"=$1 where id=$2', [
      conflicting,
      'gam_new'
    ])
    let failure: unknown
    try {
      await migrateUp(pool, [migration066GameGuests])
    } catch (error) {
      failure = error
    }
    expect(String(failure)).includes('Historical guest must belong to one side')
    expect(
      (await pool.query('select count(*) from users')).rows[0].count
    ).equals('1')
    expect(await readChildren()).deep.equals(children)
  })

  it('finds a guest described only by an add-player action without changing the action', async function () {
    const initial = structuredClone(setup)
    delete (initial.players as Record<number, unknown>)[1]
    delete (initial.players as Record<number, unknown>)[2]
    initial.sides.away.players = []
    const identities: Record<number, number | null> =
      initial.identities.sessionToSource
    delete identities[1]
    delete identities[2]
    const pending = {
      ...document,
      teamStation: {
        version: 1,
        setupBefore: initial,
        actions: [
          {
            type: 'lineup',
            kind: 'addPlayer',
            side: 'away',
            name: 'Jackie Robinson'
          }
        ]
      }
    }
    await pool.query('update games set "currentPlay"=$1 where id=$2', [
      pending,
      'gam_new'
    ])
    await migrateUp(pool, [migration066GameGuests])
    const row = (
      await pool.query('select guests,"currentPlay" from games where id=$1', [
        'gam_new'
      ])
    ).rows[0]
    expect(row.guests.away).length(1)
    const guest = row.guests.away[0]
    expect(
      row.currentPlay.teamStation.setupBefore.identities.sessionToSource[4]
    ).equals(guest)
    expect(row.currentPlay.teamStation.setupBefore.players).not.have.property(
      '4'
    )
    expect(row.currentPlay.teamStation.actions).deep.equals(
      pending.teamStation.actions
    )
    expect(
      (await pool.query('select display_name from users where id=$1', [guest]))
        .rows[0].display_name
    ).equals('Jackie Robinson')
  })

  it('rolls back the entire migration when a historical guest belongs to two sides', async function () {
    const broken = structuredClone(document)
    broken.teamStation.setupBefore.sides.home.players.push(1)
    await pool.query('update games set "currentPlay"=$1 where id=$2', [
      broken,
      'gam_new'
    ])
    let failure: unknown
    try {
      await migrateUp(pool, [migration066GameGuests])
    } catch (error) {
      failure = error
    }
    expect(String(failure)).contains('Historical guest must belong to one side')
    expect(
      (await pool.query('select id from users')).rows.map(row => Number(row.id))
    ).deep.equals([123])
    expect(
      (
        await pool.query(
          "select to_regclass('game_placeholder_guests') as table_name"
        )
      ).rows[0].table_name
    ).equals(null)
    expect(
      (
        await pool.query(
          "select column_name from information_schema.columns where table_name='games' and column_name='guests'"
        )
      ).rows
    ).deep.equals([])
    expect(
      (await pool.query('select gumbo from events')).rows[0].gumbo
    ).deep.equals(document)
    expect(await readChildren()).deep.equals(children)
  })
})
