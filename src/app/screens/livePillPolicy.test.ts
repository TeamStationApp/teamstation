import { expect } from 'chai'
import { describe, it } from 'mocha'

import { showVideoLivePill } from './livePillPolicy'

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
