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
  dictatedAction,
  ERROR_KINDS,
  GAME_FLOW_KINDS,
  HOME_RUN_KINDS,
  keyterms,
  LINEUP_KINDS,
  OUT_KINDS,
  PITCH_CALLS,
  PRODUCED_EVENT_TYPES,
  promptContext,
  RESULT_TYPES,
  RUNNER_REASONS,
  type ScoringAction,
  shortName,
  taggedAction,
  toolSchema,
  TRAJECTORIES,
  untaggedAction
} from './actions'
import { storedEventType } from './document'
import { PITCH_HEIGHTS, PITCH_SIDES } from './pitchLocation'
import { fieldingIds, taggedIds, tagOf } from './playerTags'
import {
  asGameSetup,
  asGameState,
  copyState,
  type GameState,
  type Position,
  POSITIONS,
  setupOf
} from './state'
import { DICTATION_TERMS } from './vocabulary'

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
      tagOrder: Array.from({ length: 18 }, (_, i) => i + 1)
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
    launchAngleDragged: true,
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
    expect(
      cleanAction({ type: 'lineup', kind: 'roster', setup, shown: true })
    ).deep.equals({
      action: { type: 'lineup', kind: 'roster', setup, shown: true }
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

  it('takes a dictated action from its tool call, never as a dragged angle', function () {
    expect(
      dictatedAction('ballInPlay', {
        contact: 'swing',
        launchAngle: 30,
        launchAngleDragged: true,
        fielder: 18
      })
    ).deep.equals({
      action: {
        type: 'ballInPlay',
        contact: 'swing',
        launchAngle: 30,
        fielder: 18
      }
    })
    // The tool's name is the type, whatever the input says.
    expect(
      dictatedAction('pitch', { type: 'ballInPlay', call: 'B' })
    ).deep.equals({ action: { type: 'pitch', call: 'B' } })
    expect(dictatedAction('result', 'single')).to.have.nested.property(
      'problem.code',
      'malformed'
    )
    expect(dictatedAction('swing', {})).to.have.nested.property(
      'problem.code',
      'unknownAction'
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
    // A dictated angle is an estimate: only the screen says the scorer dragged.
    expect(props('ballInPlay')).have.property('launchAngle')
    expect(props('ballInPlay')).not.have.property('launchAngleDragged')
    expect(props('result').eventType.enum).deep.equals(RESULT_TYPES)
    expect(props('result').outBy.enum).deep.equals(OUT_KINDS)
    expect(props('result').base.enum).deep.equals(BASES)
    expect(props('fieldingPlay').errorKind.enum).deep.equals(ERROR_KINDS)
    const fielding = toolSchema().find(tool => tool.name === 'fieldingPlay')!
    expect(fielding.input_schema.required).deep.equals(['fielders', 'error'])
    expect(fielding.description).match(/only after a result of field_error/)
    const movement = toolSchema().find(tool => tool.name === 'runnerMovement')!
    expect(movement.description).match(
      /A hit already moves the batter and every runner/
    )
    expect(props('runnerMovement').to.enum).deep.equals(DESTINATIONS)
    expect(props('runnerMovement').reason.enum).deep.equals(RUNNER_REASONS)
    expect(props('baseRunning').kind.enum).deep.equals(BASE_RUNNING_KINDS)
    expect(props('batteryEvent').kind.enum).deep.equals(BATTERY_KINDS)
    expect(props('lineup').kind.enum).deep.equals(LINEUP_KINDS)
    expect(props('lineup').position.enum).deep.equals(POSITIONS)
    expect(props('lineup').base.enum).deep.equals(BASES)
    expect(props('gameFlow').kind.enum).deep.equals(GAME_FLOW_KINDS)
    // A player is his tag, never a number: not the jersey said, which is
    // how the roster tools beside these take him, and not a base.
    expect(props('ballInPlay').fielder).deep.equals({
      type: 'string',
      description:
        "The fielder who first handled the ball: the player's tag from GAME, like KT4; never a jersey or base number"
    })
    const player = { type: 'string' }
    const players = { type: 'array', items: { type: 'string' } }
    for (const [name, field, shape] of [
      ['ballInPlay', 'fielder', player],
      ['fieldingPlay', 'fielders', players],
      ['fieldingPlay', 'error', player],
      ['runnerMovement', 'runner', player],
      ['runnerMovement', 'fielders', players],
      ['baseRunning', 'runner', player],
      ['baseRunning', 'fielders', players],
      ['lineup', 'order', players],
      ['lineup', 'player', player],
      ['lineup', 'replaces', player],
      ['gameFlow', 'runner', player]
    ] as const) {
      expect(props(name)[field], `${name}.${field}`).deep.include(shape)
      expect(
        (props(name)[field] as { description?: string }).description
      ).match(
        /the player's tag from GAME, like KT4; never a jersey or base number$/
      )
    }
    const battery = tools.find(tool => tool.name === 'batteryEvent')!
    expect(
      battery.input_schema.properties?.advances.items?.properties?.runner
    ).deep.include(player)
    for (const tool of tools) {
      expect(tool.description).not.equals('')
      expect(tool.input_schema.additionalProperties).equals(false)
      for (const required of tool.input_schema.required ?? [])
        expect(tool.input_schema.properties).to.have.property(required)
    }
  })

  it('takes and offers a pitch’s speed, location and zone, thrown or hit', function () {
    const pitchData = {
      speed: 84.5,
      pitchLocation: { height: 'low', side: 'away', inZone: false },
      zone: 14
    } as const
    expect(dictatedAction('pitch', { call: 'B', ...pitchData })).deep.equals({
      action: { type: 'pitch', call: 'B', ...pitchData }
    })
    expect(
      dictatedAction('ballInPlay', { contact: 'swing', ...pitchData })
    ).deep.equals({
      action: { type: 'ballInPlay', contact: 'swing', ...pitchData }
    })
    // A speed or zone out of range is the engine's to drop; a location in
    // other words is no location.
    expect(
      cleanAction({ type: 'pitch', call: 'B', speed: 500, zone: 10 })
    ).to.have.property('action')
    expect(
      cleanAction({
        type: 'pitch',
        call: 'B',
        pitchLocation: { height: 'up', side: 'away', inZone: true }
      })
    ).to.have.nested.property('problem.code', 'malformed')
    const tools = toolSchema()
    for (const name of ['pitch', 'ballInPlay']) {
      const props =
        tools.find(tool => tool.name === name)?.input_schema.properties ?? {}
      expect(props, name).to.include.keys('speed', 'pitchLocation', 'zone')
      expect(props.pitchLocation.properties?.height.enum).deep.equals(
        PITCH_HEIGHTS
      )
      expect(props.pitchLocation.properties?.side.enum).deep.equals(PITCH_SIDES)
    }
  })

  it('tells a model the situation by name, and never the score or an index', function () {
    const text = promptContext(sampleGame())
    expect(text).includes('Top of the 3rd, 1 out, count 1-2.')
    expect(text).includes('Visitors batting, Hosts in the field.')
    // Every player by his tag, and no id.
    expect(text).includes(
      `Batter: Player 4. #4 (tag ${tagOf(3)}). Pitcher: Player 1. #10 (tag ${tagOf(9)}).`
    )
    expect(text).includes(
      `On first: nobody. On second: Player 3. #3 (tag ${tagOf(2)}).`
    )
    expect(text).includes(`Next batter: Player 5. #5 (tag ${tagOf(4)}).`)
    expect(text).includes(`SS Player 1. #14 (tag ${tagOf(13)})`)
    expect([...taggedIds(text)].sort((a, b) => a - b)).deep.equals([
      2, 3, 4, 9, 10, 11, 12, 13, 14, 15, 16, 17
    ])
    expect(text).not.match(/\bid\b/)
    expect(text).not.match(/runs?\b|score|atBatIndex|at-bat/i)

    const bottom = sampleGame()
    const line = bottom.liveData.linescore
    line.isTopInning = false
    line.currentInning = 12
    line.outs = 2
    line.offense.batter = { id: 99, fullName: 'Unlisted' }
    bottom.meta.tagOrder.push(99)
    expect(promptContext(bottom)).includes(
      'Bottom of the 12th, 2 outs, count 1-2.'
    )
    expect(promptContext(bottom)).includes(
      'Hosts batting, Visitors in the field.'
    )
    expect(promptContext(bottom)).includes(
      `Batter: Unlisted (tag ${tagOf(18)}).`
    )
    // A player with no number on the roster is named without one.
    bottom.gameData.players[14].jersey = '  '
    expect(promptContext(bottom)).includes(`SS Player 1. (tag ${tagOf(13)})`)
  })

  it('reads a dictated action’s players back from their tags, and tags them again for the model', function () {
    const game = new Set([1, 2, 3, 5, 11, 12, 13, 14, 18])
    // Each example as a model would call for it: the screen alone drags.
    const said = examples.map(example => {
      const { launchAngleDragged, ...rest } = example as Record<string, unknown>
      return rest as ScoringAction
    })
    const tagged = said.map(taggedAction)
    // Every player field, a battery event's runners and a base's runner too.
    expect(tagged[1]).deep.include({ fielder: tagOf(11) })
    expect(tagged[3]).deep.include({
      fielders: [tagOf(14), tagOf(13)],
      error: tagOf(13)
    })
    expect(tagged[4]).deep.include({
      runner: tagOf(3),
      fielders: [tagOf(17), tagOf(11)]
    })
    expect(tagged[6]).deep.include({
      advances: [{ runner: tagOf(3), to: '3B' }]
    })
    expect(tagged[7]).deep.include({
      player: tagOf(18),
      replaces: tagOf(14),
      order: [tagOf(1), tagOf(2)],
      nextBatter: tagOf(2)
    })
    expect(tagged[8]).deep.include({
      runner: tagOf(3),
      batter: tagOf(12),
      pitcher: tagOf(5),
      bases: [null, tagOf(13), null]
    })
    // Read back, each is the action it was.
    const all = new Set([...game, 17])
    for (const [index, raw] of tagged.entries())
      expect(
        untaggedAction(raw as Record<string, unknown> & { type: string }, all),
        String(index)
      ).deep.equals({ raw: said[index] })
    expect(
      untaggedAction(
        {
          type: 'baseRunning',
          kind: 'steal',
          runner: ` ${tagOf(3).toLowerCase()} `,
          to: '3B'
        },
        game
      )
    ).deep.equals({
      raw: { type: 'baseRunning', kind: 'steal', runner: 3, to: '3B' }
    })
    // As the game writes him, copied whole.
    expect(
      untaggedAction(
        {
          type: 'ballInPlay',
          contact: 'swing',
          fielder: `SS Ian K. #5 (tag ${tagOf(14)})`
        },
        game
      )
    ).deep.equals({
      raw: { type: 'ballInPlay', contact: 'swing', fielder: 14 }
    })
  })

  it('round-trips fielding-route tags and accepts fielding positions without changing points', function () {
    const action: ScoringAction = {
      type: 'runnerMovement',
      runner: 3,
      to: '2B',
      fieldingRoute: [{ id: 14, point: { x: 1, z: 2 } }]
    }
    const tagged = taggedAction(action) as Record<string, unknown> & {
      type: string
    }
    expect(tagged.fieldingRoute).deep.equals([
      { id: tagOf(14), point: { x: 1, z: 2 } }
    ])
    const players = new Set([3, 14])
    expect(untaggedAction(tagged, players)).deep.equals({ raw: action })
    expect(
      untaggedAction(
        {
          ...tagged,
          fieldingRoute: [{ id: 'SS', point: { x: 1, z: 2 } }]
        },
        players,
        new Map([['SS', 14]])
      )
    ).deep.equals({ raw: action })
  })

  it('refuses a dictated player the game gives no tag: a number, a base, a stranger', function () {
    const game = new Set([3, 14])
    const refused = (raw: Record<string, unknown>): string | undefined => {
      const untagged = untaggedAction(
        raw as Record<string, unknown> & { type: string },
        game
      )
      return 'problem' in untagged
        ? `${untagged.problem.code}: ${untagged.problem.message}`
        : undefined
    }
    const steal = { type: 'baseRunning', kind: 'steal', to: '3B' }
    expect(refused({ ...steal, runner: 3 })).equals(
      'unknownPlayer: the steal — the runner 3 is no player in the game'
    )
    for (const runner of ['3', '#3', '3B', 'SS', 'KT', '', tagOf(4)])
      expect(refused({ ...steal, runner }), runner).match(/^unknownPlayer: /)
    expect(
      refused({
        type: 'fieldingPlay',
        fielders: [tagOf(14), 5],
        error: tagOf(14)
      })
    ).equals('unknownPlayer: the error — a fielder 5 is no player in the game')
    expect(
      refused({
        type: 'batteryEvent',
        kind: 'wild_pitch',
        advances: [{ runner: tagOf(5), to: '3B' }]
      })
    ).equals(
      'unknownPlayer: the wild pitch — the runner is no player in the game'
    )
    // A setup names its players by id, which a model never has.
    expect(
      refused({ type: 'lineup', kind: 'roster', setup: { sides: {} } })
    ).equals(
      'malformed: the lineup change — a whole game setup is never dictated'
    )
    // No player at all is nothing to read; an unknown action is the cleaner's.
    expect(refused({ type: 'pitch', call: 'B' })).equals(undefined)
    expect(refused({ type: 'dance', runner: 3 })).equals(undefined)
  })

  it('reads a fielder said by his position as the player the game lists there', function () {
    const game = sampleGame()
    const defense = game.liveData.linescore.defense
    const context = promptContext(game)
    const fielding = fieldingIds(context)
    const ids = taggedIds(context)
    for (const position of POSITIONS) {
      const id = game.meta.tagOrder.indexOf(defense[position]!.id)
      expect(fielding.get(position), position).equals(id)
      expect(
        untaggedAction(
          { type: 'ballInPlay', contact: 'swing', fielder: position },
          ids,
          fielding
        ),
        position
      ).deep.equals({
        raw: { type: 'ballInPlay', contact: 'swing', fielder: id }
      })
    }
    // In the words a scorer uses, in every field that names a fielder.
    const at = (position: Position): number | undefined =>
      game.meta.tagOrder.indexOf(defense[position]!.id)
    expect(
      untaggedAction(
        {
          type: 'fieldingPlay',
          fielders: ['the shortstop', 'First Baseman'],
          error: '1b'
        },
        ids,
        fielding
      )
    ).deep.equals({
      raw: {
        type: 'fieldingPlay',
        fielders: [at('SS'), at('1B')],
        error: at('1B')
      }
    })
    expect(
      untaggedAction(
        {
          type: 'runnerMovement',
          runner: tagOf(3),
          to: 'home',
          out: true,
          fielders: ['left fielder', 'C']
        },
        ids,
        fielding
      )
    ).deep.equals({
      raw: {
        type: 'runnerMovement',
        runner: 3,
        to: 'home',
        out: true,
        fielders: [at('LF'), at('C')]
      }
    })
    expect(
      untaggedAction(
        {
          type: 'baseRunning',
          kind: 'caught_stealing',
          runner: tagOf(3),
          to: '2B',
          fielders: ['catcher', 'the second-baseman']
        },
        ids,
        fielding
      )
    ).deep.equals({
      raw: {
        type: 'baseRunning',
        kind: 'caught_stealing',
        runner: 3,
        to: '2B',
        fielders: [at('C'), at('2B')]
      }
    })

    const refused = (raw: Record<string, unknown>): string | undefined => {
      const untagged = untaggedAction(
        raw as Record<string, unknown> & { type: string },
        ids,
        new Map([...fielding].filter(([position]) => position !== 'RF'))
      )
      return 'problem' in untagged
        ? `${untagged.problem.code}: ${untagged.problem.message}`
        : undefined
    }
    // A position nobody plays, and no position at all.
    expect(
      refused({ type: 'ballInPlay', contact: 'swing', fielder: 'RF' })
    ).equals(
      'unknownPlayer: the ball in play — the fielder "RF" is no player in the game'
    )
    for (const [fielder, position] of [
      ['left', 'LF'],
      ['center', 'CF'],
      ['right', 'RF'],
      ['RF.', 'RF'],
      ['the right fielder.', 'RF'],
      ['leftfielder', 'LF'],
      ['3rd', '3B'],
      ['3rd baseman', '3B']
    ] as const)
      expect(
        untaggedAction(
          { type: 'ballInPlay', contact: 'swing', fielder },
          ids,
          fielding
        ),
        fielder
      ).deep.equals({
        raw: { type: 'ballInPlay', contact: 'swing', fielder: at(position) }
      })
    for (const fielder of ['DH', 'the outfield', '9'])
      expect(
        refused({ type: 'ballInPlay', contact: 'swing', fielder }),
        fielder
      ).equals(
        `unknownPlayer: the ball in play — the fielder ${JSON.stringify(fielder)} is no player in the game`
      )
    // A position names only a fielder: never a runner, a batter or a player.
    expect(
      refused({ type: 'baseRunning', kind: 'steal', runner: 'SS', to: '3B' })
    ).equals(
      'unknownPlayer: the steal — the runner "SS" is no player in the game'
    )
    expect(
      refused({
        type: 'batteryEvent',
        kind: 'passed_ball',
        advances: [{ runner: 'the shortstop', to: '3B' }]
      })
    ).equals(
      'unknownPlayer: the passed ball — the runner "the shortstop" is no player in the game'
    )
    expect(
      refused({
        type: 'lineup',
        kind: 'substitute',
        side: 'home',
        position: 'LF',
        player: tagOf(at('LF') ?? 0),
        replaces: 'LF'
      })
    ).equals(
      'unknownPlayer: the lineup change — the player leaving "LF" is no player in the game'
    )
    expect(
      refused({
        type: 'gameFlow',
        kind: 'placeRunner',
        runner: 'C',
        base: '2B'
      })
    ).equals(
      'unknownPlayer: the game change — the runner "C" is no player in the game'
    )
  })

  it('tells the scorer what a dropped call left out, in his words, never a tag', function () {
    const game = new Set([3])
    const message = (raw: Record<string, unknown>): string | undefined => {
      const untagged = untaggedAction(
        raw as Record<string, unknown> & { type: string },
        game
      )
      return 'problem' in untagged ? untagged.problem.message : undefined
    }
    const nobody = tagOf(4)
    const said: Array<[Record<string, unknown>, string]> = [
      [{ type: 'pitch', call: 'B', batter: nobody }, 'the pitch — the batter'],
      [
        { type: 'ballInPlay', contact: 'swing', fielder: nobody },
        'the ball in play — the fielder'
      ],
      [
        { type: 'fieldingPlay', fielders: [nobody], error: tagOf(3) },
        'the error — a fielder'
      ],
      [
        { type: 'fieldingPlay', fielders: [tagOf(3)], error: nobody },
        'the error — the fielder charged with the error'
      ],
      [
        { type: 'runnerMovement', runner: nobody, to: 'home' },
        "the runner's move — the runner"
      ],
      [
        { type: 'baseRunning', kind: 'pickoff', runner: nobody },
        'the pickoff — the runner'
      ],
      [
        { type: 'baseRunning', kind: 'pickoff_safe', runner: nobody },
        'the pickoff throw — the runner'
      ],
      [
        { type: 'baseRunning', kind: 'defensive_indifference', runner: nobody },
        "the runner's advance — the runner"
      ],
      [
        { type: 'baseRunning', kind: 'caught_stealing', runner: nobody },
        'the caught stealing — the runner'
      ],
      [
        { type: 'baseRunning', kind: 'sneak', runner: nobody },
        "the runner's play — the runner"
      ],
      [
        {
          type: 'batteryEvent',
          kind: 'balk',
          advances: [{ runner: nobody, to: '2B' }]
        },
        'the balk — the runner'
      ],
      [
        {
          type: 'batteryEvent',
          advances: [{ runner: nobody, to: '2B' }]
        },
        'the wild pitch, passed ball or balk — the runner'
      ],
      [
        { type: 'lineup', kind: 'battingOrder', order: [tagOf(3), nobody] },
        'the lineup change — a batter in the order'
      ],
      [
        { type: 'lineup', kind: 'position', player: nobody },
        'the lineup change — the player'
      ],
      [
        { type: 'gameFlow', kind: 'override', pitcher: nobody },
        'the game change — the pitcher'
      ],
      [
        { type: 'gameFlow', kind: 'override', bases: [null, nobody] },
        'the game change — a runner on base'
      ],
      [
        { type: 'gameFlow', kind: 'override', nextBatter: nobody },
        'the game change — the next batter'
      ],
      [
        { type: 'result', eventType: 'single', runner: nobody },
        'the result — the runner'
      ]
    ]
    for (const [raw, what] of said)
      expect(message(raw), what).equals(`${what} is no player in the game`)
    // A tag of nobody, copied as the game writes it, and a blank, unshown.
    expect(
      message({
        type: 'ballInPlay',
        contact: 'swing',
        fielder: `Ian K. #5 (tag ${nobody})`
      })
    ).equals('the ball in play — the fielder is no player in the game')
    expect(message({ type: 'baseRunning', kind: 'steal', runner: ' ' })).equals(
      'the steal — the runner is no player in the game'
    )
    expect(
      message({ type: 'baseRunning', kind: 'steal', runner: { id: 3 } })
    ).equals('the steal — the runner is no player in the game')
    for (const text of said.map(([raw]) => message(raw) ?? ''))
      expect(text).not.match(/[A-Z]{2}[0-9]|tag|ballInPlay|baseRunning/)
  })

  it('names a player by first name and last initial, and never by surname', function () {
    expect(
      shortName({ fullName: 'Noah Dean', firstName: 'Noah', lastName: 'Dean' })
    ).equals('Noah D.')
    expect(shortName({ fullName: 'Marcus Semien' })).equals('Marcus S.')
    expect(shortName({ fullName: 'Mary Ann Smith' })).equals('Mary Ann S.')
    expect(shortName({ fullName: "Liam O'Brien" })).equals('Liam O.')
    expect(shortName({ fullName: 'Sam P.' })).equals('Sam P.')
    expect(shortName({ fullName: 'Unlisted' })).equals('Unlisted')
    expect(shortName({ fullName: '  ', firstName: 'Ana' })).equals('Ana')
    expect(shortName({ fullName: '' })).equals('')

    const game = sampleGame()
    for (const player of Object.values(game.gameData.players)) {
      player.firstName = 'Chase'
      player.lastName = `Utley${player.id}`
      player.fullName = `Chase Utley${player.id}`
    }
    const text = promptContext(game)
    expect(text).includes(`Batter: Chase U. #4 (tag ${tagOf(3)}).`)
    expect(text).not.match(/Utley/)
    expect(keyterms(game).join(' ')).not.match(/Utley/)
  })

  it('biases the recogniser toward who is in the play first', function () {
    const game = sampleGame()
    for (const player of Object.values(game.gameData.players)) {
      player.firstName = `First${player.id}`
      player.lastName = `Last${player.id}`
    }
    const terms = keyterms(game)
    // Batter 4, pitcher 10, runner on second 3, then the fielders.
    expect(terms.slice(0, 3)).deep.equals([
      'First4 L.',
      'First10 L.',
      'First3 L.'
    ])
    expect(terms[3]).equals('First11 L.')
    // Every player once, then the team names, then the scoring words.
    const names = terms.filter(term => /^First\d+ L\.$/.test(term))
    expect(names).to.have.length(18)
    expect(new Set(names).size).equals(18)
    const afterNames = terms.slice(18)
    expect(afterNames.slice(0, 2)).deep.equals(['Visitors', 'Hosts'])
    expect(afterNames.slice(2)).deep.equals([...DICTATION_TERMS])
    expect(terms.length).lessThan(100)
    for (const term of terms) {
      expect(term.length).within(1, 50)
    }
    expect(keyterms(game)).deep.equals(terms)
  })

  it('sends a coach only the players on his side', function () {
    const game = sampleGame()
    for (const player of Object.values(game.gameData.players)) {
      player.firstName = `First${player.id}`
      player.lastName = `Last${player.id}`
    }
    const home = keyterms(game, 'home')
    expect(home.filter(term => /^First\d+ L\.$/.test(term))).deep.equals(
      [10, 11, 12, 13, 14, 15, 16, 17, 18].map(id => `First${id} L.`)
    )
    expect(home.slice(9)).deep.equals(['Hosts', ...DICTATION_TERMS])
    const away = keyterms(game, 'away')
    expect(away.filter(term => /^First\d+ L\.$/.test(term))).deep.equals([
      'First4 L.',
      'First3 L.',
      'First1 L.',
      'First2 L.',
      'First5 L.',
      'First6 L.',
      'First7 L.',
      'First8 L.',
      'First9 L.'
    ])
    expect(away.slice(9)).deep.equals(['Visitors', ...DICTATION_TERMS])
  })

  it('keeps the same terms when a runner only moves', function () {
    const game = sampleGame()
    const before = keyterms(game)
    const line = game.liveData.linescore
    line.offense.third = line.offense.second
    line.offense.second = null
    expect(keyterms(game)).deep.equals(before)
  })

  it('drops an empty or over-long name and repeats nothing', function () {
    const game = sampleGame()
    game.gameData.players[4].fullName = ''
    game.gameData.players[5].fullName = `${'x'.repeat(60)} Y`
    game.gameData.teams.home.name = 'Visitors'
    const terms = keyterms(game)
    expect(terms).not.includes('')
    for (const term of terms) expect(term.length).at.most(50)
    expect(terms.filter(term => term === 'Visitors')).to.have.length(1)
    game.liveData.linescore.offense.batter = {
      id: 777,
      fullName: 'Pinch Hitter'
    }
    expect(keyterms(game)[0]).equals('Pinch H.')
  })

  it('tells a model that result strikeout is a dropped third strike', function () {
    const result = toolSchema().find(tool => tool.name === 'result')
    expect(result?.description).match(/dropped third strike/i)
    expect(result?.description).match(/pitch that makes strike three/)
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
    expect(storedEventType('manual_placement')).equals('ts_manual_placement')
    expect(storedEventType('placed_runner')).equals('runner_placed')
    // Other out is a runner's between pitches, and the batter's own is ours.
    expect(storedEventType('other_out')).equals('other_out')
    expect(storedEventType('other_out', 'Batter Out — Other')).equals(
      'ts_batter_out'
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
    expect(setup.players[4].id).equals(4)
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
