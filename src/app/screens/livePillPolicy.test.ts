import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  gameLiveWindow,
  showGameLivePill,
  showVideoLivePill
} from './livePillPolicy'

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
    expect(gameLiveWindow(game)).deep.equals([start, end])
    for (const now of [start, start + 1, end - 1, end])
      expect(showGameLivePill(game, now)).equals(true)
    for (const now of [start - 1, end + 1])
      expect(showGameLivePill(game, now)).equals(false)
  })

  it('requires a remaining event, not a stale in-progress status', () => {
    for (const hasScoringEvents of [false, undefined])
      expect(showGameLivePill({ ...game, hasScoringEvents }, start)).equals(
        false
      )
    expect(showGameLivePill({ ...game, status: 'scheduled' }, start)).equals(
      true
    )
  })

  it('never shows a finalized or cancelled game', () => {
    for (const status of ['final', 'cancelled'])
      expect(showGameLivePill({ ...game, status }, start)).equals(false)
  })

  it('uses the three-hour game duration when no end is set', () => {
    const noEnd = { ...game, endAt: null }
    const fallbackEnd = Date.parse('2027-04-10T22:00:00Z')
    expect(showGameLivePill(noEnd, fallbackEnd)).equals(true)
    expect(showGameLivePill(noEnd, fallbackEnd + 1)).equals(false)
  })

  it('hides games without a valid range and non-game events', () => {
    for (const startAt of [null, 'invalid'])
      expect(showGameLivePill({ ...game, startAt }, start)).equals(false)
    expect(
      showGameLivePill(
        { ...game, endAt: game.startAt.replace('18:', '16:') },
        start
      )
    ).equals(false)
    expect(showGameLivePill({ ...game, eventKind: 'event' }, start)).equals(
      false
    )
  })
})

describe('the live pill on a video', () => {
  const startAt = '2027-04-10T18:00:00Z'
  const endAt = '2027-04-10T20:00:00Z'
  const game = { startAt, endAt, status: 'scheduled' }
  const before = Date.parse(startAt) - 1
  const during = Date.parse(startAt)
  const after = Date.parse(endAt)

  it('stays up during the game after a camera drops', () => {
    const dropped = { status: 'live', receiving: false }
    expect(showVideoLivePill(dropped, game, during)).equals(true)
    expect(showVideoLivePill(dropped, game, Date.parse(endAt) - 1)).equals(true)
  })

  it('comes off after the game when nothing is sending', () => {
    const dropped = { status: 'live', receiving: false }
    expect(showVideoLivePill(dropped, game, after)).equals(false)
    expect(
      showVideoLivePill(dropped, { ...game, status: 'final' }, during)
    ).equals(false)
    expect(showVideoLivePill({ status: 'live' }, game, after)).equals(false)
  })

  it('stays up after the game while bytes are arriving', () => {
    const sending = { status: 'live', receiving: true }
    expect(showVideoLivePill(sending, game, after)).equals(true)
    expect(
      showVideoLivePill(sending, { ...game, status: 'final' }, after)
    ).equals(true)
  })

  it('hides a dropped camera before the game and shows one that is sending', () => {
    expect(
      showVideoLivePill({ status: 'live', receiving: false }, game, before)
    ).equals(false)
    expect(
      showVideoLivePill({ status: 'live', receiving: true }, game, before)
    ).equals(true)
  })

  it('hides a video that is not live', () => {
    expect(
      showVideoLivePill({ status: 'ready', receiving: true }, game, during)
    ).equals(false)
    expect(showVideoLivePill(undefined, game, during)).equals(false)
  })
})
