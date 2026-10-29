import { type Kysely, sql } from 'kysely'

import {
  type GumboViolation,
  gumboViolations
} from '../../common/gumbo/validate'
import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import { type Database, makeDatabase } from '../db/database'
import { resolveScoringGame } from '../scoring/openRow'
import { serverConfig } from '../serverConfig'

/**
 * Checks every stored play, and every at-bat in progress, against MLB's code
 * lists and the live feed's shapes (`src/common/gumbo/validate.ts`), as each
 * game is read: named from its players' accounts (`resolveScoringGame`).
 *
 *   npm run validate-gumbo
 *
 * Prints each game that holds a violation, with every violation under the
 * play it is in, then a count. Exits 1 when there is any, and 0 otherwise.
 * Nothing is written.
 */

export interface PlayViolations {
  /** `play <atBatIndex>`, or `the at-bat in progress`. */
  play: string
  violations: GumboViolation[]
}
export interface GameViolations {
  gameId: string
  plays: PlayViolations[]
}
export interface ValidateReport {
  games: GameViolations[]
  /** Stored plays and at-bats in progress checked. */
  checked: number
}

/** Games with a stored play or an at-bat in progress, by id. */
async function gamesWithPlays(db: Kysely<Database>): Promise<string[]> {
  const rows = await sql<{ id: string }>`
    select distinct "gameId" as id from events
    union
    select id from games where "currentPlay" is not null
    order by id
  `.execute(db)
  return rows.rows.map(row => row.id)
}

/** Checks every stored play of every game, named; writes nothing. */
export async function validateStoredPlays(
  db: Kysely<Database>
): Promise<ValidateReport> {
  const report: ValidateReport = { games: [], checked: 0 }
  for (const gameId of await gamesWithPlays(db)) {
    const rows = await db
      .selectFrom('events')
      .select(['atBatIndex', 'gumbo'])
      .where('gameId', '=', gameId)
      .orderBy('atBatIndex')
      .execute()
    const game = await db
      .selectFrom('games')
      .select('currentPlay')
      .where('id', '=', gameId)
      .executeTakeFirst()
    // Checked as they are read: named from the players' accounts. A game
    // whose accounts cannot be resolved is checked as stored.
    const stored = {
      plays: rows.map(row => row.gumbo as GumboPlay),
      currentPlay: (game?.currentPlay ?? null) as CurrentPlay | null
    }
    const named = await resolveScoringGame(db, stored).catch(() => stored)
    const documents: Array<{ play: string; document: unknown }> = rows.map(
      (row, index) => ({
        play: `play ${row.atBatIndex}`,
        document: named.plays[index]
      })
    )
    if (named.currentPlay != null)
      documents.push({
        play: 'the at-bat in progress',
        document: named.currentPlay
      })
    const plays: PlayViolations[] = []
    for (const { play, document } of documents) {
      report.checked += 1
      const violations = gumboViolations(document)
      if (violations.length > 0) plays.push({ play, violations })
    }
    if (plays.length > 0) report.games.push({ gameId, plays })
  }
  return report
}

/** Runs the check against `db`, printing to `print`; the exit code. */
export async function runValidate(
  db: Kysely<Database>,
  print: (line: string) => void
): Promise<number> {
  const report = await validateStoredPlays(db)
  let total = 0
  for (const game of report.games) {
    print(game.gameId)
    for (const play of game.plays)
      for (const violation of play.violations) {
        total += 1
        print(
          `  ${play.play}: ${violation.path} ${violation.message} (${violation.rule})`
        )
      }
  }
  print(
    `${total} violations in ${report.games.length} games; ` +
      `${report.checked} plays checked`
  )
  return total > 0 ? 1 : 0
}

async function main(): Promise<void> {
  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    process.exitCode = await runValidate(db, line => {
      console.log(line)
    })
  } finally {
    await db.destroy()
  }
}

const entry = process.argv[1] ?? ''
if (
  entry.endsWith('/validateGumbo.ts') ||
  entry.endsWith('/validateGumbo.js')
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
