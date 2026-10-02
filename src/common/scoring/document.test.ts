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
  strikeout,
  TEAMS,
  walk
} from '../../test/scoringGames'
import {
  HIT_TRAJECTORIES,
  mlbEventName,
  MOVEMENT_REASONS,
  POSITION_CODES,
  STORED_EVENT_TYPES
} from '../gumbo/reference'
import type { GumboPlay } from '../gumboPlay'
import { type ScoringAction, TRAJECTORIES } from './actions'
import { applyAction } from './apply'
import {
  currentDocumentOf,
  distanceFeet,
  documentOf,
  FEET_PER_SPRAY_UNIT,
  feetPerUnit,
  finalDocumentOf,
  PlayFolder,
  SPRAY_HOME,
  sprayCoordinates,
  storedEventType
} from './document'
import { freshGame, newSetup } from './lineup'
import { PARK } from './park'
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
      // Unforced 2→3 is automatic on the single; the scorer then sends him home.
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
      readFileSync('src/common/gumbo/reference/feed776258.json', 'utf8')
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

interface StoredEvent {
  index: number
  pitchNumber?: number
  isPitch: boolean
  isBaseRunningPlay?: boolean
  details: Record<string, unknown>
  count: { balls: number; strikes: number; outs: number }
  player?: { id?: number; fullName: string }
}
function eventsOf(play: GumboPlay): StoredEvent[] {
  return (play.playEvents ?? []) as unknown as StoredEvent[]
}
const pitchCall = (call: 'B' | 'C' | 'S' | 'F' | 'T' | 'L'): ScoringAction => ({
  type: 'pitch',
  call
})
const counts = (play: GumboPlay): string[] =>
  eventsOf(play)
    .filter(event => event.isPitch)
    .map(event => `${event.count.balls}-${event.count.strikes}`)
const codes = (play: GumboPlay): string[] =>
  eventsOf(play)
    .filter(event => event.isPitch)
    .map(event => String(event.details.code))
/** The keys of a pitch's details the plan writes, from any pitch event. */
const PITCH_DETAILS = [
  'call',
  'code',
  'description',
  'isInPlay',
  'isStrike',
  'isBall',
  'isOut',
  'hasReview'
]
function pitchDetails(
  details: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(PITCH_DETAILS.map(key => [key, details[key]]))
}

describe('pitch events (U12)', function () {
  it("writes the feed's first plate appearance: each call's details and the count it left", function () {
    const feed = JSON.parse(
      readFileSync('src/common/gumbo/reference/feed776258.json', 'utf8')
    ) as {
      liveData: {
        plays: {
          allPlays: Array<{
            playEvents: Array<{
              isPitch: boolean
              details: Record<string, unknown>
              count: unknown
            }>
          }>
        }
      }
    }
    const feedPitches = feed.liveData.plays.allPlays[0].playEvents.filter(
      event => event.isPitch
    )
    // Ball, ball, ball, called strike, swinging strike, popped out.
    const state = after(
      game(),
      ball,
      ball,
      ball,
      strike,
      pitchCall('S'),
      { type: 'ballInPlay', contact: 'swing', fielder: F['3B'] },
      { type: 'result', eventType: 'field_out', outBy: 'catch' },
      close
    )
    const play = stored(state, true)
    const pitches = eventsOf(play).filter(event => event.isPitch)
    expect(counts(play)).deep.equals(['1-0', '2-0', '3-0', '3-1', '3-2', '3-2'])
    expect(pitches.map(event => event.count)).deep.equals(
      feedPitches.map(event => event.count)
    )
    expect(pitches.map(event => pitchDetails(event.details))).deep.equals(
      feedPitches.map(event => pitchDetails(event.details))
    )
    expect(pitches.map(event => event.pitchNumber)).deep.equals([
      1, 2, 3, 4, 5, 6
    ])
    expect(Object.keys(pitches[0]).sort()).deep.equals([
      'count',
      'details',
      'endTime',
      'index',
      'isPitch',
      'pitchNumber',
      'player',
      'startTime',
      'type'
    ])
    // As in the feed, the play is its pitches alone: the batter's out is on
    // the in-play pitch, with no action of its own.
    expect(play).deep.include({
      pitchIndex: [0, 1, 2, 3, 4, 5],
      actionIndex: [],
      runnerIndex: [0]
    })
    expect(runnersOf(play)[0].details.playIndex).equals(5)
    expect(play.count).deep.equals({ balls: 3, strikes: 2, outs: 1 })
  })

  it('codes each call, a hit batsman as H and a dropped third strike as a strike', function () {
    const struckOut = stored(
      after(
        game(),
        ball,
        pitchCall('F'),
        pitchCall('L'),
        pitchCall('F'),
        ball,
        pitchCall('T')
      )
    )
    expect(codes(struckOut)).deep.equals(['B', 'F', 'L', 'F', 'B', 'T'])
    expect(counts(struckOut)).deep.equals([
      '1-0',
      '1-1',
      '1-2',
      '1-2',
      '2-2',
      '2-3'
    ])
    const details = eventsOf(struckOut).map(event => event.details)
    expect(details.map(d => d.isStrike)).deep.equals([
      false,
      true,
      true,
      true,
      false,
      true
    ])
    expect(details.map(d => d.isBall)).deep.equals([
      true,
      false,
      false,
      false,
      true,
      false
    ])
    // Strike three is the pitch that made the out; the outs are the ones
    // before the play.
    expect(details.map(d => d.isOut)).deep.equals([
      false,
      false,
      false,
      false,
      false,
      true
    ])
    expect(eventsOf(struckOut).at(-1)!.count.outs).equals(0)
    expect(
      details.map(d => (d.call as { description: string }).description)
    ).deep.equals(['Ball', 'Foul', 'Foul Bunt', 'Foul', 'Ball', 'Foul Tip'])

    const hit = stored(
      after(game(), strike, pitchCall('S'), {
        type: 'result',
        eventType: 'hit_by_pitch'
      })
    )
    expect(codes(hit)).deep.equals(['C', 'S', 'H'])
    // A hit batsman leaves the count where it was.
    expect(counts(hit)).deep.equals(['0-1', '0-2', '0-2'])
    expect(pitchDetails(eventsOf(hit)[2].details)).deep.equals({
      call: { code: 'H', description: 'Hit By Pitch' },
      code: 'H',
      description: 'Hit By Pitch',
      isInPlay: false,
      isStrike: false,
      isBall: true,
      isOut: false,
      hasReview: false
    })

    const dropped = stored(
      after(
        game(),
        strike,
        strike,
        { type: 'result', eventType: 'strikeout' },
        move(1, '1B'),
        close
      ),
      true
    )
    expect(dropped.result.eventType).equals('strikeout')
    expect(codes(dropped)).deep.equals(['C', 'C', 'S'])
    expect(counts(dropped)).deep.equals(['0-1', '0-2', '0-3'])
    expect(eventsOf(dropped)[2].details).deep.include({
      isInPlay: false,
      isStrike: true,
      isOut: false
    })
    expect(runnersOf(dropped)[0].movement).deep.include({
      start: null,
      end: '1B',
      isOut: false
    })
  })

  it('codes the in-play pitch E on a sacrifice fly, X on a ground-ball double play and D on a single', function () {
    const onThird = after(game(), ...hit('triple'), close)
    const sacFly = stored(
      after(onThird, ...flyBall, move(1, 'home'), close),
      true
    )
    expect(sacFly.result.eventType).equals('sac_fly')
    expect(eventsOf(sacFly)[0].details).deep.include({
      call: { code: 'E', description: 'In play, run(s)' },
      code: 'E',
      isInPlay: true,
      isOut: true
    })
    const gidp = stored(
      after(
        single(game()),
        close,
        ...groundBall,
        out(1, '2B', [F.SS, F['2B']]),
        out(2, '1B', [F['2B'], F['1B']]),
        close
      ),
      true
    )
    expect(gidp.result.eventType).equals('grounded_into_double_play')
    expect(eventsOf(gidp)[0].details).deep.include({
      code: 'X',
      description: 'In play, out(s)',
      isOut: true
    })
    const hitSafely = stored(single(game()))
    expect(eventsOf(hitSafely)[0].details).deep.include({
      code: 'D',
      description: 'In play, no out',
      isOut: false,
      isStrike: false,
      isBall: false
    })
    // The in-play pitch keeps the count it was thrown in.
    expect(
      counts(stored(after(game(), ball, strike, ...hit('single'))))
    ).deep.equals(['1-0', '1-1', '1-1'])
  })
})

