import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { storedRecordOf } from '../../common/scoring/gumbo'
import { userIdOfGumbo } from '../../common/userId'
import type { Database } from '../../server/db/database'
import { importedRecordsReport } from '../../server/dev/importedRecords'
import { convertImportedGames } from '../../server/events/convertImportedGames'
import * as importedWriteModule from '../../server/events/importedWrite'
import { migrateUp } from '../runner'
import {
  createMigratedDatabase,
  dropScratchDatabase,
  testDatabaseUrl,
  testDatabaseUrlOf
} from '../testDatabase'
import { migration122ImportedRecords as migration } from './122importedRecords'
import { migrations } from './index'

/**
 * The stored imported games get the records their plays came without, and
 * nothing else of any game changes: a game scored in TeamStation, a game
 * whose turn at bat names nobody and a final score alone are left as they
 * are, and a second run writes nothing.
 */

type Json = Record<string, unknown>

const plays = JSON.parse(
  readFileSync('src/common/scoring/fixtures/imported/inventedGame.json', 'utf8')
) as Json[]

describe('imported games given their records', function () {
  this.timeout(120000)
  const name = `teamstation_imported_records_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool
  let db: Kysely<Database>

  const insert = async (
    gameId: string,
    gumbos: Json[],
    options: { owner?: string; status?: string } = {}
  ): Promise<void> => {
    await pool.query(
      `insert into games(id,home_team_id,away_team_id,start_at,status,"scoringOwner")
       values ($1,'tem_home','tem_away',now(),$2,$3)`,
      [gameId, options.status ?? 'final', options.owner ?? null]
    )
    for (const [index, gumbo] of gumbos.entries())
      await pool.query(
        `insert into events(id,"gameId",gumbo,source) values ($1,$2,$3,$4)`,
        [
          `evt_${gameId}_${index}`,
          gameId,
          JSON.stringify(gumbo),
          options.owner === 'teamstation' ? 'teamstation' : 'external'
        ]
      )
  }

  const stored = async (gameId: string): Promise<Json[]> =>
    (
      await pool.query(
        `select gumbo from events where "gameId" = $1 order by "atBatIndex"`,
        [gameId]
      )
    ).rows.map((row: { gumbo: Json }) => row.gumbo)

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await createMigratedDatabase(
      admin,
      name,
      migrations.filter(m => m.name !== migration.name)
    )
    pool = new Pool({ connectionString: testDatabaseUrlOf(name) })
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    await pool.query(
      `insert into teams(id,name) values ('tem_home','Hosts'),('tem_away','Visitors')`
    )
    // The invented game's people, 1000 to 1010, as accounts of this database.
    for (let id = 1000; id <= 1010; id++) {
      const userId = userIdOfGumbo(id)
      await pool.query(
        'insert into users (id, display_name, login_enabled) values ($1, $2, false)',
        [userId, `Player ${id}`]
      )
      await pool.query(
        'insert into gumbo_ids (gumbo_id, user_id) values ($1, $2)',
        [id, userId]
      )
    }
    await insert('gam_imported', plays)
    // A scored game: its plays, record and all, stay exactly as they are.
    await insert(
      'gam_scored',
      [{ ...plays[0], teamStation: { version: 3, actions: [] } }],
      { owner: 'teamstation' }
    )
    const unnamed = structuredClone(plays)
    unnamed[2] = {
      ...unnamed[2],
      matchup: { ...(unnamed[2].matchup as Json), batter: { id: null } }
    }
    await insert('gam_unnamed', unnamed)
    await insert('gam_score', [
      {
        about: { atBatIndex: 0, inning: 7, halfInning: 'bottom' },
        result: { eventType: 'final_score', awayScore: 2, homeScore: 5 },
        count: { outs: 3 }
      }
    ])
    await pool.query(
      `insert into game_stats_state(game_id,requested_generation,built_generation,status,attempts)
       values ('gam_imported',2,2,'built',0)`
    )
  })

  after(async function () {
    await db?.destroy()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
  })

  it('gives the imported game its records, and leaves every other game as it is', async function () {
    const scored = await stored('gam_scored')
    const unnamed = await stored('gam_unnamed')
    const score = await stored('gam_score')
    // Everything of an event but its document: tags, offsets, times, links.
    const columns = async (): Promise<unknown[]> =>
      (
        await pool.query(
          `select to_jsonb(e) - 'gumbo' - 'updatedAt' as row from events e where "gameId" = 'gam_imported' order by "atBatIndex"`
        )
      ).rows
    const before = await columns()
    const touched = async (gameId: string): Promise<number> =>
      new Date(
        (
          await pool.query('select updated_at from games where id = $1', [
            gameId
          ])
        ).rows[0].updated_at
      ).getTime()
    const touchedBefore = await touched('gam_imported')
    const scoredTouched = await touched('gam_scored')
    await migrateUp(pool, migrations)
    expect(await columns()).deep.equals(before)
    // What reads the game's plays is told they changed; a game left is not.
    expect(await touched('gam_imported')).greaterThan(touchedBefore)
    expect(await touched('gam_scored')).equals(scoredTouched)
    const imported = await stored('gam_imported')
    expect(imported).length(plays.length)
    expect(imported.every(play => storedRecordOf(play) != null)).equals(true)
    // Scores, times and the people named stay as they were.
    for (const [index, play] of imported.entries()) {
      expect(play.result).deep.include({
        awayScore: (plays[index].result as Json).awayScore,
        homeScore: (plays[index].result as Json).homeScore
      })
      expect(play.matchup).deep.equals(plays[index].matchup)
      expect(play.about).deep.equals(plays[index].about)
    }
    expect(await stored('gam_scored')).deep.equals(scored)
    expect(await stored('gam_unnamed')).deep.equals(unnamed)
    expect(await stored('gam_score')).deep.equals(score)
    const queued = (
      await pool.query(
        `select requested_generation::int, status from game_stats_state where game_id = 'gam_imported'`
      )
    ).rows[0] as { requested_generation: number; status: string }
    expect(queued).deep.equals({ requested_generation: 3, status: 'pending' })
  })

  it('writes nothing on a second run, and lists what it leaves', async function () {
    const before = await stored('gam_imported')
    const again = await convertImportedGames(db)
    expect(again.plays).equals(0)
    expect(again.unnamedPlayers).deep.equals(['gam_unnamed'])
    expect(again.noPlayByPlay).deep.equals(['gam_score'])
    expect(await stored('gam_imported')).deep.equals(before)
    const preview = await convertImportedGames(db, { preview: true })
    expect(preview.failed).deep.equals([])
    // Built again, the records come out as they were, and nothing is written.
    const rebuilt = await convertImportedGames(db, { rebuild: true })
    expect(rebuilt.games).equals(1)
    expect(rebuilt.plays).equals(0)
    expect(await stored('gam_imported')).deep.equals(before)
  })

  it('leaves a game whose conversion fails in the migration, and goes on', async function () {
    const before = await stored('gam_imported')
    const module = importedWriteModule as { writeImportedRecords: unknown }
    const real = importedWriteModule.writeImportedRecords
    // As on a schema a later converter reads and this migration predates.
    module.writeImportedRecords = async (
      trx: Kysely<Database>,
      ...rest: Parameters<typeof real> extends [unknown, ...infer R] ? R : never
    ) => {
      await sql`update events set gumbo = '{}' where "gameId" = 'gam_imported'`.execute(
        trx
      )
      await sql`select no_such_column from events`.execute(trx)
      return await real(trx, ...rest)
    }
    try {
      const out = await db.transaction().execute(
        async trx =>
          await convertImportedGames(trx, {
            inTransaction: true,
            rebuild: true
          })
      )
      expect(out.failed.map(one => one.gameId)).deep.equals([
        'gam_imported',
        'gam_score',
        'gam_unnamed'
      ])
    } finally {
      module.writeImportedRecords = real
    }
    // Rolled back to its savepoint: as it was, and the transaction kept.
    expect(await stored('gam_imported')).deep.equals(before)
  })

  it('reports as `npm run imported-records` prints, for the games named', async function () {
    const report = await importedRecordsReport(db, [
      '--game',
      'gam_imported',
      '--game',
      'gam_unnamed',
      '--preview',
      '--rebuild'
    ])
    expect(report).deep.equals({
      preview: true,
      games: 1,
      plays: 0,
      corrections: report.corrections,
      unnamedPlayers: 1,
      noPlayByPlay: 0,
      unreadable: [],
      failed: []
    })
    let refused: unknown
    try {
      await importedRecordsReport(db, ['--everything'])
    } catch (error) {
      refused = error
    }
    expect(String(refused)).include('Unknown argument --everything')
  })
})
