import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  PITCH_HEIGHTS,
  PITCH_SIDES,
  type PitchLocation,
  pitchZone
} from './pitchLocation'

/** `height side` for a pitch in the zone, `missed height side` for one out. */
function said(location: PitchLocation): string {
  const words = `${location.height} ${location.side}`
  return location.inZone ? words : `missed ${words}`
}

describe('the zone a pitch location falls in', function () {
  // Each batter's zones for every height and side, in the zone and missed.
  const ZONES: Record<'R' | 'L', Record<string, number | undefined>> = {
    R: {
      'high inside': 1,
      'high middle': 2,
      'high away': 3,
      'middle inside': 4,
      'middle middle': 5,
      'middle away': 6,
      'low inside': 7,
      'low middle': 8,
      'low away': 9,
      'missed high inside': 11,
      'missed high middle': undefined,
      'missed high away': 12,
      'missed middle inside': undefined,
      'missed middle middle': undefined,
      'missed middle away': undefined,
      'missed low inside': 13,
      'missed low middle': undefined,
      'missed low away': 14
    },
    L: {
      'high inside': 3,
      'high middle': 2,
      'high away': 1,
      'middle inside': 6,
      'middle middle': 5,
      'middle away': 4,
      'low inside': 9,
      'low middle': 8,
      'low away': 7,
      'missed high inside': 12,
      'missed high middle': undefined,
      'missed high away': 11,
      'missed middle inside': undefined,
      'missed middle middle': undefined,
      'missed middle away': undefined,
      'missed low inside': 14,
      'missed low middle': undefined,
      'missed low away': 13
    }
  }

  it('numbers each height and side as the catcher sees it, for either batter', function () {
    for (const batSide of ['R', 'L'] as const) {
      const found: Record<string, number | undefined> = {}
      for (const inZone of [true, false])
        for (const height of PITCH_HEIGHTS)
          for (const side of PITCH_SIDES) {
            const location = { height, side, inZone }
            found[said(location)] = pitchZone(location, batSide)
          }
      expect(found, batSide).deep.equals(ZONES[batSide])
    }
  })

  it('gives no zone when the batter’s side is not known', function () {
    const location = { height: 'low', side: 'inside', inZone: true } as const
    expect(pitchZone(location, null)).equals(undefined)
    expect(pitchZone(location, undefined)).equals(undefined)
  })
})
