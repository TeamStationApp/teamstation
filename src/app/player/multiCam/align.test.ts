import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { AngleVideo } from '../wallClock'
import {
  correctionFor,
  endFor,
  everythingEnded,
  hasStalled,
  holdExpired,
  isFinished,
  isOurSilence,
  LIVE_OPEN_WAIT_MS,
  liveOpeningMs,
  liveTargetMs,
  masterOf,
  NUDGE_LIMIT,
  nudgeRate,
  type Placeable,
  worthCorrecting
} from './align'

const at = (
  startAt: string | null,
  durationSec: number | null = 3600,
  syncOffsetSec = 0
): AngleVideo => ({ startAt, syncOffsetSec, durationSec })

const wall = (iso: string): number => Date.parse(iso)

describe('keeping the tiles on one moment', function () {
  const video = at('2026-05-01T18:00:00.000Z')

  it('holds a tile that is already there', function () {
    const correction = correctionFor({
      wallMs: wall('2026-05-01T18:10:00.000Z'),
      follower: { video, atSec: 600.02 }
    })
    expect(correction.kind).equals('hold')
  })

  it('seeks a tile that is out by more than the tolerance', function () {
    const correction = correctionFor({
      wallMs: wall('2026-05-01T18:10:00.000Z'),
      follower: { video, atSec: 590 }
    })
    expect(correction).deep.equals({ kind: 'seek', toSec: 600 })
  })

  it('parks a camera that was not running yet', function () {
    const late = at('2026-05-01T18:30:00.000Z')
    const correction = correctionFor({
      wallMs: wall('2026-05-01T18:10:00.000Z'),
      follower: { video: late, atSec: 0 }
    })
    expect(correction).deep.equals({ kind: 'park', reason: 'beforeStart' })
  })

  it('believes the file about its own length, not the row', function () {
    // A real recording here declares 7344 seconds and holds 7337.9. Waiting
    // for the declared end means waiting for a moment that never arrives.
    const overstated = at('2026-05-01T18:00:00.000Z', 7344)
    const correction = correctionFor({
      wallMs: wall('2026-05-01T20:02:21.000Z'),
      follower: { video: overstated, atSec: 7337, mediaSec: 7337.9 }
    })
    expect(correction).deep.equals({ kind: 'park', reason: 'afterEnd' })
  })

  it('parks a camera that had already stopped', function () {
    const short = at('2026-05-01T18:00:00.000Z', 300)
    const correction = correctionFor({
      wallMs: wall('2026-05-01T18:10:00.000Z'),
      follower: { video: short, atSec: 300 }
    })
    expect(correction).deep.equals({ kind: 'park', reason: 'afterEnd' })
  })

  it('leaves a recording it cannot place alone', function () {
    const correction = correctionFor({
      wallMs: wall('2026-05-01T18:10:00.000Z'),
      follower: { video: at(null), atSec: 12 }
    })
    expect(correction.kind).equals('hold')
  })

  it('allows for a recording own clock correction', function () {
    const corrected = at('2026-05-01T18:00:00.000Z', 3600, 5)
    const correction = correctionFor({
      wallMs: wall('2026-05-01T18:10:00.000Z'),
      follower: { video: corrected, atSec: 0 }
    })
    expect(correction).deep.equals({ kind: 'seek', toSec: 605 })
  })
})

describe('the end of what a recording holds', function () {
  it('is its media, less the slack an element stops short by', function () {
    expect(endFor(7337.9)).equals(7337.65)
    expect(endFor(null)).equals(null)
  })

  it('counts a tile finished when it says so itself', function () {
    expect(isFinished({ ended: true, atSec: 12, mediaSec: 7337.9 })).equals(
      true
    )
  })

  it('counts one finished that stopped a fraction short and said nothing', function () {
    // The case that wedged the clock twice: an element that stops 0.16 s from
    // its own last frame and never fires `ended`.
    expect(
      isFinished({ ended: false, atSec: 7337.74, mediaSec: 7337.9 })
    ).equals(true)
  })

  it('leaves a live recording unfinished, having no end to reach', function () {
    expect(isFinished({ ended: false, atSec: 99999, mediaSec: null })).equals(
      false
    )
  })

  it('agrees with the parking rule about the same moment', function () {
    // The two questions — has it finished, and does the take still expect a
    // picture from it — must answer the same way, or the clock waits for a
    // tile that has nothing left to give.
    const video = at('2026-05-01T18:00:00.000Z', 7344)
    const mediaSec = endFor(7337.9)
    const wallMs = Date.parse('2026-05-01T18:00:00.000Z') + 7337.8 * 1000
    expect(
      correctionFor({ wallMs, follower: { video, atSec: 7337.8, mediaSec } })
    ).deep.equals({ kind: 'park', reason: 'afterEnd' })
    expect(
      isFinished({ ended: false, atSec: 7337.8, mediaSec: 7337.9 })
    ).equals(true)
  })
})

