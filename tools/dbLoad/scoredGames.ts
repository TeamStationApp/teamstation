import type { GumboPlay } from '../../src/common/gumboPlay'
import type { ScoringAction } from '../../src/common/scoring/actions'
import { newSetup } from '../../src/common/scoring/lineup'
import {
  ScoringSession,
  type SessionContext,
  type StoredGame
} from '../../src/common/scoring/session'
import type {
  GameSetup,
  GameState,
  Position,
  Side
} from '../../src/common/scoring/state'
import { recordBySide } from '../../src/common/scoring/teamRecord'
import { MemoryStore } from '../../src/test/replayGameFixture'

/** One player of a seeded roster, as a scorer's lineup needs them. */
export interface RosterPlayer {
  gumboId: number
  first: string
  last: string
  /** Absent on the bench. */
  position?: Position
}

/** What a game's scorer needs to know of its two teams. */
export interface GameSides {
  away: { id: string; name: string; players: RosterPlayer[] }
  home: { id: string; name: string; players: RosterPlayer[] }
}

/** The fielding positions a roster's first nine players take. */
export const POSITIONS: Position[] = [
  'P',
  'C',
  '1B',
  '2B',
  '3B',
  'SS',
  'LF',
  'CF',
  'RF'
]

/** A repeatable stream of numbers in [0, 1), so a seed builds the same shapes. */
export function randomFrom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

/** Both lineups, each roster batting in its order. */
export function contextOf(gameId: string, sides: GameSides): SessionContext {
  const teams = {
    away: { id: sides.away.id, name: sides.away.name },
    home: { id: sides.home.id, name: sides.home.name }
  }
  const roster = (
    players: RosterPlayer[]
  ): Array<{
    gumboId: number
    shortName: string
  }> =>
    players.map(player => ({
      gumboId: player.gumboId,
      shortName: `${player.first} ${player.last}`
    }))
  const setup: GameSetup = newSetup(teams, {
    away: roster(sides.away.players),
    home: roster(sides.home.players)
  })
  for (const side of ['away', 'home'] as const) {
    const team = setup.sides[side]
    const starters = sides[side].players.filter(
      player => player.position != null
    )
    for (const player of sides[side].players) {
      setup.players[player.gumboId].firstName = player.first
      setup.players[player.gumboId].lastName = player.last
    }
    team.battingOrder = starters.map(player => player.gumboId)
    team.battingIndex = 0
    for (const position of POSITIONS) team.defense[position] = null
    for (const player of starters)
      team.defense[player.position as Position] = player.gumboId
  }
  return { gamePk: gameId, teams, setup }
}

const CLOSE: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }

function pitches(calls: Array<'B' | 'C' | 'S' | 'F'>): ScoringAction[] {
  return calls.map(call => ({ type: 'pitch', call }))
}

/** The side whose turn it is in the field. */
function fielding(state: GameState): Side {
  return state.liveData.linescore.isTopInning ? 'home' : 'away'
}

/**
 * One batter, from first pitch to the play closing. About 60% of batters make
 * an out and a third walk, which gives a game about ten plays and forty
 * pitches an inning, with runs from the odd home run clearing the bases.
 */
export function batterActions(
  state: GameState,
  random: () => number
): ScoringAction[] {
  const roll = random()
  if (roll < 0.33) return [...pitches(['B', 'C', 'B', 'B', 'F', 'B']), CLOSE]
  if (roll < 0.4)
    return [
      ...pitches(['B', 'C']),
      {
        type: 'ballInPlay',
        contact: 'swing',
        launchAngle: 31.5,
        launchAngleDragged: true,
        location: { x: -40, z: -128 },
        homeRunKind: 'out-of-park'
      },
      { type: 'result', eventType: 'home_run' },
      CLOSE
    ]
  if (roll < 0.7) return [...pitches(['C', 'B', 'F', 'B', 'S']), CLOSE]
  const fielder =
    state.liveData.boxscore.teams[fielding(state)].defense.CF ?? undefined
  return [
    ...pitches(['B', 'F']),
    {
      type: 'ballInPlay',
      contact: 'swing',
      launchAngle: 38,
      location: { x: 4, z: -92 },
      ...(fielder == null ? {} : { fielder })
    },
    { type: 'result', eventType: 'field_out', outBy: 'catch' },
    CLOSE
  ]
}

