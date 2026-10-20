import { expect } from 'chai'
import { describe, it } from 'mocha'

import { after, ball, TEAMS, walk } from '../../test/scoringGames'
import { userIdOfGumbo } from '../userId'
import type { JsonSchema } from './actions'
import { freshGame, newSetup, type RosterPlayer } from './lineup'
import {
  applyRosterCommands,
  asRosterCommand,
  asSaidRosterCommand,
  type ChosenRosterCommand,
  ONE_CATEGORY_AT_A_TIME,
  ONE_TEAM_AT_A_TIME,
  resolveRosterCommands,
  ROSTER_COMMAND_TYPES,
  ROSTER_TAB,
  type RosterCommand,
  rosterPrompt,
  type RosterQuestion,
  type RosterResolution,
  type RosterResolving,
  type RosterSituation,
  rosterSituation,
  rosterToolSchema,
  type StagedRoster
} from './rosterCommands'
import type { GameState } from './state'

/**
 * Ten a side, the tenth on the bench. The visitors are ids 1-10 and bat 1-9;
 * the hosts are 11-20. Each side fields its first nine from P to RF.
 */
const AWAY = [
  'Judge',
  'Soto',
  'Betts',
  'Ohtani',
  'Freeman',
  'Trout',
  'Harper',
  'Machado',
  'Alonso',
  'Lindor'
]
const HOME = [
  'Cole',
  'Skenes',
  'Witt',
  'Seager',
  'Turner',
  'Acuna',
  'Tucker',
  'Bellinger',
  'Riley',
  'Arenado'
]
const id = (name: string): number =>
  AWAY.includes(name) ? AWAY.indexOf(name) + 1 : HOME.indexOf(name) + 11

function pregame(): GameState {
  const roster = (names: string[], first: number): RosterPlayer[] =>
    names.map((shortName, i) => ({
      userId: userIdOfGumbo(first + i),
      gumboId: first + i,
      shortName,
      jersey: String(i + 2)
    }))
  const setup = newSetup(TEAMS, {
    away: roster(AWAY, 1),
    home: roster(HOME, 11)
  })
  for (const side of ['away', 'home'] as const)
    setup.sides[side].battingOrder = setup.sides[side].battingOrder.slice(0, 9)
  return freshGame('g1', TEAMS, setup)
}
/** After the first pitch: Judge up, nobody on. */
const live = (): GameState => after(pregame(), ball)

function staged(
  state: GameState,
  commands: RosterCommand[],
  situation: Partial<RosterSituation> = {}
): StagedRoster {
  const result = applyRosterCommands(state, commands, {
    ...rosterSituation(state),
    ...situation
  })
  if ('problem' in result) throw new Error(result.problem)
  return result
}
function refused(
  state: GameState,
  commands: RosterCommand[],
  situation: Partial<RosterSituation> = {}
): string {
  const result = applyRosterCommands(state, commands, {
    ...rosterSituation(state),
    ...situation
  })
  if (!('problem' in result)) throw new Error('Expected a refusal')
  return result.problem
}
const names = (state: GameState, ids: number[]): string[] =>
  ids.map(player => state.gameData.players[player].fullName)
const order = (
  result: StagedRoster,
  side: 'away' | 'home' = 'away'
): string[] =>
  names(result.draft, result.draft.liveData.boxscore.teams[side].battingOrder)

