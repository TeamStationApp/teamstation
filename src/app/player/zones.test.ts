import { expect } from 'chai'
import { describe, it } from 'mocha'

import { gestureAction, HOLD_MS, STILL_FRACTION, type Zone } from './zones'

describe('player zones', function () {
  it('holds at half a second, still within a twentieth of the width (U17)', function () {
    expect(HOLD_MS).equals(500)
    expect(STILL_FRACTION).equals(0.05)
  })

  it('crawls on a hold of the +10 s square, and nowhere else', function () {
    const zones: Zone[] = ['seekBack', 'seekForward', 'toggle']
    expect(zones.map(zone => gestureAction(zone, 'tap'))).deep.equals([
      'seekBack',
      'seekForward',
      'toggle'
    ])
    expect(zones.map(zone => gestureAction(zone, 'hold'))).deep.equals([
      null,
      'slowForward',
      null
    ])
  })
})
