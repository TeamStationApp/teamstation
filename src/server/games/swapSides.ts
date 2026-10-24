import type { Kysely, Transaction } from 'kysely'

import { conflict, notFound } from '../../common/errors'
import { storedGuests } from '../../common/guests'
import { recordOf } from '../../common/scoring/gumbo'
import { pregameRecord } from '../../common/scoring/sideSwap'
import { recordByTeam } from '../../common/scoring/teamRecord'
import { keyedBySide, listsByTeam, teamsOfRow } from '../../common/teamLists'
import { storedUnrostered } from '../../common/unroster'
import type { Database } from '../db/database'
import { changedLineupsDigest } from '../events/teamLineups'
import { recordIn } from '../events/wireRecords'
import { notifyGameChange } from '../socket/gameChanges'
import { noteGameFigures } from '../socket/syncRevision'
import { gameHasPlays } from './fenceDistance'

export const SWAP_REFUSED =
  'Home and away can be swapped only before the first pitch'

/**
 * Whether a game may still swap home and away: neither under way nor final,
 * no play stored, and its open at-bat, if any, holds only lineup changes. A
 * game scored elsewhere has no plays here, but its status still says it
 * started.
 */
export async function maySwapSides(
  trx: Kysely<Database>,
  game: { id: string; currentPlay: unknown; status: string }
): Promise<boolean> {
  return (
    game.status !== 'inProgress' &&
    game.status !== 'final' &&
    pregameRecord(game.currentPlay) &&
    !(await gameHasPlays(trx, game.id))
  )
}

/**
 * Swaps a game's home and away teams before its first pitch. Everything it
 * keeps about its teams is stored by team (its pregame lineups, its guests
 * and the players left off), so only the two team ids and the scores are
 * exchanged; the lineups digest changes, so a device still holding the old
 * sides is refused as stale. Pregame lineups still stored by side, as an
 * older post or record left them, are first written by team, as the game
 * stood.
 *
 * Runs in the caller's transaction, which took `lockPlayerEdits` before any
 * `games` row lock, as every roster writer does; it may hold this game's
 * row already.
 */
export async function swapGameSides(
  trx: Transaction<Database>,
  gameId: string
): Promise<void> {
  const game = await trx
    .selectFrom('games')
    .selectAll()
    .where('id', '=', gameId)
    .forUpdate()
    .executeTakeFirst()
  if (game == null) throw notFound()
  if (!(await maySwapSides(trx, game))) throw conflict(SWAP_REFUSED)
  const before = teamsOfRow(game)
  const teams = {
    home_team_id: game.away_team_id,
    away_team_id: game.home_team_id
  }
  // The pregame lineups, wherever an older write left them: on the game's
  // at-bat in progress before records lived apart from it.
  const raw = game.pregame ?? recordIn(game.currentPlay)
  const record = raw == null ? null : recordOf({ teamStation: raw }, before)
  const digest = await changedLineupsDigest(
    trx,
    game,
    'sides',
    teams.home_team_id,
    teams.away_team_id
  )
  await trx
    .updateTable('games')
    .set({
      ...teams,
      home_score: game.away_score,
      away_score: game.home_score,
      // Lists still keyed by side are written by team, so they follow it.
      ...(keyedBySide(game.guests, before)
        ? { guests: listsByTeam(storedGuests(game.guests, before), before) }
        : {}),
      ...(keyedBySide(game.unrostered, before)
        ? {
            unrostered: listsByTeam(
              storedUnrostered(game.unrostered, before),
              before
            )
          }
        : {}),
      ...(record == null
        ? {}
        : { currentPlay: null, pregame: recordByTeam(record, before) }),
      lineups_digest: digest,
      updated_at: new Date()
    })
    .where('id', '=', gameId)
    .execute()
  // The teams' lists show the game on its new side, and every screen
  // holding it reads its sides, lineups and at-bat again.
  await noteGameFigures(trx, gameId)
  await notifyGameChange(trx, { game: gameId, kind: 'game' })
  if (record != null) {
    await notifyGameChange(trx, { game: gameId, kind: 'plays' })
    await notifyGameChange(trx, { game: gameId, kind: 'lineups' })
  }
}
