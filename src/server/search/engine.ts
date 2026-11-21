import { type Kysely, sql } from 'kysely'

import type { ScoredMatch } from '../../common/search/match'
import { wordsOf } from '../../common/search/match'
import { placeLabel } from '../../common/search/places'
import type {
  Location,
  SearchAsk,
  SearchGroupResult,
  SearchPersonResult,
  SearchResult
} from '../../common/search/types'
import { asUserId } from '../../common/userId'
import { visibleScopes } from '../access'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { imageUrl, PROFILE_SIZE } from '../media/imageUrls'
import type { SpaceSettings } from '../media/spacesHls'
import { jevKey } from '../nodeSettings'
import {
  listedNames,
  personAffiliations,
  shortened
} from '../users/personAffiliations'
import { readerOf } from '../users/readerNames'
import { rosterRows } from '../users/rosterCandidates'
import { type FactsInput, jevFacts } from './facts'
import {
  type Candidate,
  candidateOrder,
  gather,
  type Gathered,
  type GatherOptions,
  type GroupCandidate,
  listsEveryone
} from './gather'
import { JEV_MAX_CANDIDATES, jevRank } from './jev'
import {
  distinctLabels,
  findLocations,
  type FoundLocation,
  LOCATIONS_SHOWN,
  locationsReady
} from './locations'
import { emptyReach, inReach } from './reach'
import type { ReaderCache, ReaderReads } from './readerCache'
import type { ReaderPoint } from './readerPlace'

/**
 * The search engine the search socket and Add Existing Player answer from.
 *
 * `searchOnce` is the lexicographic answer, sent at once: every candidate
 * `gather` found (at most 80: 20 of each kind, or in mode `people` 80
 * people), in `candidateOrder`, the first
 * `RESULTS_MAX`, with the first `LOCATIONS_SHOWN` location pills.
 * `searchJev` asks Jev to re-rank the same candidates and pills, and is null
 * whenever Jev cannot answer: the lexicographic answer then stands.
 */
export const RESULTS_MAX = JEV_MAX_CANDIDATES

/** What the engine needs beside the database. */
export interface SearchDeps {
  space: SpaceSettings
  /** `serverConfig.jev.baseUrl`. */
  jevBaseUrl: string
  /** Where the answering Jev model's version is written. */
  log?: (line: string) => void
  /** The Jev call's timeout; `JEV_TIMEOUT_MS` by default. */
  jevTimeoutMs?: number
  /** The reader's day, for Jev's `today`. */
  now?: () => Date
  /**
   * The search socket's own `readerCache`: what the reader's searches read
   * about the reader alone is kept there between them. Without it, each
   * search reads it.
   */
  reader?: ReaderCache
  /**
   * Where the reader is (`readerPoints`), the search socket's for its
   * connection: equally good place pills nearest it come first. Without it,
   * none are ranked by nearness.
   */
  readerPoints?: () => Promise<ReaderPoint[]>
}

const placeName = (label: string | undefined): string | null =>
  label == null || label === '' ? null : label

/** What `searchOnce` found, for `searchJev` to re-rank. */
export interface SearchContext extends FactsInput {
  /** The row of each of `ordered`, at the same index. */
  results: SearchResult[]
  /** The reader's home area's label, for Jev; null when it is not known. */
  readerPlace: string | null
}

export interface SearchAnswer {
  results: SearchResult[]
  locations: Location[]
}

/**
 * Whether a search asks anything Jev could rank: typed words or a pill.
 * An empty field asks nothing, except Add Existing Player's
 * (`listsEveryone`), which `searchOnce` answers nearest first and Jev
 * does not re-rank.
 */
export function asksAnything(ask: SearchAsk): boolean {
  return wordsOf(ask.text).length > 0 || ask.location != null
}

/**
 * The groups of these the reader follows, as `kind:id`, read on every
 * search (never kept by the socket), so a Follow or Unfollow made over REST
 * shows on the next keystroke.
 */
async function followedGroups(
  db: Kysely<Database>,
  actor: Actor | null,
  groups: GroupCandidate[]
): Promise<Set<string>> {
  if (actor == null || groups.length === 0) return new Set()
  const rows = await db
    .selectFrom('follows')
    .select(['group_type', 'group_id'])
    .where('user_id', '=', actor.userId)
    .where(
      'group_id',
      'in',
      groups.map(group => group.id)
    )
    .execute()
  return new Set(rows.map(row => `${row.group_type}:${row.group_id}`))
}

/** The groups of these the reader follows, and their associations lines. */
async function groupFacts(
  db: Kysely<Database>,
  actor: Actor | null,
  groups: GroupCandidate[]
): Promise<[Set<string>, Map<string, string>]> {
  return await Promise.all([
    followedGroups(db, actor, groups),
    associationsOf(db, groups)
  ])
}

