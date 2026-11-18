import type { Kysely } from 'kysely'

import { HttpError } from '../../common/errors'
import type { GroupKind } from '../../common/groupCreation'
import type { PublicGroup } from '../../common/publicGroups'
import { type Role, ROLE_FLAGS, ROLES } from '../../common/roles'
import { guardedPeopleOfEach, teamsPlayedOnNowByRow } from '../access'
import { type OnePerson, onePerson } from '../admin/people'
import type { Database } from '../db/database'
import { readerNaming } from '../groups/playerNamePrivacy'
import { publicGroup } from '../groups/publicSummary'
import { imageUrl } from '../media/imageUrls'
import type { SpaceSettings } from '../media/spacesHls'
import type { Reader } from './readerNames'

/** A league, season or team the person belongs to directly, with how. */
export interface AccountAffiliationGroup {
  kind: GroupKind
  id: string
  group: PublicGroup
  /** `admin` and the staff flags held on the group itself. */
  roles: Role[]
  /** Whether a coach role they hold here is the head coach's. */
  headCoach: boolean
  /** Whether they play on the team. */
  player: boolean
  /** Whether they are a member here otherwise, with no role. */
  member: boolean
  /** Whether the signed-in row follows the group. */
  following: boolean
}

/** A player the person is a guardian of. */
export interface AccountAffiliationPlayer {
  userId: string
  name: string
  avatarUrl: string | null
  /** The teams they play on now, by name. */
  teamNames: string[]
}

export interface AccountAffiliations {
  groups: AccountAffiliationGroup[]
  players: AccountAffiliationPlayer[]
}

interface Ties {
  roles: Set<Role>
  headCoach: boolean
  player: boolean
  member: boolean
  following: boolean
}

const STAFF = new Set<string>(ROLE_FLAGS)
const ORDER: Record<GroupKind, number> = { league: 0, season: 1, team: 2 }

/**
 * The account screen's Affiliations: each league, season and team the person
 * holds a tie to **on that group itself**, and each player they guard.
 *
 * A tie is a role there (`scope_roles`), a team membership (owner or manager
 * is admin, `is_player` is playing, any other row is membership), a season or
 * league membership, or a follow. Roles and memberships are read for every row
 * the person signs in as; follows for the signed-in row alone, as
 * `GET /me/follows` reads them, so `DELETE /me/follows` can remove each one.
 * Nothing inherited adds a row: a league's administrator has no row for its
 * teams. Merged and external teams are left out, and a follow of a team since
 * merged stays the merged team's (Home's `homeLists` shows the team it became).
 *
 * Home's `homeLists` reads the same tables for its direct ties, on purpose
 * not the same way: it counts a team a guarded player plays on as direct and
 * puts a group held only as its admin after the direct ties, where this lists
 * admin and team owner or manager as ties and the guarded players as rows of
 * their own. A change to what a tie is should be weighed in both.
 *
 * Groups come leagues, seasons, then teams, each by name and then id; the
 * players come after, by name.
 */
export async function accountAffiliationsOf(
  db: Kysely<Database>,
  userId: string,
  space: SpaceSettings,
  /**
   * Whom the guarded players are named to (`readerOf`): none for a machine
   * actor, which reads only their public short names.
   */
  reader?: Reader
): Promise<AccountAffiliations> {
  const person = await onePerson(db, userId)
  // The players this person guards do not wait on the groups.
  const [groups, players] = await Promise.all([
    groupsOf(db, userId, person.userIds, space),
    guardedOf(db, userId, reader, person, space)
  ])
  return { groups, players }
}

