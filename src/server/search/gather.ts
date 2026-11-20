import { type Kysely, type RawBuilder, sql } from 'kysely'

import type { NamedPerson } from '../../common/names'
import {
  compareMatches,
  fold,
  type Matchable,
  type MatchScore,
  matchScore,
  type ScoredMatch,
  wordsOf
} from '../../common/search/match'
import type { SearchAsk, SearchGroupKind } from '../../common/search/types'
import { type FullNameGrants, guardedRows } from '../access'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { type ReaderNaming, readerNaming } from '../groups/playerNamePrivacy'
import { readerOf } from '../users/readerNames'
import {
  type CandidateTarget,
  candidateTarget,
  heldSql,
  shownMatches
} from '../users/rosterCandidates'
import { cityCoordinates, countrySpellings, regionSpellings } from './locations'
import { type SearchReach, searchReach } from './reach'
import type { ReaderReads } from './readerCache'

/**
 * What a search can answer, before any ranking but its own: in mode `all`,
 * at most `PER_KIND` leagues, seasons, teams and people; in mode `people`,
 * at most `PEOPLE_ONLY_MAX` people. Either way up to 80 candidates.
 *
 * Every query narrows in SQL first. An organization is kept when any typed
 * word is in its folded name (`ts_name_fold`) or its locality's folded city,
 * region or country (a season's is its league's), the best
 * `PREFILTER_ROWS` of each kind by words found, then words found at a word's
 * start, then a shorter name; `lexicographicTop`'s key then picks the
 * `PER_KIND`. A city pill keeps the organizations in that city first and
 * widens to the nearest outside it, in `RING_MILES` rings, in the same one
 * query per kind. A region or country pill only filters.
 *
 * People are found only inside the reader's reach (`searchReach`), or
 * through the reader's own guardian links, and only with no pill, by the
 * name the reader is shown (`readerNaming`), or by their stored first and
 * last names typed whole (`shownMatches`). Mode `people` with `forTeam`
 * (Add Existing Player) lists them with nothing typed too, nearest first by
 * `tier`.
 */
export const PER_KIND = 20
/** The most people mode `people` gathers: as many as mode `all`'s four kinds. */
export const PEOPLE_ONLY_MAX = 4 * PER_KIND
export const PREFILTER_ROWS = 200
/**
 * The most people rows a search reads, `PREFILTER_ROWS` at a time, to fill
 * its answer past rows a hidden surname alone found.
 */
export const PEOPLE_SCAN = 1000
export const RING_MILES = 5
/**
 * With a pill and nothing typed, the most organizations of a kind whose
 * recent activity is read, nearest first, to list the `PER_KIND` most
 * recently active of.
 */
export const ACTIVITY_ROWS = 200
/** The most typed words a search reads; more are left out. */
export const TYPED_WORDS_MAX = 8

const EARTH_MILES = 3958.8

/** A league, season or team a search may answer. */
export interface GroupCandidate extends Matchable {
  kind: SearchGroupKind
  /** Its city, region and country: a season's are its league's. */
  place: [string | null, string | null, string | null]
  logoPath: string | null
  /** A season's league's picture, which it is drawn with when it has none. */
  leagueLogoPath: string | null
  /** A team's or season's league. */
  leagueId: string | null
  /** A season's dates, `YYYY-MM-DD`. */
  startsOn: string | null
  endsOn: string | null
  /** Inside the chosen location, or true when there is none. */
  inside: boolean
  /** With a city pill, the miles from that city; null for no coordinates. */
  miles: number | null
  /** With no typed text, its most recent game or team event. */
  lastActivityAt: Date | null
}

