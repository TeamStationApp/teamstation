import { expect } from 'chai'
import { describe, it } from 'mocha'

import { GUMBO_EVENT_TYPES } from '../gumboEventTypes'
import {
  ACTION_TYPES,
  BASE_RUNNING_KINDS,
  baseDestination,
  BASES,
  BATTERY_KINDS,
  cleanAction,
  CONTACTS,
  destinationBase,
  DESTINATIONS,
  ERROR_KINDS,
  GAME_FLOW_KINDS,
  HOME_RUN_KINDS,
  LINEUP_KINDS,
  OUT_KINDS,
  PITCH_CALLS,
  PRODUCED_EVENT_TYPES,
  promptContext,
  RESULT_TYPES,
  RUNNER_REASONS,
  type ScoringAction,
  toolSchema,
  TRAJECTORIES
} from './actions'
import { storedEventType } from './document'
import {
  asGameSetup,
  asGameState,
  copyState,
  type GameState,
  POSITIONS,
  setupOf
} from './state'

/** Nine a side, the home team in the field, a runner on second. */
export function sampleGame(): GameState {
  const players: GameState['gameData']['players'] = {}
  const side = (
    offset: number,
    teamId: string
  ): GameState['liveData']['boxscore']['teams']['away'] => {
    const ids = Array.from({ length: 9 }, (_, i) => offset + i)
    for (const id of ids)
      players[id] = {
        id,
        userId: id * 1000,
        teamId,
        fullName: `Player ${id}`,
        jersey: String(id),
        bats: 'right',
        throws: 'right',
        positions: [],
        local: false
      }
    return {
      players: ids,
      battingOrder: ids,
      battingIndex: 0,
      defense: Object.fromEntries(
        POSITIONS.map((position, index) => [position, ids[index]])
      ) as GameState['liveData']['boxscore']['teams']['away']['defense'],
      pitchCounts: {}
    }
  }
  const away = side(1, 'team-away')
  const home = side(10, 'team-home')
  const ref = (id: number): { id: number; fullName: string } => ({
    id,
    fullName: `Player ${id}`
  })
  return {
    gamePk: 'g1',
    gameData: {
      teams: {
        away: { id: 'team-away', name: 'Visitors' },
        home: { id: 'team-home', name: 'Hosts' }
      },
      players
    },
    liveData: {
      linescore: {
        currentInning: 3,
        currentInningOrdinal: '3rd',
        inningState: 'Top',
        isTopInning: true,
        balls: 1,
        strikes: 2,
        outs: 1,
        teams: {
          away: { runs: 2, hits: 3, errors: 0 },
          home: { runs: 1, hits: 2, errors: 1 }
        },
        offense: { batter: ref(4), first: null, second: ref(3), third: null },
        defense: Object.fromEntries(
          POSITIONS.map((position, index) => [position, ref(10 + index)])
        ) as GameState['liveData']['linescore']['defense']
      },
      boxscore: { teams: { away, home } },
      plays: { allPlays: [], currentPlay: null }
    },
    pending: null,
    homeQueue: [],
    recentPitch: null,
    awaitingBatter: null,
    final: false,
    meta: {
      sequence: 0,
      identities: { sourceToSession: {}, sessionToSource: {}, nextId: 19 }
    }
  }
}

