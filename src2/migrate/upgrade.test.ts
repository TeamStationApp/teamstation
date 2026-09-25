import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { mintUserId } from '../common/mintUserId'
import { migrations } from './migrations'
import { migration037GameStatsState } from './migrations/037gameStatsState'
import { migration038CurrentPlay } from './migrations/038currentPlay'
import { migrateDown, migrateUp } from './runner'
import { testDatabaseUrl } from './testDatabase'

/**
 * The scoring migrations run over a database that already holds plays.
 *
 * `runner.test.ts` applies every migration to an empty database, where none
 * of the conversion SQL in 031 to 033 touches a single row. Here 001 to 030
 * build the schema as it was, rows are written in that shape — string user
 * ids, credits JSON, a sentence per play — and the rest are applied over
 * them. Then everything is rolled back to 030, and the
 * down path is held to what it says it restores.
 */
const adminUrl = testDatabaseUrl
const scratchName = `gamestation_upgrade_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const before031 = migrations.filter(migration => migration.name < '031')
const from031 = migrations.filter(migration => migration.name >= '031')

const ada = mintUserId(() => false)
const bea = mintUserId(id => id === ada.userId)
const cy = mintUserId(id => id === ada.userId || id === bea.userId)

const PLAYED = '2026-05-02T18:30:00.000Z'

describe('the scoring migrations over existing plays', function () {
  this.timeout(60000)

  let admin: Pool
  let pool: Pool

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`create database ${scratchName}`)
    pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, before031)
    await seed(pool)
  })

  after(async function () {
    if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  it('applies over the old rows', async function () {
    const result = await migrateUp(pool, migrations)
    expect(result.applied).deep.equals(from031.map(item => item.name))
  })

  it('turns each user id into its leading 53 bits and keeps the string', async function () {
    const { rows } = await pool.query<{ id: string; legacyId: string }>(
      'select id::text, "legacyId" from users'
    )
    const byLegacy = (
      a: { legacyId: string },
      b: { legacyId: string }
    ): number => (a.legacyId < b.legacyId ? -1 : 1)
    expect(rows.sort(byLegacy)).deep.equals(
      [ada, bea, cy]
        .map(made => ({ id: String(made.userId), legacyId: made.legacyId }))
        .sort(byLegacy)
    )
    const players = await pool.query<{ userId: string }>(
      'select user_id::text as "userId" from event_players'
    )
    expect(players.rows).deep.equals([{ userId: String(ada.userId) }])
    const merged = await pool.query<{ mergedInto: string }>(
      'select merged_into::text as "mergedInto" from users where id = $1',
      [bea.userId]
    )
    expect(merged.rows).deep.equals([{ mergedInto: String(ada.userId) }])
  })

  it("rewrites only a person's external ids", async function () {
    const { rows } = await pool.query<{ id: string; entityId: string }>(
      'select id, entity_id as "entityId" from external_ids order by id'
    )
    expect(rows).deep.equals([
      { id: 'ext_bea', entityId: String(bea.userId) },
      { id: 'ext_cyPlayer', entityId: String(cy.userId) },
      { id: 'ext_cyUser', entityId: String(bea.userId) },
      { id: 'ext_nobody', entityId: 'tem_away' },
      { id: 'ext_player', entityId: String(ada.userId) },
      { id: 'ext_team', entityId: 'tem_home' }
    ])
  })

  it('stores each play as Gumbo, crediting people by user id alone', async function () {
    const { rows } = await pool.query<{
      id: string
      atBatIndex: number
      gumbo: Record<string, any>
      creditsLookedAt: boolean
    }>(
      `select id, "atBatIndex", gumbo, "creditsLookedAt"
       from events order by "gameId", "atBatIndex"`
    )
    const byId = new Map(rows.map(row => [row.id, row]))

    const single = byId.get('evt_single')
    expect(single?.atBatIndex).equals(0)
    expect(single?.gumbo.result).deep.equals({
      eventType: 'single',
      awayScore: 1,
      homeScore: 0
    })
    expect(single?.gumbo.about).deep.include({
      atBatIndex: 0,
      inning: 1,
      halfInning: 'top',
      isScoringPlay: true
    })
    expect(new Date(single?.gumbo.about.startTime).toISOString()).equals(PLAYED)
    const credited = (name: string, creditUserId: number | null): unknown => ({
      eventType: 'single',
      label: `Single: ${name}`,
      teamId: 'tem_away',
      creditUserId,
      credit: { name, role: 'batter', position: null }
    })
    expect(single?.gumbo.credits).deep.equals([
      credited('Ada', ada.userId),
      credited('Bea', null),
      credited('Cy', null),
      credited('Nobody', null)
    ])
    expect(single?.creditsLookedAt).equals(true)

    // Never looked at, which is not the same as looked at and found empty.
    expect(byId.get('evt_out')?.creditsLookedAt).equals(false)
    expect(byId.get('evt_out')?.gumbo).not.have.property('credits')

    // After everything else in its game, off the index it held.
    expect(byId.get('evt_correction')?.atBatIndex).equals(2)
    expect(byId.get('evt_correction')?.gumbo.about.atBatIndex).equals(2)

    // A game the import held nothing but a line score for.
    expect(byId.get('evt_lineScore')?.gumbo).deep.equals({
      about: { atBatIndex: 0, isScoringPlay: false },
      result: { eventType: 'final_score', awayScore: 3, homeScore: 2 }
    })

    const credits = await pool.query<{
      eventId: string
      name: string
      creditUserId: string | null
    }>(
      `select "eventId", name, "creditUserId"::text as "creditUserId"
       from "eventCredits" order by name`
    )
    expect(credits.rows).deep.equals([
      { eventId: 'evt_single', name: 'Ada', creditUserId: String(ada.userId) },
      { eventId: 'evt_single', name: 'Bea', creditUserId: null },
      { eventId: 'evt_single', name: 'Cy', creditUserId: null },
      { eventId: 'evt_single', name: 'Nobody', creditUserId: null }
    ])
    const external = await pool.query(
      `select column_name from information_schema.columns
       where table_name = 'eventCredits' and column_name = 'externalPlayerId'
       union all
       select indexname from pg_indexes
       where indexname = 'event_credits_external_player'`
    )
    expect(external.rows).deep.equals([])
  })

  it('rebuilds credits only when the play itself changes', async function () {
    const creditId = async (): Promise<string> =>
      (
        await pool.query<{ id: string }>(
          `select id from "eventCredits"
           where "eventId" = 'evt_single' and name = 'Ada'`
        )
      ).rows[0].id
    const first = await creditId()
    await pool.query(
      `update events set hidden = true, "timeNudgeSec" = 2
       where id = 'evt_single'`
    )
    expect(await creditId(), 'hiding a play keeps its credits').equals(first)
    await pool.query(
      `update events set gumbo = jsonb_set(gumbo, '{about,inning}', '2')
       where id = 'evt_single'`
    )
    expect(await creditId(), 'a changed play is read again').not.equals(first)

    const indexes = await pool.query<{ name: string }>(
      `select indexname as name from pg_indexes
       where indexname in ('events_game_order', 'external_ids_game_external')`
    )
    expect(indexes.rows).deep.equals([{ name: 'external_ids_game_external' }])
  })

  it('keeps the at-bat in progress on the game, and takes it away again', async function () {
    const column = async (): Promise<string[]> =>
      (
        await pool.query<{ name: string }>(
          `select column_name as name from information_schema.columns
           where table_name = 'games' and column_name = 'currentPlay'`
        )
      ).rows.map(row => row.name)
    expect(await column()).deep.equals(['currentPlay'])
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(migration038CurrentPlay.down)
      const dropped = await client.query(
        `select 1 from information_schema.columns
         where table_name = 'games' and column_name = 'currentPlay'`
      )
      expect(dropped.rows).deep.equals([])
      await client.query(migration038CurrentPlay.up)
    } finally {
      await client.query('rollback')
      client.release()
    }
    expect(await column()).deep.equals(['currentPlay'])
  })

  it('rolls back to 030 and puts back what the down path claims to', async function () {
    const rolledBack = await migrateDown(pool, migrations, from031.length)
    expect(rolledBack).deep.equals(from031.map(item => item.name).reverse())

    const users = await pool.query<{ id: string }>('select id from users')
    expect(users.rows.map(row => row.id).sort()).deep.equals(
      [ada.legacyId, bea.legacyId, cy.legacyId].sort()
    )
    const players = await pool.query<{ userId: string }>(
      'select user_id as "userId" from event_players'
    )
    expect(players.rows).deep.equals([{ userId: ada.legacyId }])
    const merged = await pool.query<{ mergedInto: string }>(
      'select merged_into as "mergedInto" from users where id = $1',
      [bea.legacyId]
    )
    expect(merged.rows).deep.equals([{ mergedInto: ada.legacyId }])
    const external = await pool.query<{ entityId: string }>(
      `select entity_id as "entityId" from external_ids where id = 'ext_player'`
    )
    expect(external.rows).deep.equals([{ entityId: ada.legacyId }])

    // The typed columns come back out of the document. The sentence does
    // not: 033 dropped it, and its down does not say it can put it back.
    const events = await pool.query<{
      id: string
      at_bat_index: number
      event_type: string
      inning: number | null
      half_inning: string | null
      away_score: number | null
      home_score: number | null
    }>(
      `select id, at_bat_index, event_type, inning, half_inning,
              away_score, home_score
       from events order by id`
    )
    expect(events.rows).deep.equals([
      {
        id: 'evt_correction',
        at_bat_index: 2,
        event_type: 'score_correction',
        inning: null,
        half_inning: null,
        away_score: 1,
        home_score: 1
      },
      {
        id: 'evt_lineScore',
        at_bat_index: 0,
        event_type: 'final_score',
        inning: null,
        half_inning: null,
        away_score: 3,
        home_score: 2
      },
      {
        id: 'evt_out',
        at_bat_index: 1,
        event_type: 'field_out',
        inning: 1,
        half_inning: 'bottom',
        away_score: 1,
        home_score: 0
      },
      {
        id: 'evt_single',
        at_bat_index: 0,
        event_type: 'single',
        inning: 2,
        half_inning: 'top',
        away_score: 1,
        home_score: 0
      }
    ])

    const tables = await pool.query<{ name: string }>(
      `select tablename as name from pg_tables
       where tablename = 'eventCredits'`
    )
    expect(tables.rows).deep.equals([])

    // The credits list comes back on its column, naming users by their
    // string ids, and a play nobody credited has none.
    const restored = (name: string, creditUserId: string | null): unknown => ({
      eventType: 'single',
      label: `Single: ${name}`,
      teamId: 'tem_away',
      creditUserId,
      credit: { name, role: 'batter', position: null }
    })
    const credits = await pool.query<{ id: string; credits: unknown }>(
      `select id, credits from events
       where id in ('evt_single', 'evt_out') order by id`
    )
    expect(credits.rows).deep.equals([
      { id: 'evt_out', credits: null },
      {
        id: 'evt_single',
        credits: [
          restored('Ada', ada.legacyId),
          restored('Bea', null),
          restored('Cy', null),
          restored('Nobody', null)
        ]
      }
    ])
    const creditIndex = await pool.query<{ name: string }>(
      `select indexname as name from pg_indexes
       where indexname = 'events_credits'`
    )
    expect(creditIndex.rows).deep.equals([{ name: 'events_credits' }])
    const indexes = await pool.query<{ name: string }>(
      `select indexname as name from pg_indexes
       where indexname in ('events_game_order', 'external_ids_game_external')`
    )
    expect(indexes.rows).deep.equals([{ name: 'events_game_order' }])
  })
})

/**
 * Two people, two games, and plays in the shape 030 stored them: a credited
 * single and an uncredited out in one game with a score correction after
 * them, and a line-score-only game.
 */
async function seed(pool: Pool): Promise<void> {
  for (const [made, name] of [
    [ada, 'Ada'],
    [bea, 'Bea'],
    [cy, 'Cy']
  ] as const) {
    await pool.query('insert into users (id, display_name) values ($1, $2)', [
      made.legacyId,
      name
    ])
  }
  // A user column on users itself, which the down path cannot read users
  // for while it rewrites that table.
  await pool.query('update users set merged_into = $1 where id = $2', [
    ada.legacyId,
    bea.legacyId
  ])
  await pool.query(
    `insert into teams (id, name) values
       ('tem_home', 'Home'), ('tem_away', 'Away')`
  )
  await pool.query(
    `insert into games (id, home_team_id, away_team_id, start_at) values
       ('gam_plays', 'tem_home', 'tem_away', $1),
       ('gam_lineScore', 'tem_home', 'tem_away', $1)`,
    [PLAYED]
  )
  await pool.query(
    `insert into external_ids
       (id, entity_type, entity_id, system, kind, external_id)
     values
       ('ext_player', 'user', $1, 'external', 'player', 'ext-ada'),
       ('ext_bea', 'user', $2, 'external', 'player', 'ext-bea'),
       ('ext_cyUser', 'user', $2, 'external', 'user', 'ext-cy'),
       ('ext_cyPlayer', 'user', $3, 'external', 'player', 'ext-cy'),
       ('ext_nobody', 'team', 'tem_away', 'external', 'team', 'ext-nobody'),
       ('ext_team', 'team', 'tem_home', 'external', 'team', 'ext-home')`,
    [ada.legacyId, bea.legacyId, cy.legacyId]
  )

  const oldCredit = (
    name: string,
    ids: { creditUserId?: string | null }
  ): unknown => ({
    eventType: 'single',
    label: `Single: ${name}`,
    teamId: 'tem_away',
    ...(ids.creditUserId === undefined
      ? {}
      : { creditUserId: ids.creditUserId }),
    credit: { name, role: 'batter', position: null }
  })

  const insertEvent = async (row: {
    id: string
    gameId: string
    atBatIndex: number
    inning: number | null
    half: 'top' | 'bottom' | null
    eventType: string
    description: string
    scoring: boolean
    away: number
    home: number
    gumbo: unknown
    credits: unknown
    startTime: string | null
  }): Promise<void> => {
    await pool.query(
      `insert into events (
         id, game_id, at_bat_index, inning, half_inning, event_type,
         description, is_scoring_play, away_score, home_score, gumbo,
         credits, start_time
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        row.id,
        row.gameId,
        row.atBatIndex,
        row.inning,
        row.half,
        row.eventType,
        row.description,
        row.scoring,
        row.away,
        row.home,
        JSON.stringify(row.gumbo),
        row.credits == null ? null : JSON.stringify(row.credits),
        row.startTime
      ]
    )
  }

  await insertEvent({
    id: 'evt_single',
    gameId: 'gam_plays',
    atBatIndex: 0,
    inning: 1,
    half: 'top',
    eventType: 'single',
    description: 'Ada singles to left field.',
    scoring: true,
    away: 1,
    home: 0,
    gumbo: {
      about: { inning: 1, halfInning: 'top' },
      result: { eventType: 'single', awayScore: 1, homeScore: 0 }
    },
    // Ada by her user id; Bea and Nobody by name alone, beside a null user
    // id; Cy by name alone, with no user id key at all.
    credits: [
      oldCredit('Ada', { creditUserId: ada.legacyId }),
      oldCredit('Bea', { creditUserId: null }),
      oldCredit('Cy', {}),
      oldCredit('Nobody', { creditUserId: null })
    ],
    startTime: PLAYED
  })
  await insertEvent({
    id: 'evt_out',
    gameId: 'gam_plays',
    atBatIndex: 1,
    inning: 1,
    half: 'bottom',
    eventType: 'field_out',
    description: 'Bea grounds out.',
    scoring: false,
    away: 1,
    home: 0,
    gumbo: {
      about: { inning: 1, halfInning: 'bottom' },
      result: { eventType: 'field_out', awayScore: 1, homeScore: 0 }
    },
    credits: null,
    startTime: null
  })
  await insertEvent({
    id: 'evt_correction',
    gameId: 'gam_plays',
    atBatIndex: 50,
    inning: null,
    half: null,
    eventType: 'score_correction',
    description: 'Score corrected to 1-1.',
    scoring: false,
    away: 1,
    home: 1,
    gumbo: {
      result: { eventType: 'score_correction', awayScore: 1, homeScore: 1 }
    },
    credits: null,
    startTime: null
  })
  await insertEvent({
    id: 'evt_lineScore',
    gameId: 'gam_lineScore',
    atBatIndex: 0,
    inning: null,
    half: null,
    eventType: 'final_score',
    description: 'Final score 3–2.',
    scoring: false,
    away: 3,
    home: 2,
    gumbo: { source: 'lineScore', away: 3, home: 2 },
    credits: null,
    startTime: null
  })

  await pool.query(
    `insert into event_players (id, event_id, user_id, team_id, role)
     values ('evp_ada', 'evt_single', $1, 'tem_away', 'batter')`,
    [ada.legacyId]
  )
}

