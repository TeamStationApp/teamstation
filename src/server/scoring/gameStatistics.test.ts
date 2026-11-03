import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  statisticsForAction,
  statisticsForCount,
  statisticsWindow
} from '../../common/gameStatistics'
import type { GumboPlay } from '../../common/gumboPlay'
import { replayBoxScore } from '../../common/replay/replayBoxScore'
import { stateBefore } from '../../common/replay/replayRewind'
import { replaySourceOf } from '../../common/replay/replaySource'
import {
  finalGame,
  importedThenScoredGame,
  replayContext
} from '../../test/replayGameFixture'
import { statisticsQuery } from './gameStatistics'
import {
  historicalStatistics,
  importedStatistics
} from './historicalStatistics'

const context = replayContext()
const game = {
  id: context.gamePk,
  homeTeamId: context.teams.home.id,
  awayTeamId: context.teams.away.id,
  homeTeamName: 'Hosts',
  awayTeamName: 'Visitors'
}
const imported = JSON.parse(
  readFileSync(join(__dirname, '../stats/fixtures/imported1.json'), 'utf8')
) as { plays: GumboPlay[] }

describe('unified historical game statistics', function () {
  this.timeout(60000)
  it('reconstructs imported games at completed plays without native records', () => {
    const all = historicalStatistics(game, {
      plays: imported.plays,
      currentPlay: null
    })
    expect(all.initial).equals(null)
    expect(all.boxes.length).equals(imported.plays.length)
    expect(all.boxes[0].box?.away.runs).equals(0)
    expect(all.boxes.at(-1)?.box?.home.runs).equals(11)
    expect(all.boxes.at(-1)?.box?.away.runs).equals(3)
    expect(all.boxes.at(-1)?.box?.away.batting.length).greaterThan(0)
    expect(
      statisticsWindow(all.boxes, { at: all.boxes[0].at - 1 })
    ).deep.equals([])
    expect(
      statisticsWindow(all.boxes, { at: all.boxes[0].at })[0].box?.home.runs
    ).equals(0)
  })
  it('keeps native replay parity including the initial lineup and final out', async () => {
    const stored = await finalGame()
    const source = replaySourceOf(game, stored)!
    const stats = historicalStatistics(game, stored)
    expect(stats.initial).deep.equals(replayBoxScore(source.timeline.start))
    expect(stats.boxes.at(-1)?.box).deep.equals(
      replayBoxScore(source.timeline.end)
    )
    expect(stats.boxes.every(step => Number.isFinite(step.at))).equals(true)
    expect(statisticsForAction(stats, null)).deep.equals(stats.initial)
    const first = stats.boxes[0]
    expect(statisticsForAction(stats, first.position)).deep.equals(first.box)
  })
  it('matches the replay action cursor at every delivery boundary, including close-play actions', async () => {
    const stored = await finalGame()
    const source = replaySourceOf(game, stored)!
    const stats = historicalStatistics(game, stored)
    let count = 0
    for (let index = 0; index < source.timeline.steps.length; index++) {
      expect(statisticsForCount(stats, count), `step ${index}`).deep.equals(
        replayBoxScore(stateBefore(source.timeline, index))
      )
      count += source.timeline.steps[index].actions.length
    }
    expect(statisticsForCount(stats, count)).deep.equals(
      replayBoxScore(source.timeline.end)
    )
  })
  it('counts imported prefixes together with subsequent native actions', async () => {
    const stored = await importedThenScoredGame()
    const stats = historicalStatistics(game, stored)
    expect(
      stats.boxes.some(step => step.position === null && step.box !== null)
    ).equals(true)
    expect(
      stats.boxes.some(step => step.position !== null && step.box !== null)
    ).equals(true)
    expect(stats.boxes.at(-1)?.box?.from).equals(null)
    expect(stats.boxes.at(-1)?.box?.away.runs).equals(
      stored.plays.at(-1)?.result.awayScore
    )
  })
  it('never substitutes native-only totals for an incomplete imported prefix', async () => {
    const stored = await importedThenScoredGame()
    delete stored.plays[0].matchup
    const statistics = historicalStatistics(game, stored)
    const native = statistics.boxes.filter(step => step.position !== null)
    expect(native.length).greaterThan(0)
    expect(
      native.every(
        step =>
          step.box === null && step.message?.includes('incomplete') === true
      )
    ).equals(true)
  })
  it('reports incomplete details and excludes a reopened imported play', () => {
    const broken = structuredClone(imported.plays[0])
    delete broken.matchup
    expect(importedStatistics(game, [broken])).deep.equals({
      box: null,
      message: 'Player statistics are incomplete in the recorded plays.'
    })
    const current = imported.plays[0] as unknown as NonNullable<
      Parameters<typeof historicalStatistics>[1]['currentPlay']
    >
    expect(
      historicalStatistics(game, {
        plays: [imported.plays[0]],
        currentPlay: current
      }).boxes
    ).deep.equals([])
    expect(
      historicalStatistics(game, { plays: [], currentPlay: null })
    ).deep.equals({ initial: null, boxes: [] })
  })
  it('uses monotonic fallbacks and preserves the last step at window boundaries', () => {
    const plays = structuredClone(imported.plays.slice(0, 3))
    plays.forEach(play => {
      delete play.about.startTime
      delete play.about.endTime
    })
    const stats = historicalStatistics(
      { ...game, startAt: '2026-01-01T00:00:00Z' },
      { plays, currentPlay: null }
    )
    expect(new Set(stats.boxes.map(step => step.at)).size).equals(1)
    const steps = [{ at: 1 }, { at: 2 }, { at: 3 }]
    expect(statisticsWindow(steps, { fromMs: 2, toMs: 3 })).deep.equals([
      { at: 2 },
      { at: 3 }
    ])
    expect(statisticsWindow(steps, { at: 0 })).deep.equals([])
    expect(statisticsWindow(steps, { toMs: 2 })).deep.equals([
      { at: 1 },
      { at: 2 }
    ])
  })
  it('validates explicit playback bounds and preserves default totals', () => {
    expect(statisticsQuery({})).equals(null)
    expect(statisticsQuery({ view: 'playback', at: '0' })).deep.equals({
      at: 0,
      fromMs: undefined,
      toMs: undefined
    })
    for (const query of [
      { at: '1' },
      { view: 'final' },
      { view: ['playback'] },
      { view: 'playback', at: 'NaN' },
      { view: 'playback', from: ['1', '2'] },
      { view: 'playback', at: '-1' },
      { view: 'playback', at: '1.5' },
      { view: 'playback', at: '1', from: '0' },
      { view: 'playback', from: '2', to: '1' },
      { view: 'playback', at: '999999999999999999999' }
    ])
      expect(() => statisticsQuery(query)).to.throw()
  })
})
