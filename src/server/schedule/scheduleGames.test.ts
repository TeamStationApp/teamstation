import { expect } from 'chai'
import { type Kysely, type Selectable, sql } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import type {
  ScheduleGameResult,
  ScheduleGamesResponse
} from '../../common/scheduleGames'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { Database, GamesTable } from '../db/database'
import { makeDatabase } from '../db/database'
import {
  mayScheduleIn,
  scheduleGames,
  type ScheduleRights
} from './scheduleGames'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_schedule_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const SITE: ScheduleRights = {
  siteAdmin: true,
  teamAdminIds: new Set(),
  seasonIds: new Set()
}

describe('scheduling a team’s games', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let db: Kysely<Database> | undefined
  const summer = makeId('season')
  const fall = makeId('season')
  const lateSummer = makeId('season')
  const trosky = makeId('team')
  const rival = makeId('team')
  const boren = makeId('team')
  const outsiders = makeId('team')
  const merged = makeId('team')
  const mergedInto = makeId('team')
  const others = makeId('team')
  const loner = makeId('team')

  const post = async (
    rows: unknown[],
    options: { teamId?: string; rights?: ScheduleRights } = {}
  ): Promise<ScheduleGamesResponse> =>
    await scheduleGames(db!, {
      teamId: options.teamId ?? trosky,
      rows,
      rights: options.rights ?? SITE
    })

  const gamesCount = async (): Promise<number> =>
    Number(
      (
        await db!
          .selectFrom('games')
          .select(eb => eb.fn.countAll().as('n'))
          .executeTakeFirstOrThrow()
      ).n
    )

  const game = async (id: string): Promise<Selectable<GamesTable>> =>
    await db!
      .selectFrom('games')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

  const idOf = (result: ScheduleGameResult): string => {
    if (result.result === 'error') throw new Error(result.error.message)
    return result.gameId
  }

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query('select 1')
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
      return
    }
    await admin.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    await db
      .insertInto('seasons')
      .values([
        {
          id: summer,
          name: 'Summer 2026',
          year: 2026,
          starts_on: '2026-07-01',
          ends_on: '2026-09-13'
        },
        {
          id: fall,
          name: 'Fall 2026',
          year: 2026,
          starts_on: '2026-10-01',
          ends_on: '2026-12-15'
        },
        // Overlaps the end of summer and starts later: it wins there.
        {
          id: lateSummer,
          name: 'Late Summer 2026',
          year: 2026,
          starts_on: '2026-09-01',
          ends_on: '2026-09-10'
        }
      ])
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: trosky, name: 'Trosky Force 11U' },
        { id: rival, name: 'Hawks' },
        { id: boren, name: 'Black Sox (Boren)' },
        { id: outsiders, name: 'Outsiders', kind: 'external' },
        { id: mergedInto, name: 'AAA Hawks' },
        {
          id: merged,
          name: 'NP5 Hardy',
          kind: 'external',
          merged_into: mergedInto
        },
        { id: others, name: 'Others' },
        { id: loner, name: 'Loner' }
      ])
      .execute()
    await db
      .insertInto('season_teams')
      .values([
        { season_id: summer, team_id: trosky },
        { season_id: summer, team_id: rival },
        { season_id: summer, team_id: boren },
        { season_id: fall, team_id: trosky },
        { season_id: lateSummer, team_id: trosky },
        { season_id: summer, team_id: others }
      ])
      .execute()
  })

  after(async function () {
    if (db != null) await db.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName} with (force)`)
      await admin.end()
    }
  })

  let hour = 0
  /** A fresh time in July for each test, so no two rows twin by accident. */
  const nextStart = (): string => {
    hour += 1
    return new Date(Date.UTC(2026, 6, 2, 0) + hour * 3_600_000).toISOString()
  }
  beforeEach(function () {
    if (db == null) this.skip()
  })

  it('creates an external opponent from the api, once per name', async function () {
    const answer = await post([
      { opponent: { name: 'Diablos' }, side: 'home', startAt: nextStart() },
      { opponent: { name: 'diablos 2' }, side: 'away', startAt: nextStart() }
    ])
    expect(answer.counts).deep.equals({
      created: 2,
      updated: 0,
      unchanged: 0,
      error: 0
    })
    const [first, second] = await Promise.all(
      answer.results.map(async r => await game(idOf(r)))
    )
    expect(first.home_team_id).equals(trosky)
    expect(second.away_team_id).equals(trosky)
    expect(second.home_team_id).equals(first.away_team_id)
    expect(first.season_id).equals(summer)
    expect(first.status).equals('scheduled')
    const team = await db!
      .selectFrom('teams')
      .select(['name', 'kind', 'created_from'])
      .where('id', '=', first.away_team_id)
      .executeTakeFirstOrThrow()
    expect(team).deep.equals({
      name: 'Diablos',
      kind: 'external',
      created_from: 'api'
    })
  })

  it('finds a same-season rival by name and by coach', async function () {
    const answer = await post([
      { opponent: { name: 'Hawks 2' }, side: 'home', startAt: nextStart() },
      { opponent: { name: 'NP3 Boren' }, side: 'home', startAt: nextStart() },
      { opponent: { name: 'Outsiders' }, side: 'home', startAt: nextStart() }
    ])
    const opponents = await Promise.all(
      answer.results.map(async r => (await game(idOf(r))).away_team_id)
    )
    expect(opponents).deep.equals([rival, boren, outsiders])
  })

  it('records an external id and recognises it again', async function () {
    const row = {
      opponent: { name: 'Rattlers' },
      side: 'away',
      startAt: nextStart(),
      externalId: { system: 'otherLeague', id: 'ol-1' }
    }
    const first = await post([row])
    expect(first.results[0].result).equals('created')
    const gameId = idOf(first.results[0])
    const ids = await db!
      .selectFrom('external_ids')
      .select(['system', 'kind', 'external_id', 'entity_id'])
      .where('external_id', '=', 'ol-1')
      .execute()
    expect(ids).deep.equals([
      {
        system: 'otherLeague',
        kind: 'event',
        external_id: 'ol-1',
        entity_id: gameId
      }
    ])
    const count = await gamesCount()
    const again = await post([row])
    expect(again.results[0]).deep.equals({
      index: 0,
      result: 'unchanged',
      gameId,
      status: 'scheduled'
    })
    expect(await gamesCount()).equals(count)
  })

  it('matches an id held under other kinds', async function () {
    const gameId = makeId('game')
    await db!
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: trosky,
        away_team_id: rival,
        season_id: summer,
        start_at: new Date(nextStart())
      })
      .execute()
    const start = (await game(gameId)).start_at
    await db!
      .insertInto('external_ids')
      .values(
        ['game', 'teamEvent'].map(kind => ({
          id: makeId('externalId'),
          entity_type: 'game',
          entity_id: gameId,
          system: 'acme',
          kind,
          external_id: 'ext-held'
        }))
      )
      .execute()
    const count = await gamesCount()
    const answer = await post([
      {
        startAt: new Date(start).toISOString(),
        externalId: { system: 'acme', id: 'ext-held', kind: 'teamEvent' }
      }
    ])
    expect(answer.results[0]).deep.equals({
      index: 0,
      result: 'unchanged',
      gameId,
      status: 'scheduled'
    })
    expect(await gamesCount()).equals(count)
  })

  it('moves, re-venues, cancels and restores a held game, and records a new kind', async function () {
    const externalId = { system: 'otherLeague', id: 'ol-move' }
    const created = await post([
      {
        opponent: { name: 'Movers' },
        side: 'home',
        startAt: nextStart(),
        venue: 'Field 1',
        externalId
      }
    ])
    const gameId = idOf(created.results[0])
    const before = await game(gameId)
    const later = nextStart()

    const moved = await post([{ startAt: later, externalId }])
    expect(moved.results[0]).deep.include({
      result: 'updated',
      status: 'scheduled'
    })
    let now = await game(gameId)
    expect(new Date(now.start_at).toISOString()).equals(later)
    expect(now.venue).equals('Field 1')
    expect([now.home_team_id, now.away_team_id]).deep.equals([
      before.home_team_id,
      before.away_team_id
    ])

    expect(
      (await post([{ startAt: later, venue: 'Field 2', externalId }]))
        .results[0].result
    ).equals('updated')
    expect((await game(gameId)).venue).equals('Field 2')

    const cancelled = await post([
      { startAt: later, status: 'cancelled', externalId }
    ])
    expect(cancelled.results[0]).deep.include({
      result: 'updated',
      status: 'cancelled'
    })
    const restored = await post([
      { startAt: later, status: 'scheduled', externalId }
    ])
    expect(restored.results[0]).deep.include({
      result: 'updated',
      status: 'scheduled'
    })
    now = await game(gameId)
    expect(now.status).equals('scheduled')

    const newKind = await post([
      { startAt: later, externalId: { ...externalId, kind: 'teamEvent' } }
    ])
    expect(newKind.results[0].result).equals('updated')
    const kinds = await db!
      .selectFrom('external_ids')
      .select(['kind'])
      .where('external_id', '=', 'ol-move')
      .orderBy('kind')
      .execute()
    expect(kinds.map(row => row.kind)).deep.equals(['event', 'teamEvent'])
  })

  it('sets a game’s fence on create, changes it on a held game, and keeps it otherwise', async function () {
    const externalId = { system: 'otherLeague', id: 'ol-fence' }
    const startAt = nextStart()
    const created = await post([
      {
        opponent: { name: 'Fencers' },
        side: 'home',
        startAt,
        externalId,
        fenceDistanceFt: 185
      },
      { opponent: { name: 'Fencers' }, side: 'away', startAt: nextStart() }
    ])
    const gameId = idOf(created.results[0])
    expect((await game(gameId)).fence_distance_ft).equals(185)
    // A row that does not give one leaves it to the season.
    expect((await game(idOf(created.results[1]))).fence_distance_ft).equals(
      null
    )

    const same = await post([{ startAt, externalId, fenceDistanceFt: 185 }])
    expect(same.results[0].result).equals('unchanged')
    const resized = await post([{ startAt, externalId, fenceDistanceFt: 210 }])
    expect(resized.results[0]).deep.include({
      result: 'updated',
      status: 'scheduled'
    })
    expect((await game(gameId)).fence_distance_ft).equals(210)
    expect((await post([{ startAt, externalId }])).results[0].result).equals(
      'unchanged'
    )
    expect((await game(gameId)).fence_distance_ft).equals(210)

    // A cancelled game is still a scheduled one's field.
    await post([{ startAt, externalId, status: 'cancelled' }])
    const cancelled = await post([
      { startAt, externalId, fenceDistanceFt: 195 }
    ])
    expect(cancelled.results[0]).deep.include({
      result: 'updated',
      status: 'cancelled'
    })
    expect((await game(gameId)).fence_distance_ft).equals(195)

    // Plays posted to it fix its field, cancelled or not.
    const play = {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
      result: { eventType: 'stolen_base', awayScore: null, homeScore: null }
    }
    const { away_team_id: battingTeamId } = await game(gameId)
    await sql`insert into events (id, "gameId", "battingTeamId", gumbo)
      values (${makeId('event')}, ${gameId}, ${battingTeamId}, ${JSON.stringify(play)}::jsonb)`.execute(
      db!
    )
    const played = await post([{ startAt, externalId, fenceDistanceFt: 205 }])
    expect(played.results[0].result).equals('unchanged')
    expect((await game(gameId)).fence_distance_ft).equals(195)

    // Once it is being played, or has been, the field is what it was.
    for (const status of ['inProgress', 'final'] as const) {
      await db!
        .updateTable('games')
        .set({ status })
        .where('id', '=', gameId)
        .execute()
      const answer = await post([{ startAt, externalId, fenceDistanceFt: 300 }])
      expect(answer.results[0].result, status).equals('unchanged')
      expect((await game(gameId)).fence_distance_ft, status).equals(195)
    }

    const refused = await post([
      { startAt: nextStart(), externalId, fenceDistanceFt: 601 }
    ])
    expect(refused.results[0]).deep.include({ result: 'error' })
  })

  it('keeps the fence a first post fixed while a row waited on it', async function () {
    const play = {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
      result: { eventType: 'stolen_base', awayScore: null, homeScore: null }
    }
    // A post puts a scheduled game under way; a cancelled one stays so.
    for (const [status, after] of [
      ['scheduled', 'inProgress'],
      ['cancelled', 'cancelled']
    ] as const) {
      const externalId = { system: 'otherLeague', id: `ol-race-${status}` }
      const startAt = nextStart()
      const created = await post([
        {
          opponent: { name: 'Racers' },
          side: 'home',
          startAt,
          externalId,
          status,
          fenceDistanceFt: 230
        }
      ])
      const gameId = idOf(created.results[0])
      let answer: ReturnType<typeof post> | undefined
      await db!.transaction().execute(async trx => {
        await trx
          .selectFrom('games')
          .select('id')
          .where('id', '=', gameId)
          .forUpdate()
          .execute()
        const { away_team_id: battingTeamId } = await game(gameId)
        await sql`insert into events (id, "gameId", "battingTeamId", gumbo)
          values (${makeId('event')}, ${gameId}, ${battingTeamId}, ${JSON.stringify(play)}::jsonb)`.execute(
          trx
        )
        await trx
          .updateTable('games')
          .set({ status: after })
          .where('id', '=', gameId)
          .execute()
        answer = post([{ startAt, externalId, fenceDistanceFt: 500 }])
        await new Promise(resolve => setTimeout(resolve, 200))
      })
      const { results } = await answer!
      expect(results[0], status).deep.include({
        result: 'unchanged',
        status: after
      })
      expect((await game(gameId)).fence_distance_ft, status).equals(230)
    }
  })

  it('leaves a game in progress or final as it is', async function () {
    for (const status of ['inProgress', 'final'] as const) {
      const externalId = { system: 'otherLeague', id: `ol-${status}` }
      const created = await post([
        {
          opponent: { name: 'Players' },
          side: 'home',
          startAt: nextStart(),
          externalId
        }
      ])
      const gameId = idOf(created.results[0])
      await db!
        .updateTable('games')
        .set({ status })
        .where('id', '=', gameId)
        .execute()
      const before = await game(gameId)
      const answer = await post([
        {
          startAt: nextStart(),
          venue: 'Elsewhere',
          status: 'cancelled',
          externalId: { ...externalId, kind: 'other' }
        }
      ])
      expect(answer.results[0]).deep.equals({
        index: 0,
        result: 'unchanged',
        gameId,
        status
      })
      expect(await game(gameId)).deep.equals(before)
    }
  })

  it('refuses an id on a game the team does not play in', async function () {
    const gameId = makeId('game')
    const start = new Date(nextStart())
    await db!
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: rival,
        away_team_id: boren,
        season_id: summer,
        start_at: start
      })
      .execute()
    await db!
      .insertInto('external_ids')
      .values({
        id: makeId('externalId'),
        entity_type: 'game',
        entity_id: gameId,
        system: 'otherLeague',
        kind: 'event',
        external_id: 'ol-theirs'
      })
      .execute()
    const answer = await post([
      {
        startAt: nextStart(),
        status: 'cancelled',
        externalId: { system: 'otherLeague', id: 'ol-theirs' }
      }
    ])
    expect(answer.results[0]).deep.include({ result: 'error' })
    expect(
      (answer.results[0] as { error: { code: string } }).error.code
    ).equals('conflict')
    expect((await game(gameId)).status).equals('scheduled')
  })

  it('lands an id on its twin, and a row with no id makes a second game', async function () {
    const start = nextStart()
    const twinId = makeId('game')
    await db!
      .insertInto('games')
      .values({
        id: twinId,
        home_team_id: rival,
        away_team_id: trosky,
        season_id: summer,
        start_at: new Date(start)
      })
      .execute()
    const count = await gamesCount()
    const answer = await post([
      {
        opponent: { teamId: rival },
        side: 'away',
        startAt: start,
        externalId: { system: 'otherLeague', id: 'twin-1' }
      }
    ])
    expect(answer.results[0]).deep.equals({
      index: 0,
      result: 'updated',
      gameId: twinId,
      status: 'scheduled'
    })
    expect(await gamesCount()).equals(count)
    const held = await db!
      .selectFrom('external_ids')
      .select(['entity_id'])
      .where('external_id', '=', 'twin-1')
      .executeTakeFirstOrThrow()
    expect(held.entity_id).equals(twinId)

    // The twin's side is the other way round: the reversed pair still twins.
    const second = await post([
      {
        opponent: { name: 'Hawks' },
        side: 'home',
        startAt: start,
        externalId: { system: 'otherLeague', id: 'twin-2' }
      }
    ])
    expect(idOf(second.results[0])).equals(twinId)

    const doubleheader = await post([
      { opponent: { teamId: rival }, side: 'away', startAt: start }
    ])
    expect(doubleheader.results[0].result).equals('created')
    expect(await gamesCount()).equals(count + 1)
  })

  it('creates a game every time a row has no external id', async function () {
    const row = {
      opponent: { name: 'Diablos' },
      side: 'home',
      startAt: nextStart()
    }
    const count = await gamesCount()
    const first = await post([row])
    const second = await post([row])
    expect(idOf(first.results[0])).not.equals(idOf(second.results[0]))
    expect(await gamesCount()).equals(count + 2)
  })

  it('resolves the season by name, by range, then by year', async function () {
    const seasonOf = async (row: object): Promise<string | null> => {
      const answer = await post([
        { opponent: { name: 'Diablos' }, side: 'home', ...row }
      ])
      return (await game(idOf(answer.results[0]))).season_id
    }
    expect(await seasonOf({ startAt: '2026-10-20T17:00:00Z' })).equals(fall)
    // Summer and late summer both hold it; late summer started later.
    expect(await seasonOf({ startAt: '2026-09-05T17:00:00Z' })).equals(
      lateSummer
    )
    // Wall-clock day of the offset, not UTC — evening on summer's last day.
    expect(await seasonOf({ startAt: '2026-09-13T19:00:00-07:00' })).equals(
      summer
    )
    // Outside every range: the latest-starting season of 2026.
    expect(await seasonOf({ startAt: '2026-09-19T17:00:00Z' })).equals(fall)
    expect(
      await seasonOf({ startAt: '2026-10-20T17:00:00Z', seasonId: summer })
    ).equals(summer)

    const notIn = await post([
      {
        opponent: { name: 'Diablos' },
        side: 'home',
        startAt: nextStart(),
        seasonId: makeId('season')
      }
    ])
    expect(notIn.results[0]).deep.include({ result: 'error' })
    expect((notIn.results[0] as { error: { code: string } }).error.code).equals(
      'notFound'
    )

    const none = await post([
      {
        opponent: { name: 'Diablos' },
        side: 'home',
        startAt: '2027-05-01T17:00:00Z'
      }
    ])
    expect(none.results[0]).deep.equals({
      index: 0,
      result: 'error',
      error: {
        code: 'noSeason',
        message: 'Trosky Force 11U has no season in 2027: send seasonId'
      }
    })
  })

  it('refuses a bad opponent', async function () {
    const codes = async (
      opponent: unknown,
      side: unknown = 'home'
    ): Promise<string> => {
      const row = side === 'none' ? { opponent } : { opponent, side }
      const answer = await post([{ ...row, startAt: nextStart() }])
      const result = answer.results[0]
      return result.result === 'error'
        ? `${result.error.code}: ${result.error.message}`
        : result.result
    }
    expect(await codes({ teamId: makeId('team') })).matches(/^notFound/)
    expect(await codes({ teamId: trosky })).matches(/^conflict/)
    expect(await codes({ teamId: merged })).equals(
      `conflict: Team ${merged} was merged into ${mergedInto}`
    )
    expect(await codes({ name: 'Trosky Force 11U' })).matches(/^conflict/)
    expect(await codes({ name: 'Diablos' }, 'none')).equals(
      'invalid: opponent and side are needed to create a game'
    )
    const noOpponent = await post([{ side: 'home', startAt: nextStart() }])
    expect(noOpponent.results[0]).deep.include({ result: 'error' })
  })

  it('follows a merged team a name finds', async function () {
    const answer = await post([
      { opponent: { name: 'NP5 Hardy' }, side: 'home', startAt: nextStart() }
    ])
    expect((await game(idOf(answer.results[0]))).away_team_id).equals(
      mergedInto
    )
  })

  it('answers every row in order, applying the good around a bad one', async function () {
    const count = await gamesCount()
    const answer = await post([
      { opponent: { name: 'Diablos' }, side: 'home', startAt: nextStart() },
      {
        opponent: { name: 'Diablos' },
        side: 'home',
        startAt: '2026-10-03 17:00'
      },
      { opponent: { name: 'Diablos' }, side: 'home', startAt: nextStart() }
    ])
    expect(answer.results.map(r => [r.index, r.result])).deep.equals([
      [0, 'created'],
      [1, 'error'],
      [2, 'created']
    ])
    const bad = answer.results[1] as {
      error: { code: string; message: string }
    }
    expect(bad.error.code).equals('invalid')
    expect(bad.error.message).includes('startAt')
    expect(answer.counts).deep.equals({
      created: 2,
      updated: 0,
      unchanged: 0,
      error: 1
    })
    expect(await gamesCount()).equals(count + 2)
  })

  it('leaves no stray team behind a failed row, and does not remember it', async function () {
    // No side: the row fails after its opponent was made, and rolls it back.
    const answer = await post([
      { opponent: { name: 'Ghosts' }, startAt: nextStart() },
      { opponent: { name: 'Ghosts' }, side: 'home', startAt: nextStart() }
    ])
    expect(answer.results.map(r => r.result)).deep.equals(['error', 'created'])
    const ghosts = await db!
      .selectFrom('teams')
      .select(['id'])
      .where('name', '=', 'Ghosts')
      .execute()
    expect(ghosts).lengthOf(1)
  })

  it('makes one game from two concurrent posts of one new id', async function () {
    const row = {
      opponent: { name: 'Racers' },
      side: 'home',
      startAt: nextStart(),
      externalId: { system: 'otherLeague', id: 'race-1' }
    }
    const [a, b] = await Promise.all([post([row]), post([row])])
    expect([a.results[0].result, b.results[0].result].sort()).deep.equals([
      'created',
      'unchanged'
    ])
    expect(idOf(a.results[0])).equals(idOf(b.results[0]))
  })

  it('refuses a row into a season a season admin does not administer', async function () {
    const rights: ScheduleRights = {
      siteAdmin: false,
      teamAdminIds: new Set(),
      seasonIds: new Set([summer])
    }
    const answer = await post(
      [
        {
          opponent: { name: 'Diablos' },
          side: 'home',
          startAt: '2026-07-20T17:00:00Z'
        },
        {
          opponent: { name: 'Diablos' },
          side: 'home',
          startAt: '2026-10-20T17:00:00Z'
        }
      ],
      { rights }
    )
    expect(answer.results[0].result).equals('created')
    expect(answer.results[1]).deep.equals({
      index: 1,
      result: 'error',
      error: {
        code: 'forbidden',
        message:
          'Only an admin of this team or of Fall 2026 may schedule games in it'
      }
    })
  })

  it('judges rights by team, then by season', function () {
    const rights: ScheduleRights = {
      siteAdmin: false,
      teamAdminIds: new Set(['t1']),
      seasonIds: new Set(['s1'])
    }
    expect(mayScheduleIn(rights, 't1', null)).equals(true)
    expect(mayScheduleIn(rights, 't2', 's1')).equals(true)
    expect(mayScheduleIn(rights, 't2', 's2')).equals(false)
    expect(mayScheduleIn(rights, 't2', null)).equals(false)
    expect(mayScheduleIn(SITE, 't2', null)).equals(true)
  })
})
