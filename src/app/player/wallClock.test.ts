import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type AngleVideo,
  endMs,
  secondsAt,
  startMs,
  wallAt,
  windowOf
} from './wallClock'

const at = (
  startAt: string | null,
  syncOffsetSec = 0,
  durationSec: number | null = null
): AngleVideo => ({ startAt, syncOffsetSec, durationSec })

describe('the wall clock behind every angle', function () {
  it('turns a position into an instant', function () {
    const video = at('2026-05-01T18:00:00.000Z')
    expect(wallAt(video, 600)).equals(Date.parse('2026-05-01T18:10:00.000Z'))
  })

  it('turns an instant back into a position', function () {
    const video = at('2026-05-01T18:00:00.000Z')
    expect(secondsAt(video, Date.parse('2026-05-01T18:10:00.000Z'))).equals(600)
  })

  it('is its own inverse, correction and all', function () {
    const video = at('2026-05-01T18:00:00.000Z', 5)
    const wallMs = wallAt(video, 600)!
    expect(secondsAt(video, wallMs)).equals(600)
  })

  it('says null rather than guessing when there is no start', function () {
    expect(wallAt(at(null), 600)).equals(null)
    expect(secondsAt(at(null), Date.now())).equals(null)
    expect(startMs(at('not a date'))).equals(null)
  })

  it('answers honestly outside the recording, and does not clamp', function () {
    // The multi-camera view needs to know a camera was not running yet. That
    // is the whole reason this is separate from `sameMoment`, which clamps.
    const late = at('2026-05-01T18:30:00.000Z')
    expect(secondsAt(late, Date.parse('2026-05-01T18:00:00.000Z'))).equals(
      -1800
    )
    const short = at('2026-05-01T18:00:00.000Z', 0, 300)
    expect(secondsAt(short, Date.parse('2026-05-01T18:10:00.000Z'))).equals(600)
  })

  it('knows when a recording stopped, and that a live one has not', function () {
    expect(endMs(at('2026-05-01T18:00:00.000Z', 0, 600))).equals(
      Date.parse('2026-05-01T18:10:00.000Z')
    )
    expect(endMs(at('2026-05-01T18:00:00.000Z'))).equals(null)
  })

  describe('the window a set of recordings covers', function () {
    it('runs from the first start to the last end', function () {
      const window = windowOf([
        at('2026-05-01T18:00:00.000Z', 0, 600),
        at('2026-05-01T18:05:00.000Z', 0, 600)
      ])
      expect(window?.fromMs).equals(Date.parse('2026-05-01T18:00:00.000Z'))
      expect(window?.toMs).equals(Date.parse('2026-05-01T18:15:00.000Z'))
    })

    it('takes a live edge from the caller, since a live row has no end', function () {
      const live = Date.parse('2026-05-01T18:20:00.000Z')
      const window = windowOf([at('2026-05-01T18:00:00.000Z')], live)
      expect(window?.toMs).equals(live)
    })

    it('is null when nothing can be placed at all', function () {
      expect(windowOf([at(null), at(null)])).equals(null)
    })

    it('never has zero width, which would divide by nothing', function () {
      const window = windowOf([at('2026-05-01T18:00:00.000Z', 0, 0)])
      expect((window as { toMs: number }).toMs).greaterThan(
        (window as { fromMs: number }).fromMs
      )
    })
  })
})
