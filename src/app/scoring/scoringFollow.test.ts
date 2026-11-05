import { expect } from 'chai'
import { describe, it } from 'mocha'

import { authoredScoringEvent, ScoringFollow } from './scoringFollow'

describe('scoring follow ownership', function () {
  it('follows multiple remote steps until an actual local edit claims the play', function () {
    const follow = new ScoringFollow()
    const read = follow.snapshot()
    expect(follow.adopt(read)).equals(true)
    expect(follow.adopt(read)).equals(true)
    expect(follow.observing).equals(true)
    follow.authored()
    expect(follow.observing).equals(false)
    expect(follow.adopt(read)).equals(false)
    expect(follow.adopt(follow.snapshot())).equals(true)
    follow.dispose()
    expect(follow.adopt(follow.snapshot())).equals(false)
  })

  it('distinguishes automatic close and gesture release from user intent', function () {
    expect(authoredScoringEvent({ type: 'PITCH', kind: 'ball' })).equals(true)
    expect(authoredScoringEvent({ type: 'UNDO' })).equals(true)
    expect(authoredScoringEvent({ type: 'CLOSE_PLAY' })).equals(true)
    expect(authoredScoringEvent({ type: 'CLOSE_PLAY', generation: 1 })).equals(
      false
    )
    expect(authoredScoringEvent({ type: 'GESTURE', active: true })).equals(true)
    expect(authoredScoringEvent({ type: 'GESTURE', active: false })).equals(
      false
    )
    expect(authoredScoringEvent({ type: 'SAVED_UNDONE' })).equals(false)
    expect(
      authoredScoringEvent({ type: 'PRESENTATION', enabled: true })
    ).equals(false)
  })
})
