import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asImported,
  correctedGame,
  finalGame,
  importedThenScoredGame,
  inProgressGame,
  REPLAY_GAME_ID,
  replayActions,
  replayContext,
  scored
} from '../../test/replayGameFixture'
import { withoutHalves } from '../../test/storedNamesRoundTrip'
import type { ScoringAction } from '../scoring/actions'
import type { StoredGame } from '../scoring/session'
import {
  extendTimeline,
  hasRecords,
  isDetermined,
  isReplayable,
  replayContextOf,
  replayTimelineOf,
  stepsOf
} from './replayTimeline'

const context = replayContext()

describe('replay timeline', function () {
  this.timeout(20000)

  it('cuts a finished game into one step per delivery, with what followed it', async function () {
    const timeline = replayTimelineOf(await finalGame(), context)
    const keys = timeline.steps.map(step => step.key)
    expect(new Set(keys).size).equals(keys.length)
    // Soto's walk: four pitches, the fourth carrying the scorer's close.
    expect(
      timeline.steps.slice(0, 5).map(step => [step.key, step.kind])
    ).deep.equals([
      ['0-0', 'pitch'],
      ['0-1', 'pitch'],
      ['0-2', 'pitch'],
      ['0-3', 'pitch'],
      ['0-4', 'pitch']
    ])
    expect(timeline.steps[4].actions.map(action => action.type)).deep.equals([
      'pitch',
      'gameFlow'
    ])
    // The close is stored as the next play's first action; the next play's
    // steps start after it.
    expect(timeline.steps[5].key).equals('1-1')
    // Rizzo's single: the ball in play with its result, runner and close.
    const single = timeline.steps.find(
      step =>
        step.kind === 'inPlay' &&
        step.actions.some(
          action => action.type === 'result' && action.eventType === 'single'
        )
    )!
    expect(single.actions.map(action => action.type)).deep.equals([
      'ballInPlay',
      'result',
      'runnerMovement',
      'gameFlow'
    ])
    // Gil's entry before his first pitch is a step of its own.
    const entry = timeline.steps.find(step => step.kind === 'other')!
    expect(entry.actions.map(action => action.type)).deep.equals(['lineup'])
    expect(timeline.end.final).equals(true)
    expect(timeline.start.liveData.plays.allPlays).length(0)
    expect(timeline.derived).equals(0)
    // Every stored action is in exactly one step.
    expect(
      timeline.steps.reduce((sum, step) => sum + step.actions.length, 0)
    ).equals(replayActions().length)
  })

  it('ends a game in progress with the at-bat being played', async function () {
    const timeline = replayTimelineOf(await inProgressGame(), context)
    const last = timeline.steps.slice(-2)
    expect(last.map(step => step.kind)).deep.equals(['other', 'pitch'])
    expect(last[1].atBatIndex).equals(13)
    expect(timeline.end.final).equals(false)
  })

  it('starts a game whose first innings were imported where its own scoring begins', async function () {
    const timeline = replayTimelineOf(await importedThenScoredGame(), context)
    expect(timeline.derived).equals(18)
    expect(timeline.steps[0].key).equals('18-0')
    expect(timeline.start.liveData.linescore.teams.away.runs).equals(2)
    expect(timeline.start.liveData.linescore.teams.home.runs).equals(3)
    expect(timeline.start.liveData.linescore.currentInning).equals(3)
  })

  it('has no steps for a game nothing was scored in', async function () {
    const final = await finalGame()
    const imported: StoredGame = {
      plays: final.plays
        .filter(play => (play.about.inning ?? 0) < 3)
        .map(asImported),
      currentPlay: null
    }
    expect(hasRecords(imported)).equals(false)
    expect(replayTimelineOf(imported, context).steps).deep.equals([])
    expect(hasRecords(final)).equals(true)
    expect(replayContextOf(gameDetail(), imported)).equals(null)
  })

  it('starts a play with a step of its own when nothing was delivered yet', function () {
    expect(
      stepsOf(4, [
        { type: 'lineup', kind: 'batterSide', batSide: 'L' },
        { type: 'pitch', call: 'B' }
      ]).map(step => [step.key, step.kind, step.actions.length])
    ).deep.equals([
      ['4-0', 'other', 1],
      ['4-1', 'pitch', 1]
    ])
    expect(stepsOf(4, [])).deep.equals([])
  })

  describe('a newer copy of the game', function () {
    const actions = replayActions()

    it('adds only the new steps when the scorer goes on', async function () {
      const before = replayTimelineOf(
        await scored(actions.slice(0, 10)),
        context
      )
      const change = extendTimeline(
        before,
        await scored(actions.slice(0, 12)),
        context
      )
      // Actions 10 and 11: a ball, then Soto's steal during it.
      expect(change.kind).equals('extend')
      if (change.kind !== 'extend') return
      expect(change.steps.map(step => step.key)).deep.equals(['2-1'])
      expect(change.steps[0].actions.map(action => action.type)).deep.equals([
        'pitch',
        'baseRunning'
      ])
      expect(change.timeline.steps).length(before.steps.length + 1)
    })

    it('carries a step that grew under its own key, whole', async function () {
      // Rizzo's ball in play is saved before its result and runner.
      const inPlay = actions.findIndex(action => action.type === 'ballInPlay')
      const before = replayTimelineOf(
        await scored(actions.slice(0, inPlay + 1)),
        context
      )
      const change = extendTimeline(
        before,
        await scored(actions.slice(0, inPlay + 3)),
        context
      )
      expect(change.kind).equals('extend')
      if (change.kind !== 'extend') return
      expect(change.steps).length(1)
      expect(change.steps[0].key).equals(before.steps.at(-1)!.key)
      expect(change.steps[0].actions.map(action => action.type)).deep.equals([
        'ballInPlay',
        'result',
        'runnerMovement'
      ])
    })

    it('grows the step a close follows into, though the close starts the next play', async function () {
      const before = replayTimelineOf(
        await scored(actions.slice(0, 5)),
        context
      )
      const change = extendTimeline(
        before,
        await scored(actions.slice(0, 6)),
        context
      )
      expect(change.kind).equals('extend')
      if (change.kind !== 'extend') return
      expect(change.steps.map(step => step.key)).deep.equals(['0-4'])
      expect(change.steps[0].actions).length(2)
    })

    it('rewrites when a play is undone, corrected or replaced', async function () {
      const longer = replayTimelineOf(
        await scored(actions.slice(0, 10)),
        context
      )
      expect(
        extendTimeline(longer, await scored(actions.slice(0, 9)), context).kind
      ).equals('rewrite')
      const final = await finalGame()
      const lastPitch = actions.findLastIndex(action => action.type === 'pitch')
      const struckOut = replayTimelineOf(
        await scored(actions.slice(0, lastPitch + 1)),
        context
      )
      expect(
        extendTimeline(struckOut, await correctedGame(), context).kind
      ).equals('rewrite')
      expect(
        extendTimeline(
          replayTimelineOf(final, context),
          await importedThenScoredGame(),
          context
        ).kind
      ).equals('rewrite')
    })
  })
})

