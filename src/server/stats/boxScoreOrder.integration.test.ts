import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { REPLAY_SEED, seedReplay } from '../dev/replaySeed'
import { battingLines, pitchingLines } from '../stats'
import { boxScoreOrder, gamePlays, pitchingOrder } from './boxScoreOrder'
import { statRows } from './rows'

/** Every statement the replay database's pool runs, by its text. */
const statements: string[] = []
class CountingClient extends Client {
  override query(...args: any[]): any {
    if (typeof args[0] === 'string') statements.push(args[0])
    return (super.query as (...given: any[]) => any)(...args)
  }
}
const playsReads = (): number =>
  statements.filter(text =>
    text.includes('from "events" where "gameId" = $1 order by "atBatIndex"')
  ).length

describe('box score order from plays read once', function () {
  this.timeout(120000)

  const scratchName = `teamstation_boxscoreorder_${Date.now()}`
  const gameId = REPLAY_SEED.games.final
  let admin: Pool | undefined
  let db: Kysely<Database> | undefined

  before(async function () {
    attachInt8Parser()
    admin = new Pool({ connectionString: testDatabaseUrl })
    try {
      await admin.query('select 1')
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
      return
    }
    await admin.query(`create database ${scratchName}`)
    const pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${scratchName}`),
      Client: CountingClient
    })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    await seedReplay(db, {
      password: 'replay-test-password',
      clock: () => new Date('2026-09-26T17:00:00Z')
    })
  })

  after(async function () {
    if (db != null) await db.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  async function lines(): Promise<{
    batting: ReturnType<typeof battingLines>
    pitching: ReturnType<typeof pitchingLines>
    name: (line: { userId: string }) => string
  }> {
    const rows = await statRows(db!, { gameId })
    const names = new Map(
      rows.map(row => [row.userId, `${row.firstName} ${row.lastName}`])
    )
    return {
      batting: battingLines(rows),
      pitching: pitchingLines(rows),
      name: line => names.get(line.userId) ?? line.userId
    }
  }

  it('orders the final game as before, from one read of its plays', async function () {
    const { batting, pitching, name } = await lines()
    statements.length = 0
    const plays = await gamePlays(db!, gameId)
    const pitchers = await pitchingOrder(db!, gameId, pitching, plays)
    const batters = await boxScoreOrder(db!, gameId, batting, plays)
    expect(playsReads()).equals(1)
    expect(pitchers.map(name)).deep.equals([
      'Tyler Glasnow',
      'Gerrit Cole',
      'Luis Gil'
    ])
    expect(batters.map(name)).deep.equals(BATTING_ORDER)
    // Each reading the plays for itself gives the same order.
    expect((await pitchingOrder(db!, gameId, pitching)).map(name)).deep.equals(
      pitchers.map(name)
    )
    expect((await boxScoreOrder(db!, gameId, batting)).map(name)).deep.equals(
      batters.map(name)
    )
  })

  it('orders lines without a first appearance from the plays it is given, reading none', async function () {
    const { batting, name } = await lines()
    const old = batting.map(line => ({ ...line, firstPa: null }))
    const plays = await gamePlays(db!, gameId)
    statements.length = 0
    const given = await boxScoreOrder(db!, gameId, old, plays)
    expect(playsReads()).equals(0)
    const read = await boxScoreOrder(db!, gameId, old)
    expect(playsReads()).equals(1)
    expect(given.map(name)).deep.equals(read.map(name))
    expect(given.map(name)).deep.equals(BATTING_ORDER)
  })
})

/** The final game's batters as round2Base's box score ordered them. */
const BATTING_ORDER = [
  'Juan Soto',
  'Aaron Judge',
  'Anthony Rizzo',
  'Gleyber Torres',
  'Mookie Betts',
  'Freddie Freeman',
  'Shohei Ohtani',
  'Will Smith',
  'Anthony Volpe',
  'Luis Garcia',
  'Jose Trevino',
  'Giancarlo Stanton',
  'Luis Gil',
  'Max Muncy',
  'Teoscar Hernandez',
  'Rowan Pell',
  'James Outman',
  'Tyler Glasnow'
]
