import { expect } from 'chai'
import { describe, it } from 'mocha'

import { ScoringSession } from '../common/scoring/session'
import { measureOffset } from '../common/serverClock'
import { game } from '../test/scoringGames'
import {
  computeHighlights,
  type CreditedOutcome,
  type Highlight,
  type HighlightEvent,
  highlightEvent,
  type HighlightVideo,
  leadFor,
  withDropped
} from './highlights'
import type { HighlightSettings } from './settings'

const settings: HighlightSettings = {
  lagSec: 8,
  leadSec: 30,
  leadSecByEventType: { strikeout: 10 },
  mergeWithinSec: 5,
  tailSec: 5
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
  endTime: null,
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
  it('stops each highlight tailSec past the play, and no later than the recording', () => {
    // Tapped 600 s in, so the play is at 592 s and the start 30 s before it.
    const [one] = computeHighlights([event()], video, settings)
    expect(one.playOffsetSec).equals(592)
    expect(one.startOffsetSec).equals(562)
    expect(one.endOffsetSec).equals(597)
    const [onPlay] = computeHighlights([event()], video, {
      ...settings,
      tailSec: 0
    })
    expect(onPlay.endOffsetSec).equals(592)
    expect(onPlay.startOffsetSec).equals(562)
    const [short] = computeHighlights(
      [event()],
      { ...video, durationSec: 594 },
      settings
    )
    expect(short.endOffsetSec).equals(594)
    const [open] = computeHighlights(
      [event()],
      { ...video, durationSec: null, syncOffsetSec: 1.25 },
      settings
    )
    expect(open.endOffsetSec).equals(598.3)
  })

  it('keeps a structured completed-play tag separate from the description and timings', () => {
    const plain = computeHighlights([event()], video, settings)[0]
    const tagged = computeHighlights(
      [event({ tag: 'great catch' })],
      video,
      settings
    )[0]
    expect(tagged.tag).equals('great catch')
    expect(tagged.description).equals(plain.description)
    expect(tagged.startOffsetSec).equals(plain.startOffsetSec)
    const row = {
      ...event(),
      gumbo: {
        about: { atBatIndex: 1 },
        tagTargets: {
          version: 1,
          play: {
            id: 'target_completed',
            signature: 'single',
            tag: 'great catch'
          },
          events: [
            {
              id: 'target_pitch',
              index: 0,
              signature: 'pitch',
              tag: 'great pitch'
            }
          ]
        }
      }
    }
    expect(highlightEvent(row, undefined, () => undefined).tag).equals(
      'great catch'
    )
    expect(
      highlightEvent(
        {
          ...row,
          gumbo: {
            about: { atBatIndex: 1 },
            tagTargets: { version: 1, events: row.gumbo.tagTargets.events }
          }
        },
        undefined,
        () => undefined
      ).tag
    ).equals(null)
  })
  it('seeks lag plus lead before the tap', function () {
    // Tap at 10:00 into the video; the play was 8 s earlier at 9:52; the
    // highlight starts 30 s before that, at 9:22.
    const [highlight] = computeHighlights([event()], video, settings)
    expect(highlight.playOffsetSec).equals(592)
    expect(highlight.startOffsetSec).equals(562)
  })

  it('seeks to a play scored on the server clock, in a video whose start is on it too (U4)', async function () {
    // The scorer's phone runs 40 s slow. The session stamps the play with the
    // phone's clock plus the offset measured against the server, as the
    // video's start is on the server's clock.
    let server = videoStart.getTime() + 600_000
    const phone = (): number => server - 40_000
    const { offsetMs } = await measureOffset(async () => server, 1, phone)
    const session = ScoringSession.start(
      {
        load: async () => ({ plays: [], currentPlay: null }),
        save: async () => ({ plays: [], currentPlay: null })
      },
      'g1',
      game(),
      {
        now: () => new Date(phone() + offsetMs),
        setTimer: () => null,
        clearTimer: () => undefined
      }
    )
    session.apply({ type: 'result', eventType: 'single' })
    server += 20_000
    session.apply({ type: 'pitch', call: 'B' })
    const play = session.picture().plays.get(0)!
    expect(play.about.startTime).equals(
      new Date(videoStart.getTime() + 600_000).toISOString()
    )
    const [highlight] = computeHighlights(
      [event({ startTime: new Date(play.about.startTime!) })],
      video,
      settings
    )
    // The tap at 10:00 into the video, less the lag and the lead.
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

  it('seeks from the tap that ended the at-bat, not the one that began it', function () {
    // A TeamStation-scored lineout: the at-bat began at the previous play's
    // tap, ten minutes in, and the scorekeeper tapped the out 118 s later.
    const lineout = event({
      eventType: 'field_out',
      startTime: new Date(videoStart.getTime() + 600_000),
      endTime: new Date(videoStart.getTime() + 718_000)
    })
    const [highlight] = computeHighlights([lineout], video, settings)
    expect(highlight.playOffsetSec).equals(710)
    expect(highlight.startOffsetSec).equals(680)
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
    // The sentence under the video is TeamStation's own, from the play.
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
    endTime: null,
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
              label: 'Single: Jordan P',
              credit: credit('Jordan P'),
              teamId: null,
              creditUserId: null
            }
          ]
        }
      ],
      video,
      settings
    )
    expect(one?.title).equals('Single: Jordan P')
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
              label: 'Single: Jordan P',
              credit: credit('Jordan P'),
              teamId: null,
              creditUserId: null
            },
            {
              eventType: 'run',
              label: 'Run: Hunter P',
              credit: credit('Hunter P', 'runner'),
              teamId: null,
              creditUserId: null
            }
          ]
        }
      ],
      video,
      settings
    )
    expect(one?.title).equals('Single: Jordan P · Run: Hunter P')
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
              label: 'Home run: Hunter P',
              credit: credit('Hunter P'),
              teamId: null,
              creditUserId: null
            },
            {
              eventType: 'run',
              label: 'Run: Hunter P',
              credit: credit('Hunter P', 'runner'),
              teamId: null,
              creditUserId: null
            }
          ]
        }
      ],
      video,
      settings
    )
    expect(one?.title).equals('Home run: Hunter P')
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
              label: 'Single: Jordan P',
              credit: credit('Jordan P'),
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
              label: 'Single: Jordan P',
              credit: credit('Jordan P'),
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
              label: 'Single: Jordan P',
              credit: credit('Jordan P'),
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

