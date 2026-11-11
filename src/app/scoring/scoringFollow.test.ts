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
    expect(
      authoredScoringEvent({
        type: 'CLOSE_PLAY',
        generation: 1,
        authored: true
      })
    ).equals(true)
    expect(authoredScoringEvent({ type: 'GESTURE', active: true })).equals(
      false
    )
    expect(authoredScoringEvent({ type: 'GESTURE', active: false })).equals(
      false
    )
    expect(authoredScoringEvent({ type: 'SAVED_UNDONE' })).equals(false)
    expect(
      authoredScoringEvent({ type: 'PRESENTATION', enabled: true })
    ).equals(false)
  })

  it('keeps a plan refresh passive without invalidating a remote read', () => {
    const follow = new ScoringFollow()
    follow.adopt(follow.snapshot())
    const reading = follow.snapshot()
    expect(
      follow.input({ type: 'PLANS', plans: { away: null, home: null } })
    ).equals(false)
    expect(follow.current(reading)).equals(true)
    expect(follow.observing).equals(true)
    expect(follow.locallyAuthored).equals(false)
  })

  it('keeps observing after a canceled runner drag while invalidating a read begun before the drag', () => {
    const follow = new ScoringFollow()
    follow.adopt(follow.snapshot())
    const reading = follow.snapshot()
    expect(follow.input({ type: 'GESTURE', active: true })).equals(false)
    expect(follow.current(reading)).equals(false)
    expect(follow.input({ type: 'GESTURE', active: false })).equals(false)
    expect(follow.observing).equals(true)
    expect(follow.locallyAuthored).equals(false)
    expect(follow.adopt(follow.snapshot())).equals(true)
    follow.input({ type: 'PITCH', kind: 'ball' })
    expect(follow.observing).equals(false)
  })
})
