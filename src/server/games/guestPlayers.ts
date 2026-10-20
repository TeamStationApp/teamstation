import type { Kysely } from 'kysely'

import type { RosterEntry } from '../../common/api'
import { conflict, forbidden, notFound } from '../../common/errors'
import { asGuests } from '../../common/guests'
import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import type { NewRosterPlayer } from '../../common/playerSettings'
import { recordOf, replayPlays } from '../../common/scoring/gumbo'
import { awaitingResult } from '../../common/scoring/rules'
import type { Side } from '../../common/scoring/state'
import { canManageRoster, canScore, roleScopes } from '../access'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { readPlays } from '../events/postPlays'
import { resolveScoringGame } from '../scoring/openRow'
import { contextOf } from '../scoring/replayContext'
import { ensureGumboId, insertUser } from '../users/insertUser'

/** The game row serializes guest creation against lineup and play writes. */
export async function createGuestPlayer(
  db: Kysely<Database>,
  actor: Actor,
  gameId: string,
  side: Side,
  player: NewRosterPlayer
): Promise<RosterEntry> {
  return await db.transaction().execute(async trx => {
    const game = await trx
      .selectFrom('games')
      .selectAll()
      .where('id', '=', gameId)
      .forUpdate()
      .executeTakeFirst()
    if (game == null) throw notFound()
    const roles = await roleScopes(trx, actor.userId, actor.isAdmin)
    const teamId = side === 'home' ? game.home_team_id : game.away_team_id
    if (
      !canManageRoster(roles, teamId) &&
      !canScore(roles, game.home_team_id) &&
      !canScore(roles, game.away_team_id)
    )
      throw forbidden(
        'Only a roster manager or game scorekeeper may create a guest'
      )
    if (game.status === 'final' || game.status === 'cancelled')
      throw conflict('This game cannot accept players')
    const stored = await resolveScoringGame(trx, {
      plays: (await readPlays(trx, gameId)).map(row => row.gumbo as GumboPlay),
      currentPlay: game.currentPlay as CurrentPlay | null
    })
    const context = await contextOf(trx, gameId, game, stored)
    if (context != null) {
      const replay = replayPlays(stored, context)
      if (replay.problems.length > 0 || awaitingResult(replay.state))
        throw conflict('Finish the current play before creating a player')
    } else if (game.currentPlay != null && recordOf(game.currentPlay) == null) {
      throw conflict('The stored game cannot be read')
    }
    const fullName = [player.firstName, player.lastName]
      .filter(Boolean)
      .join(' ')
    const userId = await insertUser(trx, {
      display_name: fullName,
      first_name: player.firstName === '' ? null : player.firstName,
      last_name: player.lastName === '' ? null : player.lastName,
      login_enabled: false,
      bats: player.bats,
      throws: player.throws,
      bats_source:
        player.bats != null || player.throws != null ? 'manual' : null
    })
    await trx
      .insertInto('game_guest_details')
      .values({
        game_id: gameId,
        user_id: userId,
        jersey: player.jersey,
        positions: player.positions
      })
      .execute()
    const gumboId = await ensureGumboId(trx, userId)
    const guests = asGuests(game.guests)
    guests[side].push(gumboId)
    await trx
      .updateTable('games')
      .set({ guests })
      .where('id', '=', gameId)
      .execute()
    return {
      userId,
      gumboId,
      shortName: fullName,
      nameDetails: {
        firstName: player.firstName,
        lastName: player.lastName,
        displayName: fullName
      },
      jersey: player.jersey,
      positions: player.positions,
      bats: player.bats,
      throws: player.throws,
      isPlayer: true,
      role: 'player',
      section: 'player',
      staffRoles: [],
      inheritedFrom: null,
      avatarUrl: null,
      walkUpSong: null
    }
  })
}
