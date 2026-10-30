import { type Kysely, type RawBuilder, sql } from 'kysely'

import { badRequest, forbidden, notFound } from '../../common/errors'
import { storedGuests } from '../../common/guests'
import { shortParts } from '../../common/names'
import { teamsOfRow } from '../../common/teamLists'
import {
  canManageRoster,
  canScore,
  canSeeTeam,
  nonMemberTeam,
  roleScopes,
  visibleScopes
} from '../access'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { publicNames } from '../groups/playerNamePrivacy'
import { imageUrl } from '../media/imageUrls'
import type { SpaceSettings } from '../media/spacesHls'

/** How close a player is to the asker, nearest first. */
export const CANDIDATE_TIERS = ['mine', 'season', 'league', 'other'] as const
export type CandidateTier = (typeof CANDIDATE_TIERS)[number]

/** One player the asker may add, as little about them as the card shows. */
export interface RosterCandidate {
  userId: string
  gumboId: number | null
  externalIds: string[]
  /** `Jordan P`, told apart from anybody else on the same page. */
  shortName: string
  /** `shortName` split where it was built: "Mookie" and "B". */
  shortParts: { first: string; last: string }
  avatarUrl: string | null
  bats: 'left' | 'right' | 'switch' | null
  throws: 'left' | 'right' | null
  /** The teams they play for in a season that ends today or later. */
  teams: Array<{ teamId: string; name: string }>
  tier: CandidateTier
  /** Opaque; pass as `after` for the next page. */
  cursor: string
}

export interface CandidateQuery {
  teamId: string
  gameId?: string
  /** Trimmed; its words each prefix-match a name. */
  q: string
  limit: number
  /** A row's `cursor`: the rows after it. */
  after?: string
}

/**
 * Whether the `users` row aliased `user` is a full account: one its person
 * signs in to, with an email of their own, and not deleted. A full account
 * can be added as a player though it plays for no team yet.
 */
export function fullAccount(user: string): RawBuilder<boolean> {
  return sql<boolean>`(${sql.ref(`${user}.login_enabled`)}
    and ${sql.ref(`${user}.deleted_at`)} is null
    and exists (
      select 1 from user_emails
        where user_emails.user_id = ${sql.ref(`${user}.id`)}
    ))`
}

/** Somebody with no tie to the asker is listed only once this much is typed. */
export const OTHER_TIER_QUERY = 3
export const CANDIDATE_LIMIT = { default: 30, max: 50 } as const
export const CANDIDATE_QUERY_MAX = 100

/** The query string of `GET /users?forTeam=`, checked. */
export function candidateQueryOf(
  query: Record<string, unknown>
): CandidateQuery {
  const one = (key: string): string | undefined => {
    const value = query[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string') throw badRequest(`${key} must be given once`)
    return value
  }
  const teamId = one('forTeam')
  if (teamId == null || teamId === '')
    throw badRequest('forTeam must be a team id')
  if (query.externalId !== undefined || query.guardedBy !== undefined)
    throw badRequest('Ask by forTeam alone, not beside externalId or guardedBy')
  const gameId = one('forGame')
  if (gameId === '') throw badRequest('forGame must be a game id')
  const q = (one('q') ?? '').trim().replace(/\s+/g, ' ')
  if (q.length > CANDIDATE_QUERY_MAX)
    throw badRequest(`q is at most ${CANDIDATE_QUERY_MAX} characters`)
  const limitText = one('limit')
  const limit = limitText == null ? CANDIDATE_LIMIT.default : Number(limitText)
  if (!Number.isInteger(limit) || limit < 1 || limit > CANDIDATE_LIMIT.max)
    throw badRequest(
      `limit must be a whole number from 1 to ${CANDIDATE_LIMIT.max}`
    )
  const after = one('after')
  if (after != null) cursorOf(after)
  return {
    teamId,
    ...(gameId == null ? {} : { gameId }),
    q,
    limit,
    ...(after == null ? {} : { after })
  }
}

function cursorOf(raw: string): { tier: number; userId: string } {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8')
    )
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      Number.isInteger(parsed[0]) &&
      parsed[0] >= 0 &&
      parsed[0] < CANDIDATE_TIERS.length &&
      typeof parsed[1] === 'string'
    )
      return { tier: parsed[0], userId: parsed[1] }
  } catch {}
  throw badRequest('after must be a cursor this search answered')
}

