import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  currentRoute,
  scoringOriginHistory,
  seedRoute,
  showRoute,
  stepBackTo
} from './useAddressBar.native'

describe('closing the full-screen player on a phone (U12)', function () {
  it('goes back to the step it was opened over, with the address it has now', function () {
    seedRoute(null)
    showRoute({ name: 'game', gameId: 'g1', tab: 'watch', videoId: 'v1' })
    const depth = scoringOriginHistory()
    showRoute({
      name: 'game',
      gameId: 'g1',
      tab: 'watch',
      angles: ['v1'],
      audio: 'v1'
    })
    expect(scoringOriginHistory()).equals(depth + 1)
    stepBackTo({
      name: 'game',
      gameId: 'g1',
      tab: 'watch',
      videoId: 'v1',
      at: 42
    })
    // One step, not a copy of the page for Android's Back to walk into.
    expect(scoringOriginHistory()).equals(depth)
    expect(currentRoute()).deep.include({ videoId: 'v1', at: 42 })
  })
})
