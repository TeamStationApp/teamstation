import { expect } from 'chai'

import {
  answersSeek,
  SEEK_PATIENCE_MS,
  shouldAdoptProgress
} from './seekTracker'

describe('believing the player about the playhead', function () {
  const at = (target: number | null, reported: number, age = 0): boolean =>
    shouldAdoptProgress({ target, reported, sentAt: 1000, now: 1000 + age })

  it('believes it when nothing is outstanding', function () {
    expect(at(null, 42)).equals(true)
  })

  it('does not believe it while a seek is in flight', function () {
    // The report still describes where it was. Adopting it is how a seek gets
    // undone a quarter of a second after it was made.
    expect(at(600, 42)).equals(false)
  })

  it('believes it once the report has arrived at the target', function () {
    expect(at(600, 600.02)).equals(true)
    expect(at(600, 599.94)).equals(true)
  })

  it('believes it again once the deadline has passed', function () {
    // ExoPlayer says nothing at all about a seek issued while paused *and*
    // buffering — a stalled live stream — and one wrong second is better than
    // a playhead wedged for the life of the source.
    expect(at(600, 42, SEEK_PATIENCE_MS + 1)).equals(true)
    expect(at(600, 42, SEEK_PATIENCE_MS - 1)).equals(false)
  })

  it('survives a crawl, which issues a seek per frame', function () {
    // The case a count of outstanding seeks cannot survive: ExoPlayer answers
    // ten of these once, so anything that counted them would never reach zero.
    // A target is simply replaced.
    let target: number | null = null
    for (let frame = 0; frame < 10; frame += 1) {
      target = 600 - frame * 0.04
      expect(
        shouldAdoptProgress({ target, reported: 600, sentAt: 0, now: 16 })
      ).equals(frame < 3)
    }
    // And the one acknowledgement that does arrive names the last of them.
    expect(answersSeek(target, 599.64)).equals(true)
  })

  it('ignores an acknowledgement for something nobody asked for', function () {
    // A discontinuity after a re-prepare is not an answer, and clearing the
    // target on one would let the next report undo a seek still in flight.
    expect(answersSeek(600, 12)).equals(false)
    expect(answersSeek(null, 12)).equals(false)
  })
})
