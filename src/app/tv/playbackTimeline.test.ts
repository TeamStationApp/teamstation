import { expect } from 'chai'
import { describe, it } from 'mocha'

import { storedRecordOf } from '../../common/scoring/gumbo'
import { finalGame, replayContext } from '../../test/replayGameFixture'
import { boardAt } from '../player/scoreboardOverlay/boardAt'
import { boxTimeline } from './playbackTimeline'

const context = replayContext()
const game = {
  id: context.gamePk,
  awayTeamId: context.teams.away.id,
  homeTeamId: context.teams.home.id,
  awayTeamName: context.teams.away.name,
  homeTeamName: context.teams.home.name
}
describe('TV historical box score', () => {
  it('reconstructs only completed actions, rolls back on seeks and honors corrected playback stamps', async () => {
    const stored = await finalGame()
    let stamp = 100000
    for (const play of [...stored.plays, stored.currentPlay]) {
      const record = storedRecordOf(play)
      if (record === null) continue
      const playbackTimes = record.actions.map(() =>
        new Date((stamp += 1000)).toISOString()
      )
      const document = play as { teamStation: object }
      document.teamStation = { ...document.teamStation, playbackTimes }
    }
    const before = JSON.stringify(stored)
    const steps = boxTimeline(game, stored)
    expect(steps.length).greaterThan(20)
    expect(boardAt(steps, 99999)!.box.away.runs).equals(0)
    expect(boardAt(steps, 99999)!.box.away.batting.length).greaterThan(0)
    const early = boardAt(steps, steps[1].at)!.box
    const final = boardAt(steps, Infinity)!.box
    expect(early.away.runs).equals(0)
    expect(early.home.pitching.reduce((n, p) => n + p.pc, 0)).equals(1)
    expect(early.away.batting.reduce((n, p) => n + p.bb, 0)).equals(0)
    const walk = boardAt(steps, steps[6].at)!.box
    expect(walk.home.pitching.reduce((n, p) => n + p.pc, 0)).equals(5)
    expect(walk.away.batting.reduce((n, p) => n + p.bb, 0)).equals(1)
    expect(boardAt(steps, steps[1].at)!.box).deep.equals(early)
    expect(final.away.runs).equals(2)
    expect(final.home.runs).equals(3)
    expect(boardAt(steps, steps[1].at)!.box).equals(early)
    expect(JSON.stringify(stored)).equals(before)
  })
  it('uses completed-play times when action stamps are absent and shows no fabricated totals without records', async () => {
    const stored = await finalGame()
    for (const play of [...stored.plays, stored.currentPlay]) {
      const record = storedRecordOf(play)
      if (record !== null) {
        const document = play as { teamStation: Record<string, unknown> }
        document.teamStation = { ...document.teamStation, actionTimes: [] }
        delete document.teamStation.playbackTimes
      }
    }
    expect(boxTimeline(game, stored).length).greaterThan(0)
    expect(
      boxTimeline(game, { ...stored, plays: [], currentPlay: null })
    ).deep.equals([])
  })
})
