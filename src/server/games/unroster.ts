import type { Kysely } from 'kysely'

import type { UnrosterBody } from '../../common/api'
import { badRequest, conflict, forbidden, notFound } from '../../common/errors'
import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import { storedRecordOf } from '../../common/scoring/gumbo'
import { newSetup } from '../../common/scoring/lineup'
import { reconcileRoster } from '../../common/scoring/rosterAvailability'
import { awaitingResult } from '../../common/scoring/rules'
import { ScoringSession } from '../../common/scoring/session'
import { setupOf } from '../../common/scoring/state'
import { listsByTeam, teamsOfRow } from '../../common/teamLists'
import type { Unrostered } from '../../common/unroster'
import { isHeadCoach, roleScopes } from '../access'
import {
  lockPlayerEdits,
  survivorsOf,
  UnresolvedAccount
} from '../admin/people'
import type { Actor } from '../auth/sessions'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { atBatOf } from '../events/atBatInProgress'
import { postGamePlays, readPlays } from '../events/postPlays'
import { changedLineupsDigest } from '../events/teamLineups'
import { resolveScoringGame } from '../scoring/openRow'
import { contextOf } from '../scoring/replayContext'
import { notifyGameChange } from '../socket/gameChanges'
import { noteScopeChange } from '../socket/syncRevision'
import { gameAvailability } from './rosterAvailability'

/** A switch and its lineup change commit together, serialized with scoring writes. */
export async function setRostered(
  db: Kysely<Database>,
  actor: Actor,
  gameId: string,
  body: UnrosterBody
): Promise<Unrostered> {
  return await atomic(db, async trx => {
    await lockPlayerEdits(trx)
    const game = await trx
      .selectFrom('games')
      .selectAll()
      .where('id', '=', gameId)
      .forUpdate()
      .executeTakeFirst()
    if (game == null) throw notFound()
    const teamId = body.side === 'away' ? game.away_team_id : game.home_team_id
    if (
      !isHeadCoach(await roleScopes(trx, actor.userId, actor.isAdmin), teamId)
    )
      throw forbidden('Only the head coach may change game availability')
    if (game.status === 'final' || game.status === 'cancelled')
      throw conflict('This game cannot accept lineup changes')
    const userId = await survivorsOf(trx, [body.userId])
      .then(ids => ids.get(body.userId)!)
      .catch((error: unknown) => {
        if (error instanceof UnresolvedAccount)
          throw badRequest('The player does not exist')
        throw error
      })
    const availability = await gameAvailability(trx, game)
    const player = availability.roster[body.side].find(
      row => row.userId === userId && row.isPlayer
    )
    if (player?.gumboId == null)
      throw badRequest('Only a player on this team can be unrostered')
    const gumboId = player.gumboId
    const unrostered = availability.unrostered
    const isRostered = !unrostered[body.side].includes(gumboId)
    if (isRostered === body.rostered) return unrostered
    unrostered[body.side] = body.rostered
      ? unrostered[body.side].filter(id => id !== gumboId)
      : [...unrostered[body.side], gumboId]
    // A merge can leave one person on both team rosters with one side
    // excluded. Re-enabling that side must not make the next setup unreadable.
    const teams = {
      away: { id: game.away_team_id, name: '' },
      home: { id: game.home_team_id, name: '' }
    }
    try {
      reconcileRoster(
        newSetup(teams, { away: [], home: [] }),
        teams,
        availability.roster,
        availability.guestPlayers,
        unrostered
      )
    } catch (error) {
      if (!(error instanceof Error)) throw error
      throw conflict(error.message)
    }
    const rows = await readPlays(trx, gameId)
    const stored = await resolveScoringGame(
      trx,
      {
        plays: rows.map(row => row.gumbo as GumboPlay),
        currentPlay: atBatOf(game, rows.length > 0) as CurrentPlay | null
      },
      { gameId }
    )
    if (
      [...stored.plays, stored.currentPlay].some(
        play => play?.teamStation != null && storedRecordOf(play) == null
      )
    )
      throw conflict('The stored game cannot be read')
    const context = await contextOf(trx, gameId, game, stored)
    await trx
      .updateTable('games')
      .set({
        unrostered: listsByTeam(unrostered, teamsOfRow(game)),
        updated_at: new Date(),
        // Before the first setup exists, no roster action can update this token.
        // Still invalidate a scorer's earlier view of who may play.
        ...(context == null
          ? {
              lineups_digest: await changedLineupsDigest(trx, game, unrostered)
            }
          : {})
      })
      .where('id', '=', gameId)
      .execute()
    if (context != null) {
      let failure: Error | undefined
      const session = await ScoringSession.open(
        {
          load: async () => stored,
          save: async (_id, change) => {
            try {
              const posted = await postGamePlays(
                trx,
                gameId,
                asPostEventsBody({
                  ...change,
                  mode: 'live',
                  source: { system: 'teamstation' }
                })
              )
              return {
                plays: posted.plays.map(row => row.gumbo as GumboPlay),
                currentPlay: posted.currentPlay as CurrentPlay | null
              }
            } catch (error) {
              failure =
                error instanceof Error ? error : new Error(String(error))
              throw failure
            }
          }
        },
        gameId,
        context,
        {
          requireCurrentSetup: true,
          setTimer: () => null,
          clearTimer: () => undefined
        }
      )
      if (session.problem != null || awaitingResult(session.state))
        throw conflict('Finish the current play first')
      const setup = reconcileRoster(
        setupOf(session.state),
        context.teams,
        availability.roster,
        availability.guestPlayers,
        unrostered
      )
      const problem = session.apply({ type: 'lineup', kind: 'roster', setup })
        .problems[0]
      if (problem != null) throw conflict(problem.message)
      await session.flush()
      if (failure != null) throw failure
      if (session.problem != null) throw conflict(session.problem)
    }
    await notifyGameChange(trx, { game: gameId, kind: 'game' })
    noteScopeChange(trx, { gameId })
    return unrostered
  })
}
