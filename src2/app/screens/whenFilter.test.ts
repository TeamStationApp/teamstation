import { expect } from 'chai'

import { gamesFor } from './whenFilter'

const NOW = Date.parse('2026-09-17T12:00:00Z')

interface Game {
  startAt: string | null
  awayScore: number | null
}

const game = (startAt: string | null, awayScore: number | null): Game => ({
  startAt,
  awayScore
})

const feb = game('2026-02-28T20:00:00Z', null)
const lastWeek = game('2026-09-10T16:00:00Z', 4)
const tomorrow = game('2026-09-18T16:00:00Z', null)
const nextMonth = game('2026-10-04T19:30:00Z', null)

describe('which games a filter asks for', function () {
  it('leaves a fixture whose date has gone out of upcoming', function () {
    // The one §19 was written about: nobody ever scored it, and it was being
    // offered in September as something still to come.
    expect(gamesFor([feb, tomorrow], 'upcoming', NOW)).deep.equals([tomorrow])
  })

  it('counts that fixture as past, so it is not lost altogether', function () {
    expect(gamesFor([feb, lastWeek], 'past', NOW)).deep.equals([lastWeek, feb])
  })

  it('puts the soonest game first looking forward', function () {
    expect(gamesFor([nextMonth, tomorrow], 'upcoming', NOW)).deep.equals([
      tomorrow,
      nextMonth
    ])
  })

  it('puts the newest game first looking back', function () {
    const older = game('2026-08-01T16:00:00Z', 2)
    expect(gamesFor([older, lastWeek], 'past', NOW)).deep.equals([
      lastWeek,
      older
    ])
  })

  it('keeps everything under all, newest first', function () {
    expect(gamesFor([lastWeek, nextMonth], 'all', NOW)).deep.equals([
      nextMonth,
      lastWeek
    ])
  })

  it('does not reorder what it was given', function () {
    const held = [nextMonth, tomorrow]
    gamesFor(held, 'upcoming', NOW)
    expect(held).deep.equals([nextMonth, tomorrow])
  })

  it('treats a game with no date at all as past', function () {
    const undated = game(null, null)
    expect(gamesFor([undated], 'upcoming', NOW)).deep.equals([])
    expect(gamesFor([undated], 'past', NOW)).deep.equals([undated])
  })
})
