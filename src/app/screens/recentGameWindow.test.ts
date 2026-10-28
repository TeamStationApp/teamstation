import { expect } from 'chai'
import { describe, it } from 'mocha'

import { RECENT_GAME_WINDOW_MS, recentGameIsCurrent } from './recentGameWindow'

const START = '2026-10-04T19:30:00Z'
const at = Date.parse(START)

describe('the recent game window', function () {
  it('is three days', function () {
    expect(RECENT_GAME_WINDOW_MS).equals(259_200_000)
  })

  it('holds from the start to just under three days later', function () {
    expect(recentGameIsCurrent(START, at)).equals(true)
    expect(recentGameIsCurrent(START, at + RECENT_GAME_WINDOW_MS - 1)).equals(
      true
    )
    expect(recentGameIsCurrent(START, at + RECENT_GAME_WINDOW_MS)).equals(false)
  })

  it('leaves out a start still to come, missing or unreadable', function () {
    expect(recentGameIsCurrent(START, at - 1)).equals(false)
    expect(recentGameIsCurrent(null, at)).equals(false)
    expect(recentGameIsCurrent(undefined, at)).equals(false)
    expect(recentGameIsCurrent('not a date', at)).equals(false)
  })
})
