import { expect } from 'chai'
import { describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import { encodeScheduleCursor } from '../schedule/scheduleCursor'
import {
  eventWindow,
  parseEventListQuery,
  parsePublicGamesQuery,
  parseTeamGamesQuery,
  parseUmpirePageQuery,
  schedulePageAsk
} from './eventListQuery'

const NOW = new Date('2026-09-30T20:00:00.000Z')
const HOUR = 3_600_000

function parse(query: Record<string, unknown>): ReturnType<typeof eventWindow> {
  return eventWindow(parseEventListQuery(query), NOW)
}

function refused(query: Record<string, unknown>): string {
  try {
    parseEventListQuery(query)
  } catch (error) {
    if (error instanceof HttpError) return error.message
    throw error
  }
  throw new Error('expected a 400')
}

describe('GET /events query', function () {
  it('defaults to every visible game, newest first', function () {
    const window = parse({})
    expect(window.order).equals('desc')
    expect(window.since).equals(undefined)
    expect(window.omitCancelled).equals(false)
    expect(parseEventListQuery({}).scope).equals('visible')
  })

  it('reads the picker as games you run, from the look-back, soonest first', function () {
    const window = parse({
      scope: 'run',
      lookbackHours: '2',
      limit: '20'
    })
    expect(window.omitCancelled).equals(true)
    expect(window.order).equals('asc')
    expect(window.since?.toISOString()).equals(
      new Date(NOW.getTime() - 2 * HOUR).toISOString()
    )
    expect(parseEventListQuery({ limit: '20' }).limit).equals(20)
  })

  it('cuts finished uploads and recent scoreboards on their own clocks', function () {
    const finished = parse({ scope: 'run', when: 'finished' })
    expect(finished.until?.toISOString()).equals(
      new Date(NOW.getTime() - 2 * HOUR).toISOString()
    )
    expect(finished.untilInclusive).equals(false)
    expect(finished.order).equals('desc')

    const recent = parse({ scope: 'run', when: 'recent', lookbackHours: '3' })
    expect(recent.since?.toISOString()).equals(
      new Date(NOW.getTime() - 3 * HOUR).toISOString()
    )
    expect(recent.until).equals(NOW)
    expect(recent.untilInclusive).equals(true)
  })

  it('keeps upcoming, past, and future distinct', function () {
    expect(parse({ when: 'upcoming' })).deep.include({
      upcoming: true,
      past: false,
      future: false,
      order: 'asc'
    })
    expect(parse({ when: 'past' })).deep.include({
      past: true,
      upcoming: false,
      order: 'desc'
    })
    expect(parse({ when: 'future' })).deep.include({
      future: true,
      upcoming: false,
      order: 'asc'
    })
    expect(parse({ when: 'upcoming', order: 'desc' }).order).equals('desc')
  })

  it('refuses a filter that does not mean one thing', function () {
    expect(refused({ scope: 'watch' })).equals(
      'scope must be visible, run, or film'
    )
    expect(refused({ when: 'soon' })).contains('when must be')
    expect(refused({ lookbackHours: '0' })).equals(
      'lookbackHours must be a positive number'
    )
    expect(refused({ when: 'upcoming', lookbackHours: '2' })).contains(
      'lookbackHours applies'
    )
    expect(refused({ since: 'nope' })).equals('since must be a date')
    expect(refused({ since: NOW.toISOString(), lookbackHours: '2' })).equals(
      'since and lookbackHours cannot both be set'
    )
    expect(refused({ when: 'future', since: NOW.toISOString() })).equals(
      'since does not apply with this when'
    )
    expect(refused({ limit: '0' })).equals(
      'limit must be a whole number of at least 1'
    )
    expect(refused({ played: 'yes' })).equals('played must be 1 or true')
    expect(refused({ scoreboard: 'closed' })).equals('scoreboard must be open')
    expect(refused({ season: '' })).equals('season must be a non-empty string')
    expect(refused({ externalId: '' })).equals(
      'externalId must be a non-empty string'
    )
  })

  it('leaves an unpaged list as it was, with no page size', function () {
    const parsed = parseEventListQuery({ limit: '500' })
    expect(parsed).deep.include({
      limit: 500,
      paged: false,
      cursor: undefined,
      around: false,
      hasVideo: false
    })
    expect(parseEventListQuery({}).limit).equals(undefined)
  })

  it('reads a page of 50 by default, and 100 at most', function () {
    expect(parseEventListQuery({ paged: '1' }).limit).equals(50)
    expect(parseEventListQuery({ paged: 'true', limit: '100' }).limit).equals(
      100
    )
    expect(refused({ paged: '1', limit: '101' })).equals(
      'limit must be at most 100 with paged'
    )
  })

  it('reads a cursor, a video filter and an opening row (U3)', function () {
    const cursor = {
      startAt: NOW.toISOString(),
      id: 'gam_1',
      direction: 'prev' as const,
      order: 'desc' as const
    }
    expect(
      parseEventListQuery({
        paged: '1',
        hasVideo: '1',
        cursor: encodeScheduleCursor(cursor)
      })
    ).deep.include({ paged: true, hasVideo: true, cursor })
    expect(parseEventListQuery({ hasVideo: 'true' }).hasVideo).equals(true)
    // A cursor reads in its own order, said again or not.
    const text = encodeScheduleCursor(cursor)
    expect(parse({ paged: '1', cursor: text }).order).equals('desc')
    expect(parse({ paged: '1', cursor: text, when: 'upcoming' }).order).equals(
      'desc'
    )
    expect(parse({ paged: '1', cursor: text, order: 'desc' }).order).equals(
      'desc'
    )
    expect(parseEventListQuery({ paged: '1', around: 'next' }).around).equals(
      true
    )
  })

  it('refuses what a page cannot be, naming the parameter (U3)', function () {
    const cursor = encodeScheduleCursor({
      startAt: NOW.toISOString(),
      id: 'gam_1',
      direction: 'next',
      order: 'asc'
    })
    expect(refused({ paged: '0' })).equals('paged must be 1 or true')
    expect(refused({ hasVideo: 'yes' })).equals('hasVideo must be 1 or true')
    expect(refused({ cursor })).equals('cursor needs paged')
    expect(refused({ paged: '1', cursor, order: 'desc' })).equals(
      'order must be asc with this cursor'
    )
    expect(refused({ paged: '1', cursor: 'nope' })).equals(
      'cursor is not a cursor this list gave'
    )
    expect(refused({ paged: '1', cursor: '' })).equals(
      'cursor must be a non-empty string'
    )
    expect(refused({ around: 'next' })).equals('around needs paged')
    expect(refused({ paged: '1', around: 'previous' })).equals(
      'around must be next'
    )
    expect(refused({ paged: '1', around: 'next', cursor })).equals(
      'around does not apply with cursor'
    )
    expect(refused({ paged: '1', around: 'next', order: 'desc' })).equals(
      'around reads order=asc'
    )
    expect(refused({ paged: '1', scoreboard: 'open' })).equals(
      'paged does not apply with scoreboard=open'
    )
  })

  it('runs a page around the next game forward, whatever the when', function () {
    expect(parse({ paged: '1', around: 'next' }).order).equals('asc')
    expect(parse({ paged: '1', around: 'next', when: 'past' }).order).equals(
      'asc'
    )
  })

  it('counts over the whole list, leaving out when', function () {
    const parsed = parseEventListQuery({
      paged: '1',
      when: 'recent',
      season: 'sea_1',
      order: 'asc'
    })
    const ask = schedulePageAsk(parsed, NOW)
    expect(ask.limit).equals(50)
    expect(ask.around).equals(false)
    expect(ask.whole).deep.include({
      since: undefined,
      until: undefined,
      upcoming: false,
      past: false,
      future: false
    })
    const looking = parseEventListQuery({ paged: '1', lookbackHours: '2' })
    expect(schedulePageAsk(looking, NOW).whole.since).equals(undefined)
  })

  it('reads a public list as a page, with no opening row', function () {
    expect(
      parsePublicGamesQuery({
        public: '1',
        paged: '1',
        when: 'past',
        hasVideo: '1',
        limit: '7'
      })
    ).deep.include({ paged: true, when: 'past', hasVideo: true, limit: 7 })
    const refuses = (query: Record<string, unknown>): string => {
      try {
        parsePublicGamesQuery(query)
      } catch (error) {
        if (error instanceof HttpError) return error.message
        throw error
      }
      throw new Error('expected a 400')
    }
    expect(refuses({ public: '1' })).equals('public needs paged')
    expect(refuses({ public: '0', paged: '1' })).equals(
      'public must be 1 or true'
    )
    expect(refuses({ public: '1', paged: '1', around: 'next' })).equals(
      'around does not apply with public'
    )
  })

  it('takes only the page parameters on an umpire schedule', function () {
    expect(parseUmpirePageQuery({ view: 'schedule' })).deep.include({
      paged: false,
      around: false,
      limit: undefined,
      cursor: undefined
    })
    // Sent today, and ignored today.
    expect(parseUmpirePageQuery({ limit: 'many' }).limit).equals(undefined)
    expect(
      parseUmpirePageQuery({ paged: '1', around: 'next', limit: '9' })
    ).deep.include({ paged: true, around: true, limit: 9 })
    expect(parseUmpirePageQuery({ paged: '1' }).limit).equals(50)
  })

  it("takes only a team's own parameters on a team's games", function () {
    expect(
      parseTeamGamesQuery({ when: 'past', order: 'asc', scope: 'run' })
    ).deep.include({ when: 'past', order: 'asc', scope: 'visible' })
    // Sent today, and ignored today.
    expect(parseTeamGamesQuery({ limit: '1' }).limit).equals(undefined)
    expect(parseTeamGamesQuery({ paged: '1', limit: '7' }).limit).equals(7)
    expect(parseTeamGamesQuery({ paged: '1' }).limit).equals(50)
    expect(() => parseTeamGamesQuery({ around: 'next' })).throws(
      'around needs paged'
    )
  })
})
