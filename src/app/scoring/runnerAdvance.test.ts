import { expect } from 'chai'
import { describe, it } from 'mocha'

import { cleanAction } from '../../common/scoring/actions'
import { currentDocumentOf, documentOf } from '../../common/scoring/document'
import { baseIds } from '../../common/scoring/rules'
import { applyAction } from '../../common/scoring/session'
import { asGameState, setupOf } from '../../common/scoring/state'
import { completeMotions } from '../../test/scoringHelpers'
import { scoringSession } from '../../test/scoringSession'
import { fieldStageInstruction } from './battedBallField'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'
import type { ScoringState } from './scoringTypes'

function initial(mask = 1): ScoringState {
  const state = initialScoringState(scoringSession(gameFixture))
  for (let base = 0; base < 3; base++)
    if ((mask & (1 << base)) !== 0)
      state.session.liveData.linescore.offense[
        (['first', 'second', 'third'] as const)[base]
      ] = playerRef(state.session, base + 2)
  return state
}
function choose(
  state: ScoringState,
  reason: string,
  from = 1,
  to = from + 1
): ScoringState {
  state = scoringReducer(state, {
    type: 'RUNNER_DROP',
    id: from + 1,
    to,
    decision: 'safe',
    generation: state.generation
  })
  expect(state.phase).equals('runnerReason')
  return scoringReducer(state, { type: 'RUNNER_REASON', reason })
}
function ball(state: ScoringState): ScoringState {
  return completeMotions(scoringReducer(state, { type: 'PITCH', kind: 'ball' }))
}
function addPitch(
  state: ScoringState,
  kind: 'ball' | 'called' | 'swing' = 'ball'
): ScoringState {
  if (state.runnerAction?.reason !== 'Passed Ball')
    return scoringReducer(state, { type: 'RUNNER_PITCH', addBall: true })
  if (state.phase === 'runnerPitch')
    state = scoringReducer(state, { type: 'RUNNER_PITCH_NEW' })
  return scoringReducer(state, { type: 'RUNNER_PITCH_KIND', kind })
}
function stored(state: ScoringState): ReturnType<typeof currentDocumentOf> {
  return currentDocumentOf(
    state.session,
    state.session.liveData.plays.currentPlay,
    { setupBefore: setupOf(state.session), actions: state.log }
  )
}