function cursorFor(tier: number, userId: string): string {
  return Buffer.from(JSON.stringify([tier, userId])).toString('base64url')
}

interface Target {
  teamId: string
  leagueId: string | null
  /** The season a game is in, when one is asked about. */
  gameSeasonId: string | null
  game: {
    id: string
    home_team_id: string
    away_team_id: string
    guests: unknown
  } | null
}

/**
 * Whether the asker may add players to this team, or to its side of this
 * game: a roster manager of the team, or with a game a scorekeeper of either
 * team in it. A team or game the asker cannot see is not found.
 */
export async function candidateTarget(
  db: Kysely<Database>,
  actor: Actor,
  teamId: string,
  gameId?: string
): Promise<Target> {
  const team = await db
    .selectFrom('teams')
    .select(['id', 'league_id'])
    .where('id', '=', teamId)
    .where('merged_into', 'is', null)
    .executeTakeFirst()
  if (team == null) throw notFound()
  const game =
    gameId == null
      ? null
      : await db
          .selectFrom('games')
          .select(['id', 'home_team_id', 'away_team_id', 'season_id', 'guests'])
          .where('id', '=', gameId)
          .executeTakeFirst()
  if (gameId != null && game == null) throw notFound()
  if (
    game != null &&
    game.home_team_id !== teamId &&
    game.away_team_id !== teamId
  )
    throw badRequest('forTeam must play in forGame')
  const roles = await roleScopes(db, actor.userId, actor.isAdmin)
  const allowed =
    canManageRoster(roles, teamId) ||
    (game != null &&
      (canScore(roles, game.home_team_id) ||
        canScore(roles, game.away_team_id)))
  if (!allowed) {
    const seen = await visibleScopes(db, actor.userId, actor.isAdmin)
    const sees =
      canSeeTeam(seen, teamId) ||
      (game != null &&
        (canSeeTeam(seen, game.home_team_id) ||
          canSeeTeam(seen, game.away_team_id)))
    // A team read in the non-member view is one the caller can see too.
    if (!sees && !(await nonMemberTeam(db, actor, seen, teamId)))
      throw notFound()
    throw forbidden('Only a roster manager of this team may add its players')
  }
  return {
    teamId,
    leagueId: team.league_id,
    gameSeasonId: game?.season_id ?? null,
    game: game ?? null
  }
}

interface CandidateRow {
  user_id: string
  tier: number
  first_name: string | null
  last_name: string | null
  display_name: string
  bats: RosterCandidate['bats']
  throws: RosterCandidate['throws']
  avatar_path: string | null
  gumbo_id: number | null
}

/**
 * Every live player the asker may add, nearest first: the asker's own teams
 * and guarded players, then the season (the game's, or any `forTeam` is in),
 * then the team's league, then, once three letters are typed, everyone else.
 * A full account that plays for no team is everyone else too (or the
 * asker's own, when they guard it).
 * Players already on the team, and with a game anybody already in it, are
 * left out. Pages are keyset pages over (tier, folded first, folded last, id),
 * so the list growing between pages repeats and skips nobody.
 */
/**
 * Whether a person is somebody this team has a reason to know, as the search's
 * tiers read it: on a team of the caller's, in the team's season or league, or
 * somebody the caller guards. Anybody else is a stranger, and an add of a
 * stranger only asks: creating a team takes nothing but an account, and a
 * team that holds a player reads their whole name, their guardians and their
 * birth month.
 */
export async function hasTie(
  db: Kysely<Database>,
  actor: Actor,
  teamId: string,
  gameId: string | undefined,
  userIds: readonly string[]
): Promise<boolean> {
  if (actor.isAdmin) return true
  const target = await candidateTarget(db, actor, teamId, gameId)
  const seasons =
    target.gameSeasonId != null
      ? sql`select ${target.gameSeasonId}::text as season_id`
      : sql`select season_id from team_seasons where team_id = ${target.teamId}`
  const ids = sql.join(userIds)
  const { rows } = await sql`
    with recursive
    team_seasons as (
      select season_id, team_id from season_teams where active
      union
      select season_id, team_id from season_team_parents
    ),
    target_seasons as (${seasons}),
    caller_teams as (
      select team_id from memberships where user_id = ${actor.userId}
      union
      select scope_id from scope_roles
        where user_id = ${actor.userId} and scope_type = 'team'
    )
    select 1 from memberships m
      join teams t on t.id = m.team_id and t.merged_into is null
      where m.is_player and m.user_id in (${ids})
        and (m.team_id in (select team_id from caller_teams)
          or m.team_id in (
            select team_id from team_seasons
              where season_id in (select season_id from target_seasons)
          )
          or t.league_id = ${target.leagueId})
    union all
    select 1 from user_links
      where user_id = ${actor.userId} and related_user_id in (${ids})
        and kind in ('guardian', 'family')
    limit 1`.execute(db)
  return rows.length > 0
}

