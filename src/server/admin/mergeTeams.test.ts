import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

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
import { mergeTeams } from './mergeTeams'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_mergeteams_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

/**
 * The real shape of the problem, in miniature.
 *
 * One fixture, written down twice by two clubs who disagreed about which of
 * them was at home. The club that kept score has the plays and no video; the
 * club that filmed it has the video and nothing else. That is not a contrived
 * case — it is the QPLL playoffs, where every team entered its opponent by
 * hand as a new team.
 */
describe('merging two rows that are one team', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let pool: Pool | undefined
  let db: Kysely<Database> | undefined

  const hawks = makeId('team')
  const houser = makeId('team')
  const widows = makeId('team')
  const scoredGame = makeId('game')
  const filmedGame = makeId('game')
  const videoId = makeId('video')
  const startAt = new Date('2026-05-20T23:45:00.000Z')

  before(async function () {
    attachInt8Parser()
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
    pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })

    await db
      .insertInto('teams')
      .values([
        { id: hawks, name: 'Alta Hawks', kind: 'full' },
        { id: houser, name: 'NP5 Maddux', kind: 'external' },
        { id: widows, name: 'Bay Widows', kind: 'full' }
      ])
      .execute()

    // Scored by the Widows' club: they were away, Houser — really the Hawks —
    // were at home. 14-4, with plays.
    await db
      .insertInto('games')
      .values({
        id: scoredGame,
        home_team_id: houser,
        away_team_id: widows,
        start_at: startAt,
        status: 'final',
        home_score: 4,
        away_score: 14
      })
      .execute()
    await db
      .insertInto('events')
      .values(
        [0, 1, 2].map(index => ({
          id: makeId('event'),
          gameId: scoredGame,
          battingTeamId: widows,
          source: 'external' as const,
          gumbo: {
            about: { atBatIndex: index },
            result: { eventType: 'single', awayScore: 14, homeScore: 4 }
          }
        }))
      )
      .execute()

    // The Hawks' own record of the same fixture: sides the other way round,
    // never scored, but it is the one with the video on it.
    await db
      .insertInto('games')
      .values({
        id: filmedGame,
        home_team_id: widows,
        away_team_id: hawks,
        start_at: startAt,
        status: 'scheduled'
      })
      .execute()
    await db
      .insertInto('videos')
      .values({
        id: videoId,
        game_id: filmedGame,
        kind: 'program',
        title: '2026-05-20 Hawks vs Bay Widows',
        storage: 'peertube',
        status: 'ready'
      })
      .execute()
  })

  after(async function () {
    if (db != null) await db.destroy()
    else if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  it('writes nothing without being asked to', async function () {
    if (db == null) this.skip()
    const report = await mergeTeams(db, {
      fromTeamId: houser,
      intoTeamId: hawks
    })
    expect(report.applied).equals(false)
    expect(report.fixtures.length).equals(1)
    expect(report.fixtures[0].orientationDiffers).equals(true)

    const still = await db
      .selectFrom('games')
      .select('id')
      .where('id', '=', filmedGame)
      .executeTakeFirst()
    expect(still != null, 'the game is still there').equals(true)
  })

  it('keeps the scored game and moves the video onto it', async function () {
    if (db == null) this.skip()
    const report = await mergeTeams(db, {
      fromTeamId: houser,
      intoTeamId: hawks,
      apply: true
    })
    expect(report.applied).equals(true)
    expect(report.fixtures[0].keptGameId).equals(scoredGame)
    expect(report.fixtures[0].videosMoved).equals(1)

    const game = await db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', scoredGame)
      .executeTakeFirstOrThrow()

    // The orientation of the record that holds the plays is preserved, so the
    // 59 real events never have to have their scores swapped round.
    expect(game.home_team_id, 'the Hawks were at home').equals(hawks)
    expect(game.away_team_id).equals(widows)
    expect(game.away_score).equals(14)
    expect(game.home_score).equals(4)

    const video = await db
      .selectFrom('videos')
      .select('game_id')
      .where('id', '=', videoId)
      .executeTakeFirstOrThrow()
    expect(video.game_id, 'the video followed').equals(scoredGame)

    const gone = await db
      .selectFrom('games')
      .select('id')
      .where('id', '=', filmedGame)
      .executeTakeFirst()
    expect(gone == null, 'the emptier row is gone').equals(true)

    const team = await db
      .selectFrom('teams')
      .select('merged_into')
      .where('id', '=', houser)
      .executeTakeFirstOrThrow()
    expect(team.merged_into).equals(hawks)

    const owed = await db
      .selectFrom('game_stats_state')
      .selectAll()
      .where('game_id', '=', scoredGame)
      .executeTakeFirstOrThrow()
    expect(Number(owed.requested_generation)).greaterThan(
      Number(owed.built_generation)
    )
    expect(owed.status).equals('pending')
  })

  it('refuses to merge a team into itself', async function () {
    if (db == null) this.skip()
    let refused = false
    try {
      await mergeTeams(db, { fromTeamId: hawks, intoTeamId: hawks })
    } catch {
      refused = true
    }
    expect(refused).equals(true)
  })

  it('a drain after merge writes rows with the surviving team id', async function () {
    if (db == null) this.skip()
    // Fresh pair: fromTeam is home, intoTeam is the survivor name for team_id.
    const from = makeId('team')
    const into = makeId('team')
    const opponent = makeId('team')
    const game = makeId('game')
    const held = new Set<number>()
    const mint = (): { userId: number; legacyId: string } => {
      const made = mintUserId(id => held.has(id))
      held.add(made.userId)
      return made
    }
    const batter = mint()
    const pitcher = mint()
    const now = new Date()
    await db
      .insertInto('teams')
      .values([
        { id: from, name: 'From', kind: 'external' },
        { id: into, name: 'Into', kind: 'full' },
        { id: opponent, name: 'Opp', kind: 'full' }
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
    await db
      .insertInto('games')
      .values({
        id: game,
        home_team_id: from,
        away_team_id: opponent,
        start_at: now
      })
      .execute()
    await replaceGameEvents(db, {
      gameId: game,
      homeTeamId: from,
      awayTeamId: opponent,
      plays: [
        {
          gumbo: {
            about: { atBatIndex: 0, inning: 1, halfInning: 'bottom' },
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
          },
          source: 'manual'
        }
      ]
    })
    await mergeTeams(db, { fromTeamId: from, intoTeamId: into, apply: true })
    const { drain } = await import('../statsBuilder/builder')
    await drain(db, () => new Date('2026-09-25T12:00:00.000Z'))
    const rows = await db
      .selectFrom('game_player_stats')
      .select(['gumbo_id', 'team_id'])
      .where('game_id', '=', game)
      .execute()
    expect(rows.length).greaterThan(0)
    const bat = rows.find(row => Number(row.gumbo_id) === batter.userId)!
    expect(bat.team_id).equals(into)
  })
})
