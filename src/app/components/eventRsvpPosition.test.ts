import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  clampRsvpPosition,
  RSVP_COLORS,
  rsvpAtPosition,
  rsvpColor,
  rsvpPosition
} from './eventRsvpPosition'

describe('continuous RSVP choices and colors', () => {
  it('starts undecided in the blue center, snaps choices, and blends continuously', () => {
    expect(
      [null, 'maybe', 'yes', 'no'].map(value =>
        rsvpPosition(value as 'yes' | 'no' | 'maybe' | null)
      )
    ).deep.equals([1, 1, 0, 2])
    expect([-1, 0, 1, 2, 3].map(clampRsvpPosition)).deep.equals([0, 0, 1, 2, 2])
    expect([0.49, 0.51, 1.49, 1.51].map(rsvpAtPosition)).deep.equals([
      'yes',
      'maybe',
      'maybe',
      'no'
    ])
    expect([0, 1, 2].map(rsvpColor)).deep.equals([...RSVP_COLORS])
    expect(rsvpColor(0.5)).not.equals(rsvpColor(0)).and.not.equals(rsvpColor(1))
    expect(rsvpColor(1.5)).not.equals(rsvpColor(1)).and.not.equals(rsvpColor(2))
  })
})