export async function rosterCandidates(
  db: Kysely<Database>,
  actor: Actor,
  ask: CandidateQuery,
  space?: SpaceSettings
): Promise<RosterCandidate[]> {
  const target = await candidateTarget(db, actor, ask.teamId, ask.gameId)
  const words = ask.q === '' ? [] : ask.q.split(' ')
  const inGame =
    target.game == null
      ? []
      : [target.game.home_team_id, target.game.away_team_id]
  const guestGumbos =
    target.game == null
      ? []
      : (() => {
          const guests = storedGuests(
            target.game.guests,
            teamsOfRow(target.game)
          )
          return [...guests.away, ...guests.home]
        })()
  const after = ask.after == null ? null : cursorOf(ask.after)
  const seasons =
    target.gameSeasonId != null
      ? sql`select ${target.gameSeasonId}::text as season_id`
      : sql`select season_id from team_seasons where team_id = ${target.teamId}`
  // Each word is a literal prefix: `%`, `_` and `\` in it match only
  // themselves.
  const literal = (word: string): string => word.replace(/[\\%_]/g, '\\$&')
  const matches =
    words.length === 0
      ? sql`true`
      : sql.join(
          words.map(
            word => sql`(
              ts_name_fold(u.first_name) like ts_name_fold(${literal(word)}) || '%'
              or ts_name_fold(u.last_name) like ts_name_fold(${literal(word)}) || '%'
              or ts_name_fold(u.display_name) like ts_name_fold(${literal(word)}) || '%'
            )`
          ),
          sql` and `
        )
  // Strangers are listed only once three letters or digits are typed.
  const strangers =
    words.join('').replace(/[^\p{L}\p{N}]/gu, '').length >= OTHER_TIER_QUERY
  const rows = await sql<CandidateRow>`
    with recursive
    team_seasons as (
      select season_id, team_id from season_teams where active
      union
      select season_id, team_id from season_team_parents
    ),
    target_seasons as (${seasons}),
    caller_teams as (
      select team_id from memberships where user_id = ${actor.userId}
      union
      select scope_id from scope_roles
        where user_id = ${actor.userId} and scope_type = 'team'
    ),
    guarded as (
      select related_user_id as user_id from user_links
        where user_id = ${actor.userId} and kind in ('guardian', 'family')
    ),
    named as (select u.id from users u where ${matches}),
    named_origins as (
      select id from named
      union
      select u.id from users u join named_origins n on u.merged_into = n.id
    ),
    -- Full accounts the words name: with no strangers asked for, only the
    -- ones the caller guards.
    accounts as (
      select u.id from users u
        where ${fullAccount('u')} and u.merged_into is null
          ${words.length === 0 ? sql`` : sql`and u.id in (select id from named)`}
          ${strangers ? sql`` : sql`and u.id in (select user_id from guarded)`}
    ),
    played as (
      select m.user_id as origin, m.user_id as id, m.team_id, t.league_id
        from memberships m
        join teams t on t.id = m.team_id and t.merged_into is null
        where m.is_player
          -- Only the people the search can answer: those the words name
          -- (and accounts merged into them), and with no strangers asked
          -- for, only the caller's, the season's and the league's.
          ${words.length === 0 ? sql`` : sql`and m.user_id in (select id from named_origins)`}
          ${
            strangers
              ? sql``
              : sql`and (m.team_id in (select team_id from caller_teams)
                    or m.team_id in (
                      select team_id from team_seasons
                        where season_id in (select season_id from target_seasons)
                    )
                    or t.league_id = ${target.leagueId}
                    or m.user_id in (select user_id from guarded))`
          }
      -- A full account plays for no team in particular.
      union all
      select id, id, null::text, null::text from accounts
    ),
    survivor as (
      select origin, id, team_id, league_id from played
      union all
      select s.origin, u.merged_into, s.team_id, s.league_id
        from survivor s join users u on u.id = s.id
        where u.merged_into is not null
    ),
    resolved as (
      select s.id as user_id, s.team_id, s.league_id
        from survivor s join users u on u.id = s.id
        where u.merged_into is null and u.disabled_at is null
    ),
    -- Who is on the team already, or in the game: from every membership of
    -- those teams, as the narrowed list above may not hold them.
    held as (
      select m.user_id as id from memberships m
        where m.is_player
          and (m.team_id = ${target.teamId}
            ${inGame.length === 0 ? sql`` : sql`or m.team_id in (${sql.join(inGame)})`})
      ${
        guestGumbos.length === 0
          ? sql``
          : sql`union select user_id from gumbo_ids
                  where gumbo_id in (${sql.join(guestGumbos)})`
      }
      union
      select u.merged_into from held h join users u on u.id = h.id
        where u.merged_into is not null
    ),
    excluded as (
      select id as user_id from held
    ),
    ranked as (
      select r.user_id, min(case
          when r.team_id in (select team_id from caller_teams)
            or r.user_id in (select user_id from guarded) then 0
          when r.team_id in (
            select team_id from team_seasons
              where season_id in (select season_id from target_seasons)
          ) then 1
          when r.league_id is not null and r.league_id = ${target.leagueId} then 2
          else 3
        end) as tier
        from resolved r
        where r.user_id not in (select user_id from excluded)
        group by r.user_id
    ),
    cursor_user as (
      select ts_name_fold(first_name) as first, ts_name_fold(last_name) as last
        from users where id = ${after?.userId ?? null}
    )
    select ranked.user_id, ranked.tier, u.first_name, u.last_name,
           u.display_name, u.bats, u.throws, u.avatar_path, g.gumbo_id
      from ranked
      join users u on u.id = ranked.user_id
      left join gumbo_ids g on g.user_id = u.id
      where ${matches}
        and ${strangers ? sql`true` : sql`ranked.tier < 3`}
        ${
          after == null
            ? sql``
            : sql`and (ranked.tier, ts_name_fold(u.first_name),
                       ts_name_fold(u.last_name), u.id)
                  > (${after.tier}, (select first from cursor_user),
                     (select last from cursor_user), ${after.userId})`
        }
      order by ranked.tier, ts_name_fold(u.first_name),
               ts_name_fold(u.last_name), u.id
      limit ${ask.limit}
  `.execute(db)
  const people = rows.rows
  if (people.length === 0) return []
  const teams = await currentTeams(
    db,
    people.map(row => row.user_id)
  )
  const named = people.map(row => ({
    id: row.user_id,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name
  }))
  // Anybody's player, from anywhere: the formats of the teams they play for.
  const names = await publicNames(
    db,
    named.map(person => ({ person }))
  )
  return people.map((row, index) => {
    const short = names.get(row.user_id) ?? ''
    return {
      userId: row.user_id,
      gumboId: row.gumbo_id,
      externalIds: [],
      shortName: short,
      shortParts: shortParts(named[index], short),
      avatarUrl: space == null ? null : imageUrl(space, row.avatar_path),
      bats: row.bats,
      throws: row.throws,
      teams: teams.get(row.user_id) ?? [],
      tier: CANDIDATE_TIERS[row.tier],
      cursor: cursorFor(row.tier, row.user_id)
    }
  })
}

/** The teams each person plays for in a season ending today or later. */
async function currentTeams(
  db: Kysely<Database>,
  userIds: string[]
): Promise<Map<string, Array<{ teamId: string; name: string }>>> {
  const rows = await sql<{ user_id: string; team_id: string; name: string }>`
    with team_seasons as (
      select season_id, team_id from season_teams where active
      union
      select season_id, team_id from season_team_parents
    )
    select distinct m.user_id, t.id as team_id, t.name
      from memberships m
      join teams t on t.id = m.team_id and t.merged_into is null
      join team_seasons ts on ts.team_id = t.id
      join seasons s on s.id = ts.season_id
      where m.is_player
        and m.user_id in (${sql.join(userIds)})
        and s.ends_on >= current_date
      order by t.name, t.id
  `.execute(db)
  const out = new Map<string, Array<{ teamId: string; name: string }>>()
  for (const row of rows.rows) {
    const held = out.get(row.user_id) ?? []
    held.push({ teamId: row.team_id, name: row.name })
    out.set(row.user_id, held)
  }
  return out
}
