import { type Kysely, sql } from 'kysely'

import { badRequest, notFound } from '../../common/errors'
import { type Role, ROLES } from '../../common/roles'
import type {
  Affiliation,
  AffiliationRole,
  DirectoryPerson,
  PersonAdministration
} from '../../common/userManagement'
import { visibleScopes } from '../access'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { likeLiteral } from '../db/likeText'
import { imageUrl } from '../media/imageUrls'
import type { SpaceSettings } from '../media/spacesHls'
import { personAffiliations } from '../users/personAffiliations'
import { readerOf } from '../users/readerNames'
import { requireSignedInNodeAdmin } from './nodeAdministration'
import { onePeople } from './people'
import { lastActiveOf } from './userActivity'

/** Who may look people up: a node administrator signed in themselves. */
const LOOKUP_ONLY = 'Only a node administrator, signed in, can look people up'

/** The most people one directory search answers. */
export const DIRECTORY_LIMIT = 10

/** What `GET /users?view=directory` was asked. */
export interface DirectoryQuery {
  q: string
  limit: number
}

export function directoryQueryOf(
  query: Record<string, unknown>
): DirectoryQuery {
  for (const key of Object.keys(query))
    if (key !== 'view' && key !== 'q' && key !== 'limit')
      throw badRequest(`${key} is not a parameter of the directory`)
  const { q, limit } = query
  if (q !== undefined && typeof q !== 'string') throw badRequest('Give q once')
  if (limit !== undefined && typeof limit !== 'string')
    throw badRequest('Give limit once')
  const text = (q ?? '').trim()
  if (text.length > 120)
    throw badRequest('Search must be at most 120 characters')
  const size = limit === undefined ? DIRECTORY_LIMIT : Number(limit)
  if (
    limit !== undefined &&
    (!/^\d{1,2}$/.test(limit) || size < 1 || size > DIRECTORY_LIMIT)
  )
    throw badRequest(`limit is a whole number from 1 to ${DIRECTORY_LIMIT}`)
  return { q: text, limit: size }
}

/**
 * Open accounts whose name or any address holds `q`: those whose name or an
 * address starts with it first, then by name and id. Each with the address
 * that matched (or their primary) and the affiliation line Add Person shows.
 */
export async function directorySearch(
  db: Kysely<Database>,
  actor: Actor,
  query: DirectoryQuery,
  space?: SpaceSettings
): Promise<DirectoryPerson[]> {
  const fresh = await requireSignedInNodeAdmin(db, actor, LOOKUP_ONLY)
  if (query.q === '') return []
  const within = '%' + likeLiteral(query.q) + '%'
  const prefix = likeLiteral(query.q) + '%'
  const { rows } = await sql<{
    id: string
    display_name: string
    avatar_path: string | null
    email: string | null
  }>`
    with matched as (
      -- Each account's addresses are read once: whether one holds the
      -- search, whether one starts with it, and which to show.
      select u.id, u.display_name, u.avatar_path,
        u.display_name ilike ${prefix} or coalesce(e.starts, false) as starts,
        u.display_name ilike ${within} or coalesce(e.holds, false) as holds,
        e.email
      from users u
      left join lateral (
        select bool_or(a.email ilike ${within}) as holds,
          bool_or(a.email ilike ${prefix}) as starts,
          (array_agg(a.email order by (a.email ilike ${within}) desc,
            a.is_primary desc, a.verified_at is not null desc,
            a.created_at, a.id))[1] as email
        from user_emails a where a.user_id = u.id
      ) e on true
      where u.merged_into is null and u.login_enabled
    )
    select id, display_name, avatar_path, email from matched
    where holds
    order by starts desc, display_name, id collate "C"
    limit ${query.limit}`.execute(db)
  const lines = await personAffiliations(
    db,
    rows.map(row => row.id),
    {
      reader: readerOf(fresh),
      scopes: await visibleScopes(db, fresh.userId, fresh.isAdmin)
    }
  )
  const empty = rows
    .map(row => row.id)
    .filter(id => (lines.get(id) ?? '') === '')
  const groups = await groupNamesOf(db, empty)
  return rows.map(row => ({
    userId: row.id,
    displayName: row.display_name,
    avatarUrl: space == null ? null : imageUrl(space, row.avatar_path),
    email: row.email,
    affiliations:
      (lines.get(row.id) ?? '') === ''
        ? (groups.get(row.id) ?? '')
        : lines.get(row.id)!
  }))
}

