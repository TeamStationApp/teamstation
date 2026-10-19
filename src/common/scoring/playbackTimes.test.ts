import { expect } from 'chai'
import { describe, it } from 'mocha'

import { game } from '../../test/scoringGames'
import { comparablePlay } from './comparable'
import { forPlayback } from './playbackTimes'
import { setupOf } from './state'

const times = [0, 20000, 40000].map(offset =>
  new Date(Date.parse('2026-01-01T12:00:00Z') + offset).toISOString()
)
const later = '2026-01-01T12:11:00.000Z'
function play(calls = ['B', 'C', 'F']): any {
  return {
    teamStation: {
      version: 2,
      setupBefore: setupOf(game()),
      actions: calls.map(call => ({ type: 'pitch', call })),
      actionTimes: [...times]
    }
  }
}

describe('scoring playback times', () => {
  it('uses the historical clock without changing radar times or comparison', () => {
    const original = play()
    original.teamStation.actionTimes[0] = later
    original.teamStation.playbackTimes = times
    const historical = forPlayback(original)
    expect(historical.teamStation.actionTimes).deep.equals(times)
    expect(original.teamStation.actionTimes[0]).equals(later)
    expect(comparablePlay(original)).deep.equals(comparablePlay(historical))
  })

  it('ignores missing or invalid records and falls back from invalid metadata', () => {
    for (const value of [null, {}, { teamStation: {} }]) {
      expect(forPlayback(value)).equals(value)
    }
    for (const invalid of [
      undefined,
      [],
      ['bad', ...times.slice(1)],
      [1, 2, 3]
    ]) {
      const prior = play()
      prior.teamStation.playbackTimes = invalid
      expect(forPlayback(prior)).equals(prior)
    }
  })
})
