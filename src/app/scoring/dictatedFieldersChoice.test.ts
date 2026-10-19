import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { ScoringAction } from '../../common/scoring/actions'
import { applyAction } from '../../common/scoring/session'
import { asGameState } from '../../common/scoring/state'
import { choiceRelayPhrases } from '../../test/fieldersChoicePhrases'
import { BASES } from '../field/fieldModel'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { atRest, initialScoringState, scoringReducer } from './scoringMachine'
import { scoringFieldPlayers } from './scoringMotion'
import { playerRef } from './scoringSelectors'
import type { ScoringState } from './scoringTypes'

function game(mask = 7, outs = 0): ScoringState {
  const session = createDevelopmentSession(gameFixture, [], [])
  for (const [index, key] of (['first', 'second', 'third'] as const).entries())
    session.liveData.linescore.offense[key] =
      (mask & (1 << index)) !== 0 ? playerRef(session, index + 6) : null
  session.liveData.linescore.outs = outs
  return initialScoringState(session, true)
}

const grounder: ScoringAction = {
  type: 'ballInPlay',
  contact: 'swing',
  trajectory: 'ground_ball',
  fielder: 15
}
const choice: ScoringAction = { type: 'result', eventType: 'fielders_choice' }

function playReel(state: ScoringState): {
  state: ScoringState
  throws: Array<{ from: number; to: number; origin: unknown; target: unknown }>
  motions: Map<number, Array<{ x: number; z: number }>>
} {
  const throws: Array<{
    from: number
    to: number
    origin: unknown
    target: unknown
  }> = []
  const motions = new Map<number, Array<{ x: number; z: number }>>()
  const seen = new Set<string>()
  for (let step = 0; step < 150 && !atRest(state); step++) {
    for (const motion of state.motions)
      if (!seen.has(motion.id) && motion.held !== true) {
        seen.add(motion.id)
        motions.set(motion.playerId, [
          ...(motions.get(motion.playerId) ?? []),
          ...motion.waypoints
        ])
      }
    const p = state.presentation
    if (p != null) {
      if (p.kind === 'throw')
        throws.push({
          from: p.thrower,
          to: p.receiver,
          origin: p.holderOrigin,
          target: { x: p.to.x, z: p.to.z }
        })
      if (p.kind === 'hit' && p.stage === 'swing')
        state = scoringReducer(state, {
          type: 'PRESENTATION_CONTACT',
          id: p.id,
          generation: p.generation
        })
      const current = state.presentation!
      state = scoringReducer(state, {
        type: 'PRESENTATION_DONE',
        id: current.id,
        generation: current.generation,
        stage: current.stage
      })
    } else {
      const motion = state.motions.find(m => !m.complete && m.held !== true)
      expect(motion, 'reel must make progress').not.equals(undefined)
      state = scoringReducer(state, {
        type: 'MOTION_DONE',
        id: motion!.id,
        generation: motion!.generation
      })
    }
  }
  expect(atRest(state), 'reel must finish').equals(true)
  return { state, throws, motions }
}

function say(
  before: ScoringState,
  actions: ScoringAction[],
  transcript = "Fielder's choice. Ground ball to third.",
  resultAfterMoves = false
): ScoringState {
  const state = scoringReducer(before, {
    type: 'DICTATED',
    transcript,
    actions: resultAfterMoves
      ? [grounder, ...actions, choice]
      : [grounder, choice, ...actions]
  })
  expect(state.dictation?.problem, JSON.stringify(state.dictation)).equals(
    undefined
  )
  expect(
    state.dictationQuestion,
    JSON.stringify(state.dictationQuestion)
  ).equals(undefined)
  expect(state.past.length).equals(1)
  return state
}

function credits(state: ScoringState): unknown {
  const play =
    state.session.pending == null
      ? state.session.liveData.plays.allPlays.at(-1)!
      : state.session.liveData.plays.currentPlay!
  return play.runners.flatMap(r =>
    r.credits
      .filter(c => c.credit === 'f_putout' || c.credit === 'f_assist')
      .map(c => [r.details.runner.id, c.player.id, c.credit])
  )
}