describe('action events (U12)', function () {
  interface ActionCase {
    name: string
    state: GameState
    eventType: string
    description: string
    isBaseRunningPlay: boolean
    isScoringPlay?: boolean
    isOut?: boolean
    /** The visitors' score after it; the home side never scores here. */
    awayScore?: number
    /** The player it names, when the case checks it. */
    player?: { id: number; fullName: string }
  }

  it('writes each action with its event type and a sentence', function () {
    const onFirst = after(rostered(), ...hit('single'), close)
    const onThird = after(onFirst, running('steal'), running('steal'))
    const batteryEvent = (
      kind: 'wild_pitch' | 'passed_ball'
    ): ScoringAction => ({
      type: 'batteryEvent',
      kind,
      advances: [{ runner: 1, to: '2B' }]
    })
    const cases: ActionCase[] = [
      {
        name: 'balk',
        state: after(onThird, { type: 'batteryEvent', kind: 'balk' }),
        eventType: 'balk',
        description: 'Balk by Home 1. Away 1 scores.',
        isBaseRunningPlay: true,
        isScoringPlay: true,
        awayScore: 1
      },
      {
        name: 'wild pitch',
        state: after(onFirst, ball, batteryEvent('wild_pitch')),
        eventType: 'wild_pitch',
        description: 'Wild pitch by Home 1. Away 1 to 2nd.',
        isBaseRunningPlay: true
      },
      {
        name: 'passed ball',
        state: after(onFirst, ball, batteryEvent('passed_ball')),
        eventType: 'passed_ball',
        description: 'Passed ball. Away 1 to 2nd.',
        isBaseRunningPlay: true
      },
      {
        name: 'steal',
        state: after(onFirst, running('steal')),
        eventType: 'stolen_base_2b',
        description: 'Away 1 steals second.',
        isBaseRunningPlay: true
      },
      {
        name: 'caught stealing',
        state: after(onFirst, running('caught_stealing')),
        eventType: 'caught_stealing_2b',
        description: 'Caught stealing second, Away 1.',
        isBaseRunningPlay: true,
        isOut: true
      },
      {
        name: 'pickoff',
        state: after(onFirst, running('pickoff')),
        eventType: 'pickoff_1b',
        description: 'Pickoff at first, Away 1.',
        isBaseRunningPlay: true,
        isOut: true
      },
      {
        name: 'defensive indifference',
        state: after(onFirst, running('defensive_indifference')),
        eventType: 'defensive_indiff',
        description: 'Defensive indifference, Away 1 to 2nd.',
        isBaseRunningPlay: true
      },
      {
        name: 'runner sent on',
        state: after(onFirst, move(1, '2B')),
        eventType: 'other_advance',
        description: 'Runner advance, Away 1 to 2nd.',
        isBaseRunningPlay: true
      },
      {
        name: 'intentional walk',
        state: after(onFirst, { type: 'result', eventType: 'intent_walk' }),
        eventType: 'intent_walk',
        description: 'Away 2 is walked intentionally. Away 1 to 2nd.',
        isBaseRunningPlay: false
      },
      {
        name: 'intentional walk with nobody forced',
        state: after(onFirst, running('steal'), {
          type: 'result',
          eventType: 'intent_walk'
        }),
        eventType: 'intent_walk',
        description: 'Away 2 is walked intentionally.',
        isBaseRunningPlay: false
      },
      {
        name: 'pickoff attempt',
        state: after(onFirst, running('pickoff_safe')),
        eventType: 'pickoff_1b',
        description: 'Pickoff at first, Away 1 stays at 1st.',
        isBaseRunningPlay: true
      },
      {
        name: "catcher's interference",
        state: after(rostered(), {
          type: 'result',
          eventType: 'catcher_interference'
        }),
        eventType: 'catcher_interf',
        description: "Away 1 reaches on catcher's interference.",
        isBaseRunningPlay: false
      },
      {
        name: 'manual placement',
        state: after(rostered(), {
          type: 'result',
          eventType: 'manual_placement',
          base: '2B'
        }),
        eventType: 'gs_manual_placement',
        description: 'Away 1 is placed on base.',
        isBaseRunningPlay: false
      },
      {
        name: 'batter out, other',
        state: after(
          rostered(),
          { type: 'result', eventType: 'other_out' },
          out(1, 'batter', [F.C])
        ),
        eventType: 'gs_batter_out',
        description: 'Out, Away 1.',
        isBaseRunningPlay: false,
        isOut: true
      },
      {
        name: 'placed runner',
        state: after(rostered(), {
          type: 'gameFlow',
          kind: 'placeRunner',
          runner: 9,
          base: '2B'
        }),
        eventType: 'runner_placed',
        description: 'Away 9 is placed on base.',
        isBaseRunningPlay: false,
        // The runner placed, not the pitcher.
        player: { id: 109, fullName: 'Away 9' }
      }
    ]
    for (const expected of cases) {
      const actions = eventsOf(stored(expected.state)).filter(
        event => !event.isPitch
      )
      const event = actions.at(-1)!
      expect(event, expected.name).deep.include({
        isPitch: false,
        type: 'action',
        startTime: null,
        endTime: null
      })
      // As the feed writes it: on the event, and only when true.
      expect(event.isBaseRunningPlay, expected.name).equals(
        expected.isBaseRunningPlay ? true : undefined
      )
      expect(event.details, expected.name).deep.equals({
        description: expected.description,
        event: mlbEventName(expected.eventType),
        eventType: expected.eventType,
        awayScore: expected.awayScore ?? 0,
        homeScore: 0,
        isScoringPlay: expected.isScoringPlay ?? false,
        isOut: expected.isOut ?? false,
        hasReview: false
      })
      expect(STORED_EVENT_TYPES.has(expected.eventType), expected.name).equals(
        true
      )
      if (expected.player != null)
        expect(event.player, expected.name).deep.equals(expected.player)
    }
  })

  it('writes a wild pitch or passed ball that moves two runners as one event, with both runners on it', function () {
    // Away 1 on second and Away 2 on first.
    const twoOn = walk(walk(rostered()))
    for (const kind of ['wild_pitch', 'passed_ball'] as const) {
      const play = stored(
        after(twoOn, ball, {
          type: 'batteryEvent',
          kind,
          advances: [
            { runner: 1, to: '3B' },
            { runner: 2, to: '2B' }
          ]
        })
      )
      const lead =
        kind === 'wild_pitch' ? 'Wild pitch by Home 1.' : 'Passed ball.'
      expect(
        eventsOf(play)
          .filter(event => !event.isPitch)
          .map(event => [event.index, event.details.eventType])
      ).deep.equals([[1, kind]])
      expect(eventsOf(play)[1].details.description).equals(
        `${lead} Away 1 to 3rd. Away 2 to 2nd.`
      )
      expect(
        runnersOf(play).map(runner => [
          runner.details.runner.fullName,
          runner.details.eventType,
          runner.details.playIndex
        ])
      ).deep.equals([
        ['Away 1', kind, 1],
        ['Away 2', kind, 1]
      ])
      expect(play).deep.include({ actionIndex: [1], runnerIndex: [0, 1] })
    }
  })

  it('names the pitcher who threw the wild pitch or balked, not one who relieved him later in the plate appearance', function () {
    const relieved = after(
      walk(rostered()),
      ball,
      {
        type: 'batteryEvent',
        kind: 'wild_pitch',
        advances: [{ runner: 1, to: '2B' }]
      },
      ball,
      { type: 'batteryEvent', kind: 'balk' },
      {
        type: 'lineup',
        kind: 'position',
        side: 'home',
        position: 'P',
        player: F.SS
      },
      {
        type: 'lineup',
        kind: 'position',
        side: 'home',
        position: 'SS',
        player: F.P
      },
      strike
    )
    const play = stored(relieved)
    expect(
      eventsOf(play)
        .filter(
          event =>
            event.details.eventType === 'wild_pitch' ||
            event.details.eventType === 'balk'
        )
        .map(event => event.details.description)
    ).deep.equals([
      'Wild pitch by Home 1. Away 1 to 2nd.',
      'Balk by Home 1. Away 1 to 3rd.'
    ])
    expect(play.matchup).not.deep.include({
      pitcher: { id: 201, fullName: 'Home 1' }
    })
  })

  it('writes no action for a runner the ball in play moved: his entry is on the in-play pitch', function () {
    const onFirst = after(rostered(), ball, ...hit('single'), close)
    const plays = [
      after(onFirst, ball, ...hit('double'), move(1, 'home'), close),
      after(
        onFirst,
        ball,
        ...groundBall,
        out(1, '2B', [F.SS, F['2B']]),
        out(2, 'batter', [F['2B'], F['1B']]),
        close
      ),
      after(onFirst, ball, ...flyBall, close),
      // An action between pitches keeps its event, and the ones after it
      // keep their places.
      after(
        onFirst,
        running('steal'),
        ball,
        ...hit('single'),
        move(1, 'home'),
        close
      )
    ].map(state => stored(state, true))
    expect(
      plays.map(play => [
        eventsOf(play).map(event =>
          event.isPitch
            ? String((event.details.call as { code: string }).code)
            : String(event.details.eventType)
        ),
        runnersOf(play).map(runner => runner.details.playIndex)
      ])
    ).deep.equals([
      [
        ['B', 'E'],
        [1, 1, 1]
      ],
      [
        ['B', 'X'],
        [1, 1]
      ],
      [['B', 'X'], [1]],
      [
        ['stolen_base_2b', 'B', 'E'],
        [0, 2, 2, 2]
      ]
    ])
    for (const play of plays) {
      expect(eventsOf(play).map(event => event.index)).deep.equals(
        eventsOf(play).map((event, i) => i)
      )
    }
    expect(plays[3]).deep.include({ pitchIndex: [1, 2], actionIndex: [0] })
  })

  it("has the feed's action keys and value types", function () {
    const feed = JSON.parse(
      readFileSync('src/common/gumbo/reference/feed776258.json', 'utf8')
    ) as {
      liveData: {
        plays: { allPlays: Array<{ playEvents: StoredEvent[] }> }
      }
    }
    // The feed's wild pitch, at-bat 6: a base-running action.
    const want = feed.liveData.plays.allPlays[6].playEvents.find(
      event => event.details.eventType === 'wild_pitch'
    )!
    const onFirst = after(rostered(), ...hit('single'), close)
    const got = eventsOf(
      stored(
        after(onFirst, ball, {
          type: 'batteryEvent',
          kind: 'wild_pitch',
          advances: [{ runner: 1, to: '2B' }]
        })
      )
    ).at(-1)!
    // actionPlayId is MLB's own id for the action, which GameStation has none of.
    const { actionPlayId, ...feedEvent } = want as StoredEvent & {
      actionPlayId?: string
    }
    expect(actionPlayId).a('string')
    expect(Object.keys(got).sort()).deep.equals(Object.keys(feedEvent).sort())
    expect(Object.keys(got.details)).deep.equals(Object.keys(want.details))
    for (const key of Object.keys(want.details))
      expect(typeOf(got.details[key]), key).equals(typeOf(want.details[key]))
    expect(got.isBaseRunningPlay).equals(true)
  })

  it('writes the score after each action, run by run', function () {
    // Away 1 on third and Away 2 on first; Away 3 bats.
    const cornered = after(
      rostered(),
      ...hit('single'),
      close,
      ...hit('single'),
      move(1, '3B'),
      close
    )
    const state = after(
      cornered,
      ball,
      {
        type: 'batteryEvent',
        kind: 'wild_pitch',
        advances: [{ runner: 1, to: 'home' }]
      },
      running('steal', 2),
      ...hit('single'),
      move(2, 'home'),
      close
    )
    const play = stored(state, true)
    expect(play.result).deep.include({ awayScore: 2, homeScore: 0 })
    const scores = eventsOf(play)
      .filter(event => !event.isPitch)
      .map(event => [
        String(event.details.eventType),
        event.details.awayScore,
        event.details.homeScore,
        event.details.isScoringPlay
      ])
    // The run on the single is on its in-play pitch, which has no score.
    expect(scores).deep.equals([
      ['wild_pitch', 1, 0, true],
      ['stolen_base_2b', 1, 0, false]
    ])
  })

  it('carries pitchIndex, actionIndex and runnerIndex on every play', function () {
    const state = after(
      single(game()),
      close,
      ball,
      running('steal'),
      strike,
      ...hit('single'),
      // Steal, auto-advanced runner on the single, and the batter.
      close,
      { type: 'gameFlow', kind: 'endGame' }
    )
    const stamp = { setupBefore: setupOf(state), actions: [] }
    const second = documentOf(state, state.liveData.plays.allPlays[1], stamp)
    expect(second).deep.include({
      pitchIndex: [0, 2, 3],
      actionIndex: [1],
      runnerIndex: [0, 1, 2]
    })
    expect(finalDocumentOf(state, stamp)).deep.include({
      pitchIndex: [],
      actionIndex: [],
      runnerIndex: []
    })
    const open = stored(after(game(), ball))
    expect(open).deep.include({
      pitchIndex: [0],
      actionIndex: [],
      runnerIndex: []
    })
  })
})

