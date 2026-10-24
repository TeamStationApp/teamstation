import type { Kysely, Transaction } from 'kysely'

import { conflict, notFound } from '../../common/errors'
import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import { recordOf } from '../../common/scoring/gumbo'
import { ScoringSession } from '../../common/scoring/session'
import { pregameRecord } from '../../common/scoring/sideSwap'
import { recordByTeam } from '../../common/scoring/teamRecord'
import type { Database } from '../db/database'
import { postGamePlays } from '../events/postPlays'
import { changedLineupsDigest } from '../events/teamLineups'
import { resolveScoringGame } from '../scoring/openRow'
import { contextOf } from '../scoring/replayContext'
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
 * Swaps a game's home and away teams before its first pitch, and everything
 * that names a side with them: the scores, the guest and unrostered lists,
 * and the open at-bat's record, re-opened against the new teams so its
 * matchup and the lineups digest are written afresh. A device still holding
 * the old sides is then refused as stale.
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
  const teams = {
    home_team_id: game.away_team_id,
    away_team_id: game.home_team_id
  }
  // The record names teams, so it reads the same with the sides exchanged:
  // one stored before records did is written by team, as the game stood.
  const record = recordOf(game.currentPlay, {
    away: { id: game.away_team_id },
    home: { id: game.home_team_id }
  })
  const swapped = {
    ...teams,
    home_score: game.away_score,
    away_score: game.home_score,
    updated_at: new Date()
  }
  if (record == null) {
    const digest = await changedLineupsDigest(
      trx,
      game,
      'sides',
      teams.home_team_id,
      teams.away_team_id
    )
    await trx
      .updateTable('games')
      .set({ ...swapped, lineups_digest: digest })
      .where('id', '=', gameId)
      .execute()
  } else {
    const currentPlay = {
      ...(game.currentPlay as CurrentPlay),
      teamStation: recordByTeam(record, {
        away: { id: game.away_team_id },
        home: { id: game.home_team_id }
      })
    }
    await trx
      .updateTable('games')
      .set({ ...swapped, currentPlay })
      .where('id', '=', gameId)
      .execute()
    const stored = await resolveScoringGame(trx, {
      plays: [] as GumboPlay[],
      currentPlay
    })
    const context = (await contextOf(trx, gameId, teams, stored))!
    const session = await ScoringSession.open(
      {
        load: async () => stored,
        save: async () => {
          throw new Error('The swap writes through postGamePlays')
        }
      },
      gameId,
      context,
      { setTimer: () => null, clearTimer: () => undefined }
    )
    if (session.problem != null) throw conflict(session.problem)
    await postGamePlays(
      trx,
      gameId,
      asPostEventsBody({
        plays: [],
        currentPlay: session.picture().current,
        mode: 'live',
        source: { system: 'teamstation' }
      })
    )
  }
  // The teams' lists show the game on its new side. With a record, the
  // post above sent the game's notices; without one, nothing has.
  await noteGameFigures(trx, gameId)
  if (record == null)
    await notifyGameChange(trx, { game: gameId, kind: 'game' })
}