/**
 * The most a team's seasons, and its leagues, take of its associations
 * line, well under the 1024 characters the client accepts: what does not
 * fit is counted as `+N more`.
 */
export const ASSOCIATION_SEASONS_MAX = 360
export const ASSOCIATION_LEAGUES_MAX = 140
/**
 * The most a person's associations line takes, as a team's does: the
 * players they guard and their guardians and family first, then their teams
 * newest first, then `+N more`.
 */
export const PERSON_ASSOCIATIONS_MAX =
  ASSOCIATION_SEASONS_MAX + ASSOCIATION_LEAGUES_MAX

/**
 * Each group's associations line: a team's seasons (newest first) and
 * leagues, at most `ASSOCIATION_SEASONS_MAX` and `ASSOCIATION_LEAGUES_MAX`
 * characters of each; a season's league; a league's city.
 */
async function associationsOf(
  db: Kysely<Database>,
  groups: GroupCandidate[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const teams = groups.filter(group => group.kind === 'team')
  const leagueIds = [...new Set(groups.flatMap(group => group.leagueId ?? []))]
  const [leagueRows, seasonRows] = await Promise.all([
    leagueIds.length === 0
      ? []
      : db
          .selectFrom('leagues')
          .select(['id', 'name'])
          .where('id', 'in', leagueIds)
          .execute(),
    teams.length === 0
      ? []
      : sql<{
          team_id: string
          name: string
          league: string | null
        }>`
          select x.team_id, s.name, l.name as league
            from (
              select season_id, team_id from season_team_parents
                where team_id = any(${teams.map(team => team.id)}::text[])
              union
              select season_id, team_id from season_teams
                where active and team_id = any(${teams.map(team => team.id)}::text[])
            ) x
            join seasons s on s.id = x.season_id
            left join leagues l on l.id = s.league_id
            order by s.starts_on desc, s.ends_on desc, s.name, s.id
        `
          .execute(db)
          .then(result => result.rows)
  ])
  const leagues = new Map(leagueRows.map(row => [row.id, row.name]))
  const seasonsOf = new Map<
    string,
    Array<{ name: string; league: string | null }>
  >()
  for (const row of seasonRows) {
    const held = seasonsOf.get(row.team_id) ?? []
    held.push({ name: row.name, league: row.league })
    seasonsOf.set(row.team_id, held)
  }
  for (const group of groups) {
    const key = `${group.kind}:${group.id}`
    if (group.kind === 'league') {
      out.set(key, cityLineOf(group) ?? '')
      continue
    }
    const league =
      group.leagueId == null ? undefined : leagues.get(group.leagueId)
    if (group.kind === 'season') {
      out.set(key, league == null ? '' : shortened(league))
      continue
    }
    const seasons = seasonsOf.get(group.id) ?? []
    out.set(
      key,
      [
        listedNames(
          seasons.map(season => season.name),
          ASSOCIATION_SEASONS_MAX
        ),
        listedNames(
          [league, ...seasons.map(season => season.league)],
          ASSOCIATION_LEAGUES_MAX
        )
      ]
        .filter(part => part !== '')
        .join(' · ')
    )
  }
  return out
}

/** A group's city as its pill reads: `City, AB`; null with no city. */
function cityLineOf(group: GroupCandidate): string | null {
  const [city, region, country] = group.place
  if (city == null || city === '') return null
  return placeLabel({
    kind: 'city',
    city,
    region: region ?? undefined,
    country: country ?? ''
  })
}

/**
 * The rows of these candidates, in their order, and the groups of them the
 * reader follows, every read made at once. `affiliations` are the people's
 * lines, which `searchOnce` started reading while they were named.
 */
async function resultsOf(
  db: Kysely<Database>,
  actor: Actor | null,
  gathered: Gathered,
  ordered: Array<ScoredMatch<Candidate>>,
  read: {
    /** The people's lines, started while they were named. */
    affiliations: Promise<Map<string, string>> | null
    /** The groups' follows and associations, started once they were found. */
    groups: Promise<[Set<string>, Map<string, string>]> | null
  },
  reads: ReaderReads | undefined,
  deps: SearchDeps
): Promise<{ results: SearchResult[]; followed: Set<string> }> {
  const groups = ordered.flatMap(({ candidate }) =>
    candidate.kind === 'person' ? [] : [candidate]
  )
  const people = ordered.flatMap(({ candidate }) =>
    candidate.kind === 'person' ? [candidate] : []
  )
  // Add Existing Player's rows carry its card, built as the REST route
  // builds it; its affiliation line is the row's associations.
  const carded =
    actor != null && gathered.target != null && gathered.naming != null
  const [[followed, associations], cards, lines] = await Promise.all([
    read.groups ?? groupFacts(db, actor, groups),
    actor == null || !carded
      ? null
      : (async () => {
          // The socket's kept reads of the reader, when it has them.
          const [scopes, grants] =
            reads == null
              ? [undefined, undefined]
              : await Promise.all([reads.scopes(), reads.grants()])
          const rows = await rosterRows(db, actor, people, gathered.naming!, {
            space: deps.space,
            affiliationBudget: PERSON_ASSOCIATIONS_MAX,
            ...(scopes == null ? {} : { scopes }),
            ...(grants == null ? {} : { grants })
          })
          return new Map(rows.map(card => [card.userId, card]))
        })(),
    people.length === 0 || carded || read.affiliations == null
      ? new Map<string, string>()
      : read.affiliations
  ])
  const results = ordered.map(({ candidate }): SearchResult => {
    if (candidate.kind === 'person') {
      const card = cards?.get(candidate.id)
      const person: SearchPersonResult = {
        kind: 'person',
        userId: asUserId(candidate.id),
        name: candidate.name,
        avatarUrl: imageUrl(deps.space, candidate.avatarPath),
        associations: card?.affiliations ?? lines.get(candidate.id) ?? ''
      }
      if (card != null)
        person.roster = {
          gumboId: card.gumboId,
          shortName: card.shortName,
          ...(card.nameFormat == null ? {} : { nameFormat: card.nameFormat }),
          ...(card.compactName == null
            ? {}
            : { compactName: card.compactName }),
          ...(card.compactFormat == null
            ? {}
            : { compactFormat: card.compactFormat }),
          shortParts: card.shortParts,
          bats: card.bats,
          throws: card.throws,
          teams: card.teams,
          tier: card.tier,
          ...(candidate.matched.length === 0
            ? {}
            : { matched: candidate.matched })
        }
      return person
    }
    const key = `${candidate.kind}:${candidate.id}`
    const follow: SearchGroupResult['follow'] =
      actor == null || inReach(gathered.reach, candidate.kind, candidate.id)
        ? null
        : followed.has(key)
          ? 'following'
          : 'follow'
    return {
      kind: candidate.kind,
      id: candidate.id,
      name: candidate.name,
      imageUrl: imageUrl(
        deps.space,
        candidate.logoPath ?? candidate.leagueLogoPath,
        PROFILE_SIZE
      ),
      cityLine: candidate.kind === 'league' ? null : cityLineOf(candidate),
      associations: associations.get(key) ?? '',
      follow
    }
  })
  return { results, followed }
}

function emptyContext(ask: SearchAsk): SearchContext {
  return {
    ask,
    typed: [],
    reach: emptyReach(),
    target: null,
    ordered: [],
    locations: [],
    followed: new Set(),
    results: [],
    readerPlace: null
  }
}

/**
 * The lexicographic answer, and what `searchJev` needs to re-rank it. An
 * ask with no typed words and no pill answers nothing and reads nothing.
 * Mode `people` with `forTeam` throws as `candidateTarget` does for a team
 * or game the reader may not add players to.
 */
export async function searchOnce(
  db: Kysely<Database>,
  actor: Actor | null,
  ask: SearchAsk,
  deps: SearchDeps
): Promise<SearchAnswer & { context: SearchContext }> {
  if (!asksAnything(ask) && !listsEveryone(ask))
    return { results: [], locations: [], context: emptyContext(ask) }
  const reads = actor == null ? undefined : deps.reader?.of(db, actor)
  // The people's affiliation lines are read while they are named, for the
  // people the search likeliest answers, with the reader's scopes (kept by
  // the socket, or read now). Add Existing Player's cards need none.
  const linesOf = async (
    ids: string[],
    readsFull: Promise<ReadonlySet<string>> | ReadonlySet<string>
  ): Promise<Map<string, string>> => {
    if (actor == null) return new Map()
    const [scopes, grants] = await Promise.all([
      reads?.scopes() ?? visibleScopes(db, actor.userId, actor.isAdmin),
      reads?.grants()
    ])
    return await personAffiliations(db, ids, {
      reader: readerOf(actor),
      scopes,
      readsFull,
      budget: PERSON_ASSOCIATIONS_MAX,
      ...(grants == null ? {} : { grants })
    })
  }
  // Set by `onPeople`, which gather calls: held in an object, so its type
  // is not narrowed to the null it starts as.
  const started: {
    lines: Promise<Map<string, string>> | null
    asked: ReadonlySet<string>
  } = { lines: null, asked: new Set() }
  const onPeople: GatherOptions['onPeople'] = ({ ids, readsFull }) => {
    if (actor == null || ask.forTeam != null) return
    const read = linesOf(ids, readsFull)
    // A search that fails before it waits for them leaves no rejection
    // unhandled; awaiting them still throws.
    read.catch(() => undefined)
    started.lines = read
    started.asked = new Set(ids)
  }
  // The organizations' lines are read as soon as they are found.
  let groupLines: Promise<[Set<string>, Map<string, string>]> | null = null
  const onGroups = (groups: GroupCandidate[]): void => {
    groupLines = groupFacts(db, actor, groups)
    groupLines.catch(() => undefined)
  }
  // Where the reader is ranks the pills; a failure to tell ranks none by it.
  const near: Promise<ReaderPoint[]> =
    ask.location != null || ask.mode !== 'all' || deps.readerPoints == null
      ? Promise.resolve([])
      : deps.readerPoints().catch((error: unknown) => {
          deps.log?.(`search reader place unread: ${String(error)}`)
          return []
        })
  // The pills are found once gather's reads have gone out, while the
  // database answers them.
  const [gathered, locations] = await Promise.all([
    gather(db, actor, ask, {
      onPeople,
      onGroups,
      ...(reads == null ? {} : { reader: reads })
    }),
    (async (): Promise<FoundLocation[]> => {
      await new Promise(resolve => setImmediate(resolve))
      if (ask.location != null || ask.mode !== 'all') return []
      // A worker still warming the catalog finishes it first.
      await locationsReady()
      return findLocations(ask.text, undefined, await near)
    })()
  ])
  const ordered = [...gathered.candidates].sort(candidateOrder(ask))
  // Anybody answered past the rows the lines were started for is read now.
  const unasked = ordered.flatMap(({ candidate }) =>
    candidate.kind === 'person' && !started.asked.has(candidate.id)
      ? [candidate.id]
      : []
  )
  let affiliations = started.lines
  if (affiliations != null && unasked.length > 0 && gathered.naming != null) {
    const more = linesOf(unasked, gathered.naming.readsFull)
    affiliations = Promise.all([affiliations, more]).then(
      ([first, rest]) => new Map([...first, ...rest])
    )
  }
  const { results, followed } = await resultsOf(
    db,
    actor,
    gathered,
    ordered,
    { affiliations, groups: groupLines },
    reads,
    deps
  )
  return {
    results: results.slice(0, RESULTS_MAX),
    // Told apart among the pills shown, not the twelve Jev may choose from.
    locations: distinctLabels(
      locations.slice(0, LOCATIONS_SHOWN).map(found => found.location)
    ),
    context: {
      ask,
      typed: gathered.typed,
      reach: gathered.reach,
      target: gathered.target,
      ordered,
      locations,
      followed,
      results,
      // A place nothing names is no place to tell Jev.
      readerPlace: placeName((await near)[0]?.label)
    }
  }
}

/**
 * Jev's answer for the same search: its facts about every candidate and
 * pill `searchOnce` found, ranked by `jevRank`, mapped back onto the same
 * rows. Null with nothing to rank, no Jev key, or any answer `jevRank`
 * cannot use, and when `signal` aborts.
 */
export async function searchJev(
  db: Kysely<Database>,
  actor: Actor | null,
  ask: SearchAsk,
  context: SearchContext,
  deps: SearchDeps,
  signal?: AbortSignal
): Promise<(SearchAnswer & { model: string }) | null> {
  if (context.ordered.length + context.locations.length === 0) return null
  // Add Existing Player's empty field stays nearest first.
  if (!asksAnything(ask)) return null
  // Read again after each wait: a newer search may have aborted it.
  const aborted = (): boolean => signal?.aborted === true
  const key = await jevKey(db)
  if (key == null || aborted()) return null
  const facts = await jevFacts(db, actor, context)
  if (aborted()) return null
  const ranking = await jevRank(
    {
      query: ask.text,
      location: ask.location,
      today: (deps.now?.() ?? new Date()).toISOString().slice(0, 10),
      candidates: facts.candidates,
      locations: facts.locations,
      reader: { place: context.readerPlace }
    },
    key,
    deps.jevBaseUrl,
    signal,
    {
      ...(deps.jevTimeoutMs == null ? {} : { timeoutMs: deps.jevTimeoutMs }),
      ...(deps.log == null ? {} : { log: deps.log })
    }
  )
  if (ranking == null || aborted()) return null
  const at = (key: string): number => Number(key.slice(1)) - 1
  return {
    results: ranking.order.flatMap(each => context.results[at(each)] ?? []),
    locations: distinctLabels(
      ranking.locations.flatMap(
        each => context.locations[at(each)]?.location ?? []
      )
    ),
    model: ranking.model
  }
}
