import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asGumboPlay, type GumboPlay } from '../../common/gumboPlay'
import * as library from '../../common/scoring/linescore'
import * as route from './events'

/**
 * The scoring library works the line score out from documents; the route
 * works it out from rows whose columns Postgres generates from the same
 * documents. Given the same plays, the two must agree.
 */
function play(input: {
  atBatIndex: number
  inning?: number | null
  halfInning?: 'top' | 'bottom' | null
  awayScore?: number | null
  homeScore?: number | null
  eventType?: string
  outs?: number
  halfOuts?: number
  playEvents?: unknown[]
}): GumboPlay {
  return asGumboPlay({
    about: {
      atBatIndex: input.atBatIndex,
      inning: input.inning === undefined ? 1 : input.inning,
      halfInning: input.halfInning === undefined ? 'top' : input.halfInning,
      ...(input.halfOuts == null ? {} : { halfOuts: input.halfOuts })
    },
    count: { outs: input.outs ?? 1 },
    result: {
      eventType: input.eventType ?? 'single',
      awayScore: input.awayScore === undefined ? 0 : input.awayScore,
      homeScore: input.homeScore === undefined ? 0 : input.homeScore
    },
    ...(input.playEvents == null ? {} : { playEvents: input.playEvents })
  })
}

/** The row `readPlays` returns for a stored document. */
function row(doc: GumboPlay): Parameters<typeof route.halfOutcomes>[0][number] {
  return {
    id: `event-${doc.about.atBatIndex}`,
    gameId: 'g1',
    atBatIndex: doc.about.atBatIndex,
    inning: doc.about.inning ?? null,
    halfInning: doc.about.halfInning ?? null,
    eventType: doc.result.eventType,
    awayScore: doc.result.awayScore ?? null,
    homeScore: doc.result.homeScore ?? null,
    gumbo: doc
  }
}

const fixtures: Record<string, GumboPlay[]> = {
  'a finished game': [
    play({ atBatIndex: 0, awayScore: 1, outs: 1 }),
    play({ atBatIndex: 1, awayScore: 2, eventType: 'home_run', outs: 1 }),
    play({ atBatIndex: 2, awayScore: 2, eventType: 'strikeout', outs: 3 }),
    play({
      atBatIndex: 3,
      halfInning: 'bottom',
      awayScore: 2,
      homeScore: 1,
      eventType: 'walk',
      outs: 0
    }),
    play({
      atBatIndex: 4,
      halfInning: 'bottom',
      awayScore: 2,
      homeScore: 1,
      eventType: 'field_error',
      outs: 3
    }),
    play({
      atBatIndex: 5,
      inning: 2,
      awayScore: 3,
      eventType: 'hit_by_pitch',
      outs: 3
    })
  ],
  'plays without scores or halves': [
    play({ atBatIndex: 0, awayScore: null, homeScore: null }),
    play({ atBatIndex: 1, halfInning: null, awayScore: 4 }),
    play({ atBatIndex: 2, inning: null, awayScore: 5 }),
    play({
      atBatIndex: 3,
      halfInning: 'bottom',
      homeScore: null,
      awayScore: null
    })
  ],
  'an inning-ended marker and a stored half outs': [
    play({
      atBatIndex: 0,
      outs: 1,
      playEvents: [{ type: 'Inning Ended', count: { outs: 3 } }, null, 'x']
    }),
    play({
      atBatIndex: 1,
      outs: 2,
      playEvents: [{ type: 'inning_ended', outs: 3 }]
    }),
    play({ atBatIndex: 2, halfInning: 'bottom', halfOuts: 2, outs: 1 }),
    play({
      atBatIndex: 3,
      halfInning: 'bottom',
      outs: 3,
      playEvents: [{ type: 'pitch' }]
    })
  ],
  'only a final score': [
    play({
      atBatIndex: 9999,
      eventType: 'final_score',
      awayScore: 7,
      homeScore: 3
    })
  ],
  'plays out of order': [
    play({
      atBatIndex: 3,
      inning: 2,
      halfInning: 'bottom',
      homeScore: 2,
      awayScore: 1
    }),
    play({ atBatIndex: 1, halfInning: 'bottom', homeScore: 1, awayScore: 1 }),
    play({ atBatIndex: 0, awayScore: 1 }),
    play({ atBatIndex: 2, inning: 2, awayScore: 1, homeScore: 1 })
  ]
}

describe('the line score from documents and from rows', function () {
  for (const [name, plays] of Object.entries(fixtures))
    it(`agrees on ${name}`, function () {
      const marked = library.withHalfOuts(plays)
      expect(marked).deep.equals(route.withHalfOuts(plays))
      const rows = marked.map(row)
      const halves = library.halfOutcomes(marked)
      expect(halves).deep.equals(route.halfOutcomes(rows))
      for (const [away, home] of [
        [3, 1],
        [null, null],
        [0, 9]
      ] as const)
        expect(library.lineScore(marked, halves, away, home)).deep.equals(
          route.lineScore(rows, halves, away, home)
        )
    })
})
