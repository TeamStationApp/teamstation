import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  angleZoneFor,
  gestureAction,
  HOLD_MS,
  SCRUB_EDGE_FRACTION,
  SCRUB_RATE,
  STILL_FRACTION,
  type Zone,
  zoneFor
} from './zones'

const W = 900
const H = 506

describe('player zones', function () {
  it('holds at half a second, still within a twentieth of the width (U17)', function () {
    expect(HOLD_MS).equals(500)
    expect(STILL_FRACTION).equals(0.05)
    expect(SCRUB_EDGE_FRACTION).equals(0.1)
    expect(SCRUB_RATE).equals(0.25)
  })

  it('gives the multi-camera bottom row to the controls', function () {
    const at = (col: number, row: number): string =>
      angleZoneFor(((col + 0.5) * W) / 3, ((row + 0.5) * H) / 3, W, H)
    expect([at(0, 0), at(1, 0), at(2, 0)]).deep.equals([
      'toggle',
      'toggle',
      'toggle'
    ])
    expect([at(0, 1), at(1, 1), at(2, 1)]).deep.equals([
      'seekBack',
      'toggle',
      'seekForward'
    ])
    expect([at(0, 2), at(1, 2), at(2, 2)]).deep.equals([
      'controls',
      'controls',
      'controls'
    ])
  })

  it('gives each of the nine squares its own action', function () {
    const at = (col: number, row: number): string =>
      zoneFor(((col + 0.5) * W) / 3, ((row + 0.5) * H) / 3, W, H)
    expect([at(0, 0), at(1, 0), at(2, 0)]).deep.equals([
      'toggle',
      'toggle',
      'toggle'
    ])
    expect([at(0, 1), at(1, 1), at(2, 1)]).deep.equals([
      'seekBack',
      'toggle',
      'seekForward'
    ])
    expect([at(0, 2), at(1, 2), at(2, 2)]).deep.equals([
      'toggle',
      'toggle',
      'toggle'
    ])
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

  it('splits into even thirds whatever shape the picture is', function () {
    // Two cameras side by side are 32:9, and a grid that assumed 16:9 would
    // put the middle column somewhere else entirely.
    expect(zoneFor(1, 1, 1600, 450)).equals('toggle')
    expect(zoneFor(800, 225, 1600, 450)).equals('toggle')
    expect(zoneFor(100, 225, 1600, 450)).equals('seekBack')
    expect(zoneFor(1500, 225, 1600, 450)).equals('seekForward')
  })

  it('keeps the boundaries where the thirds are', function () {
    expect(zoneFor(W / 3 - 1, H / 2, W, H)).equals('seekBack')
    expect(zoneFor(W / 3 + 1, H / 2, W, H)).equals('toggle')
  })
})
