import { type Kysely, sql, type Transaction } from 'kysely'

import { notFound } from '../../common/errors'
import type { PlayerAddTerms } from '../../common/notifications'
import {
  DEFAULT_PLAYER_NAME_PRIVACY,
  type PlayerNamePrivacy
} from '../../common/playerNamePrivacy'
import type { ExistingRosterPlayer } from '../../common/playerSettings'
import { lockPlayerEdits, UnresolvedAccount } from '../admin/people'
import type { Actor } from '../auth/sessions'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import {
  applyPlayerAdd,
  personOf,
  playerAddPolicy,
  recordPlayerAdd,
  refuseOtherSide
} from '../groups/noticePolicy'
import { formatForReader, publicFormats } from '../groups/playerNamePrivacy'
import { type Clock, realClock } from '../groups/requests'
import { fullAccount } from '../users/rosterCandidates'

type Trx = Transaction<Database>

/**
 * The person a `userId` body names, as `GET /users?forTeam=` would list
 * them: a live account that plays for some team, or a full account (one its
 * person signs in to with an email). Anybody else, a game guest made for one
 * game included, is not found.
 */
export async function candidatePerson(
  trx: Kysely<Database>,
  /** The team they are being added to, whose format their label takes. */
  teamId: string,
  userId: string
): Promise<{
  userId: string
  userIds: string[]
  shortName: string
  nameFormat?: PlayerNamePrivacy
}> {
  let person
  try {
    person = await personOf(trx, userId)
  } catch (error) {
    if (error instanceof UnresolvedAccount) throw notFound()
    throw error
  }
  const user = await trx
    .selectFrom('users')
    .select(['id', 'first_name', 'last_name', 'display_name', 'disabled_at'])
    .where('id', '=', person.userId)
    .executeTakeFirst()
  if (user == null || user.disabled_at != null) throw notFound()
  const plays = await trx
    .selectFrom('memberships')
    .innerJoin('teams', 'teams.id', 'memberships.team_id')
    .select('memberships.id')
    .where('memberships.user_id', 'in', person.userIds)
    .where('memberships.is_player', '=', true)
    .where('teams.merged_into', 'is', null)
    .executeTakeFirst()
  if (plays == null) {
    const account = await trx
      .selectFrom('users as u')
      .select('u.id')
      .where('u.id', '=', person.userId)
      .where(fullAccount('u'))
      .executeTakeFirst()
    if (account == null) throw notFound()
  }
  const named = {
    id: user.id,
    firstName: user.first_name,
    lastName: user.last_name,
    displayName: user.display_name
  }
  const formats = await publicFormats(trx, [{ person: named, teamId }])
  const shortName =
    formatForReader([{ person: named, format: formats.get(user.id)! }]).get(
      user.id
    ) ?? ''
  const format = formats.get(user.id)
  return {
    ...person,
    shortName,
    ...(format === DEFAULT_PLAYER_NAME_PRIVACY ? {} : { nameFormat: format })
  }
}

export async function teamName(
  trx: Kysely<Database>,
  teamId: string
): Promise<string> {
  const team = await trx
    .selectFrom('teams')
    .select('name')
    .where('id', '=', teamId)
    .executeTakeFirst()
  if (team == null) throw notFound()
  return team.name
}

/** What an existing-player add answers, before the route reads the entry. */
export type ExistingAdd =
  | { kind: 'added'; userId: string; requestId: string | null }
  | { kind: 'unchanged'; userId: string }
  | { kind: 'pending'; userId: string; requestId: string }

/**
 * Makes or asks for the add, by the notice policy: at once with a notice
 * the first time this team adds this player, and as a request the player's
 * side must accept after one of those was rejected. With nobody to ask, it
 * simply applies.
 */
export async function addByPolicy(
  trx: Trx,
  actor: Actor,
  terms: PlayerAddTerms,
  clock: Clock
): Promise<Exclude<ExistingAdd, { kind: 'unchanged' }>> {
  // Refused before it is asked, as well as when an accepted one applies.
  if (terms.mode === 'roster')
    await refuseOtherSide(
      trx,
      (await personOf(trx, terms.userId)).userIds,
      terms
    )
  const policy = await playerAddPolicy(trx, terms.userId, terms.teamId)
  if (policy === 'approval') {
    // Asked again while the first ask waits: the same request, not another.
    const waiting = await trx
      .selectFrom('group_requests')
      .select('id')
      .where('kind', '=', 'playerAdd')
      .where('status', '=', 'pending')
      // Nothing marks an unanswered one expired: its date does.
      .where('expires_at', '>', clock.now())
      .where('initiating_team_id', '=', terms.teamId)
      .where(sql<boolean>`terms->>'userId' = ${terms.userId}`)
      .where(sql<boolean>`terms->>'mode' = ${terms.mode}`)
      .where(
        sql<boolean>`coalesce(terms->>'gameId', '') = ${terms.gameId ?? ''}`
      )
      .executeTakeFirst()
    if (waiting != null)
      return { kind: 'pending', userId: terms.userId, requestId: waiting.id }
    const requestId = await recordPlayerAdd(trx, actor, terms, 'pending', clock)
    if (requestId != null)
      return { kind: 'pending', userId: terms.userId, requestId }
  }
  const applied = await applyPlayerAdd(trx, terms, terms.mode === 'roster')
  const requestId = await recordPlayerAdd(trx, actor, applied, 'applied', clock)
  return { kind: 'added', userId: terms.userId, requestId }
}

/**
 * Puts an existing player on a team's roster, for `POST
 * /teams/:teamId/roster-players` with `{ userId }`. Already a player of the
 * team, nothing changes, so a retried call answers the same.
 */
export async function addExistingRosterPlayer(
  db: Kysely<Database>,
  actor: Actor,
  teamId: string,
  body: ExistingRosterPlayer,
  claim?: (trx: Trx, result: ExistingAdd) => Promise<void>,
  clock: Clock = realClock
): Promise<ExistingAdd> {
  return await atomic(db, async trx => {
    await lockPlayerEdits(trx)
    const person = await candidatePerson(trx, teamId, body.userId)
    const playing = await trx
      .selectFrom('memberships')
      .select('id')
      .where('team_id', '=', teamId)
      .where('user_id', 'in', person.userIds)
      .where('is_player', '=', true)
      .executeTakeFirst()
    const result: ExistingAdd =
      playing != null
        ? { kind: 'unchanged', userId: person.userId }
        : await addByPolicy(
            trx,
            actor,
            {
              kind: 'playerAdd',
              mode: 'roster',
              userId: person.userId,
              teamId,
              jersey: body.jersey,
              positions: body.positions,
              teamName: await teamName(trx, teamId)
            },
            clock
          )
    await claim?.(trx, result)
    return result
  })
}
