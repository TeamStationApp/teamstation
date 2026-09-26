import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  after,
  ball,
  close,
  F,
  game,
  single,
  strike,
  walk
} from '../../test/scoringGames'
import { MOVEMENT_REASONS, STORED_EVENT_TYPES } from '../gumbo/reference'
import type { GumboPlay } from '../gumboPlay'
import type { ScoringAction } from './actions'
import {
  currentDocumentOf,
  documentOf,
  finalDocumentOf,
  storedEventType
} from './document'
import { newSetup } from './lineup'
import { type GamePlay, type GameState, setupOf } from './state'

type RunnerTo = 'batter' | '1B' | '2B' | '3B' | 'home'
type Move = Extract<ScoringAction, { type: 'runnerMovement' }>
const move = (
  runner: number,
  to: RunnerTo,
  extra: Partial<Move> = {}
): ScoringAction => ({ type: 'runnerMovement', runner, to, ...extra })
const out = (
  runner: number,
  to: RunnerTo,
  fielders: number[],
  reason?: Move['reason']
): ScoringAction =>
  move(runner, to, {
    out: true,
    fielders,
    ...(reason == null ? {} : { reason })
  })
const groundBall: ScoringAction[] = [
  { type: 'ballInPlay', contact: 'swing', fielder: F.SS },
  { type: 'result', eventType: 'field_out' }
]
const flyBall: ScoringAction[] = [
  { type: 'ballInPlay', contact: 'swing', fielder: F.CF },
  { type: 'result', eventType: 'field_out', outBy: 'catch' }
]
const hit = (eventType: 'single' | 'double' | 'triple'): ScoringAction[] => [
  { type: 'ballInPlay', contact: 'swing', fielder: F.CF },
  { type: 'result', eventType }
]
const running = (
  kind: Extract<ScoringAction, { type: 'baseRunning' }>['kind'],
  runner = 1
): ScoringAction => ({ type: 'baseRunning', kind, runner })

interface StoredRunner {
  movement: Record<string, unknown>
  details: Record<string, unknown> & {
    runner: { id?: number; fullName?: string }
  }
  credits: Array<Record<string, unknown>>
}
function runnersOf(play: GumboPlay): StoredRunner[] {
  return (play.runners ?? []) as unknown as StoredRunner[]
}
/** The play in progress, or the last one completed, as it is stored. */
function stored(state: GameState, completed = false): GumboPlay {
  const stamp = { setupBefore: setupOf(state), actions: [] }
  if (completed)
    return documentOf(state, state.liveData.plays.allPlays.at(-1)!, stamp)
  const play: GamePlay = state.liveData.plays.currentPlay!
  return play.result.eventType === ''
    ? (currentDocumentOf(state, play, stamp) as unknown as GumboPlay)
    : documentOf(state, play, stamp)
}
/** A made-up runner by his number, `Player 4` as 4, or `batter`. */
function runnerName(runner: StoredRunner): string {
  return runner.movement.start === null && runner.movement.originBase === null
    ? 'batter'
    : String(runner.details.runner.fullName).replace('Player ', '')
}
/** Each stored runner of a play as `runner reason eventType`. */
function reasons(play: GumboPlay): string[] {
  return runnersOf(play).map(
    r =>
      `${runnerName(r)} ${String(r.details.movementReason)} ${String(r.details.eventType)}`
  )
}

/** Rostered, so every player is named by a user id: runner n is 100 + n. */
function rostered(): GameState {
  const setup = newSetup(
    {
      away: { id: 'team-away', name: 'A' },
      home: { id: 'team-home', name: 'H' }
    },
    {
      away: Array.from({ length: 9 }, (_, i) => ({
        userId: 101 + i,
        shortName: `Away ${i + 1}`
      })),
      home: Array.from({ length: 9 }, (_, i) => ({
        userId: 201 + i,
        shortName: `Home ${i + 1}`
      }))
    }
  )
  return after(game(), { type: 'lineup', kind: 'roster', setup })
}