describe('roster commands: lineups, defenses and players (U1)', function () {
  it('sets a lineup exactly, and whoever is not named leaves it for the bench', function () {
    const state = pregame()
    const result = staged(state, [
      {
        type: 'setLineup',
        side: 'away',
        order: [id('Lindor'), id('Judge'), id('Soto'), id('Judge')]
      }
    ])
    expect(order(result)).deep.equals(['Lindor', 'Judge', 'Soto'])
    expect(result.draft.liveData.boxscore.teams.away.players).length(10)
    expect(result).deep.include({
      category: 'offense',
      side: 'away',
      lines: ['Lineup: Lindor, Judge, Soto'],
      runners: []
    })
    // The draft it was given is left as it was.
    expect(state.liveData.boxscore.teams.away.battingOrder).length(9)
    expect(
      refused(state, [{ type: 'setLineup', side: 'away', order: [] }])
    ).equals('Name the batters in order')
  })

  it('places a player inside the order, past its end, and at the end', function () {
    const state = pregame()
    const fourth = staged(state, [
      {
        type: 'placeInLineup',
        side: 'away',
        places: [{ player: id('Judge'), slot: 4 }]
      }
    ])
    expect(order(fourth).slice(0, 5)).deep.equals([
      'Soto',
      'Betts',
      'Ohtani',
      'Judge',
      'Freeman'
    ])
    expect(fourth.lines).deep.equals(['Judge to 4th in the lineup'])
    const past = staged(state, [
      {
        type: 'placeInLineup',
        side: 'away',
        places: [{ player: id('Soto'), slot: 11 }]
      }
    ])
    expect(order(past).at(-1)).equals('Soto')
    expect(past.lines).deep.equals(['Soto to 9th in the lineup'])
    // A bench player at the end joins the order; one in it moves there.
    const benched = staged(state, [
      {
        type: 'placeInLineup',
        side: 'away',
        places: [{ player: id('Lindor'), slot: 'end' }]
      }
    ])
    expect(order(benched)).length(10)
    expect(benched.lines).deep.equals(['Lindor to 10th in the lineup'])
    const moved = staged(state, [
      {
        type: 'placeInLineup',
        side: 'away',
        places: [{ player: id('Judge'), slot: 'end' }]
      }
    ])
    expect(order(moved)).length(9)
    expect(order(moved)[0]).equals('Soto')
    expect(moved.lines).deep.equals(['Judge to 9th in the lineup'])
  })

  it('puts three players at three places at once, whatever places they held', function () {
    const result = staged(pregame(), [
      {
        type: 'placeInLineup',
        side: 'away',
        places: [
          { player: id('Judge'), slot: 3 },
          { player: id('Soto'), slot: 4 },
          { player: id('Betts'), slot: 5 }
        ]
      }
    ])
    expect(order(result).slice(0, 6)).deep.equals([
      'Ohtani',
      'Freeman',
      'Judge',
      'Soto',
      'Betts',
      'Trout'
    ])
    expect(result.lines).deep.equals([
      'Judge to 3rd in the lineup',
      'Soto to 4th in the lineup',
      'Betts to 5th in the lineup'
    ])
    // The last place said for a player is his.
    const twice = staged(pregame(), [
      {
        type: 'placeInLineup',
        side: 'away',
        places: [
          { player: id('Judge'), slot: 2 },
          { player: id('Judge'), slot: 6 }
        ]
      }
    ])
    expect(order(twice)[5]).equals('Judge')
    expect(twice.lines).deep.equals(['Judge to 6th in the lineup'])
  })

  it('places several fielders, swaps two, and never touches the order', function () {
    const state = pregame()
    const defenseOf = (result: StagedRoster): Record<string, string | null> =>
      Object.fromEntries(
        Object.entries(result.draft.liveData.boxscore.teams.away.defense).map(
          ([position, player]) => [
            position,
            player == null
              ? null
              : result.draft.gameData.players[player].fullName
          ]
        )
      )
    const several = staged(state, [
      {
        type: 'setPositions',
        side: 'away',
        places: [
          { player: id('Soto'), position: 'SS' },
          { player: id('Betts'), position: '2B' }
        ]
      }
    ])
    expect(defenseOf(several)).deep.include({
      C: null,
      '1B': null,
      '2B': 'Betts',
      SS: 'Soto'
    })
    expect(several.lines).deep.equals([
      'Soto to SS',
      'Betts to 2B',
      'Freeman off the field',
      'Ohtani off the field'
    ])
    expect(several.category).equals('defense')
    expect(order(several)).deep.equals(AWAY.slice(0, 9))

    const swapped = staged(state, [
      {
        type: 'setPositions',
        side: 'away',
        places: [
          { player: id('Judge'), position: 'C' },
          { player: id('Soto'), position: 'P' }
        ]
      }
    ])
    expect(defenseOf(swapped)).deep.include({ P: 'Soto', C: 'Judge' })
    expect(swapped.lines).deep.equals(['Judge to C', 'Soto to P'])
  })

  it('brings a bench player in to field, and the man he replaces keeps his slot', function () {
    const result = staged(pregame(), [
      {
        type: 'setPositions',
        side: 'away',
        places: [{ player: id('Lindor'), position: 'SS' }]
      }
    ])
    const team = result.draft.liveData.boxscore.teams.away
    expect(team.defense.SS).equals(id('Lindor'))
    expect(Object.values(team.defense)).not.include(id('Freeman'))
    expect(order(result)).deep.equals(AWAY.slice(0, 9))
    expect(order(result)).not.include('Lindor')
    expect(result.lines).deep.equals(['Lindor to SS', 'Freeman off the field'])
  })

  it('adds a player to the roster, with a jersey and without', function () {
    const state = pregame()
    const numbered = staged(state, [
      {
        type: 'addPlayer',
        player: 9000000,
        side: 'home',
        name: ' Shohei  Ohtani ',
        jersey: '17'
      }
    ])
    const team = numbered.draft.liveData.boxscore.teams.home
    const added = team.players.at(-1)!
    expect(team.players).length(11)
    expect(team.battingOrder).not.include(added)
    expect(numbered.draft.gameData.players[added]).deep.include({
      fullName: 'Shohei Ohtani',
      firstName: 'Shohei',
      lastName: 'Ohtani',
      jersey: '17',
      id: 9000000,
      local: true,
      teamId: TEAMS.home.id
    })
    expect(numbered).deep.include({
      category: 'roster',
      side: 'home',
      lines: ['Shohei O. #17 added to the roster']
    })
    const plain = staged(state, [
      { type: 'addPlayer', player: 9000000, side: 'away', name: 'Ohtani' }
    ])
    const player =
      plain.draft.gameData.players[
        plain.draft.liveData.boxscore.teams.away.players.at(-1)!
      ]
    expect(player).deep.include({ fullName: 'Ohtani', jersey: '' })
    expect(plain.lines).deep.equals(['Ohtani added to the roster'])
    expect(
      refused(state, [{ type: 'addPlayer', side: 'away', name: '  ' }])
    ).equals("Say the new player's name")
    expect(
      refused(state, [
        { type: 'addPlayer', side: 'away', name: 'Ohtani', jersey: 'X' }
      ])
    ).equals('Use digits for the jersey number.')
  })
})

