import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { ScoringAction } from '../../common/scoring/actions'
import { applyAction } from '../../common/scoring/session'
import { asGameState } from '../../common/scoring/state'
import { completeMotions } from '../../test/scoringHelpers'
import { BASES } from '../field/fieldModel'
import { fieldStageInstruction } from './battedBallField'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { scoringFieldPlayers } from './scoringMotion'
import { baseIds, playerRef } from './scoringSelectors'
import type { ScoringEvent, ScoringState } from './scoringTypes'

function initial(mask = 7, outs = 0): ScoringState {
  const session = createDevelopmentSession(gameFixture, [], [])
  for (const [index, key] of (['first', 'second', 'third'] as const).entries())
    session.liveData.linescore.offense[key] =
      (mask & (1 << index)) !== 0 ? playerRef(session, index + 6) : null
  session.liveData.linescore.outs = outs
  return initialScoringState(session)
}
function step(state: ScoringState, event: ScoringEvent): ScoringState {
  return completeMotions(scoringReducer(state, event))
}
function relay(mask = 7, outs = 0, receivers = [13, 12]): ScoringState {
  let state = step(initial(mask, outs), {
    type: 'OUTCOME',
    outcome: "Fielder's Choice"
  })
  state = step(state, {
    type: 'FIELDER',
    id: 15,
    point: { x: -20, z: -35 },
    generation: state.generation
  })
  state = step(state, {
    type: 'TRAJECTORY',
    angle: 20,
    generation: state.generation
  })
  expect(state.phase).equals('chooseDefender')
  expect(state.runnerAction!.purpose).equals('fieldersChoice')
  for (const id of receivers)
    state = step(state, {
      type: 'DEFENDER',
      id,
      point: { x: id, z: -25 },
      generation: state.generation
    })
  expect(state.session.liveData.linescore.outs).equals(outs)
  return state
}
function offered(mask = 7, outs = 0, receivers?: number[]): ScoringState {
  const state = relay(mask, outs, receivers)
  return step(state, { type: 'DEFENDER', generation: state.generation })
}
function choose(
  state: ScoringState,
  id: number,
  decision: 'safe' | 'out',
  putout = state.pendingPlay!.fieldersChoice!.route.length - 1
): ScoringState {
  return step(state, {
    type: 'CHOICE_DECIDE',
    id,
    decision,
    ...(decision === 'out' ? { putout } : {}),
    generation: state.generation
  })
}
function current(
  state: ScoringState
): NonNullable<ScoringState['session']['liveData']['plays']['currentPlay']> {
  return state.session.pending != null
    ? state.session.liveData.plays.currentPlay!
    : state.session.liveData.plays.allPlays.at(-1)!
}