describe('the stored runner document (U8)', function () {
  it('writes the batter from nowhere, and a runner put out at the base he was out at', function () {
    const state = after(single(game()), close, ...groundBall)
    const done = after(
      state,
      out(1, '2B', [F.SS, F['2B']]),
      out(2, '1B', [F['2B'], F['1B']])
    )
    const [first, batter, lead, second] = [
      runnersOf(stored(single(game())))[0],
      ...runnersOf(stored(done))
    ]
    expect(first.movement).deep.equals({
      originBase: null,
      start: null,
      end: '1B',
      outBase: null,
      isOut: false,
      outNumber: null
    })
    expect(first.details.movementReason).equals(null)
    // The batter entry of the ground ball is written when he is put out.
    expect(batter.movement).deep.includes({
      originBase: '1B',
      start: '1B',
      end: null,
      outBase: '2B',
      isOut: true,
      outNumber: 1
    })
    expect(lead.movement).deep.includes({
      originBase: null,
      start: null,
      end: null,
      outBase: '1B',
      outNumber: 2
    })
    expect(second).equals(undefined)
    // A batter out at the plate — a strikeout — is out at first.
    const k = after(game(), strike, strike, strike)
    expect(runnersOf(stored(k))[0].movement).deep.includes({
      start: null,
      end: null,
      outBase: '1B'
    })
  })

  it('takes the origin base from the start of the plate appearance, across two movements', function () {
    const state = after(
      single(game()),
      close,
      running('steal'),
      ...hit('single'),
      move(1, 'home')
    )
    const all = runnersOf(stored(state))
    expect(
      all.map(r => [r.movement.originBase, r.movement.start, r.movement.end])
    ).deep.equals([
      ['1B', '1B', '2B'],
      ['1B', '2B', '3B'],
      [null, null, '1B'],
      ['1B', '3B', 'score']
    ])
    expect(all.map(r => r.details.eventType)).deep.equals([
      'stolen_base_2b',
      'single',
      'single',
      'single'
    ])
    expect(all.map(r => r.details.playIndex)).deep.equals([0, 1, 1, 1])
    expect(all[3].details).includes({ isScoringEvent: true, rbi: true })
  })

  it('writes each row of the movement-reason table', function () {
    const runner1 = single(game())
    const cases: Array<[string, GameState, string]> = [
      // Out, forced: the lead runner of a ground ball.
      [
        'r_force_out',
        after(runner1, close, ...groundBall, out(1, '2B', [F.SS, F['2B']])),
        '1 r_force_out field_out'
      ],
      [
        'r_caught_stealing_2b',
        after(runner1, close, running('caught_stealing')),
        '1 r_caught_stealing_2b caught_stealing_2b'
      ],
      [
        'r_pickoff_caught_stealing_2b',
        after(runner1, close, out(1, '2B', [F.C, F.SS], 'Picked Off')),
        '1 r_pickoff_caught_stealing_2b pickoff_caught_stealing_2b'
      ],
      [
        'r_pickoff_1b',
        after(runner1, close, running('pickoff')),
        '1 r_pickoff_1b pickoff_1b'
      ],
      [
        'r_doubled_off',
        after(
          runner1,
          close,
          ...flyBall,
          out(1, '1B', [F.CF, F['1B']], 'Ball Caught')
        ),
        '1 r_doubled_off field_out'
      ],
      [
        'r_interference',
        after(runner1, close, out(1, '2B', [F.SS], 'Offensive Interference')),
        '1 r_interference other_out'
      ],
      [
        'r_out_appeal',
        after(runner1, close, out(1, '1B', [F['1B']], 'Out on Appeal')),
        '1 r_out_appeal other_out'
      ],
      [
        'r_out_returning',
        after(
          runner1,
          close,
          ...flyBall,
          out(1, '1B', [F.CF, F['1B']], 'Back')
        ),
        '1 r_out_returning field_out'
      ],
      [
        'r_thrown_out',
        after(runner1, close, ...hit('single'), out(1, '3B', [F.CF, F['3B']])),
        '1 r_thrown_out single'
      ],
      [
        'r_adv_force',
        after(runner1, close, ball, ball, ball, ball),
        '1 r_adv_force walk'
      ],
      [
        'r_stolen_base_2b',
        after(runner1, close, running('steal')),
        '1 r_stolen_base_2b stolen_base_2b'
      ],
      [
        'r_adv_throw',
        after(
          runner1,
          close,
          ...hit('double'),
          out(1, 'home', [F.CF, F.C]),
          move(2, '3B')
        ),
        '2 r_adv_throw double'
      ],
      [
        'r_adv_play',
        after(runner1, close, ball, {
          type: 'batteryEvent',
          kind: 'wild_pitch',
          advances: [{ runner: 1, to: '2B' }]
        }),
        '1 r_adv_play wild_pitch'
      ]
    ]
    for (const [row, state, expected] of cases) {
      const play = stored(state)
      expect(reasons(play), row).to.include(expected)
      expect(MOVEMENT_REASONS.has(row), row).equals(true)
    }
  })

  it('names the action that moved a runner between pitches', function () {
    const runner1 = after(single(game()), close)
    const onThird = after(runner1, running('steal'), running('steal'))
    const cases: Array<[GameState, string]> = [
      [
        after(runner1, ball, {
          type: 'batteryEvent',
          kind: 'passed_ball',
          advances: [{ runner: 1, to: '2B' }]
        }),
        '1 r_adv_play passed_ball'
      ],
      [
        after(runner1, { type: 'batteryEvent', kind: 'balk' }),
        '1 r_adv_play balk'
      ],
      [
        after(runner1, running('defensive_indifference')),
        '1 r_adv_play defensive_indiff'
      ],
      [
        after(runner1, move(1, '2B', { reason: 'Throwing Error' })),
        '1 r_adv_play error'
      ],
      [after(runner1, move(1, '2B')), '1 r_adv_play other_advance'],
      [after(runner1, out(1, '2B', [F.C, F.SS])), '1 r_thrown_out other_out'],
      [after(runner1, running('pickoff_safe')), '1 r_adv_play pickoff_1b'],
      [
        after(onThird, running('steal')),
        '1 r_stolen_base_home stolen_base_home'
      ],
      [
        after(
          onThird,
          move(1, 'home', {
            out: true,
            fielders: [F.C],
            reason: 'Caught Stealing'
          })
        ),
        '1 r_caught_stealing_home caught_stealing_home'
      ]
    ]
    for (const [state, expected] of cases)
      expect(reasons(stored(state))).to.include(expected)

    // A runner who tags up on a fly out advances on the play, not a throw.
    const tagged = after(
      after(single(game()), close, running('steal'), running('steal')),
      ...flyBall,
      move(1, 'home')
    )
    expect(reasons(stored(tagged)).slice(-2)).deep.equals([
      'batter null field_out',
      '1 r_adv_play field_out'
    ])

    // A run on an overthrow during a hit is the error's, on the hit's pitch.
    const overthrow = runnersOf(
      stored(
        after(
          runner1,
          ...hit('single'),
          move(1, 'home', { reason: 'Throwing Error' })
        )
      )
    ).find(r => r.movement.end === 'score')!
    expect(overthrow.details).includes({
      eventType: 'error',
      movementReason: 'r_adv_play',
      playIndex: 0,
      rbi: false,
      earned: false
    })

    const placed = after(game(), {
      type: 'gameFlow',
      kind: 'placeRunner',
      runner: 9,
      base: '2B'
    })
    const [entry] = runnersOf(stored(placed))
    expect(entry.movement).deep.includes({
      originBase: null,
      start: null,
      end: '2B'
    })
    expect(entry.details).includes({
      movementReason: 'r_adv_play',
      eventType: 'runner_placed',
      playIndex: 0
    })
  })

  it('holds a run a third-out force took back on the base he left', function () {
    const state = after(
      single(game()),
      close,
      ...hit('double'),
      move(1, 'home')
    )
    const play = state.liveData.plays.currentPlay!
    // What a forced third out leaves on the engine's entry of the run.
    const run = play.runners.find(r => r.movement.end === 4)!
    run.movement.runScored = false
    run.details.rbi = false
    run.details.earned = false
    const doc = documentOf(state, play, {
      setupBefore: setupOf(state),
      actions: []
    })
    const held = runnersOf(doc).find(r => r.movement.start === '3B')!
    expect(held.movement).deep.includes({
      originBase: '1B',
      end: '3B',
      isOut: false
    })
    expect(held.details).includes({
      isScoringEvent: false,
      rbi: false,
      responsiblePitcher: null
    })
    expect(doc.about.isScoringPlay).equals(false)
  })

  it('charges the scoring runners and the batter who walked to a pitcher, by user id', function () {
    let state = walk(rostered())
    const walked = runnersOf(stored(state, true))
    expect(walked[0].details.responsiblePitcher).deep.equals({ id: 201 })
    state = after(state, ...hit('double'), move(1, 'home'))
    const runners = runnersOf(stored(state))
    const scorer = runners.find(r => r.movement.end === 'score')!
    expect(scorer.details).deep.includes({
      responsiblePitcher: { id: 201 },
      isScoringEvent: true,
      earned: true,
      teamUnearned: false,
      rbi: true
    })
    const batter = runners.find(r => r.movement.start === null)!
    expect(batter.details.responsiblePitcher).equals(null)
  })

  it('writes a credit position from MLB list, and none for a fielder without one', function () {
    const state = after(
      rostered(),
      ...groundBall,
      out(1, '1B', [F.SS, F['1B']])
    )
    const play = stored(state)
    const [batter] = runnersOf(play)
    expect(batter.credits.map(c => c.position)).deep.equals([
      { code: '6', name: 'Shortstop', type: 'Infielder', abbreviation: 'SS' },
      { code: '3', name: 'First Base', type: 'Infielder', abbreviation: '1B' }
    ])
    const engine = state.liveData.plays.currentPlay!
    engine.runners[0].credits[0].position = ''
    const blank = runnersOf(
      documentOf(state, engine, { setupBefore: setupOf(state), actions: [] })
    )[0]
    expect(blank.credits[0]).not.to.have.property('position')
    expect(blank.credits[0]).deep.equals({
      player: { id: 205, fullName: 'Home 5' },
      credit: 'f_assist'
    })
  })

  it('writes an award only for the batter and the runners it forced', function () {
    const onSecond = after(game(), ...hit('double'), close)
    const award = (
      state: GameState,
      eventType: 'catcher_interference' | 'hit_by_pitch' | 'intent_walk'
    ): string[] => reasons(stored(after(state, { type: 'result', eventType })))
    expect(award(onSecond, 'catcher_interference')).deep.equals([
      'batter null catcher_interf'
    ])
    expect(award(onSecond, 'hit_by_pitch')).deep.equals([
      'batter null hit_by_pitch'
    ])
    // First and third: the runner on first is forced, the one on third is not.
    const corners = walk(after(game(), ...hit('triple'), close))
    expect(award(corners, 'intent_walk')).deep.equals([
      'batter null intent_walk',
      '2 r_adv_force intent_walk'
    ])
    expect(award(corners, 'catcher_interference')).deep.equals([
      'batter null catcher_interf',
      '2 r_adv_force catcher_interf'
    ])
  })

  it('writes the engine types MLB names otherwise as listed codes', function () {
    const ci = after(game(), {
      type: 'result',
      eventType: 'catcher_interference'
    })
    expect(stored(ci).result.eventType).equals('catcher_interf')
    expect(reasons(stored(ci))).deep.equals(['batter null catcher_interf'])
    const placed = after(game(), {
      type: 'result',
      eventType: 'manual_placement',
      base: '2B'
    })
    expect(stored(placed).result.eventType).equals('gs_manual_placement')
    // The batter's own other out is ours; a runner's between pitches is MLB's.
    const batterOut = after(
      game(),
      { type: 'result', eventType: 'other_out' },
      out(1, '1B', [F.C])
    )
    expect(stored(batterOut).result.eventType).equals('gs_batter_out')
    expect(reasons(stored(batterOut))).deep.equals([
      'batter null gs_batter_out'
    ])
    let third = after(single(game()), close)
    third = after(
      third,
      strike,
      strike,
      strike,
      close,
      strike,
      strike,
      strike,
      close
    )
    third = after(third, out(1, '2B', [F.C, F.SS]))
    const between = stored(third, true)
    expect(between.result.eventType).equals('other_out')
    expect(storedEventType('single')).equals('single')
    expect(STORED_EVENT_TYPES.has(stored(ci).result.eventType)).equals(true)
  })

  it('folds the at-bat in progress and the final play in the same shape', function () {
    const state = after(single(game()), close, running('steal'), ball)
    const current = currentDocumentOf(state, state.liveData.plays.currentPlay, {
      setupBefore: setupOf(state),
      actions: []
    })
    expect(
      (current.runners as StoredRunner[]).map(r => r.movement.end)
    ).deep.equals(['2B'])
    const final = finalDocumentOf(after(state, strike, strike, strike, close), {
      setupBefore: setupOf(state),
      actions: []
    })
    expect(final.result.eventType).equals('final_score')
  })
})