/** A person a search may answer, named as the reader is shown them. */
export interface PersonCandidate extends Matchable {
  kind: 'person'
  firstName: string | null
  lastName: string | null
  displayName: string
  avatarPath: string | null
  bats: 'left' | 'right' | 'switch' | null
  throws: 'left' | 'right' | null
  gumboId: number | null
  /**
   * Mode `people` with `forTeam`: how near the person is to the reader and
   * the target, as Add Existing Player orders an empty field. `mine` plays
   * on, or holds a place on, one of the reader's teams, or is one the reader
   * guards; `season` is on a team of the target's season (the game's, or any
   * the team is in); `league` is anybody else in the reach. Null otherwise.
   */
  tier: PersonTier | null
  /**
   * The typed words (folded) that found this person: each matched one of
   * the names the reader may find them by. None with nothing typed.
   */
  matched: string[]
}

/** How near a person found for Add Existing Player is, nearest first. */
export const PERSON_TIERS = ['mine', 'season', 'league'] as const
export type PersonTier = (typeof PERSON_TIERS)[number]

export type Candidate = GroupCandidate | PersonCandidate

/** What `gather` found, and what it read on the way. */
export interface Gathered {
  /** The folded typed words, at most `TYPED_WORDS_MAX`. */
  typed: string[]
  reach: SearchReach
  /** Each kind's best, at most `PER_KIND` of each, in no particular order. */
  candidates: Array<ScoredMatch<Candidate>>
  /** The people's names as the reader reads them. */
  naming: ReaderNaming | null
  /** Mode `people` with `forTeam`: where the person would be added. */
  target: CandidateTarget | null
}

const NO_MATCH: MatchScore = { matched: 0, points: 0, coverage: 0, words: [] }

/** Text compared as `LIKE` matches it: `%`, `_` and `\` only themselves. */
function literal(word: string): string {
  return word.replace(/[\\%_]/g, '\\$&')
}

/**
 * The order of a search's answer. Typed text ranks by `compareMatches`,
 * after, with a city pill, inside the city first and then by 5-mile ring
 * outward. No typed text ranks by recent activity, then nearest, then name.
 */
export function candidateOrder(
  ask: Pick<SearchAsk, 'text' | 'location'>
): (a: ScoredMatch<Candidate>, b: ScoredMatch<Candidate>) => number {
  const typed = wordsOf(ask.text).length > 0
  const city = ask.location?.kind === 'city'
  const ring = (candidate: Candidate): number =>
    candidate.kind === 'person' || candidate.inside
      ? -1
      : candidate.miles == null
        ? Infinity
        : Math.floor(candidate.miles / RING_MILES)
  const miles = (candidate: Candidate): number =>
    candidate.kind === 'person' || candidate.inside
      ? 0
      : (candidate.miles ?? Infinity)
  const activity = (candidate: Candidate): number =>
    candidate.kind === 'person'
      ? -Infinity
      : (candidate.lastActivityAt?.getTime() ?? -Infinity)
  return (a, b) => {
    if (city) {
      const rings = ring(a.candidate) - ring(b.candidate)
      if (rings !== 0 && !Number.isNaN(rings)) return rings
    }
    if (typed) return compareMatches(a, b)
    if (a.candidate.kind === 'person' && b.candidate.kind === 'person')
      return personOrder(a.candidate, b.candidate)
    const recent = activity(b.candidate) - activity(a.candidate)
    if (recent !== 0 && !Number.isNaN(recent)) return recent
    const near = miles(a.candidate) - miles(b.candidate)
    if (near !== 0 && !Number.isNaN(near)) return near
    return compareMatches(a, b)
  }
}

