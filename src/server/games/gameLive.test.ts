import { expect } from 'chai'
import { describe, it } from 'mocha'

import { gameIsLive } from './gameLive'

describe('the live pill on a game', () => {
  const game = {
    startAt: '2027-04-10T18:00:00Z',
    endAt: '2027-04-10T20:00:00Z',
    status: 'inProgress',
    hasScoringEvents: true
  }
  const start = Date.parse('2027-04-10T17:00:00Z')
  const end = Date.parse('2027-04-10T21:00:00Z')

  it('requires the inclusive hour before start through hour after end', () => {
    for (const now of [start, start + 1, end - 1, end])
      expect(gameIsLive(game, now)).equals(true)
    for (const now of [start - 1, end + 1])
      expect(gameIsLive(game, now)).equals(false)
  })

  it('requires a remaining event, not a stale in-progress status', () => {
    for (const hasScoringEvents of [false, undefined])
      expect(gameIsLive({ ...game, hasScoringEvents }, start)).equals(false)
    expect(gameIsLive({ ...game, status: 'scheduled' }, start)).equals(true)
  })

  it('never shows a finalized or cancelled game', () => {
    for (const status of ['final', 'cancelled'])
      expect(gameIsLive({ ...game, status }, start)).equals(false)
  })

  it('uses the three-hour game duration when no end is set', () => {
    const noEnd = { ...game, endAt: null }
    const fallbackEnd = Date.parse('2027-04-10T22:00:00Z')
    expect(gameIsLive(noEnd, fallbackEnd)).equals(true)
    expect(gameIsLive(noEnd, fallbackEnd + 1)).equals(false)
  })

  it('hides games without a valid range and non-game events', () => {
    for (const startAt of [null, 'invalid'])
      expect(gameIsLive({ ...game, startAt }, start)).equals(false)
    expect(
      gameIsLive({ ...game, endAt: game.startAt.replace('18:', '16:') }, start)
    ).equals(false)
    expect(gameIsLive({ ...game, eventKind: 'event' }, start)).equals(false)
  })
})
