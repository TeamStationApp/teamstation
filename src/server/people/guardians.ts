import type { Kysely } from 'kysely'

import { badRequest, notFound } from '../../common/errors'
import { makeId } from '../../common/ids'
import { canCoach, openAddTeams, roleScopes } from '../access'
import { onePerson, survivorsOf } from '../admin/people'
import type { Database } from '../db/database'
import { rowsOfPeople } from '../teams/teamStaff'

/**
 * Guardians and adult family members of a player.
 *
 * A guardian link is a `user_links` row `(guardian, player, 'guardian')`
 * with `can_manage`; an adult family member is the same row of kind
 * `family`, without it. A guardian always has an account, and linking one
 * puts them on the player's team as a plain member whose membership says it
 * came from the link (`granted_by_link_id`), so taking the link away takes
 * that membership with it. A family link grants nothing: it counts only for
 * who may be in a direct message with the player.
 *
 * One person is one of the two to a player, never both: linking with the
 * other kind replaces the row.
 */

export type RelativeKind = 'guardian' | 'family'

export interface Guardian {
  userId: string
  name: string
  /** Their primary address, or null when they have none on file. */
  email: string | null
  kind: RelativeKind
}

export interface Linked {
  linkId: string
  /** False when the link was already there. */
  created: boolean
}

/**
 * Makes `guardianId` a guardian (or adult family member) of `playerId`, who
 * must be a player on `teamId`.
 *
 * Refuses a guardian who is not an account (`badRequest`, reason
 * `guardianNeedsAccount`), a link of a player to themselves, and a player
 * who has no `is_player` membership on the team (404). Idempotent. A
 * guardian who has no membership on the team gets one, granted by the link;
 * one they already had is left as it was. `actor` is whoever asked, kept
 * for the chat's membership log; nothing here reads it.
 */
export async function linkGuardian(
  trx: Kysely<Database>,
  playerId: string,
  guardianId: string,
  teamId: string,
  actor: string | null,
  kind: RelativeKind = 'guardian'
): Promise<Linked> {
  if (guardianId === playerId) {
    throw badRequest('A player cannot be their own guardian', {
      reason: 'selfLink'
    })
  }
  const guardian = await trx
    .selectFrom('users')
    .select(['id'])
    .where('id', '=', guardianId)
    .where('merged_into', 'is', null)
    .where('login_enabled', '=', true)
    .executeTakeFirst()
  if (guardian == null) {
    throw badRequest('A guardian needs an account of their own', {
      reason: 'guardianNeedsAccount'
    })
  }
  const place = await trx
    .selectFrom('memberships')
    .select(['id'])
    .where('user_id', '=', playerId)
    .where('team_id', '=', teamId)
    .where('is_player', '=', true)
    .executeTakeFirst()
  if (place == null) throw notFound()

  // The other kind goes first, and takes its membership with it.
  const other: RelativeKind = kind === 'guardian' ? 'family' : 'guardian'
  await unlinkKinds(trx, playerId, guardianId, [other])

  const made = await trx
    .insertInto('user_links')
    .values({
      id: makeId('userLink'),
      user_id: guardianId,
      related_user_id: playerId,
      kind,
      can_manage: kind === 'guardian'
    })
    .onConflict(oc =>
      oc.columns(['user_id', 'related_user_id', 'kind']).doNothing()
    )
    .returning(['id'])
    .executeTakeFirst()
  const link =
    made ??
    (await trx
      .selectFrom('user_links')
      .select(['id'])
      .where('user_id', '=', guardianId)
      .where('related_user_id', '=', playerId)
      .where('kind', '=', kind)
      .executeTakeFirstOrThrow())

  if (kind === 'guardian') {
    await trx
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: guardianId,
        team_id: teamId,
        role: 'member',
        is_player: false,
        granted_by_link_id: link.id
      })
      .onConflict(oc => oc.columns(['user_id', 'team_id']).doNothing())
      .execute()
  }
  return { linkId: link.id, created: made != null }
}

/**
 * Takes away every guardian and family link from `guardianId` to
 * `playerId`, from any row of the one to any row of the other, and the
 * memberships those links granted.
 *
 * A membership a link granted, and that is still a plain `member`, moves to
 * another guardian link of the same person to a player on that team when
 * there is one (a parent of two siblings stays on the team while either is
 * linked), and is deleted otherwise. A membership they had before the link,
 * or one since made into more, stays. Answers whether there was a link.
 */
export async function unlinkGuardian(
  trx: Kysely<Database>,
  playerId: string,
  guardianId: string
): Promise<boolean> {
  return await unlinkKinds(trx, playerId, guardianId, ['guardian', 'family'])
}