describe('dictated fielder choice animation and credits', function () {
  for (const fielders of [[15], [15, 13]])
    for (const startingOuts of [0, 2])
      for (const runnerOnly of [false, true])
        it(`preserves tag geometry with batter Safe after the Out (${fielders.join('-')}/${startingOuts}/${runnerOnly})`, function () {
          const target = { x: -8, z: -29 }
          const before = game(2, startingOuts)
          const words =
            fielders.length === 1
              ? "Ground ball to the third baseman for a fielder's choice. The runner from second is tagged out at third by the third baseman himself. The batter is safe at first."
              : "Ground ball to the third baseman for a fielder's choice. The runner from second is out at third on the throw to the second baseman. The batter is safe at first."
          const result = playReel(
            say(
              before,
              [
                {
                  type: 'runnerMovement',
                  runner: 7,
                  to: '3B',
                  out: true,
                  fielders,
                  ...(runnerOnly
                    ? { runnerLocation: target }
                    : {
                        locations:
                          fielders.length === 1 ? [target] : [BASES[3], target]
                      })
                },
                { type: 'runnerMovement', runner: 1, to: '1B' }
              ],
              words
            )
          )
          expect(result.state.dictation?.problem).equals(undefined)
          expect(result.throws.at(-1)!.target).deep.equals(target)
          expect(result.motions.get(7)).deep.includes(target)
          expect(result.motions.get(7)).not.deep.includes(BASES[3])
          const play =
            result.state.session.pending == null
              ? result.state.session.liveData.plays.allPlays.at(-1)!
              : result.state.session.liveData.plays.currentPlay!
          expect(
            play.source.teamstation
              .runnerActions!.find(r => r.isOut)!
              .defensiveRoute!.at(-1)!.location
          ).deep.equals(target)
          expect(
            play.runners.some(
              r => r.details.runner.id === 1 && r.movement.isOut
            )
          ).equals(false)
          expect(credits(result.state)).deep.equals(
            fielders.length === 1
              ? [[7, 15, 'f_putout']]
              : [
                  [7, 15, 'f_assist'],
                  [7, 13, 'f_putout']
                ]
          )
          expect(
            scoringReducer(result.state, { type: 'UNDO' }).session
          ).deep.equals(before.session)
        })

  for (const fielders of [undefined, [13], [15, 13]])
    it(`aligns the receiver catch with inferred assist (${fielders?.join('-') ?? 'missing'})`, function () {
      const origin = { x: -5, z: -20 }
      const target = { x: 4, z: -11 }
      const before = game(1)
      const result = playReel(
        scoringReducer(before, {
          type: 'DICTATED',
          transcript:
            "Ground ball to the third baseman for a fielder's choice. The runner from first is tagged out by the second baseman. The second baseman throws to the first baseman, too late. The batter is safe at first.",
          actions: [
            { ...grounder, location: origin },
            choice,
            {
              type: 'runnerMovement',
              runner: 6,
              to: '2B',
              out: true,
              fielders,
              locations: fielders?.length === 2 ? [origin, target] : [target],
              runnerLocation: target
            },
            { type: 'runnerMovement', runner: 1, to: '1B', fielders: [13, 12] }
          ]
        })
      )
      expect(result.state.dictation?.problem).equals(undefined)
      expect(result.throws.map(t => [t.from, t.to])).deep.equals([
        [15, 13],
        [13, 12]
      ])
      expect(result.throws[0].origin).deep.equals(origin)
      expect(result.throws[0].target).deep.equals(target)
      expect(credits(result.state)).deep.equals([
        [6, 15, 'f_assist'],
        [6, 13, 'f_putout']
      ])
      expect(
        scoringFieldPlayers(result.state).find(p => p.playerId === 15)!.position
      ).deep.equals(origin)
    })

  it('renders every queued Safe relay after its carrier scores without resurrecting him', function () {
    const before = game(5)
    const state = say(before, [
      { type: 'runnerMovement', runner: 6, to: '3B', fielders: [15, 13] },
      { type: 'runnerMovement', runner: 8, to: 'home', fielders: [13, 11] },
      { type: 'runnerMovement', runner: 1, to: '1B' }
    ])
    const sequences = [
      state.presentation,
      ...state.reel!.map(b => b.presentation)
    ].filter(p => p?.kind === 'throw')
    expect(sequences.map(p => [p.thrower, p.receiver])).deep.equals([
      [15, 13],
      [13, 11]
    ])
    expect(
      sequences.every(p => !p.players.some(player => player.playerId === 8))
    ).equals(true)
    const result = playReel(state)
    expect(result.state.session.liveData.linescore.teams.away.runs).equals(1)
    expect(credits(result.state)).deep.equals([])
    const restored = initialScoringState(
      asGameState(JSON.parse(JSON.stringify(result.state.session)))
    )
    expect(
      scoringFieldPlayers(restored).find(p => p.playerId === 11)!.position
    ).deep.equals(BASES[0])
    expect(scoringReducer(result.state, { type: 'UNDO' }).session).deep.equals(
      before.session
    )
  })
  it('runs to an explicit unassisted tag point before the base and exits continuously', function () {
    const point = { x: -8, z: -29 }
    const state = say(
      game(2),
      [
        {
          type: 'runnerMovement',
          runner: 7,
          to: '3B',
          out: true,
          fielders: [15],
          locations: [point],
          runnerLocation: point
        },
        { type: 'runnerMovement', runner: 1, to: '1B' }
      ],
      "Ground ball to the third baseman for a fielder's choice. The runner from second is tagged out before third by the third baseman. The batter is safe at first."
    )
    const result = playReel(state)
    expect(result.throws[0].target).deep.equals(point)
    expect(result.motions.get(7)).deep.includes(point)
    expect(result.motions.get(7)).not.deep.includes(BASES[3])
    expect(
      scoringFieldPlayers(result.state).find(p => p.playerId === 15)!.position
    ).deep.equals(point)
    expect(credits(result.state)).deep.equals([[7, 15, 'f_putout']])
  })
  it('retains every supplied intermediate fielder in an all-Safe relay', function () {
    const result = playReel(
      say(
        game(1),
        [
          { type: 'runnerMovement', runner: 6, to: '2B' },
          {
            type: 'runnerMovement',
            runner: 1,
            to: '1B',
            fielders: [15, 14, 13, 12]
          }
        ],
        "Ground ball to the third baseman for a fielder's choice. He throws across. The shortstop takes it and feeds the second baseman. The second baseman throws to the first baseman, too late. The runner from first is safe at second. The batter is safe at first."
      )
    )
    expect(result.throws.map(t => [t.from, t.to])).deep.equals([
      [15, 14],
      [14, 13],
      [13, 12]
    ])
    expect(
      result.state.session.liveData.plays.currentPlay!.source.teamstation.fieldingRoute!.map(
        hop => hop.player.id
      )
    ).deep.equals([15, 14, 13, 12])
    expect(credits(result.state)).deep.equals([])
  })

  it('animates and stores every Safe relay segment in one saved continuation', function () {
    let session = game(1).session
    for (const action of [
      grounder,
      choice,
      { type: 'runnerMovement', runner: 1, to: '1B' },
      { type: 'runnerMovement', runner: 6, to: '2B' }
    ] as ScoringAction[])
      session = applyAction(session, action).state
    const before = initialScoringState(
      asGameState(JSON.parse(JSON.stringify(session))),
      true
    )
    const origin = scoringFieldPlayers(before).find(
      p => p.playerId === 15
    )!.position
    const middle = { x: 3, z: -12 }
    const result = playReel(
      scoringReducer(before, {
        type: 'DICTATED',
        transcript:
          'The third baseman throws to the second baseman, then the first baseman, too late. Then the first baseman throws home to the catcher, also too late. The batter stays safe at first.',
        actions: [
          {
            type: 'runnerMovement',
            runner: 1,
            to: '1B',
            fielders: [15, 13, 12],
            locations: [origin, middle, BASES[1]]
          },
          {
            type: 'runnerMovement',
            runner: 1,
            to: '1B',
            fielders: [12, 11],
            locations: [BASES[1], BASES[0]]
          }
        ]
      })
    )
    expect(result.state.dictation?.problem).equals(undefined)
    expect(result.throws.map(t => [t.from, t.to])).deep.equals([
      [15, 13],
      [13, 12],
      [12, 11]
    ])
    for (const state of [
      result.state,
      initialScoringState(
        asGameState(JSON.parse(JSON.stringify(result.state.session)))
      )
    ]) {
      expect(
        scoringFieldPlayers(state).find(p => p.playerId === 13)!.position
      ).deep.equals(middle)
      expect(
        scoringFieldPlayers(state).find(p => p.playerId === 11)!.position
      ).deep.equals(BASES[0])
      expect(state.session.liveData.plays.currentPlay!.runners).deep.equals(
        before.session.liveData.plays.currentPlay!.runners
      )
      expect(state.session.liveData.linescore).deep.equals(
        before.session.liveData.linescore
      )
      expect(credits(state)).deep.equals([])
    }
    expect(scoringReducer(result.state, { type: 'UNDO' }).session).deep.equals(
      before.session
    )
  })

  it('retains an intervening Out catch when extending an earlier saved relay', function () {
    const reopen = (state: ScoringState): ScoringState =>
      initialScoringState(
        asGameState(JSON.parse(JSON.stringify(state.session))),
        true
      )
    const first = playReel(
      say(game(1), [
        { type: 'runnerMovement', runner: 6, to: '2B' },
        {
          type: 'runnerMovement',
          runner: 1,
          to: '1B',
          fielders: [15, 13, 12],
          locations: [BASES[3], BASES[2], BASES[1]]
        }
      ])
    )
    const middle = { x: 3, z: -12 }
    const out = playReel(
      scoringReducer(reopen(first.state), {
        type: 'DICTATED',
        transcript:
          'The first baseman throws to the second baseman and on to third for the tag out.',
        actions: [
          {
            type: 'runnerMovement',
            runner: 6,
            to: '3B',
            out: true,
            fielders: [12, 13, 15],
            locations: [BASES[1], middle, BASES[3]]
          }
        ]
      })
    )
    const before = reopen(out.state)
    const result = playReel(
      scoringReducer(before, {
        type: 'DICTATED',
        transcript:
          'The third baseman throws home to the catcher, too late. The batter stays safe at first.',
        actions: [
          {
            type: 'runnerMovement',
            runner: 1,
            to: '1B',
            fielders: [15, 11],
            locations: [BASES[3], BASES[0]]
          }
        ]
      })
    )
    expect(result.state.dictation?.problem).equals(undefined)
    for (const state of [result.state, reopen(result.state)]) {
      expect(
        scoringFieldPlayers(state).find(p => p.playerId === 13)!.position
      ).deep.equals(middle)
      expect(credits(state)).deep.equals([
        [6, 12, 'f_assist'],
        [6, 13, 'f_assist'],
        [6, 15, 'f_putout']
      ])
    }
    expect(scoringReducer(result.state, { type: 'UNDO' }).session).deep.equals(
      before.session
    )
  })

  it('starts the FC walk off at the actual custom tag endpoint', function () {
    const target = { x: 4, z: -11 }
    const state = say(game(1), [
      {
        type: 'runnerMovement',
        runner: 6,
        to: '2B',
        out: true,
        fielders: [15, 13],
        locations: [{ x: -19, z: -27 }, target]
      },
      { type: 'runnerMovement', runner: 1, to: '1B' }
    ])
    const walk = state
      .reel!.flatMap(beat => beat.motions)
      .findLast(m => m.playerId === 6)!
    expect(walk.waypoints[0]).deep.equals(target)
    const result = playReel(state)
    expect(credits(result.state)).deep.equals([
      [6, 15, 'f_assist'],
      [6, 13, 'f_putout']
    ])
  })
  it('preserves an original runner Out after an earlier Safe advance', function () {
    const result = playReel(
      say(
        game(1),
        [
          { type: 'runnerMovement', runner: 6, to: '2B' },
          { type: 'runnerMovement', runner: 1, to: '1B' },
          {
            type: 'runnerMovement',
            runner: 6,
            to: '3B',
            out: true,
            fielders: [15]
          }
        ],
        "Ground ball to the third baseman for a fielder's choice. The runner from first is safe at second. The batter is safe at first. The runner from first is tagged out at third by the third baseman."
      )
    )
    expect(result.state.session.liveData.linescore.outs).equals(1)
    expect(credits(result.state)).deep.equals([[6, 15, 'f_putout']])
    expect(result.motions.get(6)).deep.includes(BASES[3])
  })

  it('preserves supplied intermediate fielders even when the final receiver is named', function () {
    const result = playReel(
      say(
        game(1),
        [
          {
            type: 'runnerMovement',
            runner: 6,
            to: '2B',
            out: true,
            fielders: [15, 14, 13]
          },
          { type: 'runnerMovement', runner: 1, to: '1B' }
        ],
        "Ground ball to the third baseman for a fielder's choice. He throws across. The shortstop takes it and feeds the second baseman. The runner from first is out at second on the throw to the second baseman. The batter is safe at first."
      )
    )
    expect(result.throws.map(t => [t.from, t.to])).deep.equals([
      [15, 14],
      [14, 13]
    ])
    expect(credits(result.state)).deep.equals([
      [6, 15, 'f_assist'],
      [6, 14, 'f_assist'],
      [6, 13, 'f_putout']
    ])
  })

  it('retains interpreted catch locations during explicit base-by-base completion', function () {
    const catchPoint = { x: 3, z: -12 }
    const result = playReel(
      say(
        game(1),
        [
          {
            type: 'runnerMovement',
            runner: 6,
            to: '2B',
            out: true,
            fielders: [15, 13],
            locations: [{ x: -20, z: -25 }, catchPoint]
          },
          { type: 'runnerMovement', runner: 1, to: '1B' }
        ],
        "Ground ball to the third baseman for a fielder's choice. The runner from first is out at second on the throw to the second baseman. The batter is safe at first."
      )
    )
    expect(result.throws[0].target).deep.equals(catchPoint)
    expect(
      scoringFieldPlayers(result.state).find(p => p.playerId === 13)!.position
    ).deep.equals(catchPoint)
  })

  for (const catchPoint of [BASES[2], { x: 3, z: -12 }])
    it(`keeps earlier relay endpoints across two saved FC continuations (${catchPoint.x})`, function () {
      let session = game(1).session
      for (const action of [
        grounder,
        choice,
        { type: 'runnerMovement', runner: 1, to: '1B' },
        { type: 'runnerMovement', runner: 6, to: '2B' }
      ] as ScoringAction[])
        session = applyAction(session, action).state
      const reopen = (session: ScoringState['session']): ScoringState =>
        initialScoringState(
          asGameState(JSON.parse(JSON.stringify(session))),
          true
        )
      const before = reopen(session)
      const origin = scoringFieldPlayers(before).find(
        p => p.playerId === 15
      )!.position
      const first = playReel(
        scoringReducer(before, {
          type: 'DICTATED',
          transcript:
            'The third baseman throws to the second baseman and on to first, both late. The batter is safe at first.',
          actions: [
            {
              type: 'runnerMovement',
              runner: 1,
              to: '1B',
              fielders: [15, 13, 12],
              locations: [origin, catchPoint, BASES[1]]
            }
          ]
        })
      )
      const resumed = reopen(first.state.session)
      const count = resumed.session.liveData.plays.currentPlay!.runners.length
      const second = playReel(
        scoringReducer(resumed, {
          type: 'DICTATED',
          transcript:
            'The first baseman throws to the catcher at home, too late. The batter is still safe at first.',
          actions: [
            {
              type: 'runnerMovement',
              runner: 1,
              to: '1B',
              fielders: [12, 11],
              locations: [BASES[1], BASES[0]]
            }
          ]
        })
      )
      expect(second.state.dictation?.problem).equals(undefined)
      expect(second.throws.map(t => [t.from, t.to])).deep.equals([[12, 11]])
      for (const state of [second.state, reopen(second.state.session)])
        expect(
          scoringFieldPlayers(state).find(p => p.playerId === 13)!.position
        ).deep.equals(catchPoint)
      const route =
        second.state.session.liveData.plays.currentPlay!.source.teamstation
          .fieldingRoute!
      expect(route.map(hop => hop.player.id)).deep.equals([15, 13, 12, 12, 11])
      expect(second.state.session.liveData.plays.currentPlay!.runners).length(
        count
      )
      expect(second.state.session.liveData.linescore).deep.equals(
        resumed.session.liveData.linescore
      )
      expect(credits(second.state)).deep.equals([])
      expect(
        scoringReducer(second.state, { type: 'UNDO' }).session
      ).deep.equals(resumed.session)
    })
  it('refuses an unsolicited error after a completed FC without saving partial credits', function () {
    const before = game(7, 1)
    const result = playReel(
      scoringReducer(before, {
        type: 'DICTATED',
        transcript:
          "Ground ball to the third baseman for a fielder's choice. The batter is safe at first. The third baseman tags the runner from third out himself at home. The runner from second is safe at third. The third baseman tags the runner from first out himself at second.",
        actions: [
          grounder,
          {
            type: 'runnerMovement',
            runner: 8,
            to: 'home',
            out: true,
            reason: 'Force Out',
            fielders: [15]
          },
          { type: 'runnerMovement', runner: 7, to: '3B', reason: 'Advance' },
          {
            type: 'runnerMovement',
            runner: 6,
            to: '2B',
            out: true,
            reason: 'Force Out',
            fielders: [15]
          },
          { type: 'runnerMovement', runner: 1, to: '1B', reason: 'Advance' },
          { type: 'fieldingPlay', fielders: [15], error: 15 },
          choice
        ]
      })
    )
    expect(result.state.dictation?.problem).not.equals(undefined)
    expect(result.state.session).deep.equals(before.session)
    expect(result.throws).deep.equals([])
  })
  for (const fielders of [[15, 13], undefined])
    it(`retains ${fielders == null ? 'inferred' : 'supplied'} putout credits with a receiver in the preceding sentence`, function () {
      const result = playReel(
        say(
          game(1),
          [
            {
              type: 'runnerMovement',
              runner: 6,
              to: '2B',
              out: true,
              fielders
            },
            { type: 'runnerMovement', runner: 1, to: '1B' }
          ],
          "Ground ball to the third baseman for a fielder's choice. He throws to the second baseman. The runner from first is out at second. The batter is safe at first."
        )
      )
      expect(result.throws.map(t => [t.from, t.to])).deep.equals([[15, 13]])
      expect(credits(result.state)).deep.equals([
        [6, 15, 'f_assist'],
        [6, 13, 'f_putout']
      ])
    })

  it('preserves a later batter Out after reaching first safely', function () {
    const result = playReel(
      say(
        game(1),
        [
          {
            type: 'runnerMovement',
            runner: 6,
            to: '2B',
            out: true,
            fielders: [15, 13]
          },
          {
            type: 'runnerMovement',
            runner: 1,
            to: '2B',
            out: true,
            fielders: [13]
          }
        ],
        "Ground ball to the third baseman for a fielder's choice. The runner from first is out at second on the throw to the second baseman. The batter reaches first, then is tagged out at second by the second baseman."
      )
    )
    expect(result.state.session.liveData.linescore.outs).equals(2)
    expect(credits(result.state)).deep.equals([
      [6, 15, 'f_assist'],
      [6, 13, 'f_putout'],
      [1, 13, 'f_putout']
    ])
  })

  for (const contraction of ["isn't", 'isn’t', "wasn't", "weren't"])
    it(`preserves ${contraction} out as Safe`, function () {
      const result = playReel(
        say(
          game(1),
          [
            { type: 'runnerMovement', runner: 6, to: '2B' },
            { type: 'runnerMovement', runner: 1, to: '1B' }
          ],
          `Ground ball to the third baseman for a fielder's choice. The runner from first ${contraction} out at second. The batter is safe at first.`
        )
      )
      expect(result.state.session.liveData.linescore.outs).equals(0)
      expect(credits(result.state)).deep.equals([])
    })

  it('preserves a contracted negation of collective Safe', function () {
    const result = playReel(
      say(
        game(1),
        [
          {
            type: 'runnerMovement',
            runner: 6,
            to: '2B',
            out: true,
            fielders: [15, 13]
          },
          { type: 'runnerMovement', runner: 1, to: '1B' }
        ],
        "Ground ball to the third baseman for a fielder's choice. It isn't true that all runners are safe. The second baseman retires the runner at second and the batter is safe at first."
      )
    )
    expect(result.state.session.liveData.linescore.outs).equals(1)
    expect(credits(result.state)).deep.equals([
      [6, 15, 'f_assist'],
      [6, 13, 'f_putout']
    ])
  })

  it('animates and stores a resumed late relay without repeating a base advance', function () {
    let session = game(1).session
    for (const action of [
      grounder,
      choice,
      { type: 'runnerMovement', runner: 1, to: '1B' },
      { type: 'runnerMovement', runner: 6, to: '2B' }
    ] as ScoringAction[])
      session = applyAction(session, action).state
    const before = initialScoringState(
      asGameState(JSON.parse(JSON.stringify(session))),
      true
    )
    const count = session.liveData.plays.currentPlay!.runners.length
    const result = playReel(
      scoringReducer(before, {
        type: 'DICTATED',
        transcript:
          'The third baseman throws to the first baseman, too late. The batter is safe at first.',
        actions: [
          { type: 'runnerMovement', runner: 1, to: '1B', fielders: [15, 12] }
        ]
      })
    )
    expect(result.state.dictation?.problem).equals(undefined)
    expect(result.state.dictationQuestion).equals(undefined)
    expect(result.throws.map(t => [t.from, t.to])).deep.equals([[15, 12]])
    expect(result.state.session.liveData.plays.currentPlay!.runners).length(
      count
    )
    expect(credits(result.state)).deep.equals([])
    expect(result.state.session.liveData.linescore).deep.equals(
      before.session.liveData.linescore
    )
    const restored = initialScoringState(
      asGameState(JSON.parse(JSON.stringify(result.state.session)))
    )
    expect(
      scoringFieldPlayers(restored).find(p => p.playerId === 12)!.position
    ).deep.equals(BASES[1])
    expect(scoringReducer(result.state, { type: 'UNDO' }).session).deep.equals(
      before.session
    )
  })

  it('runs a saved FC runner to his putout base before walking off', function () {
    let session = game(2).session
    for (const action of [
      grounder,
      choice,
      { type: 'runnerMovement', runner: 1, to: '1B' }
    ] as ScoringAction[])
      session = applyAction(session, action).state
    const before = initialScoringState(
      asGameState(JSON.parse(JSON.stringify(session))),
      true
    )
    const result = playReel(
      scoringReducer(before, {
        type: 'DICTATED',
        transcript: 'The third baseman tags the runner out at third.',
        actions: [
          {
            type: 'runnerMovement',
            runner: 7,
            to: '3B',
            out: true,
            fielders: [15]
          }
        ]
      })
    )
    expect(result.state.dictation?.problem).equals(undefined)
    expect(result.motions.get(7)).deep.includes(BASES[3])
    expect(result.throws.map(t => [t.from, t.to])).deep.equals([[15, 15]])
    expect(credits(result.state)).deep.equals([[7, 15, 'f_putout']])
  })
  for (const fielders of [[15, 13], undefined])
    it(`preserves a base-only throw at second with ${fielders == null ? 'inferred' : 'explicit'} fielders`, function () {
      const result = playReel(
        say(
          game(1),
          [
            { type: 'runnerMovement', runner: 6, to: '2B', out: true, fielders }
          ],
          "Ground ball to third for a fielder's choice. He throws to second for the out on the runner from first. The batter is safe at first."
        )
      )
      expect(result.throws.map(t => [t.from, t.to])).deep.equals([[15, 13]])
      expect(credits(result.state)).deep.equals([
        [6, 15, 'f_assist'],
        [6, 13, 'f_putout']
      ])
    })

  it('preserves an explicitly dictated batter advance beyond first', function () {
    const result = playReel(
      say(
        game(1),
        [
          {
            type: 'runnerMovement',
            runner: 6,
            to: '2B',
            out: true,
            fielders: [15, 13]
          },
          { type: 'runnerMovement', runner: 1, to: '2B' }
        ],
        "Ground ball to the third baseman for a fielder's choice. The runner from first is out at second on the throw to the second baseman. The batter is safe at second on the throw."
      )
    )
    expect(result.state.session.liveData.linescore.offense.second?.id).equals(1)
    expect(result.state.session.liveData.linescore.offense.first).equals(null)
  })

  it('does not turn a negated collective Safe statement into everyone Safe', function () {
    const result = playReel(
      say(
        game(1),
        [
          {
            type: 'runnerMovement',
            runner: 6,
            to: '2B',
            out: true,
            fielders: [15, 13]
          }
        ],
        "Ground ball to third for a fielder's choice. Not all runners are safe. He throws to second for the force out. The batter is safe at first."
      )
    )
    expect(result.state.session.liveData.linescore.outs).equals(1)
    expect(credits(result.state)).deep.equals([
      [6, 15, 'f_assist'],
      [6, 13, 'f_putout']
    ])
  })

  for (const resultAfterMoves of [false, true])
    it(`counts an earlier home crossing before a tag third out when the model omitted batter Safe, result last ${resultAfterMoves}`, function () {
      const result = playReel(
        say(
          game(6, 2),
          [
            { type: 'runnerMovement', runner: 8, to: 'home' },
            {
              type: 'runnerMovement',
              runner: 7,
              to: '3B',
              out: true,
              fielders: [15]
            }
          ],
          "Grounder to the third baseman for a fielder's choice. The runner on third scores before the runner on second is tagged out at third by the third baseman himself. The batter reaches first safely.",
          resultAfterMoves
        )
      )
      expect(result.state.session.liveData.linescore.teams.away.runs).equals(1)
      expect(credits(result.state)).deep.equals([[7, 15, 'f_putout']])
      expect(result.motions.get(7)).deep.includes(BASES[3])
    })

  for (const resultAfterMoves of [false, true])
    for (const batterSafe of [false, true])
      for (const homeFirst of [false, true])
        it(`counts a crossing only before a nonforce third Out, home first ${homeFirst}, batter Safe ${batterSafe}, result last ${resultAfterMoves}`, function () {
          const before = game(6, 2)
          const home: ScoringAction = {
            type: 'runnerMovement',
            runner: 8,
            to: 'home'
          }
          const tag: ScoringAction = {
            type: 'runnerMovement',
            runner: 7,
            to: '3B',
            out: true,
            fielders: [15, 13],
            locations: [
              { x: -17, z: 20 },
              { x: 4, z: -11 }
            ],
            runnerLocation: { x: 4, z: -11 }
          }
          const moves: ScoringAction[] = [
            ...(batterSafe
              ? [{ type: 'runnerMovement', runner: 1, to: '1B' } as const]
              : []),
            ...(homeFirst ? [home, tag] : [tag, home])
          ]
          const result = playReel(
            say(before, moves, undefined, resultAfterMoves)
          )
          expect(
            result.state.session.liveData.linescore.teams.away.runs
          ).equals(homeFirst ? 1 : 0)
          expect(credits(result.state)).deep.equals([
            [7, 15, 'f_assist'],
            [7, 13, 'f_putout']
          ])
          const play = result.state.session.liveData.plays.allPlays.at(-1)!
          expect(
            play.runners.filter(r => r.movement.runScored === true).length
          ).equals(homeFirst ? 1 : 0)
          expect(result.throws.map(t => [t.from, t.to])).deep.equals([[15, 13]])
          expect(
            scoringReducer(result.state, { type: 'UNDO' }).session
          ).deep.equals(before.session)
          const reopened = initialScoringState(
            asGameState(JSON.parse(JSON.stringify(before.session))),
            true
          )
          expect(
            playReel(say(reopened, moves, undefined, resultAfterMoves)).state
              .session.liveData
          ).deep.equals(result.state.session.liveData)
        })

  for (const resultAfterMoves of [false, true])
    it(`plays an earlier home carrier's late relay once when batter Safe follows the third Out, result last ${resultAfterMoves}`, function () {
      const before = game(6, 2)
      const origin = scoringFieldPlayers(before).find(
        p => p.playerId === 15
      )!.position
      const tag = { x: 4, z: -11 }
      const first = { x: 21, z: -7 }
      const home = { x: 2, z: 3 }
      const result = playReel(
        say(
          before,
          [
            {
              type: 'runnerMovement',
              runner: 8,
              to: 'home',
              fielders: [13, 12, 11],
              locations: [tag, first, home]
            },
            {
              type: 'runnerMovement',
              runner: 7,
              to: '3B',
              out: true,
              fielders: [15, 13],
              locations: [origin, tag],
              runnerLocation: tag
            },
            { type: 'runnerMovement', runner: 1, to: '1B' }
          ],
          undefined,
          resultAfterMoves
        )
      )
      expect(result.throws.map(t => [t.from, t.to])).deep.equals([
        [15, 13],
        [13, 12],
        [12, 11]
      ])
      expect(result.state.session.liveData.linescore.teams.away.runs).equals(1)
      expect(credits(result.state)).deep.equals([
        [7, 15, 'f_assist'],
        [7, 13, 'f_putout']
      ])
      const play = result.state.session.liveData.plays.allPlays.at(-1)!
      expect(play.runners.filter(r => r.details.runner.id === 8)).length(1)
      expect(
        play.source.teamstation.fieldingRoute?.map(h => [
          h.player.id,
          h.location
        ])
      ).deep.equals([
        [15, origin],
        [13, tag],
        [13, tag],
        [12, first],
        [11, home]
      ])
      expect(result.throws.map(t => [t.origin, t.target])).deep.equals([
        [origin, tag],
        [tag, first],
        [first, home]
      ])
      expect(
        scoringReducer(result.state, { type: 'UNDO' }).session
      ).deep.equals(before.session)
    })

  it('does not record or score an FC home crossing after the third out in the shared engine', function () {
    let session = game(6, 2).session
    for (const action of [
      grounder,
      choice,
      { type: 'runnerMovement', runner: 1, to: '1B' },
      { type: 'runnerMovement', runner: 7, to: '3B', out: true, fielders: [15] }
    ] as ScoringAction[]) {
      const applied = applyAction(session, action)
      expect(applied.problems).deep.equals([])
      session = applied.state
    }
    const late = applyAction(session, {
      type: 'runnerMovement',
      runner: 8,
      to: 'home'
    })
    expect(late.problems).deep.equals([])
    expect(late.transitions).deep.equals([])
    expect(late.state.liveData.linescore).deep.equals(
      session.liveData.linescore
    )
    expect(late.state.liveData.plays.currentPlay!.runners).deep.equals(
      session.liveData.plays.currentPlay!.runners
    )
  })

  it('animates a saved FC continuation from the current defender positions', function () {
    let session = game(1).session
    for (const action of [
      grounder,
      choice,
      { type: 'runnerMovement', runner: 1, to: '1B' },
      { type: 'runnerMovement', runner: 6, to: '2B' }
    ] as ScoringAction[]) {
      const applied = applyAction(session, action)
      expect(applied.problems).deep.equals([])
      session = applied.state
    }
    const before = initialScoringState(
      asGameState(JSON.parse(JSON.stringify(session))),
      true
    )
    const origin = scoringFieldPlayers(before).find(
      p => p.playerId === 15
    )!.position
    const result = playReel(
      scoringReducer(before, {
        type: 'DICTATED',
        transcript:
          'The third baseman throws to the second baseman, too late. The runner takes third and the batter takes second safely.',
        actions: [
          { type: 'runnerMovement', runner: 6, to: '3B' },
          { type: 'runnerMovement', runner: 1, to: '2B', fielders: [15, 13] }
        ]
      })
    )
    expect(result.state.dictation?.problem).equals(undefined)
    expect(result.throws.map(t => [t.from, t.to])).deep.equals([[15, 13]])
    expect(result.throws[0].origin).deep.equals(origin)
    expect(result.state.session.liveData.linescore.offense.second?.id).equals(1)
  })

  it('keeps earlier receivers at their catches during every later hop', function () {
    const state = say(game(1), [
      {
        type: 'runnerMovement',
        runner: 6,
        to: '2B',
        out: true,
        fielders: [15, 14, 13, 12],
        locations: [
          { x: -24.72, z: -40.12 },
          { x: 1, z: -30 },
          { x: 2, z: -31 },
          BASES[2]
        ]
      },
      { type: 'runnerMovement', runner: 1, to: '1B' }
    ])
    const throws = [
      state.presentation,
      ...(state.reel ?? []).map(b => b.presentation)
    ].filter(p => p?.kind === 'throw')
    expect(throws).length(3)
    expect(
      throws[2].players.find(p => p.playerId === 14)!.position
    ).deep.equals({ x: 1, z: -30 })
    expect(credits(playReel(state).state)).deep.equals([
      [6, 15, 'f_assist'],
      [6, 14, 'f_assist'],
      [6, 13, 'f_assist'],
      [6, 12, 'f_putout']
    ])
  })

  it('persists a late catch after its Out records when the same sentence includes the next batted play', function () {
    const final = { x: 2, z: -5 }
    const result = playReel(
      say(game(3), [
        {
          type: 'runnerMovement',
          runner: 1,
          to: '1B',
          fielders: [13, 12, 15],
          locations: [BASES[2], BASES[1], final]
        },
        {
          type: 'runnerMovement',
          runner: 7,
          to: '3B',
          out: true,
          fielders: [15]
        },
        {
          type: 'runnerMovement',
          runner: 6,
          to: '2B',
          out: true,
          fielders: [15, 13]
        },
        {
          type: 'ballInPlay',
          contact: 'swing',
          trajectory: 'line_drive',
          fielder: 17
        },
        { type: 'result', eventType: 'single' }
      ])
    )
    const session = asGameState(
      JSON.parse(JSON.stringify(result.state.session))
    )
    const first = session.liveData.plays.allPlays[0]
    expect(
      first.source.teamstation.fieldingRoute!.at(-1)!.location
    ).deep.equals(final)
    expect(first.source.teamstation.fieldingRouteRecordCount).equals(
      first.source.teamstation.runnerActions!.length
    )
    session.liveData.plays.currentPlay = first
    const restored = initialScoringState(session)
    expect(
      scoringFieldPlayers(restored).find(p => p.playerId === 15)!.position
    ).deep.equals(final)
  })
  it('persists the final late catch even when its Safe carrier preceded the Out calls', function () {
    const final = { x: -5, z: -25 }
    const result = playReel(
      say(game(3), [
        {
          type: 'runnerMovement',
          runner: 1,
          to: '1B',
          fielders: [15, 13, 15],
          locations: [{ x: -20, z: -35 }, BASES[2], final]
        },
        { type: 'runnerMovement', runner: 6, to: '2B' },
        {
          type: 'runnerMovement',
          runner: 7,
          to: '3B',
          out: true,
          fielders: [15]
        }
      ])
    )
    expect(result.throws.map(t => [t.from, t.to])).deep.equals([
      [15, 15],
      [15, 13],
      [13, 15]
    ])
    expect(result.throws.at(-1)!.target).deep.equals(final)
    const restored = initialScoringState(
      asGameState(JSON.parse(JSON.stringify(result.state.session)))
    )
    expect(
      scoringFieldPlayers(restored).find(p => p.playerId === 15)!.position
    ).deep.equals(final)
    expect(credits(restored)).deep.equals([[7, 15, 'f_putout']])
  })
  for (const example of choiceRelayPhrases)
    it(`completes the explicit relay and every credit from a partial model reply: ${example.said}`, function () {
      const result = playReel(say(game(example.mask), [], example.said))
      expect(result.throws.map(t => [t.from, t.to])).deep.equals(example.throws)
      expect(credits(result.state)).deep.equals(example.credits)
      const endpoints = new Map<number, unknown>()
      for (const hop of result.throws) {
        if (endpoints.has(hop.from))
          expect(hop.origin).deep.equals(endpoints.get(hop.from))
        endpoints.set(hop.to, hop.target)
      }
      const restored = initialScoringState(
        asGameState(JSON.parse(JSON.stringify(result.state.session)))
      )
      for (const [id, point] of endpoints)
        expect(
          scoringFieldPlayers(restored).find(p => p.playerId === id)!.position
        ).deep.equals(point)
      for (const id of [6, 7, 8].filter(
        id => (example.mask & (1 << (id - 6))) !== 0
      ))
        expect(
          result.motions.get(id),
          `runner ${id} reaches his next base before leaving`
        ).deep.includes(BASES[(id - 4) % 4])
    })
  function permutations(ids: number[]): number[][] {
    return ids.length === 0
      ? [[]]
      : ids.flatMap(id =>
          permutations(ids.filter(other => other !== id)).map(rest => [
            id,
            ...rest
          ])
        )
  }
  for (let mask = 1; mask < 8; mask++)
    for (const startingOuts of [0, 1, 2]) {
      const runners = [6, 7, 8].filter(id => (mask & (1 << (id - 6))) !== 0)
      for (let subset = 0; subset < 1 << runners.length; subset++)
        for (const order of permutations(runners))
          for (const resultAfterMoves of [false, true])
            it(`resolves bases ${mask}, starting outs ${startingOuts}, out subset ${subset}, calls ${order.join(',')}, result last ${resultAfterMoves}`, function () {
              const outIds = runners.filter(
                (_, index) => (subset & (1 << index)) !== 0
              )
              const actions: ScoringAction[] = [
                { type: 'runnerMovement', runner: 1, to: '1B' }
              ]
              let outs = startingOuts
              for (const id of order) {
                if (outs === 3) break
                const isOut = outIds.includes(id)
                actions.push({
                  type: 'runnerMovement',
                  runner: id,
                  to: (['2B', '3B', 'home'] as const)[id - 6],
                  ...(isOut ? { out: true, fielders: [15] } : {})
                })
                if (isOut) outs++
              }
              const before = game(mask, startingOuts)
              const result = playReel(
                say(before, actions, undefined, resultAfterMoves)
              )
              const play =
                result.state.session.pending == null
                  ? result.state.session.liveData.plays.allPlays.at(-1)!
                  : result.state.session.liveData.plays.currentPlay!
              expect(result.state.session.liveData.linescore.outs).equals(
                outs === 3 ? 0 : outs
              )
              const outOrder = order
                .filter(id => outIds.includes(id))
                .slice(0, 3 - startingOuts)
              const thirdOut =
                startingOuts + outOrder.length === 3
                  ? outOrder.at(-1)
                  : undefined
              const forcedThird =
                thirdOut != null &&
                [6, 7, 8]
                  .filter(id => id < thirdOut)
                  .every(
                    id =>
                      runners.includes(id) &&
                      !outOrder.slice(0, -1).includes(id)
                  )
              const reachedHome = actions.some(
                a =>
                  a.type === 'runnerMovement' &&
                  a.runner === 8 &&
                  a.out !== true
              )
              expect(
                result.state.session.liveData.linescore.teams.away.runs
              ).equals(reachedHome && !forcedThird ? 1 : 0)
              const fielded = play.runners.flatMap(r =>
                r.credits
                  .filter(c => c.credit === 'f_fielded_ball')
                  .map(c => [r.details.runner.id, c.player.id])
              )
              expect(fielded.length).at.most(1)
              for (const row of fielded) expect(row).deep.equals([1, 15])
              expect(play.matchup.batter.id).equals(1)
              expect(
                play.runners.some(
                  r => r.details.runner.id === 1 && r.movement.isOut
                )
              ).equals(false)
              expect(credits(result.state)).deep.equals(
                order
                  .filter(id => outIds.includes(id))
                  .slice(0, 3 - startingOuts)
                  .map(id => [id, 15, 'f_putout'])
              )
              expect(result.throws.map(t => [t.from, t.to])).deep.equals(
                order
                  .filter(id => outIds.includes(id))
                  .slice(0, 3 - startingOuts)
                  .map(() => [15, 15])
              )
              const undone = scoringReducer(result.state, { type: 'UNDO' })
              expect(undone.session).deep.equals(before.session)
              const reloaded = initialScoringState(
                asGameState(JSON.parse(JSON.stringify(before.session))),
                true
              )
              const replay = playReel(
                say(reloaded, actions, undefined, resultAfterMoves)
              ).state.session
              expect(replay.liveData.linescore).deep.equals(
                result.state.session.liveData.linescore
              )
              const replayPlay =
                replay.pending == null
                  ? replay.liveData.plays.allPlays.at(-1)!
                  : replay.liveData.plays.currentPlay!
              expect(replayPlay.runners).deep.equals(play.runners)
              expect(replayPlay.source).deep.equals(play.source)
            })
    }

  for (let mask = 1; mask < 8; mask++)
    it(`keeps explicit Safe calls without inventing an Out or asking again, bases ${mask}`, function () {
      const moves: ScoringAction[] = [8, 7, 6]
        .filter(id => (mask & (1 << (id - 6))) !== 0)
        .map(runner => ({
          type: 'runnerMovement',
          runner,
          to: (['2B', '3B', 'home'] as const)[runner - 6]
        }))
      const result = playReel(say(game(mask), moves))
      expect(credits(result.state)).deep.equals([])
      expect(result.state.session.liveData.linescore.outs).equals(0)
      expect(result.state.session.liveData.linescore.offense.first?.id).equals(
        1
      )
    })

  it('keeps successive putouts by the same holder at their actual bases', function () {
    const result = playReel(
      say(game(3), [
        { type: 'runnerMovement', runner: 1, to: '1B' },
        {
          type: 'runnerMovement',
          runner: 7,
          to: '3B',
          out: true,
          fielders: [15]
        },
        {
          type: 'runnerMovement',
          runner: 6,
          to: '2B',
          out: true,
          fielders: [15]
        }
      ])
    )
    expect(result.throws.map(t => [t.from, t.to])).deep.equals([
      [15, 15],
      [15, 15]
    ])
    expect(result.throws[1].origin).deep.equals(BASES[3])
    expect(result.throws[1].target).deep.equals(BASES[2])
    expect(credits(result.state)).deep.equals([
      [7, 15, 'f_putout'],
      [6, 15, 'f_putout']
    ])
  })

  it('animates an all-Safe relay without inventing a defensive credit', function () {
    const route = [
      { id: 15, point: { x: -20, z: -35 } },
      { id: 13, point: { ...BASES[2] } },
      { id: 12, point: { ...BASES[1] } }
    ]
    const result = playReel(
      say(game(1), [
        {
          type: 'runnerMovement',
          runner: 1,
          to: '1B',
          fielders: route.map(hop => hop.id),
          locations: route.map(hop => hop.point)
        },
        { type: 'runnerMovement', runner: 6, to: '2B' }
      ])
    )
    expect(result.throws.map(t => [t.from, t.to])).deep.equals([
      [15, 13],
      [13, 12]
    ])
    expect(credits(result.state)).deep.equals([])
    expect(result.state.session.liveData.linescore.outs).equals(0)
    const restored = initialScoringState(
      asGameState(JSON.parse(JSON.stringify(result.state.session)))
    )
    expect(
      scoringFieldPlayers(restored).find(p => p.playerId === 12)!.position
    ).deep.equals(BASES[1])
  })
})
