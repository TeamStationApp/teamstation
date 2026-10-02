import { expect } from 'chai'
import { describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import { eventWindow, parseEventListQuery } from './eventListQuery'

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
})
