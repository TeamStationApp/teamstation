import { mapPlayers } from '../../common/scoring/actions'
import { recordOf, type TeamStationRecord } from '../../common/scoring/gumbo'
import type { StoredGame } from '../../common/scoring/session'
import { type GameSetup, POSITIONS } from '../../common/scoring/state'
import { ownTeams, recordByTeam } from '../../common/scoring/teamRecord'
import { asGumboId } from '../../common/userId'

/**
 * A game's documents with every scoring identity changed by one rule: the
 * pure projection that reads a game through account merges, and that a
 * proposed merge is checked against. Positions, counts, clocks and event ids
 * stay as they are; nothing here names anybody.
 */

const playerReferences = new Set([
  'batter',
  'catcher',
  'fielder',
  'pitcher',
  'runner',
  'responsiblePitcher',
  'player',
  'replacedPlayer'
])

/** Internal diagnostics: only the authorized merge caller exposes them. */
export class ScoringProjectionConflict extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown>
  ) {
    super(message)
  }
}

/**
 * An event's `said` with its players' ids changed: the players its sentence
 * names (`player`, `replaced`), a batting order's moved players, and an
 * action's lead. A typed name with no id stays.
 */
function mapSaid(raw: unknown, resolve: (id: number) => number): unknown {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const id = (value: unknown): unknown =>
    typeof value === 'number' ? resolve(asGumboId(value)) : value
  const withPlayer = (value: unknown): unknown =>
    value != null && typeof value === 'object' && !Array.isArray(value)
      ? {
          ...value,
          player: id((value as { player?: unknown }).player)
        }
      : value
  const said = raw as Record<string, unknown>
  const out: Record<string, unknown> = { ...said }
  for (const key of ['player', 'replaced'])
    if (key in out) out[key] = id(out[key])
  if (Array.isArray(said.moved)) out.moved = said.moved.map(withPlayer)
  if ('lead' in said) out.lead = withPlayer(said.lead)
  return out
}

/** Change only scoring identity fields. Positions, counts, clocks and event ids stay intact. */
function mapDocument<T>(document: T, resolve: (id: number) => number): T {
  const setup = (held: GameSetup): GameSetup => {
    const players: GameSetup['players'] = {}
    const originals = new Map<number, GameSetup['players'][number]>()
    // Prefer the surviving account's saved player details when both aliases occur.
    const entries = Object.values(held.players).sort(
      (a, b) => Number(resolve(a.id) === a.id) - Number(resolve(b.id) === b.id)
    )
    for (const player of entries) {
      const id = resolve(player.id)
      const previous = originals.get(id)
      if (previous != null && previous.teamId !== player.teamId)
        throw new ScoringProjectionConflict(
          'Merged scoring identities belong to opposing teams',
          {
            participants: [previous, player].map(person => ({
              gumboId: person.id,
              teamId: person.teamId,
              name: person.fullName
            }))
          }
        )
      originals.set(id, player)
      players[id] = { ...player, id }
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
  const visit = (raw: unknown, parent = '', grandparent = ''): unknown => {
    if (Array.isArray(raw))
      return raw.map(value => visit(value, parent, grandparent))
    if (raw == null || typeof raw !== 'object') return raw
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'teamStation') {
        // Read and written back under its own teams: a version 3 record
        // keeps every team id it named.
        const own = ownTeams(value)
        const record = recordOf({ teamStation: value }, own)
        const stored = (mapped: object): unknown =>
          (value as { version?: unknown }).version === 3
            ? recordByTeam(mapped as TeamStationRecord, own)
            : mapped
        result[key] =
          record == null
            ? value
            : stored({
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
              })
      } else if (key === 'said' && parent === 'playEvents') {
        result[key] = mapSaid(value, resolve)
      } else if (
        (key === 'creditUserId' ||
          (key === 'id' &&
            (playerReferences.has(parent) ||
              (grandparent === 'offense' &&
                ['first', 'second', 'third'].includes(parent))))) &&
        value != null
      ) {
        result[key] = resolve(asGumboId(value))
      } else result[key] = visit(value, key, parent)
    }
    return result
  }
  return visit(document) as T
}

/** Every scoring identity referenced by a saved setup, action, sentence or play. */
export function scoringIdsIn(stored: {
  plays: readonly unknown[]
  currentPlay: unknown
}): number[] {
  const ids = new Set<number>()
  const collect = (id: number): number => {
    ids.add(id)
    return id
  }
  for (const document of [...stored.plays, stored.currentPlay])
    mapDocument(document, collect)
  return [...ids]
}

/** The team each player of a game's setups appears for, the latest setup last. */
export function playerTeamsIn(stored: {
  plays: readonly unknown[]
  currentPlay: unknown
}): Map<number, string> {
  const teams = new Map<number, string>()
  const collect = (setup: GameSetup): void => {
    for (const player of Object.values(setup.players))
      teams.set(player.id, player.teamId)
  }
  for (const document of [...stored.plays, stored.currentPlay]) {
    const value = (document as { teamStation?: unknown } | null)?.teamStation
    if (value == null) continue
    const record = recordOf({ teamStation: value }, ownTeams(value))
    if (record == null) continue
    collect(record.setupBefore)
    for (const action of record.actions)
      if ('setup' in action && action.setup != null) collect(action.setup)
  }
  return teams
}

type GumboDocument = StoredGame['plays'][number] | StoredGame['currentPlay']

/** The same pure projection is used for reads and for a proposed merge. */
export function projectScoringGame<T extends StoredGame>(
  stored: T,
  resolve: (id: number) => number
): T {
  const project = <D extends GumboDocument>(document: D): D => {
    try {
      return mapDocument(document, resolve)
    } catch (error) {
      if (!(error instanceof ScoringProjectionConflict)) throw error
      throw new ScoringProjectionConflict(error.message, {
        ...error.details,
        atBatIndex: document?.about.atBatIndex,
        inning: document?.about.inning,
        halfInning: document?.about.halfInning
      })
    }
  }
  return {
    ...stored,
    plays: stored.plays.map(project),
    currentPlay: project(stored.currentPlay)
  }
}
