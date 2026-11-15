import type { Kysely, Transaction } from 'kysely'

import { forbidden, notFound } from '../../common/errors'
import type { ExternalIdBody } from '../../common/externalIds'
import { storedGuests } from '../../common/guests'
import type { Side } from '../../common/scoring/state'
import { listsByTeam, teamsOfRow } from '../../common/teamLists'
import { canManageRoster, canScore, roleScopes } from '../access'
import { lockPlayerEdits } from '../admin/people'
import type { Actor } from '../auth/sessions'
import { lockGameTeams, lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { externalIdLockKey } from '../db/externalIds'
import { noteScopeChange } from '../socket/syncRevision'
import {
  claimExternalId,
  displayNameOf,
  externalIdHolder
} from '../teams/addPlayers'
import { ensureGumboId, insertUser } from '../users/insertUser'

/**
 * The people an outside scorer names that have no TeamStation account, each
 * made one guest account, once, and reused for every game they play: the
 * account that holds their external id (the outside scorer's player id) when there
 * is one, else one made for them that cannot sign in. Each is a guest of the
 * game for the side they play on, unless they are on that side's roster
 * already. A game of any status takes them, final included: no play changes.
 */

export interface ExternalGuest {
  side: Side
  externalId: ExternalIdBody
  firstName: string
  lastName: string
  jersey: string
}

export interface ExternalGuestAnswer {
  externalId: ExternalIdBody
  userId?: string
  gumboId?: number
  /** True when this call made the account. */
  created: boolean
  /** Why this one was not added, when it was not. */
  refused?: string
}

type Trx = Transaction<Database>

/** Whether the caller may add players to a side of this game. */
async function maySeat(
  trx: Trx,
  actor: Actor,
  game: { home_team_id: string; away_team_id: string },
  side: Side
): Promise<boolean> {
  if (actor.isAdmin) return true
  const roles = await roleScopes(trx, actor.userId, actor.isAdmin)
  const teamId = side === 'home' ? game.home_team_id : game.away_team_id
  return (
    canManageRoster(roles, teamId) ||
    canScore(roles, game.home_team_id) ||
    canScore(roles, game.away_team_id)
  )
}

/** The account that holds an external id, made when none does. */
async function accountFor(
  trx: Trx,
  guest: ExternalGuest
): Promise<{ userId: string; created: boolean } | { refused: string }> {
  const holder = await externalIdHolder(trx, guest.externalId)
  if (holder.held && 'userId' in holder)
    return { userId: holder.userId, created: false }
  // An id held by a team or a game names something else; one left by a
  // removed account is taken over by the guest made now.
  if (holder.held && !('orphanRowId' in holder))
    return { refused: 'That external id names something else' }
  const firstName = guest.firstName.trim()
  const lastName = guest.lastName.trim()
  const userId = await insertUser(trx, {
    display_name: displayNameOf(firstName, lastName, 'Player'),
    first_name: firstName === '' ? null : firstName,
    last_name: lastName === '' ? null : lastName,
    login_enabled: false
  })
  await claimExternalId(trx, userId, guest.externalId, holder)
  return { userId, created: true }
}

export async function ensureExternalGuests(
  db: Kysely<Database>,
  actor: Actor,
  gameId: string,
  guests: readonly ExternalGuest[]
): Promise<ExternalGuestAnswer[]> {
  return await atomic(db, async trx => {
    await lockPlayerEdits(trx)
    await lockGameTeams(trx, gameId)
    const game = await trx
      .selectFrom('games')
      .selectAll()
      .where('id', '=', gameId)
      .forUpdate()
      .executeTakeFirst()
    if (game == null) throw notFound()
    for (const side of new Set(guests.map(guest => guest.side)))
      if (!(await maySeat(trx, actor, game, side)))
        throw forbidden(
          'Only a roster manager or game scorekeeper may add players to this game'
        )
    // Two games naming one player at once queue here, so one account is made.
    await lockKeys(
      trx,
      [
        ...new Set(guests.map(guest => externalIdLockKey(guest.externalId)))
      ].sort()
    )
    const teams = teamsOfRow(game)
    const lists = storedGuests(game.guests, teams)
    const teamOf = (side: Side): string =>
      side === 'home' ? game.home_team_id : game.away_team_id
    const answers: ExternalGuestAnswer[] = []
    let changed = false
    for (const guest of guests) {
      const account = await accountFor(trx, guest)
      if ('refused' in account) {
        answers.push({
          externalId: guest.externalId,
          created: false,
          refused: account.refused
        })
        continue
      }
      const other: Side = guest.side === 'home' ? 'away' : 'home'
      const rostered = async (side: Side): Promise<boolean> =>
        (await trx
          .selectFrom('memberships')
          .select('id')
          .where('team_id', '=', teamOf(side))
          .where('user_id', '=', account.userId)
          .where('is_player', '=', true)
          .executeTakeFirst()) != null
      // An account someone else made — a player on a team's roster, or one
      // who signs in — is not this route's to seat, nor to name to a caller
      // who may not see him: only a guest made for an outside player is
      // reused, and one already on this side's roster is left there.
      if (!account.created && !(await rostered(guest.side))) {
        const holder = await trx
          .selectFrom('users')
          .select('login_enabled')
          .where('id', '=', account.userId)
          .executeTakeFirst()
        const onARoster = await trx
          .selectFrom('memberships')
          .select('id')
          .where('user_id', '=', account.userId)
          .executeTakeFirst()
        if (holder?.login_enabled !== false || onARoster != null) {
          answers.push({
            externalId: guest.externalId,
            created: false,
            refused: 'That external id is a player this route does not seat'
          })
          continue
        }
      }
      const gumboId = await ensureGumboId(trx, account.userId)
      // Every id the person goes by, so a merged account's are seen too.
      const ids = (
        await trx
          .selectFrom('gumbo_ids')
          .select('gumbo_id')
          .where('user_id', '=', account.userId)
          .execute()
      ).map(row => Number(row.gumbo_id))
      const playedForOther =
        (await trx
          .selectFrom('event_players')
          .innerJoin('events', 'events.id', 'event_players.event_id')
          .select('event_players.id')
          .where('events.gameId', '=', gameId)
          .where('event_players.team_id', '=', teamOf(other))
          .where('event_players.gumbo_id', 'in', [...ids, gumboId])
          .executeTakeFirst()) != null
      if (
        lists[other].includes(gumboId) ||
        (await rostered(other)) ||
        playedForOther
      ) {
        answers.push({
          externalId: guest.externalId,
          created: false,
          refused: 'This player plays for the other side of this game'
        })
        continue
      }
      if (
        !lists[guest.side].includes(gumboId) &&
        !(await rostered(guest.side))
      ) {
        lists[guest.side].push(gumboId)
        await trx
          .insertInto('game_guest_details')
          .values({
            game_id: gameId,
            user_id: account.userId,
            jersey: guest.jersey,
            positions: []
          })
          .onConflict(oc => oc.doNothing())
          .execute()
        changed = true
      }
      answers.push({
        externalId: guest.externalId,
        userId: account.userId,
        gumboId,
        created: account.created
      })
    }
    if (changed) {
      await trx
        .updateTable('games')
        .set({ guests: listsByTeam(lists, teams) })
        .where('id', '=', gameId)
        .execute()
      noteScopeChange(trx, { gameId })
    }
    return answers
  })
}