/** A relief pitcher for the side in the field, if its bench has one left. */
export function reliefAction(
  state: GameState,
  sides: GameSides
): ScoringAction | undefined {
  const side = fielding(state)
  const team = state.liveData.boxscore.teams[side]
  const replaces = team.defense.P
  const player = sides[side].players.find(
    candidate =>
      candidate.position == null &&
      !team.battingOrder.includes(candidate.gumboId)
  )
  if (replaces == null || player == null) return undefined
  return {
    type: 'lineup',
    kind: 'substitute',
    side,
    player: player.gumboId,
    replaces,
    position: 'P'
  }
}

export interface ScriptedGame extends StoredGame {
  /** How many lineup changes and corrections its scorer made. */
  lineupChanges: number
  corrections: number
}

/**
 * A whole game as a scorer takes it, through the scoring screen's own session
 * into a store in memory: every play, pitch, relief pitcher and correction, in
 * the form the server is sent. `final` ends it, and otherwise it stops at the
 * start of the last half's last batter.
 */
export async function scriptedGame(
  gameId: string,
  sides: GameSides,
  options: {
    innings: number
    final: boolean
    random: () => number
    /** Bring a reliever every so many innings; 0 never does. */
    reliefEvery?: number
    /** Undo and take again every so many batters; 0 never does. */
    correctEvery?: number
  }
): Promise<ScriptedGame> {
  const store = new MemoryStore()
  const session = await ScoringSession.open(
    store,
    gameId,
    contextOf(gameId, sides),
    {
      now: () => new Date('2026-09-26T17:00:00Z'),
      setTimer: () => null,
      clearTimer: () => undefined
    }
  )
  const take = (action: ScoringAction): void => {
    const applied = session.apply(action)
    if (applied.problems.length > 0)
      throw new Error(
        `${JSON.stringify(action)}: ${applied.problems[0].message}`
      )
  }
  const reliefEvery = options.reliefEvery ?? 0
  const correctEvery = options.correctEvery ?? 0
  let lineupChanges = 0
  let corrections = 0
  let batters = 0
  let reliefInning = 0
  const inning = (): number => session.state.liveData.linescore.currentInning
  while (inning() <= options.innings) {
    if (
      reliefEvery > 0 &&
      inning() % reliefEvery === 0 &&
      inning() !== reliefInning
    ) {
      reliefInning = inning()
      const relief = reliefAction(session.state, sides)
      if (relief != null) {
        take(relief)
        lineupChanges += 1
      }
    }
    batters += 1
    const actions = batterActions(session.state, options.random)
    if (correctEvery > 0 && batters % correctEvery === 0) {
      // A pitch called wrongly: it comes back off the record and is called again.
      take(actions[0])
      session.undo()
      corrections += 1
    }
    for (const action of actions) take(action)
  }
  if (options.final) take({ type: 'gameFlow', kind: 'endGame' })
  await session.flush()
  session.close()
  return {
    ...store.storedForms(),
    lineupChanges,
    corrections
  }
}

/**
 * The same play as an older build stored it. Version 2 names its sides as home
 * and away; version 1 also names its players by session number, here the same
 * numbers as their scoring ids. The game reads the same at each, which is what
 * makes all three worth keeping in one game: replaying it reads each kind.
 */
export function asOlderRecord(
  play: GumboPlay,
  sides: GameSides,
  version: 1 | 2
): GumboPlay {
  const record = recordBySide((play as { teamStation?: unknown }).teamStation, {
    away: sides.away,
    home: sides.home
  }) as { setupBefore: GameSetup; actions: ScoringAction[] }
  if (version === 2)
    return { ...play, teamStation: record } as unknown as GumboPlay
  return {
    ...play,
    teamStation: {
      ...record,
      version: 1,
      setupBefore: legacySetup(record.setupBefore),
      actions: record.actions.map(action =>
        'setup' in action && action.setup != null
          ? { ...action, setup: legacySetup(action.setup) }
          : action
      )
    }
  } as unknown as GumboPlay
}

/** A setup as version 1 wrote it, whose player numbers are the session's. */
function legacySetup(setup: GameSetup): unknown {
  const { tagOrder: _tagOrder, ...kept } = setup
  const ids = Object.keys(setup.players).map(Number)
  return {
    ...kept,
    players: Object.fromEntries(
      ids.map(id => [id, { ...setup.players[id], userId: id }])
    ),
    identities: {
      sessionToSource: Object.fromEntries(ids.map(id => [id, id])),
      sourceToSession: Object.fromEntries(ids.map(id => [`number:${id}`, id])),
      nextId: Math.max(0, ...ids) + 1
    }
  }
}