describe('hit data (U17)', function () {
  type BallInPlay = Extract<ScoringAction, { type: 'ballInPlay' }>
  const batted = (
    ballInPlay: Omit<BallInPlay, 'type' | 'contact'> & {
      contact?: BallInPlay['contact']
    },
    eventType: 'single' | 'field_out' | 'home_run' = 'single',
    fenceDistanceFt?: number
  ): GumboPlay =>
    stored(
      after(
        fenceDistanceFt == null
          ? game()
          : freshGame(
              'g1',
              TEAMS,
              newSetup(TEAMS, { away: [], home: [] }),
              fenceDistanceFt
            ),
        ball,
        { type: 'ballInPlay', contact: 'swing', ...ballInPlay },
        {
          type: 'result',
          eventType,
          ...(eventType === 'field_out' ? { outBy: 'catch' as const } : {})
        },
        close
      ),
      true
    )
  const hitDataOf = (play: GumboPlay): Record<string, unknown> | undefined =>
    (
      eventsOf(play).find(event => event.details.isInPlay === true) as
        { hitData?: Record<string, unknown> } | undefined
    )?.hitData
  const detailOf = (play: GumboPlay): Record<string, unknown> =>
    (play.gameStation as { detail: Record<string, unknown> }).detail
  /** Every key anywhere in the stored play outside its record. */
  const keysOf = (value: unknown): string[] =>
    value == null || typeof value !== 'object'
      ? []
      : Object.entries(value).flatMap(([key, item]) =>
          key === 'gameStation' ? [] : [key, ...keysOf(item)]
        )

  it('sits on the in-play pitch, not on the play', function () {
    const play = batted({
      trajectory: 'line_drive',
      location: { x: 10, z: -60 },
      fielder: F.CF
    })
    expect(play).not.have.property('hitData')
    const [pitch, inPlay] = eventsOf(play) as Array<
      StoredEvent & { hitData?: unknown }
    >
    expect(pitch).not.have.property('hitData')
    expect(inPlay.details.isInPlay).equals(true)
    // 60.8 units out on a 200-foot field, where the fence is 118 units.
    expect(inPlay.hitData).deep.equals({
      totalDistance: 103,
      trajectory: 'line_drive',
      location: '8',
      coordinates: sprayCoordinates({ x: 10, z: -60 })
    })
    // The pitch keeps its own keys, with the hit data after its count.
    expect(Object.keys(inPlay)).deep.equals([
      'index',
      'pitchNumber',
      'isPitch',
      'type',
      'details',
      'count',
      'hitData',
      'player',
      'startTime',
      'endTime'
    ])
    // The ball in play of the at-bat still being decided carries it too.
    const pending = stored(
      after(game(), {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'fly_ball',
        fielder: F.LF
      })
    )
    expect(hitDataOf(pending)).deep.equals({
      trajectory: 'fly_ball',
      location: '7'
    })
  })

  it('has the keys of the feed hit data we can know, with the same value types', function () {
    const feed = JSON.parse(
      readFileSync('src/common/gumbo/reference/feed776258.json', 'utf8')
    ) as {
      liveData: {
        plays: {
          allPlays: Array<{ playEvents: Array<{ hitData?: object }> }>
        }
      }
    }
    const feedHits = feed.liveData.plays.allPlays.flatMap(play =>
      play.playEvents.flatMap(event =>
        event.hitData == null ? [] : [event.hitData]
      )
    ) as Array<Record<string, unknown>>
    expect(feedHits.length).greaterThan(0)
    const ours = hitDataOf(
      batted({
        launchAngle: -5,
        launchAngleDragged: true,
        location: { x: -12, z: -30 },
        fielder: F.SS
      })
    )!
    // What a scorer cannot know: the speed off the bat and how hard it was
    // hit. The launch angle is his, set on the field, and how far the ball
    // went is where he put it on a field of the game's size.
    const unknown = ['hardness', 'launchSpeed']
    const typeOf = (value: unknown): string =>
      value == null || typeof value !== 'object'
        ? typeof value
        : JSON.stringify(
            Object.fromEntries(
              Object.entries(value).map(([key, item]) => [key, typeof item])
            )
          )
    for (const hit of feedHits) {
      expect(Object.keys(hit).sort()).deep.equals(
        [...Object.keys(ours), ...unknown].sort()
      )
      for (const key of Object.keys(ours))
        expect(typeOf(ours[key]), key).equals(typeOf(hit[key]))
    }
    expect(HIT_TRAJECTORIES.has(String(ours.trajectory))).equals(true)
    expect(POSITION_CODES.has(String(ours.location))).equals(true)
  })

  it("maps each of the scorer's trajectories to MLB's, bunts to their own", function () {
    const expected = {
      ground_ball: ['ground_ball', 'bunt_grounder'],
      line_drive: ['line_drive', 'bunt_line_drive'],
      fly_ball: ['fly_ball', 'bunt_popup'],
      popup: ['popup', 'bunt_popup'],
      chopper: ['ground_ball', 'bunt_grounder']
    }
    expect(Object.keys(expected)).deep.equals([...TRAJECTORIES])
    for (const trajectory of TRAJECTORIES)
      for (const [i, contact] of (['swing', 'bunt'] as const).entries()) {
        const play = batted({ contact, trajectory, fielder: F['3B'] })
        expect(hitDataOf(play), `${contact} ${trajectory}`).deep.equals({
          trajectory: expected[trajectory][i],
          location: '5'
        })
        expect(HIT_TRAJECTORIES.has(expected[trajectory][i])).equals(true)
        // The scorer's own pick stays in the record, chopper and all.
        expect(detailOf(play)).includes({ trajectory, contactKind: contact })
        expect(detailOf(play).launchAngle).a('number')
      }
    // The screen gives an angle, not a trajectory: the band it falls in, and
    // the angle itself, which the scorer set.
    const dragged = batted({
      launchAngle: -40,
      launchAngleDragged: true,
      location: { x: 3, z: -20 }
    })
    expect(hitDataOf(dragged)).deep.equals({
      launchAngle: -40,
      totalDistance: 34,
      trajectory: 'ground_ball',
      coordinates: sprayCoordinates({ x: 3, z: -20 })
    })
    expect(detailOf(dragged)).includes({
      trajectory: 'chopper',
      launchAngle: -40
    })
  })

  it('puts home plate and the fence at their places on the spray chart', function () {
    expect(sprayCoordinates({ x: 0, z: 0 })).deep.equals(SPRAY_HOME)
    expect(SPRAY_HOME).deep.equals({ coordX: 125, coordY: 204 })
    expect(PARK.outfieldRadius).equals(118)
    expect(FEET_PER_SPRAY_UNIT).equals(2.4)
    const pole = 118 * Math.SQRT1_2
    // A fence F feet out sits F / 2.4 units from home, the poles at 45°.
    for (const [fence, wall] of [
      [200, 83.33],
      [387, 161.25],
      [150, 62.5]
    ]) {
      expect(feetPerUnit(fence) * PARK.outfieldRadius).closeTo(fence, 1e-9)
      const round = (value: number): number => Math.round(value * 100) / 100
      const at45 = (fence * Math.SQRT1_2) / FEET_PER_SPRAY_UNIT
      expect(sprayCoordinates({ x: 0, z: -118 }, fence)).deep.equals({
        coordX: 125,
        coordY: round(204 - wall)
      })
      expect(sprayCoordinates({ x: pole, z: -pole }, fence)).deep.equals({
        coordX: round(125 + at45),
        coordY: round(204 - at45)
      })
      expect(sprayCoordinates({ x: -pole, z: -pole }, fence)).deep.equals({
        coordX: round(125 - at45),
        coordY: round(204 - at45)
      })
      expect(distanceFeet({ x: 0, z: -118 }, fence)).equals(fence)
      expect(distanceFeet({ x: pole, z: -pole }, fence)).equals(fence)
    }
    // Without a fence, the 200-foot default: centre at (125, 120.67), the
    // poles at (66.07, 145.07) and (183.93, 145.07).
    expect(sprayCoordinates({ x: 0, z: -118 })).deep.equals({
      coordX: 125,
      coordY: 120.67
    })
    expect(sprayCoordinates({ x: pole, z: -pole })).deep.equals({
      coordX: 183.93,
      coordY: 145.07
    })
    expect(sprayCoordinates({ x: -pole, z: -pole })).deep.equals({
      coordX: 66.07,
      coordY: 145.07
    })
    expect(distanceFeet({ x: 0, z: -59 })).equals(100)
    // A home run over the fence in straightaway centre, stored, went as far
    // as the fence.
    const homeRun = batted(
      {
        launchAngle: 30,
        launchAngleDragged: true,
        location: { x: 0, z: -118 }
      },
      'home_run'
    )
    expect(hitDataOf(homeRun)).deep.equals({
      launchAngle: 30,
      totalDistance: 200,
      trajectory: 'line_drive',
      coordinates: { coordX: 125, coordY: 120.67 }
    })
    // The same ball on a game played to a 250-foot fence.
    const overridden = batted(
      {
        launchAngle: 30,
        launchAngleDragged: true,
        location: { x: 0, z: -118 }
      },
      'home_run',
      250
    )
    expect(hitDataOf(overridden)).deep.equals({
      launchAngle: 30,
      totalDistance: 250,
      trajectory: 'line_drive',
      coordinates: { coordX: 125, coordY: 99.83 }
    })
    // Halfway to the fence down the right-field line, on that field.
    const halfway = batted(
      { location: { x: pole / 2, z: -pole / 2 }, fielder: F.RF },
      'single',
      250
    )
    expect(hitDataOf(halfway)).deep.include({
      totalDistance: 125,
      coordinates: sprayCoordinates({ x: pole / 2, z: -pole / 2 }, 250)
    })
    // A ball put down on the plate itself has no distance to write.
    expect(
      hitDataOf(batted({ location: { x: 0, z: -0.2 }, fielder: F.C }))
    ).deep.equals({
      location: '2',
      coordinates: sprayCoordinates({ x: 0, z: -0.2 })
    })
  })

  it('writes no coordinates when only a fielder was picked, and a launch angle only when the scorer set it', function () {
    const fielded = batted({ fielder: F.SS }, 'field_out')
    // Nowhere placed, so no distance either.
    expect(hitDataOf(fielded)).deep.equals({ location: '6' })
    expect(keysOf(fielded)).not.include('totalDistance')
    expect(detailOf(fielded)).not.have.property('trajectory')
    expect(detailOf(fielded)).not.have.property('launchAngle')
    // No ball in play said anything: no hit data at all.
    expect(hitDataOf(batted({}))).equals(undefined)
    const plays = [
      fielded,
      batted({ trajectory: 'popup', fielder: F.C }, 'field_out'),
      batted({
        launchAngle: 22,
        launchAngleDragged: true,
        location: { x: 30, z: -70 },
        fielder: F.RF
      }),
      batted({ contact: 'bunt', trajectory: 'chopper', fielder: F.P })
    ]
    for (const [i, play] of plays.entries()) {
      // Only the dragged angle is the scorer's; a trajectory's is estimated.
      if (i === 2) expect(keysOf(play)).include('launchAngle')
      else expect(keysOf(play)).not.include('launchAngle')
      expect(keysOf(play)).not.include('launchSpeed')
      expect(detailOf(play)).not.have.property('launchSpeed')
    }
    expect(detailOf(plays[2])).includes({
      launchAngle: 22,
      launchAngleSet: true
    })
    expect(detailOf(plays[1])).not.have.property('launchAngleSet')
    // A fractional drag is kept to a tenth of a degree.
    expect(
      hitDataOf(
        batted({ launchAngle: 22.46, launchAngleDragged: true, fielder: F.RF })
      )?.launchAngle
    ).equals(22.5)
  })

  it('writes the trajectory band each dragged angle falls in, at its edges', function () {
    const swing: Array<[number, string, string]> = [
      [90, 'popup', 'popup'],
      [48, 'popup', 'popup'],
      [47, 'fly_ball', 'fly_ball'],
      [47.4, 'fly_ball', 'fly_ball'],
      [35, 'fly_ball', 'fly_ball'],
      [34, 'line_drive', 'line_drive'],
      [10, 'line_drive', 'line_drive'],
      [9, 'ground_ball', 'ground_ball'],
      [-25, 'ground_ball', 'ground_ball'],
      // A chopper is the record's; MLB's list calls it a ground ball.
      [-26, 'chopper', 'ground_ball'],
      [-90, 'chopper', 'ground_ball']
    ]
    for (const [launchAngle, band, written] of swing) {
      const play = batted({
        launchAngle,
        launchAngleDragged: true,
        fielder: F.CF
      })
      expect(hitDataOf(play), String(launchAngle)).deep.include({
        launchAngle,
        trajectory: written
      })
      expect(detailOf(play), String(launchAngle)).includes({ trajectory: band })
    }
    // A bunt has MLB's bunt list: grounders, line drives and pop-ups.
    const bunts: Array<[number, string]> = [
      [60, 'bunt_popup'],
      [48, 'bunt_popup'],
      [35, 'bunt_popup'],
      [34, 'bunt_line_drive'],
      [10, 'bunt_line_drive'],
      [9, 'bunt_grounder'],
      [-26, 'bunt_grounder']
    ]
    for (const [launchAngle, written] of bunts)
      expect(
        hitDataOf(
          batted({
            contact: 'bunt',
            launchAngle,
            launchAngleDragged: true,
            fielder: F.P
          })
        ),
        String(launchAngle)
      ).deep.include({ launchAngle, trajectory: written })
  })

  it('writes no launch angle the scorer gave without dragging it', function () {
    // Dictation, or the screen's untouched default: an angle, but not dragged.
    for (const launchAngleDragged of [undefined, false]) {
      const play = batted({
        launchAngle: 45,
        ...(launchAngleDragged == null ? {} : { launchAngleDragged }),
        location: { x: 30, z: -70 },
        fielder: F.RF
      })
      expect(keysOf(play)).not.include('launchAngle')
      expect(detailOf(play)).includes({ launchAngle: 45 })
      expect(detailOf(play)).not.have.property('launchAngleSet')
    }
    // A drag flag with no angle to go with it writes none either.
    const flagOnly = batted({ launchAngleDragged: true, fielder: F.RF })
    expect(keysOf(flagOnly)).not.include('launchAngle')
    expect(detailOf(flagOnly)).not.have.property('launchAngleSet')
  })

  it('drops a launch angle outside -90 to 90 degrees, and keeps the ball in play', function () {
    for (const launchAngle of [120, -90.5, Number.NaN, Infinity]) {
      const play = batted({
        launchAngle,
        launchAngleDragged: true,
        location: { x: 30, z: -70 },
        fielder: F.RF
      })
      expect(keysOf(play), String(launchAngle)).not.include('launchAngle')
      expect(keysOf(play), String(launchAngle)).not.include('trajectory')
      expect(detailOf(play)).not.have.property('launchAngle')
      expect(detailOf(play)).not.have.property('launchAngleSet')
      expect(detailOf(play)).not.have.property('trajectory')
      expect(hitDataOf(play)).deep.include({ location: '9' })
    }
    // A trajectory given beside it still says how the ball went.
    const popped = batted({
      launchAngle: 120,
      launchAngleDragged: true,
      trajectory: 'popup',
      fielder: F.C
    })
    expect(keysOf(popped)).not.include('launchAngle')
    expect(detailOf(popped)).includes({ trajectory: 'popup', launchAngle: 60 })
    expect(detailOf(popped)).not.have.property('launchAngleSet')
    for (const launchAngle of [-90, 90])
      expect(
        applyAction(game(), {
          type: 'ballInPlay',
          contact: 'swing',
          launchAngle,
          launchAngleDragged: true
        }).problems
      ).deep.equals([])
  })
})

