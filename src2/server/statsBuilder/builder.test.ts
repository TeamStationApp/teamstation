import { expect } from 'chai'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'
import { Pool } from 'pg'

import type { GumboPlay } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { replaceGameEvents } from '../events/eventWrite'
import { statRows } from '../stats/rows'
import { type AfterReadHook, buildNext, drain } from './builder'
import { requestGameStats } from './request'
import { gameStatsStatus } from './status'

const adminUrl = testDatabaseUrl
const scratchName = `gamestation_stats_bld_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

function paPlay(
  batter: number,
  pitcher: number,
  opts: {
    atBatIndex?: number
    eventType?: string
    outs?: number
    awayScore?: number | null
    homeScore?: number | null
  } = {}
): GumboPlay {
  const eventType = opts.eventType ?? 'single'
  const end = ['field_out', 'sac_bunt'].includes(eventType) ? null : '1B'
  const isOut = end == null
  return {
    about: {
      atBatIndex: opts.atBatIndex ?? 0,
      inning: 1,
      halfInning: 'top'
    },
    result: {
      eventType,
      awayScore: opts.awayScore ?? 0,
      homeScore: opts.homeScore ?? 0
    },
    count: { outs: opts.outs ?? (isOut ? 1 : 0) },
    matchup: { batter: { id: batter }, pitcher: { id: pitcher } },
    runners: [
      {
        movement: { start: null, end, isOut },
        details: {
          eventType,
          runner: { id: batter }
        }
      }
    ]
  }
}

describe('statsBuilder drain', function () {
  this.timeout(60000)

  let admin: Pool
  let pool: Pool
  let db: Kysely<Database>
  const home = makeId('team')
  const away = makeId('team')
  const held = new Set<number>()
  const legacies = new Map<number, string>()
  function mint(): number {
    const made = mintUserId(id => held.has(id))
    held.add(made.userId)
    legacies.set(made.userId, made.legacyId)
    return made.userId
  }
  const batter = mint()
  const pitcher = mint()
  const otherBatter = mint()
  let clockNow = new Date('2026-09-25T12:00:00.000Z')
  const clock = (): Date => new Date(clockNow)

  before(async function () {
    attachInt8Parser()
    admin = new Pool({ connectionString: adminUrl })
    await admin.query('select 1')
    await admin.query(`create database ${scratchName}`)
    pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    const now = new Date()
    await db
      .insertInto('teams')
      .values([
        { id: home, name: 'Home', kind: 'full' },
        { id: away, name: 'Away', kind: 'full' }
      ])
      .execute()
    for (const [id, name] of [
      [batter, 'Batter'],
      [pitcher, 'Pitcher'],
      [otherBatter, 'Other']
    ] as const) {
      await db
        .insertInto('users')
        .values({
          id,
          legacyId: legacies.get(id)!,
          display_name: name,
          created_at: now,
          updated_at: now
        })
        .execute()
    }
  })

  beforeEach(function () {
    clockNow = new Date('2026-09-25T12:00:00.000Z')
  })

  after(async function () {
    await db.destroy()
    await admin.query(`drop database if exists ${scratchName}`)
    await admin.end()
  })

  async function seedGame(
    plays: GumboPlay[],
    gameId = makeId('game')
  ): Promise<string> {
    await db
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date()
      })
      .execute()
    await replaceGameEvents(db, {
      gameId,
      homeTeamId: home,
      awayTeamId: away,
      plays: plays.map(gumbo => ({ gumbo, source: 'manual' as const }))
    })
    return gameId
  }

  it('builds an owed game with lines at the injected clock', async function () {
    const gameId = await seedGame([paPlay(batter, pitcher)])
    await drain(db, clock)
    const state = await db
      .selectFrom('game_stats_state')
      .selectAll()
      .where('game_id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(state.status).equals('built')
    expect(Number(state.built_generation)).equals(
      Number(state.requested_generation)
    )
    expect(new Date(state.built_at!).toISOString()).equals(
      clockNow.toISOString()
    )
    const rows = await db
      .selectFrom('game_player_stats')
      .selectAll()
      .where('game_id', '=', gameId)
      .execute()
    expect(rows.length).equals(2)
    const bat = rows.find(row => Number(row.user_id) === batter)!
    expect(bat.pa).equals(1)
    expect(bat.singles).equals(1)
    expect(bat.team_id).equals(away)
    expect(new Date(bat.computed_at).toISOString()).equals(
      clockNow.toISOString()
    )
    const pit = rows.find(row => Number(row.user_id) === pitcher)!
    expect(pit.pitch_bf).equals(1)
    expect(pit.team_id).equals(home)
  })

  it('stores a sacrifice bunt as sh, read back through statRows', async function () {
    const gameId = await seedGame([
      paPlay(batter, pitcher, { eventType: 'sac_bunt' })
    ])
    await drain(db, clock)
    const rows = await statRows(db, { gameId })
    const bat = rows.find(row => row.userId === batter)!
    expect([bat.pa, bat.ab, bat.sf, bat.sh]).deep.equals([1, 0, 0, 1])
    expect(rows.find(row => row.userId === pitcher)!.sh).equals(0)
  })

  it('rebuilds after a second post and drops vanished players', async function () {
    const gameId = await seedGame([
      paPlay(batter, pitcher),
      paPlay(otherBatter, pitcher, { atBatIndex: 1 })
    ])
    await drain(db, clock)
    expect(
      (
        await db
          .selectFrom('game_player_stats')
          .select('user_id')
          .where('game_id', '=', gameId)
          .execute()
      )
        .map(row => Number(row.user_id))
        .sort((a, b) => a - b)
    ).deep.equals([batter, otherBatter, pitcher].sort((a, b) => a - b))

    await replaceGameEvents(db, {
      gameId,
      homeTeamId: home,
      awayTeamId: away,
      plays: [{ gumbo: paPlay(batter, pitcher), source: 'manual' }]
    })
    await drain(db, clock)
    const ids = (
      await db
        .selectFrom('game_player_stats')
        .select('user_id')
        .where('game_id', '=', gameId)
        .execute()
    ).map(row => Number(row.user_id))
    expect(ids.includes(otherBatter)).equals(false)
    expect(ids.includes(batter)).equals(true)
  })

  it('keeps earlier rows when incomplete', async function () {
    const gameId = await seedGame([paPlay(batter, pitcher)])
    await drain(db, clock)
    const before = await db
      .selectFrom('game_player_stats')
      .selectAll()
      .where('game_id', '=', gameId)
      .execute()

    const bad = paPlay(batter, pitcher)
    delete (bad as { matchup?: unknown }).matchup
    await replaceGameEvents(db, {
      gameId,
      homeTeamId: home,
      awayTeamId: away,
      plays: [{ gumbo: bad, source: 'manual' }]
    })
    await drain(db, clock)
    const state = await db
      .selectFrom('game_stats_state')
      .selectAll()
      .where('game_id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(state.status).equals('incomplete')
    expect(state.detail).equals('play 0: matchup.pitcher missing')
    const after = await db
      .selectFrom('game_player_stats')
      .selectAll()
      .where('game_id', '=', gameId)
      .execute()
    expect(after.map(row => row.id).sort()).deep.equals(
      before.map(row => row.id).sort()
    )
  })

  it('clears rows and builds a game with no plays', async function () {
    const gameId = await seedGame([paPlay(batter, pitcher)])
    await drain(db, clock)
    await replaceGameEvents(db, {
      gameId,
      homeTeamId: home,
      awayTeamId: away,
      plays: []
    })
    await drain(db, clock)
    const state = await gameStatsStatus(db, gameId)
    expect(state.status).equals('built')
    const rows = await db
      .selectFrom('game_player_stats')
      .select('id')
      .where('game_id', '=', gameId)
      .execute()
    expect(rows).deep.equals([])
  })

  it('stays owed when a post lands during the build', async function () {
    const gameId = await seedGame([paPlay(batter, pitcher)])
    const midPost: AfterReadHook = async ({ db: trx }) => {
      await replaceGameEvents(trx, {
        gameId,
        homeTeamId: home,
        awayTeamId: away,
        plays: [{ gumbo: paPlay(otherBatter, pitcher), source: 'manual' }]
      })
    }
    await buildNext(db, clock, new Set(), midPost)
    let state = await db
      .selectFrom('game_stats_state')
      .selectAll()
      .where('game_id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(Number(state.requested_generation)).greaterThan(
      Number(state.built_generation)
    )
    // Must not advertise built over the stale play snapshot we just wrote.
    expect(state.status).equals('pending')

    await drain(db, clock)
    state = await db
      .selectFrom('game_stats_state')
      .selectAll()
      .where('game_id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(state.status).equals('built')
    expect(Number(state.built_generation)).equals(
      Number(state.requested_generation)
    )
    const ids = (
      await db
        .selectFrom('game_player_stats')
        .select('user_id')
        .where('game_id', '=', gameId)
        .execute()
    ).map(row => Number(row.user_id))
    expect(ids.includes(otherBatter)).equals(true)
    expect(ids.includes(batter)).equals(false)
  })

  it('marks incomplete for an unknown responsiblePitcher id', async function () {
    const missing = 999_999_001
    const gameId = await seedGame([])
    await replaceGameEvents(db, {
      gameId,
      homeTeamId: home,
      awayTeamId: away,
      plays: [
        {
          gumbo: {
            about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
            result: { eventType: 'single', awayScore: 1, homeScore: 0 },
            count: { outs: 0 },
            matchup: { batter: { id: batter }, pitcher: { id: pitcher } },
            runners: [
              {
                movement: { start: null, end: 'score', isOut: false },
                details: {
                  eventType: 'single',
                  runner: { id: batter },
                  responsiblePitcher: { id: missing },
                  earned: true,
                  rbi: true
                }
              }
            ]
          },
          source: 'manual'
        }
      ]
    })
    await drain(db, clock)
    const state = await db
      .selectFrom('game_stats_state')
      .selectAll()
      .where('game_id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(state.status).equals('incomplete')
    expect(state.detail).includes('is not a user')
  })

  it('marks failed with retry_at, skips until the clock passes', async function () {
    const doomed = mint()
    await db
      .insertInto('users')
      .values({
        id: doomed,
        legacyId: legacies.get(doomed)!,
        display_name: 'Doomed',
        created_at: new Date(),
        updated_at: new Date()
      })
      .execute()
    const gameId = await seedGame([paPlay(doomed, pitcher)])
    const other = await seedGame([paPlay(batter, pitcher)])

    const deleteDoomed: AfterReadHook = async ({
      db: trx,
      gameId: current
    }) => {
      if (current !== gameId) return
      // Delete inside the build transaction so the insert fails the FK; the
      // rollback restores the user, which is what a mid-build race looks like
      // after the failed attempt is recorded.
      await trx.deleteFrom('users').where('id', '=', doomed).execute()
    }
    await drain(db, clock, deleteDoomed)

    const failed = await db
      .selectFrom('game_stats_state')
      .selectAll()
      .where('game_id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(failed.status).equals('failed')
    expect(failed.attempts).equals(1)
    expect(new Date(failed.retry_at!).toISOString()).equals(
      new Date(clockNow.getTime() + 60_000).toISOString()
    )
    expect(
      (
        await db
          .selectFrom('game_stats_state')
          .select('status')
          .where('game_id', '=', other)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('built')

    // Attempt 2: delay doubles to 2 minutes.
    clockNow = new Date(failed.retry_at!)
    await drain(db, clock, deleteDoomed)
    const failed2 = await db
      .selectFrom('game_stats_state')
      .selectAll()
      .where('game_id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(failed2.status).equals('failed')
    expect(failed2.attempts).equals(2)
    expect(new Date(failed2.retry_at!).toISOString()).equals(
      new Date(clockNow.getTime() + 2 * 60_000).toISOString()
    )

    // Cap: pretends we already failed six times so the next delay is 60 min.
    await sql`
      update game_stats_state
      set requested_generation = built_generation + 1,
          status = 'failed',
          attempts = 6,
          retry_at = ${clockNow}
      where game_id = ${gameId}
    `.execute(db)
    await drain(db, clock, deleteDoomed)
    const capped = await db
      .selectFrom('game_stats_state')
      .selectAll()
      .where('game_id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(capped.attempts).equals(7)
    expect(new Date(capped.retry_at!).toISOString()).equals(
      new Date(clockNow.getTime() + 60 * 60_000).toISOString()
    )

    await sql`
      update game_stats_state
      set requested_generation = built_generation + 1,
          status = 'failed',
          attempts = 1,
          retry_at = ${new Date(clockNow.getTime() + 60_000)}
      where game_id = ${gameId}
    `.execute(db)
    await drain(db, clock)
    expect(
      (
        await db
          .selectFrom('game_stats_state')
          .select('status')
          .where('game_id', '=', gameId)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('failed')

    clockNow = new Date(clockNow.getTime() + 61_000)
    await drain(db, clock)
    expect(
      (
        await db
          .selectFrom('game_stats_state')
          .select('status')
          .where('game_id', '=', gameId)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('built')
  })

  it('does not let markFailed clobber a concurrent poke', async function () {
    const doomed = mint()
    await db
      .insertInto('users')
      .values({
        id: doomed,
        legacyId: legacies.get(doomed)!,
        display_name: 'Doomed',
        created_at: new Date(),
        updated_at: new Date()
      })
      .execute()
    const gameId = await seedGame([paPlay(doomed, pitcher)])
    const before = await db
      .selectFrom('game_stats_state')
      .select('requested_generation')
      .where('game_id', '=', gameId)
      .executeTakeFirstOrThrow()
    const genAtStart = Number(before.requested_generation)

    // Commit a poke on a separate connection while the build txn is open, then
    // fail the build. markFailed must not overwrite the poke's pending row.
    const pokeAndFail: AfterReadHook = async () => {
      await requestGameStats(db, gameId)
      await db.deleteFrom('users').where('id', '=', doomed).execute()
    }
    await buildNext(db, clock, new Set(), pokeAndFail)

    const state = await db
      .selectFrom('game_stats_state')
      .selectAll()
      .where('game_id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(Number(state.requested_generation)).greaterThan(genAtStart)
    expect(state.status).equals('pending')
    expect(state.attempts).equals(0)
    expect(state.retry_at).equals(null)

    // Restore the user so a later drain can succeed.
    await db
      .insertInto('users')
      .values({
        id: doomed,
        legacyId: legacies.get(doomed)!,
        display_name: 'Doomed',
        created_at: new Date(),
        updated_at: new Date()
      })
      .execute()
    await drain(db, clock)
    expect(
      (
        await db
          .selectFrom('game_stats_state')
          .select('status')
          .where('game_id', '=', gameId)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('built')
  })

  it('stops between games when shutdown is requested', async function () {
    const first = await seedGame([paPlay(batter, pitcher)])
    await seedGame([paPlay(otherBatter, pitcher)])
    let built = 0
    await drain(
      db,
      clock,
      async () => {
        built++
      },
      () => built >= 1
    )
    expect(
      (
        await db
          .selectFrom('game_stats_state')
          .select('status')
          .where('game_id', '=', first)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('built')
    expect(
      (
        await db
          .selectFrom('game_stats_state')
          .select('status')
          .where('status', '=', 'pending')
          .execute()
      ).length
    ).greaterThan(0)
  })

  it('skips a game held by another advisory lock and builds others', async function () {
    const locked = await seedGame([paPlay(batter, pitcher)])
    const free = await seedGame([paPlay(otherBatter, pitcher)])

    const holder = await pool.connect()
    try {
      await holder.query('begin')
      await holder.query(`select pg_advisory_xact_lock(hashtext($1))`, [
        `game_stats:${locked}`
      ])
      await drain(db, clock)
      expect(
        (
          await db
            .selectFrom('game_stats_state')
            .select('status')
            .where('game_id', '=', locked)
            .executeTakeFirstOrThrow()
        ).status
      ).equals('pending')
      expect(
        (
          await db
            .selectFrom('game_stats_state')
            .select('status')
            .where('game_id', '=', free)
            .executeTakeFirstOrThrow()
        ).status
      ).equals('built')
    } finally {
      await holder.query('rollback')
      holder.release()
    }

    await drain(db, clock)
    expect(
      (
        await db
          .selectFrom('game_stats_state')
          .select('status')
          .where('game_id', '=', locked)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('built')
  })

  it('gameStatsStatus returns each status and none', async function () {
    expect(await gameStatsStatus(db, makeId('game'))).deep.equals({
      status: 'none'
    })
    const gameId = await seedGame([paPlay(batter, pitcher)])
    expect((await gameStatsStatus(db, gameId)).status).equals('pending')
    await drain(db, clock)
    const built = await gameStatsStatus(db, gameId)
    expect(built.status).equals('built')
    if (built.status === 'none') throw new Error('unreachable')
    expect(built.builtAt != null).equals(true)

    await db
      .updateTable('game_stats_state')
      .set({ status: 'incomplete', detail: 'play 1: missing' })
      .where('game_id', '=', gameId)
      .execute()
    expect(await gameStatsStatus(db, gameId)).deep.equals({
      status: 'incomplete',
      detail: 'play 1: missing',
      builtAt: built.builtAt
    })

    await db
      .updateTable('game_stats_state')
      .set({ status: 'failed', detail: 'boom' })
      .where('game_id', '=', gameId)
      .execute()
    const failed = await gameStatsStatus(db, gameId)
    expect(failed.status).equals('failed')
    if (failed.status === 'none') throw new Error('unreachable')
    expect(failed.detail).equals('boom')
  })
})
