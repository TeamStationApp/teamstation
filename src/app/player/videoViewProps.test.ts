import { expect } from 'chai'
import { describe, it } from 'mocha'

import { TILE_BUFFER } from './multiCam/buffering'
import { audioSession, forwardBufferSec } from './videoViewProps'

describe("a phone player's share of the audio session (U13a)", function () {
  it('takes it, through the silent switch, when it is the one watched', function () {
    expect(audioSession(true)).deep.equals({
      disableFocus: false,
      ignoreSilentSwitch: 'ignore'
    })
  })

  it('leaves it alone, obeying the switch, as a preview or an unheard tile', function () {
    expect(audioSession(false)).deep.equals({
      disableFocus: true,
      ignoreSilentSwitch: 'obey'
    })
  })
})

describe("how far ahead a phone's player loads (U30)", function () {
  it('is half a minute, for the single player and for a tile', function () {
    expect(forwardBufferSec()).equals(30)
    expect(forwardBufferSec(TILE_BUFFER)).equals(30)
  })
})