describe('substitutions (U19)', function () {
  interface Substitution extends StoredEvent {
    isSubstitution?: boolean
    player: { id?: number; fullName: string }
    position?: Record<string, unknown>
    battingOrder?: string
    replacedPlayer?: { id?: number; fullName: string }
  }
  const substitutions = (play: GumboPlay): Substitution[] =>
    (eventsOf(play) as Substitution[]).filter(
      event => event.isSubstitution === true
    )
  /** Each substitution as `eventType position battingOrder replaced: sentence`. */
  const said = (play: GumboPlay): string[] =>
    substitutions(play).map(
      event =>
        `${String(event.details.eventType)} ${String(event.position?.abbreviation)} ${String(event.battingOrder)} ${String(event.replacedPlayer?.fullName)}: ${String(event.details.description)}`
    )
  const roster = (
    state: GameState,
    change: (setup: ReturnType<typeof setupOf>) => void
  ): GameState => {
    const setup = setupOf(state)
    change(setup)
    return after(state, { type: 'lineup', kind: 'roster', setup })
  }
  const bench = (state: GameState, side: 'away' | 'home'): GameState =>
    after(state, {
      type: 'lineup',
      kind: 'addPlayer',
      side,
      name: `${side === 'away' ? 'Away' : 'Home'} Bench`
    })
  /** Away 1 on first after a walk, Away 2 due; a bench player a side, 19 and 20. */
  const benched = (): GameState =>
    bench(bench(walk(rostered()), 'away'), 'home')

  it("writes each kind with the feed's keys, value types and position", function () {
    const feed = JSON.parse(
      readFileSync('src/common/gumbo/reference/feed776258.json', 'utf8')
    ) as {
      liveData: {
        plays: { allPlays: Array<{ playEvents: Substitution[] }> }
      }
    }
    const feedOf = (eventType: string): Substitution =>
      feed.liveData.plays.allPlays
        .flatMap(play => play.playEvents)
        .find(event => event.details.eventType === eventType)!
    // A pinch hitter at 1-0 and a new pitcher, as the screen saves them.
    const subbed = roster(after(benched(), ball), setup => {
      setup.sides.away.battingOrder[1] = 19
      setup.sides.home.defense.P = 20
    })
    // The pinch hitter stays in, at third, when his side takes the field.
    const fielding = after(subbed, ball, ball, ball, close, {
      type: 'gameFlow',
      kind: 'endHalf'
    })
    const stays = roster(walk(fielding), setup => {
      setup.sides.away.defense['3B'] = 19
    })
    const got = new Map(
      [...substitutions(stored(subbed)), ...substitutions(stored(stays))].map(
        event => [String(event.details.eventType), event]
      )
    )
    for (const eventType of [
      'offensive_substitution',
      'pitching_substitution',
      'defensive_switch'
    ]) {
      const want = feedOf(eventType)
      const event = got.get(eventType)!
      expect(Object.keys(event).sort(), eventType).deep.equals(
        Object.keys(want).sort()
      )
      expect(Object.keys(event.details), eventType).deep.equals(
        Object.keys(want.details)
      )
      // No action says when it happened, so its times are null.
      for (const key of Object.keys(want).filter(key => !key.endsWith('Time')))
        expect(typeOf(event[key as keyof Substitution]), key).equals(
          typeOf(want[key as keyof Substitution])
        )
      for (const key of Object.keys(want.details))
        expect(typeOf(event.details[key]), key).equals(
          typeOf(want.details[key])
        )
      expect(Object.keys(event.position!)).deep.equals(
        Object.keys(want.position!)
      )
      expect(event.details.event).equals(want.details.event)
      expect(POSITION_CODES.has(String(event.position!.code))).equals(true)
    }
    // The pinch hitter bats in his man's place, in the count he left.
    expect(stored(subbed).matchup).deep.include({
      batter: { fullName: 'Away Bench' },
      pitcher: { fullName: 'Home Bench' }
    })
    expect(stored(subbed).count).deep.include({ balls: 1, strikes: 0 })
    // Only the pinch hitter and the switch carry his place and his man.
    expect(got.get('pitching_substitution')).not.have.property('battingOrder')
    expect(got.get('pitching_substitution')).not.have.property('replacedPlayer')
    expect(said(stored(subbed))).deep.equals([
      'pitching_substitution P undefined undefined: Pitching Change: Home Bench replaces Home 1.',
      'offensive_substitution PH 201 Away 2: Offensive Substitution: Pinch-hitter Away Bench replaces Away 2.'
    ])
    expect(got.get('offensive_substitution')!.position).deep.equals({
      code: '11',
      name: 'Pinch Hitter',
      type: 'Hitter',
      abbreviation: 'PH'
    })
    expect(got.get('offensive_substitution')!.replacedPlayer).deep.equals({
      id: 102,
      fullName: 'Away 2'
    })
    // As the feed's McKinstry: the pinch hitter's place, and the man at third.
    expect(said(stored(stays))).deep.equals([
      'defensive_switch 3B 201 Away 6: Away Bench remains in the game as the third baseman.'
    ])
  })

  it('writes a sub who comes in to field with the pitching change keys', function () {
    const fielded = roster(benched(), setup => {
      setup.sides.home.defense.LF = 20
      setup.sides.home.battingOrder[6] = 20
    })
    const [event] = substitutions(stored(fielded))
    expect(said(stored(fielded))).deep.equals([
      'defensive_substitution LF undefined undefined: Defensive Substitution: Home Bench replaces Home 7, playing left field.'
    ])
    expect(event.position!.code).equals('7')
    expect(Object.keys(event).sort()).deep.equals(
      [
        'count',
        'details',
        'endTime',
        'index',
        'isPitch',
        'isSubstitution',
        'player',
        'position',
        'startTime',
        'type'
      ].sort()
    )
  })

  it('writes a shortstop moved to the mound as a pitching change and a switch, in one change or two', function () {
    const swapped = roster(benched(), setup => {
      setup.sides.home.defense.P = F.SS
      setup.sides.home.defense.SS = F.P
    })
    const expected = [
      'pitching_substitution P undefined undefined: Pitching Change: Home 5 replaces Home 1.',
      'defensive_switch SS 100 Home 5: Defensive switch from pitcher to shortstop for Home 1.'
    ]
    expect(said(stored(swapped))).deep.equals(expected)
    // The way the E0 session did it: one position at a time.
    const stepwise = after(
      benched(),
      {
        type: 'lineup',
        kind: 'position',
        side: 'home',
        position: 'P',
        player: F.SS
      },
      {
        type: 'lineup',
        kind: 'position',
        side: 'home',
        position: 'SS',
        player: F.P
      }
    )
    expect(said(stored(stepwise))).deep.equals(expected)
    expect(stored(stepwise).matchup).deep.include({
      pitcher: { id: 205, fullName: 'Home 5' }
    })
  })

  it('writes a substitute who comes in to pitch, and numbers each sub into a place', function () {
    const relieved = after(benched(), {
      type: 'lineup',
      kind: 'substitute',
      side: 'home',
      player: 20,
      replaces: F.P
    })
    expect(said(stored(relieved))).deep.equals([
      'pitching_substitution P undefined undefined: Pitching Change: Home Bench replaces Home 1.'
    ])
    // A second pinch hitter at the same place is its second sub.
    const twice = after(
      roster(benched(), setup => {
        setup.sides.away.battingOrder[1] = 19
      }),
      { type: 'lineup', kind: 'addPlayer', side: 'away', name: 'Away Two' },
      {
        type: 'lineup',
        kind: 'substitute',
        side: 'away',
        player: 21,
        replaces: 19
      }
    )
    expect(
      substitutions(stored(twice)).map(event => event.battingOrder)
    ).deep.equals(['201', '202'])
    expect(stored(twice).matchup).deep.include({
      batter: { fullName: 'Away Two' }
    })
  })

  it('writes a pinch runner for a man on base, and a new batting order as gs_batting_order', function () {
    const ran = roster(benched(), setup => {
      setup.sides.away.battingOrder[0] = 19
    })
    expect(said(stored(ran))).deep.equals([
      'offensive_substitution PR 101 Away 1: Offensive Substitution: Pinch-runner Away Bench replaces Away 1.'
    ])
    const reordered = roster(benched(), setup => {
      const order = setup.sides.away.battingOrder
      ;[order[2], order[3]] = [order[3], order[2]]
    })
    const [event] = substitutions(stored(reordered))
    expect(event).not.have.property('position')
    expect(event.details).deep.include({
      eventType: 'gs_batting_order',
      event: 'Batting Order Change',
      description: 'Batting order change: Away 4 bats 3rd, Away 3 bats 4th.'
    })
    expect(event.player).deep.equals({ id: 104, fullName: 'Away 4' })
    expect(STORED_EVENT_TYPES.has('gs_batting_order')).equals(true)
  })

  it('writes nothing for the lineups a game starts with, a new roster player or the batter changing sides', function () {
    const pregame = roster(rostered(), setup => {
      setup.sides.away.battingOrder.reverse()
      setup.sides.home.defense.P = F.SS
      setup.sides.home.defense.SS = F.P
    })
    expect(pregame.liveData.plays.currentPlay!.playEvents).deep.equals([])
    const quiet = after(bench(walk(rostered()), 'away'), {
      type: 'lineup',
      kind: 'batterSide',
      batSide: 'L'
    })
    expect(quiet.liveData.plays.currentPlay!.playEvents).deep.equals([])
  })

  it('writes a change the side at bat makes to its fielders first in the first play it fields', function () {
    // At 1-0 the visitors, at bat, swap their pitcher and shortstop and send
    // a pinch hitter up, with the score 1-0 after a home run.
    const homeRun: ScoringAction[] = [
      { type: 'ballInPlay', contact: 'swing', fielder: F.CF },
      { type: 'result', eventType: 'home_run' },
      close
    ]
    const swapped = roster(after(benched(), ...homeRun, ball), setup => {
      const defense = setup.sides.away.defense
      ;[defense.P, defense.SS] = [defense.SS, defense.P]
      setup.sides.away.battingOrder[2] = 19
    })
    // The half they bat writes only the pinch hitter.
    expect(said(stored(swapped))).deep.equals([
      'offensive_substitution PH 301 Away 3: Offensive Substitution: Pinch-hitter Away Bench replaces Away 3.'
    ])
    const fielding = strikeout(strikeout(strikeout(swapped)))
    const completed = (state: GameState): GumboPlay[] =>
      state.liveData.plays.allPlays.map(play =>
        documentOf(state, play, { setupBefore: setupOf(state), actions: [] })
      )
    expect(completed(fielding).map(said)).deep.equals([
      [],
      [],
      [
        'offensive_substitution PH 301 Away 3: Offensive Substitution: Pinch-hitter Away Bench replaces Away 3.'
      ],
      [],
      []
    ])
    // As the feed writes a change between innings: before the first pitch,
    // with the count and outs the half begins with and the score it stands at.
    const announced = [
      'pitching_substitution P undefined undefined: Pitching Change: Away 5 replaces Away 1.',
      'defensive_switch SS 100 Away 5: Defensive switch from pitcher to shortstop for Away 1.'
    ]
    const first = stored(fielding)
    expect(first.about).deep.include({ halfInning: 'bottom', inning: 1 })
    expect(said(first)).deep.equals(announced)
    expect(
      eventsOf(first).map(({ index, count, details }) => [
        index,
        count,
        details.awayScore,
        details.homeScore
      ])
    ).deep.equals([
      [0, { balls: 0, strikes: 0, outs: 0 }, 2, 0],
      [1, { balls: 0, strikes: 0, outs: 0 }, 2, 0]
    ])
    expect(first.actionIndex).deep.equals([0, 1])
    // The play's own events come after them, and its runners point past them.
    const fanned = strikeout(after(fielding, ball))
    const [bottom] = completed(fanned).slice(5)
    expect(said(bottom)).deep.equals(announced)
    expect(bottom.pitchIndex).deep.equals([2, 3, 4, 5])
    expect(bottom.actionIndex).deep.equals([0, 1])
    expect(eventsOf(bottom).map(event => event.index)).deep.equals([
      0, 1, 2, 3, 4, 5
    ])
    expect(runnersOf(bottom)[0].details.playIndex).equals(5)
    expect(bottom.matchup).deep.include({
      pitcher: { id: 105, fullName: 'Away 5' }
    })
    // Only the first play of the half writes them.
    expect(said(stored(fanned))).deep.equals([])
  })

  /** Each substitution of every play so far, the one in progress last. */
  const everySaid = (state: GameState): string[][] => [
    ...state.liveData.plays.allPlays.map(play =>
      said(
        documentOf(state, play, { setupBefore: setupOf(state), actions: [] })
      )
    ),
    said(stored(state))
  ]
  /** The visitors put their shortstop on the mound and their pitcher at short. */
  const swapAway = (state: GameState): GameState =>
    roster(state, setup => {
      const defense = setup.sides.away.defense
      ;[defense.P, defense.SS] = [defense.SS, defense.P]
    })
  const away = (player: number, replaces: number): ScoringAction => ({
    type: 'lineup',
    kind: 'substitute',
    side: 'away',
    player,
    replaces
  })
  const toTheField = (state: GameState): GameState => {
    let next = state
    while (next.liveData.linescore.isTopInning) next = strikeout(next)
    return next
  }

  it('announces the pitcher who takes the mound, not one the side at bat moved there and replaced', function () {
    // At bat, the visitors move Away 5 to the mound, then bring Away Bench
    // in for him, who neither bats nor runs: in the next plate appearance,
    // or in the same one.
    const apart = after(
      strikeout(swapAway(after(benched(), ball))),
      away(19, 5)
    )
    const together = after(swapAway(after(benched(), ball)), away(19, 5))
    for (const [name, batting] of [
      ['apart', apart],
      ['together', together]
    ] as const) {
      const fielding = toTheField(batting)
      const all = everySaid(fielding)
      // The half they bat writes none of it.
      expect(all.slice(0, -1).flat(), name).deep.equals([])
      expect(all.at(-1), name).deep.equals([
        'pitching_substitution P undefined undefined: Pitching Change: Away Bench replaces Away 1.',
        'defensive_switch SS 100 Away 5: Defensive switch from pitcher to shortstop for Away 1.'
      ])
      expect(stored(fielding).matchup, name).deep.include({
        pitcher: { fullName: 'Away Bench' }
      })
    }
    // The engine sees Away Bench come in to hit for Away 5, which he never
    // did before his side took the field.
    expect(
      apart.liveData.plays.currentPlay!.playEvents.find(
        event => event.isSubstitution === true
      )
    ).deep.include({
      position: 'PH',
      battingOrder: '501',
      replacedPlayer: { id: 5, fullName: 'Away 5' }
    })
  })

  it('announces nothing for a change the side undid before it took the field', function () {
    // Swapped at bat and swapped back later in the half.
    const back = toTheField(
      swapAway(strikeout(swapAway(after(benched(), ball))))
    )
    expect(everySaid(back).flat()).deep.equals([])
    // Swapped at bat, and back at the break before the first pitch.
    const atBreak = swapAway(toTheField(swapAway(after(benched(), ball))))
    expect(everySaid(atBreak).flat()).deep.equals([])
    expect(everySaid(strikeout(atBreak)).flat()).deep.equals([])
    // After the first pitch the change back is the side's own, written where
    // it was made.
    const pitched = swapAway(after(toTheField(swapAway(benched())), ball))
    expect(said(stored(pitched))).deep.equals([
      'pitching_substitution P undefined undefined: Pitching Change: Away 5 replaces Away 1.',
      'defensive_switch SS 100 Away 5: Defensive switch from pitcher to shortstop for Away 1.',
      'pitching_substitution P undefined undefined: Pitching Change: Away 1 replaces Away 5.',
      'defensive_switch SS 500 Away 1: Defensive switch from pitcher to shortstop for Away 5.'
    ])
    // A change made one position at a time at the break is announced once.
    const stepwise = after(
      toTheField(benched()),
      {
        type: 'lineup',
        kind: 'position',
        side: 'away',
        position: 'P',
        player: 5
      },
      {
        type: 'lineup',
        kind: 'position',
        side: 'away',
        position: 'SS',
        player: 1
      }
    )
    expect(said(stored(stepwise))).deep.equals([
      'pitching_substitution P undefined undefined: Pitching Change: Away 5 replaces Away 1.',
      'defensive_switch SS 100 Away 5: Defensive switch from pitcher to shortstop for Away 1.'
    ])
  })

  it('writes a pinch hitter who takes the field as a switch, and a bench player sent in to field as a substitution', function () {
    // Away Bench pinch-hits for Away 2, the catcher, and Away Two comes in
    // for Away 8, the center fielder, who neither bats nor runs.
    const batting = after(
      benched(),
      away(19, 2),
      { type: 'lineup', kind: 'addPlayer', side: 'away', name: 'Away Two' },
      away(21, 8)
    )
    const all = everySaid(toTheField(batting))
    expect(all.slice(0, -1).flat()).deep.equals([
      'offensive_substitution PH 201 Away 2: Offensive Substitution: Pinch-hitter Away Bench replaces Away 2.'
    ])
    // As the feed's McKinstry, then the fielder the visitors sent in.
    expect(all.at(-1)).deep.equals([
      'defensive_switch C 201 Away 2: Away Bench remains in the game as the catcher.',
      'defensive_substitution CF undefined undefined: Defensive Substitution: Away Two replaces Away 8, playing center field.'
    ])
  })

  it('stays out of the pitches, the score and the in-play check', function () {
    // Runs in, then a change: the event carries the score as it stands.
    const homeRun: ScoringAction[] = [
      { type: 'ballInPlay', contact: 'swing', fielder: F.CF },
      { type: 'result', eventType: 'home_run' },
      close
    ]
    const scored = roster(after(benched(), ...homeRun), setup => {
      setup.sides.home.defense.P = 20
    })
    const play = stored(scored)
    expect(substitutions(play)[0].details).deep.include({
      awayScore: 2,
      homeScore: 0,
      isScoringPlay: false,
      isOut: false
    })
    expect(play.pitchIndex).deep.equals([])
    expect(play.actionIndex).deep.equals([0])
  })
})

