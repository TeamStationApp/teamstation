import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  finalGame,
  importedThenScoredGame,
  replayContext,
  stateAfterSteps
} from '../../test/replayGameFixture'
import {
  halvesOf,
  inningWord,
  rewindLabel,
  rewindTarget,
  stateBefore
} from './replayRewind'
import { type ReplayTimeline, replayTimelineOf } from './replayTimeline'

const context = replayContext()
const WORDS = { top: 'Rewind to top of %s', bottom: 'Rewind to bottom of %s' }

/** The first step index of each half, in order, with the half. */
function halfStarts(
  timeline: ReplayTimeline
): Array<{ index: number; inning: number; isTop: boolean }> {
  const halves = halvesOf(timeline)
  return halves.flatMap((half, index) =>
    index === 0 ||
    half.inning !== halves[index - 1].inning ||
    half.isTop !== halves[index - 1].isTop
      ? [{ index, ...half }]
      : []
  )
}

describe('replay rewind', function () {
  this.timeout(20000)

  it('gives each step the half it was delivered in', async function () {
    const timeline = replayTimelineOf(await finalGame(), context)
    const halves = halvesOf(timeline)
    expect(halves).length(timeline.steps.length)
    expect(halves[0]).deep.equals({ inning: 1, isTop: true })
    const starts = halfStarts(timeline)
    expect(starts.map(start => [start.inning, start.isTop])).deep.equals([
      [1, true],
      [1, false],
      [2, true],
      [2, false],
      [3, true],
      // The scorer's End Game, after the third out of the top of the third.
      [3, false]
    ])
    for (const [index, half] of halves.entries()) {
      const line = stateBefore(timeline, index).liveData.linescore
      expect({
        inning: line.currentInning,
        isTop: line.isTopInning
      }).deep.equals(half)
    }
    expect(halvesOf(timeline)).equals(halves)
  })

  it('rebuilds the game before a step without changing the start', async function () {
    const timeline = replayTimelineOf(await finalGame(), context)
    const start = JSON.stringify(timeline.start)
    expect(JSON.stringify(stateBefore(timeline, 0))).equals(start)
    for (const { index } of halfStarts(timeline).slice(1)) {
      const before = stateBefore(timeline, index).liveData.linescore
      const expected = stateAfterSteps(timeline, index).liveData.linescore
      expect(before.currentInning).equals(expected.currentInning)
      expect(before.isTopInning).equals(expected.isTopInning)
      expect(before.outs).equals(0)
      expect(before.offense.first ?? null).equals(null)
      expect(before.offense.second ?? null).equals(null)
      expect(before.offense.third ?? null).equals(null)
      expect(before.teams).deep.equals(expected.teams)
    }
    expect(JSON.stringify(timeline.start)).equals(start)
    expect(
      stateBefore(timeline, timeline.steps.length).liveData.linescore.teams
    ).deep.equals(timeline.end.liveData.linescore.teams)
  })

  it('rewinds to this half after two of its steps, else to the half before', async function () {
    const timeline = replayTimelineOf(await finalGame(), context)
    const [top1, bottom1, top2, , top3] = halfStarts(timeline).map(
      start => start.index
    )
    const target = (shown: number): number | undefined =>
      rewindTarget(timeline, shown)?.index
    expect(target(-1)).equals(0)
    expect(target(top1)).equals(0)
    expect(target(top1 + 1)).equals(0)
    expect(target(bottom1)).equals(top1)
    expect(target(bottom1 + 1)).equals(bottom1)
    // The step that made the third out of the top of the first.
    expect(target(bottom1 - 1)).equals(top1)
    expect(target(top2 + 1)).equals(top2)
    expect(rewindTarget(timeline, top2 + 1)?.half).deep.equals({
      inning: 2,
      isTop: true
    })
    expect(target(top3)).equals(halfStarts(timeline)[3].index)
    expect(rewindTarget(timeline, top3)?.half).deep.equals({
      inning: 2,
      isTop: false
    })
    // From the end of the game, which only its End Game step reached.
    const last = timeline.steps.length - 1
    expect(halvesOf(timeline)[last]).deep.equals({ inning: 3, isTop: false })
    expect(target(last)).equals(top3)
    expect(target(timeline.steps.length + 5)).equals(top3)
  })

  it('never goes before the first step of a replay that starts mid-game', async function () {
    const timeline = replayTimelineOf(await importedThenScoredGame(), context)
    expect(timeline.derived).greaterThan(0)
    expect(rewindTarget(timeline, -1)?.index).equals(0)
    expect(rewindTarget(timeline, 0)?.index).equals(0)
    expect(rewindTarget(timeline, 1)?.index).equals(0)
    expect(rewindTarget(timeline, 0)?.half).deep.equals({
      inning: 3,
      isTop: true
    })
  })

  it('has no target on a timeline with no steps', async function () {
    const timeline = replayTimelineOf(await finalGame(), context)
    expect(rewindTarget({ ...timeline, steps: [] }, 3)).equals(null)
  })

  it('names the half in words', function () {
    expect(rewindLabel({ inning: 1, isTop: true }, WORDS)).equals(
      'Rewind to top of first'
    )
    expect(rewindLabel({ inning: 2, isTop: false }, WORDS)).equals(
      'Rewind to bottom of second'
    )
    expect(rewindLabel({ inning: 10, isTop: true }, WORDS)).equals(
      'Rewind to top of tenth'
    )
    expect([1, 12, 20, 21].map(inningWord)).deep.equals([
      'first',
      'twelfth',
      'twentieth',
      '21st'
    ])
  })
})
