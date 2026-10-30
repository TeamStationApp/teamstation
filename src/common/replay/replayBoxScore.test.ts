import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  AWAY_PLAYERS,
  finalGame,
  firstActionOfHalf,
  HOME_PLAYERS,
  importedThenScoredGame,
  replayActions,
  replayContext,
  scored,
  stateAfterSteps
} from '../../test/replayGameFixture'
import type { ScoringAction } from '../scoring/actions'
import { statLines } from '../scoring/credits'
import type { Position } from '../scoring/state'
import {
  battingTotals,
  pitchingTotals,
  type ReplayBattingLine,
  replayBoxScore,
  type ReplayPitchingLine,
  scoredFrom
} from './replayBoxScore'
import { replayTimelineOf } from './replayTimeline'

const context = replayContext()
const away = (index: number): number => AWAY_PLAYERS[index].gumboId
const home = (index: number): number => HOME_PLAYERS[index].gumboId

function names(lines: Array<{ name: string }>): string[] {
  return lines.map(line => line.name)
}

describe('replay box score', function () {
  this.timeout(20000)

  it('lists every starter and both starting pitchers, empty, before the first pitch', async function () {
    const timeline = replayTimelineOf(await finalGame(), context)
    const box = replayBoxScore(timeline.start)
    expect(names(box.away.batting)).deep.equals([
      'Juan S',
      'Aaron J',
      'Anthony R',
      'Gleyber T',
      'Anthony V',
      'Luis Ga',
      'Jose T',
      'Harrison B',
      'Gerrit C'
    ])
    for (const line of [...box.away.batting, ...box.home.batting])
      expect([line.ab, line.r, line.h, line.rbi, line.bb, line.k]).deep.equals([
        0, 0, 0, 0, 0, 0
      ])
    expect(names(box.away.pitching)).deep.equals(['Gerrit C'])
    expect(names(box.home.pitching)).deep.equals(['Tyler G'])
    expect(box.home.pitching[0]).includes({ ip: '0.0', pc: 0, current: true })
    expect(box.away.batting[0].current).equals(true)
    expect(box.away.innings).deep.equals([0])
    expect(box.home.innings).deep.equals([null])
    expect(box.from).equals(null)
  })

  it('puts substitutes under the slot they entered and pitchers in the order they pitched', async function () {
    const timeline = replayTimelineOf(await finalGame(), context)
    const box = replayBoxScore(timeline.end)
    // Stanton pinch-hit for Bader and stayed in; Gil relieved Cole.
    expect(
      box.away.batting.slice(7).map(line => [line.name, line.sub])
    ).deep.equals([
      ['Harrison B', false],
      ['Giancarlo S', true],
      ['Gerrit C', false],
      ['Luis Gi', true]
    ])
    // Gil got more outs than Cole and is still listed after him; Stanton
    // never pitched and is not listed as a pitcher.
    expect(names(box.away.pitching)).deep.equals(['Gerrit C', 'Luis Gi'])
    expect(box.away.pitching.map(line => line.ip)).deep.equals(['0.2', '1.1'])
    // Volpe's run, after Betts's error, is unearned to Glasnow.
    expect(box.home.pitching[0]).includes({
      name: 'Tyler G',
      ip: '3.0',
      r: 2,
      er: 1,
      k: 4
    })
    expect(box.home.pitching[0].pc).equals(
      timeline.end.liveData.boxscore.teams.home.pitchCounts[home(8)]
    )
    expect(box.away.pitching[1]).includes({ r: 2, er: 2 })
    // A finished game has nobody at the plate or on the mound.
    expect(
      [...box.away.batting, ...box.home.batting].some(line => line.current)
    ).equals(false)
    expect(box.away.innings).deep.equals([1, 1, 0])
    expect(box.home.innings).deep.equals([1, 2, null])
    expect([box.away.runs, box.away.hits, box.away.errors]).deep.equals([
      2, 2, 0
    ])
    expect([box.home.runs, box.home.hits, box.home.errors]).deep.equals([
      3, 3, 1
    ])
    const rizzo = box.away.batting.find(line => line.id === away(2))!
    expect(rizzo).includes({ ab: 2, h: 1, rbi: 1, k: 1 })
  })

  it('keeps players who only change positions in their own slots, and lists a fielder who moves to the mound as a pitcher', async function () {
    const actions = replayActions()
    const at = firstActionOfHalf(actions, 2, 'bottom')
    const move = (index: number, position: Position): ScoringAction => ({
      type: 'lineup',
      kind: 'position',
      side: 'away',
      position,
      player: away(index)
    })
    const timeline = replayTimelineOf(
      await scored([
        ...actions.slice(0, at),
        // Torres (batting 4th, 2B) and Volpe (5th, SS) swap places; Garcia
        // (6th, 3B) comes in to pitch and Gil, who relieved Cole at ninth,
        // goes to third.
        move(3, 'SS'),
        move(4, '2B'),
        move(5, 'P'),
        move(10, '3B'),
        { type: 'pitch', call: 'B' }
      ]),
      context
    )
    const box = replayBoxScore(timeline.end)
    const ids = box.away.batting.map(line => line.id)
    expect(ids).length(new Set(ids).size)
    expect(names(box.away.batting)).deep.equals([
      'Juan S',
      'Aaron J',
      'Anthony R',
      'Gleyber T',
      'Anthony V',
      'Luis Ga',
      'Jose T',
      'Harrison B',
      'Giancarlo S',
      'Gerrit C',
      'Luis Gi'
    ])
    expect(names(box.away.batting.filter(line => line.sub))).deep.equals([
      'Giancarlo S',
      'Luis Gi'
    ])
    expect(names(box.away.pitching)).deep.equals([
      'Gerrit C',
      'Luis Gi',
      'Luis Ga'
    ])
  })

  it('tells two players with the same short name apart', async function () {
    const timeline = replayTimelineOf(await finalGame(), context)
    const box = replayBoxScore(timeline.end)
    expect(names(box.away.batting)).to.include.members(['Luis Ga', 'Luis Gi'])
  })

  it('marks who is at the plate and on the mound in the middle of a game', async function () {
    const timeline = replayTimelineOf(await finalGame(), context)
    // After Freeman's strikeout: two out in the bottom of the 1st.
    const index = timeline.steps.findIndex(
      step => step.atBatIndex === 5 && step.actions.at(-1)?.type === 'gameFlow'
    )
    const state = stateAfterSteps(timeline, index + 1)
    const box = replayBoxScore(state)
    expect(box.away.pitching[0]).includes({
      name: 'Gerrit C',
      ip: '0.1',
      current: true
    })
    const atBat = box.home.batting.filter(line => line.current)
    expect(atBat.map(line => line.id)).deep.equals([home(2)])
    expect(box.away.batting.some(line => line.current)).equals(false)
    expect(box.home.innings).deep.equals([1])
  })

  it('counts only its own scoring after imported innings, and leaves those innings blank', async function () {
    const timeline = replayTimelineOf(await importedThenScoredGame(), context)
    const from = scoredFrom(timeline.start, timeline.derived)
    expect(from).deep.equals({ inning: 3, half: 'top' })
    for (let count = 0; count <= timeline.steps.length; count++) {
      const state = stateAfterSteps(timeline, count)
      const box = replayBoxScore(state, from)
      expect([box.away.runs, box.home.runs]).deep.equals([2, 3])
    }
    const box = replayBoxScore(timeline.end, from)
    expect(box.from).deep.equals(from)
    expect(box.away.innings.slice(0, 2)).deep.equals([null, null])
    expect(box.away.innings[2]).equals(0)
    const lines = statLines(timeline.end.liveData.plays.allPlays)
    for (const line of box.away.batting)
      expect(line.ab).equals(lines.batting[line.id]?.ab ?? 0)
    expect(box.away.batting.reduce((sum, line) => sum + line.ab, 0)).equals(3)
  })

  it('has no blank innings when nothing was imported', async function () {
    const timeline = replayTimelineOf(await finalGame(), context)
    expect(scoredFrom(timeline.start, timeline.derived)).equals(null)
  })
})