const through036 = migrations.filter(migration => migration.name < '037')
const through037 = migrations.filter(migration => migration.name < '038')

const batter = mintUserId(() => false)
const pitcher = mintUserId(id => id === batter.userId)
const otherRunner = mintUserId(
  id => id === batter.userId || id === pitcher.userId
)

/**
 * Migration 037's table and its change to the events trigger: a batter who
 * reaches is not also listed as their own runner, and rolling the migration
 * back restores the old rows.
 */
describe('migration 037gameStatsState', function () {
  this.timeout(60000)

  const scratchName = `gamestation_upgrade_037_${Date.now()}`
  const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

  let admin: Pool
  let pool: Pool

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`create database ${scratchName}`)
    pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, through036)
    await seedPost031(pool)
  })

  after(async function () {
    if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  it('skips the batter as a runner and leaves game_player_stats alone', async function () {
    const applied = await migrateUp(pool, through037)
    expect(applied.applied).deep.equals([migration037GameStatsState.name])

    const table = await pool.query(
      `select to_regclass('game_stats_state')::text as name`
    )
    expect(table.rows).deep.equals([{ name: 'game_stats_state' }])

    const before = await pool.query<{
      id: string
      pa: number
      ab: number
      h: number
    }>(
      `select id, pa, ab, h from game_player_stats where game_id = 'gam_037'`
    )

    await pool.query(`update events set gumbo = gumbo where id = 'evt_037'`)

    const players = await pool.query<{ role: string; userId: string }>(
      `select role, user_id::text as "userId"
       from event_players
       where event_id = 'evt_037' and role in ('batter', 'runner')
       order by role, user_id`
    )
    expect(players.rows).deep.equals([
      { role: 'batter', userId: String(batter.userId) },
      { role: 'runner', userId: String(otherRunner.userId) }
    ])

    const after = await pool.query<{
      id: string
      pa: number
      ab: number
      h: number
    }>(
      `select id, pa, ab, h from game_player_stats where game_id = 'gam_037'`
    )
    expect(after.rows).deep.equals(before.rows)
  })

  it('restores the batter as a runner when 037 is rolled back', async function () {
    const rolled = await migrateDown(pool, through037, 1)
    expect(rolled).deep.equals([migration037GameStatsState.name])

    const table = await pool.query(
      `select to_regclass('game_stats_state')::text as name`
    )
    expect(table.rows).deep.equals([{ name: null }])

    await pool.query(`update events set gumbo = gumbo where id = 'evt_037'`)

    const players = await pool.query<{ role: string; userId: string }>(
      `select role, user_id::text as "userId"
       from event_players
       where event_id = 'evt_037' and role in ('batter', 'runner')
       order by role, user_id`
    )
    const runnerRows =
      batter.userId < otherRunner.userId
        ? [
            { role: 'runner', userId: String(batter.userId) },
            { role: 'runner', userId: String(otherRunner.userId) }
          ]
        : [
            { role: 'runner', userId: String(otherRunner.userId) },
            { role: 'runner', userId: String(batter.userId) }
          ]
    expect(players.rows).deep.equals([
      { role: 'batter', userId: String(batter.userId) },
      ...runnerRows
    ])
  })
})

