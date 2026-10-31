import { type Kysely, sql } from 'kysely'

import type { RosterEntry, RosterSection } from '../../common/api'
import { DEFAULT_PLAYER_NAME_PRIVACY } from '../../common/playerNamePrivacy'
import { type Role, ROLE_FLAGS } from '../../common/roles'
import type { WalkUpSong } from '../../common/walkUpSong'
import {
  givenRoleLevelsAt,
  guardiansOfEach,
  levelsAboveTeam,
  mayEditName,
  membersOfLevels,
  openAdds,
  openAddsOf,
  type RoleLevel,
  teamsUnder
} from '../access'
import type { Database } from '../db/database'
import { formatForReader, publicFormats } from '../groups/playerNamePrivacy'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { teamWalkUpSongs } from '../routes/walkUpSongs'

/**
 * The rows held from this reader: not a site administrator, a guardian, the
 * player, or the staff of a team of theirs, whose rights no add takes away.
 */
async function heldAgainst(
  db: Kysely<Database>,
  userIds: string[],
  held: Set<string>,
  viewer?: { userId: string; isAdmin: boolean }
): Promise<Set<string>> {
  if (viewer == null) return held
  const shown = await Promise.all(
    userIds
      .filter(id => held.has(id))
      .map(
        async id =>
          [id, await mayEditName(db, viewer.userId, id, viewer)] as const
      )
  )
  return new Set(shown.filter(([, may]) => !may).map(([id]) => id))
}

/**
 * Who is on a team. Ordinary reads contain short names, for every viewer. A
 * route that has authorized roster management may explicitly request private
 * name details.
 *
 * The people are every member of the team, everybody a season or league
 * above it makes a member of it, everybody given a role on the team, on the
 * seasons it belongs to or on its league, every guardian of one of its
 * players, and everybody who follows it.
 *
 * Each person is listed once, in the first section that fits: `admin`
 * (owner, manager or an admin role), `staff` (any role flag), `player`,
 * `family` (a guardian of a player here), `spectator` (a member with none of
 * those, of the team or through its season or league), then `follower`.
 * Somebody who coaches and is also a parent is staff, which is what they are
 * here for; a member who follows the team too is a spectator.
 *
 * Each entry carries the person's walk-up song on this team, or `null`: a
 * song belongs to a player's place on a team, so the same child reads
 * another team's song only on that team's roster.
 */
export async function teamRoster(
  db: Kysely<Database>,
  space: MediaContext['space'] | undefined,
  teamId: string,
  includeFullNames = false,
  /** Who reads it, so a hold holds only against those it keeps out. */
  viewer?: { userId: string; isAdmin: boolean }
): Promise<RosterEntry[]> {
  const members = await db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select([
      'memberships.user_id as userId',
      'users.display_name as displayName',
      'users.first_name as firstName',
      'users.last_name as lastName',
      'users.bats as bats',
      'users.throws as throws',
      'users.avatar_path as avatarPath',
      'memberships.jersey as jersey',
      'memberships.positions as positions',
      'memberships.is_player as isPlayer',
      'memberships.role as role'
    ])
    .where('memberships.team_id', '=', teamId)
    .where('users.merged_into', 'is', null)
    .orderBy('users.display_name')
    .execute()

  // The seasons and leagues above the team, read once for its roles and its
  // members both.
  const levels = await levelsAboveTeam(db, teamId)
  const given = await givenRoleLevelsAt(db, { teamId, ...levels })
  // A member of the team itself, unless a season or league above makes them
  // one too: the highest level is the one their pill names.
  const memberLevels = new Map<string, RoleLevel>(
    members.map(row => [row.userId, 'team'])
  )
  for (const [userId, level] of await membersOfLevels(db, levels))
    memberLevels.set(userId, level)
  // Not the guardians of somebody held only by an add they may yet reject.
  const open = await heldAgainst(
    db,
    members.map(row => row.userId),
    await openAdds(db, teamId),
    viewer
  )
  const family = await guardiansOfEach(
    db,
    members
      .filter(row => row.isPlayer && !open.has(row.userId))
      .map(row => row.userId)
  )
  const followers = await followersOf(db, teamId)

  return await sectionPeople(
    db,
    space,
    [
      ...members,
      ...(await outsiders(
        db,
        [
          ...given.keys(),
          ...memberLevels.keys(),
          ...family.keys(),
          ...followers
        ],
        new Set(members.map(row => row.userId))
      ))
    ],
    {
      openAdds: open,
      ownLevel: 'team',
      given,
      memberLevels,
      family,
      songs: await teamWalkUpSongs(db, teamId),
      teamId,
      includeFullNames
    }
  )
}

