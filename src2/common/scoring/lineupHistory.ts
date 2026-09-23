import {
  asArray,
  asEither,
  asNull,
  asNumber,
  asObject,
  asString,
  asValue,
  type Cleaner
} from 'cleaners'

import type { CurrentPlay, GumboPlay } from '../gumboPlay'
import { asUserId } from '../userIdNumber'
import { recordOf, replayPlays } from './gumbo'
import { begun } from './lineup'
import {
  type GamePlayer,
  type GameSetup,
  type GameTeam,
  type Lineups,
  lineupsOf,
  type Position,
  POSITIONS,
  type Side
} from './state'

/**
 * Lineups read out of a game GameStation stores: the lineup each side began
 * with, every change MLB's record announces, and the lineup as it stands.
 * `replayPlays`, `begun` and `lineupsOf` do the work; nothing here replays a
 * game any other way.
 */

export interface LineupPerson {
  /** Null for a placeholder the team named at the field. */
  userId: number | null
  /** The short name the scoring screen shows; never a full name. */
  name: string
  jersey: string
}

export interface Lineup {
  /** The batting order: slot 0 leads off. */
  batters: LineupPerson[]
  defense: Record<Position, LineupPerson | null>
}

export const SUBSTITUTION_TYPES = [
  'offensive_substitution',
  'defensive_substitution',
  'defensive_switch',
  'pitching_substitution',
  'gs_batting_order'
] as const
export type SubstitutionType = (typeof SUBSTITUTION_TYPES)[number]

/** One Gumbo substitution event, as stored. */
export interface LineupChange {
  /** The play it is announced in. */
  atBatIndex: number
  inning: number
  half: 'top' | 'bottom'
  /** The side the player belongs to. */
  side: Side
  eventType: SubstitutionType
  player: LineupPerson
  /** The Gumbo position abbreviation: PH, PR, SS, P, … */
  position: string | null
  /** The place in the order as MLB writes it, `"601"`. */
  battingOrder: string | null
  replaced: LineupPerson | null
  /** The announcement, as the live feed words it. */
  description: string
}

export interface SideLineups {
  /** The lineup the side began with; null until the game has begun. */
  start: Lineup | null
  /** Every change announced, in game order. */
  changes: LineupChange[]
  /**
   * The lineup as it stands, with changes not announced yet (a pinch hitter
   * waiting to bat); null for a game without GameStation's record.
   */
  current: Lineup | null
}

export interface StoredLineupGame {
  plays: GumboPlay[]
  currentPlay: CurrentPlay | null
}

export interface LineupContext {
  gamePk: string
  teams: Record<Side, GameTeam>
  /**
   * The lineups a game with no setup of its own starts from. A game read back
   * from its record starts from the record's, so a reader that has none may
   * leave it out.
   */
  setup?: GameSetup
  fenceDistanceFt?: number
}

export interface GameLineups {
  sides: Record<Side, SideLineups>
  /**
   * Whether the game has begun, as `begun` says; null when the record no
   * longer replays, so nobody can say.
   */
  begun: boolean | null
  /** Why the record did not replay, or null. */
  problem: string | null
}

const asLineupPerson: Cleaner<LineupPerson> = asObject({
  userId: asEither(asNull, asUserId),
  name: asString,
  jersey: asString
})

/** Checks a lineup: a team's default, or one the server sent. */
export const asLineup: Cleaner<Lineup> = asObject({
  batters: asArray(asLineupPerson),
  defense: asObject(
    Object.fromEntries(
      POSITIONS.map(position => [position, asEither(asNull, asLineupPerson)])
    ) as Record<Position, Cleaner<LineupPerson | null>>
  )
})

const asLineupChange: Cleaner<LineupChange> = asObject({
  atBatIndex: asNumber,
  inning: asNumber,
  half: asValue('top', 'bottom'),
  side: asValue('away', 'home'),
  eventType: asValue(...SUBSTITUTION_TYPES),
  player: asLineupPerson,
  position: asEither(asNull, asString),
  battingOrder: asEither(asNull, asString),
  replaced: asEither(asNull, asLineupPerson),
  description: asString
})

/** Checks one side's lineups, as `GET /games/:gameId/lineups` sends them. */
export const asSideLineups: Cleaner<SideLineups> = asObject({
  start: asEither(asNull, asLineup),
  changes: asArray(asLineupChange),
  current: asEither(asNull, asLineup)
})