describe('roster commands: pinch hitters, pinch runners and refusals (U2)', function () {
  it('sends a pinch hitter up in the slot of the batter due', function () {
    const state = live()
    const result = staged(state, [
      { type: 'pinchHitter', player: id('Lindor') }
    ])
    expect(order(result)[0]).equals('Lindor')
    expect(order(result)).not.include('Judge')
    expect(result.nextBatter).equals(id('Lindor'))
    expect(result.lines).deep.equals(['Lindor pinch-hits for Judge'])
    expect(result.draft.liveData.boxscore.teams.away.players).include(
      id('Judge')
    )
    // A second pinch hitter replaces the first, who was due.
    const again = applyRosterCommands(
      result.draft,
      [{ type: 'pinchHitter', player: id('Judge') }],
      { ...rosterSituation(state), nextBatter: result.nextBatter }
    )
    expect(again).deep.include({
      nextBatter: id('Judge'),
      lines: ['Judge pinch-hits for Lindor']
    })
  })

  it('refuses a pinch hitter before the game begins, or one already in the order', function () {
    expect(
      refused(pregame(), [{ type: 'pinchHitter', player: id('Lindor') }])
    ).equals('Pinch hitters only once the game has begun')
    expect(
      refused(live(), [{ type: 'pinchHitter', player: id('Soto') }])
    ).equals('Soto is already in the lineup')
    // With nobody due in the order, there is no slot to take.
    const empty = live()
    empty.liveData.boxscore.teams.away.battingOrder = []
    empty.liveData.linescore.offense.batter = null
    expect(
      refused(empty, [{ type: 'pinchHitter', player: id('Lindor') }])
    ).equals('Nobody is due up')
  })

  it('stages a pinch runner and leaves the order as it is', function () {
    const state = walk(live())
    expect(rosterSituation(state)).deep.equals({
      live: true,
      battingSide: 'away',
      runnersOn: { '1B': id('Judge'), '2B': null, '3B': null }
    })
    const result = staged(state, [
      { type: 'pinchRunner', player: id('Lindor'), base: '1B' }
    ])
    expect(result).deep.include({
      category: 'offense',
      side: 'away',
      runners: [{ base: '1B', player: id('Lindor') }],
      lines: ['Lindor runs for Judge']
    })
    expect(result.nextBatter).equals(undefined)
    expect(order(result)).deep.equals(AWAY.slice(0, 9))
    // Another for the same base takes his place; one already running is refused.
    const again = staged(
      state,
      [{ type: 'pinchRunner', player: id('Machado'), base: '1B' }],
      { runners: result.runners }
    )
    expect(again.runners).deep.equals([{ base: '1B', player: id('Machado') }])
    expect(
      refused(
        state,
        [{ type: 'pinchRunner', player: id('Lindor'), base: '2B' }],
        {
          runnersOn: { '1B': id('Judge'), '2B': id('Soto') },
          runners: result.runners
        }
      )
    ).equals('Lindor is already on base')
    expect(
      refused(state, [{ type: 'pinchRunner', player: id('Judge'), base: '1B' }])
    ).equals('Judge is already on base')
    const batter = state.liveData.linescore.offense.batter?.id
    expect(batter).not.equals(undefined)
    expect(
      refused(state, [{ type: 'pinchRunner', player: batter!, base: '1B' }])
    ).equals(`${state.gameData.players[batter!].fullName} is already batting`)
  })

  it('refuses a pinch runner for an empty base, or before the game begins', function () {
    expect(
      refused(live(), [
        { type: 'pinchRunner', player: id('Lindor'), base: '2B' }
      ])
    ).equals('Nobody is on 2B')
    expect(
      refused(pregame(), [
        { type: 'pinchRunner', player: id('Lindor'), base: '1B' }
      ])
    ).equals('Pinch runners only once the game has begun')
  })

  it('refuses a sentence of two categories or two teams, and stages nothing', function () {
    const state = pregame()
    const before = JSON.stringify(state)
    expect(
      refused(state, [
        {
          type: 'placeInLineup',
          side: 'away',
          places: [{ player: id('Judge'), slot: 1 }]
        },
        {
          type: 'setPositions',
          side: 'away',
          places: [{ player: id('Soto'), position: 'SS' }]
        }
      ])
    ).equals(ONE_CATEGORY_AT_A_TIME)
    expect(
      refused(state, [
        {
          type: 'setPositions',
          side: 'away',
          places: [{ player: id('Soto'), position: 'SS' }]
        },
        {
          type: 'setPositions',
          side: 'home',
          places: [{ player: id('Witt'), position: 'SS' }]
        }
      ])
    ).equals(ONE_TEAM_AT_A_TIME)
    // A pinch hitter is the side at bat's: the home side's order is another team.
    expect(
      refused(live(), [
        { type: 'pinchHitter', player: id('Lindor') },
        {
          type: 'placeInLineup',
          side: 'home',
          places: [{ player: id('Witt'), slot: 1 }]
        }
      ])
    ).equals(ONE_TEAM_AT_A_TIME)
    expect(refused(state, [])).equals('Nothing to change')
    expect(JSON.stringify(state)).equals(before)
  })

  it('refuses a player who is not on the side, and stages none of the sentence', function () {
    const state = pregame()
    expect(
      refused(state, [
        {
          type: 'setPositions',
          side: 'away',
          places: [
            { player: id('Soto'), position: 'SS' },
            { player: id('Witt'), position: '2B' }
          ]
        }
      ])
    ).equals('Witt is not on the Visitors roster')
    expect(
      refused(state, [{ type: 'setLineup', side: 'home', order: [99] }])
    ).equals('Player 99 is not on the Hosts roster')
  })

  it('opens each category on its tab', function () {
    expect(ROSTER_TAB).deep.equals({
      roster: 'editRoster',
      offense: 'lineup',
      defense: 'defense'
    })
  })

  it('drops a staged next batter the sentence took out of the order', function () {
    const state = live()
    const result = staged(
      state,
      [{ type: 'setLineup', side: 'away', order: [id('Soto'), id('Betts')] }],
      { nextBatter: id('Judge') }
    )
    expect(result.nextBatter).equals(undefined)
    const kept = staged(
      state,
      [{ type: 'setLineup', side: 'away', order: [id('Judge'), id('Betts')] }],
      { nextBatter: id('Judge') }
    )
    expect(kept.nextBatter).equals(id('Judge'))
  })
})

