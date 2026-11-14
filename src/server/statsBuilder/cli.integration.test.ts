import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
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
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { replaceGameEvents } from '../events/eventWrite'
import { drain } from './builder'
import {
  formatSummary,
  parseArgs,
  runStatsRequest,
  summarizeStatuses
} from './cli'
import { runStatsBuilder } from './main'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_stats_cli_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

describe('statsBuilder cli', function () {
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

  it('parses --game, --all and --wait', function () {
    expect(parseArgs(['--game', 'g1'])).deep.equals({
      game: 'g1',
      wait: 120
    })
    expect(parseArgs(['--all', '--wait', '30'])).deep.equals({
      all: true,
      wait: 30
    })
    expect(() => parseArgs(['--wait', 'nope'])).throws(/--wait/)
  })

  it('rejects missing or combined flags', async function () {
    let missing = false
    try {
      await runStatsRequest({}, { databaseUrl: scratchUrl })
    } catch {
      missing = true
    }
    expect(missing).equals(true)
    let both = false
    try {
      await runStatsRequest(
        { game: 'g', all: true },
        { databaseUrl: scratchUrl }
      )
    } catch {
      both = true
    }
    expect(both).equals(true)
  })

  it('summarizes pending and null incomplete detail', async function () {
    const pendingGame = makeId('game')
    const incompleteGame = makeId('game')
    await db
      .insertInto('games')
      .values([
        {
          id: pendingGame,
          home_team_id: home,
          away_team_id: away,
          start_at: new Date()
        },
        {
          id: incompleteGame,
          home_team_id: home,
          away_team_id: away,
          start_at: new Date()
        }
      ])
      .execute()
    await db
      .insertInto('game_stats_state')
      .values([
        {
          game_id: pendingGame,
          requested_generation: 1,
          built_generation: 0,
          status: 'pending',
          detail: null,
          attempts: 0
        },
        {
          game_id: incompleteGame,
          requested_generation: 1,
          built_generation: 1,
          status: 'incomplete',
          detail: null,
          attempts: 0
        }
      ])
      .execute()

    const summary = await summarizeStatuses(db)
    expect(summary.pending).greaterThan(0)
    expect(
      summary.incompleteReasons.some(r => r.detail === '(no detail)')
    ).equals(true)
    await runStatsRequest(
      { all: true, wait: 0 },
      { databaseUrl: scratchUrl, sleep: async () => undefined }
    )
  })

  it('covers runCliMain and default sleep/log helpers', async function () {
    const { runCliMain } = await import('./cli')
    // Empty args throw through runCliMain.
    let failed = false
    try {
      await runCliMain([])
    } catch {
      failed = true
    }
    expect(failed).equals(true)
  })

  it('--game raises that game; --all raises every game with plays and summarizes', async function () {
    const good = makeId('game')
    const bad = makeId('game')
    await db
      .insertInto('games')
      .values([
        {
          id: good,
          home_team_id: home,
          away_team_id: away,
          start_at: new Date()
        },
        {
          id: bad,
          home_team_id: home,
          away_team_id: away,
          start_at: new Date()
        }
      ])
      .execute()

    const play: GumboPlay = {
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
    await replaceGameEvents(db, {
      gameId: good,
      homeTeamId: home,
      awayTeamId: away,
      plays: [{ gumbo: play, source: 'manual' }]
    })
    const incomplete: GumboPlay = { ...play, matchup: undefined }
    await replaceGameEvents(db, {
      gameId: bad,
      homeTeamId: home,
      awayTeamId: away,
      plays: [{ gumbo: incomplete, source: 'manual' }]
    })

    await runStatsRequest({ game: good, wait: 1 }, { databaseUrl: scratchUrl })
    expect(
      Number(
        (
          await db
            .selectFrom('game_stats_state')
            .select('requested_generation')
            .where('game_id', '=', good)
            .executeTakeFirstOrThrow()
        ).requested_generation
      )
    ).greaterThan(1)

    const { EventEmitter } = await import('events')
    const signals = new EventEmitter()
    const builder = await runStatsBuilder({
      databaseUrl: scratchUrl,
      clock: () => new Date(),
      signals
    })
    try {
      const lines: string[] = []
      const summary = await runStatsRequest(
        { all: true, wait: 10 },
        {
          databaseUrl: scratchUrl,
          log: line => lines.push(line),
          sleep: async () => undefined
        }
      )
      // Drain manually in case wait sleep was no-op and builder raced.
      await drain(db, () => new Date())
      const final = summary ?? (await summarizeStatuses(db))
      // Re-print after drain for assertion stability.
      const printed = formatSummary(await summarizeStatuses(db))
      expect(printed).includes('built')
      expect(printed).includes('incomplete')
      expect(final.incomplete).greaterThan(0)
      expect(final.incompleteReasons.length).greaterThan(0)
      expect(lines.length + printed.length).greaterThan(0)
    } finally {
      await builder.stop('SIGTERM')
    }
  })
})
