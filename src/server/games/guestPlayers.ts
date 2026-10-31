import type { Kysely, Selectable, Transaction } from 'kysely'

import type { RosterEntry } from '../../common/api'
import { conflict, forbidden, notFound } from '../../common/errors'
import { storedGuests } from '../../common/guests'
import { shortParts } from '../../common/names'
import type { PlayerAddTold } from '../../common/notifications'
import type {
  ExistingRosterPlayer,
  NewRosterPlayer
} from '../../common/playerSettings'
import type { Side } from '../../common/scoring/state'
import { listsByTeam, teamsOfRow } from '../../common/teamLists'
import { canManageRoster, canScore, lineupTeams, roleScopes } from '../access'
import { lockPlayerEdits } from '../admin/people'
import type { Actor } from '../auth/sessions'
import { atomic } from '../db/atomic'
import type { Database, GamesTable } from '../db/database'
import { lockPlayerAdds } from '../groups/noticePolicy'
import { type Clock, realClock } from '../groups/requests'
import { noteScopeChange } from '../socket/syncRevision'
import {
  addByPolicy,
  candidatePerson,
  teamName
} from '../teams/addExistingPlayer'
import { refuseDeleted } from '../users/deleted'
import { ensureGumboId, insertUser } from '../users/insertUser'
import {
  guestAlreadyInGame,
  guestGameOpen,
  playedForOther
} from './guestChecks'

/**
 * What every guest write checks, with the game row held: the side holds the
 * team the caller means, they may add to it (a roster manager of that team,
 * or a scorekeeper of either team), the game is neither over nor between a
 * pitch and its result. Answers the game and the side's team.
 */
async function guestGate(
  trx: Transaction<Database>,
  actor: Actor,
  gameId: string,
  side: Side,
  expectedTeamId?: string
): Promise<{ game: Selectable<GamesTable>; teamId: string }> {
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
  await guestGameOpen(trx, game)
  return { game, teamId }
}

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
    const { game } = await guestGate(trx, actor, gameId, side, expectedTeamId)
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
 * account cannot sign in, and who is no pool player (an existing player
 * added for this game), may be renamed here, by a caller who may save the
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
    const details = await trx
      .selectFrom('game_guest_details')
      .select(['jersey', 'positions', 'pool'])
      .where('game_id', '=', gameId)
      .where('user_id', '=', userId)
      .executeTakeFirst()
    // A pool player is somebody who already exists, added for this game
    // only: their name is their own, not this game's to correct.
    if (details?.pool === true)
      throw forbidden('A pool player keeps their own name')
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

/** What an existing player's guest add answers. */
export type ExistingGuest =
  | {
      kind: 'added'
      entry: RosterEntry
      requestId: string | null
      told: PlayerAddTold | null
    }
  | { kind: 'pending'; requestId: string }

/**
 * Adds a player who already exists to one side of one game as a pool player,
 * for `POST /games/:gameId/guest-players` with `{ userId }`: through the same
 * checks as a new guest, and by the notice policy. Anybody already in the
 * game, on either team's roster or as a guest of either side, is refused.
 */
export async function addExistingGuest(
  db: Kysely<Database>,
  actor: Actor,
  gameId: string,
  side: Side,
  body: ExistingRosterPlayer,
  expectedTeamId?: string,
  clock: Clock = realClock
): Promise<ExistingGuest> {
  return await atomic(db, async trx => {
    await lockPlayerEdits(trx)
    const { game, teamId } = await guestGate(
      trx,
      actor,
      gameId,
      side,
      expectedTeamId
    )
    const person = await candidatePerson(
      trx,
      side === 'away' ? game.away_team_id : game.home_team_id,
      body.userId
    )
    await lockPlayerAdds(trx, person.userId)
    await guestAlreadyInGame(trx, game, person.userIds)
    // Before anybody is told: somebody stays with the team they played for.
    if (await playedForOther(trx, gameId, person.userIds, teamId))
      throw conflict('This player already played for the other team')
    const result = await addByPolicy(
      trx,
      actor,
      {
        kind: 'playerAdd',
        mode: 'pool',
        userId: person.userId,
        teamId,
        gameId,
        side,
        jersey: body.jersey,
        positions: body.positions,
        teamName: await teamName(trx, teamId)
      },
      clock
    )
    if (result.kind === 'pending')
      return { kind: 'pending', requestId: result.requestId }
    const user = await trx
      .selectFrom('users')
      .select(['bats', 'throws'])
      .where('id', '=', person.userId)
      .executeTakeFirstOrThrow()
    const gumboId = await ensureGumboId(trx, person.userId)
    const parts = shortParts(
      { id: person.userId, displayName: person.shortName },
      person.shortName
    )
    return {
      kind: 'added',
      requestId: result.requestId,
      told: result.told,
      entry: {
        userId: person.userId,
        gumboId,
        shortName: person.shortName,
        ...(person.nameFormat == null ? {} : { nameFormat: person.nameFormat }),
        nameDetails: {
          firstName: parts.first,
          lastName: parts.last,
          displayName: person.shortName
        },
        jersey: body.jersey,
        positions: body.positions,
        bats: user.bats,
        throws: user.throws,
        isPlayer: true,
        pool: true,
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
