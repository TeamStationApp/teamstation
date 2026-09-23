import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asGumboPlay } from './gumboPlay'

const correction = {
  about: { atBatIndex: 142, isScoringPlay: false },
  result: {
    eventType: 'score_correction',
    awayScore: 4,
    homeScore: 3
  }
}

describe('a Gumbo play', function () {
  it('rejects a play with no about.atBatIndex', function () {
    expect(() => asGumboPlay({ result: { eventType: 'single' } })).to.throw(
      'a play: Expected an object, got undefined at .about'
    )
    expect(() =>
      asGumboPlay({
        about: { atBatIndex: 1.5 },
        result: { eventType: 'single' }
      })
    ).to.throw(/^a play: .* at \.about\.atBatIndex$/)
    expect(() => asGumboPlay(null)).to.throw(/^a play: /)
    expect(() => asGumboPlay({ about: { atBatIndex: 0 } })).to.throw(
      'play 0: Expected an object, got undefined at .result'
    )
    expect(() =>
      asGumboPlay({ about: null, result: { eventType: 'single' } })
    ).to.throw(/at \.about$/)
    expect(() =>
      asGumboPlay({ about: { atBatIndex: 4 }, result: { eventType: 'bunt' } })
    ).to.throw(
      'play 4: Expected a known event type, got bunt at .result.eventType'
    )
  })

  it('rejects a value the events table cannot cast, naming the play', function () {
    const withField = (
      about: Record<string, unknown>,
      result: Record<string, unknown> = {},
      rest: Record<string, unknown> = {}
    ): unknown => ({
      about: { atBatIndex: 7, ...about },
      result: { eventType: 'single', ...result },
      ...rest
    })
    const tooBig = 2147483648
    const refused: Array<[unknown, string]> = [
      [withField({ atBatIndex: -1 }), '.about.atBatIndex'],
      [withField({ atBatIndex: tooBig }), '.about.atBatIndex'],
      [withField({ inning: 2.5 }), 'play 7: '],
      [withField({ inning: '1' }), '.about.inning'],
      [withField({ inning: tooBig }), '.about.inning'],
      [withField({ halfInning: 'middle' }), '.about.halfInning'],
      [withField({ halfOuts: null }), '.about.halfOuts'],
      [withField({ halfOuts: tooBig }), '.about.halfOuts'],
      [withField({ isScoringPlay: 'yes' }), '.about.isScoringPlay'],
      [withField({ startTime: 'soon' }), '.about.startTime'],
      [withField({ endTime: '2026-13-45T99:00:00Z' }), '.about.endTime'],
      [withField({ startTime: '2026-02-31T10:00:00Z' }), '.about.startTime'],
      [withField({ startTime: '2026-02-29' }), '.about.startTime'],
      [withField({}, { awayScore: '3a' }), '.result.awayScore'],
      [withField({}, { awayScore: 3000000000 }), '.result.awayScore'],
      [withField({}, { homeScore: 1.5 }), '.result.homeScore'],
      [withField({}, { homeScore: -1 }), '.result.homeScore'],
      [withField({}, { rbi: 'x' }), '.result.rbi'],
      [withField({}, { rbi: tooBig }), '.result.rbi'],
      [withField({}, { description: 4 }), '.result.description'],
      [withField({}, {}, { count: 3 }), '.count'],
      [withField({}, {}, { count: { outs: '2' } }), '.count.outs'],
      [withField({}, {}, { count: { outs: tooBig } }), '.count.outs'],
      [withField({}, {}, { count: { balls: 'four' } }), '.count.balls'],
      [withField({}, {}, { credits: {} }), '.credits'],
      [withField({}, {}, { credits: ['Ada'] }), '.credits[0]'],
      [
        withField({}, {}, { credits: [{ creditUserId: '12' }] }),
        '.credits[0].creditUserId'
      ],
      [
        withField({}, {}, { credits: [{ creditUserId: 2 ** 60 }] }),
        '.credits[0].creditUserId'
      ],
      [withField({}, {}, { credits: [{ teamId: 3 }] }), '.credits[0].teamId'],
      [
        withField({}, {}, { credits: [{ credit: { externalPlayerId: 'x' } }] }),
        'credits name people by creditUserId'
      ],
      [
        withField({}, {}, { credits: [{ credit: { acmePlayerId: null } }] }),
        '.credits[0].credit'
      ],
      [
        withField({}, {}, { matchup: { batter: { id: '7' } } }),
        '.matchup.batter.id'
      ],
      [
        withField({}, {}, { matchup: { pitcher: { id: 0 } } }),
        '.matchup.pitcher.id'
      ],
      [
        withField({}, {}, { matchup: { batter: { id: 2 ** 60 } } }),
        '.matchup.batter.id'
      ],
      [withField({}, {}, { matchup: 'Ada' }), '.matchup'],
      [
        withField({}, {}, { runners: [{ details: { runner: { id: -3 } } }] }),
        '.runners[0].details.runner.id'
      ],
      [withField({}, {}, { runners: {} }), '.runners']
    ]
    for (const [raw, message] of refused) {
      expect(() => asGumboPlay(raw), JSON.stringify(raw))
        .to.throw(TypeError, message)
        .with.property('message')
        .that.matches(/^play -?\d+: /)
    }
  })

  it('lets absent and null fields through, and keeps what it does not check', function () {
    const play = asGumboPlay({
      about: {
        atBatIndex: 2147483647,
        inning: null,
        halfInning: null,
        isScoringPlay: true,
        startTime: '2026-09-24T19:24:21.500Z',
        endTime: null
      },
      result: { eventType: 'walk', awayScore: null, rbi: 0 },
      count: { outs: null, balls: 4 },
      credits: [{ creditUserId: null }, { creditUserId: 42, label: 'Ada' }],
      matchup: { batter: { id: 7, name: 'Ada' }, pitcher: { id: null } },
      runners: [{ details: { runner: { id: 9 } } }, { movement: {} }],
      source: 'kept'
    })
    expect(play.about.atBatIndex).equals(2147483647)
    expect(play.source).equals('kept')
    expect(play.about.inning).equals(null)
    // Keys the cleaner does not check stay at every level, untyped.
    expect(play.matchup?.batter).deep.equals({ id: 7, name: 'Ada' })
    expect(play.runners?.[1]).deep.include({ movement: {} })
    expect(
      asGumboPlay({
        about: { atBatIndex: 0, startTime: '2026-09-24T19:24:21-07:00' },
        result: { eventType: 'single' }
      }).about.startTime
    ).equals('2026-09-24T19:24:21-07:00')
  })

  it('accepts score_correction and final_score', function () {
    expect(asGumboPlay(correction).result.eventType).equals('score_correction')
    expect(
      asGumboPlay({
        about: { atBatIndex: 0 },
        result: { eventType: 'final_score', awayScore: 1, homeScore: 0 },
        count: { outs: 3 }
      }).result.eventType
    ).equals('final_score')
  })

  it('keeps the rest of the document', function () {
    const play = asGumboPlay({
      about: { atBatIndex: 0, halfInning: 'top' },
      result: { eventType: 'single' },
      matchup: { batter: { id: 7 } }
    })
    expect((play.matchup as { batter: { id: number } }).batter.id).equals(7)
  })
})