describe('runner advance attribution and pitch choice', () => {
  for (const reason of ['Throwing Error', 'Fielding Error'])
    for (const reuse of [true, false])
      for (const multiple of [true, false])
        it(`${reason}: ${reuse ? 'shares' : 'separates'} errors for ${multiple ? 'two runners' : 'two bases'}`, () => {
          const advance = (
            state: ScoringState,
            id: number,
            to: number
          ): ScoringState => {
            let next = scoringReducer(state, {
              type: 'RUNNER_DROP',
              id,
              to,
              decision: 'safe',
              generation: state.generation
            })
            next = scoringReducer(next, { type: 'RUNNER_REASON', reason })
            return scoringReducer(next, {
              type: 'RUNNER_ERROR',
              id: 10,
              generation: next.generation
            })
          }
          const before = ball(initial(multiple ? 3 : 1))
          const first = completeMotions(
            advance(before, multiple ? 3 : 2, multiple ? 3 : 2)
          )
          const offered = advance(first, 2, multiple ? 2 : 3)
          expect(offered.phase).equals('runnerErrorReuse')
          expect(offered.session).deep.equals(first.session)
          expect(
            scoringReducer(offered, { type: 'RUNNER_CANCEL' }).session
          ).deep.equals(first.session)
          const final = completeMotions(
            scoringReducer(offered, { type: 'RUNNER_ERROR_REUSE', reuse })
          )
          const errors = reuse ? 1 : 2
          expect(final.session.liveData.linescore.teams.home.errors).equals(
            errors
          )
          const runners = final.session.liveData.plays.currentPlay!.runners
          expect(runners.flatMap(r => r.credits)).has.length(errors)
          expect(
            runners.at(-1)!.details.playIndex ===
              runners.at(-2)!.details.playIndex
          ).equals(reuse)
          const gumbo = stored(final) as any
          expect(
            gumbo.runners
              .flatMap((r: any) => r.credits)
              .filter((c: any) => c.credit.includes('error'))
          ).has.length(errors)
          const cleaned = cleanAction(
            JSON.parse(JSON.stringify(final.log.at(-1)))
          )
          if ('problem' in cleaned) throw new Error(cleaned.problem.message)
          expect(
            JSON.parse(
              JSON.stringify(applyAction(first.session, cleaned.action).state)
            )
          ).deep.equals(JSON.parse(JSON.stringify(final.session)))
          expect(scoringReducer(final, { type: 'UNDO' }).session).deep.equals(
            first.session
          )
          if (reuse) {
            const stale = ball(first)
            expect(
              applyAction(stale.session, cleaned.action).problems
            ).has.length(1)
          }
        })

  it('rejects nonexistent error links and ignores reuse outside the choice', () => {
    const state = ball(initial())
    expect(
      scoringReducer(state, { type: 'RUNNER_ERROR_REUSE', reuse: true })
    ).equals(state)
    for (const errorEvent of [-1, 0.5, 100])
      expect(
        applyAction(state.session, {
          type: 'runnerMovement',
          runner: 2,
          to: '2B',
          reason: 'Throwing Error',
          error: 10,
          errorEvent
        }).problems
      ).has.length(1)
  })
  it('charges the catcher at pitch time even if the defense changes before the passed ball is entered', () => {
    const state = ball(initial())
    const catcher = state.session.liveData.linescore.defense.C!
    state.session.liveData.linescore.defense.C =
      state.session.liveData.linescore.defense['1B']
    const result = scoringReducer(choose(state, 'Passed Ball'), {
      type: 'RUNNER_PITCH',
      addBall: false
    })
    expect(
      result.session.liveData.plays.currentPlay!.playEvents.at(-1)!.catcher
    ).deep.equals(catcher)
  })
  for (const reason of ['Throwing Error', 'Fielding Error'])
    it(`${reason} requires a current defender, records the charge and undoes in one step`, () => {
      const before = ball(initial())
      const draft = choose(before, reason)
      expect(draft.phase).equals('runnerError')
      expect(draft.session).deep.equals(before.session)
      expect(fieldStageInstruction(draft)).equals(
        `Tap the defender who made the ${reason.toLowerCase()}.`
      )
      expect(
        scoringReducer(draft, { type: 'RUNNER_CANCEL' }).session
      ).deep.equals(before.session)
      for (const [id, generation] of [
        [2, draft.generation],
        [10, draft.generation + 1]
      ])
        expect(
          scoringReducer(draft, { type: 'RUNNER_ERROR', id, generation })
        ).equals(draft)
      expect(
        scoringReducer(before, {
          type: 'RUNNER_ERROR',
          id: 10,
          generation: before.generation
        })
      ).equals(before)
      const final = completeMotions(
        scoringReducer(draft, {
          type: 'RUNNER_ERROR',
          id: 10,
          generation: draft.generation
        })
      )
      expect(baseIds(final.session)).deep.equals([null, 2, null])
      expect(final.session.liveData.linescore.teams.home.errors).equals(1)
      expect(final.session.liveData.linescore.balls).equals(1)
      const record = final.session.liveData.plays.currentPlay!.runners.at(-1)!
      expect(record.credits).has.length(1)
      expect(record.credits[0]).deep.include({
        credit:
          reason === 'Throwing Error' ? 'f_throwing_error' : 'f_fielding_error'
      })
      expect(record.credits[0].player.id).equals(10)
      const cleaned = cleanAction(JSON.parse(JSON.stringify(final.log.at(-1))))
      if ('problem' in cleaned) throw new Error(cleaned.problem.message)
      expect(
        JSON.parse(
          JSON.stringify(applyAction(before.session, cleaned.action).state)
        )
      ).deep.equals(JSON.parse(JSON.stringify(final.session)))
      expect(JSON.stringify(stored(final))).includes(record.credits[0].credit)
      expect(final.past).has.length(before.past.length + 1)
      expect(scoringReducer(final, { type: 'UNDO' }).session).deep.equals(
        before.session
      )
    })

  it('rejects invalid engine error attribution while replaying historical uncredited errors', () => {
    const state = ball(initial()).session
    for (const extra of [
      { error: 2, reason: 'Fielding Error' as const },
      { error: 10, reason: 'Steal' as const },
      { error: 10, reason: 'Throwing Error' as const, out: true }
    ]) {
      const result = applyAction(state, {
        type: 'runnerMovement',
        runner: 2,
        to: '2B',
        ...extra
      })
      expect(result.problems.length).greaterThan(0)
      expect(result.state).deep.equals(state)
    }
    expect(
      applyAction(state, {
        type: 'runnerMovement',
        runner: 2,
        to: '2B',
        reason: 'Fielding Error'
      }).problems
    ).deep.equals([])
  })

  for (const reason of ['Wild Pitch', 'Passed Ball']) {
    for (const kind of ['ball', 'called', 'swing'] as const)
      it(`${reason} reuses a previous ${kind} without changing pitch or ball counts`, () => {
        const before = scoringReducer(initial(), { type: 'PITCH', kind })
        const draft = choose(before, reason)
        expect(draft.phase).equals('runnerPitch')
        expect(draft.session).deep.equals(before.session)
        expect(
          scoringReducer(draft, { type: 'RUNNER_CANCEL' }).session
        ).deep.equals(before.session)
        const final = completeMotions(
          scoringReducer(draft, { type: 'RUNNER_PITCH', addBall: false })
        )
        expect(final.session.liveData.linescore.balls).equals(
          before.session.liveData.linescore.balls
        )
        expect(final.session.liveData.linescore.strikes).equals(
          before.session.liveData.linescore.strikes
        )
        expect(
          final.session.liveData.boxscore.teams.home.pitchCounts
        ).deep.equals(before.session.liveData.boxscore.teams.home.pitchCounts)
        expect(final.session.liveData.linescore.teams.home.errors).equals(0)
        const play = final.session.liveData.plays.currentPlay!
        expect(play.runners.at(-1)!.credits).deep.equals([])
        if (reason === 'Passed Ball') {
          expect(play.playEvents.at(-1)!.catcher?.id).equals(
            final.session.liveData.linescore.defense.C!.id
          )
          expect(
            asGameState(
              JSON.parse(JSON.stringify(final.session))
            ).liveData.plays.currentPlay!.playEvents.at(-1)!.catcher
          ).deep.equals(play.playEvents.at(-1)!.catcher)
          expect(JSON.stringify(stored(final))).includes(
            play.playEvents.at(-1)!.catcher!.fullName
          )
        } else
          expect(play.playEvents.at(-1)!.pitcher?.id).equals(
            final.session.liveData.linescore.defense.P!.id
          )
        expect(scoringReducer(final, { type: 'UNDO' }).session).deep.equals(
          before.session
        )
      })

    it(`${reason} adds one ball and one pitch, and later runners reuse that event`, () => {
      const before = initial(3)
      const first = completeMotions(addPitch(choose(before, reason, 2)))
      const final = completeMotions(
        scoringReducer(choose(first, reason), {
          type: 'RUNNER_PITCH',
          addBall: false
        })
      )
      expect(baseIds(final.session)).deep.equals([null, 2, 3])
      expect(final.session.liveData.linescore.balls).equals(1)
      const play = final.session.liveData.plays.currentPlay!
      expect(play.playEvents.filter(event => event.isPitch)).has.length(1)
      expect(
        play.playEvents.filter(
          event =>
            event.details.code ===
            (reason === 'Wild Pitch' ? 'wild_pitch' : 'passed_ball')
        )
      ).has.length(1)
      expect(play.runners.map(runner => runner.details.playIndex)).deep.equals([
        1, 1
      ])
      const undone = scoringReducer(final, { type: 'UNDO' })
      expect(undone.session).deep.equals(first.session)
      expect(scoringReducer(undone, { type: 'UNDO' }).session).deep.equals(
        before.session
      )
    })

    it(`${reason} handles ball four without duplicating the forced advance`, () => {
      const before = ball(ball(ball(initial())))
      const final = completeMotions(addPitch(choose(before, reason)))
      expect(baseIds(final.session)).deep.equals([1, 2, null])
      const play = final.session.liveData.plays.allPlays.at(-1)!
      expect(play.result.eventType).equals('walk')
      expect(play.playEvents.filter(event => event.isPitch)).has.length(4)
      expect(
        play.runners.filter(runner => runner.details.runner.id === 2)
      ).has.length(1)
      expect(
        play.runners.find(runner => runner.details.runner.id === 2)!.details
          .movementReason
      ).equals('Walk')
      expect(scoringReducer(final, { type: 'UNDO' }).session).deep.equals(
        before.session
      )
    })

    it(`${reason} keeps an unforced advance on ball four`, () => {
      for (const [mask, from, to] of [[2, 2, 3]]) {
        const before = ball(ball(ball(initial(mask))))
        const final = completeMotions(
          addPitch(choose(before, reason, from, to))
        )
        expect(baseIds(final.session)).deep.equals([1, null, from + 1])
        expect(
          final.session.liveData.plays.allPlays.at(-1)!.runners.at(-1)!.details
            .movementReason
        ).equals(reason)
        expect(scoringReducer(final, { type: 'UNDO' }).session).deep.equals(
          before.session
        )
      }
    })
  }

  for (const kind of ['ball', 'called', 'swing'] as const) {
    it(`asks for a passed-ball ${kind} on the first pitch and counts it once`, () => {
      const before = initial()
      const draft = choose(before, 'Passed Ball')
      expect(draft.phase).equals('runnerPitchType')
      expect(fieldStageInstruction(draft)).includes('Tap Ball')
      expect(scoringReducer(draft, { type: 'PITCH', kind: 'foul' })).equals(
        draft
      )
      expect(
        scoringReducer(draft, { type: 'RUNNER_CANCEL' }).session
      ).deep.equals(before.session)
      const final = completeMotions(addPitch(draft, kind))
      expect(baseIds(final.session)).deep.equals([null, 2, null])
      const play = final.session.liveData.plays.currentPlay!
      expect(play.playEvents.filter(event => event.isPitch)).length(1)
      expect(final.session.liveData.linescore.balls).equals(
        kind === 'ball' ? 1 : 0
      )
      expect(final.session.liveData.linescore.strikes).equals(
        kind === 'ball' ? 0 : 1
      )
      expect(scoringReducer(final, { type: 'UNDO' }).session).deep.equals(
        before.session
      )
    })
  }
  it('NO asks for another pitch without mutating the draft; a previous batter does not qualify', () => {
    const before = ball(initial())
    const draft = choose(before, 'Passed Ball')
    const selecting = scoringReducer(draft, { type: 'RUNNER_PITCH_NEW' })
    expect(selecting.phase).equals('runnerPitchType')
    expect(selecting.session).deep.equals(before.session)
    expect(
      scoringReducer(selecting, { type: 'RUNNER_CANCEL' }).session
    ).deep.equals(before.session)
    expect(
      completeMotions(addPitch(selecting, 'swing')).session.liveData.linescore
        .strikes
    ).equals(1)
    expect(scoringReducer(before, { type: 'RUNNER_PITCH_NEW' })).equals(before)
    const stale = ball(initial())
    stale.session.recentPitch!.atBatIndex--
    expect(choose(stale, 'Passed Ball').phase).equals('runnerPitchType')
  })
  it('a passed-ball third strike retains the pitch and advances the runner without an extra out', () => {
    let before = initial(2)
    for (let i = 0; i < 2; i++)
      before = completeMotions(
        scoringReducer(before, { type: 'PITCH', kind: 'called' })
      )
    const final = completeMotions(
      addPitch(choose(before, 'Passed Ball', 2), 'swing')
    )
    expect(final.session.liveData.linescore.outs).equals(1)
    expect(baseIds(final.session)).deep.equals([null, null, 3])
    expect(
      (
        final.session.liveData.plays.currentPlay ??
        final.session.liveData.plays.allPlays.at(-1)!
      ).playEvents.filter(e => e.isPitch)
    ).length(3)
    expect(scoringReducer(final, { type: 'UNDO' }).session).deep.equals(
      before.session
    )
  })

  for (const kind of ['called', 'swing'] as const)
    it(`a passed-ball ${kind} third strike ends the inning without scoring a runner from third`, () => {
      let state = initial(0)
      const act = (event: Parameters<typeof scoringReducer>[1]): void => {
        state = completeMotions(scoringReducer(state, event))
      }
      for (let batter = 0; batter < 2; batter++) {
        for (let pitch = 0; pitch < 3; pitch++)
          act({ type: 'PITCH', kind: 'called' })
        act({ type: 'CLOSE_PLAY' })
      }
      for (let pitch = 0; pitch < 4; pitch++)
        act({ type: 'PITCH', kind: 'ball' })
      act({ type: 'CLOSE_PLAY' })
      const runner = state.session.liveData.linescore.offense.first!.id
      for (const to of [2, 3]) {
        act({
          type: 'RUNNER_DROP',
          id: runner,
          to,
          decision: 'safe',
          generation: state.generation
        })
        act({ type: 'RUNNER_REASON', reason: 'Steal' })
      }
      for (let pitch = 0; pitch < 2; pitch++)
        act({ type: 'PITCH', kind: 'called' })
      const before = state
      expect(before.session.liveData.linescore.outs).equals(2)
      act({
        type: 'RUNNER_DROP',
        id: runner,
        to: 4,
        decision: 'safe',
        generation: state.generation
      })
      act({ type: 'RUNNER_REASON', reason: 'Passed Ball' })
      act({ type: 'RUNNER_PITCH_NEW' })
      act({ type: 'RUNNER_PITCH_KIND', kind })
      expect(state.session.liveData.linescore.inningState).equals('Bottom')
      expect(state.session.liveData.linescore.teams.away.runs).equals(0)
      const play = state.session.liveData.plays.allPlays.at(-1)!
      expect(play.playEvents.filter(event => event.isPitch)).has.length(3)
      expect(
        play.runners.some(runner => runner.movement.runScored === true)
      ).equals(false)
      expect(
        play.playEvents.some(event => event.details.code === 'passed_ball')
      ).equals(false)
      expect(scoringReducer(state, { type: 'UNDO' }).session).deep.equals(
        before.session
      )
    })

  it('refuses a nonexistent or foul previous pitch and ignores answers outside the question', () => {
    const before = initial()
    expect(
      scoringReducer(before, { type: 'RUNNER_PITCH', addBall: true })
    ).equals(before)
    for (const state of [
      before,
      scoringReducer(before, { type: 'PITCH', kind: 'foul' })
    ]) {
      const draft = choose(state, 'Wild Pitch')
      expect(
        scoringReducer(draft, { type: 'RUNNER_PITCH', addBall: false })
      ).equals(draft)
      expect(baseIds(draft.session)).deep.equals([2, null, null])
    }
  })

  it('resolves a bases-loaded ball four once and restores the count and run with Undo', () => {
    const before = ball(ball(ball(initial(7))))
    const final = completeMotions(
      scoringReducer(choose(before, 'Wild Pitch', 3), {
        type: 'RUNNER_PITCH',
        addBall: true
      })
    )
    expect(baseIds(final.session)).deep.equals([1, 2, 3])
    expect(final.session.liveData.linescore.teams.away.runs).equals(1)
    expect(
      final.session.liveData.plays.allPlays
        .at(-1)!
        .runners.filter(runner => runner.details.runner.id === 4)
    ).has.length(1)
    expect(scoringReducer(final, { type: 'UNDO' }).session).deep.equals(
      before.session
    )
  })

  it('uses strike three from the previous appearance without adding another pitch or out', () => {
    let before = initial(2)
    for (let n = 0; n < 3; n++)
      before = completeMotions(
        scoringReducer(before, { type: 'PITCH', kind: 'called' })
      )
    before = scoringReducer(before, { type: 'CLOSE_PLAY' })
    const final = completeMotions(
      scoringReducer(choose(before, 'Wild Pitch', 2), {
        type: 'RUNNER_PITCH',
        addBall: false
      })
    )
    expect(baseIds(final.session)).deep.equals([null, null, 3])
    expect(final.session.liveData.linescore.outs).equals(1)
    expect(final.session.liveData.linescore.balls).equals(0)
    expect(final.session.liveData.linescore.strikes).equals(0)
    expect(final.session.liveData.boxscore.teams.home.pitchCounts).deep.equals(
      before.session.liveData.boxscore.teams.home.pitchCounts
    )
    expect(
      JSON.parse(
        JSON.stringify(scoringReducer(final, { type: 'UNDO' }).session)
      )
    ).deep.equals(JSON.parse(JSON.stringify(before.session)))
  })

  it('keeps a caught foul as an out with a tag-up in the saved Gumbo play', () => {
    let state = initial(2)
    state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Ball Caught' })
    state = scoringReducer(state, {
      type: 'FIELDER',
      id: 10,
      point: { x: 30, z: -20 },
      generation: state.generation
    })
    state = completeMotions(
      scoringReducer(state, {
        type: 'TRAJECTORY',
        angle: 45,
        generation: state.generation
      })
    )
    expect(state.log.at(-1)).deep.include({
      type: 'result',
      eventType: 'field_out',
      outBy: 'catch',
      foulCaught: true
    })
    state = completeMotions(
      scoringReducer(state, {
        type: 'RUNNER_DROP',
        id: 3,
        to: 3,
        decision: 'safe',
        generation: state.generation
      })
    )
    expect(state.session.liveData.linescore.outs).equals(1)
    expect(baseIds(state.session)).deep.equals([null, null, 3])
    const play = state.session.liveData.plays.currentPlay!
    const doc = documentOf(state.session, play, {
      setupBefore: setupOf(state.session),
      actions: state.log
    })
    expect(doc.result).deep.include({
      eventType: 'field_out',
      description: 'Foul ball caught',
      isOut: true
    })
    expect(play.source.teamstation.foulCaught).equals(true)
    expect(
      play.runners.find(runner => runner.details.runner.id === 1)!.credits[0]
        .credit
    ).equals('f_putout')
  })
})