const examples: ScoringAction[] = [
  { type: 'pitch', call: 'B', zone: 12 },
  {
    type: 'ballInPlay',
    contact: 'bunt',
    trajectory: 'ground_ball',
    launchAngle: -10,
    location: { x: 1, z: -20 },
    fielder: 11,
    landingHeight: 0,
    homeRunKind: 'in-park'
  },
  {
    type: 'result',
    eventType: 'manual_placement',
    base: '2B',
    outBy: 'throw',
    foulCaught: false
  },
  {
    type: 'fieldingPlay',
    fielders: [14, 13],
    error: 13,
    errorKind: 'throwing',
    locations: [{ x: 0, z: 0 }]
  },
  {
    type: 'runnerMovement',
    runner: 3,
    to: 'home',
    out: true,
    reason: 'Out at home',
    fielders: [17, 11],
    locations: [{ x: 1, z: 2 }],
    runnerLocation: { x: 0, z: 1 }
  },
  { type: 'baseRunning', kind: 'steal', runner: 3, to: '3B', fielders: [] },
  {
    type: 'batteryEvent',
    kind: 'wild_pitch',
    advances: [{ runner: 3, to: '3B' }]
  },
  {
    type: 'lineup',
    kind: 'substitute',
    side: 'home',
    position: 'SS',
    player: 18,
    replaces: 14,
    name: 'New Kid',
    jersey: '99',
    batSide: 'L',
    order: [1, 2],
    nextBatter: 2
  },
  {
    type: 'gameFlow',
    kind: 'override',
    runner: 3,
    base: '1B',
    inning: 4,
    top: false,
    awayScore: 1,
    homeScore: 2,
    balls: 0,
    strikes: 0,
    outs: 2,
    batter: 12,
    pitcher: 5,
    bases: [null, 13, null]
  }
]

