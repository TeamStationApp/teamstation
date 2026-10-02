import { sql } from 'kysely'

import type { GumboPlay } from '../../common/gumboPlay'
import { halfOutcomes, lineScore } from '../../common/scoring/linescore'
import { makeDatabase } from '../db/database'
import { readPlays } from '../routes/events'
import { serverConfig } from '../serverConfig'

/**
 * Fills in the line score of every game that has plays but none, or one
 * written before line scores carried Gumbo's `innings`.
 *
 * `POST /games/:gameId/events` writes a game's line score with its plays, so
 * only a game whose plays were stored some other way, or not posted since,
 * lacks one. This works it out the same way, from the stored plays and the
 * game's own final score, so a line score and a final score cannot disagree.
 *
 *   npm run backfill-linescore -- --dry
 *   npm run backfill-linescore
 */
async function main(): Promise<void> {
  const dry = process.argv.includes('--dry')
  const db = makeDatabase(serverConfig.databaseUrl)

  try {
    const games = await db
      .selectFrom('games')
      .select(['id', 'home_score', 'away_score'])
      .where(sql<boolean>`linescore is null or not (linescore ? 'innings')`)
      .execute()

    let written = 0
    let skipped = 0
    for (const game of games) {
      const rows = await readPlays(db, game.id)
      const plays = rows.map(row => row.gumbo as GumboPlay)
      if (plays.length === 0) {
        skipped += 1
        continue
      }
      const linescore = lineScore(
        plays,
        halfOutcomes(plays),
        game.away_score,
        game.home_score
      )
      if (!dry) {
        await db
          .updateTable('games')
          .set({ linescore: sql`${JSON.stringify(linescore)}::jsonb` })
          .where('id', '=', game.id)
          .execute()
      }
      written += 1
    }

    console.log(`${dry ? 'would write' : 'wrote'} ${written} line scores`)
    console.log(`${skipped} games have no plays and were left alone`)
  } finally {
    await db.destroy()
  }
}

const entry = process.argv[1] ?? ''
if (
  entry.endsWith('/backfillLinescore.ts') ||
  entry.endsWith('/backfillLinescore.js')
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