/**
 * A team's default lineup: the starting lineup of the game it was taken
 * from, and when. A team without one has all three null.
 */
export interface DefaultLineup {
  lineup: Lineup | null
  fromGameId: string | null
  setAt: string | null
}
export const asDefaultLineup: Cleaner<DefaultLineup> = asObject({
  lineup: asEither(asNull, asLineup),
  fromGameId: asEither(asNull, asString),
  setAt: asEither(asNull, asString)
})
export const NO_DEFAULT_LINEUP: DefaultLineup = {
  lineup: null,
  fromGameId: null,
  setAt: null
}

/** One side of the engine's lineups, naming each person as the game knows him. */
export function lineupOf(
  lineups: Lineups,
  side: Side,
  players: Record<number, GamePlayer>
): Lineup {
  const person = (id: number): LineupPerson => {
    const player = players[id]
    return {
      userId: player?.userId ?? null,
      name: player?.fullName ?? '',
      jersey: player?.jersey ?? ''
    }
  }
  const own = lineups[side]
  return {
    batters: own.battingOrder.map(person),
    defense: Object.fromEntries(
      POSITIONS.map(position => {
        const id = own.defense[position]
        return [position, id == null ? null : person(id)]
      })
    ) as Record<Position, LineupPerson | null>
  }
}

/** A person as two lineups compare him: his user id, or a placeholder's name. */
function personKey(person: LineupPerson | null): string {
  if (person == null) return ''
  return person.userId != null ? `user:${person.userId}` : `name:${person.name}`
}

/**
 * The same batting order and the same fielders, by user id, and by name for
 * a placeholder. Jerseys and spellings of a real player's name do not count.
 */
export function sameArrangement(a: Lineup, b: Lineup): boolean {
  return (
    a.batters.length === b.batters.length &&
    a.batters.every(
      (person, slot) => personKey(person) === personKey(b.batters[slot])
    ) &&
    POSITIONS.every(
      position =>
        personKey(a.defense[position]) === personKey(b.defense[position])
    )
  )
}

/** Both sides' lineups: start, changes and current. */
export function lineupHistory(
  stored: StoredLineupGame,
  context: LineupContext
): Record<Side, SideLineups> {
  return readLineups(stored, context).sides
}

/**
 * Both sides' lineups, and whether the game has begun. A game GameStation
 * did not score, or whose record no longer replays, has no start and no
 * current lineup, only the substitutions its documents carry.
 */
export function readLineups(
  stored: StoredLineupGame,
  context: LineupContext
): GameLineups {
  const played = playsInOrder(stored)
  const records = played.map(recordOf)
  const firstRecord = records.find(record => record != null)
  if (firstRecord == null) {
    const hasBegun =
      stored.plays.length > 0 ||
      eventsOf(stored.currentPlay).some(event => event.isSubstitution !== true)
    return {
      sides: sidesOf(changesOf(played, context, {}), null, null),
      begun: hasBegun,
      problem: null
    }
  }
  let problem: string | null = null
  let replayed: ReturnType<typeof replayPlays> | null = null
  try {
    replayed = replayPlays(stored, {
      gamePk: context.gamePk,
      teams: context.teams,
      setup: context.setup ?? firstRecord.setupBefore,
      fenceDistanceFt: context.fenceDistanceFt
    })
    if (replayed.problems.length > 0) problem = replayed.problems[0].message
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error)
  }
  if (replayed == null || problem != null)
    return {
      sides: sidesOf(changesOf(played, context, {}), null, null),
      begun: null,
      problem
    }
  const state = replayed.state
  const players = state.gameData.players
  const hasBegun = begun(state)
  const first =
    state.liveData.plays.allPlays[0] ?? state.liveData.plays.currentPlay
  const began = hasBegun ? (first?.lineups?.began ?? null) : null
  const now = lineupsOf(state)
  return {
    sides: sidesOf(
      changesOf(played, context, players),
      side => (began == null ? null : lineupOf(began, side, players)),
      side => lineupOf(now, side, players)
    ),
    begun: hasBegun,
    problem: null
  }
}

function sidesOf(
  changes: LineupChange[],
  start: ((side: Side) => Lineup | null) | null,
  current: ((side: Side) => Lineup) | null
): Record<Side, SideLineups> {
  const side = (which: Side): SideLineups => ({
    start: start?.(which) ?? null,
    changes: changes.filter(change => change.side === which),
    current: current?.(which) ?? null
  })
  return { away: side('away'), home: side('home') }
}

