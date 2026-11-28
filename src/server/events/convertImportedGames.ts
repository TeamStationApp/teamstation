import { type Kysely, sql } from 'kysely'

import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { requireNamedSides } from '../games/namedSides'
import { notifyPlaysChanged } from '../socket/gameChanges'
import { noteScopeChange } from '../socket/syncRevision'
import { requestGameStats } from '../statsBuilder/request'
import { writeImportedRecords } from './importedWrite'

/**
 * Gives the stored games that an outside scorer posted, or a person typed
 * in, the records their plays came without: every game TeamStation does not
 * own that holds a play with no record. Each game is converted with its row
 * locked, as a post converts it (`writeImportedRecords`), and its statistics
 * are asked for again. A game whose turn at bat names nobody, or that holds
 * no turn at bat, is listed and left; it is converted once a later post or
 * re-link names its players. A play that has a record is never written again
 * unless its game's records are rebuilt, and those come out the same, so a
 * second run writes nothing.
 */

export interface ConvertedGames {
  /** Games given records. */
  games: number
  /** Plays written with a record. */
  plays: number
  /** Plays whose record needed a correction the events did not give. */
  corrections: number
  /** Games left because a turn at bat names nobody. */
  unnamedPlayers: string[]
  /** Games left because no play is a turn at bat (a final score alone). */
  noPlayByPlay: string[]
  /**
   * Games left because their records would not read: two merged accounts on
   * opposite sides, which the scoring screen refuses.
   */
  unreadable: string[]
  /** Games the converter could not read, with what stopped it. */
  failed: Array<{ gameId: string; reason: string }>
}

/** What a preview's transaction throws to write nothing. */
class Preview extends Error {}

export async function convertImportedGames(
  db: Kysely<Database>,
  options: {
    gameIds?: readonly string[]
    /** Work everything out, and write nothing. */
    preview?: boolean
    /** The caller holds a transaction already, as a migration does. */
    inTransaction?: boolean
    /**
     * Build again the records of every game TeamStation does not own, not
     * only of those holding a play without one: for a converter that reads
     * the plays better than the one that converted them.
     */
    rebuild?: boolean
  } = {}
): Promise<ConvertedGames> {
  let query = db
    .selectFrom('games')
    .select('id')
    .where(eb =>
      eb.or([
        eb('scoringOwner', 'is', null),
        eb('scoringOwner', '!=', 'teamstation')
      ])
    )
    .where(eb =>
      eb.exists(
        eb
          .selectFrom('events')
          .select('events.id')
          .whereRef('events.gameId', '=', 'games.id')
          .where(
            options.rebuild === true
              ? sql<boolean>`true`
              : sql<boolean>`not (events.gumbo ? 'teamStation')`
          )
      )
    )
    .orderBy('id')
  if (options.gameIds != null)
    query = query.where('id', 'in', [...options.gameIds, ''])
  const ids = (await query.execute()).map(row => row.id)
  const out: ConvertedGames = {
    games: 0,
    plays: 0,
    corrections: 0,
    unnamedPlayers: [],
    noPlayByPlay: [],
    unreadable: [],
    failed: []
  }
  for (const gameId of ids) {
    const convert = async (trx: Kysely<Database>): Promise<void> => {
      const game = requireNamedSides(
        await trx
          .selectFrom('games')
          .select([
            'id',
            'home_team_id',
            'away_team_id',
            'status',
            'scoringOwner'
          ])
          .where('id', '=', gameId)
          .forUpdate()
          .executeTakeFirstOrThrow()
      )
      const written = await writeImportedRecords(trx, game, { rebuild: true })
      // The repair is the moment to build its statistics again, and to tell
      // what reads the game's plays that they changed: the board's timeline
      // cached under `updated_at`, and every app following the game.
      if (written.rewritten.length > 0) {
        await requestGameStats(trx, gameId)
        await trx
          .updateTable('games')
          .set({ updated_at: new Date() })
          .where('id', '=', gameId)
          .execute()
        await notifyPlaysChanged(trx, gameId)
        // A migration runs before the server starts: there is nobody to tell.
        if (options.inTransaction !== true) noteScopeChange(trx, { gameId })
      }
      if (written.counts.unconvertible === 'unnamedPlayers')
        out.unnamedPlayers.push(gameId)
      else if (written.counts.unconvertible === 'noPlayByPlay')
        out.noPlayByPlay.push(gameId)
      else if (written.counts.unconvertible === 'unreadable')
        out.unreadable.push(gameId)
      else {
        out.games++
        out.plays += written.rewritten.length
        out.corrections += written.counts.corrections
      }
      if (options.preview === true) throw new Preview()
    }
    // Inside a migration each game is converted under a savepoint: one that
    // fails — even on a database a later release migrates, whose converter
    // reads a schema this migration predates — is rolled back alone and
    // listed, and the others are kept. `npm run imported-records` converts
    // it once the server runs, as a later post of its plays does.
    const inMigration =
      options.inTransaction === true && options.preview !== true
    try {
      if (inMigration) {
        await sql`savepoint convert_imported_game`.execute(db)
        await convert(db)
        await sql`release savepoint convert_imported_game`.execute(db)
      } else await atomic(db, convert)
    } catch (error) {
      if (error instanceof Preview) continue
      if (inMigration)
        await sql`rollback to savepoint convert_imported_game`.execute(db)
      out.failed.push({
        gameId,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return out
}
