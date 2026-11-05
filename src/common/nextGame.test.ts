import { expect } from 'chai'
import { describe, it } from 'mocha'

import { endsAt, initialUmpireGame, nextGameIndex } from './nextGame'

const NOW = Date.parse('2027-04-10T12:00:00.000Z')

describe('the row a schedule opens on', function () {
  it('is the same rule a team schedule and the server read', function () {
    const game = (startAt: string, awayScore: number | null): any => ({
      startAt,
      awayScore,
      status: awayScore == null ? 'scheduled' : 'final'
    })
    const played = game('2027-04-09T12:00:00.000Z', 2)
    const soon = game('2027-04-11T12:00:00.000Z', null)
    expect(nextGameIndex([played, soon], NOW)).equals(1)
    expect(Number.isNaN(endsAt({ startAt: null }))).equals(true)
  })

  it('opens the umpire table on the first game under way or to come', function () {
    const past = {
      id: 'past',
      status: 'final',
      startAt: '2027-04-09T12:00:00.000Z'
    }
    const ongoing = {
      id: 'ongoing',
      status: 'inProgress',
      startAt: '2027-04-10T11:00:00.000Z'
    }
    const game = {
      id: 'game',
      status: 'scheduled',
      startAt: '2027-04-11T12:00:00.000Z'
    }
    expect(initialUmpireGame([past, ongoing, game], NOW)?.id).equals('ongoing')
    expect(initialUmpireGame([past, game], NOW)?.id).equals('game')
    expect(initialUmpireGame([past], NOW)?.id).equals('past')
    expect(initialUmpireGame<typeof game>([], NOW)).equals(undefined)
  })
})