interface FeedRunner {
  movement: Record<string, unknown>
  details: Record<string, unknown>
  credits: Array<
    { position: Record<string, unknown> } & Record<string, unknown>
  >
}
function typeOf(value: unknown): string {
  return value === null ? 'null' : typeof value
}
/** Each key's value types across a list of objects. */
function shapes(
  objects: Array<Record<string, unknown>>
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const object of objects)
    for (const [key, value] of Object.entries(object)) {
      const types = out.get(key) ?? new Set<string>()
      types.add(typeOf(value))
      out.set(key, types)
    }
  return out
}

describe('the stored runner matches the live feed (U9)', function () {
  it('has the feed runner keys and value types, and only listed reasons', function () {
    const feed = JSON.parse(
      readFileSync('src2/common/gumbo/reference/feed776258.json', 'utf8')
    ) as { liveData: { plays: { allPlays: Array<{ runners: FeedRunner[] }> } } }
    const feedRunners = feed.liveData.plays.allPlays.flatMap(p => p.runners)
    const want = {
      movement: shapes(feedRunners.map(r => r.movement)),
      details: shapes(feedRunners.map(r => r.details)),
      credit: shapes(feedRunners.flatMap(r => r.credits)),
      position: shapes(feedRunners.flatMap(r => r.credits.map(c => c.position)))
    }
    let state = rostered()
    const plays: GumboPlay[] = []
    const keep = (): void => {
      plays.push(stored(state, true))
    }
    state = walk(state)
    keep()
    state = after(
      state,
      running('steal'),
      ...hit('double'),
      move(1, 'home'),
      close
    )
    keep()
    state = after(
      state,
      ...groundBall,
      out(2, '3B', [F.SS, F['3B']]),
      out(3, '1B', [F['3B'], F['1B']]),
      close
    )
    keep()
    state = after(state, ...flyBall, close)
    keep()
    const ours = plays.flatMap(runnersOf)
    expect(ours.length).greaterThan(5)
    for (const runner of ours) {
      for (const [part, got] of [
        ['movement', runner.movement],
        ['details', runner.details]
      ] as const) {
        expect(Object.keys(got).sort(), part).deep.equals(
          [...want[part].keys()].sort()
        )
        for (const [key, value] of Object.entries(got))
          expect(want[part].get(key), `${part}.${key}`).to.include(
            typeOf(value)
          )
      }
      for (const credit of runner.credits) {
        expect(Object.keys(credit).sort()).deep.equals(
          [...want.credit.keys()].sort()
        )
        const position = credit.position as Record<string, unknown>
        expect(Object.keys(position).sort()).deep.equals(
          [...want.position.keys()].sort()
        )
        for (const value of Object.values(position)) expect(value).a('string')
      }
      const reason = runner.details.movementReason
      if (reason !== null) {
        expect(reason).a('string')
        expect(MOVEMENT_REASONS.has(reason as string), reason as string).equals(
          true
        )
      }
    }
    expect(ours.some(r => r.movement.end === 'score')).equals(true)
    expect(ours.some(r => r.credits.length > 0)).equals(true)
  })
})