async function unlinkKinds(
  trx: Kysely<Database>,
  playerId: string,
  guardianId: string,
  kinds: RelativeKind[]
): Promise<boolean> {
  const guardianRows = await rowsOfPeople(trx, [guardianId])
  const links = await trx
    .selectFrom('user_links')
    .select(['id'])
    .where('user_id', 'in', guardianRows)
    .where('related_user_id', 'in', await rowsOfPeople(trx, [playerId]))
    .where('kind', 'in', kinds)
    .execute()
  if (links.length === 0) return false
  const linkIds = links.map(link => link.id)

  const granted = await trx
    .selectFrom('memberships')
    .select(['id', 'team_id'])
    .where('granted_by_link_id', 'in', linkIds)
    .where('role', '=', 'member')
    .execute()

  await trx.deleteFrom('user_links').where('id', 'in', linkIds).execute()

  // Their links to anybody else, each child as the row they now are.
  const others = await trx
    .selectFrom('user_links')
    .select(['id', 'related_user_id'])
    .where('user_id', 'in', guardianRows)
    .where('kind', '=', 'guardian')
    .orderBy('created_at')
    .execute()
  const childOf = await survivorsOf(
    trx,
    others.map(link => link.related_user_id)
  )
  for (const membership of granted) {
    // Another child of theirs on the same team keeps them on it.
    const players = await trx
      .selectFrom('memberships')
      .select(['user_id'])
      .where('team_id', '=', membership.team_id)
      .where('is_player', '=', true)
      .execute()
    const onTeam = new Set(players.map(row => row.user_id))
    const sibling = others.find(link =>
      onTeam.has(childOf.get(link.related_user_id) ?? link.related_user_id)
    )
    if (sibling != null) {
      await trx
        .updateTable('memberships')
        .set({ granted_by_link_id: sibling.id })
        .where('id', '=', membership.id)
        .execute()
    } else {
      await trx
        .deleteFrom('memberships')
        .where('id', '=', membership.id)
        .execute()
    }
  }
  return true
}

/**
 * A player's guardians and adult family members, guardians first.
 *
 * The player is every row that is them (a merge closes a row without moving
 * what pointed at it), and each relative is answered as the row they now
 * are. A relative merged into the player themselves is left out.
 */
export async function guardiansOf(
  db: Kysely<Database>,
  playerId: string
): Promise<Guardian[]> {
  const person = await onePerson(db, playerId)
  const links = await db
    .selectFrom('user_links')
    .select(['user_id', 'kind'])
    .where('related_user_id', 'in', person.userIds)
    .where('kind', 'in', ['guardian', 'family'])
    .execute()
  if (links.length === 0) return []

  const survivors = await survivorsOf(
    db,
    links.map(link => link.user_id)
  )
  const kinds = new Map<string, RelativeKind>()
  for (const link of links) {
    const userId = survivors.get(link.user_id) ?? link.user_id
    if (userId === person.userId) continue
    const kind = link.kind as RelativeKind
    // Guardian wins over family when two merged rows disagree.
    if (kinds.get(userId) !== 'guardian') kinds.set(userId, kind)
  }
  if (kinds.size === 0) return []

  const userIds = [...kinds.keys()]
  const users = await db
    .selectFrom('users')
    .select(['id', 'display_name'])
    .where('id', 'in', userIds)
    .execute()
  const emails = await db
    .selectFrom('user_emails')
    .select(['user_id', 'email'])
    .where('user_id', 'in', userIds)
    .orderBy('is_primary', 'desc')
    .orderBy('created_at')
    .execute()
  const emailOf = new Map<string, string>()
  for (const row of emails) {
    if (!emailOf.has(row.user_id)) emailOf.set(row.user_id, row.email)
  }

  return users
    .map(user => ({
      userId: user.id,
      name: user.display_name,
      email: emailOf.get(user.id) ?? null,
      kind: kinds.get(user.id) ?? 'guardian'
    }))
    .sort((a, b) => {
      const rank = (kind: RelativeKind): number => (kind === 'guardian' ? 0 : 1)
      const byKind = rank(a.kind) - rank(b.kind)
      return byKind !== 0 ? byKind : a.name.localeCompare(b.name)
    })
}

/** Whether `userId` is a guardian of `playerId` (any row of the player). */
export async function isGuardianOf(
  db: Kysely<Database>,
  userId: string,
  playerId: string
): Promise<boolean> {
  const guardians = await guardiansOf(db, playerId)
  return guardians.some(
    guardian => guardian.userId === userId && guardian.kind === 'guardian'
  )
}

/**
 * Whether `actor` may set and see `playerId`'s birth month: a site
 * administrator, an administrator or coach of a team the player plays on
 * (inherited roles count, as everywhere a coach is asked about), or one of
 * the player's guardians. Not the player, and not an adult family member.
 */
export async function mayKeepBirthMonth(
  db: Kysely<Database>,
  actor: { userId: string; isAdmin: boolean },
  playerId: string
): Promise<boolean> {
  if (actor.isAdmin) return true
  const person = await onePerson(db, playerId)
  const teams = await db
    .selectFrom('memberships')
    .select(['team_id'])
    .where('user_id', 'in', person.userIds)
    .where('is_player', '=', true)
    .execute()
  if (teams.length > 0) {
    const scopes = await roleScopes(db, actor.userId, actor.isAdmin)
    // Not a team holding them only by an open add: a rejection could not
    // undo it.
    const held = await openAddTeams(db, person.userIds)
    if (
      teams.some(
        team => !held.includes(team.team_id) && canCoach(scopes, team.team_id)
      )
    )
      return true
  }
  return await isGuardianOf(db, actor.userId, playerId)
}