describe('the matchup', function () {
  it("writes the batter's side by name, and the pitcher's hand when the roster knows it", function () {
    const teams = {
      away: { id: 'team-away', name: 'A' },
      home: { id: 'team-home', name: 'H' }
    }
    const handed = freshGame(
      'g1',
      teams,
      newSetup(teams, {
        away: [{ userId: 1, shortName: 'Lefty', bats: 'left' }],
        home: [{ userId: 2, shortName: 'Southpaw', throws: 'left' }]
      })
    )
    expect(stored(handed).matchup).deep.equals({
      batter: { id: 1, fullName: 'Lefty' },
      batSide: { code: 'L', description: 'Left' },
      pitcher: { id: 2, fullName: 'Southpaw' },
      pitchHand: { code: 'L', description: 'Left' }
    })
    expect(stored(rostered()).matchup).deep.equals({
      batter: { id: 101, fullName: 'Away 1' },
      batSide: { code: 'R', description: 'Right' },
      pitcher: { id: 201, fullName: 'Home 1' }
    })
  })
})

describe('folding a whole game', function () {
  it('folds each play through one folder as it folds that play alone, in one step each', function () {
    // A bench player sent in for Away 2 on deck, who bats, then fields: who
    // has been announced is carried from play to play.
    const K = [strike, strike, strike, close]
    const state = after(
      game(),
      { type: 'lineup', kind: 'addPlayer', side: 'away', name: 'Away Bench' },
      ball,
      {
        type: 'lineup',
        kind: 'substitute',
        side: 'away',
        player: 19,
        replaces: 2
      },
      ...Array.from({ length: 7 }, () => K).flat(),
      ball
    )
    const stamp = { setupBefore: setupOf(state), actions: [] }
    const plays = state.liveData.plays.allPlays
    const current = state.liveData.plays.currentPlay
    const alone = [
      ...plays.map(play => documentOf(state, play, stamp)),
      currentDocumentOf(state, current, stamp)
    ]
    const folder = new PlayFolder(state)
    const before = PlayFolder.steps
    const together = [
      ...plays.map(play => folder.play(play, stamp)),
      folder.current(current, stamp)
    ]
    expect(PlayFolder.steps - before).equals(plays.length + 1)
    expect(together).deep.equals(alone)
    expect(
      together.flatMap(play =>
        (
          (play.playEvents ?? []) as Array<{
            isSubstitution?: boolean
            details: Record<string, unknown>
          }>
        )
          .filter(event => event.isSubstitution === true)
          .map(
            event =>
              `${play.about.atBatIndex} ${String(event.details.eventType)}`
          )
      )
    ).deep.equals(['1 offensive_substitution', '3 defensive_switch'])
    // Asked for an earlier play, it starts over from the game's first.
    expect(folder.play(plays[1], stamp)).deep.equals(alone[1])
    expect(folder.play(plays[4], stamp)).deep.equals(alone[4])
  })
})

