import {
  asArray,
  asEither,
  asNull,
  asNumber,
  asObject,
  asString,
  type Cleaner
} from 'cleaners'

import { asLiteral } from '../asLiteral'
import type { CurrentPlay, GumboPlay } from '../gumboPlay'
import { asUserId } from '../userIdNumber'
import type { ScoringAction } from './actions'
import { recordOf, replayPlays } from './gumbo'
import { addPlayer, begun } from './lineup'
import {
  copyState,
  type GamePlayer,
  type GameSetup,
  type GameState,
  type GameTeam,
  type Lineups,
  lineupsOf,
  type Position,
  POSITIONS,
  setupOf,
  type Side
} from './state'

/**
 * Lineups read out of a game TeamStation stores: the lineup each side began
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
  'ts_batting_order'
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
   * waiting to bat); null for a game without TeamStation's record.
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

/** A pinch runner who keeps the batting order, as the play records him. */
export interface CourtesyRunner {
  atBatIndex: number
  player: LineupPerson
  replaced: LineupPerson | null
}

/**
 * Who is due up when that is not the next man the order would send. Either
 * the man the order names is on base and nobody has been chosen, or a save
 * has chosen someone else and he is the one at the plate.
 */
export interface DueBatter {
  awaiting: boolean
  player: LineupPerson
}

export interface GameLineups {
  sides: Record<Side, SideLineups>
  /**
   * People on the roster who are in neither the batting order nor the
   * field. A change to one of them is not a lineup change, and the digest
   * of the lineups counts them so a save of one is seen.
   */
  bench: Record<Side, LineupPerson[]>
  /**
   * Pinch runners who keep the batting order. Each is recorded on the play
   * and changes no lineup, and the digest of the lineups counts them so a
   * save of one is seen.
   */
  courtesy: CourtesyRunner[]
  /**
   * Who is due up when the order alone does not say so. Null when the man
   * the order names is the one at the plate, so a pitch leaves the digest
   * alone.
   */
  due: DueBatter | null
  /**
   * Whether the game has begun, as `begun` says; null when the record no
   * longer replays, so nobody can say.
   */
  begun: boolean | null
  /** Why the record did not replay, or null. */
  problem: string | null
}

const noBench = (): Record<Side, LineupPerson[]> => ({ away: [], home: [] })