describe('the roster prompt (U2)', function () {
  it('lists each side asked for by name and number: the order with positions, then the bench, and no ids', function () {
    const state = staged(pregame(), [
      {
        type: 'setPositions',
        side: 'away',
        places: [{ player: id('Lindor'), position: 'SS' }]
      }
    ]).draft
    state.gameData.players[id('Alonso')].jersey = ''
    const away = rosterPrompt(state, ['away']).split('\n')
    expect(away).deep.equals([
      'AWAY — Visitors',
      '  Judge #2 — bats 1st, plays P',
      '  Soto #3 — bats 2nd, plays C',
      '  Betts #4 — bats 3rd, plays 1B',
      '  Ohtani #5 — bats 4th, plays 2B',
      '  Freeman #6 — bats 5th',
      '  Trout #7 — bats 6th, plays 3B',
      '  Harper #8 — bats 7th, plays LF',
      '  Machado #9 — bats 8th, plays CF',
      '  Alonso — bats 9th, plays RF',
      '  Lindor #11 — plays SS'
    ])
    state.liveData.boxscore.teams.home.defense.P = null
    const both = rosterPrompt(state, ['away', 'home']).split('\n')
    expect(both).length(22)
    expect(both[11]).equals('HOME — Hosts')
    expect(both.at(-2)).equals('  Riley #10 — bats 9th, plays RF')
    expect(both.at(-1)).equals('  Arenado #11 — bench')
    expect(both[12]).equals('  Cole #2 — bats 1st')
    expect(rosterPrompt(state, ['home'])).not.include('AWAY')
    // Once the game has begun, the game line says who is at bat; the
    // rosters are listed the same way.
    const top = rosterPrompt(live(), ['away', 'home'])
    expect(top.split('\n')).length(22)
    expect(top).not.match(/\bid\b|at bat|in the field/)
  })
})