describe('pitch data', function () {
  const pitchDataOf = (play: GumboPlay): unknown[] =>
    eventsOf(play)
      .filter(event => event.isPitch)
      .map(event => (event as { pitchData?: unknown }).pitchData)

  it('writes the speed and zone the scorer gave a pitch, and the one the batter hit', function () {
    const play = stored(
      after(
        game(),
        {
          type: 'pitch',
          call: 'B',
          speed: 71.26,
          pitchLocation: { height: 'high', side: 'away', inZone: false }
        },
        { type: 'pitch', call: 'C', zone: 5 },
        ball,
        {
          type: 'ballInPlay',
          contact: 'swing',
          fielder: F.SS,
          speed: 68,
          pitchLocation: { height: 'low', side: 'inside', inZone: true }
        },
        { type: 'result', eventType: 'single' },
        close
      ),
      true
    )
    expect(pitchDataOf(play)).deep.equals([
      { startSpeed: 71.3, zone: 12 },
      { zone: 5 },
      undefined,
      { startSpeed: 68, zone: 7 }
    ])
    // The in-play pitch keeps its hit data beside it.
    const inPlay = eventsOf(play).at(-1) as { hitData?: unknown }
    expect(inPlay.hitData).deep.include({ location: '6' })
  })

  it('takes the batter’s side for the location, and a zone given as a number over it', function () {
    const play = stored(
      after(
        game(),
        { type: 'lineup', kind: 'batterSide', batSide: 'L' },
        {
          type: 'pitch',
          call: 'B',
          pitchLocation: { height: 'low', side: 'inside', inZone: false }
        },
        {
          type: 'pitch',
          call: 'C',
          zone: 1,
          pitchLocation: { height: 'low', side: 'inside', inZone: true }
        },
        {
          type: 'pitch',
          call: 'B',
          pitchLocation: { height: 'high', side: 'middle', inZone: false }
        }
      )
    )
    expect(pitchDataOf(play)).deep.equals([
      { zone: 14 },
      { zone: 1 },
      undefined
    ])
  })

  it('says more of the pitch the batter hit when the ball in play says more', function () {
    const play = stored(
      after(
        game(),
        { type: 'ballInPlay', contact: 'swing', speed: 80 },
        {
          type: 'ballInPlay',
          contact: 'swing',
          fielder: F.CF,
          pitchLocation: { height: 'middle', side: 'middle', inZone: true }
        },
        { type: 'result', eventType: 'single' },
        close
      ),
      true
    )
    expect(pitchDataOf(play)).deep.equals([{ startSpeed: 80, zone: 5 }])
  })

  it('drops a speed or zone out of range, and still throws the pitch', function () {
    const state = after(
      game(),
      { type: 'pitch', call: 'B', speed: 150, zone: 10 },
      { type: 'pitch', call: 'B', speed: 12, zone: 2.5 },
      // A zone out of range leaves the location to say where it was.
      {
        type: 'pitch',
        call: 'B',
        speed: Number.NaN,
        zone: 0,
        pitchLocation: { height: 'middle', side: 'away', inZone: true }
      },
      {
        type: 'ballInPlay',
        contact: 'bunt',
        speed: -3,
        zone: 15,
        fielder: F.C
      },
      { type: 'result', eventType: 'single' },
      close
    )
    const play = stored(state, true)
    expect(pitchDataOf(play)).deep.equals([
      undefined,
      undefined,
      { zone: 6 },
      undefined
    ])
    for (const speed of [20, 110])
      expect(
        pitchDataOf(stored(after(game(), { type: 'pitch', call: 'B', speed })))
      ).deep.equals([{ startSpeed: speed }])
  })
})
