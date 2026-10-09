import { expect } from 'chai'
import { EventEmitter } from 'events'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import type { GumboPlay } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { until } from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { replaceGameEvents } from '../events/eventWrite'
import { runStatsBuilder } from './main'
import { requestGameStats } from './request'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_stats_main_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

describe('statsBuilder main', function () {
  this.timeout(60000)

  let admin: Pool
  let pool: Pool
  let db: Kysely<Database>
  const home = makeId('team')
  const away = makeId('team')
  const held = new Set<number>()
  function mint(): { userId: number; legacyId: string } {
    const made = mintUserId(id => held.has(id))
    held.add(made.userId)
    return made
  }
  const batter = mint()
  const pitcher = mint()
  const clockNow = new Date('2026-09-25T12:00:00.000Z')

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
    for (const user of [batter, pitcher]) {
      await db
        .insertInto('users')
        .values({
          id: user.userId,
          legacyId: user.legacyId,
          display_name: 'P',
          created_at: now,
          updated_at: now
        })
        .execute()
    }
  })

  after(async function () {
    await db.destroy()
    await admin.query(`drop database if exists ${scratchName}`)
    await admin.end()
  })

  function play(): GumboPlay {
    return {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
      result: { eventType: 'single', awayScore: 0, homeScore: 0 },
      count: { outs: 0 },
      matchup: {
        batter: { id: batter.userId },
        pitcher: { id: pitcher.userId }
      },
      runners: [
        {
          movement: { start: null, end: '1B', isOut: false },
          details: {
            eventType: 'single',
            runner: { id: batter.userId }
          }
        }
      ]
    }
  }

  it('drains on start, on notify, schedules retry_at, and stops cleanly', async function () {
    const gameId = makeId('game')
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
      plays: [{ gumbo: play(), source: 'manual' }]
    })

    const signals = new EventEmitter()
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
      originalLog(...args)
    }

    let handle: Awaited<ReturnType<typeof runStatsBuilder>> | undefined
    try {
      handle = await runStatsBuilder({
        databaseUrl: scratchUrl,
        clock: () => new Date(clockNow),
        signals
      })

      expect(
        (
          await db
            .selectFrom('game_stats_state')
            .select('status')
            .where('game_id', '=', gameId)
            .executeTakeFirstOrThrow()
        ).status
      ).equals('built')

      await replaceGameEvents(db, {
        gameId,
        homeTeamId: home,
        awayTeamId: away,
        plays: [{ gumbo: play(), source: 'manual' }]
      })
      const deadline = Date.now() + 1000
      let status = 'pending'
      while (Date.now() < deadline) {
        status = (
          await db
            .selectFrom('game_stats_state')
            .select('status')
            .where('game_id', '=', gameId)
            .executeTakeFirstOrThrow()
        ).status
        if (status === 'built') break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(status).equals('built')

      const retryAt = new Date(clockNow.getTime() + 5_000)
      await sql`
        update game_stats_state
        set requested_generation = built_generation + 1,
            status = 'failed',
            attempts = 1,
            retry_at = ${retryAt}
        where game_id = ${gameId}
      `.execute(db)
      await sql`select pg_notify('game_stats', ${gameId})`.execute(db)
      await new Promise(resolve => setTimeout(resolve, 150))
      const delay = handle.lastTimerMs()
      expect(delay).equals(5_000)

      await handle.stop('SIGTERM')
      expect(
        logs.some(line => line.includes('stats builder: stopped on SIGTERM'))
      ).equals(true)
      handle = undefined

      // SIGINT, double-stop, and listen error with an injected signal bus.
      handle = await runStatsBuilder({
        databaseUrl: scratchUrl,
        clock: () => new Date(clockNow),
        signals
      })
      const firstStop = handle.stop('SIGINT')
      const secondStop = handle.stop('SIGKILL')
      await firstStop
      await secondStop
      expect(logs.some(line => line.includes('stopped on SIGINT'))).equals(true)
      handle = undefined

      handle = await runStatsBuilder({
        databaseUrl: scratchUrl,
        clock: () => new Date(clockNow),
        signals,
        setTimeout: ((fn: () => void) => {
          // Fire immediately to exercise the timer callback path.
          fn()
          return 0 as unknown as NodeJS.Timeout
        }) as typeof setTimeout
      })
      await requestGameStats(db, gameId)
      await new Promise(resolve => setTimeout(resolve, 50))
      signals.emit('SIGINT')
      await new Promise(resolve => setTimeout(resolve, 100))
      await handle.stop('SIGTERM')
      handle = undefined

      // pokedDuringDrain: hold the first build, poke again mid-drain, release.
      let releaseHold: (() => void) | undefined
      const hold = new Promise<void>(resolve => {
        releaseHold = resolve
      })
      let afterReadCalls = 0
      handle = await runStatsBuilder({
        databaseUrl: scratchUrl,
        clock: () => new Date(clockNow),
        signals,
        afterRead: async () => {
          afterReadCalls++
          if (afterReadCalls === 1) await hold
        }
      })
      await requestGameStats(db, gameId)
      await until('the first read', () => afterReadCalls >= 1, 2000)
      expect(afterReadCalls).equals(1)
      await requestGameStats(db, gameId)
      await new Promise(resolve => setTimeout(resolve, 50))
      releaseHold!()
      await until('the poked read', () => afterReadCalls >= 2, 2000)
      // Stopping waits out the game in hand, so its build has committed.
      await handle.stop('SIGTERM')
      handle = undefined
      expect(
        (
          await db
            .selectFrom('game_stats_state')
            .select('status')
            .where('game_id', '=', gameId)
            .executeTakeFirstOrThrow()
        ).status
      ).equals('built')

      // Listen client error with an injected signal bus (no process.exit):
      // the failure is reported before the builder gives up.
      const reported: unknown[] = []
      handle = await runStatsBuilder({
        databaseUrl: scratchUrl,
        clock: () => new Date(clockNow),
        signals,
        report: async error => {
          reported.push(error)
        }
      })
      handle.listenClient().emit('error', new Error('listen boom'))
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(process.exitCode).equals(1)
      expect(reported.map(error => (error as Error).message)).deep.equals([
        'listen boom'
      ])
      process.exitCode = 0
      handle = undefined
    } finally {
      console.log = originalLog
      if (handle != null) await handle.stop('SIGTERM')
    }
  })
})
