import type { Kysely } from 'kysely'

import { conflict } from '../../common/errors'
import { shortNames } from '../../common/names'
import { mapPlayers } from '../../common/scoring/actions'
import { recordOf } from '../../common/scoring/gumbo'
import type { StoredGame } from '../../common/scoring/session'
import { type GameSetup, POSITIONS } from '../../common/scoring/state'
import { asGumboId } from '../../common/userId'
import { UnresolvedAccount } from '../admin/people'
import type { Database } from '../db/database'
import { resolveGumboIds } from './gumboIds'

const playerReferences = new Set([
  'batter',
  'fielder',
  'pitcher',
  'runner',
  'responsiblePitcher',
  'player',
  'replacedPlayer'
])
/** Change only scoring identity fields. Positions, counts, clocks and event ids stay intact. */
function mapDocument<T>(
  document: T,
  resolve: (id: number) => number,
  names: Map<number, string>
): T {
  const setup = (held: GameSetup): GameSetup => {
    const players: GameSetup['players'] = {}
    // Prefer the surviving account's saved player details when both aliases occur.
    const entries = Object.values(held.players).sort(
      (a, b) => Number(resolve(a.id) === a.id) - Number(resolve(b.id) === b.id)
    )
    for (const player of entries) {
      const id = resolve(player.id)
      if (players[id] != null && players[id].teamId !== player.teamId)
        throw new Error('Merged scoring identities belong to opposing teams')
      const name = names.get(id)
      players[id] = {
        ...player,
        id,
        ...(name == null
          ? {}
          : {
              fullName: name,
              firstName: undefined,
              lastName: undefined
            })
      }
    }
    const sides = { ...held.sides }
    for (const side of ['away', 'home'] as const) {
      const old = held.sides[side]
      const pitchCounts: Record<number, number> = {}
      for (const [key, count] of Object.entries(old.pitchCounts)) {
        const id = resolve(asGumboId(Number(key)))
        pitchCounts[id] = (pitchCounts[id] ?? 0) + count
      }
      sides[side] = {
        ...old,
        players: [...new Set(old.players.map(resolve))],
        // Historical turns remain turns even when two accounts became one person.
        battingOrder: old.battingOrder.map(resolve),
        defense: Object.fromEntries(
          POSITIONS.map(position => [
            position,
            old.defense[position] == null
              ? null
              : resolve(old.defense[position])
          ])
        ) as GameSetup['sides']['home']['defense'],
        pitchCounts
      }
    }
    return {
      players,
      sides,
      tagOrder: [...new Set(held.tagOrder.map(resolve))]
    }
  }
  const visit = (raw: unknown, parent = ''): unknown => {
    if (Array.isArray(raw)) return raw.map(value => visit(value, parent))
    if (raw == null || typeof raw !== 'object') return raw
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'teamStation') {
        const record = recordOf({ teamStation: value })
        result[key] =
          record == null
            ? value
            : {
                ...(value as Record<string, unknown>),
                ...record,
                ...(record.detail == null
                  ? {}
                  : { detail: visit(record.detail) }),
                setupBefore: setup(record.setupBefore),
                actions: record.actions.map(action => ({
                  ...mapPlayers(action, value => resolve(asGumboId(value))),
                  ...('setup' in action && action.setup != null
                    ? { setup: setup(action.setup) }
                    : {})
                }))
              }
      } else if (
        (key === 'creditUserId' ||
          (key === 'id' && playerReferences.has(parent))) &&
        value != null
      ) {
        result[key] = resolve(asGumboId(value))
      } else result[key] = visit(value, key)
    }
    return result
  }
  return visit(document) as T
}

/** A read-only projection: callers keep raw documents and digests for writes and concurrency. */
export async function resolveScoringGame<T extends StoredGame>(
  db: Kysely<Database>,
  stored: T
): Promise<T> {
  const ids = new Set<number>()
  const collect = (id: number): number => {
    ids.add(id)
    return id
  }
  for (const document of [...stored.plays, stored.currentPlay])
    mapDocument(document, collect, new Map())
  const resolved = await resolveGumboIds(db, [...ids]).catch(
    (error: unknown) => {
      if (error instanceof UnresolvedAccount)
        throw conflict(
          'The scoring history refers to an account that cannot be resolved'
        )
      throw error
    }
  )
  if ([...resolved].every(([id, survivor]) => id === survivor)) return stored
  const targets = new Set(
    [...resolved]
      .filter(([id, survivor]) => id !== survivor)
      .map(([, survivor]) => survivor)
  )
  const rows = await db
    .selectFrom('gumbo_ids')
    .innerJoin('users', 'users.id', 'gumbo_ids.user_id')
    .select(['gumbo_id as id', 'display_name', 'first_name', 'last_name'])
    .where('gumbo_id', 'in', [...new Set(resolved.values())])
    .execute()
  // General scoring reads also feed public scoreboards. Disambiguate against
  // everyone in the game without adding private name parts to the projection.
  const labels = shortNames(
    rows.map(row => ({
      id: row.id,
      displayName: row.display_name,
      firstName: row.first_name,
      lastName: row.last_name
    }))
  )
  const names = new Map(
    rows
      .filter(row => targets.has(row.id))
      .map(row => [row.id, labels.get(row.id)!])
  )
  const resolve = (id: number): number => {
    const survivor = resolved.get(id)
    if (survivor == null) throw new Error('Missing scoring identity')
    return survivor
  }
  return {
    ...stored,
    plays: stored.plays.map(play => mapDocument(play, resolve, names)),
    currentPlay: mapDocument(stored.currentPlay, resolve, names)
  }
}
