import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import type { GumboPlay } from '../../common/gumboPlay'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { REPLAY_SEED, seedReplay } from '../dev/replaySeed'
import { battingLines, pitchingLines } from '../stats'
import {
  boxScoreOrder,
  gamePlays,
  pitchersInOrder,
  pitchingOrder
} from './boxScoreOrder'
import { statRows } from './rows'

const cole = 101
const holmes = 102
const weaver = 103
const loaisiga = 104

function play(
  atBatIndex: number,
  pitcher: number | undefined,
  playEvents?: unknown[]
): GumboPlay {
  return {
    about: { atBatIndex, inning: 1, halfInning: 'top' },
    result: { eventType: 'field_out' },
    matchup: pitcher == null ? {} : { pitcher: { id: pitcher } },
    ...(playEvents == null ? {} : { playEvents })
  } as unknown as GumboPlay
}

const pitch = (index: number, player: number): unknown => ({
  index,
  isPitch: true,
  player: { id: player }
})
const change = (index: number, player: number, replaced: number): unknown => ({
  index,
  details: { eventType: 'pitching_substitution' },
  player: { id: player },
  replacedPlayer: { id: replaced }
})

describe('pitchersInOrder', function () {
  it('lists the starter first, however many outs a reliever gets', function () {
    expect(
      pitchersInOrder([
        play(0, cole),
        play(1, cole),
        play(2, holmes, [change(0, holmes, cole), pitch(1, holmes)]),
        play(3, holmes),
        play(4, holmes)
      ])
    ).deep.equals([cole, holmes])
  })

  it('puts a pitcher changed mid at-bat before the one who replaced them', function () {
    expect(
      pitchersInOrder([
        play(0, weaver, [
          pitch(0, cole),
          pitch(1, cole),
          change(2, weaver, cole),
          pitch(3, weaver)
        ])
      ])
    ).deep.equals([cole, weaver])
  })

  it('takes the replaced pitcher from the change when the pitches name nobody', function () {
    expect(
      pitchersInOrder([
        play(0, weaver, [
          { index: 0, isPitch: true },
          change(1, weaver, cole),
          { index: 2, isPitch: true }
        ])
      ])
    ).deep.equals([cole, weaver])
  })

  it('follows several changes in one play in the order they were made', function () {
    expect(
      pitchersInOrder([
        play(0, loaisiga, [
          change(3, loaisiga, holmes),
          pitch(0, cole),
          change(1, holmes, cole),
          pitch(2, holmes),
          pitch(4, loaisiga)
        ])
      ])
    ).deep.equals([cole, holmes, loaisiga])
  })

  it('orders imported plays without pitches by the pitcher of each play', function () {
    expect(
      pitchersInOrder([play(0, weaver), play(1, weaver), play(2, cole)])
    ).deep.equals([weaver, cole])
  })

  it('skips plays and events that name no pitcher', function () {
    expect(
      pitchersInOrder([
        play(0, undefined),
        play(1, undefined, [{ index: 0, isPitch: true, player: 'cole' }]),
        play(2, cole, 'not a list' as unknown as unknown[])
      ])
    ).deep.equals([cole])
  })

  it('answers no pitchers for a game with no plays', function () {
    expect(pitchersInOrder([])).deep.equals([])
  })
})

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
