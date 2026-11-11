import { type Kysely, type RawBuilder, sql } from 'kysely'

import { badRequest, forbidden, notFound } from '../../common/errors'
import { storedGuests } from '../../common/guests'
import { type NamedPerson, shortParts } from '../../common/names'
import { DEFAULT_PLAYER_NAME_PRIVACY } from '../../common/playerNamePrivacy'
import { teamsOfRow } from '../../common/teamLists'
import {
  canManageRoster,
  canScore,
  canSeeTeam,
  guardedRows,
  nonMemberTeam,
  openAddTeams,
  roleScopes,
  type VisibleScopes,
  visibleScopes
} from '../access'
import { onePerson } from '../admin/people'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import {
  compactFields,
  type ReaderNaming,
  readerNaming
} from '../groups/playerNamePrivacy'
import { imageUrl } from '../media/imageUrls'
import type { SpaceSettings } from '../media/spacesHls'
import { personAffiliations } from './personAffiliations'
import { readerOf } from './readerNames'

/** How close a player is to the asker, nearest first. */
export const CANDIDATE_TIERS = ['mine', 'season', 'league', 'other'] as const
export type CandidateTier = (typeof CANDIDATE_TIERS)[number]

/** One player the asker may add, as little about them as the card shows. */
export interface RosterCandidate {
  userId: string
  gumboId: number | null
  externalIds: string[]
  /** `Jordan P`, the short name in its format alone. */
  shortName: string
  /**
   * The public label split where it was built: "Mookie" and "B", even for an
   * asker who reads the name in full.
   */
  shortParts: { first: string; last: string }
  avatarUrl: string | null
  bats: 'left' | 'right' | 'switch' | null
  throws: 'left' | 'right' | null
  /**
   * The teams they play for in a season that ends today or later, of those
   * the reader may see (`canSeeTeam`), as the line names them. Kept for
   * clients that still draw them.
   */
  teams: Array<{ teamId: string; name: string }>
  /** Their affiliation line, as the reader may see it (`personAffiliations`). */
  affiliations: string
  tier: CandidateTier
  /**
   * Always empty: an installed build's cleaner needs the field, and goes on
   * from it with `after`, which answers nothing. The search has no pages.
   */
  cursor: ''
}

export interface CandidateQuery {
  teamId: string
  gameId?: string
  /** Trimmed; its words each prefix-match a name. */
  q: string
  /**
   * At most `CANDIDATE_LIMIT.max`. Read only with `capped=1`: an installed
   * build sends `limit=30` and pages on with `after`, which answers nothing,
   * so without the marker the answer is the whole `CANDIDATE_LIMIT.max`.
   */
  limit: number
  /**
   * `after` was sent: an installed build scrolling past the answer it has.
   * The search has no further pages, so it answers nothing.
   */
  after?: true
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
/**
 * One answer per search, of at most this many rows; `limit` may ask fewer
 * beside `capped=1`.
 */
export const CANDIDATE_LIMIT = { default: 100, max: 100 } as const

/**
 * The most matches one search reads looking for rows the asker is shown: a
 * common surname that the rows hide would otherwise walk every match
 * site-wide on each keystroke. It reads them `CANDIDATE_SCAN_BATCH` at a
 * time, and answers what it kept by then.
 */
export const CANDIDATE_SCAN = 1000
export const CANDIDATE_SCAN_BATCH = 200
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
  const capped = one('capped')
  if (capped !== undefined && capped !== '1')
    throw badRequest('capped must be 1')
  const limitText = one('limit')
  const limit = limitText == null ? CANDIDATE_LIMIT.default : Number(limitText)
  if (!Number.isInteger(limit) || limit < 1 || limit > CANDIDATE_LIMIT.max)
    throw badRequest(
      `limit must be a whole number from 1 to ${CANDIDATE_LIMIT.max}`
    )
  // Whatever it holds: no cursor is ever issued, so none is read.
  const after = one('after')
  return {
    teamId,
    ...(gameId == null ? {} : { gameId }),
    q,
    // A build that draws no capped notice asks for a page it would scroll
    // past, so it is answered the whole list.
    limit: capped == null ? CANDIDATE_LIMIT.max : limit,
    ...(after == null ? {} : { after: true as const })
  }
}

