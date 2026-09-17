import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  computeHighlights,
  type HighlightEvent,
  type HighlightVideo,
  leadFor
} from './highlights'
import type { HighlightSettings } from './settings'

const settings: HighlightSettings = {
  lagSec: 8,
  leadSec: 30,
  leadSecByEventType: { strikeout: 10 }
}

const videoStart = new Date('2026-05-01T18:00:00.000Z')

const video: HighlightVideo = {
  startAt: videoStart,
  syncOffsetSec: 0,
  durationSec: 7200
}

const event = (over: Partial<HighlightEvent> = {}): HighlightEvent => ({
  id: 'evt_1',
  atBatIndex: 1,
  startTime: new Date(videoStart.getTime() + 600_000),
  eventType: 'single',
  description: 'Jordan singles to left',
  titleOverride: null,
  timeNudgeSec: 0,
  hidden: false,
  isScoringPlay: false,
  ...over
})

describe('highlights', function () {
  it('seeks lag plus lead before the tap', function () {
    // Tap at 10:00 into the video; the play was 8 s earlier at 9:52; the
    // highlight starts 30 s before that, at 9:22.
    const [highlight] = computeHighlights([event()], video, settings)
    expect(highlight.playOffsetSec).equals(592)
    expect(highlight.startOffsetSec).equals(562)
  })

  it('uses a shorter lead for the event types that ask for one', function () {
    const [highlight] = computeHighlights(
      [event({ eventType: 'strikeout' })],
      video,
      settings
    )
    expect(highlight.playOffsetSec).equals(592)
    expect(highlight.startOffsetSec).equals(582)
    expect(leadFor('strikeout', settings)).equals(10)
    expect(leadFor('single', settings)).equals(30)
    expect(leadFor(null, settings)).equals(30)
  })

  it('applies a per-play nudge without touching the others', function () {
    const nudged = computeHighlights(
      [event({ timeNudgeSec: 12 })],
      video,
      settings
    )
    expect(nudged[0].playOffsetSec).equals(604)
    expect(
      computeHighlights([event()], video, settings)[0].playOffsetSec
    ).equals(592)
  })

  it("applies the video's own clock correction", function () {
    const shifted = computeHighlights(
      [event()],
      { ...video, syncOffsetSec: -5 },
      settings
    )
    expect(shifted[0].playOffsetSec).equals(587)
  })

  it('never seeks before the start of the video', function () {
    // A play 10 s in would want to start 38 s before the recording began.
    const early = event({
      startTime: new Date(videoStart.getTime() + 10_000)
    })
    const [highlight] = computeHighlights([early], video, settings)
    expect(highlight.startOffsetSec).equals(0)
    expect(highlight.playOffsetSec).equals(2)
  })

  it('leaves out plays that are not in this video', function () {
    const before = event({
      id: 'evt_before',
      startTime: new Date(videoStart.getTime() - 600_000)
    })
    const after = event({
      id: 'evt_after',
      startTime: new Date(videoStart.getTime() + 8000 * 1000)
    })
    expect(computeHighlights([before, after], video, settings)).deep.equals([])
  })

  it('leaves out hidden plays and plays with no time', function () {
    const hidden = event({ id: 'evt_hidden', hidden: true })
    const untimed = event({ id: 'evt_untimed', startTime: null })
    expect(computeHighlights([hidden, untimed], video, settings)).deep.equals(
      []
    )
  })

  it('returns them in game order, oldest first', function () {
    const third = event({ id: 'c', atBatIndex: 3 })
    const first = event({ id: 'a', atBatIndex: 1 })
    const second = event({ id: 'b', atBatIndex: 2 })
    const order = computeHighlights([third, first, second], video, settings)
    expect(order.map(item => item.eventId)).deep.equals(['a', 'b', 'c'])
  })

  it('prefers a manual title, then the description', function () {
    const overridden = computeHighlights(
      [event({ titleOverride: 'The catch' })],
      video,
      settings
    )
    expect(overridden[0].title).equals('The catch')

    const described = computeHighlights([event()], video, settings)
    expect(described[0].title).equals('Jordan singles to left')

    const bare = computeHighlights(
      [event({ description: null, titleOverride: null })],
      video,
      settings
    )
    expect(bare[0].title).equals('single')
  })

  it('has nothing to offer for a video with no start time', function () {
    const unknown = { ...video, startAt: null }
    expect(computeHighlights([event()], unknown, settings)).deep.equals([])
  })

  it('moves every highlight when the settings change', function () {
    const slower: HighlightSettings = { ...settings, lagSec: 20 }
    const [normal] = computeHighlights([event()], video, settings)
    const [corrected] = computeHighlights([event()], video, slower)
    expect(normal.playOffsetSec - corrected.playOffsetSec).equals(12)
  })
})
