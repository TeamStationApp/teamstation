import type { Kysely } from 'kysely'

import type { PersonProfile, ProfileSection } from '../../common/api'
import { notFound } from '../../common/errors'
import type { GroupRef } from '../../common/groupCreation'
import { ROLES } from '../../common/roles'
import {
  guardedPlayers,
  levelsAboveTeam,
  mayViewFullNames,
  settledTeams,
  teamsPlayedOnNow,
  teamsUnder
} from '../access'
import { onePerson } from '../admin/people'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { publicNames } from '../groups/playerNamePrivacy'
import { canAdminister, canManagePeople, currentActor } from '../groups/rights'
import { canHoldRoles, groupName, heldAt } from '../invites/grants'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { readerOf } from '../users/readerNames'
import { teamHeadCoach } from './teamHeadCoach'
import { followersOf, onPeopleList } from './teamRoster'

/**
 * One person as a team, a season or a league sees them, for the profile its
 * administrators, coaches and assistants open from its people list.
 *
 * - **Who**: their photo, their name as the viewer reads it, and their whole
 *   name, both for a viewer who may see it (`mayViewFullNames`: whoever may
 *   change it, and whoever manages the people of a level whose list holds
 *   them, as this one does unless only an open add puts them on it).
 * - **Parent/Guardian of**: the players they guard who play now on a team
 *   this level reaches: the team itself, any team of the season, any team
 *   of the league.
 * - **What they hold**, a section per level: a team's profile has the team,
 *   its seasons taken together as one, and its league; a season's has the
 *   season and its league; a league's the league. Each says the roles given
 *   at that level, the membership of it, and whether they follow it. Only
 *   the level the profile was opened from is `editable`, and only for a
 *   viewer who manages its people; the levels above are for reading.
 *
 * Readable by the level's administrators, coaches and assistants, and by
 * the person themselves; anybody else is answered 404, as is somebody who is
 * not on the level's people list.
 */
export async function personProfile(
  db: Kysely<Database>,
  space: MediaContext['space'] | undefined,
  viewer: Actor,
  ref: GroupRef,
  userId: string
): Promise<PersonProfile> {
  const fresh = await currentActor(db, viewer)
  const name = await levelName(db, ref)
  const person = await db
    .selectFrom('users')
    .select([
      'id',
      'display_name as displayName',
      'first_name as firstName',
      'last_name as lastName',
      'avatar_path as avatarPath'
    ])
    .where('id', '=', userId)
    .where('merged_into', 'is', null)
    .executeTakeFirst()
  if (name == null || person == null) throw notFound()
  const self = (await onePerson(db, fresh.userId)).userIds.includes(userId)
  const manages = await canManagePeople(db, fresh, ref)
  const admin = manages && (await canAdminister(db, fresh, ref))
  if (!manages && !self) throw notFound()
  let editable = manages
  if (!self && !(await onPeopleList(db, ref, userId, fresh))) {
    const identity = await onePerson(db, userId)
    const umpire =
      ref.kind === 'league' && admin
        ? await db
            .selectFrom('league_umpires')
            .select('user_id')
            .where('league_id', '=', ref.id)
            .where('user_id', 'in', identity.userIds)
            .executeTakeFirst()
        : undefined
    if (umpire == null) throw notFound()
    // Visibility alone does not authorize the people-list mutation routes.
    editable = false
  }

  const parts = [person.firstName, person.lastName].filter(
    part => part != null && part.trim() !== ''
  )
  const whole = parts.length === 0 ? person.displayName : parts.join(' ')
  // One answer for the person and the players they guard, asked once: it
  // answers the name field and names every label below.
  const children = await guardedPlayers(db, userId)
  const readsFull = await mayViewFullNames(
    db,
    fresh.userId,
    [userId, ...children],
    fresh
  )

  return {
    context: { kind: ref.kind, id: ref.id, name },
    person: {
      userId,
      shortName:
        (
          await publicNames(
            db,
            [
              {
                person,
                teamId:
                  ref.kind === 'team' &&
                  (await teamsPlayedOnNow(db, [userId])).includes(ref.id)
                    ? ref.id
                    : undefined
              }
            ],
            { reader: readerOf(viewer), readsFull }
          )
        ).get(userId) ?? person.displayName,
      fullName: readsFull.has(userId) ? whole : null,
      avatarUrl: space == null ? null : imageUrl(space, person.avatarPath),
      canHoldRoles: await canHoldRoles(db, userId)
    },
    guardianOf: await guardianRows(db, space, ref, children, viewer, readsFull),
    sections: await sections(db, ref, userId, editable),
    viewer: { manages: editable, admin: editable && admin, self }
  }
}

