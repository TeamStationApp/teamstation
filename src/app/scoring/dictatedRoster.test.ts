import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  promptContext,
  type ScoringAction,
  shortName
} from '../../common/scoring/actions'
import {
  ONE_CATEGORY_AT_A_TIME,
  rosterPrompt,
  type SaidRosterCommand
} from '../../common/scoring/rosterCommands'
import { applyAction } from '../../common/scoring/session'
import { copyState, type GameState } from '../../common/scoring/state'
import { scoringSession } from '../../test/scoringSession'
import {
  dictatedSheet,
  FINISH_THE_PLAY,
  openDictatedRosters,
  rosterReply,
  UNREFRESHED
} from './dictatedRoster'
import { dictationContext } from './dictationHook'
import { gameFixture } from './isUnscoredGame.test'
import type { RosterEditorDraft } from './RosterEditor'

const SEPARATELY = 'Say a substitution separately from a play'
/** The bench player each side gets, by session id. */
const BENCH = { away: 90, home: 91 }

/** A new game, each side with one player on the bench. */
function opening(): GameState {
  const state = copyState(scoringSession(gameFixture))
  for (const side of ['away', 'home'] as const) {
    const id = BENCH[side]
    const first = state.liveData.boxscore.teams[side].battingOrder[0]
    state.gameData.players[id] = {
      ...state.gameData.players[first],
      id,
      fullName: side === 'away' ? 'Freeman' : 'Soto',
      firstName: side === 'away' ? 'Freeman' : 'Soto',
      lastName: '',
      jersey: side === 'away' ? '13' : '10'
    }
    state.liveData.boxscore.teams[side].players.push(id)
  }
  return state
}
function play(state: GameState, actions: ScoringAction[]): GameState {
  let next = state
  for (const action of actions) {
    const applied = applyAction(next, action)
    expect(applied.problems).deep.equals([])
    next = applied.state
  }
  return next
}
const walk: ScoringAction[] = [
  ...Array.from({ length: 4 }, () => ({ type: 'pitch', call: 'B' }) as const),
  { type: 'gameFlow', kind: 'closePlay' }
]
/** Two walks: the leadoff man on second, the next on first. */
function runnersOn(): GameState {
  return play(opening(), [...walk, ...walk])
}
const away = (state: GameState): number[] =>
  state.liveData.boxscore.teams.away.battingOrder
const home = (
  state: GameState
): GameState['liveData']['boxscore']['teams']['home'] =>
  state.liveData.boxscore.teams.home