describe('the replay box score totals', function () {
  const batter = (
    id: number,
    figures: Partial<ReplayBattingLine>
  ): ReplayBattingLine => ({
    id,
    name: `Batter ${id}`,
    ab: 0,
    r: 0,
    h: 0,
    rbi: 0,
    bb: 0,
    k: 0,
    sub: false,
    current: false,
    ...figures
  })
  const pitcher = (
    id: number,
    outs: number,
    figures: Partial<ReplayPitchingLine> = {}
  ): ReplayPitchingLine => ({
    id,
    name: `Pitcher ${id}`,
    outs,
    ip: `${Math.floor(outs / 3)}.${outs % 3}`,
    h: 1,
    r: 1,
    er: 0,
    bb: 1,
    k: 2,
    pc: 20,
    current: false,
    ...figures
  })

  it('adds up each batting column, a batter yet to bat adding nothing', function () {
    expect(
      battingTotals([
        batter(1, { ab: 3, r: 1, h: 2, rbi: 1, k: 1 }),
        batter(2, { ab: 4, h: 1, bb: 1, k: 2 }),
        batter(3, {})
      ])
    ).deep.equals({ ab: 7, r: 1, h: 3, rbi: 1, bb: 1, k: 3 })
    expect(battingTotals([])).deep.equals({
      ab: 0,
      r: 0,
      h: 0,
      rbi: 0,
      bb: 0,
      k: 0
    })
  })

  it('adds innings as outs, and the other pitching columns as they are', function () {
    expect(
      pitchingTotals([pitcher(1, 4), pitcher(2, 5, { er: 1, pc: 31 })])
    ).deep.equals({
      outs: 9,
      ip: '3.0',
      h: 2,
      r: 2,
      er: 1,
      bb: 2,
      k: 4,
      pc: 51
    })
  })
})
