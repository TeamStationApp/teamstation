import { expect } from 'chai'
import { describe, it } from 'mocha'

import { jumpDetector } from './timestampJump'

describe('a jump in a live publish (U18)', function () {
  /** Video at 30 fps from `at`, on time. */
  const steady = (
    detect: ReturnType<typeof jumpDetector>,
    from: number,
    count: number,
    arrival = from
  ): boolean[] =>
    Array.from({ length: count }, (unused, index) =>
      detect.feed({
        video: true,
        dtsMs: from + index * 33,
        arrivalMs: arrival + index * 33
      })
    )

  it('sees none in steady video, and never in the first packet', function () {
    const detect = jumpDetector(4000)
    expect(detect.feed({ video: true, dtsMs: 1_000_000, arrivalMs: 5 })).equals(
      false
    )
    expect(steady(detect, 1_000_033, 300, 38)).not.includes(true)
  })

  it('sees one in a timestamp step past the cut', function () {
    const detect = jumpDetector(4000)
    steady(detect, 0, 30)
    expect(
      detect.feed({ video: true, dtsMs: 30 * 33 + 4001, arrivalMs: 1000 })
    ).equals(true)
    // And carries on from there.
    expect(
      detect.feed({ video: true, dtsMs: 30 * 33 + 4034, arrivalMs: 1033 })
    ).equals(false)
    // Backwards counts as well.
    expect(detect.feed({ video: true, dtsMs: 0, arrivalMs: 1066 })).equals(true)
    // Just under the cut is not one.
    const near = jumpDetector(4000)
    near.feed({ video: true, dtsMs: 0, arrivalMs: 0 })
    expect(near.feed({ video: true, dtsMs: 4000, arrivalMs: 4000 })).equals(
      false
    )
  })

  it('sees one in an arrival gap past the cut, timestamps steady: a queued burst', function () {
    const detect = jumpDetector(4000)
    steady(detect, 0, 30, 0)
    expect(
      detect.feed({ video: true, dtsMs: 30 * 33, arrivalMs: 29 * 33 + 4100 })
    ).equals(true)
  })

  it('looks at no audio, and starts afresh after a reset', function () {
    const detect = jumpDetector(4000)
    detect.feed({ video: true, dtsMs: 0, arrivalMs: 0 })
    expect(
      detect.feed({ video: false, dtsMs: 90_000, arrivalMs: 90_000 })
    ).equals(false)
    expect(detect.feed({ video: true, dtsMs: 33, arrivalMs: 33 })).equals(false)
    detect.reset()
    // A reconnect's clock starts again from nought, after any outage.
    expect(detect.feed({ video: true, dtsMs: 0, arrivalMs: 40_000 })).equals(
      false
    )
  })
})