/**
 * For people Add Person's line says nothing of, as staff with no team of
 * their own: the teams, seasons and leagues they hold a role on or belong
 * to, teams first, as one line.
 */
async function groupNamesOf(
  db: Kysely<Database>,
  userIds: readonly string[]
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map()
  const ids = sql.join([...userIds])
  const { rows } = await sql<{ user_id: string; name: string }>`
    select distinct t.user_id, k.rank, g.name from (
      select user_id, scope_type as kind, scope_id as id from scope_roles
        where user_id in (${ids})
      union select user_id, 'team', team_id from memberships
        where user_id in (${ids})
      union select user_id, 'season', season_id from season_members
        where user_id in (${ids})
      union select user_id, 'league', league_id from league_members
        where user_id in (${ids})
    ) t
    cross join lateral (
      select case t.kind when 'team' then 0 when 'season' then 1 else 2 end
        as rank
    ) k
    join lateral (
      select name from teams
        where t.kind = 'team' and id = t.id and merged_into is null
      union all select name from seasons where t.kind = 'season' and id = t.id
      union all select name from leagues where t.kind = 'league' and id = t.id
    ) g on true
    order by t.user_id, k.rank, g.name`.execute(db)
  const names = new Map<string, string[]>()
  for (const row of rows)
    names.set(row.user_id, [...(names.get(row.user_id) ?? []), row.name])
  return new Map(
    [...names].map(([id, list]) => [id, list.join(' · ')] as const)
  )
}

/** What one source of a tie says the person is there. */
export interface HeldRole {
  role?: Role
  headCoach?: boolean
  membership?: 'owner' | 'manager' | 'member'
  player?: boolean
  member?: boolean
  following?: boolean
}

const ROLE_ORDER: readonly AffiliationRole[] = [
  'admin',
  'head coach',
  ...ROLES.filter(role => role !== 'admin'),
  'player',
  'member',
  'following'
]

/**
 * A group's roles for one person, each once, in the order the app lists
 * them: administrator, head coach, the role flags, then player, member and
 * following. A team's owner or manager is its administrator.
 */
export function affiliationRoles(held: readonly HeldRole[]): AffiliationRole[] {
  const roles = new Set<AffiliationRole>()
  for (const tie of held) {
    if (tie.role != null) roles.add(tie.role)
    if (tie.headCoach === true) roles.add('head coach')
    if (tie.membership === 'owner' || tie.membership === 'manager')
      roles.add('admin')
    if (tie.membership === 'member') roles.add('member')
    if (tie.player === true) roles.add('player')
    if (tie.member === true) roles.add('member')
    if (tie.following === true) roles.add('following')
  }
  return ROLE_ORDER.filter(role => roles.has(role))
}

type Kind = Affiliation['kind']
const KIND_ORDER: Record<Kind, number> = { team: 0, season: 1, league: 2 }

/**
 * One account as a node administrator sees it: every address, the latest
 * use of anything, and every team, season and league they belong to, hold
 * a role on or follow, across the rows merged into them.
 */