/**
 * The people of a season or a league, in the roster's six sections, read the
 * way a team's are one level up.
 *
 * - **Admins** and **Staff**: roles given on the season or its league (on
 *   the league alone for a league), the league's carrying its pill.
 * - **Players**: everybody who plays now on a team the level reaches, as
 *   membership and roles reach it (`teamsUnder`), with the teams' names.
 * - **Family members**: their guardians.
 * - **Spectators**: members of the season or its league, the league's with
 *   a "League spectator" pill on a season's list.
 * - **Followers**: people who follow this season or league itself.
 *
 * Undefined for a season or league that is not there.
 */
export async function levelPeople(
  db: Kysely<Database>,
  space: MediaContext['space'] | undefined,
  ref: { kind: 'season' | 'league'; id: string }
): Promise<RosterEntry[] | undefined> {
  let levels: { seasonIds: string[]; leagueIds: string[] }
  if (ref.kind === 'season') {
    const season = await db
      .selectFrom('seasons')
      .select('league_id')
      .where('id', '=', ref.id)
      .executeTakeFirst()
    if (season == null) return undefined
    levels = {
      seasonIds: [ref.id],
      leagueIds: season.league_id == null ? [] : [season.league_id]
    }
  } else {
    const league = await db
      .selectFrom('leagues')
      .select('id')
      .where('id', '=', ref.id)
      .executeTakeFirst()
    if (league == null) return undefined
    levels = { seasonIds: [], leagueIds: [ref.id] }
  }
  const given = await givenRoleLevelsAt(db, levels)
  const memberLevels: Map<string, RoleLevel> = await membersOfLevels(db, levels)

  const teamIds = [...(await teamsUnder(db, ref))]
  const playing =
    teamIds.length === 0
      ? []
      : await db
          .selectFrom('memberships')
          .innerJoin('users', 'users.id', 'memberships.user_id')
          .innerJoin('teams', 'teams.id', 'memberships.team_id')
          .select([
            'memberships.user_id as userId',
            'users.display_name as displayName',
            'users.first_name as firstName',
            'users.last_name as lastName',
            'users.bats as bats',
            'users.throws as throws',
            'users.avatar_path as avatarPath',
            'memberships.team_id as teamId',
            'teams.name as teamName'
          ])
          .where('memberships.team_id', 'in', teamIds)
          .where('memberships.is_player', '=', true)
          .where('teams.merged_into', 'is', null)
          .where('users.merged_into', 'is', null)
          .orderBy('users.display_name')
          .orderBy('teams.name')
          .execute()
  const players = new Map<string, PeopleRow>()
  for (const row of playing) {
    const held = players.get(row.userId)
    if (held != null) {
      held.teamNames?.push(row.teamName)
      continue
    }
    const { teamName, teamId: _, ...person } = row
    players.set(row.userId, {
      ...person,
      jersey: null,
      positions: [],
      isPlayer: true,
      role: 'member',
      teamNames: [teamName]
    })
  }
  // Not the guardians of somebody every team of theirs here holds only by an
  // add they may yet reject.
  const open = await openAddsOf(db, teamIds)
  const settled = new Set(
    playing
      .filter(row => open.get(row.teamId)?.has(row.userId) !== true)
      .map(row => row.userId)
  )
  const family = await guardiansOfEach(
    db,
    [...players.keys()].filter(id => settled.has(id))
  )
  const followers = (
    await db
      .selectFrom('follows')
      .innerJoin('users', 'users.id', 'follows.user_id')
      .select('follows.user_id')
      .where('follows.group_type', '=', ref.kind)
      .where('follows.group_id', '=', ref.id)
      .where('users.disabled_at', 'is', null)
      .where('users.merged_into', 'is', null)
      .execute()
  ).map(row => row.user_id)

  return await sectionPeople(
    db,
    space,
    [
      ...players.values(),
      ...(await outsiders(
        db,
        [
          ...given.keys(),
          ...memberLevels.keys(),
          ...family.keys(),
          ...followers
        ],
        new Set(players.keys())
      ))
    ],
    { ownLevel: ref.kind, given, memberLevels, family }
  )
}