describe('scoring actions', function () {
  it('round-trips one example of every action through its cleaner', function () {
    expect(examples.map(action => action.type)).deep.equals([...ACTION_TYPES])
    for (const action of examples)
      expect(cleanAction(copyState(action))).deep.equals({ action })
  })

  it('carries a whole setup on a roster change', function () {
    const setup = setupOf(sampleGame())
    const result = cleanAction({ type: 'lineup', kind: 'roster', setup })
    expect(result).deep.equals({
      action: { type: 'lineup', kind: 'roster', setup }
    })
  })

  it('answers an unknown or malformed action with a problem, never a throw', function () {
    expect(cleanAction({ type: 'dance' })).deep.equals({
      problem: { code: 'unknownAction', message: 'Unknown action "dance"' }
    })
    expect(cleanAction(null)).deep.equals({
      problem: { code: 'unknownAction', message: 'Unknown action null' }
    })
    const bad = cleanAction({ type: 'pitch', call: 'Z' })
    expect(bad).to.have.property('problem')
    expect((bad as { problem: { code: string } }).problem.code).equals(
      'malformed'
    )
    const thrown = cleanAction({ type: 'runnerMovement', runner: -1, to: '1B' })
    expect((thrown as { problem: { code: string } }).problem.code).equals(
      'malformed'
    )
  })

  it('offers exactly one tool per action, with every enum from its list', function () {
    const tools = toolSchema()
    expect(tools.map(tool => tool.name)).deep.equals([...ACTION_TYPES])
    const props = (
      name: string
    ): Record<string, { enum?: readonly unknown[] }> =>
      tools.find(tool => tool.name === name)?.input_schema.properties ?? {}
    expect(props('pitch').call.enum).deep.equals(PITCH_CALLS)
    expect(props('ballInPlay').contact.enum).deep.equals(CONTACTS)
    expect(props('ballInPlay').trajectory.enum).deep.equals(TRAJECTORIES)
    expect(props('ballInPlay').homeRunKind.enum).deep.equals(HOME_RUN_KINDS)
    expect(props('result').eventType.enum).deep.equals(RESULT_TYPES)
    expect(props('result').outBy.enum).deep.equals(OUT_KINDS)
    expect(props('result').base.enum).deep.equals(BASES)
    expect(props('fieldingPlay').errorKind.enum).deep.equals(ERROR_KINDS)
    expect(props('runnerMovement').to.enum).deep.equals(DESTINATIONS)
    expect(props('runnerMovement').reason.enum).deep.equals(RUNNER_REASONS)
    expect(props('baseRunning').kind.enum).deep.equals(BASE_RUNNING_KINDS)
    expect(props('batteryEvent').kind.enum).deep.equals(BATTERY_KINDS)
    expect(props('lineup').kind.enum).deep.equals(LINEUP_KINDS)
    expect(props('lineup').position.enum).deep.equals(POSITIONS)
    expect(props('gameFlow').kind.enum).deep.equals(GAME_FLOW_KINDS)
    for (const tool of tools) {
      expect(tool.description).not.equals('')
      expect(tool.input_schema.additionalProperties).equals(false)
      for (const required of tool.input_schema.required ?? [])
        expect(tool.input_schema.properties).to.have.property(required)
    }
  })

  it('tells a model the situation by name, and never the score or an index', function () {
    const text = promptContext(sampleGame())
    expect(text).includes('Top of the 3rd, 1 out, count 1-2.')
    expect(text).includes('Visitors batting, Hosts in the field.')
    expect(text).includes(
      'Batter: Player 4 (id 4). Pitcher: Player 10 (id 10).'
    )
    expect(text).includes('On first: nobody. On second: Player 3 (id 3).')
    expect(text).includes('SS Player 14 (id 14)')
    expect(text).not.match(/runs?\b|score|atBatIndex|at-bat/i)

    const bottom = sampleGame()
    const line = bottom.liveData.linescore
    line.isTopInning = false
    line.currentInning = 12
    line.outs = 2
    line.offense.batter = { id: 99, fullName: 'Unlisted' }
    expect(promptContext(bottom)).includes(
      'Bottom of the 12th, 2 outs, count 1-2.'
    )
    expect(promptContext(bottom)).includes(
      'Hosts batting, Visitors in the field.'
    )
    expect(promptContext(bottom)).includes('Batter: Unlisted (id 99).')
  })

  it('names bases and destinations both ways', function () {
    expect(DESTINATIONS.map(destinationBase)).deep.equals([0, 1, 2, 3, 4])
    expect([0, 1, 2, 3, 4, 7, -1].map(baseDestination)).deep.equals([
      'batter',
      '1B',
      '2B',
      '3B',
      'home',
      'home',
      'batter'
    ])
  })

  it('folds nothing the stored vocabulary does not accept', function () {
    // The document writes each type the engine produces as a listed code.
    const stored: readonly string[] = GUMBO_EVENT_TYPES
    for (const type of PRODUCED_EVENT_TYPES)
      expect(stored, type).to.include(storedEventType(type))
    expect(storedEventType('catcher_interference')).equals('catcher_interf')
    expect(storedEventType('manual_placement')).equals('gs_manual_placement')
    expect(storedEventType('placed_runner')).equals('runner_placed')
    // Other out is a runner's between pitches, and the batter's own is ours.
    expect(storedEventType('other_out')).equals('other_out')
    expect(storedEventType('other_out', 'Batter Out — Other')).equals(
      'gs_batter_out'
    )
  })
})

describe('game state and setup', function () {
  it('round-trips a game and its setup through their cleaners', function () {
    const game = sampleGame()
    expect(asGameState(copyState(game))).deep.equals(game)
    const setup = setupOf(game)
    expect(asGameSetup(copyState(setup))).deep.equals(setup)
    expect(setup.sides.home.defense.SS).equals(14)
    expect(setup.players[4].userId).equals(4000)
  })

  it('keeps a setup apart from the game it came from', function () {
    const game = sampleGame()
    const setup = setupOf(game)
    setup.sides.away.battingOrder.reverse()
    setup.players[1].fullName = 'Changed'
    expect(game.liveData.boxscore.teams.away.battingOrder[0]).equals(1)
    expect(game.gameData.players[1].fullName).equals('Player 1')
  })

  it('refuses a game with a malformed pending play', function () {
    const game = sampleGame() as unknown as Record<string, unknown>
    game.pending = { outcome: 'Single', movements: 'no' }
    expect(() => asGameState(game)).to.throw()
  })
})