describe('fielder choice runner calls', function () {
  for (const [mask, prior] of [
    [5, 6],
    [6, 7],
    [7, 6],
    [7, 7]
  ])
    for (const outs of [0, 1, 2])
      it(`resolves Out calls after preserved home advance ${prior}, mask ${mask}, outs ${outs}`, function () {
        const applied = applyAction(relay(mask, outs).session, {
          type: 'runnerMovement',
          runner: prior,
          to: 'home'
        })
        expect(applied.problems).deep.equals([])
        let state = initialScoringState(
          asGameState(JSON.parse(JSON.stringify(applied.state)))
        )
        state = step(state, {
          type: 'THROWER',
          id: 15,
          point: { x: 0, z: -25 },
          generation: state.generation
        })
        state = step(state, { type: 'DEFENDER', generation: state.generation })
        const unresolved = state
          .pendingPlay!.fieldersChoice!.runners.filter(
            move => move.decision == null
          )
          .map(move => move.playerId)
        for (const id of unresolved) state = choose(state, id, 'out', 0)
        expect(state.pendingPlay?.fieldersChoice).equals(undefined)
        expect(current(state).runners.filter(row => row.movement.isOut)).length(
          Math.min(unresolved.length, 3 - outs)
        )
      })
  it('keeps a run before a resumed multi-base tag third out', function () {
    const applied = applyAction(relay(7, 2).session, {
      type: 'runnerMovement',
      runner: 6,
      to: '3B'
    })
    expect(applied.problems).deep.equals([])
    let state = initialScoringState(applied.state)
    state = step(state, {
      type: 'THROWER',
      id: 15,
      point: { x: 0, z: -25 },
      generation: state.generation
    })
    state = step(state, { type: 'DEFENDER', generation: state.generation })
    state = choose(state, 8, 'safe')
    state = choose(state, 7, 'out', 0)
    expect(state.phase).equals('ready')
    expect(state.session.liveData.linescore.teams.away.runs).equals(1)
    const out = current(state).runners.find(row => row.movement.isOut)!
    expect([
      out.movement.start,
      out.movement.end,
      out.movement.forceOut
    ]).deep.equals([2, 4, false])
  })
  it('keeps a preserved home run when an earlier out removes the home force', function () {
    const applied = applyAction(relay(7, 1).session, {
      type: 'runnerMovement',
      runner: 7,
      to: 'home'
    })
    expect(applied.problems).deep.equals([])
    let state = initialScoringState(
      asGameState(JSON.parse(JSON.stringify(applied.state)))
    )
    state = step(state, {
      type: 'THROWER',
      id: 15,
      point: { x: 0, z: -25 },
      generation: state.generation
    })
    state = step(state, { type: 'DEFENDER', generation: state.generation })
    state = choose(state, 6, 'out', 0)
    state = choose(state, 8, 'out', 0)
    expect(state.phase).equals('ready')
    expect(state.session.liveData.linescore.teams.away.runs).equals(1)
    expect(
      current(state)
        .runners.filter(row => row.movement.isOut)
        .map(row => row.movement.forceOut)
    ).deep.equals([true, false])
  })
  for (const outs of [0, 1, 2])
    for (const order of [
      [7, 8],
      [8, 7]
    ])
      it(`settles a preserved home crossing before queued outs ${order.join(',')}, starting outs ${outs}`, function () {
        const applied = applyAction(relay(7, outs).session, {
          type: 'runnerMovement',
          runner: 6,
          to: 'home'
        })
        expect(applied.problems).deep.equals([])
        let state = initialScoringState(
          asGameState(JSON.parse(JSON.stringify(applied.state)))
        )
        state = step(state, {
          type: 'THROWER',
          id: 15,
          point: { x: 0, z: -25 },
          generation: state.generation
        })
        state = step(state, { type: 'DEFENDER', generation: state.generation })
        for (const id of order) state = choose(state, id, 'out', 0)
        expect(state.pendingPlay?.fieldersChoice).equals(undefined)
        expect(state.session.liveData.linescore.teams.away.runs).equals(
          outs === 2 && order[0] === 8 ? 0 : 1
        )
        expect(
          current(state)
            .runners.filter(row => row.movement.isOut)
            .map(row => [row.details.runner.id, row.movement.forceOut])
        ).deep.equals(
          order.slice(0, 3 - outs).map(id => [id, id === 8 && order[0] === 8])
        )
      })
  for (const [batterTo, destination] of [
    [2, '2B'],
    [3, '3B'],
    [4, 'home']
  ] as const)
    for (const outs of [0, 1, 2])
      it(`preserves a saved batter advance to ${batterTo} with ${outs} outs`, function () {
        const applied = applyAction(relay(3, outs).session, {
          type: 'runnerMovement',
          runner: 1,
          to: destination
        })
        expect(applied.problems).deep.equals([])
        let state = initialScoringState(
          asGameState(JSON.parse(JSON.stringify(applied.state)))
        )
        state = step(state, {
          type: 'THROWER',
          id: 15,
          point: { x: 0, z: -25 },
          generation: state.generation
        })
        expect(
          scoringFieldPlayers(state).find(player => player.playerId === 1)!
            .position
        ).deep.equals(BASES[batterTo % 4])
        state = step(state, {
          type: 'DEFENDER',
          id: 13,
          point: { x: 13, z: -25 },
          generation: state.generation
        })
        state = step(state, { type: 'DEFENDER', generation: state.generation })
        const preview = scoringFieldPlayers(state).find(
          player => player.playerId === 1
        )!
        expect([
          preview.runnerBase,
          preview.position,
          preview.target
        ]).deep.equals([batterTo, BASES[batterTo % 4], BASES[batterTo % 4]])
        expect(fieldStageInstruction(state)).not.includes('safe at first')
        const runners = state.pendingPlay!.fieldersChoice!.runners
        expect(runners.map(move => move.to)).deep.equals(
          batterTo === 2 ? [3, 4] : [4, 4]
        )
        for (const runner of runners)
          state = choose(state, runner.playerId, 'safe')
        expect(baseIds(state.session)).deep.equals(
          batterTo === 2
            ? [null, 1, 6]
            : batterTo === 3
              ? [null, null, 1]
              : [null, null, null]
        )
        expect(state.session.liveData.linescore.teams.away.runs).equals(
          batterTo - 1
        )
        expect(current(state).source.teamstation.fieldingRoute).length(2)
        expect(state.session.liveData.linescore.outs).equals(outs)
      })
  for (const outs of [0, 1])
    for (const to of ['1B', '2B', '3B', 'home'] as const)
      it(`retains an already retired batter at ${to}, starting outs ${outs}`, function () {
        let session = relay(3, outs).session
        for (const action of [
          { type: 'runnerMovement', runner: 1, to },
          { type: 'runnerMovement', runner: 1, to, out: true, fielders: [15] }
        ] as ScoringAction[]) {
          const applied = applyAction(session, action)
          expect(applied.problems).deep.equals([])
          session = applied.state
        }
        let state = initialScoringState(
          asGameState(JSON.parse(JSON.stringify(session)))
        )
        state = step(state, {
          type: 'THROWER',
          id: 15,
          point: { x: 0, z: -25 },
          generation: state.generation
        })
        state = step(state, {
          type: 'DEFENDER',
          id: 13,
          point: { x: 13, z: -25 },
          generation: state.generation
        })
        state = step(state, { type: 'DEFENDER', generation: state.generation })
        expect(
          scoringFieldPlayers(state).some(player => player.playerId === 1)
        ).equals(false)
        expect(fieldStageInstruction(state)).not.includes('batter is safe')
        state = choose(state, 6, 'safe')
        state = choose(state, 7, 'safe')
        expect(baseIds(state.session)).deep.equals([null, 6, 7])
        expect(state.session.liveData.linescore.outs).equals(outs + 1)
        expect(
          current(state).source.teamstation.fieldingRoute!.map(
            hop => hop.player.id
          )
        ).deep.equals([15, 13])
        let replay = session
        for (const action of JSON.parse(
          JSON.stringify(state.log)
        ) as ScoringAction[]) {
          const applied = applyAction(replay, action)
          expect(applied.problems).deep.equals([])
          replay = applied.state
        }
        expect(JSON.parse(JSON.stringify(replay.liveData))).deep.equals(
          JSON.parse(JSON.stringify(state.session.liveData))
        )
      })
  it('keeps the full relay on an Out when the batter was already retired', function () {
    const advanced = applyAction(relay(3).session, {
      type: 'runnerMovement',
      runner: 1,
      to: '2B'
    })
    expect(advanced.problems).deep.equals([])
    const applied = applyAction(advanced.state, {
      type: 'runnerMovement',
      runner: 1,
      to: '2B',
      out: true,
      fielders: [15]
    })
    expect(applied.problems).deep.equals([])
    let state = initialScoringState(applied.state)
    state = step(state, {
      type: 'THROWER',
      id: 15,
      point: { x: 0, z: -25 },
      generation: state.generation
    })
    state = step(state, {
      type: 'DEFENDER',
      id: 13,
      point: { x: 13, z: -25 },
      generation: state.generation
    })
    state = step(state, { type: 'DEFENDER', generation: state.generation })
    state = choose(state, 6, 'out', 0)
    state = choose(state, 7, 'out', 1)
    expect(
      current(state).source.teamstation.fieldingRoute!.map(hop => hop.player.id)
    ).deep.equals([15, 13])
    expect(current(state).runners.filter(row => row.movement.isOut)).length(3)
    expect(baseIds(state.session)).not.includes(1)
  })
  it('presents a live pending runner when a retired batter and prior home arrival are absent', function () {
    let session = relay(3).session
    for (const action of [
      { type: 'runnerMovement', runner: 1, to: '2B' },
      {
        type: 'runnerMovement',
        runner: 1,
        to: '2B',
        out: true,
        fielders: [15]
      },
      { type: 'runnerMovement', runner: 6, to: 'home' }
    ] as ScoringAction[]) {
      const applied = applyAction(session, action)
      expect(applied.problems).deep.equals([])
      session = applied.state
    }
    let state = initialScoringState(session)
    expect(state.runnerAction!.playerId).equals(7)
    state = step(state, {
      type: 'THROWER',
      id: 15,
      point: { x: 0, z: -25 },
      generation: state.generation
    })
    state = step(state, {
      type: 'DEFENDER',
      id: 13,
      point: { x: 13, z: -25 },
      generation: state.generation
    })
    state = step(state, { type: 'DEFENDER', generation: state.generation })
    state = choose(state, 7, 'safe')
    expect(state.pendingPlay?.fieldersChoice).equals(undefined)
    expect(baseIds(state.session)).not.includes(1)
    expect(state.session.liveData.linescore.teams.away.runs).equals(2)
    expect(current(state).source.teamstation.fieldingRoute).length(2)
  })
  it('validates explicit whole relay metadata and retains legacy Safe batter routes', function () {
    const session = relay(3).session
    const route = [15, 13].map(id => ({ id, point: { x: id, z: -25 } }))
    const explicit = applyAction(session, {
      type: 'runnerMovement',
      runner: 1,
      to: '1B',
      fieldingRoute: route
    })
    expect(explicit.problems).deep.equals([])
    const legacy = applyAction(session, {
      type: 'runnerMovement',
      runner: 1,
      to: '1B',
      fielders: route.map(hop => hop.id),
      locations: route.map(hop => hop.point)
    })
    expect(legacy.problems).deep.equals([])
    expect(legacy.state.liveData).deep.equals(explicit.state.liveData)
    for (const fieldingRoute of [
      [],
      [{ id: 999, point: { x: 0, z: 0 } }],
      [{ id: 15, point: { x: Infinity, z: 0 } }]
    ]) {
      const refused = applyAction(session, {
        type: 'runnerMovement',
        runner: 1,
        to: '1B',
        fieldingRoute
      })
      expect(refused.problems.length).greaterThan(0)
      expect(refused.state).deep.equals(session)
    }
    expect(
      applyAction(initial().session, {
        type: 'runnerMovement',
        runner: 1,
        to: '1B',
        fieldingRoute: route
      }).problems.length
    ).greaterThan(0)
    expect(
      applyAction(session, {
        type: 'runnerMovement',
        runner: 1,
        to: '1B',
        fielders: [15],
        locations: []
      }).problems.length
    ).greaterThan(0)
  })
  for (const outs of [0, 1, 2])
    for (const reverse of [false, true])
      for (const outMask of [0, 1, 2, 3])
        it(`resolves saved pending corrections, outs ${outs}, reverse ${String(reverse)}, out subset ${outMask}`, function () {
          let session = relay(3, outs).session
          for (const action of [
            { type: 'runnerMovement', runner: 6, to: '3B' },
            { type: 'runnerMovement', runner: 1, to: 'home' },
            { type: 'runnerMovement', runner: 1, to: '1B' }
          ] as ScoringAction[]) {
            const applied = applyAction(session, action)
            expect(applied.problems).deep.equals([])
            session = applied.state
          }
          let state = initialScoringState(
            asGameState(JSON.parse(JSON.stringify(session)))
          )
          state = step(state, {
            type: 'THROWER',
            id: 15,
            point: { x: 0, z: -25 },
            generation: state.generation
          })
          state = step(state, {
            type: 'DEFENDER',
            generation: state.generation
          })
          for (const id of reverse ? [7, 6] : [6, 7])
            state = choose(
              state,
              id,
              (outMask & (1 << (id - 6))) !== 0 ? 'out' : 'safe',
              0
            )
          expect(state.pendingPlay?.fieldersChoice).equals(undefined)
          expect(current(state).count.outs).equals(
            Math.min(3, outs + (outMask & 1) + ((outMask >> 1) & 1))
          )
          expect(state.session.liveData.linescore.teams.away.runs).equals(0)
        })
  it('settles a blocked Safe base call before an earlier home crossing and tag third out', function () {
    let session = relay(7, 1).session
    for (const action of [
      { type: 'runnerMovement', runner: 6, to: '3B' },
      { type: 'runnerMovement', runner: 1, to: 'home' },
      { type: 'runnerMovement', runner: 1, to: '1B' },
      {
        type: 'runnerMovement',
        runner: 1,
        to: '1B',
        out: true,
        fielders: [15]
      },
      { type: 'runnerMovement', runner: 8, to: 'home' }
    ] as ScoringAction[]) {
      const applied = applyAction(session, action)
      expect(applied.problems).deep.equals([])
      session = applied.state
    }
    let state = initialScoringState(session)
    state = step(state, {
      type: 'THROWER',
      id: 15,
      point: { x: 0, z: -25 },
      generation: state.generation
    })
    state = step(state, { type: 'DEFENDER', generation: state.generation })
    state = choose(state, 6, 'out', 0)
    state = choose(state, 7, 'safe')
    expect(state.pendingPlay?.fieldersChoice).equals(undefined)
    expect(state.session.liveData.linescore.teams.away.runs).equals(1)
    expect(
      current(state)
        .runners.filter(row => row.movement.isOut)
        .at(-1)!.movement.forceOut
    ).equals(false)
  })
  it('credits the initial putout before a longer onward relay', function () {
    let state = offered(3, 0, [14, 13])
    state = choose(state, 7, 'out', 0)
    state = choose(state, 6, 'out', 2)
    expect(
      current(state)
        .runners.filter(row => row.movement.isOut)
        .map(row =>
          row.credits.map(credit => [credit.player.id, credit.credit])
        )
    ).deep.equals([
      [[15, 'f_putout']],
      [
        [15, 'f_assist'],
        [14, 'f_assist'],
        [13, 'f_putout']
      ]
    ])
  })
  it('credits the same receiver for a force and subsequent tag without a throw', function () {
    let state = offered(3, 0, [13])
    state = choose(state, 6, 'out', 1)
    state = choose(state, 7, 'out', 1)
    expect(
      current(state)
        .runners.filter(row => row.movement.isOut)
        .map(row =>
          row.credits.map(credit => [credit.player.id, credit.credit])
        )
    ).deep.equals([
      [
        [15, 'f_assist'],
        [13, 'f_putout']
      ],
      [[13, 'f_putout']]
    ])
  })
  for (const outs of [0, 1, 2])
    it(`resumes a preserved multi-base trailing advance with ${outs} outs`, function () {
      const before = relay(3, outs)
      const applied = applyAction(before.session, {
        type: 'runnerMovement',
        runner: 6,
        to: '3B'
      })
      expect(applied.problems).deep.equals([])
      let state = initialScoringState(
        asGameState(JSON.parse(JSON.stringify(applied.state)))
      )
      state = step(state, {
        type: 'THROWER',
        id: 15,
        point: { x: 0, z: -25 },
        generation: state.generation
      })
      state = step(state, { type: 'DEFENDER', generation: state.generation })
      expect(
        state.pendingPlay!.fieldersChoice!.runners.map(move => [
          move.playerId,
          move.to,
          move.decision
        ])
      ).deep.equals([
        [6, 3, 'safe'],
        [7, 4, undefined]
      ])
      state = choose(state, 7, 'safe')
      expect(state.phase).equals('correctionWindow')
      expect(baseIds(state.session)).deep.equals([1, null, 6])
      expect(state.session.liveData.linescore.teams.away.runs).equals(1)
      expect(state.session.liveData.linescore.outs).equals(outs)
    })
  for (const allSafe of [false, true])
    it(`persists the entire relay with ${allSafe ? 'all Safe calls' : 'an onward Safe throw'}, without extra credits`, function () {
      let state = offered(3, 0, [13, 15])
      const route = state.pendingPlay!.fieldersChoice!.route
      state = choose(state, 6, allSafe ? 'safe' : 'out', 1)
      state = choose(state, 7, 'safe')
      const defenders = scoringFieldPlayers(state)
      for (const id of new Set(route.map(hop => hop.id))) {
        const end = route.findLast(hop => hop.id === id)!.point
        const defender = defenders.find(player => player.playerId === id)!
        expect([defender.position, defender.target]).deep.equals([end, end])
      }
      const restored = asGameState(JSON.parse(JSON.stringify(state.session)))
      expect(
        restored.liveData.plays.currentPlay!.source.teamstation.fieldingRoute!.map(
          hop => [hop.player.id, hop.location]
        )
      ).deep.equals(route.map(hop => [hop.id, hop.point]))
      expect(
        current(state)
          .runners.flatMap(row => row.credits)
          .filter(
            credit => credit.player.id === 15 && credit.credit === 'f_putout'
          )
      ).length(0)
      expect(current(state).runners.filter(row => row.movement.isOut)).length(
        allSafe ? 0 : 1
      )
    })
  it('lets a later runner action override the completed whole-play relay positions', function () {
    let state = offered(3, 0, [13, 15])
    state = choose(state, 6, 'safe')
    state = choose(state, 7, 'safe')
    const route = current(state).source.teamstation.fieldingRoute
    const applied = applyAction(state.session, {
      type: 'runnerMovement',
      runner: 6,
      to: '3B',
      out: true,
      fielders: [13, 15],
      locations: [
        { x: -5, z: -15 },
        { x: -18, z: -19 }
      ]
    })
    expect(applied.problems).deep.equals([])
    state = {
      ...state,
      session: asGameState(JSON.parse(JSON.stringify(applied.state)))
    }
    const defender = scoringFieldPlayers(state).find(
      player => player.playerId === 15
    )!
    expect([defender.position, defender.target]).deep.equals([
      { x: -18, z: -19 },
      { x: -18, z: -19 }
    ])
    expect(current(state).source.teamstation.fieldingRoute).deep.equals(route)
  })
  it('asks who made an out, supports cancellation, and guards invalid or backwards selections', function () {
    let state = offered(3)
    const out: ScoringEvent = {
      type: 'CHOICE_DECIDE',
      id: 6,
      decision: 'out',
      generation: state.generation
    }
    state = step(state, out)
    expect(state.pendingPlay!.fieldersChoice!.choosingPutout).equals(6)
    expect(state.pendingPlay!.fieldersChoice!.calls).deep.equals([])
    expect(scoringReducer(state, out)).equals(state)
    expect(choose(state, 7, 'safe')).equals(state)
    for (const putout of [-1, 0.5, 3, NaN])
      expect(scoringReducer(state, { ...out, putout })).equals(state)
    expect(
      scoringReducer(state, { ...out, decision: 'safe', putout: 1 })
    ).equals(state)
    expect(
      scoringReducer(state, { type: 'CHOICE_CANCEL', generation: 99 })
    ).equals(state)
    const readOnly = { ...state, readOnly: true }
    expect(
      scoringReducer(readOnly, {
        type: 'CHOICE_CANCEL',
        generation: state.generation
      })
    ).equals(readOnly)
    state = step(state, { type: 'CHOICE_CANCEL', generation: state.generation })
    expect(state.pendingPlay!.fieldersChoice!.choosingPutout).equals(undefined)
    expect(
      scoringReducer(state, {
        type: 'CHOICE_CANCEL',
        generation: state.generation
      })
    ).equals(state)
    state = choose(state, 6, 'out', 1)
    expect(choose(state, 7, 'out', 0)).equals(state)
    state = choose(state, 7, 'out', 1)
    expect(state.session.liveData.linescore.outs).equals(2)
  })
  it('records an unassisted out immediately when there is only one fielder', function () {
    let state = offered(1, 0, [])
    state = step(state, {
      type: 'CHOICE_DECIDE',
      id: 6,
      decision: 'out',
      generation: state.generation
    })
    expect(state.phase).equals('correctionWindow')
    expect(
      current(state)
        .runners.find(row => row.movement.isOut)!
        .credits.map(credit => [credit.player.id, credit.credit])
    ).deep.equals([[15, 'f_putout']])
  })
  it('undoes putout selection and rejects the previous picker generation', function () {
    let state = offered(3)
    state = step(state, {
      type: 'CHOICE_DECIDE',
      id: 6,
      decision: 'out',
      generation: state.generation
    })
    const oldGeneration = state.generation
    state = choose(state, 6, 'out', 1)
    state = step(state, { type: 'UNDO' })
    expect(state.pendingPlay!.fieldersChoice!.choosingPutout).equals(6)
    expect(state.pendingPlay!.fieldersChoice!.calls).deep.equals([])
    expect(
      scoringReducer(state, {
        type: 'CHOICE_DECIDE',
        id: 6,
        decision: 'out',
        putout: 1,
        generation: oldGeneration
      })
    ).equals(state)
    state = step(state, { type: 'CHOICE_CANCEL', generation: state.generation })
    state = choose(state, 6, 'safe')
    state = choose(state, 7, 'safe')
    expect(state.phase).equals('correctionWindow')
  })
  it('refuses incomplete or unknown-fielder choice routes', function () {
    const state = relay().session
    for (const action of [
      {
        type: 'runnerMovement',
        runner: 1,
        to: '1B',
        fielders: [],
        locations: []
      },
      {
        type: 'runnerMovement',
        runner: 1,
        to: '1B',
        fielders: [15],
        locations: []
      },
      {
        type: 'runnerMovement',
        runner: 1,
        to: '1B',
        fielders: [99],
        locations: [{ x: 0, z: 0 }]
      }
    ] as ScoringAction[])
      expect(applyAction(state, action).problems).not.deep.equals([])
  })
  for (const mask of [1, 3])
    it(`resumes choice ${mask} after a runner was already retired, without asking about that runner again`, function () {
      const before = relay(mask)
      const applied = applyAction(before.session, {
        type: 'runnerMovement',
        runner: 6,
        to: '2B',
        out: true,
        fielders: [15, 13]
      })
      expect(applied.problems).deep.equals([])
      let state = initialScoringState(applied.state)
      state = step(state, {
        type: 'THROWER',
        id: 15,
        point: { x: -20, z: -35 },
        generation: state.generation
      })
      state = step(state, { type: 'DEFENDER', generation: state.generation })
      if (mask === 3) {
        expect(
          state.pendingPlay!.fieldersChoice!.runners.map(move => move.playerId)
        ).deep.equals([7])
        state = choose(state, 7, 'safe')
      }
      expect(state.phase).equals('correctionWindow')
      expect(state.session.liveData.linescore.outs).equals(1)
      expect(baseIds(state.session)).deep.equals([
        1,
        null,
        mask === 3 ? 7 : null
      ])
      expect(current(state).runners.filter(row => row.movement.isOut)).length(1)
    })
  it('keeps a run before a tag third out after an earlier out removes the force', function () {
    let state = offered(7, 1)
    state = choose(state, 8, 'safe')
    state = choose(state, 6, 'out')
    state = choose(state, 7, 'out')
    expect(state.phase).equals('ready')
    expect(state.session.liveData.linescore.teams.away.runs).equals(1)
    expect(
      current(state)
        .runners.filter(row => row.movement.isOut)
        .map(row => row.movement.forceOut)
    ).deep.equals([true, false])
    expect(
      current(state).runners.find(row => row.details.runner.id === 8)!.movement
        .runScored
    ).equals(true)
  })
  it('retains prior Safe calls when resuming a partially resolved choice', function () {
    let session = relay().session
    for (const action of [
      {
        type: 'runnerMovement',
        runner: 6,
        to: '2B',
        out: true,
        fielders: [15, 13]
      },
      { type: 'runnerMovement', runner: 7, to: '3B' },
      { type: 'runnerMovement', runner: 8, to: 'home' }
    ] as ScoringAction[]) {
      const applied = applyAction(session, { ...action })
      expect(applied.problems).deep.equals([])
      session = applied.state
    }
    let state = initialScoringState(session)
    state = step(state, {
      type: 'THROWER',
      id: 15,
      point: { x: 0, z: -25 },
      generation: state.generation
    })
    state = step(state, { type: 'DEFENDER', generation: state.generation })
    expect(state.phase).equals('correctionWindow')
    expect(baseIds(state.session)).deep.equals([1, null, 7])
    expect(state.session.liveData.linescore.teams.away.runs).equals(1)
    expect(state.session.liveData.linescore.outs).equals(1)
  })
  for (const tapped of [false, true])
    it(`credits the third-base and second-base receivers for their own putouts in a 6–5–4 choice (${tapped ? 'tapped' : 'dragged'})`, function () {
      const setup = initial(3)
      const defense = setup.session.liveData.linescore.defense
      const short = defense.SS!.id
      const third = defense['3B']!.id
      const second = defense['2B']!.id
      let state = step(setup, { type: 'OUTCOME', outcome: "Fielder's Choice" })
      state = step(state, {
        type: 'FIELDER',
        id: short,
        point: { ...BASES[3] },
        generation: 0
      })
      state = step(state, { type: 'TRAJECTORY', angle: 25, generation: 0 })
      state = step(state, {
        type: 'DEFENDER',
        id: third,
        ...(tapped ? {} : { point: { ...BASES[3] } }),
        generation: 0
      })
      state = step(state, {
        type: 'DEFENDER',
        id: second,
        ...(tapped ? {} : { point: { ...BASES[2] } }),
        generation: 0
      })
      state = step(state, { type: 'DEFENDER', generation: 0 })
      state = choose(state, 7, 'out', 1)
      state = choose(state, 6, 'out', 2)
      const outs = current(state).runners.filter(row => row.movement.isOut)
      expect(
        outs.map(row =>
          row.credits.map(credit => [credit.player.id, credit.credit])
        )
      ).deep.equals([
        [
          [short, 'f_assist'],
          [third, 'f_putout']
        ],
        [
          [third, 'f_assist'],
          [second, 'f_putout']
        ]
      ])
    })
  for (const onwardOnly of [false, true])
    it(`credits an out at second before an onward throw to a safe runner at third (${onwardOnly ? 'unassisted' : 'relay'})`, function () {
      const setup = initial(3)
      const defense = setup.session.liveData.linescore.defense
      const short = defense.SS!.id
      const second = defense['2B']!.id
      const third = defense['3B']!.id
      let state = step(setup, { type: 'OUTCOME', outcome: "Fielder's Choice" })
      state = step(state, {
        type: 'FIELDER',
        id: short,
        point: { ...BASES[2] },
        generation: 0
      })
      state = step(state, { type: 'TRAJECTORY', angle: 25, generation: 0 })
      if (!onwardOnly)
        state = step(state, { type: 'DEFENDER', id: second, generation: 0 })
      state = step(state, { type: 'DEFENDER', id: third, generation: 0 })
      state = step(state, { type: 'DEFENDER', generation: 0 })
      state = choose(state, 6, 'out', onwardOnly ? 0 : 1)
      state = choose(state, 7, 'safe')
      expect(
        current(state)
          .runners.find(row => row.movement.isOut)!
          .credits.map(credit => [credit.player.id, credit.credit])
      ).deep.equals(
        onwardOnly
          ? [[short, 'f_putout']]
          : [
              [short, 'f_assist'],
              [second, 'f_putout']
            ]
      )
      expect(baseIds(state.session)).deep.equals([1, null, 7])
    })
  for (const tapped of [false, true])
    it(`keeps the putout receiver when the later Safe home arrival needs no throw (${tapped ? 'tapped' : 'dragged'})`, function () {
      const setup = initial(5)
      const short = setup.session.liveData.linescore.defense.SS!.id
      const second = setup.session.liveData.linescore.defense['2B']!.id
      let state = step(setup, { type: 'OUTCOME', outcome: "Fielder's Choice" })
      state = step(state, {
        type: 'FIELDER',
        id: short,
        point: { x: -10, z: -35 },
        generation: 0
      })
      state = step(state, { type: 'TRAJECTORY', angle: 25, generation: 0 })
      state = step(state, {
        type: 'DEFENDER',
        id: second,
        ...(tapped ? {} : { point: { ...BASES[2] } }),
        generation: 0
      })
      state = step(state, { type: 'DEFENDER', generation: 0 })
      state = choose(state, 6, 'out')
      state = choose(state, 8, 'safe')
      expect(
        current(state)
          .runners.find(row => row.movement.isOut)!
          .credits.map(credit => [credit.player.id, credit.credit])
      ).deep.equals([
        [short, 'f_assist'],
        [second, 'f_putout']
      ])
      expect(state.session.liveData.linescore.teams.away.runs).equals(1)
    })
  for (const mask of [6, 7])
    it(`resumes choice ${mask} with two preserved home arrivals in lead-runner order`, function () {
      let session = relay(mask).session
      const actions: ScoringAction[] = [
        ...(mask === 7
          ? [{ type: 'runnerMovement' as const, runner: 1, to: '1B' as const }]
          : []),
        { type: 'runnerMovement', runner: 8, to: 'home' },
        { type: 'runnerMovement', runner: 7, to: 'home' }
      ]
      for (const action of actions) {
        const applied = applyAction(session, action)
        expect(applied.problems).deep.equals([])
        session = applied.state
      }
      let state = initialScoringState(session)
      state = step(state, {
        type: 'THROWER',
        id: 15,
        point: { x: 0, z: -25 },
        generation: 0
      })
      state = step(state, { type: 'DEFENDER', generation: 0 })
      if (mask === 7) state = choose(state, 6, 'safe')
      expect(state.phase).equals('correctionWindow')
      expect(state.session.homeQueue).deep.equals([])
      expect(state.session.liveData.linescore.teams.away.runs).equals(2)
      expect(baseIds(state.session)).deep.equals([
        1,
        mask === 7 ? 6 : null,
        null
      ])
    })
  it('keeps the explicit final receiver when the initial fielder is nearer the out base', function () {
    const setup = initial(1)
    const short = setup.session.liveData.linescore.defense.SS!.id
    const second = setup.session.liveData.linescore.defense['2B']!.id
    let state = step(setup, { type: 'OUTCOME', outcome: "Fielder's Choice" })
    state = step(state, {
      type: 'FIELDER',
      id: short,
      point: { ...BASES[2] },
      generation: 0
    })
    state = step(state, { type: 'TRAJECTORY', angle: 25, generation: 0 })
    state = step(state, { type: 'DEFENDER', id: second, generation: 0 })
    state = step(state, { type: 'DEFENDER', generation: 0 })
    state = choose(state, 6, 'out')
    const row = current(state).runners.find(row => row.movement.isOut)!
    expect(
      row.credits.map(credit => [credit.player.id, credit.credit])
    ).deep.equals([
      [short, 'f_assist'],
      [second, 'f_putout']
    ])
    expect(
      current(state)
        .source.teamstation.runnerActions!.find(row => row.isOut)!
        .defensiveRoute!.map(hop => hop.player.id)
    ).deep.equals([short, second])
  })
  for (let mask = 1; mask < 8; mask++) {
    const ids = [6, 7, 8].filter((_, index) => (mask & (1 << index)) !== 0)
    for (let outs = 0; outs < 3; outs++)
      for (let outMask = 0; outMask < 1 << ids.length; outMask++)
        for (const reverse of [false, true])
          it(`resolves bases ${mask} outs ${outs} out subset ${outMask} ${reverse ? 'reverse' : 'forward'} calls`, function () {
            let state = offered(mask, outs)
            const batter =
              state.session.liveData.plays.currentPlay!.matchup.batter.id
            expect(state.phase).equals('fieldersChoice')
            expect(state.correctionWindow).equals(null)
            const original = baseIds(state.session)
            const calls = ids.map((id, index) => ({
              id,
              out: (outMask & (1 << index)) !== 0
            }))
            for (const call of reverse ? [...calls].reverse() : calls)
              state = choose(state, call.id, call.out ? 'out' : 'safe')
            const retired = Math.min(
              3 - outs,
              calls.filter(call => call.out).length
            )
            const ended = retired + outs === 3
            const play = current(state)
            expect(play.runners.filter(row => row.movement.isOut)).length(
              retired
            )
            expect(
              play.runners.some(
                row => row.details.runner.id === batter && row.movement.isOut
              )
            ).equals(false)
            expect(state.session.homeQueue).deep.equals([])
            expect(state.pendingPlay?.fieldersChoice).equals(undefined)
            expect(state.phase).equals(ended ? 'ready' : 'correctionWindow')
            if (ended) {
              expect(state.session.liveData.linescore.isTopInning).equals(false)
              const order = reverse ? [...calls].reverse() : calls
              const outsInOrder = order
                .filter(call => call.out)
                .slice(0, retired)
              const third = outsInOrder.at(-1)!
              const from = original.indexOf(third.id) + 1
              const earlier = new Set(
                outsInOrder.slice(0, -1).map(call => call.id)
              )
              const forceThird = original
                .slice(0, from)
                .every(id => id != null && !earlier.has(id))
              const homeIndex = order.findIndex(
                call => call.id === 8 && !call.out
              )
              const homeScored =
                homeIndex >= 0 &&
                homeIndex < order.findIndex(call => call.id === third.id) &&
                !forceThird
              expect(state.session.liveData.linescore.teams.away.runs).equals(
                homeScored ? 1 : 0
              )
            } else {
              expect(baseIds(state.session)).deep.equals([
                batter,
                (mask & 1) !== 0 && !calls.find(call => call.id === 6)!.out
                  ? 6
                  : null,
                (mask & 2) !== 0 && !calls.find(call => call.id === 7)!.out
                  ? 7
                  : null
              ])
              expect(state.session.liveData.linescore.teams.away.runs).equals(
                (mask & 4) !== 0 && !calls.find(call => call.id === 8)!.out
                  ? 1
                  : 0
              )
              expect(
                play.runners.find(row => row.details.runner.id === batter)!
                  .movement.end
              ).equals(1)
              expect(state.session.liveData.linescore.teams.away.hits).equals(0)
            }
            for (const row of play.runners.filter(row => row.movement.isOut)) {
              expect(
                row.credits.filter(credit => credit.credit === 'f_putout')
              ).length(1)
              expect(
                row.credits.every(credit =>
                  [15, 13, 12].includes(credit.player.id)
                )
              ).equals(true)
              expect(row.movement.originBase).equals(
                original.indexOf(row.details.runner.id) + 1
              )
              const from = original.indexOf(row.details.runner.id) + 1
              expect(row.movement.start).equals(from)
              expect(row.movement.end).equals(from + 1)
            }
          })
  }
  it('offers one-base previews for every runner and batter after Done, with no drag or batter call', function () {
    const state = offered()
    expect(fieldStageInstruction(state)).contains(
      'Mark each runner Safe or Out'
    )
    const players = scoringFieldPlayers(state)
    for (const [id, to] of [
      [1, 1],
      [6, 2],
      [7, 3],
      [8, 4]
    ]) {
      const player = players.find(player => player.playerId === id)!
      expect(player.position).deep.equals(BASES[to % 4])
      expect(player.batting).equals(false)
    }
    expect(
      state.pendingPlay!.fieldersChoice!.runners.map(move => move.playerId)
    ).deep.equals([6, 7, 8])
  })
  for (const receivers of [[], [13, 15, 13]])
    it(`retains an ${receivers.length === 0 ? 'unassisted' : 'ordered repeated-receiver'} route and locations`, function () {
      let state = offered(1, 0, receivers)
      const route = state.pendingPlay!.fieldersChoice!.route
      expect(route.map(hop => hop.id)).deep.equals([15, ...receivers])
      for (const hop of route)
        expect(
          scoringFieldPlayers(state).find(player => player.playerId === hop.id)!
            .position
        ).deep.equals(route.findLast(other => other.id === hop.id)!.point)
      state = choose(state, 6, 'out')
      const record = current(state).source.teamstation.runnerActions!.find(
        row => row.isOut
      )!
      expect(
        record.defensiveRoute!.map(hop => [hop.player.id, hop.location])
      ).deep.equals(route.map(hop => [hop.id, hop.point]))
    })
  it('uses the order of outs to distinguish a removed force', function () {
    let state = offered(3)
    state = choose(state, 6, 'out')
    state = choose(state, 7, 'out')
    expect(
      current(state)
        .runners.filter(row => row.movement.isOut)
        .map(row => row.movement.forceOut)
    ).deep.equals([true, false])
    state = offered(3)
    state = choose(state, 7, 'out')
    state = choose(state, 6, 'out')
    expect(
      current(state)
        .runners.filter(row => row.movement.isOut)
        .map(row => row.movement.forceOut)
    ).deep.equals([true, true])
  })
  it('rejects empty bases, stale calls, wrong phases, the batter, duplicate calls and read-only calls', function () {
    const empty = initial(0)
    expect(
      scoringReducer(empty, { type: 'OUTCOME', outcome: "Fielder's Choice" })
    ).equals(empty)
    let state = offered()
    const event: ScoringEvent = {
      type: 'CHOICE_DECIDE',
      id: 6,
      decision: 'safe',
      generation: state.generation
    }
    for (const invalid of [
      { ...event, id: 1 },
      { ...event, id: 99 },
      { ...event, generation: 99 }
    ])
      expect(scoringReducer(state, invalid)).equals(state)
    const readOnly = { ...state, readOnly: true }
    expect(scoringReducer(readOnly, event)).equals(readOnly)
    const wrong = { ...state, phase: 'ready' as const }
    expect(scoringReducer(wrong, event)).equals(wrong)
    state = choose(state, 6, 'safe')
    expect(scoringReducer(state, { ...event, decision: 'out' })).equals(state)
  })
  it('waits for the hit, throws and offered runner motions before accepting calls', function () {
    let state = initial(1)
    state.presentationEnabled = true
    state = scoringReducer(state, {
      type: 'OUTCOME',
      outcome: "Fielder's Choice"
    })
    state = scoringReducer(state, {
      type: 'FIELDER',
      id: 15,
      point: { x: 0, z: -25 },
      generation: 0
    })
    state = scoringReducer(state, {
      type: 'TRAJECTORY',
      angle: 25,
      generation: 0
    })
    expect(scoringReducer(state, { type: 'DEFENDER', generation: 0 })).equals(
      state
    )
    for (let count = 0; state.presentation != null && count < 4; count++) {
      const p = state.presentation
      state = scoringReducer(
        state,
        p.kind === 'hit' && p.stage === 'swing'
          ? { type: 'PRESENTATION_CONTACT', id: p.id, generation: p.generation }
          : {
              type: 'PRESENTATION_DONE',
              id: p.id,
              generation: p.generation,
              stage: p.stage
            }
      )
    }
    state = scoringReducer(state, {
      type: 'DEFENDER',
      id: 13,
      point: { x: 15, z: -25 },
      generation: 0
    })
    expect(state.presentation!.kind).equals('throw')
    const p = state.presentation!
    state = scoringReducer(state, {
      type: 'PRESENTATION_DONE',
      id: p.id,
      generation: p.generation,
      stage: p.stage
    })
    state = scoringReducer(state, { type: 'DEFENDER', generation: 0 })
    expect(state.phase).equals('runnerMovement')
    const event: ScoringEvent = {
      type: 'CHOICE_DECIDE',
      id: 6,
      decision: 'out',
      generation: 0
    }
    expect(scoringReducer(state, event)).equals(state)
    state = completeMotions(state)
    expect(state.phase).equals('fieldersChoice')
    expect(choose(state, 6, 'out').phase).equals('correctionWindow')
  })
  it('undoes relay Done, partial calls and the final commit, and replays each with a fresh generation', function () {
    let state = offered()
    state = step(state, { type: 'UNDO' })
    expect(state.phase).equals('chooseDefender')
    expect(state.pendingPlay!.fieldersChoice).equals(undefined)
    state = step(state, { type: 'DEFENDER', generation: state.generation })
    state = choose(state, 8, 'safe')
    state = choose(state, 6, 'out')
    state = choose(state, 7, 'safe')
    expect(state.session.liveData.linescore.outs).equals(1)
    expect(state.session.liveData.linescore.teams.away.runs).equals(1)
    state = step(state, { type: 'UNDO' })
    expect(state.phase).equals('fieldersChoice')
    expect(state.session.liveData.linescore.outs).equals(0)
    expect(state.session.liveData.linescore.teams.away.runs).equals(0)
    expect(
      state.pendingPlay!.fieldersChoice!.runners.find(
        move => move.playerId === 7
      )!.decision
    ).equals(undefined)
    state = choose(state, 7, 'out')
    expect(state.session.liveData.linescore.outs).equals(2)
    state = step(state, { type: 'UNDO' })
    state = step(state, { type: 'UNDO' })
    expect(
      state.pendingPlay!.fieldersChoice!.runners.find(
        move => move.playerId === 6
      )!.decision
    ).equals(undefined)
  })
})
