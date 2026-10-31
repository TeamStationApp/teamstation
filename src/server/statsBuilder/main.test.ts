import { expect } from 'chai'
import { EventEmitter } from 'events'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import type { GumboPlay } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { until } from '../../test/scoreboardKit'
import { FEED_APPLICATION_NAME, PostgresFeed } from '../changeFeed/postgresFeed'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { replaceGameEvents } from '../events/eventWrite'
import { runMain, runStatsBuilder } from './main'
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
      await insertFixtureUsers(db, {
        id: userIdOfGumbo(user.userId),
        legacyId: user.legacyId,
        display_name: 'P',
        created_at: now,
        updated_at: now
      })
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

      // A drain error with an injected signal bus (no process.exit): the
      // failure is reported before the builder gives up.
      const reported: unknown[] = []
      let clockFails = false
      handle = await runStatsBuilder({
        databaseUrl: scratchUrl,
        clock: () => {
          if (clockFails) throw new Error('drain boom')
          return new Date(clockNow)
        },
        signals,
        report: async error => {
          reported.push(error)
        }
      })
      clockFails = true
      await requestGameStats(db, gameId)
      await until('the report', () => reported.length > 0, 2000)
      expect(process.exitCode).equals(1)
      expect(reported.map(error => (error as Error).message)).deep.equals([
        'drain boom'
      ])
      process.exitCode = 0
      handle = undefined
    } finally {
      console.log = originalLog
      if (handle != null) await handle.stop('SIGTERM')
    }
  })

  it('drains when the feed returns after a loss, and keeps running', async function () {
    const originalLog = console.log
    console.log = () => undefined
    const lines: string[] = []
    const reported: unknown[] = []
    const exitCode = process.exitCode
    const feed = new PostgresFeed({
      databaseUrl: scratchUrl,
      retryMs: 300,
      log: line => lines.push(line)
    })
    const handle = await runStatsBuilder({
      databaseUrl: scratchUrl,
      feed,
      signals: new EventEmitter(),
      report: async error => {
        reported.push(error)
      }
    })
    try {
      expect(handle.feed).equals(feed)
      const gameId = makeId('game')
      const statusOf = async (): Promise<string | undefined> =>
        (
          await db
            .selectFrom('game_stats_state')
            .select('status')
            .where('game_id', '=', gameId)
            .executeTakeFirst()
        )?.status
      await sql`
        select pg_terminate_backend(pid) from pg_stat_activity
        where datname = ${scratchName}
          and application_name = ${FEED_APPLICATION_NAME}`.execute(db)
      await until(
        'the loss',
        () => lines.some(line => line.includes('lost the feed')),
        2000
      )
      // Asked for while nobody hears: only the return can find it.
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
      expect(await statusOf()).not.equals('built')
      for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
        if ((await statusOf()) === 'built') break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(await statusOf()).equals('built')
      expect(reported).deep.equals([])
      expect(process.exitCode).equals(exitCode)
    } finally {
      await handle.stop('SIGTERM')
      console.log = originalLog
    }
  })

  it('fails to start on a database it cannot reach, leaving nothing open', async function () {
    const signals = new EventEmitter()
    const lines: string[] = []
    const missing = adminUrl.replace(/\/[^/]*$/, `/${scratchName}_missing`)
    const failure = await runStatsBuilder({
      databaseUrl: missing,
      feed: new PostgresFeed({
        databaseUrl: missing,
        log: line => lines.push(line)
      }),
      signals
    }).then(
      () => undefined,
      (error: unknown) => error
    )
    expect(String(failure)).includes('does not exist')
    expect(lines.length).equals(1)
    expect(signals.listenerCount('SIGTERM')).equals(0)
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(lines.length).equals(1)
  })

  it('queries through the request address as its role, and listens on the database', async function () {
    const originalLog = console.log
    console.log = () => undefined
    const namesOn = async (config: {
      databaseUrl: string
      databasePoolUrl: string
    }): Promise<string[]> => {
      const handle = await runMain(config)
      const { rows } = await sql<{ name: string; query: string }>`
        select application_name as name, query from pg_stat_activity
        where datname = ${scratchName}
          and application_name <> ''
          and pid <> pg_backend_pid()`.execute(db)
      await handle.stop('SIGTERM')
      return rows.map(row => row.name).sort()
    }
    try {
      expect(
        await namesOn({ databaseUrl: scratchUrl, databasePoolUrl: '' })
      ).deep.equals([FEED_APPLICATION_NAME, 'teamstation-statsBuilder'])
      // The name a URL carries beats the role's, so it shows which URL it is.
      expect(
        await namesOn({
          databaseUrl: scratchUrl,
          databasePoolUrl: `${scratchUrl}?application_name=thePool`
        })
      ).deep.equals([FEED_APPLICATION_NAME, 'thePool'])
    } finally {
      console.log = originalLog
    }
  })
})
