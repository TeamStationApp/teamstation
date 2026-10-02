import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  calendarDate,
  gameStatusLine,
  matchupLines,
  resultFor,
  winnerOf
} from './format'

const game = {
  homeTeamId: 'tem_home',
  awayTeamId: 'tem_away',
  homeTeamName: 'Bay Stars',
  awayTeamName: 'Alta Hawks'
}

describe('how a fixture is written', function () {
  it('states the fixture when there is no side to take', function () {
    expect(matchupLines(game)).deep.equals({
      first: 'Alta Hawks',
      second: '@ Bay Stars'
    })
  })

  it('says `@` when the team travelled', function () {
    expect(matchupLines(game, 'tem_away')).deep.equals({
      first: 'Alta Hawks',
      second: '@ Bay Stars'
    })
  })

  it('says `vs` when the team was at home', function () {
    expect(matchupLines(game, 'tem_home')).deep.equals({
      first: 'Bay Stars',
      second: 'vs Alta Hawks'
    })
  })

  it('falls back to the fixture for a team that is not playing', function () {
    expect(matchupLines(game, 'tem_someone_else').second).equals('@ Bay Stars')
  })
})

describe('the word between the two scores', function () {
  const played = {
    startAt: '2026-09-06T19:00:00Z',
    awayScore: 2,
    homeScore: 1
  }

  it('says when an unscored game is, rather than calling it 0–0', function () {
    const line = gameStatusLine({
      ...played,
      status: 'scheduled',
      awayScore: null,
      homeScore: null
    })
    expect(line).does.not.equal('FINAL')
    expect(line.length).is.greaterThan(0)
  })

  it('calls a finished game final', function () {
    expect(gameStatusLine({ ...played, status: 'final' })).equals('FINAL')
    expect(winnerOf({ ...played, status: 'final' })).equals('away')
    expect(
      resultFor(
        {
          ...played,
          status: 'final',
          homeTeamId: 'tem_home',
          awayTeamId: 'tem_away'
        },
        'tem_home'
      )
    ).deep.equals({ label: 'L 1–2', tone: 'loss' })
  })

  it('does not call a game final while it is still being played', function () {
    const live = { ...played, status: 'inProgress' as const }
    expect(gameStatusLine(live)).equals('LIVE')
    expect(winnerOf(live)).equals(undefined)
    expect(
      resultFor(
        { ...live, homeTeamId: 'tem_home', awayTeamId: 'tem_away' },
        'tem_home'
      )
    ).equals(undefined)
  })
})

describe('a date on a record', function () {
  it('carries the year, because accounts outlive a season', function () {
    // Midday UTC, so the day cannot slide either way with the time zone.
    expect(calendarDate('2026-05-20T12:00:00Z')).contains('2026')
    expect(calendarDate('2026-05-20T12:00:00Z')).contains('20')
  })

  it('says nothing rather than guessing', function () {
    // Never signed in is a fact, not a date to be confirmed.
    expect(calendarDate(null)).equals('\u2014')
    expect(calendarDate('not a date')).equals('\u2014')
  })
})
