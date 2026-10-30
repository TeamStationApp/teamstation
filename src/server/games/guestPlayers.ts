import type { Kysely } from 'kysely'

import type { RosterEntry } from '../../common/api'
import { conflict, forbidden, notFound } from '../../common/errors'
import { storedGuests } from '../../common/guests'
import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import type { NewRosterPlayer } from '../../common/playerSettings'
import { replayPlays, storedRecordOf } from '../../common/scoring/gumbo'
import { awaitingResult } from '../../common/scoring/rules'
import type { Side } from '../../common/scoring/state'
import { listsByTeam, teamsOfRow } from '../../common/teamLists'
import { canManageRoster, canScore, lineupTeams, roleScopes } from '../access'
import { lockPlayerEdits } from '../admin/people'
import type { Actor } from '../auth/sessions'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { readPlays } from '../events/postPlays'
import { resolveScoringGame } from '../scoring/openRow'
import { contextOf } from '../scoring/replayContext'
import { noteScopeChange } from '../socket/syncRevision'
import { refuseDeleted } from '../users/deleted'
import { ensureGumboId, insertUser } from '../users/insertUser'

/** The game row serializes guest creation against lineup and play writes. */
export async function createGuestPlayer(
  db: Kysely<Database>,
  actor: Actor,
  gameId: string,
  side: Side,
  player: NewRosterPlayer,
  /** The team the caller means: refused when the side holds another now. */
  expectedTeamId?: string
): Promise<RosterEntry> {
  return await atomic(db, async trx => {
    await lockPlayerEdits(trx)
    const game = await trx
      .selectFrom('games')
      .selectAll()
      .where('id', '=', gameId)
      .forUpdate()
      .executeTakeFirst()
    if (game == null) throw notFound()
    const roles = await roleScopes(trx, actor.userId, actor.isAdmin)
    const teamId = side === 'home' ? game.home_team_id : game.away_team_id
    if (expectedTeamId != null && expectedTeamId !== teamId)
      throw conflict("This game's teams changed. Open it again.")
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
    const stored = await resolveScoringGame(
      trx,
      {
        plays: (await readPlays(trx, gameId)).map(
          row => row.gumbo as GumboPlay
        ),
        currentPlay: game.currentPlay as CurrentPlay | null
      },
      { gameId }
    )
    const context = await contextOf(trx, gameId, game, stored)
    if (context != null) {
      const replay = replayPlays(stored, context)
      if (replay.problems.length > 0 || awaitingResult(replay.state))
        throw conflict('Finish the current play before creating a player')
    } else if (
      game.currentPlay != null &&
      storedRecordOf(game.currentPlay) == null
    ) {
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
    const teams = teamsOfRow(game)
    const guests = storedGuests(game.guests, teams)
    guests[side].push(gumboId)
    await trx
      .updateTable('games')
      .set({ guests: listsByTeam(guests, teams) })
      .where('id', '=', gameId)
      .execute()
    noteScopeChange(trx, { gameId })
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

/** A guest's name before and after a correction, for the audit trail. */
export interface GuestRenamed {
  entry: RosterEntry
  /** False when the account already had this name, and nothing was written. */
  changed: boolean
  before: {
    firstName: string | null
    lastName: string | null
    displayName: string
  }
}

/**
 * Corrects the name of a game-only player: his account is renamed (first,
 * last and display name), so every read of every game names him anew, and
 * no stored play changes. Only a guest of this game (`games.guests`) whose
 * account cannot sign in may be renamed here, by a caller who may save the
 * lineup of the guest's side (`lineupTeams`: that team's head coach, or a
 * scorekeeper of the game). Anybody else is refused 403; somebody who is no
 * guest of this game, a merged account and a deleted one are 404, as nobody.
 * The answer is the guest's entry as `createGuestPlayer` answers it. A name
 * the account already has writes nothing: no account, no scope change.
 */
export async function renameGuestPlayer(
  db: Kysely<Database>,
  actor: Actor,
  gameId: string,
  userId: string,
  name: { firstName: string; lastName: string }
): Promise<GuestRenamed> {
  return await atomic(db, async trx => {
    await lockPlayerEdits(trx)
    const game = await trx
      .selectFrom('games')
      .select(['home_team_id', 'away_team_id', 'guests'])
      .where('id', '=', gameId)
      .forUpdate()
      .executeTakeFirst()
    if (game == null) throw notFound()
    const guest = await trx
      .selectFrom('users')
      .innerJoin('gumbo_ids', 'gumbo_ids.user_id', 'users.id')
      .select([
        'gumbo_ids.gumbo_id as gumboId',
        'users.login_enabled as loginEnabled',
        'users.first_name as firstName',
        'users.last_name as lastName',
        'users.display_name as displayName',
        'users.bats as bats',
        'users.throws as throws'
      ])
      .where('users.id', '=', userId)
      .where('users.merged_into', 'is', null)
      .forNoKeyUpdate('users')
      .executeTakeFirst()
    const teams = teamsOfRow(game)
    const guests = storedGuests(game.guests, teams)
    const gumboId = guest == null ? undefined : Number(guest.gumboId)
    const side = (['away', 'home'] as const).find(
      side => gumboId != null && guests[side].includes(gumboId)
    )
    if (guest == null || gumboId == null || side == null) throw notFound()
    await refuseDeleted(trx, userId)
    const roles = await roleScopes(trx, actor.userId, actor.isAdmin)
    if (!lineupTeams(roles, game).includes(teams[side].id))
      throw forbidden(
        "Only the team's head coach or a scorekeeper may correct a guest's name"
      )
    if (guest.loginEnabled)
      throw forbidden('This player signs in and keeps his own name')
    const displayName = [name.firstName, name.lastName]
      .filter(Boolean)
      .join(' ')
    const changed =
      (guest.firstName ?? '') !== name.firstName ||
      (guest.lastName ?? '') !== name.lastName ||
      guest.displayName !== displayName
    if (changed)
      await trx
        .updateTable('users')
        .set({
          first_name: name.firstName === '' ? null : name.firstName,
          last_name: name.lastName === '' ? null : name.lastName,
          display_name: displayName,
          updated_at: new Date()
        })
        .where('id', '=', userId)
        .execute()
    const details = await trx
      .selectFrom('game_guest_details')
      .select(['jersey', 'positions'])
      .where('game_id', '=', gameId)
      .where('user_id', '=', userId)
      .executeTakeFirst()
    if (changed) noteScopeChange(trx, { gameId })
    return {
      changed,
      before: {
        firstName: guest.firstName,
        lastName: guest.lastName,
        displayName: guest.displayName
      },
      entry: {
        userId,
        gumboId,
        shortName: displayName,
        nameDetails: { ...name, displayName },
        jersey: details?.jersey ?? null,
        positions: details?.positions ?? [],
        bats: guest.bats,
        throws: guest.throws,
        isPlayer: true,
        role: 'player',
        section: 'player',
        staffRoles: [],
        inheritedFrom: null,
        avatarUrl: null,
        walkUpSong: null
      }
    }
  })
}