async function levelName(
  db: Kysely<Database>,
  ref: GroupRef
): Promise<string | undefined> {
  const table =
    ref.kind === 'league'
      ? 'leagues'
      : ref.kind === 'season'
        ? 'seasons'
        : 'teams'
  const row = await db
    .selectFrom(table)
    .select('name')
    .where('id', '=', ref.id)
    .executeTakeFirst()
  return row?.name
}

/**
 * The players this person guards who play now on a team this level
 * reaches, each with the first such team by name, which their Player screen
 * opens narrowed to.
 */
async function guardianRows(
  db: Kysely<Database>,
  space: MediaContext['space'] | undefined,
  ref: GroupRef,
  children: readonly string[],
  viewer: Actor,
  readsFull: ReadonlySet<string>
): Promise<PersonProfile['guardianOf']> {
  if (children.length === 0) return []
  const reach = await teamsUnder(db, ref)
  const found: Array<{ userId: string; teamId: string }> = []
  for (const child of children) {
    const plays = await settledTeams(db, (await onePerson(db, child)).userIds)
    const here = plays.filter(teamId => reach.has(teamId))
    if (here.length === 0) continue
    const named = await db
      .selectFrom('teams')
      .select('id')
      .where('id', 'in', here)
      .orderBy('name')
      .executeTakeFirstOrThrow()
    found.push({ userId: child, teamId: named.id })
  }
  if (found.length === 0) return []
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
      found.map(row => row.userId)
    )
    .execute()
  const names = await publicNames(
    db,
    found.map(row => ({
      person: people.find(one => one.id === row.userId)!,
      teamId: row.teamId
    })),
    { reader: readerOf(viewer), readsFull }
  )
  return found
    .map(row => {
      const child = people.find(one => one.id === row.userId)!
      return {
        userId: row.userId,
        shortName: names.get(row.userId) ?? child.displayName,
        avatarUrl: space == null ? null : imageUrl(space, child.avatarPath),
        teamId: row.teamId
      }
    })
    .sort((a, b) => a.shortName.localeCompare(b.shortName))
}

/** The levels a profile shows, its own first, each with its groups. */
async function levelsOf(
  db: Kysely<Database>,
  ref: GroupRef
): Promise<Array<{ level: GroupRef['kind']; ids: string[] }>> {
  if (ref.kind === 'league') return [{ level: 'league', ids: [ref.id] }]
  if (ref.kind === 'season') {
    const season = await db
      .selectFrom('seasons')
      .select('league_id')
      .where('id', '=', ref.id)
      .executeTakeFirstOrThrow()
    return [
      { level: 'season', ids: [ref.id] },
      {
        level: 'league',
        ids: season.league_id == null ? [] : [season.league_id]
      }
    ]
  }
  const above = await levelsAboveTeam(db, ref.id)
  return [
    { level: 'team', ids: [ref.id] },
    { level: 'season', ids: above.seasonIds },
    { level: 'league', ids: above.leagueIds }
  ]
}

/**
 * What the person holds at each level: the roles and membership given there,
 * across every group of the level (a team in two seasons has one Season
 * section for both), and whether they follow one of them. A level with no
 * group, such as the season of a team in none, has no section.
 */
async function sections(
  db: Kysely<Database>,
  ref: GroupRef,
  userId: string,
  manages: boolean
): Promise<ProfileSection[]> {
  const found: ProfileSection[] = []
  for (const { level, ids } of await levelsOf(db, ref)) {
    if (ids.length === 0) continue
    const groups = []
    const roles = new Set<string>()
    let member = false
    let follower = false
    let player = false
    for (const id of ids) {
      const group: GroupRef = { kind: level, id }
      groups.push({ id, name: await groupName(db, group) })
      const held = await heldAt(db, group, userId)
      for (const role of held.roles) roles.add(role)
      member ||= held.member
      if (level === 'team' && !player) {
        const idsOfPerson = (await onePerson(db, userId)).userIds
        player =
          (await db
            .selectFrom('memberships')
            .select('user_id')
            .where('user_id', 'in', idsOfPerson)
            .where('team_id', '=', id)
            .where('is_player', '=', true)
            .executeTakeFirst()) != null
      }
      follower ||=
        level === 'team'
          ? (await followersOf(db, id)).includes(userId)
          : (await db
              .selectFrom('follows')
              .select('user_id')
              .where('user_id', '=', userId)
              .where('group_type', '=', level)
              .where('group_id', '=', id)
              .executeTakeFirst()) != null
    }
    const headCoach =
      level === 'team' ? await teamHeadCoach(db, ref.id) : undefined
    found.push({
      ...(headCoach != null && (manages || headCoach.userId === userId)
        ? { headCoach: { userId: headCoach.userId, name: headCoach.name } }
        : {}),
      level,
      groups: groups.sort((a, b) => a.name.localeCompare(b.name)),
      roles: ROLES.filter(role => roles.has(role)),
      member,
      follower,
      player,
      editable: manages && level === ref.kind
    })
  }
  return found
}