/** People with nothing typed: nearest tier, then name, then id. */
function personOrder(a: PersonCandidate, b: PersonCandidate): number {
  const tier = (person: PersonCandidate): number =>
    person.tier == null
      ? PERSON_TIERS.length
      : PERSON_TIERS.indexOf(person.tier)
  const tiers = tier(a) - tier(b)
  if (tiers !== 0) return tiers
  const names = fold(a.name).localeCompare(fold(b.name))
  if (names !== 0) return names
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The SQL of a group's most recent game or team event, by its id
 * (`idRef`): a team's own, a season's games and its teams' events, a
 * league's seasons' games and its teams' events.
 */
export function lastActivitySql(
  kind: SearchGroupKind,
  idRef: RawBuilder<string>
): RawBuilder<Date | null> {
  if (kind === 'team')
    return sql<Date | null>`greatest(
      (select max(g.start_at) from games g
        where g.home_team_id = ${idRef} or g.away_team_id = ${idRef}),
      (select max(e.start_at) from team_events e where e.team_id = ${idRef}))`
  if (kind === 'season')
    return sql<Date | null>`greatest(
      (select max(g.start_at) from games g where g.season_id = ${idRef}),
      (select max(e.start_at) from team_events e
        where e.team_id in (
          select team_id from season_team_parents where season_id = ${idRef}
          union
          select team_id from season_teams where season_id = ${idRef} and active)))`
  return sql<Date | null>`greatest(
    (select max(g.start_at) from games g
      where g.season_id in (select id from seasons where league_id = ${idRef})),
    (select max(e.start_at) from team_events e
      where e.team_id in (select id from teams where league_id = ${idRef})))`
}

/** The miles from a point to a row's `latitude` and `longitude`. */
export function milesSql(
  latitude: number,
  longitude: number,
  rowLatitude: RawBuilder<number | null>,
  rowLongitude: RawBuilder<number | null>
): RawBuilder<number | null> {
  return sql<number | null>`(${EARTH_MILES}::float8 * 2 * asin(least(1, sqrt(
    power(sin(radians(${rowLatitude} - ${latitude}::float8) / 2), 2)
    + cos(radians(${latitude}::float8)) * cos(radians(${rowLatitude}))
      * power(sin(radians(${rowLongitude} - ${longitude}::float8) / 2), 2)))))`
}

function sourceOf(kind: SearchGroupKind): RawBuilder<unknown> {
  if (kind === 'league')
    return sql`select l.id, l.name, l.locality, l.latitude, l.longitude,
        l.logo_path, null::text as league_logo_path, null::text as league_id,
        null::text as starts_on, null::text as ends_on
      from leagues l`
  if (kind === 'season')
    return sql`select s.id, s.name, l.locality, l.latitude, l.longitude,
        s.logo_path, l.logo_path as league_logo_path, s.league_id,
        s.starts_on::text as starts_on, s.ends_on::text as ends_on
      from seasons s left join leagues l on l.id = s.league_id`
  return sql`select t.id, t.name, t.locality, t.latitude, t.longitude,
      t.logo_path, null::text as league_logo_path, t.league_id,
      null::text as starts_on, null::text as ends_on
    from teams t where t.kind = 'full' and t.merged_into is null`
}

interface GroupRow {
  id: string
  name: string
  city: string | null
  region: string | null
  country: string | null
  logo_path: string | null
  league_logo_path: string | null
  league_id: string | null
  starts_on: string | null
  ends_on: string | null
  inside: boolean
  miles: number | null
  last_activity: Date | null
}

/** One kind's organizations for this search: at most `PER_KIND`. */
async function gatherKind(
  db: Kysely<Database>,
  kind: SearchGroupKind,
  ask: SearchAsk,
  typed: string[]
): Promise<Array<ScoredMatch<GroupCandidate>>> {
  const location = ask.location
  const fields = [sql`f.fname`, sql`f.fcity`, sql`f.fregion`, sql`f.fcountry`]
  const hit = (word: string): RawBuilder<boolean> =>
    sql<boolean>`(${sql.join(
      fields.map(
        field => sql`${field} like '%' || ts_name_fold(${literal(word)}) || '%'`
      ),
      sql` or `
    )})`
  const atStart = (word: string): RawBuilder<boolean> =>
    sql<boolean>`(f.fwords like '% ' || ts_name_fold(${literal(word)}) || '%')`
  const count = (
    test: (word: string) => RawBuilder<boolean>
  ): RawBuilder<number> =>
    sql<number>`(${sql.join(
      typed.map(word => sql`(case when ${test(word)} then 1 else 0 end)`),
      sql` + `
    )})`
  const insideCity =
    location?.kind === 'city'
      ? sql<boolean>`(f.fcity = ts_name_fold(${location.city ?? ''})
          and f.fregion in (${sql.join(regionSpellings(location.country, location.region ?? ''))})
          and f.fcountry in (${sql.join(countrySpellings(location.country))}))`
      : null
  const inside =
    location == null
      ? sql<boolean>`true`
      : location.kind === 'city'
        ? insideCity!
        : location.kind === 'region'
          ? sql<boolean>`(f.fregion in (${sql.join(regionSpellings(location.country, location.region ?? ''))})
              and f.fcountry in (${sql.join(countrySpellings(location.country))}))`
          : sql<boolean>`(f.fcountry in (${sql.join(countrySpellings(location.country))}))`
  const point = location?.kind === 'city' ? cityCoordinates(location) : null
  const miles =
    point == null
      ? sql<number | null>`null::float8`
      : milesSql(
          point.latitude,
          point.longitude,
          sql`f.latitude`,
          sql`f.longitude`
        )
  // A city widens to what has coordinates; a region or country only filters.
  const where =
    location == null
      ? sql`true`
      : point != null
        ? sql`(${inside} or f.latitude is not null)`
        : inside
  const ring =
    point == null
      ? sql``
      : sql`case when ${inside} then -1 else floor(${miles} / ${RING_MILES}::float8) end,`
  const text = typed.length > 0
  const folded = sql`
    f as (
      select src.*,
        ts_name_fold(src.name) as fname,
        ts_name_fold(src.locality->>'city') as fcity,
        ts_name_fold(src.locality->>'region') as fregion,
        ts_name_fold(src.locality->>'country') as fcountry,
        ' ' || regexp_replace(concat_ws(' ', ts_name_fold(src.name),
            ts_name_fold(src.locality->>'city'),
            ts_name_fold(src.locality->>'region'),
            ts_name_fold(src.locality->>'country')),
          '[^[:alnum:]'']+', ' ', 'g') as fwords
      from src
    )`
  const columns = sql`f.id, f.name, f.locality->>'city' as city,
      f.locality->>'region' as region, f.locality->>'country' as country,
      f.logo_path, f.league_logo_path, f.league_id, f.starts_on, f.ends_on,
      ${inside} as inside, ${miles} as miles`
  // Typed text ranks by words found. With a pill and nothing typed, the
  // nearest `ACTIVITY_ROWS` (by ring, distance, then name) are kept first,
  // and only theirs read for recent activity, the order they are then
  // listed in: three aggregates a row over the whole pill would be a scan.
  const { rows } = text
    ? await sql<GroupRow>`
    with src as (${sourceOf(kind)}), ${folded}
    select ${columns}, null::timestamptz as last_activity
    from f
    where ${where} and (${sql.join(typed.map(hit), sql` or `)})
    order by ${location == null ? sql`` : sql`${inside} desc,`} ${ring}
      ${count(hit)} desc, ${count(atStart)} desc, length(f.name),
      f.name, f.id
    limit ${PREFILTER_ROWS}
  `.execute(db)
    : await sql<GroupRow>`
    with src as (${sourceOf(kind)}), ${folded},
    near as (
      select ${columns}
      from f
      where ${where}
      order by ${inside} desc, ${ring} ${miles} nulls first, f.name, f.id
      limit ${ACTIVITY_ROWS}
    )
    select near.*, ${lastActivitySql(kind, sql`near.id`)} as last_activity
    from near
    order by near.inside desc,
      ${
        point == null
          ? sql``
          : sql`case when near.inside then -1
              else floor(near.miles / ${RING_MILES}::float8) end,`
      }
      last_activity desc nulls last, near.miles nulls first, near.name, near.id
    limit ${PER_KIND}
  `.execute(db)
  const scored = rows.map(row => {
    const candidate: GroupCandidate = {
      kind,
      id: row.id,
      name: row.name,
      place: [row.city, row.region, row.country],
      logoPath: row.logo_path,
      leagueLogoPath: row.league_logo_path,
      leagueId: row.league_id,
      startsOn: row.starts_on,
      endsOn: row.ends_on,
      inside: row.inside,
      miles: row.miles == null ? null : Number(row.miles),
      lastActivityAt: row.last_activity
    }
    const score = text
      ? matchScore(typed, {
          name: wordsOf(candidate.name),
          place: candidate.place.flatMap(part =>
            part == null ? [] : wordsOf(part)
          )
        })
      : NO_MATCH
    return { candidate, score }
  })
  return scored
    .filter(entry => !text || entry.score.matched > 0)
    .sort(candidateOrder(ask))
    .slice(0, PER_KIND)
}

interface PersonRow {
  id: string
  first_name: string | null
  last_name: string | null
  display_name: string
  avatar_path: string | null
  bats: PersonCandidate['bats']
  throws: PersonCandidate['throws']
  gumbo_id: number | null
  tier: number | null
}

/**
 * The people inside the reach whose stored names hold any typed word (with
 * no typed word, everybody in it), `PREFILTER_ROWS` of them from `offset`
 * on, leaving out who the target holds already.
 *
 * Inside the reach is a membership or a role on a reach team, on a team of
 * a reach season or league, or on a reach season or league itself; or a
 * guardian link to a player found so; or one of `guarded`, the reader's own
 * wards. For a target (Add Existing Player) only players are found: a
 * player membership on a team inside the reach, or one of `guarded`. A
 * person found under an account merged since is found as the account it was
 * merged into.
 */
async function peopleRows(
  db: Kysely<Database>,
  actor: Actor,
  reach: SearchReach,
  guarded: string[],
  typed: string[],
  target: CandidateTarget | null,
  offset: number
): Promise<PersonRow[]> {
  const teams = [...reach.teamIds]
  const seasons = [...reach.seasonIds]
  const leagues = [...reach.leagueIds]
  if (teams.length + seasons.length + leagues.length + guarded.length === 0)
    return []
  const stored = sql`ts_name_fold(concat_ws(' ', u.first_name, u.last_name, u.display_name))`
  const hit = (word: string): RawBuilder<boolean> =>
    sql<boolean>`(${stored} like '%' || ts_name_fold(${literal(word)}) || '%')`
  const hits =
    typed.length === 0
      ? sql`0`
      : sql`(${sql.join(
          typed.map(word => sql`(case when ${hit(word)} then 1 else 0 end)`),
          sql` + `
        )})`
  const tiers =
    target == null
      ? sql``
      : sql`,
    team_seasons as (
      select season_id, team_id from season_teams where active
      union
      select season_id, team_id from season_team_parents
    ),
    target_seasons as (${
      target.gameSeasonId != null
        ? sql`select ${target.gameSeasonId}::text as season_id`
        : sql`select season_id from team_seasons where team_id = ${target.teamId}`
    }),
    caller_teams as (
      select team_id from memberships where user_id = ${actor.userId}
      union
      select scope_id from scope_roles
        where user_id = ${actor.userId} and scope_type = 'team'
    ),
    -- Who plays on one of the caller's teams, or the target's seasons: a
    -- membership of the person or of an account merged into them. Read once
    -- here, for every person, not once per person in the tier: per person
    -- it scanned resolved for each of thousands of people, for minutes.
    caller_held as (
      select r.id from resolved r
        join memberships m on m.user_id = r.origin
        where m.team_id in (select team_id from caller_teams)
    ),
    season_held as (
      select r.id from resolved r
        join memberships m on m.user_id = r.origin
        where m.team_id in (select team_id from team_seasons
          where season_id in (select season_id from target_seasons))
    )`
  const tier =
    target == null
      ? sql<number | null>`null::int`
      : sql<number>`(case
          when u.id in (select unnest(${guarded}::text[]))
            or u.id in (select id from caller_held) then 0
          when u.id in (select id from season_held) then 1
          else 2
        end)`
  // Add Existing Player (a target) offers players only: whoever plays on a
  // team in reach, and the reader’s own guarded players, even on no team. Its
  // coaches, staff, spectators, guardians and scope holders are not.
  const players = target == null ? sql`` : sql`and m.is_player`
  const { rows } = await sql<PersonRow>`
    with recursive
    reach_teams as (select unnest(${teams}::text[]) as id),
    reach_seasons as (select unnest(${seasons}::text[]) as id),
    reach_leagues as (select unnest(${leagues}::text[]) as id),
    inside_teams as (
      select id from reach_teams
      union
      select team_id from season_team_parents
        where season_id in (select id from reach_seasons)
      union
      select team_id from season_teams
        where active and season_id in (select id from reach_seasons)
      union
      select id from teams where league_id in (select id from reach_leagues)
      union
      select st.team_id from season_team_parents st
        join seasons s on s.id = st.season_id
        where s.league_id in (select id from reach_leagues)
    ),
    found as (
      select m.user_id from memberships m
        join teams t on t.id = m.team_id and t.merged_into is null
        where m.team_id in (select id from inside_teams)
          ${players}
      ${
        target != null
          ? sql``
          : sql`union
      select user_id from scope_roles
        where (scope_type = 'team' and scope_id in (select id from inside_teams))
          or (scope_type = 'season' and scope_id in (select id from reach_seasons))
          or (scope_type = 'league' and scope_id in (select id from reach_leagues))
      union
      select user_id from season_members
        where season_id in (select id from reach_seasons)
      union
      select user_id from league_members
        where league_id in (select id from reach_leagues)`
      }
    ),
    linked as (
      select user_id from found
      ${
        target != null
          ? sql``
          : sql`union
      select l.user_id from user_links l
        where l.kind = 'guardian'
          and l.related_user_id in (select user_id from found)`
      }
      union
      select unnest(${guarded}::text[])
    ),
    resolved as (
      select user_id as origin, user_id as id from linked
      union
      select r.origin, u.merged_into from resolved r
        join users u on u.id = r.id
        where u.merged_into is not null
    )
    ${tiers}
    ${target == null ? sql`` : sql`, held as (${heldSql(target)})`},
    shown as (
      select u.id, u.first_name, u.last_name, u.display_name, u.avatar_path,
        u.bats, u.throws, g.gumbo_id, ${tier} as tier, ${hits} as hits
      from users u
      left join gumbo_ids g on g.user_id = u.id
      where u.id in (select id from resolved)
        and u.merged_into is null and u.disabled_at is null
        and u.deleted_at is null
        ${typed.length === 0 ? sql`` : sql`and (${sql.join(typed.map(hit), sql` or `)})`}
        ${target == null ? sql`` : sql`and u.id not in (select id from held where id is not null)`}
    )
    select id, first_name, last_name, display_name, avatar_path, bats, throws,
      gumbo_id, tier
    from shown
    order by ${
      typed.length === 0
        ? sql`tier nulls last, ts_name_fold(display_name)`
        : sql`hits desc, length(display_name)`
    }, id
    limit ${PREFILTER_ROWS} offset ${offset}
  `.execute(db)
  return rows
}

/** Every name of `page` added to `into`. */
function addNaming(into: ReaderNaming, page: ReaderNaming): void {
  for (const [key, value] of page.names) into.names.set(key, value)
  for (const [key, value] of page.formats) into.formats.set(key, value)
  for (const [key, value] of page.compact) into.compact.set(key, value)
  for (const [key, value] of page.compactFormats)
    into.compactFormats.set(key, value)
  for (const id of page.readsFull) into.readsFull.add(id)
}

/**
 * People for this search, at most `max` (`PER_KIND`, or `PEOPLE_ONLY_MAX` in
 * mode `people`), and how the reader reads them. The rows are read
 * `PREFILTER_ROWS` at a time, each page named as it comes, until `max` are
 * found by the name the reader is shown, none are left, or `PEOPLE_SCAN`
 * have been read: a row a hidden surname alone found is not found, and
 * reading on finds whom it pushed out. `onPeople` hears of the first
 * page's first `max` rows only, as they start to be named.
 */
async function gatherPeople(
  db: Kysely<Database>,
  actor: Actor,
  reach: SearchReach,
  guarded: string[],
  typed: string[],
  target: CandidateTarget | null,
  max: number,
  grants: Promise<FullNameGrants> | undefined,
  onPeople?: GatherOptions['onPeople']
): Promise<{
  people: Array<ScoredMatch<PersonCandidate>>
  naming: ReaderNaming | null
}> {
  const named = (row: PersonRow): NamedPerson => ({
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name
  })
  let naming: ReaderNaming | null = null
  const people: Array<ScoredMatch<PersonCandidate>> = []
  for (let offset = 0; offset < PEOPLE_SCAN; offset += PREFILTER_ROWS) {
    const rows = await peopleRows(
      db,
      actor,
      reach,
      guarded,
      typed,
      target,
      offset
    )
    if (rows.length === 0) break
    const naming$ = (async () => {
      // The grants were read beside the reach and the first page.
      const held = grants == null ? undefined : await grants
      return await readerNaming(
        db,
        rows.map(row => ({ person: named(row) })),
        readerOf(actor),
        held == null ? {} : { grants: held }
      )
    })()
    // The first page's first `max` rows are the likeliest answered: what
    // the caller reads about them starts while they are named.
    if (offset === 0)
      onPeople?.({
        ids: rows.slice(0, max).map(row => row.id),
        readsFull: naming$.then(found => found.readsFull)
      })
    const page = await naming$
    if (naming == null) naming = page
    else addNaming(naming, page)
    for (const row of rows) {
      const shown = page.names.get(row.id) ?? ''
      const onShown = matchScore(typed, { name: wordsOf(shown) })
      // A stored name is a finder only for somebody the reader reads in
      // full (any of the first, last and display names), or typed whole: no
      // word confirms a surname the row hides. Typed whole, every typed word
      // found them.
      const full = page.readsFull.has(row.id)
      const onStored = full
        ? matchScore(typed, {
            name: wordsOf(
              [row.first_name, row.last_name, row.display_name].join(' ')
            )
          })
        : NO_MATCH
      const score = onStored.matched > onShown.matched ? onStored : onShown
      const found = typed.filter(
        (_, at) => onShown.words[at] != null || onStored.words[at] != null
      )
      const matched =
        !full && found.length < typed.length && shownMatches(typed, shown, row)
          ? typed
          : found
      if (typed.length > 0 && matched.length === 0) continue
      people.push({
        candidate: {
          kind: 'person',
          id: row.id,
          name: shown,
          firstName: row.first_name,
          lastName: row.last_name,
          displayName: row.display_name,
          avatarPath: row.avatar_path,
          bats: row.bats,
          throws: row.throws,
          gumboId: row.gumbo_id,
          tier: row.tier == null ? null : (PERSON_TIERS[row.tier] ?? null),
          matched
        },
        score
      })
    }
    if (people.length >= max || rows.length < PREFILTER_ROWS) break
  }
  if (naming == null) return { people: [], naming: null }
  return {
    people: people
      .sort(
        typed.length === 0
          ? (a, b) => personOrder(a.candidate, b.candidate)
          : compareMatches
      )
      .slice(0, max),
    naming
  }
}

export interface GatherOptions {
  /**
   * Called once, as the first people rows start to be named: the first
   * `max` of them (`ids`), the likeliest the search answers, and whom of
   * them the reader reads in full, once the naming has found it. Whatever
   * the caller reads about them next can start while they are; a person
   * answered outside `ids` (past a row a hidden surname found) the caller
   * reads after.
   */
  onPeople?: (found: {
    ids: string[]
    readsFull: Promise<ReadonlySet<string>>
  }) => void
  /**
   * Called once the organizations are found, with them, while the people
   * may still be read.
   */
  onGroups?: (groups: GroupCandidate[]) => void
  /** The socket's reads of this reader, kept between its searches. */
  reader?: ReaderReads
  /**
   * The most people mode `people` gathers: `PEOPLE_ONLY_MAX` by default.
   * `GET /users?forTeam=` asks for its `limit`, up to 100.
   */
  peopleMax?: number
}

/**
 * Whether a search lists people with nothing typed: Add Existing Player's
 * empty field, in mode `people` with `forTeam`. Text with no words in it
 * (`%%%`) is not nothing typed: it finds nobody.
 */
export function listsEveryone(ask: SearchAsk): boolean {
  return ask.mode === 'people' && ask.forTeam != null && ask.text.trim() === ''
}

/**
 * Up to `PER_KIND` candidates of each kind for this search (in mode
 * `people`, up to `PEOPLE_ONLY_MAX` people). Organizations
 * in mode `all` only; people only with no pill and typed text (or, in mode
 * `people` with `forTeam`, an empty field: `listsEveryone`), and in mode
 * `people` with `forTeam` only where `candidateTarget` lets the reader add
 * players, leaving out who is on the team or in the game already.
 */
export async function gather(
  db: Kysely<Database>,
  actor: Actor | null,
  ask: SearchAsk,
  options: GatherOptions = {}
): Promise<Gathered> {
  const typed = [...new Set(wordsOf(ask.text))].slice(0, TYPED_WORDS_MAX)
  // The organizations need nothing of the reader's: they are read while the
  // reach, the reader's wards and then their people are.
  const groups = async (): Promise<Array<ScoredMatch<GroupCandidate>>> => {
    const found =
      ask.mode === 'all' && (typed.length > 0 || ask.location != null)
        ? (
            await Promise.all(
              (['league', 'season', 'team'] as const).map(
                async kind => await gatherKind(db, kind, ask, typed)
              )
            )
          ).flat()
        : []
    options.onGroups?.(found.map(entry => entry.candidate))
    return found
  }
  const reader = async (): Promise<
    Omit<Gathered, 'typed' | 'candidates'> & {
      people: Array<ScoredMatch<PersonCandidate>>
    }
  > => {
    const target =
      ask.mode === 'people' && ask.forTeam != null && actor != null
        ? await candidateTarget(db, actor, ask.forTeam, ask.forGame)
        : null
    const findsPeople =
      actor != null &&
      ask.location == null &&
      (typed.length > 0 || (target != null && listsEveryone(ask)))
    const kept = options.reader
    // The reader's grants are read beside the reach, for the naming after.
    const grants = findsPeople ? kept?.grants() : undefined
    grants?.catch(() => undefined)
    const [reach, guarded] = await Promise.all([
      kept?.reach(target?.teamId, target?.gameSeasonId) ??
        searchReach(db, actor, target?.teamId, target?.gameSeasonId),
      findsPeople ? (kept?.guarded() ?? guardedRows(db, actor.userId)) : []
    ])
    const { people, naming } = findsPeople
      ? await gatherPeople(
          db,
          actor,
          reach,
          guarded,
          typed,
          target,
          ask.mode === 'people'
            ? (options.peopleMax ?? PEOPLE_ONLY_MAX)
            : PER_KIND,
          grants,
          options.onPeople
        )
      : { people: [], naming: null }
    return { reach, people, naming, target }
  }
  const [organizations, found] = await Promise.all([groups(), reader()])
  return {
    typed,
    reach: found.reach,
    candidates: [...organizations, ...found.people],
    naming: found.naming,
    target: found.target
  }
}