/**
 * A value of each schema: the first of each enum and of each choice, and a
 * jersey in digits.
 */
function example(schema: JsonSchema, key?: string): unknown {
  if (schema.anyOf != null) return example(schema.anyOf[0])
  if (schema.enum != null) return schema.enum[0]
  if (schema.type === 'integer') return schema.minimum ?? 1
  if (schema.type === 'boolean') return false
  if (schema.type === 'string') return key === 'jersey' ? '17' : 'Ohtani'
  if (schema.type === 'array') return [example(schema.items!)]
  return Object.fromEntries(
    Object.entries(schema.properties ?? {}).map(([name, value]) => [
      name,
      example(value, name)
    ])
  )
}

describe('the roster tools (U2)', function () {
  it('names every command, and each tool takes the command as said without its type', function () {
    const tools = rosterToolSchema()
    expect(tools.map(tool => tool.name)).deep.equals([...ROSTER_COMMAND_TYPES])
    for (const tool of tools) {
      expect(tool.input_schema).deep.include({
        type: 'object',
        additionalProperties: false
      })
      // The team is said only when the scorer names one.
      expect(tool.input_schema.required ?? []).not.include('side')
      const input = example(tool.input_schema) as Record<string, unknown>
      for (const key of tool.input_schema.required ?? [])
        expect(input, `${tool.name} ${key}`).has.property(key)
      const command = asSaidRosterCommand({ ...input, type: tool.name })
      expect(command, tool.name).deep.equals({ ...input, type: tool.name })
    }
    // A player is said by number and name, never by id.
    const setLineup = tools.find(tool => tool.name === 'setLineup')!
    expect(setLineup.input_schema.properties!.order.items).deep.include({
      type: 'object',
      additionalProperties: false
    })
    expect(
      Object.keys(setLineup.input_schema.properties!.order.items!.properties!)
    ).deep.equals(['jersey', 'name'])
  })

  it('cleans a command as said: a number or a name for each player, and the team only when named', function () {
    expect(
      asSaidRosterCommand({
        type: 'placeInLineup',
        side: null,
        places: [
          { player: { jersey: ' #3 ', name: '' }, slot: 'end' },
          { player: { jersey: 12 }, slot: 2 },
          { player: { name: ' Soto ', jersey: null }, slot: 4 }
        ]
      })
    ).deep.equals({
      type: 'placeInLineup',
      places: [
        { player: { jersey: '3' }, slot: 'end' },
        { player: { jersey: '12' }, slot: 2 },
        { player: { name: 'Soto' }, slot: 4 }
      ]
    })
    expect(
      asSaidRosterCommand({
        type: 'setPositions',
        side: 'home',
        places: [{ player: { name: 'Soto', jersey: '22' }, position: 'SS' }]
      })
    ).deep.equals({
      type: 'setPositions',
      side: 'home',
      places: [{ player: { name: 'Soto', jersey: '22' }, position: 'SS' }]
    })
    expect(
      asSaidRosterCommand({ type: 'addPlayer', side: '', name: 'Ohtani' })
    ).deep.equals({ type: 'addPlayer', name: 'Ohtani' })
    // An id is no player said, and nor is nothing.
    expect(() =>
      asSaidRosterCommand({ type: 'pinchHitter', player: 3 })
    ).to.throw()
    expect(() =>
      asSaidRosterCommand({ type: 'pinchHitter', player: { name: ' ' } })
    ).to.throw('Expected a player by number or name')
    expect(() =>
      asSaidRosterCommand({ type: 'setLineup', side: 'both', order: [] })
    ).to.throw()
    expect(() => asSaidRosterCommand({ type: 'substitute' })).to.throw(
      'Unknown roster command "substitute"'
    )
  })

  it('cleans a resolved command by its type, and refuses one it does not know', function () {
    // The other choice for a place in the order.
    expect(
      asRosterCommand({
        type: 'placeInLineup',
        side: 'home',
        places: [{ player: 3, slot: 'end' }]
      })
    ).deep.equals({
      type: 'placeInLineup',
      side: 'home',
      places: [{ player: 3, slot: 'end' }]
    })
    expect(
      asRosterCommand({
        type: 'addPlayer',
        side: 'away',
        name: 'Ohtani',
        jersey: undefined
      })
    ).deep.equals({ type: 'addPlayer', side: 'away', name: 'Ohtani' })
    expect(() => asRosterCommand({ type: 'substitute' })).to.throw(
      'Unknown roster command "substitute"'
    )
    expect(() => asRosterCommand('setLineup')).to.throw(
      'Unknown roster command null'
    )
    expect(() =>
      asRosterCommand({
        type: 'placeInLineup',
        side: 'away',
        places: [{ player: 1, slot: 0 }]
      })
    ).to.throw('Expected a place from 1, got 0')
    expect(() =>
      asRosterCommand({ type: 'pinchRunner', player: 1, base: 'home' })
    ).to.throw()
    // A said team is required once resolved.
    expect(() => asRosterCommand({ type: 'setLineup', order: [1] })).to.throw()
  })
})

