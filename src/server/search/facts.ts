import { type Kysely, sql } from 'kysely'

import type { NamedPerson } from '../../common/names'
import type { ScoredMatch } from '../../common/search/match'
import { placeLabel } from '../../common/search/places'
import type { SearchAsk, SearchGroupKind } from '../../common/search/types'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { readerNaming } from '../groups/playerNamePrivacy'
import { readerOf, runSpoken } from '../users/readerNames'
import type { CandidateTarget } from '../users/rosterCandidates'
import type { Candidate, PersonCandidate } from './gather'
import { lastActivitySql } from './gather'
import type { JevCandidateFacts, JevLocationFacts } from './jev'
import type { FoundLocation } from './locations'
import { inReach, type SearchReach } from './reach'

/** What a search found, as Jev's facts are read from it. */
export interface FactsInput {
  ask: SearchAsk
  typed: string[]
  reach: SearchReach
  target: CandidateTarget | null
  /** Every candidate, in lexicographic order: `c1` is the first. */
  ordered: Array<ScoredMatch<Candidate>>
  /** The suggested pills, in lexicographic order: `l1` is the first. */
  locations: FoundLocation[]
  /** The groups the reader follows, as `kind:id`. */
  followed: Set<string>
}

/** The facts Jev ranks by, keyed `c1`… and `l1`…. */
export interface JevFacts {
  candidates: Record<string, JevCandidateFacts>
  locations: Record<string, JevLocationFacts>
}

const day = (at: Date | null | undefined): string | undefined =>
  at == null ? undefined : new Date(at).toISOString().slice(0, 10)

/**
 * Each group's most recent game or team event, by `kind:id`: one query for
 * every kind, its kinds' reads side by side.
 */
async function lastActivity(
  db: Kysely<Database>,
  groups: Array<{ kind: SearchGroupKind; id: string }>
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>()
  const kinds = (['league', 'season', 'team'] as const).flatMap(kind => {
    const ids = groups.filter(group => group.kind === kind).map(g => g.id)
    return ids.length === 0 ? [] : [{ kind, ids }]
  })
  if (kinds.length === 0) return out
  const { rows } = await sql<{
    kind: SearchGroupKind
    id: string
    at: Date | null
  }>`${sql.join(
    kinds.map(
      ({ kind, ids }) => sql`
        select ${kind}::text as kind, x.id,
          ${lastActivitySql(kind, sql`x.id`)} as at
        from unnest(${ids}::text[]) as x(id)`
    ),
    sql` union all `
  )}`.execute(db)
  for (const row of rows)
    if (row.at != null) out.set(`${row.kind}:${row.id}`, row.at)
  return out
}

/** The reader's ties to these people. */
async function personTies(
  db: Kysely<Database>,
  actor: Actor | null,
  reach: SearchReach,
  target: CandidateTarget | null,
  ids: string[]
): Promise<Map<string, JevCandidateFacts['ties']>> {
  const out = new Map<string, JevCandidateFacts['ties']>()
  if (actor == null || ids.length === 0) return out
  const teams = [...reach.teamIds]
  const { rows } = await sql<{
    id: string
    shares: boolean
    guardian: boolean
    season: boolean
    league: boolean
  }>`
    with target_seasons as (
      ${
        target == null
          ? sql`select null::text as season_id where false`
          : target.gameSeasonId != null
            ? sql`select ${target.gameSeasonId}::text as season_id`
            : sql`select season_id from season_team_parents
                    where team_id = ${target.teamId}
                  union
                  select season_id from season_teams
                    where active and team_id = ${target.teamId}`
      }
    ),
    target_teams as (
      select team_id from season_team_parents
        where season_id in (select season_id from target_seasons)
      union
      select team_id from season_teams
        where active and season_id in (select season_id from target_seasons)
    )
    select x.id,
      exists (select 1 from memberships m
        where m.user_id = x.id and m.team_id = any(${teams}::text[])) as shares,
      exists (select 1 from user_links l
        where l.user_id = ${actor.userId} and l.related_user_id = x.id
          and l.kind = 'guardian') as guardian,
      exists (select 1 from memberships m
        where m.user_id = x.id
          and m.team_id in (select team_id from target_teams)) as season,
      exists (select 1 from memberships m join teams t on t.id = m.team_id
        where m.user_id = x.id and t.league_id = ${target?.leagueId ?? null}::text)
        as league
    from unnest(${ids}::text[]) as x(id)
  `.execute(db)
  for (const row of rows)
    out.set(row.id, {
      sharesTeam: row.shares,
      guardian: row.guardian,
      ...(target == null
        ? {}
        : { inTargetSeason: row.season, inTargetLeague: row.league })
    })
  return out
}