/** The groups, as `accountAffiliationsOf` says, in its order. */
async function groupsOf(
  db: Kysely<Database>,
  userId: string,
  userIds: string[],
  space: SpaceSettings
): Promise<AccountAffiliationGroup[]> {
  const [roles, memberships, seasonMembers, leagueMembers, follows] =
    await Promise.all([
      db
        .selectFrom('scope_roles')
        .select(['scope_type', 'scope_id', 'role', 'is_head_coach'])
        .where('user_id', 'in', userIds)
        .execute(),
      db
        .selectFrom('memberships')
        .select(['team_id', 'role', 'is_player'])
        .where('user_id', 'in', userIds)
        .execute(),
      db
        .selectFrom('season_members')
        .select('season_id')
        .where('user_id', 'in', userIds)
        .execute(),
      db
        .selectFrom('league_members')
        .select('league_id')
        .where('user_id', 'in', userIds)
        .execute(),
      db
        .selectFrom('follows')
        .select(['group_type', 'group_id'])
        .where('user_id', '=', userId)
        .execute()
    ])

  const ties = new Map<string, { kind: GroupKind; id: string } & Ties>()
  const at = (kind: GroupKind, id: string): Ties => {
    const key = `${kind}:${id}`
    let held = ties.get(key)
    if (held == null) {
      held = {
        kind,
        id,
        roles: new Set(),
        headCoach: false,
        player: false,
        member: false,
        following: false
      }
      ties.set(key, held)
    }
    return held
  }
  for (const row of roles) {
    if (row.role !== 'admin' && !STAFF.has(row.role)) continue
    const held = at(row.scope_type, row.scope_id)
    held.roles.add(row.role)
    if (row.role === 'coach' && row.is_head_coach) held.headCoach = true
  }
  for (const row of memberships) {
    const held = at('team', row.team_id)
    if (row.role === 'owner' || row.role === 'manager') held.roles.add('admin')
    else if (!row.is_player) held.member = true
    if (row.is_player) held.player = true
  }
  for (const row of seasonMembers) at('season', row.season_id).member = true
  for (const row of leagueMembers) at('league', row.league_id).member = true
  for (const row of follows) at(row.group_type, row.group_id).following = true

  const teamIds = [...ties.values()]
    .filter(held => held.kind === 'team')
    .map(held => held.id)
  // Merged and external teams, which are not read.
  const leftOut = new Set(
    teamIds.length === 0
      ? []
      : (
          await db
            .selectFrom('teams')
            .select('id')
            .where('id', 'in', teamIds)
            .where(eb =>
              eb.or([
                eb('merged_into', 'is not', null),
                eb('kind', '<>', 'full')
              ])
            )
            .execute()
        ).map(row => row.id)
  )
  // Each group's public summary at once: a few reads each, however many.
  const found = await Promise.all(
    [...ties.values()]
      .filter(held => !(held.kind === 'team' && leftOut.has(held.id)))
      .map(async held => {
        try {
          return {
            held,
            group: await publicGroup(
              db,
              { kind: held.kind, id: held.id },
              space
            )
          }
        } catch (error) {
          // A group that has gone away; anything else is the route's error.
          if (error instanceof HttpError && error.code === 'notFound')
            return undefined
          throw error
        }
      })
  )
  const groups: AccountAffiliationGroup[] = []
  for (const each of found) {
    if (each == null || each.group.external) continue
    const { held, group } = each
    groups.push({
      kind: held.kind,
      id: held.id,
      group,
      roles: ROLES.filter(role => held.roles.has(role)),
      headCoach: held.headCoach,
      player: held.player,
      member: held.member,
      following: held.following
    })
  }
  groups.sort((a, b) => {
    const byKind = ORDER[a.kind] - ORDER[b.kind]
    if (byKind !== 0) return byKind
    const byName = a.group.name.localeCompare(b.group.name)
    if (byName !== 0) return byName
    return byId(a.id, b.id)
  })

  return groups
}

/** The players this person guards, named as the roster names them to them. */
async function guardedOf(
  db: Kysely<Database>,
  userId: string,
  reader: Reader | undefined,
  person: OnePerson,
  space: SpaceSettings
): Promise<AccountAffiliationPlayer[]> {
  const children = (
    await guardedPeopleOfEach(db, new Map([[userId, person]]))
  ).get(userId)!
  if (children.length === 0) return []
  const people = await db
    .selectFrom('users')
    .select([
      'id',
      'display_name as displayName',
      'first_name as firstName',
      'last_name as lastName',
      'avatar_path as avatarPath'
    ])
    .where(
      'id',
      'in',
      children.map(child => child.userId)
    )
    .where('disabled_at', 'is', null)
    .execute()
  const { names } = await readerNaming(
    db,
    people.map(person => ({
      person: {
        id: person.id,
        firstName: person.firstName,
        lastName: person.lastName,
        displayName: person.displayName
      },
      player: true
    })),
    reader
  )
  // Every child's teams in one read, and every team's name in one more.
  const byRow = await teamsPlayedOnNowByRow(
    db,
    children.flatMap(child => child.userIds)
  )
  const teamIds = [...new Set([...byRow.values()].flat())]
  const teamNames = new Map(
    teamIds.length === 0
      ? []
      : (
          await db
            .selectFrom('teams')
            .select(['id', 'name'])
            .where('id', 'in', teamIds)
            .where('kind', '=', 'full')
            .execute()
        ).map(row => [row.id, row.name])
  )
  const players = people.map((person): AccountAffiliationPlayer => {
    const child = children.find(each => each.userId === person.id)!
    const named = new Set(
      child.userIds.flatMap(row =>
        (byRow.get(row) ?? []).flatMap(id => {
          const name = teamNames.get(id)
          return name == null ? [] : [name]
        })
      )
    )
    return {
      userId: person.id,
      name: names.get(person.id) ?? person.displayName,
      avatarUrl: imageUrl(space, person.avatarPath),
      teamNames: [...named].sort((a, b) => a.localeCompare(b))
    }
  })
  return players.sort((a, b) => {
    const byName = a.name.localeCompare(b.name)
    return byName !== 0 ? byName : byId(a.userId, b.userId)
  })
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
