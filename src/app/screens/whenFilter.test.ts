import { expect } from 'chai'

import { chronological, gamesFor, nextGameIndex } from './whenFilter'

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

describe('a team schedule in date order', function () {
  it('runs oldest first, with an undated game last', function () {
    const undated = game(null, null)
    expect(chronological([nextMonth, undated, feb, lastWeek])).deep.equals([
      feb,
      lastWeek,
      nextMonth,
      undated
    ])
  })

  it('does not reorder what it was given', function () {
    const held = [nextMonth, feb]
    chronological(held)
    expect(held).deep.equals([nextMonth, feb])
  })
})

describe('the game a team schedule opens on', function () {
  const at = (
    startAt: string | null,
    awayScore: number | null,
    status = 'scheduled'
  ): Game & { status: string } => ({ ...game(startAt, awayScore), status })
  const played = at('2026-09-10T16:00:00Z', 4, 'final')
  const today = at('2026-09-17T11:00:00Z', null, 'inProgress')
  const soon = at('2026-09-18T16:00:00Z', null)
  const later = at('2026-10-04T19:30:00Z', null)

  it('is the next game still to play', function () {
    expect(nextGameIndex([played, soon, later], NOW)).equals(1)
  })

  it('is a game being played, ahead of one still to come', function () {
    expect(nextGameIndex([played, today, soon], NOW)).equals(1)
  })

  it('skips a future game that already has a score', function () {
    const scoredEarly = at('2026-09-18T16:00:00Z', 3, 'final')
    expect(nextGameIndex([played, scoredEarly, later], NOW)).equals(2)
  })

  it('is the last dated game once the season is over', function () {
    const undated = at(null, null)
    const earlier = at('2026-08-01T16:00:00Z', 2, 'final')
    expect(nextGameIndex([earlier, played, undated], NOW)).equals(1)
  })

  it('is the last game when none has a date', function () {
    expect(nextGameIndex([at(null, null), at(null, null)], NOW)).equals(1)
  })

  it('skips a cancelled game, ahead or behind', function () {
    const rainedOut = at('2026-09-18T16:00:00Z', null, 'cancelled')
    expect(nextGameIndex([played, rainedOut, later], NOW)).equals(2)
    const cancelledLast = at('2026-09-12T16:00:00Z', null, 'cancelled')
    expect(nextGameIndex([played, cancelledLast], NOW)).equals(0)
  })

  it('takes the later of two games still marked live', function () {
    const earlier = at('2026-09-17T06:00:00Z', null, 'inProgress')
    expect(nextGameIndex([earlier, played, today, soon], NOW)).equals(2)
  })

  it('stays on something that has started and not yet ended, a practice as much as a game', function () {
    // Began half an hour ago; with no end time it runs the usual three hours.
    const practice = at('2026-09-17T11:30:00Z', null)
    expect(nextGameIndex([played, practice, soon], NOW)).equals(1)
    // One that ended an hour ago is behind.
    const over = {
      ...at('2026-09-17T08:00:00Z', null),
      endAt: '2026-09-17T11:00:00Z'
    }
    expect(nextGameIndex([played, over, soon], NOW)).equals(2)
  })

  it('keeps a game marked live first until two hours past its end', function () {
    // Ended two hours ago and still marked live: still the one shown first.
    const running = {
      ...at('2026-09-17T07:00:00Z', null, 'inProgress'),
      endAt: '2026-09-17T10:00:00Z'
    }
    expect(nextGameIndex([played, running, soon], NOW)).equals(1)
    // Three hours past its end, it is scrolled past like anything over.
    const stale = {
      ...at('2026-09-17T06:00:00Z', null, 'inProgress'),
      endAt: '2026-09-17T09:00:00Z'
    }
    expect(nextGameIndex([played, stale, soon], NOW)).equals(2)
  })

  it('never lets a game marked live take the schedule past something still to come', function () {
    // Scored five days early, and a session two days old nobody finished:
    // neither is being played, so the next thing to come is where it opens.
    const early = at('2026-09-22T19:30:00Z', null, 'inProgress')
    const abandoned = at('2026-09-15T22:30:00Z', null, 'inProgress')
    expect(nextGameIndex([abandoned, soon, early, later], NOW)).equals(1)
    // A practice still on comes before a later game being played.
    const practice = at('2026-09-17T10:30:00Z', null)
    const running = at('2026-09-17T11:00:00Z', null, 'inProgress')
    expect(nextGameIndex([played, practice, running, soon], NOW)).equals(1)
  })

  it('is -1 for no games', function () {
    expect(nextGameIndex([], NOW)).equals(-1)
  })
})