/**
 * Jev's facts about each candidate and pill. A person's name is the one a
 * model is given (`runSpoken(readerNaming)`), never more than the reader is
 * shown.
 */
export async function jevFacts(
  db: Kysely<Database>,
  actor: Actor | null,
  input: FactsInput
): Promise<JevFacts> {
  const groups = input.ordered.flatMap(({ candidate }) =>
    candidate.kind === 'person' ? [] : [candidate]
  )
  const people = input.ordered.flatMap(({ candidate }) =>
    candidate.kind === 'person' ? [candidate] : []
  )
  const named = (person: PersonCandidate): NamedPerson => ({
    id: person.id,
    firstName: person.firstName,
    lastName: person.lastName,
    displayName: person.displayName
  })
  // Each of these reads needs only the candidates: they are made at once.
  const [activity, spoken, ties] = await Promise.all([
    lastActivity(db, groups),
    people.length === 0
      ? null
      : runSpoken(
          async () =>
            await readerNaming(
              db,
              people.map(person => ({ person: named(person) })),
              readerOf(actor ?? undefined)
            )
        ),
    personTies(
      db,
      actor,
      input.reach,
      input.target,
      people.map(person => person.id)
    )
  ])
  const candidates: Record<string, JevCandidateFacts> = {}
  input.ordered.forEach(({ candidate, score }, index) => {
    const words = input.typed.map((word, at) => ({
      word,
      match: score.words[at] ?? null
    }))
    const key = `c${index + 1}`
    if (candidate.kind === 'person') {
      candidates[key] = {
        kind: 'person',
        name: spoken?.names.get(candidate.id) ?? '',
        words,
        coverage: score.coverage,
        ties: ties.get(candidate.id) ?? {}
      }
      return
    }
    const [city, region, country] = candidate.place
    const facts: JevCandidateFacts = {
      kind: candidate.kind,
      name: candidate.name,
      words,
      coverage: score.coverage,
      ties: {
        member:
          actor != null && inReach(input.reach, candidate.kind, candidate.id),
        follows: input.followed.has(`${candidate.kind}:${candidate.id}`)
      }
    }
    if (city != null) facts.city = city
    if (region != null) facts.region = region
    if (country != null) facts.country = country
    if (city != null || region != null || country != null)
      facts.placeLabel = placeLabel({
        kind: city != null ? 'city' : region != null ? 'region' : 'country',
        city: city ?? undefined,
        region: region ?? undefined,
        country: country ?? ''
      })
    const last = day(activity.get(`${candidate.kind}:${candidate.id}`))
    if (last != null) facts.lastActivityOn = last
    if (candidate.startsOn != null) facts.startsOn = candidate.startsOn
    if (candidate.endsOn != null) facts.endsOn = candidate.endsOn
    if (input.ask.location?.kind === 'city' && candidate.miles != null)
      facts.milesAway = Math.round(candidate.miles * 10) / 10
    candidates[key] = facts
  })
  const locations: Record<string, JevLocationFacts> = {}
  input.locations.forEach(({ location, population }, index) => {
    locations[`l${index + 1}`] = {
      kind: location.kind,
      label: location.label,
      ...(location.city == null ? {} : { city: location.city }),
      ...(location.region == null ? {} : { region: location.region }),
      country: location.country,
      population
    }
  })
  return { candidates, locations }
}
