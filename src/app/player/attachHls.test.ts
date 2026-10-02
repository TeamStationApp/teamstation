import { expect } from 'chai'
import { describe, it } from 'mocha'

import { aheadControl } from './attachHls'
import { shouldResumeAfterRecovery } from './resumeAfterRecovery'

/**
 * What happens to a live game when the stream stumbles.
 *
 * `recoverMediaError` detaches the media element and attaches it again, and
 * detaching calls `load()` — which resets the element, and a reset element is
 * paused. Nothing put it back, so a hiccup stopped the picture and left it
 * stopped until somebody pressed play. To a parent watching a game that is
 * indistinguishable from the game ending.
 */
describe('coming back from a stumble', function () {
  it('plays again when the recovery is what stopped it', function () {
    expect(
      shouldResumeAfterRecovery({
        recovering: true,
        wantsToPlay: true,
        paused: true
      })
    ).equals(true)
  })

  it('leaves a pause the viewer asked for alone', function () {
    // The viewer pressed pause, and then the stream stumbled. Playing again
    // here would take the control away from the person holding it.
    expect(
      shouldResumeAfterRecovery({
        recovering: true,
        wantsToPlay: false,
        paused: true
      })
    ).equals(false)
  })

  it('does nothing when nothing stopped', function () {
    expect(
      shouldResumeAfterRecovery({
        recovering: true,
        wantsToPlay: true,
        paused: false
      })
    ).equals(false)
  })

  it('does nothing outside a recovery', function () {
    // A pause with no recovery in flight is the viewer's, whatever else is
    // true, and is never undone.
    expect(
      shouldResumeAfterRecovery({
        recovering: false,
        wantsToPlay: true,
        paused: true
      })
    ).equals(false)
  })
})

describe('how far ahead a grid tile loads', function () {
  it('moves both of hls.js’s limits together', function () {
    const config = { maxBufferLength: 10, maxMaxBufferLength: 10 }
    const control = aheadControl(config, 10)
    control.setAheadSec(40)
    expect(config).deep.equals({ maxBufferLength: 40, maxMaxBufferLength: 40 })
    control.setAheadSec(15)
    expect(config).deep.equals({ maxBufferLength: 15, maxMaxBufferLength: 15 })
  })

  it('keeps under a cut hls.js made when the browser ran out of room', function () {
    const config = { maxBufferLength: 60, maxMaxBufferLength: 60 }
    const control = aheadControl(config, 60)
    // A refused append: hls.js halves its own ceiling.
    config.maxMaxBufferLength = 30
    control.setAheadSec(60)
    expect(config.maxMaxBufferLength).equals(30)
    expect(config.maxBufferLength).equals(30)
    // Lower still is always allowed.
    control.setAheadSec(20)
    expect(config.maxMaxBufferLength).equals(20)
    control.setAheadSec(60)
    expect(config.maxMaxBufferLength).equals(30)
  })
})
