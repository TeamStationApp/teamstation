import { isDeepStrictEqual } from 'node:util'

import type { Kysely } from 'kysely'

import { conflict, forbidden, notFound } from '../../common/errors'
import { calendarDateText, type GroupRef } from '../../common/groupCreation'
import {
  groupKey,
  type ParentAction,
  type ParentEffect,
  type ParentPreview
} from '../../common/groupLinks'
import { formatDateRange } from '../../common/seasonTimeFrames'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { groupScopeIds, noteScopeChange } from '../socket/syncRevision'
import { canAdminister, currentActor } from './rights'

interface Graph {
  teams: Map<string, { leagueId: string | null; parents: Set<string> }>
  seasons: Map<string, string | null>
  ranges: Map<
    string,
    { startsOn: string | null; endsOn: string | null; timezone: string }
  >
  leagues: Set<string>
}
async function graph(db: Kysely<Database>): Promise<Graph> {
  const teams = await db
    .selectFrom('teams')
    .select(['id', 'league_id'])
    .where('kind', '=', 'full')
    .where('merged_into', 'is', null)
    .execute()
  const seasons = await db
    .selectFrom('seasons')
    .select(['id', 'league_id', 'starts_on', 'ends_on', 'timezone'])
    .execute()
  const leagues = await db.selectFrom('leagues').select('id').execute()
  const parents = await db
    .selectFrom('season_team_parents')
    .select(['team_id', 'season_id'])
    .execute()
  return {
    teams: new Map(
      teams.map(row => [
        row.id,
        {
          leagueId: row.league_id,
          parents: new Set(
            parents
              .filter(edge => edge.team_id === row.id)
              .map(edge => edge.season_id)
          )
        }
      ])
    ),
    seasons: new Map(seasons.map(row => [row.id, row.league_id])),
    ranges: new Map(
      seasons.map(row => [
        row.id,
        {
          startsOn: calendarDateText(row.starts_on),
          endsOn: calendarDateText(row.ends_on),
          timezone: row.timezone
        }
      ])
    ),
    leagues: new Set(leagues.map(row => row.id))
  }
}
function state(value: Graph, ref: GroupRef): string {
  if (ref.kind === 'team') {
    const team = value.teams.get(ref.id)
    if (team == null) throw notFound()
    return JSON.stringify([team.leagueId, [...team.parents].sort()])
  }
  if (ref.kind === 'season') {
    if (!value.seasons.has(ref.id)) throw notFound()
    return JSON.stringify([value.seasons.get(ref.id), value.ranges.get(ref.id)])
  }
  if (!value.leagues.has(ref.id)) throw notFound()
  return 'league'
}
function validate(value: Graph): void {
  for (const team of value.teams.values()) {
    if (team.parents.size > 1 && team.leagueId == null)
      throw conflict(
        'Two or more parent seasons must share a league. Attach both seasons to one league in an explicit batch.'
      )
    for (const seasonId of team.parents)
      if (value.seasons.get(seasonId) !== team.leagueId)
        throw conflict(
          'Every parent season must have the same league as its team. Review a consistent batch or use competition membership.'
        )
  }
}

