import { expect } from 'chai'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { holdingEventChildren, rebuildEventChildren } from './eventChildren'

const scratchName = `teamstation_eventchildren_${process.pid}_${Date.now()}`

const credit = (over: Record<string, unknown> = {}): object => ({
  eventType: 'single',
  teamId: 'tem_home',
  head: 'Single',
  credit: { role: 'batter', position: 'LF' },
  creditUserId: 1,
  ...over
})

/** Every kind of record the trigger distinguishes, as `battingTeamId, gumbo`. */
const SHAPES: Array<[string, string | null, unknown]> = [
  ['nothing it reads', 'tem_home', { other: true }],
  [
    'a plain play, the home team batting',
    'tem_home',
    { matchup: { batter: { id: 1 }, pitcher: { id: 2 } } }
  ],
  [
    'the away team batting',
    'tem_away',
    { matchup: { batter: { id: 1 }, pitcher: { id: 2 } } }
  ],
  [
    'a team in neither side',
    'tem_other',
    { matchup: { batter: { id: 1 }, pitcher: { id: 2 } } }
  ],
  [
    'no batting team',
    null,
    { matchup: { batter: { id: 1 }, pitcher: { id: 2 } } }
  ],
  [
    'ids that are not whole numbers',
    'tem_home',
    { matchup: { batter: { id: 1.5 }, pitcher: { id: 'x' } } }
  ],
  ['a negative id', 'tem_home', { matchup: { batter: { id: -1 } } }],
  [
    'runners, one repeated, one the batter, some with no id',
    'tem_home',
    {
      matchup: { batter: { id: 1 }, pitcher: { id: 2 } },
      runners: [
        { details: { runner: { id: 3 } } },
        { details: { runner: { id: 3 } } },
        { details: { runner: { id: 1 } } },
        { details: { runner: { id: 'x' } } },
        { details: {} },
        7
      ]
    }
  ],
  ['runners that are no list', 'tem_home', { runners: { not: 'a list' } }],
  [
    'runners alone',
    'tem_away',
    { runners: [{ details: { runner: { id: 2 } } }] }
  ],
  ['only pitches', 'tem_home', { playEvents: [] }],
  ['credits that are no list', 'tem_home', { credits: { a: 1 } }],
  ['an empty credits list', 'tem_home', { credits: [] }],
  [
    'credits repeated, odd and full',
    'tem_home',
    {
      credits: [
        credit(),
        credit(),
        credit({ creditUserId: 'typed', credit: { name: 'A Typed Name' } }),
        credit({ creditUserId: null, credit: { name: '' } }),
        credit({ positionShown: false, suffix: 'x', assistWord: 'assist' }),
        credit({
          assists: [
            { creditUserId: 2, position: 'SS' },
            { creditUserId: 'y', name: 'Named', position: 4 },
            'not an object',
            { name: 5 }
          ]
        }),
        credit({ assists: 'no list' }),
        {},
        3
      ]
    }
  ]
]