/** Renames a player, as a roster with a first and a last name has him. */
function rename(
  state: GameState,
  player: number,
  firstName: string,
  lastName: string
): void {
  Object.assign(state.gameData.players[player], {
    fullName: `${firstName} ${lastName}`,
    firstName,
    lastName
  })
}
function resolve(
  state: GameState,
  said: ChosenRosterCommand[],
  resolving: Partial<RosterResolving> = {}
): RosterResolution {
  const { live, battingSide } = rosterSituation(state)
  return resolveRosterCommands(state, said, {
    live,
    battingSide,
    ...resolving
  })
}
function resolved(
  state: GameState,
  said: ChosenRosterCommand[],
  resolving: Partial<RosterResolving> = {}
): RosterCommand[] {
  const result = resolve(state, said, resolving)
  if (!('commands' in result)) throw new Error(JSON.stringify(result))
  return result.commands
}
function asked(
  state: GameState,
  said: ChosenRosterCommand[],
  resolving: Partial<RosterResolving> = {}
): RosterQuestion {
  const result = resolve(state, said, resolving)
  if (!('question' in result)) throw new Error(JSON.stringify(result))
  return result.question
}
function problem(
  state: GameState,
  said: ChosenRosterCommand[],
  resolving: Partial<RosterResolving> = {}
): string {
  const result = resolve(state, said, resolving)
  if (!('problem' in result)) throw new Error(JSON.stringify(result))
  return result.problem
}
/** One player said to one position, with no team said. */
const at = (
  player: { jersey?: string; name?: string },
  position: 'SS' | '1B' | '2B' | '3B' | 'P' = '3B'
): Extract<ChosenRosterCommand, { type: 'setPositions' }> => ({
  type: 'setPositions',
  places: [{ player, position }]
})