/** People on `side` who are not in its batting order or its defense. */
function benchOf(state: GameState): Record<Side, LineupPerson[]> {
  const people = (side: Side): LineupPerson[] => {
    const team = state.liveData.boxscore.teams[side]
    const playing = new Set<number>(team.battingOrder)
    for (const position of POSITIONS) {
      const id = team.defense[position]
      if (id != null) playing.add(id)
    }
    return team.players
      .filter(id => !playing.has(id))
      .map(id => {
        const player = state.gameData.players[id]
        return {
          userId: player?.userId ?? null,
          name: player?.fullName ?? '',
          jersey: player?.jersey ?? ''
        }
      })
  }
  return { away: people('away'), home: people('home') }
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
  half: asLiteral('top', 'bottom'),
  side: asLiteral('away', 'home'),
  eventType: asLiteral(...SUBSTITUTION_TYPES),
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

/** One side of a roster setup, as two lineups compare it. */
function lineupFromSetup(setup: GameSetup, side: Side): Lineup {
  return lineupOf(
    {
      away: {
        battingOrder: setup.sides.away.battingOrder,
        defense: setup.sides.away.defense
      },
      home: {
        battingOrder: setup.sides.home.battingOrder,
        defense: setup.sides.home.defense
      }
    },
    side,
    setup.players
  )
}

/**
 * Sides whose starting lineup is still the roster order a save wrote because
 * the saver could not see that team, and that order. A later roster save
 * drops a side when it confirms the side and the arrangement is no longer
 * that order. A later action that arranges the side drops it too. Actions
 * after the game begins belong to the game, not to the lineup it began with.
 */
function placeholderMarks(actions: readonly ScoringAction[]): {
  sides: ReadonlySet<Side>
  lineups: ReadonlyMap<Side, Lineup>
} {
  const sides = new Set<Side>()
  const lineups = new Map<Side, Lineup>()
  for (const action of actions) {
    if (action.type !== 'lineup') break
    if (action.kind === 'roster' && action.setup != null) {
      const setup = action.setup
      for (const side of action.unseen ?? []) {
        if (!sides.has(side)) lineups.set(side, lineupFromSetup(setup, side))
        sides.add(side)
      }
      for (const side of action.confirmed ?? []) {
        const was = lineups.get(side)
        if (
          was == null ||
          !sameArrangement(was, lineupFromSetup(setup, side))
        ) {
          sides.delete(side)
          lineups.delete(side)
        }
      }
    } else if (
      action.side != null &&
      (action.kind === 'battingOrder' ||
        action.kind === 'position' ||
        action.kind === 'addPlayer' ||
        action.kind === 'substitute' ||
        action.kind === 'pinchRunner')
    ) {
      sides.delete(action.side)
      lineups.delete(action.side)
    }
  }
  return { sides, lineups }
}

/** Sides still held as the roster order a save left because it could not see them. */
export function placeholderSidesOf(
  actions: readonly ScoringAction[]
): ReadonlySet<Side> {
  return placeholderMarks(actions).sides
}

/**
 * The roster order a save left for `side` because it could not see that
 * team, while that order is still the side's starting lineup. Null once
 * the side was arranged, or was never unseen.
 */
export function unseenLineup(
  actions: readonly ScoringAction[],
  side: Side
): Lineup | null {
  return placeholderMarks(actions).lineups.get(side) ?? null
}

/**
 * Sides a roster save confirms. A side still unseen is confirmed only when
 * `setup` is no longer the roster order that save left. Every other side is
 * confirmed. An empty result means the save confirms nothing.
 */
export function confirmedSides(
  actions: readonly ScoringAction[],
  setup: GameSetup
): Side[] {
  return (['away', 'home'] as const).filter(side => {
    const placeholder = unseenLineup(actions, side)
    if (placeholder == null) return true
    return !sameArrangement(placeholder, lineupFromSetup(setup, side))
  })
}

/**
 * Sides still unseen whose arrangement in `setup` is no longer that roster
 * order. A play scored from that arrangement logs it first, so the saved
 * game scores the lineup the screen showed.
 */
export function revealedSides(
  actions: readonly ScoringAction[],
  setup: GameSetup
): Side[] {
  return confirmedSides(actions, setup).filter(
    side => unseenLineup(actions, side) != null
  )
}

/**
 * Whether `side` is still the roster order a save left because it could not
 * see that team. A shown snapshot may replace that side and no other.
 */
function stillUnseenOrder(
  actions: readonly ScoringAction[],
  state: GameState,
  side: Side
): boolean {
  const placeholder = unseenLineup(actions, side)
  if (placeholder == null) return false
  return sameArrangement(
    lineupOf(lineupsOf(state), side, state.gameData.players),
    placeholder
  )
}

/**
 * The action a rebase replays. A roster marked `shown` is the lineup the
 * scoring screen was showing in place of an unseen order, ahead of a play.
 * It may replace only a side that is still that order. Every other side
 * stays as the server holds it, players off the card included. A person on
 * the side it does replace is the server's player of that user id, or of
 * that placeholder's name, and a placeholder the server does not have yet
 * is allocated from the server's ids. Null when the snapshot replaces
 * nothing, so the pitch follows the server. A roster the scorer saved from
 * the sheet carries no such mark and is returned as it is.
 */
export function reconcileShownLineup(
  action: ScoringAction,
  actions: readonly ScoringAction[],
  state: GameState
): ScoringAction | null {
  if (
    action.type !== 'lineup' ||
    action.kind !== 'roster' ||
    action.shown !== true ||
    action.setup == null
  )
    return action
  const replace = (['away', 'home'] as const).filter(side =>
    stillUnseenOrder(actions, state, side)
  )
  if (replace.length === 0) return null
  const current = setupOf(state)
  const setup = action.setup
  const players = copyState(current.players)
  const identities = copyState(current.identities)
  const sides = {
    away: copyState(current.sides.away),
    home: copyState(current.sides.home)
  }
  const draft = {
    gameData: { teams: state.gameData.teams, players },
    liveData: { boxscore: { teams: sides } },
    meta: { identities }
  }
  for (const side of replace) {
    const snap = setup.sides[side]
    const byUser = new Map<number, number>()
    const byName = new Map<string, number>()
    for (const id of sides[side].players) {
      const player = players[id]
      if (player == null) continue
      if (player.userId != null) byUser.set(player.userId, id)
      else byName.set(player.fullName, id)
    }
    const idOf = (snapId: number | null): number | null => {
      if (snapId == null) return null
      const person = setup.players[snapId]
      if (person == null) return null
      if (person.userId != null) return byUser.get(person.userId) ?? null
      const known = byName.get(person.fullName)
      if (known != null) return known
      const id = addPlayer(draft, side, person.fullName, person.jersey)
      byName.set(person.fullName, id)
      return id
    }
    const order: number[] = []
    for (const id of snap.battingOrder) {
      const next = idOf(id)
      if (next != null && !order.includes(next)) order.push(next)
    }
    const defense = Object.fromEntries(
      POSITIONS.map(position => [position, null])
    ) as Record<Position, number | null>
    const fielding = new Set<number>()
    for (const position of POSITIONS) {
      const id = idOf(snap.defense[position])
      if (id != null && !fielding.has(id)) {
        defense[position] = id
        fielding.add(id)
      }
    }
    const roster = [...sides[side].players]
    for (const id of [
      ...order,
      ...POSITIONS.map(position => defense[position])
    ])
      if (id != null && !roster.includes(id)) roster.push(id)
    sides[side] = {
      ...copyState(sides[side]),
      players: roster,
      battingOrder: order,
      battingIndex: 0,
      defense
    }
  }
  return {
    ...action,
    setup: { players, sides, identities },
    confirmed: replace
  }
}

/** Both sides' lineups: start, changes and current. */
export function lineupHistory(
  stored: StoredLineupGame,
  context: LineupContext
): Record<Side, SideLineups> {
  return readLineups(stored, context).sides
}

/**
 * Both sides' lineups, and whether the game has begun. A game TeamStation
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
      bench: noBench(),
      courtesy: courtesyOf(played, {}),
      due: null,
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
      bench: noBench(),
      courtesy: courtesyOf(played, {}),
      due: null,
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
    bench: benchOf(state),
    courtesy: courtesyOf(played, players),
    due: dueOf(state, stored),
    begun: hasBegun,
    problem: null
  }
}

/** Who is due up when the order alone does not say so, or null. */
function dueOf(state: GameState, stored: StoredLineupGame): DueBatter | null {
  const players = state.gameData.players
  const person = (id: number): LineupPerson => {
    const player = players[id]
    return {
      userId: player?.userId ?? null,
      name: player?.fullName ?? '',
      jersey: player?.jersey ?? ''
    }
  }
  const waiting = state.awaitingBatter
  if (waiting != null)
    return { awaiting: true, player: person(waiting.duePlayerId) }
  const side = state.liveData.linescore.isTopInning ? 'away' : 'home'
  const team = state.liveData.boxscore.teams[side]
  const dueId = team.battingOrder[team.battingIndex]
  if (dueId == null) return null
  if (state.liveData.linescore.offense.batter?.id !== dueId) return null
  const chosen = (recordOf(stored.currentPlay)?.actions ?? []).find(
    action =>
      action.type === 'lineup' &&
      action.kind === 'roster' &&
      action.nextBatter === dueId
  )
  return chosen == null ? null : { awaiting: false, player: person(dueId) }
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

/**
 * Pinch runners who keep the batting order, in index then event order. A
 * lineup change does not announce them.
 */
function courtesyOf(
  plays: Array<GumboPlay | CurrentPlay>,
  players: Record<number, GamePlayer>
): CourtesyRunner[] {
  const runners: CourtesyRunner[] = []
  for (const play of plays) {
    for (const event of eventsOf(play)) {
      if (event.details?.eventType !== 'ts_courtesy_runner') continue
      runners.push({
        atBatIndex: play.about.atBatIndex,
        player: storedPerson(event.player, players) ?? {
          userId: null,
          name: '',
          jersey: ''
        },
        replaced: storedPerson(event.replacedPlayer, players)
      })
    }
  }
  return runners
}

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