/**
 * A game, three people, a stats row, and one double whose runners name the
 * batter twice (null→1B, 1B→2B) plus one other runner — the post-031 shape.
 */
async function seedPost031(pool: Pool): Promise<void> {
  for (const [made, name] of [
    [batter, 'Batter'],
    [pitcher, 'Pitcher'],
    [otherRunner, 'Runner']
  ] as const) {
    await pool.query(
      `insert into users (id, "legacyId", display_name) values ($1, $2, $3)`,
      [made.userId, made.legacyId, name]
    )
  }
  await pool.query(
    `insert into teams (id, name) values
       ('tem_home037', 'Home'), ('tem_away037', 'Away')`
  )
  await pool.query(
    `insert into games (id, home_team_id, away_team_id, start_at)
     values ('gam_037', 'tem_home037', 'tem_away037', $1)`,
    [PLAYED]
  )
  await pool.query(
    `insert into game_player_stats (id, game_id, user_id, team_id, pa, ab, h)
     values ('gps_037', 'gam_037', $1, 'tem_away037', 3, 2, 1)`,
    [batter.userId]
  )

  const gumbo = {
    about: {
      atBatIndex: 0,
      inning: 1,
      halfInning: 'top',
      isScoringPlay: false
    },
    result: { eventType: 'double', awayScore: 0, homeScore: 0 },
    matchup: {
      batter: { id: batter.userId },
      pitcher: { id: pitcher.userId }
    },
    runners: [
      {
        movement: { start: null, end: '1B', isOut: false },
        details: {
          eventType: 'double',
          runner: { id: batter.userId }
        }
      },
      {
        movement: { start: '1B', end: '2B', isOut: false },
        details: {
          eventType: 'double',
          runner: { id: batter.userId }
        }
      },
      {
        movement: { start: null, end: '3B', isOut: false },
        details: {
          eventType: 'double',
          runner: { id: otherRunner.userId }
        }
      }
    ]
  }

  await pool.query(
    `insert into events (id, "gameId", "battingTeamId", gumbo)
     values ('evt_037', 'gam_037', 'tem_away037', $1::jsonb)`,
    [JSON.stringify(gumbo)]
  )
}