/** A team's roster, or a season's or league's people list. */
export async function peopleAt(
  db: Kysely<Database>,
  space: MediaContext['space'] | undefined,
  ref: { kind: 'league' | 'season' | 'team'; id: string },
  viewer?: { userId: string; isAdmin: boolean }
): Promise<RosterEntry[] | undefined> {
  if (ref.kind !== 'team')
    return await levelPeople(db, space, { kind: ref.kind, id: ref.id })
  const team = await db
    .selectFrom('teams')
    .select('id')
    .where('id', '=', ref.id)
    .where('merged_into', 'is', null)
    .executeTakeFirst()
  return team == null
    ? undefined
    : await teamRoster(db, space, ref.id, false, viewer)
}

/** Whether somebody is on a level's people list, in any section. */
export async function onPeopleList(
  db: Kysely<Database>,
  ref: { kind: 'league' | 'season' | 'team'; id: string },
  userId: string,
  viewer?: { userId: string; isAdmin: boolean }
): Promise<boolean> {
  const people = await peopleAt(db, undefined, ref, viewer)
  return people?.some(person => person.userId === userId) === true
}

/** One person a people list is built from, before their section is known. */
interface PeopleRow {
  userId: string
  displayName: string
  firstName: string | null
  lastName: string | null
  bats: RosterEntry['bats']
  throws: RosterEntry['throws']
  avatarPath: string | null
  jersey: string | null
  positions: string[]
  isPlayer: boolean
  role: string
  teamNames?: string[]
}

/**
 * People a list holds for something other than their own row there (staff
 * given their role above, members of a level above, guardians, followers),
 * while their account is open: listed with no place of their own.
 */
async function outsiders(
  db: Kysely<Database>,
  userIds: string[],
  listed: Set<string>
): Promise<PeopleRow[]> {
  const ids = [...new Set(userIds)].filter(userId => !listed.has(userId))
  if (ids.length === 0) return []
  const rows = await db
    .selectFrom('users')
    .select([
      'id as userId',
      'display_name as displayName',
      'first_name as firstName',
      'last_name as lastName',
      'bats',
      'throws',
      'avatar_path as avatarPath'
    ])
    .where('id', 'in', ids)
    .where('merged_into', 'is', null)
    .where('disabled_at', 'is', null)
    .orderBy('display_name')
    .execute()
  return rows.map(row => ({
    ...row,
    jersey: null,
    positions: [],
    isPlayer: false,
    role: 'member'
  }))
}

/**
 * Puts each person in the first section that fits, with the pill naming the
 * highest level above `ownLevel` that put them there, and sorts the list:
 * by section, the level's own people before those from above, then by name.
 */