describe('resolving roster commands as said (U2r)', function () {
  // Both teams wear #2 to #11: the visitors' #4 is Betts, the hosts' Witt.
  it('once the game has begun, finds a jersey both teams wear on the side in the field for a defensive change, and on the side at bat for a pinch hitter or runner', function () {
    const top = live()
    expect(resolved(top, [at({ jersey: '4' })])).deep.equals([
      {
        type: 'setPositions',
        side: 'home',
        places: [{ player: id('Witt'), position: '3B' }]
      }
    ])
    expect(
      resolved(top, [{ type: 'pinchHitter', player: { jersey: '11' } }])
    ).deep.equals([{ type: 'pinchHitter', player: id('Lindor') }])
    expect(
      resolved(top, [
        { type: 'pinchRunner', player: { name: 'lindor' }, base: '1B' }
      ])
    ).deep.equals([{ type: 'pinchRunner', player: id('Lindor'), base: '1B' }])
    // In the bottom half the sides change places.
    const bottom = after(walk(pregame()), { type: 'gameFlow', kind: 'endHalf' })
    expect(resolved(bottom, [at({ jersey: '4' })])).deep.equals([
      {
        type: 'setPositions',
        side: 'away',
        places: [{ player: id('Betts'), position: '3B' }]
      }
    ])
    expect(
      resolved(bottom, [{ type: 'pinchHitter', player: { jersey: '11' } }])
    ).deep.equals([{ type: 'pinchHitter', player: id('Arenado') }])
    // Before the game, a pinch hitter is the side due to bat first's, and is
    // refused once applied: nobody is asked which.
    expect(
      resolved(pregame(), [{ type: 'pinchHitter', player: { jersey: '11' } }])
    ).deep.equals([{ type: 'pinchHitter', player: id('Lindor') }])
    // A place in the order, said with the team.
    expect(
      resolved(top, [
        {
          type: 'placeInLineup',
          side: 'home',
          places: [
            { player: { name: 'Witt' }, slot: 1 },
            { player: { jersey: '11' }, slot: 'end' }
          ]
        }
      ])
    ).deep.equals([
      {
        type: 'placeInLineup',
        side: 'home',
        places: [
          { player: id('Witt'), slot: 1 },
          { player: id('Arenado'), slot: 'end' }
        ]
      }
    ])
  })

  it('takes the team the scorer names, and a coach’s own side over it', function () {
    const top = live()
    expect(
      resolved(top, [{ ...at({ jersey: '4' }), side: 'away' }])
    ).deep.equals([
      {
        type: 'setPositions',
        side: 'away',
        places: [{ player: id('Betts'), position: '3B' }]
      }
    ])
    expect(
      resolved(top, [{ ...at({ jersey: '4' }), side: 'home' }], {
        fixedSide: 'away'
      })
    ).deep.equals([
      {
        type: 'setPositions',
        side: 'away',
        places: [{ player: id('Betts'), position: '3B' }]
      }
    ])
    expect(
      resolved(top, [{ type: 'pinchHitter', player: { jersey: '11' } }], {
        fixedSide: 'home'
      })
    ).deep.equals([{ type: 'pinchHitter', player: id('Arenado') }])
  })

  it('before the game, asks which team’s player when a jersey or a name is on both, one option each, and takes a name on one team', function () {
    const state = pregame()
    const which = asked(state, [at({ jersey: '4' }, '1B')])
    expect(which).deep.equals({
      question: 'Which #4?',
      options: [
        {
          label: 'Betts #4, Visitors',
          side: 'away',
          commands: [
            {
              type: 'setPositions',
              side: 'away',
              places: [{ player: id('Betts'), position: '1B' }]
            }
          ]
        },
        {
          label: 'Witt #4, Hosts',
          side: 'home',
          commands: [
            {
              type: 'setPositions',
              side: 'home',
              places: [{ player: id('Witt'), position: '1B' }]
            }
          ]
        }
      ]
    })
    rename(state, id('Turner'), 'Tyler', 'Freeman')
    const freeman = asked(state, [at({ name: 'Freeman' }, '1B')])
    expect(freeman.question).equals('Which Freeman?')
    expect(freeman.options.map(option => option.label)).deep.equals([
      'Freeman #6, Visitors',
      'Tyler F. #6, Hosts'
    ])
    // Chosen, an option resolves as it was said.
    expect(resolved(state, freeman.options[1].commands)).deep.equals(
      freeman.options[1].commands
    )
    expect(resolved(state, [at({ name: 'Witt' })])).deep.equals([
      {
        type: 'setPositions',
        side: 'home',
        places: [{ player: id('Witt'), position: '3B' }]
      }
    ])
    // A new player with no team named: which team.
    const team = asked(state, [{ type: 'addPlayer', name: 'Ohtani' }])
    expect(team).deep.equals({
      question: 'Which team?',
      options: [
        {
          label: 'Visitors',
          side: 'away',
          commands: [{ type: 'addPlayer', name: 'Ohtani', side: 'away' }]
        },
        {
          label: 'Hosts',
          side: 'home',
          commands: [{ type: 'addPlayer', name: 'Ohtani', side: 'home' }]
        }
      ]
    })
    expect(
      resolved(state, [{ type: 'addPlayer', name: 'Ohtani', side: 'home' }])
    ).deep.equals([{ type: 'addPlayer', name: 'Ohtani', side: 'home' }])
  })

  it('asks which player when two on the side share a name', function () {
    const top = live()
    rename(top, id('Cole'), 'Chase', 'Lee')
    rename(top, id('Skenes'), 'Chase', 'Martin')
    const which = asked(top, [at({ name: 'chase' }, 'SS')])
    expect(which.question).equals('Which chase?')
    expect(which.options).deep.equals([
      {
        label: 'Chase L. #2',
        side: 'home',
        commands: [
          {
            type: 'setPositions',
            side: 'home',
            places: [{ player: id('Cole'), position: 'SS' }]
          }
        ]
      },
      {
        label: 'Chase M. #3',
        side: 'home',
        commands: [
          {
            type: 'setPositions',
            side: 'home',
            places: [{ player: id('Skenes'), position: 'SS' }]
          }
        ]
      }
    ])
    // His last name, or his number with the name, says which.
    expect(resolved(top, [at({ name: 'Martin' })])).deep.equals([
      {
        type: 'setPositions',
        side: 'home',
        places: [{ player: id('Skenes'), position: '3B' }]
      }
    ])
    expect(resolved(top, [at({ name: 'Chase', jersey: '2' })])).deep.equals([
      {
        type: 'setPositions',
        side: 'home',
        places: [{ player: id('Cole'), position: '3B' }]
      }
    ])
  })

  it('refuses a player nobody on the team is, naming the team', function () {
    const top = live()
    expect(problem(top, [at({ jersey: '42' })])).equals('No #42 on the Hosts')
    expect(problem(top, [at({ name: 'Witt', jersey: '5' })])).equals(
      'No Witt #5 on the Hosts'
    )
    expect(
      problem(top, [{ type: 'pinchHitter', player: { name: 'Witt' } }])
    ).equals('No Witt on the Visitors')
    expect(
      problem(pregame(), [
        { type: 'setLineup', order: [{ name: 'Judge' }, { name: 'Garcia' }] }
      ])
    ).equals('No Garcia on the Visitors or the Hosts')
    // A player chosen who is not on the team the command is about.
    expect(problem(top, [{ type: 'pinchHitter', player: id('Witt') }])).equals(
      'No Witt on the Visitors'
    )
    expect(problem(top, [{ type: 'pinchHitter', player: 99 }])).equals(
      'No player 99 on the Visitors'
    )
  })

  it('matches a last, first, full or short name, whatever its case and accents', function () {
    const state = pregame()
    rename(state, id('Seager'), 'José', 'Ramírez')
    const ramirez = [
      {
        type: 'setPositions',
        side: 'home',
        places: [{ player: id('Seager'), position: '3B' }]
      }
    ]
    for (const name of ['ramirez', 'JOSE', 'José Ramírez', 'Jose R.', 'jose r'])
      expect(resolved(state, [at({ name })]), name).deep.equals(ramirez)
    // A player with only a full name answers to its first and last words.
    expect(resolved(state, [at({ name: 'TROUT' })])).deep.equals([
      {
        type: 'setPositions',
        side: 'away',
        places: [{ player: id('Trout'), position: '3B' }]
      }
    ])
  })

  it('resolves a sentence’s commands together, on one team, and asks about the first player who fits two, then the next', function () {
    const state = pregame()
    // #5 is on both teams, but Witt is only a host's: the sentence is theirs.
    expect(
      resolved(state, [at({ name: 'Witt' }, 'SS'), at({ jersey: '5' }, '2B')])
    ).deep.equals([
      {
        type: 'setPositions',
        side: 'home',
        places: [{ player: id('Witt'), position: 'SS' }]
      },
      {
        type: 'setPositions',
        side: 'home',
        places: [{ player: id('Seager'), position: '2B' }]
      }
    ])
    expect(
      problem(state, [at({ name: 'Judge' }, 'SS'), at({ name: 'Witt' }, '2B')])
    ).equals(ONE_TEAM_AT_A_TIME)
    // Two hosts called Chase and two called Freeman: Chase is asked first,
    // and Freeman once Chase is chosen.
    const top = live()
    rename(top, id('Cole'), 'Chase', 'Lee')
    rename(top, id('Skenes'), 'Chase', 'Martin')
    rename(top, id('Turner'), 'Tyler', 'Freeman')
    rename(top, id('Arenado'), 'Freddie', 'Freeman')
    const sentence: ChosenRosterCommand[] = [
      {
        type: 'setPositions',
        places: [
          { player: { name: 'Chase' }, position: 'SS' },
          { player: { name: 'Freeman' }, position: '2B' }
        ]
      }
    ]
    const first = asked(top, sentence)
    expect(first.question).equals('Which Chase?')
    expect(first.options[1].commands).deep.equals([
      {
        type: 'setPositions',
        places: [
          { player: id('Skenes'), position: 'SS' },
          { player: { name: 'Freeman' }, position: '2B' }
        ]
      }
    ])
    const second = asked(top, first.options[1].commands)
    expect(second.question).equals('Which Freeman?')
    expect(second.options.map(option => option.label)).deep.equals([
      'Tyler F. #6',
      'Freddie F. #11'
    ])
    expect(resolved(top, second.options[1].commands)).deep.equals([
      {
        type: 'setPositions',
        side: 'home',
        places: [
          { player: id('Skenes'), position: 'SS' },
          { player: id('Arenado'), position: '2B' }
        ]
      }
    ])
  })
})
