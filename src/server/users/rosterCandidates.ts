import { type Kysely, type RawBuilder, sql } from 'kysely'

import { badRequest, forbidden, notFound } from '../../common/errors'
import { storedGuests } from '../../common/guests'
import { type NamedPerson, shortParts } from '../../common/names'
import {
  DEFAULT_PLAYER_NAME_PRIVACY,
  type PlayerNamePrivacy
} from '../../common/playerNamePrivacy'
import { wordsOf } from '../../common/search/match'
import type { SearchAsk } from '../../common/search/types'
import { teamsOfRow } from '../../common/teamLists'
import {
  canManageRoster,
  canScore,
  canSeeTeam,
  type FullNameGrants,
  nonMemberTeam,
  openAddTeams,
  roleScopes,
  type VisibleScopes,
  visibleScopes
} from '../access'
import { onePerson } from '../admin/people'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { compactFields, type ReaderNaming } from '../groups/playerNamePrivacy'
import { imageUrl } from '../media/imageUrls'
import type { SpaceSettings } from '../media/spacesHls'
import {
  candidateOrder,
  gather,
  PERSON_TIERS,
  type PersonCandidate,
  type PersonTier
} from '../search/gather'
import { personAffiliations } from './personAffiliations'
import { readerOf } from './readerNames'

/**
 * How close a player is to the asker, nearest first: the engine's
 * `PERSON_TIERS`. There is no tier past the league: nobody outside the
 * asker's reach is found.
 */
export const CANDIDATE_TIERS = PERSON_TIERS
export type CandidateTier = PersonTier

/** One player the asker may add, as little about them as the card shows. */
export interface RosterCandidate {
  userId: string
  gumboId: number | null
  externalIds: string[]
  /** `Jordan P`, the short name in its format alone. */
  shortName: string
  /** The format of `shortName`, unless it is the built-in one. */
  nameFormat?: PlayerNamePrivacy
  /** The public name, when `shortName` is full only because of the reader. */
  compactName?: string
  /** The format of `compactName`, unless it is the built-in one. */
  compactFormat?: PlayerNamePrivacy
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
   * The typed words, folded, that found this player by a name the asker
   * may find them by: what the phone keeps to find them again offline. A
   * search keeps anybody any one typed word finds, so it may be fewer than
   * were typed. Absent when nothing typed found them.
   */
  matched?: string[]
  /**
   * Always empty: an installed build's cleaner needs the field, and goes on
   * from it with `after`, which answers nothing. The search has no pages.
   */
  cursor: ''
}