function gameDetail(): Parameters<typeof replayContextOf>[0] {
  return {
    id: REPLAY_GAME_ID,
    awayTeamId: context.teams.away.id,
    homeTeamId: context.teams.home.id,
    awayTeamName: context.teams.away.name,
    homeTeamName: context.teams.home.name,
    awayLogoUrl: null,
    homeLogoUrl: 'https://example.test/home.png',
    fenceDistanceFt: 210
  }
}

describe('replay context and whether a game replays', function () {
  it('opens a game with its teams, the first record’s lineups and its fence', async function () {
    const final = await finalGame()
    const made = replayContextOf(gameDetail(), final)!
    expect(made.gamePk).equals(REPLAY_GAME_ID)
    expect(made.teams.home).deep.equals({
      id: context.teams.home.id,
      name: context.teams.home.name,
      logoUrl: 'https://example.test/home.png'
    })
    expect(made.teams.away.logoUrl).equals(null)
    expect(made.fenceDistanceFt).equals(210)
    // Read back as the server answers a game: named, with nobody's halves.
    expect(made.setup).deep.equals(withoutHalves(context.setup))
    // A game whose only record is the at-bat in progress.
    const fresh = await scored(replayActions().slice(0, 1))
    expect(fresh.plays).length(0)
    expect(replayContextOf({ ...gameDetail() }, fresh)?.setup).deep.equals(
      withoutHalves(context.setup)
    )
  })

  it('replays a final or live game with a record for a member only', function () {
    const member = { nonMemberView: false }
    expect(isReplayable({ ...member, status: 'final' }, true)).equals(true)
    expect(isReplayable({ ...member, status: 'inProgress' }, true)).equals(true)
    expect(isReplayable({ ...member, status: 'scheduled' }, true)).equals(false)
    expect(isReplayable({ ...member, status: 'cancelled' }, true)).equals(false)
    expect(isReplayable({ ...member, status: 'final' }, false)).equals(false)
    expect(isReplayable({ nonMemberView: true, status: 'final' }, true)).equals(
      false
    )
  })

  describe('a ball in play the scorer has yet to place', function () {
    const actions = replayActions()
    const inPlay = actions.findIndex(action => action.type === 'ballInPlay')
    const located = actions[inPlay]
    const bare: ScoringAction = { type: 'ballInPlay', contact: 'swing' }
    const timelineOf = async (
      taken: ScoringAction[]
    ): Promise<ReturnType<typeof replayTimelineOf>> =>
      replayTimelineOf(await scored(taken), context)

    it('is undetermined while it is the last step and holds only the bare ball', async function () {
      const timeline = await timelineOf([...actions.slice(0, inPlay), bare])
      const last = timeline.steps.at(-1)!
      expect(last.kind).equals('inPlay')
      expect(isDetermined(last, timeline)).equals(false)
      // Every other step is determined.
      for (const step of timeline.steps.slice(0, -1))
        expect(isDetermined(step, timeline)).equals(true)
    })

    it('is determined once it is placed, has a result, or another step follows', async function () {
      const placed = await timelineOf([
        ...actions.slice(0, inPlay),
        bare,
        located
      ])
      expect(isDetermined(placed.steps.at(-1)!, placed)).equals(true)
      const resulted = await timelineOf([
        ...actions.slice(0, inPlay),
        bare,
        { type: 'result', eventType: 'single' }
      ])
      expect(isDetermined(resulted.steps.at(-1)!, resulted)).equals(true)
      // A step with a later one after it is never held, whatever it holds.
      const whole = await timelineOf(actions)
      const earlier = whole.steps.find(step => step.kind === 'inPlay')!
      expect(isDetermined({ ...earlier, actions: [bare] }, whole)).equals(true)
      for (const ball of [
        { ...bare, fielder: (located as { fielder: number }).fielder },
        { ...bare, trajectory: 'line_drive' as const }
      ]) {
        const timeline = await timelineOf([...actions.slice(0, inPlay), ball])
        expect(isDetermined(timeline.steps.at(-1)!, timeline)).equals(true)
      }
      const pitched = await timelineOf(actions.slice(0, 1))
      expect(isDetermined(pitched.steps[0], pitched)).equals(true)
    })
  })
})
