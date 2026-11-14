import { expect } from 'chai'
import { describe, it } from 'mocha'

import { replacedNotice } from './sidesSwapped'

describe('the notice of a game swapped or reset under the screen', function () {
  const swap = { reset: false, swapped: true }
  const reset = { reset: true, swapped: false }
  const both = { reset: true, swapped: true }

  it('says changes were not kept only of those the server did not take', function () {
    expect(replacedNotice(swap, 0)).equals('Home and away were swapped.')
    expect(replacedNotice(swap, 2)).equals(
      'Home and away were swapped, so changes not yet saved before the swap were not kept.'
    )
    expect(replacedNotice(reset, 1)).equals(
      'This game was reset, so 1 change not yet saved before the reset was not kept.'
    )
  })

  it('says changes sent with no answer may not have been kept, never that they were lost (9.harness-review.2)', function () {
    expect(replacedNotice(swap, 0, 1)).equals(
      'Home and away were swapped, so changes not yet saved before the swap may not have been kept.'
    )
    expect(replacedNotice(swap, 1, 1)).equals(
      'Home and away were swapped, so changes not yet saved before the swap were not kept, and others may not have been.'
    )
    expect(replacedNotice(reset, 0, 1)).equals(
      'This game was reset, so 1 change not yet saved before the reset may not have been kept.'
    )
    expect(replacedNotice(both, 0, 2)).equals(
      'Home and away were swapped and the game was reset, so 2 changes not yet saved before the reset may not have been kept.'
    )
    expect(replacedNotice(reset, 2, 1)).equals(
      'This game was reset, so 2 changes not yet saved before the reset were not kept, and 1 more may not have been.'
    )
  })
})
