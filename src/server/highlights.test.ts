import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  computeHighlights,
  type HighlightEvent,
  type HighlightVideo,
  leadFor,
  withDropped
} from './highlights'
import type { HighlightSettings } from './settings'

const settings: HighlightSettings = {
  lagSec: 8,
  leadSec: 30,
  leadSecByEventType: { strikeout: 10 },
  mergeWithinSec: 5
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
  inning: null,
  halfInning: null,
  awayScore: null,
  homeScore: null,
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

  it('leaves out a fielding error, for either team, unless somebody titled it', function () {
    const error = event({
      id: 'evt_err',
      atBatIndex: 2,
      eventType: 'field_error'
    })
    const { highlights, dropped } = withDropped(
      [event(), error],
      video,
      settings
    )
    expect(highlights.map(h => h.eventId)).deep.equals(['evt_1'])
    expect(dropped).equals(0)
    const titled = computeHighlights(
      [{ ...error, titleOverride: 'The one that got away' }],
      video,
      settings
    )
    expect(titled.map(h => h.title)).deep.equals(['The one that got away'])
  })

  it('returns them in game order, oldest first', function () {
    const third = event({ id: 'c', atBatIndex: 3 })
    const first = event({ id: 'a', atBatIndex: 1 })
    const second = event({ id: 'b', atBatIndex: 2 })
    const order = computeHighlights([third, first, second], video, settings)
    expect(order.map(item => item.eventId)).deep.equals(['a', 'b', 'c'])
  })

  it('prefers a manual title, then names the play by its type', function () {
    const overridden = computeHighlights(
      [event({ titleOverride: 'The catch' })],
      video,
      settings
    )
    expect(overridden[0].title).equals('The catch')

    const named = computeHighlights([event()], video, settings)
    expect(named[0].title).equals('Single')
    // The sentence under the video is GameStation's own, from the play.
    expect(named[0].description).equals('Single.')
    const placed = computeHighlights(
      [event({ inning: 3, halfInning: 'bottom', awayScore: 1, homeScore: 2 })],
      video,
      settings
    )
    expect(placed[0].description).equals('Bottom 3rd: Single. 1–2')

    const unknown = computeHighlights(
      [event({ eventType: 'something_new' })],
      video,
      settings
    )
    expect(unknown[0].title).equals('Play')
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

describe('what a highlight is called, and whether it is shown at all', function () {
  const at = (sec: number): Date => new Date(videoStart.getTime() + sec * 1000)
  const base = {
    atBatIndex: 1,
    eventType: 'single',
    inning: null,
    halfInning: null,
    awayScore: null,
    homeScore: null,
    titleOverride: null,
    timeNudgeSec: 0,
    hidden: false,
    isScoringPlay: false
  }
  const credit = (
    name: string,
    role = 'batter'
  ): { name: string; role: string; position: null } => ({
    name,
    role,
    position: null
  })

  it('reads as the event and the player who did it well', function () {
    const [one] = computeHighlights(
      [
        {
          ...base,
          id: 'e1',
          startTime: at(600),
          credits: [
            {
              eventType: 'single',
              label: 'Single: Jensen P',
              credit: credit('Jensen P'),
              teamId: null,
              creditUserId: null
            }
          ]
        }
      ],
      video,
      settings
    )
    expect(one?.title).equals('Single: Jensen P')
  })

  it('joins a hit and the run it drove in into one line', function () {
    const [one] = computeHighlights(
      [
        {
          ...base,
          id: 'e1',
          startTime: at(600),
          credits: [
            {
              eventType: 'single',
              label: 'Single: Jensen P',
              credit: credit('Jensen P'),
              teamId: null,
              creditUserId: null
            },
            {
              eventType: 'run',
              label: 'Run: Harlow P',
              credit: credit('Harlow P', 'runner'),
              teamId: null,
              creditUserId: null
            }
          ]
        }
      ],
      video,
      settings
    )
    expect(one?.title).equals('Single: Jensen P · Run: Harlow P')
    expect(one?.isScoringPlay, 'a run makes it a scoring play').equals(true)
  })

  it('does not name the same player twice on a home run', function () {
    const [one] = computeHighlights(
      [
        {
          ...base,
          id: 'e1',
          startTime: at(600),
          credits: [
            {
              eventType: 'home_run',
              label: 'Home run: Harlow P',
              credit: credit('Harlow P'),
              teamId: null,
              creditUserId: null
            },
            {
              eventType: 'run',
              label: 'Run: Harlow P',
              credit: credit('Harlow P', 'runner'),
              teamId: null,
              creditUserId: null
            }
          ]
        }
      ],
      video,
      settings
    )
    expect(one?.title).equals('Home run: Harlow P')
  })

  it('shows nothing for a play nobody can be named on', function () {
    const found = computeHighlights(
      [{ ...base, id: 'e1', startTime: at(600), credits: [] }],
      video,
      settings
    )
    expect(found).deep.equals([])
  })

  it('drops a play credited to an opponent nobody runs', function () {
    const found = computeHighlights(
      [
        {
          ...base,
          id: 'e1',
          startTime: at(600),
          credits: [
            {
              eventType: 'single',
              label: 'Single: Jensen P',
              credit: credit('Jensen P'),
              teamId: 'tem_outside',
              creditUserId: null
            }
          ]
        }
      ],
      video,
      settings,
      new Map([['tem_outside', { isExternal: true, hasOwner: false }]])
    )
    expect(found).deep.equals([])
  })

  it('keeps a real team whether or not anybody is recorded as running it', function () {
    // The version of this that read `external || no owner` dropped every
    // highlight in the app, because no team has an owner on real data.
    const found = computeHighlights(
      [
        {
          ...base,
          id: 'e1',
          startTime: at(600),
          credits: [
            {
              eventType: 'single',
              label: 'Single: Jensen P',
              credit: credit('Jensen P'),
              teamId: 'tem_real',
              creditUserId: null
            }
          ]
        }
      ],
      video,
      settings,
      new Map([['tem_real', { isExternal: false, hasOwner: false }]])
    )
    expect(found).to.have.length(1)
  })

  it('keeps a play credited to a real team in the league', function () {
    const found = computeHighlights(
      [
        {
          ...base,
          id: 'e1',
          startTime: at(600),
          credits: [
            {
              eventType: 'single',
              label: 'Single: Jensen P',
              credit: credit('Jensen P'),
              teamId: 'tem_real',
              creditUserId: null
            }
          ]
        }
      ],
      video,
      settings,
      new Map([['tem_real', { isExternal: false, hasOwner: true }]])
    )
    expect(found).to.have.length(1)
  })

  it('shows a game ingested before credits existed by its plays’ types', function () {
    // `undefined` is not `[]`: nobody has looked at this play yet, so it is
    // shown by what kind of play it was rather than vanishing until an import
    // is re-run.
    const found = computeHighlights(
      [{ ...base, id: 'e1', startTime: at(600) }],
      video,
      settings
    )
    expect(found).to.have.length(1)
    expect(found[0]?.title).equals('Single')
  })
})