export async function personAdministration(
  db: Kysely<Database>,
  actor: Actor,
  userId: string,
  space?: SpaceSettings
): Promise<PersonAdministration> {
  await requireSignedInNodeAdmin(db, actor, LOOKUP_ONLY)
  const user = await db
    .selectFrom('users')
    .select(['id', 'display_name', 'avatar_path', 'merged_into'])
    .where('id', '=', userId)
    .executeTakeFirst()
  if (user == null || user.merged_into != null) throw notFound()
  const ids = (await onePeople(db, [userId])).get(userId)?.userIds ?? [userId]
  const emails = await db
    .selectFrom('user_emails')
    .select([
      'email',
      'is_primary as isPrimary',
      sql<boolean>`verified_at is not null`.as('isVerified')
    ])
    .where('user_id', 'in', ids)
    .orderBy('is_primary', 'desc')
    .orderBy('created_at')
    .orderBy('id')
    .execute()

  const held = new Map<string, { kind: Kind; id: string; ties: HeldRole[] }>()
  const tie = (kind: Kind, id: string, role: HeldRole): void => {
    const key = `${kind}:${id}`
    const entry = held.get(key) ?? { kind, id, ties: [] }
    entry.ties.push(role)
    held.set(key, entry)
  }
  // Each kind of tie is its own table; all of them at once.
  const [roles, memberships, seasons, leagues, follows, teamFollows] =
    await Promise.all([
      db
        .selectFrom('scope_roles')
        .select(['scope_type', 'scope_id', 'role', 'is_head_coach'])
        .where('user_id', 'in', ids)
        .execute(),
      db
        .selectFrom('memberships')
        .select(['team_id', 'role', 'is_player'])
        .where('user_id', 'in', ids)
        .execute(),
      db
        .selectFrom('season_members')
        .select('season_id')
        .where('user_id', 'in', ids)
        .execute(),
      db
        .selectFrom('league_members')
        .select('league_id')
        .where('user_id', 'in', ids)
        .execute(),
      db
        .selectFrom('follows')
        .select(['group_type', 'group_id'])
        .where('user_id', 'in', ids)
        .execute(),
      db
        .selectFrom('team_follows')
        .select('team_id')
        .where('user_id', 'in', ids)
        .execute()
    ])
  for (const row of roles)
    tie(row.scope_type, row.scope_id, {
      role: row.role,
      headCoach: row.is_head_coach
    })
  for (const row of memberships)
    tie('team', row.team_id, {
      membership: row.role,
      player: row.is_player
    })
  for (const row of seasons) tie('season', row.season_id, { member: true })
  for (const row of leagues) tie('league', row.league_id, { member: true })
  for (const row of follows)
    tie(row.group_type, row.group_id, { following: true })
  for (const row of teamFollows) tie('team', row.team_id, { following: true })

  const of = (kind: Kind): string[] =>
    [...held.values()]
      .filter(entry => entry.kind === kind)
      .map(entry => entry.id)
  const names = new Map<string, string>()
  const teamIds = of('team')
  const seasonIds = of('season')
  const leagueIds = of('league')
  const [teams, seasonNames, leagueNames] = await Promise.all([
    teamIds.length === 0
      ? []
      : db
          .selectFrom('teams')
          .select(['id', 'name'])
          .where('id', 'in', teamIds)
          .where('merged_into', 'is', null)
          .execute(),
    seasonIds.length === 0
      ? []
      : db
          .selectFrom('seasons')
          .select(['id', 'name'])
          .where('id', 'in', seasonIds)
          .execute(),
    leagueIds.length === 0
      ? []
      : db
          .selectFrom('leagues')
          .select(['id', 'name'])
          .where('id', 'in', leagueIds)
          .execute()
  ])
  for (const row of teams) names.set(`team:${row.id}`, row.name)
  for (const row of seasonNames) names.set(`season:${row.id}`, row.name)
  for (const row of leagueNames) names.set(`league:${row.id}`, row.name)

  const affiliations: Affiliation[] = [...held.entries()]
    .flatMap(([key, entry]) => {
      const name = names.get(key)
      return name == null
        ? []
        : [
            {
              kind: entry.kind,
              id: entry.id,
              name,
              roles: affiliationRoles(entry.ties)
            }
          ]
    })
    .sort(
      (a, b) =>
        [
          KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
          a.name.localeCompare(b.name),
          a.id.localeCompare(b.id)
        ].find(order => order !== 0) ?? 0
    )
  const last = (await lastActiveOf(db, ids)).values()
  const lastActive = [...last].reduce<Date | null>(
    (latest, at) => (latest == null || at > latest ? at : latest),
    null
  )
  return {
    userId: user.id,
    displayName: user.display_name,
    avatarUrl: space == null ? null : imageUrl(space, user.avatar_path),
    emails,
    lastActiveAt: lastActive?.toISOString() ?? null,
    affiliations
  }
}