describe('which tile the others follow', function () {
  const tiles = (): Placeable[] => [
    { id: 'short', video: at('2026-05-01T18:00:00.000Z', 600), playable: true },
    { id: 'long', video: at('2026-05-01T18:00:00.000Z', 6000), playable: true },
    { id: 'lost', video: at(null, 9000), playable: true }
  ]

  it('is the longest that can be placed on the clock', function () {
    expect(masterOf(tiles())).equals('long')
  })

  it('never a tile with no start, however long it is', function () {
    const only = [{ id: 'lost', video: at(null, 9000), playable: true }]
    expect(masterOf(only)).equals(null)
  })

  it('hands over when the master ends', function () {
    const after = tiles().map(tile =>
      tile.id === 'long' ? { ...tile, ended: true } : tile
    )
    expect(masterOf(after)).equals('short')
  })

  it('prefers a live tile, which has no length to beat', function () {
    const withLive = [
      ...tiles(),
      {
        id: 'live',
        video: at('2026-05-01T18:00:00.000Z', null),
        playable: true
      }
    ]
    expect(masterOf(withLive)).equals('live')
  })

  it('is whichever tile the viewer is listening to', function () {
    // Never corrected, so its sound never breaks.
    expect(masterOf(tiles(), 'short')).equals('short')
  })

  it('falls back to the longest when the sound is on a tile it cannot be', function () {
    const ended = tiles().map(tile =>
      tile.id === 'short' ? { ...tile, ended: true } : tile
    )
    expect(masterOf(ended, 'short')).equals('long')
    // And a tile with no start cannot hold the clock, sound or not.
    expect(masterOf(tiles(), 'lost')).equals('long')
    expect(masterOf(tiles(), 'gone')).equals('long')
  })

  it('says when there is nothing left rather than parking in silence', function () {
    const ended = tiles().map(tile => ({ ...tile, ended: true }))
    expect(everythingEnded(ended)).equals(true)
    expect(everythingEnded(tiles())).equals(false)
    expect(everythingEnded([])).equals(false)
  })
})

describe('a stall, by what has been drawn', function () {
  const base = { paused: false, progressed: false, unchangedForMs: 300 }

  it('is a tile that is meant to be playing and is drawing nothing', function () {
    expect(hasStalled(base)).equals(true)
  })

  it('is not a pause the viewer asked for', function () {
    expect(hasStalled({ ...base, paused: true })).equals(false)
  })

  it('is not a tile that is putting pictures up', function () {
    expect(hasStalled({ ...base, progressed: true })).equals(false)
  })

  it('is not a stumble, until it has gone on', function () {
    expect(hasStalled({ ...base, unchangedForMs: 100 })).equals(false)
    expect(holdExpired(500)).equals(false)
    expect(holdExpired(2500)).equals(true)
  })

  it('is not fooled by the clock the alignment moves itself', function () {
    // A starved tile is seeked forward by the view on every tick, so its
    // position changes while nothing at all is drawn.
    expect(
      hasStalled({ paused: false, progressed: false, unchangedForMs: 1000 })
    ).equals(true)
  })
})

describe('telling our own doing from a tile that has stopped', function () {
  it('forgives the silence just after this view moved it', function () {
    expect(isOurSilence(10_000, 9_400)).equals(true)
  })

  it('stops forgiving it, so a stall can be seen at all', function () {
    // The amnesty has to end. A starved tile is exactly the one the alignment
    // keeps seeking, so an unbounded forgiveness means its stall is wiped on
    // every tick and the view never drops it or says anything.
    expect(isOurSilence(10_000, 8_000)).equals(false)
    expect(isOurSilence(10_000, undefined)).equals(false)
  })

  it('does not chase the drift of a tile that has nothing to show', function () {
    expect(worthCorrecting(1, 0.4)).equals(false)
    expect(worthCorrecting(1, 1.2)).equals(false)
  })

  it('still sends that tile somewhere else entirely', function () {
    // A scrub, or coming back from the end of its own recording: a new place
    // to buffer rather than a nudge it cannot act on.
    expect(worthCorrecting(1, -3544)).equals(true)
    expect(worthCorrecting(0, 120)).equals(true)
  })

  it('moves a tile that has pictures, however small the correction', function () {
    expect(worthCorrecting(2, 0.2)).equals(true)
    expect(worthCorrecting(4, 0.2)).equals(true)
  })
})

describe('four live edges', function () {
  it('hold back to the one furthest behind', function () {
    expect(liveTargetMs([5000, 3000, 4000])).equals(3000)
  })

  it('ignore tiles that have no edge to offer', function () {
    expect(liveTargetMs([null, 4000, null])).equals(4000)
    expect(liveTargetMs([null, null])).equals(null)
  })
})

describe('bringing a phone tile back by speed', function () {
  it('runs at normal speed within the tolerance', function () {
    expect(nudgeRate(0)).equals(1)
    expect(nudgeRate(0.08)).equals(1)
    expect(nudgeRate(-0.1)).equals(1)
  })

  it('runs faster when behind and slower when ahead, in proportion', function () {
    expect(nudgeRate(0.5)).closeTo(1.1, 1e-9)
    expect(nudgeRate(-0.25)).closeTo(0.95, 1e-9)
  })

  it('never moves the speed further than the limit', function () {
    expect(nudgeRate(1)).equals(1 + NUDGE_LIMIT)
    expect(nudgeRate(-3)).equals(1 - NUDGE_LIMIT)
  })
})

describe('the moment a live grid opens on', function () {
  it('has none until a live tile has a picture', function () {
    expect(liveOpeningMs([], 0)).equals(null)
    expect(liveOpeningMs([null, null], 60_000)).equals(null)
  })

  it('is the moment of the tile furthest ahead, which the others hold already', function () {
    expect(liveOpeningMs([5000, 3000, 4000], 0)).equals(5000)
  })

  it('waits for every tile, but not for longer than the wait after the first', function () {
    expect(liveOpeningMs([5000, null], LIVE_OPEN_WAIT_MS - 1)).equals(null)
    expect(liveOpeningMs([null, 5000], LIVE_OPEN_WAIT_MS)).equals(5000)
  })
})
