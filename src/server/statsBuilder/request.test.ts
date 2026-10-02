import { expect } from 'chai'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { replaceGameEvents } from '../events/eventWrite'
import { requestAllGameStats, requestGameStats } from './request'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_stats_req_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

describe('statsBuilder request', function () {
  this.timeout(60000)

  let admin: Pool
  let pool: Pool
  let db: Kysely<Database>
  const home = makeId('team')
  const away = makeId('team')
  const gameId = makeId('game')
  const otherGame = makeId('game')
  const player = mintUserId(() => false)

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
    await db
      .insertInto('users')
      .values({
        id: player.userId,
        legacyId: player.legacyId,
        display_name: 'Ada',
        created_at: now,
        updated_at: now
      })
      .execute()
    await db
      .insertInto('games')
      .values([
        {
          id: gameId,
          home_team_id: home,
          away_team_id: away,
          start_at: now
        },
        {
          id: otherGame,
          home_team_id: home,
          away_team_id: away,
          start_at: now
        }
      ])
      .execute()
  })

  after(async function () {
    await db.destroy()
    await admin.query(`drop database if exists ${scratchName}`)
    await admin.end()
  })

  it('inserts pending generation 1, then raises and resets attempts', async function () {
    await requestGameStats(db, gameId)
    let row = await db
      .selectFrom('game_stats_state')
      .selectAll()
      .where('game_id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(Number(row.requested_generation)).equals(1)
    expect(row.status).equals('pending')
    expect(row.attempts).equals(0)
    expect(row.retry_at).equals(null)

    await db
      .updateTable('game_stats_state')
      .set({ attempts: 3, retry_at: new Date('2030-01-01T00:00:00Z') })
      .where('game_id', '=', gameId)
      .execute()

    await requestGameStats(db, gameId)
    row = await db
      .selectFrom('game_stats_state')
      .selectAll()
      .where('game_id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(Number(row.requested_generation)).equals(2)
    expect(row.status).equals('pending')
    expect(row.attempts).equals(0)
    expect(row.retry_at).equals(null)
  })

  it('notifies only after commit, never on rollback', async function () {
    const listen = new Client({ connectionString: scratchUrl })
    await listen.connect()
    await listen.query('listen game_stats')
    const seen: string[] = []
    listen.on('notification', msg => {
      if (msg.channel === 'game_stats') seen.push(msg.payload ?? '')
    })
    await new Promise(resolve => setTimeout(resolve, 50))

    await db.transaction().execute(async trx => {
      await requestGameStats(trx, otherGame)
      expect(seen).deep.equals([])
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(seen).deep.equals([otherGame])

    seen.length = 0
    try {
      await db.transaction().execute(async trx => {
        await requestGameStats(trx, otherGame)
        throw new Error('roll back')
      })
    } catch {
      // expected
    }
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(seen).deep.equals([])
    await listen.end()
  })

  it('replaceGameEvents leaves the game owed', async function () {
    const g = makeId('game')
    await db
      .insertInto('games')
      .values({
        id: g,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date()
      })
      .execute()
    await replaceGameEvents(db, {
      gameId: g,
      homeTeamId: home,
      awayTeamId: away,
      plays: [
        {
          gumbo: {
            about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
            result: { eventType: 'single', awayScore: 0, homeScore: 0 },
            count: { outs: 0 },
            matchup: {
              batter: { id: player.userId },
              pitcher: { id: player.userId }
            },
            runners: [
              {
                movement: { start: null, end: '1B', isOut: false },
                details: {
                  eventType: 'single',
                  runner: { id: player.userId }
                }
              }
            ]
          },
          source: 'manual'
        }
      ]
    })
    const row = await db
      .selectFrom('game_stats_state')
      .select(['requested_generation', 'built_generation', 'status'])
      .where('game_id', '=', g)
      .executeTakeFirstOrThrow()
    expect(Number(row.requested_generation)).greaterThan(
      Number(row.built_generation)
    )
    expect(row.status).equals('pending')
  })

  it('requestAllGameStats raises every game with plays', async function () {
    await sql`delete from game_stats_state`.execute(db)
    await requestAllGameStats(db)
    const rows = await db
      .selectFrom('game_stats_state')
      .select('game_id')
      .execute()
    const ids = new Set(rows.map(row => row.game_id))
    expect(ids.has(gameId) || ids.size >= 1).equals(true)
    // otherGame may lack events; games with events are requested.
    const withEvents = await db
      .selectFrom('events')
      .select('gameId')
      .distinct()
      .execute()
    for (const row of withEvents) {
      expect(ids.has(row.gameId)).equals(true)
    }
  })
})
