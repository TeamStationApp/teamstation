import { expect } from 'chai'
import { describe, it } from 'mocha'

import { type AngleVideo, sameMoment } from './angleSwitch'

const at = (startAt: string | null, syncOffsetSec = 0): AngleVideo => ({
  startAt,
  syncOffsetSec,
  durationSec: 7200
})

describe('the same moment in another recording', function () {
  it('is the same number when both started together', function () {
    const a = at('2026-05-01T18:00:00.000Z')
    const b = at('2026-05-01T18:00:00.000Z')
    expect(sameMoment(a, b, 600)).equals(600)
  })

  it('allows for one having started later', function () {
    const a = at('2026-05-01T18:00:00.000Z')
    const b = at('2026-05-01T18:01:30.000Z')
    // 10 minutes into a recording that began 90s earlier is 8:30 into the other.
    expect(sameMoment(a, b, 600)).equals(510)
  })

  it('works in the other direction too', function () {
    const a = at('2026-05-01T18:01:30.000Z')
    const b = at('2026-05-01T18:00:00.000Z')
    expect(sameMoment(a, b, 510)).equals(600)
  })

  it('allows for each recording own clock correction', function () {
    const a = at('2026-05-01T18:00:00.000Z', 5)
    const b = at('2026-05-01T18:00:00.000Z', -5)
    // The corrections pull in opposite directions, so they add rather than
    // cancel. Getting this sign wrong lands out by twice the correction.
    expect(sameMoment(a, b, 600)).equals(590)
  })

  it('copies the position when either side has no start', function () {
    expect(sameMoment(at(null), at('2026-05-01T18:00:00.000Z'), 600)).equals(
      600
    )
    expect(sameMoment(at('2026-05-01T18:00:00.000Z'), at(null), 600)).equals(
      600
    )
  })

  it('clamps to the start of a recording that began later', function () {
    const a = at('2026-05-01T18:00:00.000Z')
    const b = at('2026-05-01T18:30:00.000Z')
    expect(sameMoment(a, b, 60)).equals(0)
  })

  it('clamps to the end of a recording that stopped earlier', function () {
    const a = at('2026-05-01T18:00:00.000Z')
    const b: AngleVideo = {
      startAt: '2026-05-01T18:00:00.000Z',
      syncOffsetSec: 0,
      durationSec: 300
    }
    expect(sameMoment(a, b, 600)).equals(300)
  })
})