describe('a substitution said on the scoring screen', function () {
  // "Number 10 subs in at third base": no team said.
  const thirdBase: SaidRosterCommand = {
    type: 'setPositions',
    places: [{ player: { jersey: '10' }, position: '3B' }]
  }

  it('leaves a sentence with no roster commands to be scored', function () {
    expect(
      rosterReply(opening(), 'ball', [{ type: 'pitch', call: 'B' }], [], true)
    ).equals(null)
  })

  it('refuses a play and a substitution together, and either while a play is entered', function () {
    const state = runnersOn()
    const runner: SaidRosterCommand = {
      type: 'pinchRunner',
      player: { name: 'Freeman' },
      base: '1B'
    }
    expect(
      rosterReply(
        state,
        'Ball one, and Freeman runs at first',
        [{ type: 'pitch', call: 'B' }],
        [runner],
        true
      )
    ).deep.equals({ problem: SEPARATELY })
    expect(
      rosterReply(state, 'Freeman runs at first', [], [runner], false)
    ).deep.equals({ problem: FINISH_THE_PLAY })
  })

  it('refuses what does not apply to the game, opening nothing', function () {
    // Nobody has batted: there is no pinch hitter yet.
    expect(
      rosterReply(
        opening(),
        'Freeman pinch hits',
        [],
        [{ type: 'pinchHitter', player: { name: 'Freeman' } }],
        true
      )
    ).deep.equals({ problem: 'Pinch hitters only once the game has begun' })
    // A player said who is nobody on the side the change draws on.
    expect(
      rosterReply(
        play(opening(), walk),
        'Number 42 subs in at third base',
        [],
        [
          {
            ...thirdBase,
            places: [{ player: { jersey: '42' }, position: '3B' }]
          }
        ],
        true
      )
    ).deep.equals({ problem: 'No #42 on the Hawks' })
    expect(
      rosterReply(
        opening(),
        'Put Judge leadoff and Soto at third',
        [],
        [
          {
            type: 'placeInLineup',
            side: 'away',
            places: [{ player: { name: 'Freeman' }, slot: 1 }]
          },
          thirdBase
        ],
        true
      )
    ).deep.equals({ problem: ONE_CATEGORY_AT_A_TIME })
  })

  it('opens on a lineup said before the lineup is accepted', function () {
    // Three batters: the scoring screen has not accepted this lineup.
    const short = opening()
    short.liveData.boxscore.teams.away.battingOrder.splice(3)
    const order = [BENCH.away, ...away(short)]
    const said = 'Set this lineup'
    const commands: SaidRosterCommand[] = [
      {
        type: 'setLineup',
        side: 'away',
        order: order.map(id => ({ jersey: short.gameData.players[id].jersey }))
      }
    ]
    expect(rosterReply(short, said, [], commands, true)).deep.equals({
      dictated: { transcript: said, commands }
    })
    const sheet = dictatedSheet(short, { transcript: said, commands })
    expect(sheet).not.has.property('problem')
    expect(away((sheet as RosterEditorDraft).draft)).deep.equals(order)
  })

  it('stages a defensive change on the Defense tab of the side in the field, after the refresh', async function () {
    const said = 'Number 10 subs in at third base'
    const commands = [thirdBase]
    const state = play(opening(), walk)
    expect(rosterReply(state, said, [], commands, true)).deep.equals({
      dictated: { transcript: said, commands }
    })
    // Another scorer moved the home team's first two batters meanwhile.
    const fresh = copyState(state)
    const order = home(fresh).battingOrder
    ;[order[0], order[1]] = [order[1], order[0]]
    const steps: string[] = []
    let opened: RosterEditorDraft | undefined
    await openDictatedRosters(
      { transcript: said, commands },
      async () => {
        steps.push('refresh')
        return fresh
      },
      {
        open: initial => {
          steps.push('open')
          opened = initial
        },
        refuse: problem => {
          throw new Error(problem)
        }
      }
    )
    expect(steps).deep.equals(['refresh', 'open'])
    const sheet = opened!
    expect(sheet).deep.include({ side: 'home', mode: 'defense', base: fresh })
    expect(home(sheet.draft).defense['3B']).equals(BENCH.home)
    // Staged on top of the other scorer's order, which it leaves alone.
    expect(home(sheet.draft).battingOrder).deep.equals(order)
    expect(sheet.runners).equals(undefined)
    expect(sheet.nextBatter).equals(undefined)
    // The third baseman he replaces leaves the field and keeps his slot.
    const replaced = home(state).defense['3B']!
    expect(home(sheet.draft).battingOrder).includes(replaced)
    expect(sheet.chat).deep.equals([
      {
        key: 0,
        said,
        lines: [
          { kind: 'done', text: 'Soto to 3B' },
          {
            kind: 'done',
            text: `${shortName(state.gameData.players[replaced])} off the field`
          }
        ]
      }
    ])
  })

  it('stages a pinch hitter in the due batter’s slot, to bat next', function () {
    const state = play(opening(), walk)
    const due = away(state)[1]
    const sheet = dictatedSheet(state, {
      transcript: 'Freeman pinch hits',
      commands: [{ type: 'pinchHitter', player: { name: 'Freeman' } }]
    }) as RosterEditorDraft
    expect(sheet).deep.include({
      side: 'away',
      mode: 'lineup',
      nextBatter: BENCH.away
    })
    expect(away(sheet.draft)[1]).equals(BENCH.away)
    expect(away(sheet.draft)).not.includes(due)
  })

  it('stages a pinch runner without touching the order', async function () {
    const state = runnersOn()
    const onSecond = state.liveData.linescore.offense.second!.id
    let opened: RosterEditorDraft | undefined
    await openDictatedRosters(
      {
        transcript: 'Freeman runs for the runner on second',
        commands: [
          { type: 'pinchRunner', player: { jersey: '13' }, base: '2B' }
        ]
      },
      async () => state,
      {
        open: initial => {
          opened = initial
        },
        refuse: problem => {
          throw new Error(problem)
        }
      }
    )
    expect(opened).deep.include({
      side: 'away',
      mode: 'lineup',
      runners: [{ base: '2B', player: BENCH.away }]
    })
    expect(away(opened!.draft)).deep.equals(away(state))
    expect(opened!.chat![0].lines).deep.equals([
      {
        kind: 'done',
        text: `Freeman runs for ${shortName(state.gameData.players[onSecond])}`
      }
    ])
  })

  it('opens nothing when the refreshed game no longer allows it, or cannot be read', async function () {
    const dictated = {
      transcript: 'Freeman runs for the runner on second',
      commands: [
        {
          type: 'pinchRunner',
          player: { name: 'Freeman' },
          base: '2B'
        } as const
      ]
    }
    // When the sentence was heard there was a runner on second; another
    // scorer took both walks back.
    expect(
      rosterReply(runnersOn(), dictated.transcript, [], dictated.commands, true)
    ).has.property('dictated')
    const outcomes: string[] = []
    const outcome = {
      open: () => {
        outcomes.push('opened')
      },
      refuse: (problem: string) => {
        outcomes.push(problem)
      }
    }
    await openDictatedRosters(dictated, async () => opening(), outcome)
    await openDictatedRosters(dictated, async () => null, outcome)
    await openDictatedRosters(
      dictated,
      async () => await Promise.reject(new Error('offline')),
      outcome
    )
    expect(outcomes).deep.equals([
      'Pinch runners only once the game has begun',
      UNREFRESHED,
      UNREFRESHED
    ])
  })

  it('tells the model both rosters, bench and all, after the at-bat', function () {
    const state = runnersOn()
    const context = dictationContext(state)
    expect(context).equals(
      `${promptContext(state)}\nROSTERS\n${rosterPrompt(state, ['away', 'home'])}`
    )
    expect(context).includes('Freeman #13 — bench')
    expect(context).includes('Soto #10 — bench')
  })

  it('opens the sheet on the change’s tab, nothing staged, asking which player when one said fits two', async function () {
    // Before the game, both teams wear #3.
    const said = 'Number 3 subs in at third base'
    const commands: SaidRosterCommand[] = [
      {
        type: 'setPositions',
        places: [{ player: { jersey: '3' }, position: '3B' }]
      }
    ]
    const state = opening()
    expect(rosterReply(state, said, [], commands, true)).deep.equals({
      dictated: { transcript: said, commands }
    })
    let opened: RosterEditorDraft | undefined
    await openDictatedRosters(
      { transcript: said, commands },
      async () => state,
      {
        open: initial => {
          opened = initial
        },
        refuse: problem => {
          throw new Error(problem)
        }
      }
    )
    const sheet = opened!
    expect(sheet).deep.include({
      draft: state,
      base: state,
      side: 'away',
      mode: 'defense',
      chat: [{ key: 0, said, lines: [] }]
    })
    expect(sheet.question!.question).equals('Which #3?')
    expect(sheet.question!.options.map(option => option.label)).deep.equals([
      'Player 3. #3, Owls',
      'Player 3. #3, Hawks'
    ])
    // Once the game has begun, two of one name on the side in the field:
    // the sheet opens on that side.
    const live = play(opening(), walk)
    live.gameData.players[BENCH.home].fullName = 'Player 5'
    live.gameData.players[BENCH.home].firstName = 'Player'
    live.gameData.players[BENCH.home].lastName = '5'
    const two = dictatedSheet(live, {
      transcript: 'Player 5 moves to third base',
      commands: [
        {
          type: 'setPositions',
          places: [{ player: { name: 'player 5' }, position: '3B' }]
        }
      ]
    }) as RosterEditorDraft
    expect(two).deep.include({ side: 'home', mode: 'defense' })
    expect(two.question!.options.map(option => option.side)).deep.equals([
      'home',
      'home'
    ])
  })
})
