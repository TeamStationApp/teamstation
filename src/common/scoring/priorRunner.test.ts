import { expect } from 'chai'
import { describe, it } from 'mocha'

import { priorRunnerFixture } from '../../test/priorRunnerFixture'
import { HttpError } from '../errors'
import { tagTargets } from '../eventTags'
import type { ScoringAction } from './actions'
import { applyActions } from './apply'
import { storedRecordOf } from './gumbo'
import { baseIds } from './lineup'
import { forPlayback } from './playbackTimes'
import { priorRunners, returnPriorRunner } from './priorRunner'
import { overrideOf, previousRunnerError } from './rules'
import { ScoringSession } from './session'
import { copyState, setupOf } from './state'

function correct(
  s: ScoringSession,
  to: number
): NonNullable<ReturnType<typeof returnPriorRunner>> {
  const result = returnPriorRunner(s.opening, s.actions, s.state, 100, to)
  expect(result).not.equals(null)
  expect(s.sync(result!.log, result!.retainedEvents)).deep.equals([])
  return result!
}
describe('prior runner corrections', () => {
  for (const sharedError of [false, true])
    it(`does not require present-day setup completeness for retained old ${sharedError ? 'shared errors' : 'pitches'}`, async () => {
      const fixture = priorRunnerFixture('second')
      const opening = copyState(fixture.session.opening)
      opening.liveData.boxscore.teams.home.defense.SS = null
      const options = { setTimer: () => null, clearTimer: () => undefined }
      const initial = ScoringSession.start(
        fixture.store,
        fixture.session.gameId,
        opening,
        options
      )
      if (sharedError) {
        for (const action of [
          { type: 'gameFlow', kind: 'placeRunner', runner: 103, base: '3B' },
          { type: 'gameFlow', kind: 'placeRunner', runner: 104, base: '1B' },
          {
            type: 'runnerMovement',
            runner: 103,
            to: 'home',
            reason: 'Throwing Error',
            error: 207
          }
        ] as ScoringAction[])
          expect(initial.apply(action).problems).deep.equals([])
        expect(
          initial.apply({
            type: 'runnerMovement',
            runner: 104,
            to: '2B',
            reason: 'Throwing Error',
            error: 207,
            errorEvent: previousRunnerError(
              initial.state,
              'Throwing Error',
              207
            )
          }).problems
        ).deep.equals([])
      }
      for (const action of [
        { type: 'pitch', call: 'B' },
        {
          type: 'lineup',
          kind: 'roster',
          setup: setupOf(fixture.session.opening)
        },
        ...(sharedError
          ? [{ type: 'runnerMovement', runner: 104, to: 'home' }]
          : []),
        ...fixture.session.actions
      ] as ScoringAction[])
        expect(initial.apply(action).problems).deep.equals([])
      await initial.flush()
      const context = {
        gamePk: initial.gameId,
        teams: opening.gameData.teams,
        setup: setupOf(opening)
      }
      const s = await ScoringSession.open(
        fixture.store,
        initial.gameId,
        context,
        {
          ...options,
          requireCurrentSetup: true
        }
      )
      expect(s.readOnly).equals(false)
      const previous = JSON.stringify(s.picture().plays.get(0))
      const corrected = returnPriorRunner(
        s.opening,
        s.actions,
        s.state,
        100,
        2
      )!
      expect(corrected).not.equals(null)
      for (const action of s.actions)
        if (action.type === 'runnerMovement' && action.errorEvent != null)
          expect(corrected.log.includes(action)).equals(true)
      expect(s.sync(corrected.log, corrected.retainedEvents, true)).deep.equals(
        []
      )
      expect(baseIds(s.state)).deep.equals([101, 100, null])
      expect(JSON.stringify(s.picture().plays.get(0))).equals(previous)
      await s.flush()
      const reopened = await ScoringSession.open(
        fixture.store,
        s.gameId,
        context,
        {
          ...options,
          requireCurrentSetup: true
        }
      )
      expect(baseIds(reopened.state)).deep.equals([101, 100, null])
      expect(JSON.stringify(reopened.picture().plays.get(0))).equals(previous)
    })
  for (const stale of [false, true])
    it(`preserves replay-only suffix actions and rejects invalid corrections atomically${stale ? ' through stale save retries' : ''}`, async () => {
      const { session: initial, store } = priorRunnerFixture('second')
      initial.apply({ type: 'pitch', call: 'B' })
      const setup = setupOf(initial.state)
      setup.sides.home.battingOrder[8] = 200
      await initial.flush()
      const saved = store.games.get(initial.gameId)!.currentPlay as unknown as {
        teamStation: { actions: ScoringAction[] }
      }
      saved.teamStation.actions.push(
        { type: 'lineup', kind: 'roster', setup },
        { type: 'pitch', call: 'C' }
      )
      const context = {
        gamePk: initial.gameId,
        teams: initial.opening.gameData.teams,
        setup: setupOf(initial.opening)
      }
      const options = { setTimer: () => null, clearTimer: () => undefined }
      const s = await ScoringSession.open(
        store,
        initial.gameId,
        context,
        options
      )
      expect(s.readOnly).equals(false)
      // The injected legacy events have no stored tag IDs yet. Compare all
      // scoring data; reopening may assign those previously absent identities.
      const currentOf = (session: ScoringSession): string =>
        JSON.stringify({ ...session.picture().current, tagTargets: undefined })
      const current = currentOf(s)
      const corrected = returnPriorRunner(
        s.opening,
        s.actions,
        s.state,
        100,
        2
      )!
      expect(corrected).not.equals(null)
      const before = JSON.stringify({ state: s.state, actions: s.actions })
      let notifications = 0
      const unsubscribe = s.subscribe(() => notifications++)
      const invalid: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
      expect(
        s.sync([...corrected.log, invalid], corrected.retainedEvents, true)
      ).not.deep.equals([])
      expect(JSON.stringify({ state: s.state, actions: s.actions })).equals(
        before
      )
      expect(notifications).equals(0)
      // A clone of the legacy action is newly supplied, not retained history.
      const cloned = corrected.log.map(action =>
        action.type === 'lineup' ? { ...action } : action
      )
      expect(s.sync(cloned, corrected.retainedEvents, true)).not.deep.equals([])
      expect(JSON.stringify({ state: s.state, actions: s.actions })).equals(
        before
      )
      expect(s.sync(corrected.log, corrected.retainedEvents, true)).deep.equals(
        []
      )
      expect(baseIds(s.state)).deep.equals([101, 100, null])
      expect(currentOf(s)).equals(current)
      unsubscribe()
      if (stale) {
        const save = store.save.bind(store)
        let conflicts = 2
        store.save = async (...args) => {
          if (conflicts-- > 0)
            throw new HttpError('conflict', 'Lineups changed', { stale: true })
          return await save(...args)
        }
      }
      await s.flush()
      expect(s.rebases).equals(stale ? 2 : 0)
      expect(s.state.liveData.boxscore.teams.home.battingOrder).deep.equals(
        setup.sides.home.battingOrder
      )
      const reopened = await ScoringSession.open(
        store,
        s.gameId,
        context,
        options
      )
      expect(baseIds(reopened.state)).deep.equals([101, 100, null])
      expect(currentOf(reopened)).equals(current)
    })
  for (const pitched of [false, true])
    it(`retains legacy history when correcting a later single${pitched ? ' after current pitches' : ''}`, async () => {
      const { session: initial, store } = priorRunnerFixture('timed')
      expect(initial.sync([])).deep.equals([])
      const draft = overrideOf(initial.state)
      const actions: ScoringAction[] = [
        {
          type: 'gameFlow',
          kind: 'override',
          ...draft,
          batter: draft.batter ?? undefined,
          pitcher: draft.pitcher ?? undefined,
          outs: 2
        },
        { type: 'gameFlow', kind: 'placeRunner', runner: 101, base: '3B' },
        { type: 'ballInPlay', contact: 'swing', fielder: 207 },
        { type: 'result', eventType: 'field_out', outBy: 'catch' },
        { type: 'gameFlow', kind: 'closePlay' },
        { type: 'ballInPlay', contact: 'swing', fielder: 107 },
        { type: 'result', eventType: 'double' },
        { type: 'gameFlow', kind: 'closePlay' },
        { type: 'ballInPlay', contact: 'swing', fielder: 107 },
        { type: 'result', eventType: 'single' },
        { type: 'gameFlow', kind: 'closePlay' },
        ...(pitched
          ? ([
              { type: 'pitch', call: 'B' },
              { type: 'pitch', call: 'C' }
            ] as ScoringAction[])
          : [])
      ]
      for (const action of actions)
        expect(initial.apply(action).problems).deep.equals([])
      await initial.flush()
      // Older scoring versions saved this order. Reopening already supports
      // it; correcting a later play must not reinterpret the old decision.
      const first = store.games.get(initial.gameId)!.plays[0] as unknown as {
        teamStation: {
          actions: ScoringAction[]
          actionTimes?: string[]
          playbackTimes?: string[]
        }
      }
      const at =
        first.teamStation.actions.findIndex(a => a.type === 'result') + 1
      first.teamStation.actions.splice(at, 0, {
        type: 'runnerMovement',
        runner: 101,
        to: 'home'
      })
      for (const key of ['actionTimes', 'playbackTimes'] as const) {
        const times = first.teamStation[key]
        times?.splice(at, 0, times[at - 1])
      }
      const context = {
        gamePk: initial.gameId,
        teams: initial.opening.gameData.teams,
        setup: setupOf(initial.opening)
      }
      const options = { setTimer: () => null, clearTimer: () => undefined }
      const s = await ScoringSession.open(
        store,
        initial.gameId,
        context,
        options
      )
      expect(s.readOnly).equals(false)
      expect(baseIds(s.state)).deep.equals([201, null, 200])
      expect(applyActions(s.opening, s.actions).problems).not.deep.equals([])
      const before = {
        first: JSON.stringify(s.picture().plays.get(0)),
        current: JSON.stringify(s.picture().current)
      }
      const corrected = returnPriorRunner(s.opening, s.actions, s.state, 200, 2)
      expect(corrected).not.equals(null)
      expect(s.sync(corrected!.log, corrected!.retainedEvents)).deep.equals([])
      expect(baseIds(s.state)).deep.equals([201, 200, null])
      expect(JSON.stringify(s.picture().plays.get(0))).equals(before.first)
      expect(JSON.stringify(s.picture().current)).equals(before.current)
      await s.flush()
      const reopened = await ScoringSession.open(
        store,
        s.gameId,
        context,
        options
      )
      expect(baseIds(reopened.state)).deep.equals([201, 200, null])
      expect(JSON.stringify(reopened.picture().plays.get(0))).equals(
        before.first
      )
      expect(JSON.stringify(reopened.picture().current)).equals(before.current)
    })
  for (const throws of [1, 2])
    it(`preserves ${throws} acknowledged pickoff identities when an earlier steal is removed`, async () => {
      const { session: s, store } = priorRunnerFixture('occupied')
      const actions: ScoringAction[] = [
        { type: 'baseRunning', kind: 'steal', runner: 100 },
        ...Array<ScoringAction>(throws).fill({
          type: 'baseRunning',
          kind: 'pickoff_safe',
          runner: 101
        }),
        ...Array<ScoringAction>(3).fill({ type: 'pitch', call: 'C' }),
        { type: 'gameFlow', kind: 'closePlay' }
      ]
      for (const action of actions)
        expect(s.apply(action).problems).deep.equals([])
      const index = s.state.liveData.plays.allPlays.at(-1)!.about.atBatIndex
      const before = s.picture().plays.get(index)!
      const targets = tagTargets(before).filter(
        target =>
          target.eventIndex != null &&
          (before.playEvents as Array<{ isPitch?: boolean }>)[target.eventIndex]
            .isPitch !== true
      )
      expect(targets).has.length(throws + 1)
      targets.forEach((target, i) =>
        expect(s.setEventTag(target.id, `throw ${i}`)).equals(true)
      )
      await s.flush()
      const expected = s.eventTargets
        .filter(target => targets.slice(1).some(old => old.id === target.id))
        .map(target => [target.id, target.tag])
      correct(s, 2)
      const after = s.picture().plays.get(index)!
      expect(
        tagTargets(after)
          .filter(
            target =>
              target.eventIndex != null &&
              (after.playEvents as Array<{ isPitch?: boolean }>)[
                target.eventIndex
              ].isPitch !== true
          )
          .map(target => [target.id, target.tag])
      ).deep.equals(expected)
      expect(s.eventTargets.some(target => target.id === targets[0].id)).equals(
        false
      )
      await s.flush()
      const reopened = await ScoringSession.open(
        store,
        s.gameId,
        {
          gamePk: s.gameId,
          teams: s.opening.gameData.teams,
          setup: setupOf(s.opening)
        },
        { setTimer: () => null, clearTimer: () => undefined }
      )
      expect(
        reopened.eventTargets
          .filter(target => expected.some(([id]) => id === target.id))
          .map(target => [target.id, target.tag])
      ).deep.equals(expected)
    })
  it('does not offer an awarded home-run runner a return while the batter retains the home run', () => {
    const { session: s } = priorRunnerFixture('occupied')
    const log = [...s.actions]
    const result = log.findLastIndex(action => action.type === 'result')
    log[result] = { type: 'result', eventType: 'home_run' }
    expect(s.sync(log)).deep.equals([])
    expect(
      priorRunners(s.state).some(candidate => candidate.runner === 100)
    ).equals(false)
    expect(returnPriorRunner(s.opening, s.actions, s.state, 100, 3)).equals(
      null
    )
    const open = applyActions(s.opening, log.slice(0, -1)).state
    expect(
      applyActions(open, [
        { type: 'runnerMovement', runner: 100, to: '3B', reason: 'Back' }
      ]).problems
    ).not.deep.equals([])
    expect(s.state.liveData.linescore.teams.away.runs).equals(2)
  })
  for (const reason of ['Throwing Error', 'Fielding Error'] as const)
    it(`retains a shared ${reason} when its first runner returns home to third`, async () => {
      const { session: s, store } = priorRunnerFixture('occupied')
      expect(
        s.apply({ type: 'baseRunning', kind: 'steal', runner: 100 }).problems
      ).deep.equals([])
      expect(
        s.apply({
          type: 'runnerMovement',
          runner: 100,
          to: 'home',
          reason,
          error: 207
        }).problems
      ).deep.equals([])
      const errorEvent = previousRunnerError(s.state, reason, 207)!
      expect(
        s.apply({
          type: 'runnerMovement',
          runner: 101,
          to: '2B',
          reason,
          error: 207,
          errorEvent
        }).problems
      ).deep.equals([])
      for (const action of [
        ...Array<ScoringAction>(3).fill({ type: 'pitch', call: 'C' }),
        { type: 'gameFlow', kind: 'closePlay' },
        { type: 'pitch', call: 'B' }
      ] as ScoringAction[])
        expect(s.apply(action).problems).deep.equals([])
      const before = copyState(s.picture().current)
      const eventCount =
        s.state.liveData.plays.allPlays.at(-1)!.playEvents.length
      const original = JSON.stringify({
        opening: s.opening,
        state: s.state,
        log: s.actions
      })
      const proposed = returnPriorRunner(s.opening, s.actions, s.state, 100, 3)!
      expect(proposed).not.equals(null)
      expect(
        JSON.stringify({ opening: s.opening, state: s.state, log: s.actions })
      ).equals(original)
      expect(s.sync(proposed.log)).deep.equals([])
      expect(baseIds(s.state)).deep.equals([null, 101, 100])
      expect(s.state.liveData.linescore.teams.away.runs).equals(0)
      expect(s.state.liveData.linescore.teams.home.errors).equals(1)
      const play = s.state.liveData.plays.allPlays.at(-1)!
      expect(play.playEvents).has.length(eventCount)
      expect(
        play.runners.filter(row => row.details.runner.id === 101)
      ).has.length(1)
      expect(
        play.runners.find(row => row.details.runner.id === 101)!.credits[0]
          .player.id
      ).equals(207)
      expect(s.picture().current).deep.equals(before)
      await s.flush()
      const reopened = await ScoringSession.open(
        store,
        s.gameId,
        {
          gamePk: s.gameId,
          teams: s.opening.gameData.teams,
          setup: setupOf(s.opening)
        },
        { setTimer: () => null, clearTimer: () => undefined }
      )
      expect(baseIds(reopened.state)).deep.equals([null, 101, 100])
      expect(
        reopened.state.liveData.plays.allPlays.at(-1)!.runners
      ).deep.equals(play.runners)
    })
  it('forgets removed pitch identities before the same pitch is scored again without a subscriber', async () => {
    const { session: s, store } = priorRunnerFixture('pitched')
    const removed = s.eventTargets.at(-1)!
    expect(s.setEventTag(removed.id, 'Great pitch')).equals(true)
    await s.flush()
    expect(s.sync(s.actions.slice(0, -1))).deep.equals([])
    expect(s.apply({ type: 'pitch', call: 'B' }).problems).deep.equals([])
    const replacement = s.eventTargets.at(-1)!
    expect(replacement.id).not.equals(removed.id)
    expect(replacement.tag).equals(null)
    await s.flush()
    const reopened = await ScoringSession.open(
      store,
      s.gameId,
      {
        gamePk: s.gameId,
        teams: s.opening.gameData.teams,
        setup: setupOf(s.opening)
      },
      { setTimer: () => null, clearTimer: () => undefined }
    )
    expect(reopened.eventTargets.at(-1)).deep.equals(replacement)
  })
  for (const kind of ['steal', 'defensive_indifference'] as const)
    it(`preserves an earlier implicit ${kind} when removing a hit offer`, () => {
      const { session: s } = priorRunnerFixture('second')
      expect(
        s.sync(
          s.actions.map(action =>
            action.type === 'baseRunning' ? { ...action, kind } : action
          )
        )
      ).deep.equals([])
      const previous = copyState(s.state.liveData.plays.allPlays.at(-1))!
      correct(s, 2)
      const play = s.state.liveData.plays.allPlays.at(-1)!
      expect(play.playEvents).deep.equals(previous.playEvents)
      expect(
        play.runners
          .filter(row => row.details.runner.id === 100)
          .map(row => [row.movement.start, row.movement.end])
      ).deep.equals([[1, 2]])
      expect(
        s.actions.some(
          action => action.type === 'baseRunning' && action.kind === kind
        )
      ).equals(true)
    })
  for (const kind of ['wild_pitch', 'passed_ball'] as const)
    it(`returns a ${kind} advance without changing another runner`, () => {
      const { session: s } = priorRunnerFixture('occupied')
      for (const action of [
        { type: 'pitch', call: 'B' },
        {
          type: 'batteryEvent',
          kind,
          advances: [
            { runner: 100, to: '3B' },
            { runner: 101, to: '2B' }
          ]
        },
        ...Array<ScoringAction>(3).fill({ type: 'pitch', call: 'C' }),
        { type: 'gameFlow', kind: 'closePlay' },
        { type: 'pitch', call: 'B' }
      ] as ScoringAction[])
        expect(s.apply(action).problems).deep.equals([])
      // Return the trailing runner first, leaving second free for the leader.
      const trailing = returnPriorRunner(s.opening, s.actions, s.state, 101, 1)!
      expect(trailing).not.equals(null)
      expect(s.sync(trailing.log)).deep.equals([])
      expect(baseIds(s.state)).deep.equals([101, null, 100])
      correct(s, 2)
      expect(baseIds(s.state)).deep.equals([101, 100, null])
    })
  for (const base of ['2B', '3B'] as const)
    it(`corrects a manual placement at ${base}`, () => {
      const { session: s } = priorRunnerFixture('first')
      expect(
        s.sync([
          { type: 'result', eventType: 'manual_placement', base },
          { type: 'gameFlow', kind: 'closePlay' }
        ])
      ).deep.equals([])
      correct(s, base === '2B' ? 1 : 2)
    })
  it('corrects a placed runner before a closed strikeout', () => {
    const { session: s } = priorRunnerFixture('first')
    expect(
      s.sync([
        { type: 'gameFlow', kind: 'placeRunner', runner: 108, base: '2B' },
        ...Array<ScoringAction>(3).fill({ type: 'pitch', call: 'C' }),
        { type: 'gameFlow', kind: 'closePlay' }
      ])
    ).deep.equals([])
    const correction = returnPriorRunner(s.opening, s.actions, s.state, 108, 1)!
    expect(correction).not.equals(null)
    expect(s.sync(correction.log)).deep.equals([])
    expect(baseIds(s.state)).deep.equals([108, null, null])
  })
  it('preserves acknowledged current pitch tags and identities through notifications and reopen', async () => {
    const { session: s, store } = priorRunnerFixture('pitched')
    const target = s.eventTargets[0]
    expect(s.setEventTag(target.id, 'Great pitch')).equals(true)
    await s.flush()
    const before = copyState(s.eventTargets)
    const heard: unknown[] = []
    const unsubscribe = s.subscribe(() => heard.push(copyState(s.eventTargets)))
    correct(s, 1)
    expect(heard).has.length(1)
    expect(heard[0]).deep.equals(before)
    expect(s.eventTargets).deep.equals(before)
    unsubscribe()
    await s.flush()
    const reopened = await ScoringSession.open(
      store,
      s.gameId,
      {
        gamePk: s.gameId,
        teams: s.opening.gameData.teams,
        setup: setupOf(s.opening)
      },
      { setTimer: () => null, clearTimer: () => undefined }
    )
    expect(reopened.eventTargets).deep.equals(before)
  })
  for (const [eventType, to] of [
    ['double', 1],
    ['triple', 2],
    ['home_run', 3]
  ] as const)
    it(`shortens a result-derived ${eventType} without adding an event`, async () => {
      const { session: s } = priorRunnerFixture('pitched')
      const log = s.actions
        .filter(action => action.type !== 'runnerMovement')
        .map(action =>
          action.type === 'result' ? { ...action, eventType } : action
        )
      expect(s.sync(log)).deep.equals([])
      const current = copyState(s.picture().current)
      const previous = copyState(s.state.liveData.plays.allPlays.at(-1))!
      correct(s, to)
      const changed = s.state.liveData.plays.allPlays.at(-1)!
      expect(changed.result.eventType).equals(
        ['single', 'double', 'triple'][to - 1]
      )
      expect(changed.runners.at(-1)!.movement.end).equals(to)
      expect(changed.playEvents).deep.equals(previous.playEvents)
      expect(s.picture().current!.playEvents).deep.equals(current!.playEvents)
      expect(storedRecordOf(s.picture().current)!.actionTimes).deep.equals(
        storedRecordOf(current)!.actionTimes
      )
      expect(s.state.liveData.linescore.teams.away.runs).equals(0)
      expect(changed.result.rbi).equals(0)
      await s.flush()
    })
  it('keeps the other runner on third when the batter returns after a double', () => {
    const { session: s } = priorRunnerFixture('occupied')
    const log = [...s.actions]
    const lastResult = log.findLastIndex(action => action.type === 'result')
    log[lastResult] = { type: 'result', eventType: 'double' }
    expect(s.sync(log)).deep.equals([])
    const before = s.state.liveData.plays.allPlays.at(-1)!
    const corrected = returnPriorRunner(s.opening, s.actions, s.state, 101, 1)!
    expect(corrected).not.equals(null)
    expect(s.sync(corrected.log)).deep.equals([])
    expect(baseIds(s.state)).deep.equals([101, null, 100])
    expect(s.state.liveData.plays.allPlays.at(-1)!.playEvents).deep.equals(
      before.playEvents
    )
  })
  it('removes the originating steal before a completed strikeout, preserving next pitches', () => {
    const { session: s } = priorRunnerFixture('first')
    for (const action of [
      { type: 'baseRunning', kind: 'steal', runner: 100 },
      ...Array<ScoringAction>(3).fill({ type: 'pitch', call: 'C' }),
      { type: 'gameFlow', kind: 'closePlay' },
      { type: 'pitch', call: 'B' }
    ] as ScoringAction[])
      expect(s.apply(action).problems).deep.equals([])
    const current = copyState(s.picture().current)
    correct(s, 2)
    expect(baseIds(s.state)).deep.equals([null, 100, null])
    expect(
      s.state.liveData.plays.allPlays
        .at(-1)!
        .runners.some(row => row.details.runner.id === 100)
    ).equals(false)
    expect(s.picture().current!.playEvents).deep.equals(current!.playEvents)
    expect(storedRecordOf(s.picture().current)!.actionTimes).deep.equals(
      storedRecordOf(current)!.actionTimes
    )
  })
  it('removes a trailer offer pushed back by a home return, preserving its earlier steal through reopen', async () => {
    const { session: s, store } = priorRunnerFixture('second')
    for (const action of [
      { type: 'baseRunning', kind: 'steal', runner: 101 },
      { type: 'ballInPlay', contact: 'swing', fielder: 207 },
      { type: 'result', eventType: 'single' },
      { type: 'runnerMovement', runner: 100, to: '3B' },
      { type: 'gameFlow', kind: 'closePlay' }
    ] as ScoringAction[])
      expect(s.apply(action).problems).deep.equals([])
    expect(baseIds(s.state)).deep.equals([102, 101, 100])
    const play = s.state.liveData.plays.allPlays.at(-1)!
    const rows = play.runners.filter(row => row.details.runner.id === 101)
    expect(
      rows.map(row => [
        row.movement.start,
        row.movement.end,
        row.details.movementReason
      ])
    ).deep.equals([[1, 2, 'Steal']])
    expect(
      play.source.teamstation
        .runnerActions!.filter(row => row.runner.id === 101)
        .map(row => [row.origin, row.destination, row.reason])
    ).deep.equals([[1, 2, 'Steal']])
    await s.flush()
    const reopened = await ScoringSession.open(
      store,
      s.gameId,
      {
        gamePk: s.gameId,
        teams: s.opening.gameData.teams,
        setup: setupOf(s.opening)
      },
      { setTimer: () => null, clearTimer: () => undefined }
    )
    expect(baseIds(reopened.state)).deep.equals([102, 101, 100])
    expect(reopened.state.liveData.plays.allPlays.at(-1)!.runners).deep.equals(
      play.runners
    )
  })
  it('does not offer a drag back after an optional advance from third was called safe at home', () => {
    const { session: s } = priorRunnerFixture('home')
    expect(baseIds(s.state)).deep.equals([101, null, null])
    expect(s.state.liveData.linescore.teams.away.runs).equals(1)
    expect(priorRunners(s.state)).deep.equals([])
    expect(returnPriorRunner(s.opening, s.actions, s.state, 100, 3)).equals(
      null
    )
    expect(baseIds(s.state)).deep.equals([101, null, null])
    expect(s.state.liveData.linescore.teams.away.runs).equals(1)
    const offered = priorRunnerFixture('second').session
    expect(priorRunners(offered.state)).deep.equals([
      { runner: 100, from: 3, to: 2 }
    ])
  })
  for (const [scenario, to] of [
    ['first', 1],
    ['second', 2],
    ['pitched', 1]
  ] as const)
    it(`returns to ${to} for ${scenario}, retaining the current at-bat`, async () => {
      const { session: s, store } = priorRunnerFixture(scenario)
      const before = copyState(s.picture().current)
      const previous = s.state.liveData.plays.allPlays.at(-1)!
      const next = correct(s, to)
      expect(baseIds(s.state)[to - 1]).equals(100)
      const now = s.picture().current!
      expect(now.matchup).deep.equals(before!.matchup)
      expect(now.count).deep.equals(before!.count)
      expect(now.playEvents).deep.equals(before!.playEvents)
      expect(storedRecordOf(now)!.actions).deep.equals(
        storedRecordOf(before)!.actions
      )
      expect(storedRecordOf(now)!.actionTimes).deep.equals(
        storedRecordOf(before)!.actionTimes
      )
      expect(storedRecordOf(forPlayback(now))!.actionTimes).deep.equals(
        storedRecordOf(forPlayback(before))!.actionTimes
      )
      const changed = s.state.liveData.plays.allPlays.at(-1)!
      expect(changed.playEvents.length).at.most(previous.playEvents.length)
      expect(
        changed.runners.some(
          row => row.details.runner.id === 100 && row.movement.end > to
        )
      ).equals(false)
      expect(
        changed.source.teamstation.runnerActions?.some(
          row => row.runner.id === 100 && row.destination > to
        )
      ).equals(false)
      expect(applyActions(s.opening, next.log).state).deep.equals(s.state)
      await s.flush()
      const reopened = await ScoringSession.open(
        store,
        s.gameId,
        {
          gamePk: s.gameId,
          teams: s.opening.gameData.teams,
          setup: setupOf(s.opening)
        },
        { setTimer: () => null, clearTimer: () => undefined }
      )
      expect(baseIds(reopened.state)[to - 1]).equals(100)
      expect(
        storedRecordOf(reopened.picture().current)!.actionTimes
      ).deep.equals(storedRecordOf(now)!.actionTimes)
      expect(reopened.picture().current!.playEvents).deep.equals(now.playEvents)
      expect(reopened.undo().problems).deep.equals([])
    })
  it('keeps an open hit return unprompted and removes only its offered advance', () => {
    const { session: s } = priorRunnerFixture('open')
    expect(priorRunners(s.state)).deep.equals([])
    expect(
      s.apply({ type: 'runnerMovement', runner: 100, to: '2B' }).problems
    ).deep.equals([])
    expect(
      s.state.liveData.plays.currentPlay!.runners.filter(
        row => row.details.runner.id === 100 && row.details.byAction !== true
      )
    ).deep.equals([])
    expect(
      s.apply({ type: 'runnerMovement', runner: 100, to: '3B' }).problems
    ).deep.equals([])
    expect(baseIds(s.state)[2]).equals(100)
  })
  it('rejects occupied, wrong, nonadjacent and absent prior runners atomically', () => {
    const { session: s } = priorRunnerFixture('occupied')
    const before = JSON.stringify(s.picture())
    expect(returnPriorRunner(s.opening, s.actions, s.state, 100, 1)).equals(
      null
    )
    const first = priorRunnerFixture('first').session
    expect(
      returnPriorRunner(first.opening, first.actions, first.state, 999, 1)
    ).equals(null)
    expect(
      returnPriorRunner(first.opening, first.actions, first.state, 100, 3)
    ).equals(null)
    expect(priorRunners(first.opening)).deep.equals([])
    expect(JSON.stringify(s.picture())).equals(before)
  })
  it('rejects a newly proposed return after a later runner advance or substitution', () => {
    for (const action of [
      { type: 'baseRunning', kind: 'steal', runner: 100 },
      { type: 'lineup', kind: 'runner', side: 'away', base: '2B', player: 108 }
    ] as const) {
      const { session: s } = priorRunnerFixture('first')
      const result = s.apply(action)
      expect(result.problems).deep.equals([])
      const before = copyState(s.state)
      const log = [...s.actions]
      const times = copyState(storedRecordOf(s.picture().current)!.actionTimes)
      expect(
        returnPriorRunner(
          s.opening,
          s.actions,
          s.state,
          100,
          action.type === 'baseRunning' ? 2 : 1
        )
      ).equals(null)
      expect(JSON.stringify(s.state)).equals(JSON.stringify(before))
      expect(s.actions).deep.equals(log)
      expect(storedRecordOf(s.picture().current)!.actionTimes).deep.equals(
        times
      )
    }
  })
  it('rejects a changed half and a completed game', () => {
    const { session: s } = priorRunnerFixture('first')
    const changed = copyState(s.state)
    changed.liveData.plays.currentPlay!.about.halfInning = 'bottom'
    expect(priorRunners(changed)).deep.equals([])
    changed.liveData.plays.currentPlay!.about.halfInning = 'top'
    changed.final = true
    expect(priorRunners(changed)).deep.equals([])
  })
  it('refuses an inconsistent log rather than committing a partial replay', () => {
    const { session: s } = priorRunnerFixture('first')
    expect(returnPriorRunner(s.opening, [], s.state, 100, 1)).equals(null)
    expect(
      returnPriorRunner(
        s.opening,
        [{ type: 'runnerMovement', runner: 999, to: '2B' }],
        s.state,
        100,
        1
      )
    ).equals(null)
    const implicit = [
      ...s.actions.slice(0, -1),
      { type: 'pitch', call: 'B' }
    ] as const
    const state = applyActions(s.opening, implicit).state
    expect(returnPriorRunner(s.opening, implicit, state, 100, 1)).equals(null)
  })
  it('shortens an explicit multi-base advance', () => {
    const { session: s } = priorRunnerFixture('first')
    const log = [...s.actions]
    log[2] = { type: 'runnerMovement', runner: 100, to: '3B' }
    expect(s.sync(log)).deep.equals([])
    correct(s, 2)
    expect(baseIds(s.state)).deep.equals([null, 100, null])
  })
  it('rejects a candidate whose at-bat no longer matches the replay', () => {
    const { session: s } = priorRunnerFixture('first')
    const state = copyState(s.state)
    state.liveData.plays.currentPlay!.count.balls = 3
    expect(returnPriorRunner(s.opening, s.actions, state, 100, 1)).equals(null)
  })
  it('preserves unknown legacy pitch times through correction and save', async () => {
    const { session: s, store } = priorRunnerFixture('pitched')
    await s.flush()
    const loaded = await store.load(s.gameId)
    const current = loaded.currentPlay as unknown as {
      teamStation: { actionTimes?: unknown; playbackTimes?: unknown }
    }
    delete current.teamStation.actionTimes
    delete current.teamStation.playbackTimes
    const legacyStore = { load: async () => loaded, save: store.save }
    const legacy = await ScoringSession.open(
      legacyStore,
      s.gameId,
      {
        gamePk: s.gameId,
        teams: s.opening.gameData.teams,
        setup: setupOf(s.opening)
      },
      { setTimer: () => null, clearTimer: () => undefined }
    )
    const before = storedRecordOf(legacy.picture().current)!.actionTimes
    correct(legacy, 1)
    expect(storedRecordOf(legacy.picture().current)!.actionTimes).deep.equals(
      before
    )
    await legacy.flush()
  })
  it('preserves an unrelated pitching change and its current pitches', () => {
    const { session: s } = priorRunnerFixture('pitched')
    expect(
      s.apply({
        type: 'lineup',
        kind: 'position',
        side: 'home',
        player: 207,
        position: 'P'
      }).problems
    ).deep.equals([])
    const before = copyState(s.picture().current)
    correct(s, 1)
    expect(s.picture().current!.playEvents).deep.equals(before!.playEvents)
    expect(storedRecordOf(s.picture().current)!.actionTimes).deep.equals(
      storedRecordOf(before)!.actionTimes
    )
    expect(s.state.liveData.linescore.defense.P!.id).equals(207)
  })
})