/** Preview includes every implied removal/adoption; no competition or game table is touched. */
export async function previewParents(
  db: Kysely<Database>,
  actions: ParentAction[]
): Promise<ParentPreview> {
  const original = await graph(db)
  const proposed = await graph(db)
  const affected = new Map<string, GroupRef>()
  for (const action of actions) {
    state(original, action.child)
    state(original, action.parent)
    affected.set(groupKey(action.child), action.child)
    affected.set(groupKey(action.parent), action.parent)
    if (action.child.kind === 'season') {
      const before = proposed.seasons.get(action.child.id)!
      if (action.operation === 'attach') {
        if (before != null && before !== action.parent.id)
          throw conflict(
            'Break the current league relationship before moving this season'
          )
        proposed.seasons.set(action.child.id, action.parent.id)
        for (const [id, team] of proposed.teams)
          if (team.parents.has(action.child.id)) {
            affected.set(`team:${id}`, { kind: 'team', id })
            team.leagueId ??= action.parent.id
            for (const seasonId of team.parents)
              affected.set(`season:${seasonId}`, {
                kind: 'season',
                id: seasonId
              })
          }
      } else if (before === action.parent.id) {
        proposed.seasons.set(action.child.id, null)
        for (const [id, team] of proposed.teams)
          if (team.parents.has(action.child.id) && team.leagueId != null) {
            team.parents.delete(action.child.id)
            affected.set(`team:${id}`, { kind: 'team', id })
          }
      }
    } else {
      const team = proposed.teams.get(action.child.id)!
      if (action.parent.kind === 'season') {
        if (action.operation === 'attach') {
          const league = proposed.seasons.get(action.parent.id)!
          team.leagueId ??= league
          team.parents.add(action.parent.id)
        } else team.parents.delete(action.parent.id)
      } else if (action.operation === 'attach') {
        if (team.leagueId != null && team.leagueId !== action.parent.id)
          throw conflict(
            'Break the current league relationship before moving this team'
          )
        team.leagueId = action.parent.id
      } else if (team.leagueId === action.parent.id) {
        team.leagueId = null
        for (const seasonId of [...team.parents])
          if (proposed.seasons.get(seasonId) != null) {
            team.parents.delete(seasonId)
            affected.set(`season:${seasonId}`, { kind: 'season', id: seasonId })
          }
      }
      for (const seasonId of team.parents)
        affected.set(`season:${seasonId}`, { kind: 'season', id: seasonId })
    }
  }
  validate(proposed)
  const effects: ParentEffect[] = []
  const diff = (
    child: GroupRef,
    before: Set<string>,
    after: Set<string>,
    parentKind: 'league' | 'season'
  ): void => {
    for (const id of before)
      if (!after.has(id))
        effects.push({
          child,
          parent: { kind: parentKind, id },
          operation: 'detach'
        })
    for (const id of after)
      if (!before.has(id))
        effects.push({
          child,
          parent: { kind: parentKind, id },
          operation: 'attach'
        })
  }
  for (const [id, team] of proposed.teams) {
    const before = original.teams.get(id)!
    diff({ kind: 'team', id }, before.parents, team.parents, 'season')
    diff(
      { kind: 'team', id },
      new Set(before.leagueId == null ? [] : [before.leagueId]),
      new Set(team.leagueId == null ? [] : [team.leagueId]),
      'league'
    )
  }
  for (const [id, league] of proposed.seasons) {
    const before = original.seasons.get(id)!
    diff(
      { kind: 'season', id },
      new Set(before == null ? [] : [before]),
      new Set(league == null ? [] : [league]),
      'league'
    )
  }
  effects.sort((a, b) =>
    `${groupKey(a.child)}:${groupKey(a.parent)}:${a.operation}`.localeCompare(
      `${groupKey(b.child)}:${groupKey(b.parent)}:${b.operation}`
    )
  )
  const groupName = async (ref: GroupRef): Promise<string> =>
    (
      await db
        .selectFrom(
          ref.kind === 'league'
            ? 'leagues'
            : ref.kind === 'season'
              ? 'seasons'
              : 'teams'
        )
        .select('name')
        .where('id', '=', ref.id)
        .executeTakeFirstOrThrow()
    ).name
  const descriptions = await Promise.all(
    effects.map(
      async effect =>
        `${effect.operation === 'detach' ? 'Remove' : 'Add'} ${await groupName(effect.parent)} as parent of ${await groupName(effect.child)}`
    )
  )
  const periods = await Promise.all(
    [...affected.values()]
      .filter(ref => ref.kind === 'season')
      .map(async ref => {
        const range = original.ranges.get(ref.id)!
        return `${await groupName(ref)} reference time frame: ${formatDateRange(range.startsOn, range.endsOn)} (${range.timezone}).`
      })
  )
  return {
    actions,
    effects,
    expected: Object.fromEntries(
      [...affected]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, ref]) => [key, state(original, ref)])
    ),
    // One line per effect first, in effect order: the app shows exactly
    // `effects.length` leading lines as the changes being decided.
    explanation: [
      ...descriptions,
      'Only management permissions change. Competition memberships, rosters, games and results are preserved.',
      ...periods
    ]
  }
}

export async function applyParents(
  db: Kysely<Database>,
  actors: Actor[],
  preview: ParentPreview
): Promise<void> {
  const run = async (trx: Kysely<Database>): Promise<void> => {
    await lockKeys(trx as Parameters<typeof lockKeys>[0], [
      'creation:parent-graph'
    ])
    const now = await graph(trx)
    for (const [key, expected] of Object.entries(preview.expected)) {
      const [kind, ...id] = key.split(':')
      if (
        state(now, { kind: kind as GroupRef['kind'], id: id.join(':') }) !==
        expected
      )
        throw conflict(
          'The parent relationships changed. Review a fresh invitation or preview.'
        )
    }
    const fresh = await Promise.all(
      actors.map(async actor => await currentActor(trx, actor))
    )
    for (const action of preview.actions) {
      const childRights = await Promise.all(
        fresh.map(async actor => await canAdminister(trx, actor, action.child))
      )
      const parentRights = await Promise.all(
        fresh.map(async actor => await canAdminister(trx, actor, action.parent))
      )
      if (
        action.operation === 'attach'
          ? !childRights.some(Boolean) || !parentRights.some(Boolean)
          : !childRights.some(Boolean) && !parentRights.some(Boolean)
      )
        throw forbidden(
          'This relationship needs current administrator authorization on its required sides'
        )
    }
    const current = await previewParents(trx, preview.actions)
    if (!isDeepStrictEqual(current.effects, preview.effects))
      throw conflict(
        'The affected parent links changed. Review the updated consequences.'
      )
    for (const effect of current.effects.filter(
      effect => effect.parent.kind === 'season' && effect.operation === 'detach'
    ))
      await trx
        .deleteFrom('season_team_parents')
        .where('team_id', '=', effect.child.id)
        .where('season_id', '=', effect.parent.id)
        .execute()
    // Preview effects sort by identity for stable consent terms. Apply league
    // removals before additions regardless of those identities' sort order.
    for (const operation of ['detach', 'attach'] as const)
      for (const effect of current.effects.filter(
        effect =>
          effect.parent.kind === 'league' && effect.operation === operation
      )) {
        const table = effect.child.kind === 'team' ? 'teams' : 'seasons'
        await trx
          .updateTable(table)
          .set({ league_id: operation === 'attach' ? effect.parent.id : null })
          .where('id', '=', effect.child.id)
          .execute()
      }
    for (const effect of current.effects.filter(
      effect => effect.parent.kind === 'season' && effect.operation === 'attach'
    ))
      await trx
        .insertInto('season_team_parents')
        .values({ team_id: effect.child.id, season_id: effect.parent.id })
        .onConflict(oc => oc.columns(['season_id', 'team_id']).doNothing())
        .execute()
    // Who sees which team moved: told to those who see either side.
    for (const effect of current.effects)
      noteScopeChange(trx, {
        ...groupScopeIds(effect.parent.kind, effect.parent.id),
        ...groupScopeIds(effect.child.kind, effect.child.id)
      })
  }
  await atomic(db, run)
}