/** Where the scan of one search goes on: after this row. Never sent. */
interface ScanPosition {
  tier: number
  userId: string
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
  // Nobody is a stranger to themself: there is no side to ask.
  const own = await onePerson(db, actor.userId)
  if (userIds.some(id => own.userIds.includes(id))) return true
  const target = await candidateTarget(db, actor, teamId, gameId)
  const seasons =
    target.gameSeasonId != null
      ? sql`select ${target.gameSeasonId}::text as season_id`
      : sql`select season_id from team_seasons where team_id = ${target.teamId}`
  const ids = sql.join(userIds)
  // A team holding them only by an open add is no tie to them yet.
  const held = sql.join(['', ...(await openAddTeams(db, userIds))])
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
        and m.team_id not in (${held})
        and (m.team_id in (select team_id from caller_teams)
          or m.team_id in (
            select team_id from team_seasons
              where season_id in (select season_id from target_seasons)
          )
          or t.league_id = ${target.leagueId})
    union all
    select 1 from user_links
      where user_id in (${sql.join(own.userIds)}) and related_user_id in (${ids})
        and kind in ('guardian', 'family')
    limit 1`.execute(db)
  return rows.length > 0
}

/**
 * Every live player the asker may add, nearest first: the asker's own teams
 * and guarded players, then the season (the game's, or any `forTeam` is in),
 * then the team's league, then, once three letters are typed, everyone else.
 * A full account that plays for no team is everyone else too (or the
 * asker's own, when they guard it).
 * Players already on the team, and with a game anybody already in it, are
 * left out. One answer per search, of at most `ask.limit` rows, in order of
 * (tier, folded first, folded last, id); there are no further pages, so a
 * request with `after` answers none.
 */
export async function rosterCandidates(
  db: Kysely<Database>,
  actor: Actor,
  ask: CandidateQuery,
  space?: SpaceSettings,
  /** What the asker may see, when the route has read it already. */
  scopes?: VisibleScopes
): Promise<RosterCandidate[]> {
  const target = await candidateTarget(db, actor, ask.teamId, ask.gameId)
  if (ask.after === true) return []
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
  // Strangers are listed only once three letters or digits are typed. A word
  // that starts another counts for nothing, as each matches alone: `j j j` is
  // one letter, and `ab a` two, while `Bo Li` is a name typed whole.
  const letters = [
    ...new Set(
      words.map(word => word.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase())
    )
  ]
  const strangers =
    letters
      .filter(
        word => !letters.some(other => other !== word && other.startsWith(word))
      )
      .join('').length >= OTHER_TIER_QUERY
  const page = async (
    after: ScanPosition | null,
    limit: number
  ): Promise<CandidateRow[]> =>
    (
      await sql<CandidateRow>`
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
      select unnest(${await guardedRows(db, actor.userId)}::text[]) as user_id
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
      limit ${limit}
  `.execute(db)
    ).rows
  const nameOf = (row: CandidateRow): NamedPerson => ({
    id: row.user_id,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name
  })
  // Anybody's player, from anywhere: the formats of the teams they play for,
  // and in full for those the asker may read in full.
  // The public label goes beside a full one: a phone adding him offline puts
  // it on the field, the board strip and the lineup QR.
  const nameRows = async (rows: CandidateRow[]): Promise<ReaderNaming> =>
    await readerNaming(
      db,
      rows.map(row => ({ person: nameOf(row) })),
      readerOf(actor)
    )
  // The words find a stored name, but only somebody the asker reads in full
  // is found by it: anybody else by the name their row shows, or by both
  // halves of the stored one typed whole, so no word confirms a surname the
  // row hides. Matches are read `CANDIDATE_SCAN_BATCH` at a time until
  // enough are found, none are left, or `CANDIDATE_SCAN` have been read; what
  // was found by then is the answer.
  let people: CandidateRow[] = []
  let naming: ReaderNaming | undefined
  let after: ScanPosition | null = null
  for (let read = 0; ;) {
    const rows = await page(after, CANDIDATE_SCAN_BATCH)
    read += rows.length
    const pageNaming = rows.length === 0 ? undefined : await nameRows(rows)
    const found =
      pageNaming == null || words.length === 0
        ? rows
        : rows.filter(
            row =>
              pageNaming.readsFull.has(row.user_id) ||
              shownMatches(words, pageNaming.names.get(row.user_id) ?? '', row)
          )
    people = [...people, ...found].slice(0, ask.limit)
    if (pageNaming != null)
      naming = naming == null ? pageNaming : joinNaming(naming, pageNaming)
    const last = rows.at(-1)
    if (
      people.length >= ask.limit ||
      rows.length < CANDIDATE_SCAN_BATCH ||
      last == null ||
      read >= CANDIDATE_SCAN
    )
      break
    after = { tier: last.tier, userId: last.user_id }
  }
  if (people.length === 0 || naming == null) return []
  const teams = await currentTeams(
    db,
    people.map(row => row.user_id)
  )
  const named = people.map(nameOf)
  const seen = scopes ?? (await visibleScopes(db, actor.userId, actor.isAdmin))
  // The line tells two candidates of one short name apart by where they are
  // now: only teams of a season ending today or later.
  const affiliations = await personAffiliations(
    db,
    people.map(row => row.user_id),
    {
      reader: readerOf(actor),
      scopes: seen,
      teams: await currentSeasonTeams(
        db,
        people.map(row => row.user_id)
      ),
      readsFull: naming.readsFull
    }
  )
  return people.map((row, index) => {
    const short = naming.names.get(row.user_id) ?? ''
    const format = naming.formats.get(row.user_id)
    return {
      userId: row.user_id,
      gumboId: row.gumbo_id,
      externalIds: [],
      shortName: short,
      ...(format == null || format === DEFAULT_PLAYER_NAME_PRIVACY
        ? {}
        : { nameFormat: format }),
      ...compactFields(naming, named[index]),
      // Split from the public label: the add-to-roster form stores the parts
      // on the session player, and the lineup QR sends them to GameChanger.
      shortParts: shortParts(
        named[index],
        naming.compact.get(row.user_id) ?? short
      ),
      avatarUrl: space == null ? null : imageUrl(space, row.avatar_path),
      bats: row.bats,
      throws: row.throws,
      // No team the line leaves out for the reader.
      teams: (teams.get(row.user_id) ?? []).filter(each =>
        canSeeTeam(seen, each.teamId)
      ),
      affiliations: affiliations.get(row.user_id) ?? '',
      tier: CANDIDATE_TIERS[row.tier],
      cursor: '' as const
    }
  })
}

/** A name folded as `ts_name_fold` folds it: no accents, lower case. */
const fold = (name: string | null): string =>
  (name ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** Folded words of a name. */
const wordsOf = (name: string | null): string[] =>
  fold(name)
    .split(/\s+/)
    .filter(word => word !== '')

/**
 * Whether the typed words find a row the asker does not read in full: each
 * starts a word of the name the row shows, or the stored first and last
 * names are both typed whole (each word of them), the other words starting
 * a word of either or of the shown name. A stored half alone finds nobody.
 */
export function shownMatches(
  words: readonly string[],
  shown: string,
  row: Pick<CandidateRow, 'first_name' | 'last_name'>
): boolean {
  const typed = words.map(fold)
  const label = wordsOf(shown)
  const onLabel = (word: string): boolean =>
    label.some(each => each.startsWith(word))
  if (typed.every(onLabel)) return true
  const halves = [wordsOf(row.first_name), wordsOf(row.last_name)].filter(
    half => half.length > 0
  )
  if (halves.length < 2) return false
  const stored = halves.flat()
  return (
    stored.every(part => typed.includes(part)) &&
    typed.every(
      word => onLabel(word) || stored.some(part => part.startsWith(word))
    )
  )
}

/** Two pages' `readerNaming`, as one. */
function joinNaming(a: ReaderNaming, b: ReaderNaming): ReaderNaming {
  return {
    names: new Map([...a.names, ...b.names]),
    formats: new Map([...a.formats, ...b.formats]),
    compact: new Map([...a.compact, ...b.compact]),
    compactFormats: new Map([...a.compactFormats, ...b.compactFormats]),
    readsFull: new Set([...a.readsFull, ...b.readsFull])
  }
}

/**
 * The teams of a season ending today or later (the rule `currentTeams`
 * keeps) that these people, or the players they guard or are family of, hold
 * a place on, player or not.
 */
async function currentSeasonTeams(
  db: Kysely<Database>,
  userIds: string[]
): Promise<Set<string>> {
  const rows = await sql<{ team_id: string }>`
    with team_seasons as (
      select season_id, team_id from season_teams where active
      union
      select season_id, team_id from season_team_parents
    ),
    family as (
      select unnest(array[${sql.join(userIds)}]::text[]) as user_id
      union
      select related_user_id from user_links
        where user_id in (${sql.join(userIds)})
          and kind in ('guardian', 'family')
    )
    select distinct t.id as team_id
      from memberships m
      join teams t on t.id = m.team_id and t.merged_into is null
      join team_seasons ts on ts.team_id = t.id
      join seasons s on s.id = ts.season_id
      where m.user_id in (select user_id from family)
        and s.ends_on >= current_date
  `.execute(db)
  return new Set(rows.rows.map(row => row.team_id))
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
