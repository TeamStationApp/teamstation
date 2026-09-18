import { expect } from 'chai'
import { describe, it } from 'mocha'

import { shouldResumeAfterRecovery } from './attachHls'

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