async function sectionPeople(
  db: Kysely<Database>,
  space: MediaContext['space'] | undefined,
  rows: PeopleRow[],
  facts: {
    ownLevel: RoleLevel
    /** The roles given here and above, each at the highest level giving it. */
    given: Map<string, Map<Role, RoleLevel>>
    /** Members of this level or one above it, at the highest level. */
    memberLevels: Map<string, RoleLevel>
    /** Each guardian of a player on this list, and the players they guard. */
    family: Map<string, string[]>
    /** Who the team holds only through an add that may yet be rejected. */
    openAdds?: ReadonlySet<string>
    songs?: Map<string, WalkUpSong>
    /** The team these people are shown on: a roster's, not a level's list. */
    teamId?: string
    /**
     * Whether the players carry their whole names (`nameDetails`): only for
     * a team's roster read by whoever manages it, as the route decides.
     */
    includeFullNames?: boolean
  }
): Promise<RosterEntry[]> {
  const mappings =
    rows.length === 0
      ? []
      : await db
          .selectFrom('gumbo_ids')
          .selectAll()
          .where(
            'user_id',
            'in',
            rows.map(row => row.userId)
          )
          .execute()
  const gumboIds = new Map(mappings.map(row => [row.user_id, row.gumbo_id]))
  const { ownLevel, given, memberLevels, family, songs, includeFullNames } =
    facts
  // Worked out across the whole list so two children called Jordan do not
  // both come out `Jordan P`. Players take the setting: the team's on its
  // roster, and with no single team, the teams they play for.
  const people = rows.map(row => ({
    person: {
      id: row.userId,
      firstName: row.firstName,
      lastName: row.lastName,
      displayName: row.displayName
    },
    teamId: facts.teamId,
    player: row.isPlayer
  }))
  const formats = await publicFormats(db, people)
  const names = formatForReader(
    people.map(({ person }) => ({ person, format: formats.get(person.id)! }))
  )
  const above = (level: RoleLevel | undefined): level is 'season' | 'league' =>
    level != null && level !== ownLevel && level !== 'team'

  const placed = (
    row: PeopleRow
  ): Pick<RosterEntry, 'section' | 'staffRoles' | 'inheritedFrom'> => {
    const held = given.get(row.userId) ?? new Map<Role, RoleLevel>()
    const staffRoles = ROLE_FLAGS.filter(flag => held.has(flag))
    const admin =
      held.has('admin') || row.role === 'owner' || row.role === 'manager'
    const memberLevel = memberLevels.get(row.userId)
    const section: RosterSection = admin
      ? 'admin'
      : staffRoles.length > 0
        ? 'staff'
        : row.isPlayer
          ? 'player'
          : family.has(row.userId)
            ? 'family'
            : memberLevel != null
              ? 'spectator'
              : 'follower'
    // The role that put somebody in their section is the one their pill
    // names, at the highest level that gives it: for a spectator, being a
    // member, which a level above gives as this one does.
    if (section === 'spectator')
      return {
        section,
        staffRoles,
        inheritedFrom: above(memberLevel)
          ? { level: memberLevel, role: 'member' }
          : null
      }
    const placing: Role | undefined = admin ? 'admin' : staffRoles[0]
    const level = placing == null ? undefined : held.get(placing)
    return {
      section,
      staffRoles,
      inheritedFrom:
        placing == null || !above(level) ? null : { level, role: placing }
    }
  }
  // Under a family member, the players on this list they are a guardian of,
  // by the same short names the list gives them.
  const guardianOf = (
    row: PeopleRow,
    section: RosterSection
  ): { guardianOf?: string[] } => {
    if (section !== 'family') return {}
    const children = (family.get(row.userId) ?? []).map(
      id => names.get(id) ?? ''
    )
    return { guardianOf: children.filter(name => name !== '') }
  }
  const open = facts.openAdds ?? new Set<string>()
  const order: Record<RosterSection, number> = {
    admin: 0,
    staff: 1,
    player: 2,
    family: 3,
    spectator: 4,
    follower: 5
  }

  return rows
    .map((row): RosterEntry => {
      const place = placed(row)
      return {
        userId: row.userId,
        gumboId: gumboIds.get(row.userId) ?? null,
        ...(open.has(row.userId) ? { ownIdentity: true } : {}),
        nameDetails:
          includeFullNames === true && row.isPlayer && !open.has(row.userId)
            ? {
                firstName: row.firstName,
                lastName: row.lastName,
                displayName: row.displayName
              }
            : undefined,
        bats: row.bats,
        throws: row.throws,
        shortName: names.get(row.userId) ?? row.displayName,
        ...(formats.get(row.userId) === DEFAULT_PLAYER_NAME_PRIVACY
          ? {}
          : { nameFormat: formats.get(row.userId) }),
        avatarUrl: space == null ? null : imageUrl(space, row.avatarPath),
        jersey: row.jersey,
        positions: row.positions,
        isPlayer: row.isPlayer,
        role: row.role,
        ...place,
        walkUpSong: songs?.get(row.userId) ?? null,
        ...(row.teamNames == null ? {} : { teamNames: row.teamNames }),
        ...guardianOf(row, place.section)
      }
    })
    .sort((a, b) => {
      const bySection = order[a.section] - order[b.section]
      if (bySection !== 0) return bySection
      // The level's own people first, then those given their place above it.
      const byLevel =
        Number(a.inheritedFrom != null) - Number(b.inheritedFrom != null)
      if (byLevel !== 0) return byLevel
      const byName = a.shortName.localeCompare(b.shortName)
      if (byName !== 0) return byName
      return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0
    })
}

/**
 * Everybody who follows the team, or a team merged into it (the teams
 * `followMerges` leads here from), by an open account that is not disabled.
 * A follow made by a row since closed into another is not the open row's:
 * `GET /me/follows` reads follows by the row signed in as, too.
 */
export async function followersOf(
  db: Kysely<Database>,
  teamId: string
): Promise<string[]> {
  const { rows } = await sql<{ user_id: string }>`
    with recursive merged(id) as (
      select ${teamId}::text
      union
      select teams.id from teams
      inner join merged on teams.merged_into = merged.id
    )
    select distinct follows.user_id
    from follows
    inner join users on users.id = follows.user_id
    where follows.group_type = 'team'
      and follows.group_id in (select id from merged)
      and users.disabled_at is null
      and users.merged_into is null
  `.execute(db)
  return rows.map(row => row.user_id)
}