/**
 * The stored plays and the current play, in index order. A stored play at the
 * current play's index was reopened by an undo, so the current play stands
 * for it.
 */
function playsInOrder(
  stored: StoredLineupGame
): Array<GumboPlay | CurrentPlay> {
  const reopened = stored.currentPlay?.about.atBatIndex
  const plays: Array<GumboPlay | CurrentPlay> = stored.plays.filter(
    play => play.about.atBatIndex !== reopened
  )
  if (stored.currentPlay != null) plays.push(stored.currentPlay)
  return plays.sort((a, b) => a.about.atBatIndex - b.about.atBatIndex)
}

interface StoredEvent {
  isSubstitution?: unknown
  details?: { eventType?: unknown; description?: unknown }
  player?: unknown
  position?: unknown
  battingOrder?: unknown
  replacedPlayer?: unknown
}

function eventsOf(play: unknown): StoredEvent[] {
  if (play == null || typeof play !== 'object') return []
  const events = (play as { playEvents?: unknown }).playEvents
  return Array.isArray(events)
    ? events.filter(
        (event): event is StoredEvent =>
          event != null && typeof event === 'object'
      )
    : []
}

/** A person a stored event names: `{ id, fullName }`, or only a name. */
function storedPerson(
  raw: unknown,
  players: Record<number, GamePlayer>
): LineupPerson | null {
  if (raw == null || typeof raw !== 'object') return null
  const { id, fullName } = raw as { id?: unknown; fullName?: unknown }
  const name = typeof fullName === 'string' ? fullName : ''
  const userId = typeof id === 'number' ? id : null
  const known = Object.values(players).find(player =>
    userId == null
      ? player.userId == null && player.fullName === name
      : player.userId === userId
  )
  return { userId, name, jersey: known?.jersey ?? '' }
}

/** The side a changed player belongs to, as the game knows him, or by the half. */
function sideOfChange(
  person: LineupPerson,
  eventType: SubstitutionType,
  half: 'top' | 'bottom',
  context: LineupContext,
  players: Record<number, GamePlayer>
): Side {
  const candidates = Object.values(players).filter(player =>
    person.userId == null
      ? player.userId == null && player.fullName === person.name
      : player.userId === person.userId
  )
  const teams = new Set(candidates.map(player => player.teamId))
  if (teams.size === 1) {
    const [teamId] = teams
    if (teamId === context.teams.home.id) return 'home'
    if (teamId === context.teams.away.id) return 'away'
  }
  const batting: Side = half === 'top' ? 'away' : 'home'
  const fielding: Side = half === 'top' ? 'home' : 'away'
  return eventType === 'offensive_substitution' ? batting : fielding
}

function positionOf(raw: unknown): string | null {
  if (typeof raw === 'string') return raw
  if (raw != null && typeof raw === 'object') {
    const abbreviation = (raw as { abbreviation?: unknown }).abbreviation
    if (typeof abbreviation === 'string') return abbreviation
  }
  return null
}

const TYPES: ReadonlySet<string> = new Set(SUBSTITUTION_TYPES)

/** Every substitution event the plays carry, in index then event order. */
function changesOf(
  plays: Array<GumboPlay | CurrentPlay>,
  context: LineupContext,
  players: Record<number, GamePlayer>
): LineupChange[] {
  const changes: LineupChange[] = []
  for (const play of plays) {
    const half = play.about.halfInning === 'bottom' ? 'bottom' : 'top'
    for (const event of eventsOf(play)) {
      if (event.isSubstitution !== true) continue
      const eventType = event.details?.eventType
      if (typeof eventType !== 'string' || !TYPES.has(eventType)) continue
      const type = eventType as SubstitutionType
      const player = storedPerson(event.player, players) ?? {
        userId: null,
        name: '',
        jersey: ''
      }
      changes.push({
        atBatIndex: play.about.atBatIndex,
        inning: play.about.inning ?? 0,
        half,
        side: sideOfChange(player, type, half, context, players),
        eventType: type,
        player,
        position: positionOf(event.position),
        battingOrder:
          typeof event.battingOrder === 'string' ? event.battingOrder : null,
        replaced: storedPerson(event.replacedPlayer, players),
        description:
          typeof event.details?.description === 'string'
            ? event.details.description
            : ''
      })
    }
  }
  return changes
}