export interface CandidateQuery {
  teamId: string
  gameId?: string
  /** Trimmed; matched as the search engine matches people's names. */
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

/**
 * One answer per search, of at most this many rows; `limit` may ask fewer
 * beside `capped=1`.
 */
export const CANDIDATE_LIMIT = { default: 100, max: 100 } as const

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

/** Where a player would be added, as `candidateTarget` checked it. */
export interface CandidateTarget {
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
): Promise<CandidateTarget> {
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

/**
 * Who is on the target's team already, or with a game anybody in it, as the
 * body of a recursive CTE named `held`: every player membership of those
 * teams, the game's guests, and the accounts those were merged into. A
 * search for players to add leaves them all out.
 */
export function heldSql(target: CandidateTarget): RawBuilder<unknown> {
  const inGame =
    target.game == null
      ? []
      : [target.game.home_team_id, target.game.away_team_id]
  const guests =
    target.game == null
      ? null
      : storedGuests(target.game.guests, teamsOfRow(target.game))
  const guestGumbos = guests == null ? [] : [...guests.away, ...guests.home]
  return sql`
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
        where u.merged_into is not null`
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
 * Every live person the asker may add, from the search engine's people
 * gather (`gather` in mode `people`), in its lexicographic order: the people
 * of the asker's reach (`searchReach`, which for this team also holds the
 * team, its managing season and its league) and the asker's own wards. With
 * nothing typed, nearest first: the asker's own teams and wards (`mine`),
 * then the target's season (`season`: the game's, or any `forTeam` is in),
 * then the rest of the reach (`league`). Nobody outside the reach is found,
 * however much is typed. People already on the team, and with a game
 * anybody already in it, are left out. One answer per search, of at most
 * `ask.limit` rows (up to `CANDIDATE_LIMIT.max`, which installed builds
 * ask for and count to tell the user the list was cut), in the engine's
 * order; the search socket shows `SEARCH_RESULTS_MAX` of these. There are
 * no further pages, so a request with `after` answers none.
 */
export async function rosterCandidates(
  db: Kysely<Database>,
  actor: Actor,
  ask: CandidateQuery,
  space?: SpaceSettings,
  /** What the asker may see, when the route has read it already. */
  scopes?: VisibleScopes
): Promise<RosterCandidate[]> {
  if (ask.after === true) {
    await candidateTarget(db, actor, ask.teamId, ask.gameId)
    return []
  }
  const searched: SearchAsk = {
    text: ask.q,
    location: null,
    mode: 'people',
    forTeam: ask.teamId,
    ...(ask.gameId == null ? {} : { forGame: ask.gameId })
  }
  // Installed builds ask for a hundred and tell the user the list was cut
  // when that many come back, so the route gathers as many as it is asked.
  const gathered = await gather(db, actor, searched, { peopleMax: ask.limit })
  const people = [...gathered.candidates]
    .sort(candidateOrder(searched))
    .flatMap(({ candidate }) =>
      candidate.kind === 'person' ? [candidate] : []
    )
    .slice(0, ask.limit)
  if (people.length === 0 || gathered.naming == null) return []
  const rows = await rosterRows(db, actor, people, gathered.naming, {
    space,
    scopes
  })
  const matched = new Map(people.map(person => [person.id, person.matched]))
  return rows.map(row => {
    const words = matched.get(row.userId) ?? []
    return {
      ...row,
      ...(words.length === 0 ? {} : { matched: [...words] }),
      cursor: '' as const
    }
  })
}

/**
 * The card of each of these people, as Add Existing Player draws it: what
 * `GET /users?forTeam=` answers, and what a search in mode `people` with
 * `forTeam` carries on each person row (`roster`). One source of the naming
 * rules for both: the name the asker reads, the public label beside it, the
 * parts split from that label, the teams the asker may see of a season
 * ending today or later, and the affiliation line.
 */
export async function rosterRows(
  db: Kysely<Database>,
  actor: Actor,
  people: readonly PersonCandidate[],
  naming: ReaderNaming,
  {
    space,
    scopes,
    grants,
    affiliationBudget
  }: {
    space?: SpaceSettings
    /** The most characters the affiliation line takes (`affiliationText`). */
    affiliationBudget?: number
    /** What the asker may see, when the caller has read it already. */
    scopes?: VisibleScopes
    /** The asker's full-name grants, when the caller has read them already. */
    grants?: FullNameGrants
  } = {}
): Promise<Array<Omit<RosterCandidate, 'cursor'>>> {
  if (people.length === 0) return []
  const ids = people.map(person => person.id)
  const teams = await currentTeams(db, ids)
  const seen = scopes ?? (await visibleScopes(db, actor.userId, actor.isAdmin))
  // The line tells two candidates of one short name apart by where they are
  // now: only teams of a season ending today or later.
  const affiliations = await personAffiliations(db, ids, {
    reader: readerOf(actor),
    scopes: seen,
    teams: await currentSeasonTeams(db, ids),
    readsFull: naming.readsFull,
    ...(affiliationBudget == null ? {} : { budget: affiliationBudget }),
    ...(grants == null ? {} : { grants })
  })
  return people.map(person => {
    const named: NamedPerson = {
      id: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      displayName: person.displayName
    }
    const short = naming.names.get(person.id) ?? person.name
    const format = naming.formats.get(person.id)
    return {
      userId: person.id,
      gumboId: person.gumboId,
      externalIds: [],
      shortName: short,
      ...(format == null || format === DEFAULT_PLAYER_NAME_PRIVACY
        ? {}
        : { nameFormat: format }),
      ...compactFields(naming, named),
      // Split from the public label: the add-to-roster form stores the parts
      // on the session player, and the lineup QR sends them to GameChanger.
      shortParts: shortParts(named, naming.compact.get(person.id) ?? short),
      avatarUrl: space == null ? null : imageUrl(space, person.avatarPath),
      bats: person.bats,
      throws: person.throws,
      // No team the line leaves out for the reader.
      teams: (teams.get(person.id) ?? []).filter(each =>
        canSeeTeam(seen, each.teamId)
      ),
      affiliations: affiliations.get(person.id) ?? '',
      tier: person.tier ?? 'league'
    }
  })
}

/**
 * Whether the typed words find a row the asker does not read in full: each
 * starts a word of the name the row shows, or the stored first and last
 * names are both typed whole (each word of them), the other words starting
 * a word of either or of the shown name. A stored half alone finds nobody.
 */
export function shownMatches(
  words: readonly string[],
  shown: string,
  row: { first_name: string | null; last_name: string | null }
): boolean {
  // Split as the search splits what was typed: on spaces, hyphens and
  // punctuation, so a hyphenated surname is its words.
  const typed = words.flatMap(word => wordsOf(word))
  const label = wordsOf(shown)
  const onLabel = (word: string): boolean =>
    label.some(each => each.startsWith(word))
  if (typed.every(onLabel)) return true
  const halves = [
    wordsOf(row.first_name ?? ''),
    wordsOf(row.last_name ?? '')
  ].filter(half => half.length > 0)
  if (halves.length < 2) return false
  const stored = halves.flat()
  return (
    stored.every(part => typed.includes(part)) &&
    typed.every(
      word => onLabel(word) || stored.some(part => part.startsWith(word))
    )
  )
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