describe('rebuilding event children in a set', function () {
  this.timeout(60000)
  let admin: Pool
  let pool: Pool
  let db: Kysely<Database>
  const gameId = makeId('game')
  const events = SHAPES.map((_, index) => `evt_shape${index}`)

  /** An event's children as what they say, its ids left out. */
  const children = async (): Promise<unknown> => ({
    players: (
      await sql`
        select event_id, gumbo_id::text, team_id, role, position
        from event_players order by 1, 2, 4
      `.execute(db)
    ).rows,
    credits: (
      await sql`
        select to_jsonb(c) - 'id' as row from "eventCredits" c
        order by "eventId", (to_jsonb(c) - 'id')::text
      `.execute(db)
    ).rows
  })

  const write = async (index: number): Promise<void> => {
    const [, batting, gumbo] = SHAPES[index]
    await sql`
      insert into events (id, "gameId", "battingTeamId", gumbo)
      values (${events[index]}, ${gameId}, ${batting}, ${JSON.stringify({ ...(gumbo as object), about: { atBatIndex: index } })}::jsonb)
    `.execute(db)
  }

  before(async () => {
    attachInt8Parser()
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${scratchName}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${scratchName}`)
    })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    for (const team of ['tem_home', 'tem_away', 'tem_other'])
      await sql`insert into teams (id, name) values (${team}, ${team})`.execute(
        db
      )
    for (const id of [1, 2, 3]) {
      const userId = userIdOfGumbo(id)
      await sql`insert into users (id, display_name, first_name, last_name)
        values (${userId}, 'A Player', 'A', 'Player')`.execute(db)
      await sql`insert into gumbo_ids (gumbo_id, user_id)
        values (${id}, ${userId})`.execute(db)
    }
    await sql`
      insert into games (id, home_team_id, away_team_id, start_at)
      values (${gameId}, 'tem_home', 'tem_away', now())
    `.execute(db)
    for (let index = 0; index < SHAPES.length; index++) await write(index)
  })

  after(async () => {
    await db?.destroy()
    await admin?.query(`drop database if exists ${scratchName}`)
    await admin?.end()
  })

  const rebuildInTransaction = async (): Promise<void> => {
    await db.transaction().execute(async trx => {
      await rebuildEventChildren(trx, events)
    })
  }

  it('fills empty children as the trigger did, shape by shape', async () => {
    const fired = await children()
    expect(JSON.stringify(fired)).includes('A Typed Name')
    await sql`delete from event_players`.execute(db)
    await sql`delete from "eventCredits"`.execute(db)
    await rebuildInTransaction()
    expect(await children()).deep.equals(fired)
  })

  it('writes no row that already reads right, and keeps its id', async () => {
    const ids = async (): Promise<unknown> =>
      (
        await sql`select id from event_players union all select id from "eventCredits" order by 1`.execute(
          db
        )
      ).rows
    const held = await ids()
    await rebuildInTransaction()
    expect(await ids()).deep.equals(held)
  })

  it('reads the pitcher from the game as it now stands', async () => {
    const fired = await children()
    await sql`update games set home_team_id = 'tem_other' where id = ${gameId}`.execute(
      db
    )
    await rebuildInTransaction()
    const rebuilt = await children()
    await sql`update events set "battingTeamId" = "battingTeamId"`.execute(db)
    expect(rebuilt).deep.equals(await children())
    expect(rebuilt).not.deep.equals(fired)
    await sql`update games set home_team_id = 'tem_home' where id = ${gameId}`.execute(
      db
    )
    await sql`update events set "battingTeamId" = "battingTeamId"`.execute(db)
  })

  it('puts right children out of step with their record, and leaves other roles', async () => {
    const fired = await children()
    await sql`
      insert into event_players (id, event_id, gumbo_id, team_id, role) values
        ('evp_scorer', 'evt_shape1', 3, 'tem_home', 'scorer'),
        ('evp_extra', 'evt_shape1', 3, 'tem_home', 'runner'),
        ('evp_noted', 'evt_shape0', 3, 'tem_home', 'batter')
    `.execute(db)
    await sql`update event_players set position = 'LF', team_id = 'tem_other'
      where event_id = 'evt_shape2' and role = 'batter'`.execute(db)
    await sql`delete from event_players where event_id = 'evt_shape3' and role = 'pitcher'`.execute(
      db
    )
    await sql`update "eventCredits" set head = 'stale' where "eventId" = ${events[13]} and head = 'Single' and "creditGumboId" = 1 and suffix = 'x'`.execute(
      db
    )
    await sql`insert into "eventCredits" (id, "eventId", "eventType", head) values ('evc_stray', 'evt_shape0', '', '')`.execute(
      db
    )
    await rebuildInTransaction()
    const after = (await children()) as {
      players: Array<{ event_id: string; role: string }>
      credits: unknown[]
    }
    // A record reading none of these has no say over its own row; the rest
    // come back, and a role the trigger does not write stays.
    const expected = fired as typeof after
    const extras = (row: { event_id: string; role: string }): boolean =>
      (row.event_id === 'evt_shape1' && row.role === 'scorer') ||
      (row.event_id === 'evt_shape0' && row.role === 'batter')
    expect(after.players.filter(row => !extras(row))).deep.equals(
      expected.players
    )
    expect(after.players.filter(extras)).length(2)
    expect(after.credits).deep.equals(expected.credits)
    await sql`delete from event_players where id in ('evp_scorer', 'evp_noted')`.execute(
      db
    )
  })

  it('does nothing for no events', async () => {
    const queries: string[] = []
    const counting = db.withPlugin({
      transformQuery: args => {
        queries.push(args.queryId.queryId)
        return args.node
      },
      transformResult: async args => args.result
    })
    await rebuildEventChildren(counting, [])
    expect(queries).deep.equals([])
  })

  it('holds the trigger back only for its work, and only in a transaction', async () => {
    let caught: unknown
    try {
      await holdingEventChildren(db, async () => undefined)
    } catch (error) {
      caught = error
    }
    expect(String(caught)).includes('lasts for a transaction')

    await sql`update event_players set team_id = 'tem_other' where event_id = 'evt_shape2'`.execute(
      db
    )
    await db.transaction().execute(async trx => {
      await holdingEventChildren(trx, async () => {
        await sql`update events set "battingTeamId" = "battingTeamId" where id = 'evt_shape2'`.execute(
          trx
        )
      })
      const held = await sql<{ team_id: string }>`
        select team_id from event_players where event_id = 'evt_shape2' and role = 'batter'
      `.execute(trx)
      expect(held.rows[0].team_id).equals('tem_other')
      await sql`update events set "battingTeamId" = "battingTeamId" where id = 'evt_shape2'`.execute(
        trx
      )
      const fired = await sql<{ team_id: string }>`
        select team_id from event_players where event_id = 'evt_shape2' and role = 'batter'
      `.execute(trx)
      expect(fired.rows[0].team_id).equals('tem_away')
    })
  })
})