describe('a highlight named from its structured credits', function () {
  const VLAD = 7101
  const JORDAN = 7102
  const JORDAN_TOO = 7103
  const row = {
    id: 'evt_named',
    atBatIndex: 4,
    startTime: new Date(videoStart.getTime() + 600_000),
    endTime: null,
    eventType: 'single',
    inning: 1,
    halfInning: 'top',
    awayScore: 1,
    homeScore: 0,
    titleOverride: null,
    timeNudgeSec: 0,
    hidden: false,
    isScoringPlay: false
  }
  const outcome = (
    eventType: string,
    head: string,
    creditUserId: number | null,
    more: Partial<CreditedOutcome> & { typed?: string } = {}
  ): CreditedOutcome => {
    const { typed, ...rest } = more
    return {
      eventType,
      head,
      suffix: null,
      assists: [],
      assistWord: null,
      teamId: null,
      creditUserId,
      credit: {
        ...(typed == null ? {} : { name: typed }),
        role: eventType === 'run' ? 'runner' : 'batter',
        position: null
      },
      ...rest
    }
  }
  const book =
    (names: Record<number, string>) =>
    (id: number): string | undefined =>
      names[id]
  const shown = (
    credits: CreditedOutcome[],
    names: Record<number, string>
  ): { highlights: Highlight[]; dropped: number } =>
    withDropped([highlightEvent(row, credits, book(names))], video, settings)

  it('words each label from the book, an id by its name and a typed name as typed', function () {
    const credits = [
      outcome('single', 'Single', VLAD),
      outcome('run', 'Run', null, { typed: 'Kyle Tucker' })
    ]
    const [first] = shown(credits, { [VLAD]: 'Juan S' }).highlights
    expect(first.title).equals('Single: Juan S · Run: Kyle Tucker')
    expect(first.description).equals(
      'Top 1st: Juan S singles. Kyle Tucker scores. 1–0'
    )
    // A rename is read on the next read.
    const [renamed] = shown(credits, { [VLAD]: 'Vladimir G' }).highlights
    expect(renamed.title).equals('Single: Vladimir G · Run: Kyle Tucker')
    expect(renamed.description).equals(
      'Top 1st: Vladimir G singles. Kyle Tucker scores. 1–0'
    )
  })

  it("words an outside scorer's suffix and fielders' chain", function () {
    const [play] = shown(
      [
        outcome('strikeout', 'Strikeout', VLAD, {
          suffix: ' pitching',
          credit: { role: 'pitcher', position: null }
        }),
        outcome('field_out', 'Ground out', JORDAN, {
          credit: { role: 'fielder', position: 'SS' },
          assists: [
            { creditUserId: JORDAN_TOO, position: '2B' },
            { creditUserId: null, position: '1B', name: 'Kyle Tucker' }
          ],
          assistWord: 'to'
        })
      ],
      { [VLAD]: 'Vladimir G', [JORDAN]: 'Jordan Pu', [JORDAN_TOO]: 'Jordan Pe' }
    ).highlights
    expect(play.title).equals(
      'Strikeout: Vladimir G pitching · Ground out: Jordan Pu (SS) to Jordan Pe (2B) to Kyle Tucker (1B)'
    )
    expect(play.description).equals(
      'Top 1st: Vladimir G strikes out the batter. Ground out, Jordan Pu (SS) to Jordan Pe (2B) to Kyle Tucker (1B). 1–0'
    )
  })

  it('names a person once by his id or typed name, and two people who read alike twice', function () {
    const title = (credits: CreditedOutcome[]): string =>
      shown(credits, { [JORDAN]: 'Jordan P', [JORDAN_TOO]: 'Jordan P' })
        .highlights[0].title
    expect(
      title([
        outcome('home_run', 'Home run', JORDAN),
        outcome('run', 'Run', JORDAN)
      ])
    ).equals('Home run: Jordan P')
    expect(
      title([
        outcome('home_run', 'Home run', JORDAN),
        outcome('run', 'Run', JORDAN_TOO)
      ])
    ).equals('Home run: Jordan P · Run: Jordan P')
    expect(
      title([
        outcome('home_run', 'Home run', null, { typed: 'Kyle Tucker' }),
        outcome('run', 'Run', null, { typed: 'Kyle Tucker' })
      ])
    ).equals('Home run: Kyle Tucker')
    // A typed name is nobody's id.
    expect(
      title([
        outcome('home_run', 'Home run', null, { typed: 'Jordan P' }),
        outcome('run', 'Run', JORDAN)
      ])
    ).equals('Home run: Jordan P · Run: Jordan P')
  })

  it('shows a credit that names an id or a typed name, and drops one naming nobody', function () {
    // An id the book does not name is still somebody.
    expect(
      shown([outcome('single', 'Single', VLAD)], {}).highlights.map(
        highlight => highlight.title
      )
    ).deep.equals(['Single: '])
    const nobody = shown(
      [
        outcome('single', 'Single', null),
        outcome('run', 'Run', null, { typed: '' })
      ],
      {}
    )
    expect(nobody).deep.equals({ highlights: [], dropped: 1 })
    // A credit with no person at all is kept out the same way.
    expect(
      shown([outcome('single', 'Single', null, { credit: null })], {})
    ).deep.equals({ highlights: [], dropped: 1 })
  })

  it('leaves a play nobody has looked at to its type', function () {
    const event = highlightEvent(row, undefined, book({}))
    expect(event.credits).equals(undefined)
    expect(withDropped([event], video, settings).highlights[0].title).equals(
      'Single'
    )
  })
})
