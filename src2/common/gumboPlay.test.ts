import { expect } from 'chai'
import { describe, it } from 'mocha'

import { MLB_EVENT_TYPES, STORED_EVENT_TYPES } from './gumbo/reference'
import {
  eventTypeName,
  GUMBO_EVENT_TYPES,
  GUMBO_EXTENSION_EVENT_TYPES,
  isGumboEventType,
  LEGACY_EVENT_TYPES,
  normalizeEventType
} from './gumboEventTypes'
import { asCurrentPlay, asGumboPlay, asPostEventsBody } from './gumboPlay'

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
    const body = asPostEventsBody({
      plays: [correction],
      source: { system: 'gamestation' }
    })
    expect(body.source?.system).equals('gamestation')
    expect(asPostEventsBody({ plays: [] }).plays).deep.equals([])
  })

  it('accepts any source system spelled as an external id system is', function () {
    for (const system of ['acme', 'manual', 'gamestation', 'teamScorer2']) {
      expect(
        asPostEventsBody({ plays: [], source: { system } }).source?.system
      ).equals(system)
    }
    for (const system of ['Acme', '2acme', 'acme-scorer', '', 7]) {
      expect(() =>
        asPostEventsBody({ plays: [], source: { system } })
      ).to.throw()
    }
  })
})

describe("MLB's event types", function () {
  const play = (eventType: string, atBatIndex = 0): unknown => ({
    about: { atBatIndex, isComplete: false },
    result: { eventType }
  })

  it("lists MLB's codes and the extensions, and nothing else", function () {
    expect([...GUMBO_EVENT_TYPES].sort()).deep.equals(
      [...STORED_EVENT_TYPES].sort()
    )
    for (const code of GUMBO_EXTENSION_EVENT_TYPES)
      expect(MLB_EVENT_TYPES.has(code), code).equals(false)
    expect([...GUMBO_EXTENSION_EVENT_TYPES].sort()).deep.equals([
      'final_score',
      'gs_batter_out',
      'gs_batting_order',
      'gs_manual_placement',
      'score_correction'
    ])
  })

  it('accepts every code MLB lists and refuses one it does not', function () {
    for (const code of MLB_EVENT_TYPES)
      expect(asGumboPlay(play(code)).result.eventType, code).equals(code)
    expect(() => asGumboPlay(play('nonsense_type', 3))).to.throw(
      'play 3: Expected a known event type, got nonsense_type at .result.eventType'
    )
    expect(() =>
      asPostEventsBody({ plays: [play('nonsense_type', 3)] })
    ).to.throw('Expected a known event type, got nonsense_type')
    expect(() => asGumboPlay(play(7 as unknown as string, 2))).to.throw(
      'play 2: Expected an event type, got 7 at .result.eventType'
    )
    expect(() => asCurrentPlay({ about: { atBatIndex: 1 } })).to.throw(
      /^the current play: .* at \.about\.isComplete$/
    )
  })

  it('stores the legacy codes as the listed ones', function () {
    expect(LEGACY_EVENT_TYPES).deep.equals({
      catcher_interference: 'catcher_interf',
      placed_runner: 'runner_placed',
      manual_placement: 'gs_manual_placement',
      // An earlier import's own names, from a retired server-side parser (U26).
      runner_out: 'other_out',
      batter_out: 'field_out',
      catcher_s_interference: 'catcher_interf',
      fc_double_play: 'double_play',
      offensive_interference: 'batter_interference',
      batter_put_on_base: 'gs_manual_placement',
      inning_changed_by_scorekeeper: 'final_score'
    })
    const legacy = Object.keys(LEGACY_EVENT_TYPES)
    const listed = Object.values(LEGACY_EVENT_TYPES)
    const body = asPostEventsBody({
      mode: 'live',
      plays: [...legacy, 'single'].map((code, index) => ({
        about: { atBatIndex: index },
        result: { eventType: code, rbi: 0 },
        runners: [
          { details: { eventType: code, runner: { id: null } } },
          { details: { eventType: 'single' } },
          { movement: { end: '1B' } }
        ],
        gameStation: { actions: [{ type: 'result', eventType: code }] }
      })),
      currentPlay: {
        about: { atBatIndex: 9, isComplete: false },
        result: { eventType: 'catcher_interference' },
        runners: [{ details: { eventType: 'placed_runner' } }]
      }
    })
    expect(body.plays.map(item => item.result.eventType)).deep.equals([
      ...listed,
      'single'
    ])
    for (const code of listed) expect(isGumboEventType(code), code).equals(true)
    // So is each runner's, and nothing else about him.
    expect(
      body.plays.map(item =>
        item.runners?.map(
          runner =>
            (runner.details as { eventType?: string } | undefined)?.eventType
        )
      )
    ).deep.equals(
      [...listed, 'single'].map(code => [code, 'single', undefined])
    )
    expect(body.plays[0].runners?.[0].details?.runner).deep.equals({ id: null })
    // The action log keeps its own words.
    expect(body.plays[0].gameStation).deep.equals({
      actions: [{ type: 'result', eventType: 'catcher_interference' }]
    })
    expect(body.plays[0].result.rbi).equals(0)
    expect(
      (body.currentPlay?.result as { eventType: string }).eventType
    ).equals('catcher_interf')
    expect(body.currentPlay?.runners).deep.equals([
      { details: { eventType: 'runner_placed' } }
    ])

    // A current play without a result, and none at all, pass unchanged.
    const opening = { about: { atBatIndex: 0, isComplete: false } }
    expect(
      asPostEventsBody({ mode: 'live', plays: [], currentPlay: opening })
        .currentPlay
    ).deep.equals(asCurrentPlay(opening))
    expect(
      asPostEventsBody({ mode: 'live', plays: [], currentPlay: null })
        .currentPlay
    ).equals(null)
    expect(asPostEventsBody({ plays: [] }).currentPlay).equals(undefined)
  })

  it('reads a legacy code as the listed one', function () {
    expect(normalizeEventType('catcher_interference')).equals('catcher_interf')
    expect(normalizeEventType('single')).equals('single')
    expect(normalizeEventType('toString')).equals('toString')
    expect(eventTypeName('catcher_interference')).equals(
      eventTypeName('catcher_interf')
    )
    expect(eventTypeName('manual_placement')).equals('Batter placed on base')
    expect(eventTypeName('nonsense_type')).equals('Play')
    expect(eventTypeName(null)).equals('Play')
  })
})
