import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { GumboPlay } from '../gumboPlay'
import { withHalfOuts } from '../scoring/linescore'
import { completeHalves } from './halves'

function play(
  atBatIndex: number,
  inning: number | null,
  half: 'top' | 'bottom' | null,
  outs: number,
  extra: Partial<{ halfOuts: number; marker: boolean }> = {}
): GumboPlay {
  return {
    about: {
      atBatIndex,
      inning,
      halfInning: half,
      startTime: null,
      endTime: null,
      ...(extra.halfOuts == null ? {} : { halfOuts: extra.halfOuts })
    },
    result: {
      eventType: 'field_out',
      awayScore: 0,
      homeScore: 0,
      rbi: 0
    },
    count: { balls: 0, strikes: 0, outs },
    playEvents:
      extra.marker === true
        ? [{ type: 'Inning Ended', details: {} }]
        : [{ type: 'pitch' }]
  } as unknown as GumboPlay
}

/** U20a: which halves a game's plays have ended. */
describe('U20a completeHalves', function () {
  it('ends a half whose last play leaves three outs, and not one at two', function () {
    const three = withHalfOuts([
      play(0, 1, 'top', 1),
      play(1, 1, 'top', 2),
      play(2, 1, 'top', 3)
    ])
    expect(completeHalves(three)).deep.equals([
      { inning: 1, half: 'top', atBatIndex: 2 }
    ])
    const two = withHalfOuts([play(0, 1, 'top', 1), play(1, 1, 'top', 2)])
    expect(completeHalves(two)).deep.equals([])
  })

  it('reads the outs the server wrote on the last play first', function () {
    expect(completeHalves([play(0, 1, 'top', 0, { halfOuts: 3 })])).deep.equals(
      [{ inning: 1, half: 'top', atBatIndex: 0 }]
    )
  })

  it('ends a half an Inning Ended marker closes at two outs', function () {
    const plays = withHalfOuts([
      play(0, 1, 'top', 1),
      play(1, 1, 'top', 2, { marker: true })
    ])
    expect(completeHalves(plays)).deep.equals([
      { inning: 1, half: 'top', atBatIndex: 1 }
    ])
    // The marker on an earlier play of the half still ends it.
    expect(
      completeHalves([
        play(0, 2, 'bottom', 1, { marker: true }),
        play(1, 2, 'bottom', 2)
      ])
    ).deep.equals([{ inning: 2, half: 'bottom', atBatIndex: 1 }])
  })

  it('ends a half once a later half has a play, and never the half being played', function () {
    const plays = withHalfOuts([
      play(0, 1, 'top', 1),
      play(1, 1, 'bottom', 0),
      play(2, 1, 'bottom', 1),
      play(3, 2, 'top', 0)
    ])
    expect(completeHalves(plays)).deep.equals([
      { inning: 1, half: 'top', atBatIndex: 0 },
      { inning: 1, half: 'bottom', atBatIndex: 2 }
    ])
  })

  it('answers each half by its last play, in game order, whatever order the plays come in', function () {
    const plays = withHalfOuts([
      play(5, 2, 'top', 3),
      play(3, 1, 'bottom', 3),
      play(0, 1, 'top', 1),
      play(2, 1, 'top', 3),
      play(1, 1, 'top', 2),
      play(4, 2, 'top', 1)
    ])
    expect(completeHalves(plays)).deep.equals([
      { inning: 1, half: 'top', atBatIndex: 2 },
      { inning: 1, half: 'bottom', atBatIndex: 3 },
      { inning: 2, half: 'top', atBatIndex: 5 }
    ])
  })

  it('leaves out a play with no inning or half, and answers none for no plays', function () {
    expect(completeHalves([])).deep.equals([])
    expect(
      completeHalves([play(0, null, null, 3), play(1, 1, null, 3)])
    ).deep.equals([])
  })

  it('makes a half incomplete again when an undo takes its third out away', function () {
    const ended = withHalfOuts([play(0, 1, 'top', 2), play(1, 1, 'top', 3)])
    expect(completeHalves(ended)).has.length(1)
    const undone = withHalfOuts([play(0, 1, 'top', 2)])
    expect(completeHalves(undone)).deep.equals([])
  })
})
