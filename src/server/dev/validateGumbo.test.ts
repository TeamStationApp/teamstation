import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import type { GumboPlay } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { type Database, makeDatabase } from '../db/database'
import { replaceGameEvents } from '../events/eventWrite'
import { runValidate, validateStoredPlays } from './validateGumbo'

/**
 * `npm run validate-gumbo` against a scratch database: every stored play and
 * every at-bat in progress is checked, and each violation is printed under
 * its game and play.
 */
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_validate_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const home = makeId('team')
const away = makeId('team')

/** A play another service posted: a single, with the batter to first. */
function posted(atBatIndex: number, end: unknown = '1B'): GumboPlay {
  return {
    about: { atBatIndex, inning: 1, halfInning: 'top' },
    result: { eventType: 'single', awayScore: 0, homeScore: 0 },
    count: { outs: 0 },
    runners: [
      {
        movement: { start: null, end, isOut: false },
        details: { eventType: 'single' }
      }
    ]
  } as unknown as GumboPlay
}

describe('validate-gumbo', function () {
  this.timeout(60000)

  let admin: Pool
  let db: Kysely<Database>
  let clean = ''
  let broken = ''

  async function newGame(currentPlay: unknown = null): Promise<string> {
    const id = makeId('game')
    await db
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date(),
        currentPlay: currentPlay == null ? null : JSON.stringify(currentPlay)
      })
      .execute()
    return id
  }
  async function store(gameId: string, plays: GumboPlay[]): Promise<void> {
    await replaceGameEvents(db, {
      gameId,
      homeTeamId: home,
      awayTeamId: away,
      plays: plays.map(gumbo => ({ gumbo, source: 'external' as const }))
    })
  }

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    await db
      .insertInto('teams')
      .values([
        { id: home, name: 'Home', kind: 'full' },
        { id: away, name: 'Away', kind: 'full' }
      ])
      .execute()
    clean = await newGame()
    await store(clean, [posted(0), posted(1)])
    await newGame()
    broken = await newGame({
      about: { atBatIndex: 2, inning: 1, halfInning: 'top', isComplete: false },
      playEvents: [{ type: 'pitch', isPitch: true, details: { code: 'Q7' } }]
    })
    await store(broken, [posted(0), posted(1, 2)])
  })

  after(async function () {
    if (db != null) await db.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  it('prints each violation under its game and play, and exits 1', async function () {
    const lines: string[] = []
    expect(await runValidate(db, line => lines.push(line))).equals(1)
    expect(lines).deep.equals([
      broken,
      '  play 1: runners[0].movement.end expected null or string, got 2 (runner)',
      '  the at-bat in progress: playEvents[0].details.code "Q7" is not a pitch code (pitchCode)',
      '2 violations in 1 games; 5 plays checked'
    ])
  })

  it('finds nothing in Gumbo plays, and exits 0', async function () {
    await store(broken, [posted(0), posted(1)])
    await db
      .updateTable('games')
      .set({ currentPlay: null })
      .where('id', '=', broken)
      .execute()
    expect(await validateStoredPlays(db)).deep.equals({
      games: [],
      checked: 4
    })
    const lines: string[] = []
    expect(await runValidate(db, line => lines.push(line))).equals(0)
    expect(lines).deep.equals(['0 violations in 0 games; 4 plays checked'])
  })
})
