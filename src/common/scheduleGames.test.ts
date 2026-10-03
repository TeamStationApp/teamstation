import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asScheduleGameRow,
  asScheduleGamesBody,
  asScheduleGamesResponse
} from './scheduleGames'

const START = '2026-07-19T00:00:00.000Z'

function refusal(raw: unknown): string {
  try {
    asScheduleGameRow(raw)
  } catch (error) {
    return (error as Error).message
  }
  return ''
}

describe('schedule rows', function () {
  it('cleans a full row and a minimal one', function () {
    expect(
      asScheduleGameRow({
        opponent: { name: '  AC Hustle 10U ' },
        side: 'home',
        startAt: START,
        seasonId: 'sea_1',
        venue: 'Lakeside',
        status: 'cancelled',
        externalId: { system: 'acme', id: 'abc', kind: 'teamEvent' },
        fenceDistanceFt: 210
      })
    ).deep.equals({
      opponent: { name: 'AC Hustle 10U' },
      side: 'home',
      startAt: START,
      seasonId: 'sea_1',
      venue: 'Lakeside',
      status: 'cancelled',
      externalId: { system: 'acme', id: 'abc', kind: 'teamEvent' },
      fenceDistanceFt: 210
    })
    expect(
      asScheduleGameRow({ startAt: '2026-10-04T10:00:00-07:00' })
    ).deep.equals({
      startAt: '2026-10-04T10:00:00-07:00'
    })
    expect(
      asScheduleGameRow({
        startAt: START,
        opponent: { teamId: 'tem_1' },
        venue: null
      })
    ).deep.equals({
      startAt: START,
      opponent: { teamId: 'tem_1' },
      venue: null
    })
  })

  it('cleans an opponent’s external id, kind and all', function () {
    expect(
      asScheduleGameRow({
        startAt: START,
        opponent: {
          name: ' Rattlers ',
          externalId: { system: 'otherLeague', kind: 'opponent', id: 'r-1' }
        }
      }).opponent
    ).deep.equals({
      name: 'Rattlers',
      externalId: { system: 'otherLeague', kind: 'opponent', id: 'r-1' }
    })
  })

  it('defaults an external id kind to event', function () {
    expect(
      asScheduleGameRow({
        startAt: START,
        externalId: { system: 'otherLeague', id: 'x' }
      }).externalId
    ).deep.equals({ system: 'otherLeague', id: 'x', kind: 'event' })
  })

  it('refuses each bad field by name', function () {
    const cases: Array<[unknown, string]> = [
      [{ startAt: '2026-10-03 17:00' }, 'startAt'],
      [{ startAt: '2026-10-03T17:00:00' }, 'startAt'],
      [{ startAt: '2026-13-45T17:00:00Z' }, 'startAt'],
      [{}, 'startAt'],
      [{ startAt: START, side: 'left' }, 'side'],
      [{ startAt: START, status: 'final' }, 'status'],
      [{ startAt: START, opponent: { teamId: 't', name: 'n' } }, 'opponent'],
      [{ startAt: START, opponent: {} }, 'opponent'],
      [{ startAt: START, opponent: 'x' }, 'opponent'],
      [{ startAt: START, opponent: { teamId: ' ' } }, 'opponent.teamId'],
      [{ startAt: START, opponent: { name: 3 } }, 'opponent.name'],
      [{ startAt: START, opponent: { name: '  ' } }, 'opponent.name'],
      [
        { startAt: START, opponent: { name: 'x'.repeat(121) } },
        'opponent.name'
      ],
      [
        {
          startAt: START,
          opponent: {
            teamId: 't',
            externalId: { system: 'o', kind: 'opponent', id: 'x' }
          }
        },
        'opponent.externalId'
      ],
      [
        { startAt: START, opponent: { name: 'n', externalId: 'x' } },
        'opponent.externalId'
      ],
      [
        {
          startAt: START,
          opponent: {
            name: 'n',
            externalId: { system: 'Other', kind: 'opponent', id: 'x' }
          }
        },
        'opponent.externalId.system'
      ],
      [
        {
          startAt: START,
          opponent: { name: 'n', externalId: { system: 'o', id: 'x' } }
        },
        'opponent.externalId.kind'
      ],
      [
        {
          startAt: START,
          opponent: {
            name: 'n',
            externalId: { system: 'o', kind: '', id: 'x' }
          }
        },
        'opponent.externalId.kind'
      ],
      [
        {
          startAt: START,
          opponent: {
            name: 'n',
            externalId: { system: 'o', kind: 'opponent', id: '' }
          }
        },
        'opponent.externalId.id'
      ],
      [{ startAt: START, seasonId: '' }, 'seasonId'],
      [{ startAt: START, venue: 'v'.repeat(201) }, 'venue'],
      [{ startAt: START, externalId: 'x' }, 'externalId'],
      [
        { startAt: START, externalId: { system: 'other league', id: 'x' } },
        'externalId.system'
      ],
      [
        { startAt: START, externalId: { system: 'Other', id: 'x' } },
        'externalId.system'
      ],
      [
        { startAt: START, externalId: { system: 'o', id: 'x', kind: 'A' } },
        'externalId.kind'
      ],
      [
        { startAt: START, externalId: { system: 'o', id: '' } },
        'externalId.id'
      ],
      [
        { startAt: START, externalId: { system: 'o', id: 'i'.repeat(201) } },
        'externalId.id'
      ],
      [{ startAt: START, fenceDistanceFt: 0 }, 'fenceDistanceFt'],
      [{ startAt: START, fenceDistanceFt: 601 }, 'fenceDistanceFt'],
      [{ startAt: START, fenceDistanceFt: 200.5 }, 'fenceDistanceFt'],
      [{ startAt: START, fenceDistanceFt: null }, 'fenceDistanceFt'],
      ['nope', 'game']
    ]
    for (const [raw, field] of cases) {
      expect(refusal(raw), JSON.stringify(raw)).includes(field)
    }
  })

  it('takes a body of 1-200 raw games', function () {
    expect(asScheduleGamesBody({ games: [1, 2] })).deep.equals({
      games: [1, 2]
    })
    expect(asScheduleGamesBody({ games: Array(200).fill({}) }).games).lengthOf(
      200
    )
    for (const raw of [
      {},
      { games: 'x' },
      { games: [] },
      { games: Array(201).fill({}) },
      []
    ]) {
      expect(() => asScheduleGamesBody(raw)).throws(TypeError)
    }
  })

  it('reads an answer with the five error codes and nothing else', function () {
    const answer = {
      results: [
        { index: 0, result: 'created', gameId: 'gam_1', status: 'scheduled' },
        { index: 1, result: 'error', error: { code: 'noSeason', message: 'm' } }
      ],
      counts: { created: 1, updated: 0, unchanged: 0, error: 1 }
    }
    expect(asScheduleGamesResponse(answer)).deep.equals(answer)
    for (const code of [
      'invalid',
      'notFound',
      'conflict',
      'noSeason',
      'forbidden'
    ]) {
      expect(
        asScheduleGamesResponse({
          results: [
            { index: 0, result: 'error', error: { code, message: 'm' } }
          ],
          counts: answer.counts
        }).results[0]
      ).deep.equals({
        index: 0,
        result: 'error',
        error: { code, message: 'm' }
      })
    }
    const bad = [
      null,
      { results: [], counts: { created: 1, updated: 0, unchanged: 0 } },
      { results: [{ result: 'created' }], counts: answer.counts },
      {
        results: [
          { index: 0, result: 'error', error: { code: 'weird', message: 'm' } }
        ],
        counts: answer.counts
      },
      {
        results: [{ index: 0, result: 'moved', gameId: 'g', status: 'final' }],
        counts: answer.counts
      },
      {
        results: [{ index: 0, result: 'created', gameId: 'g', status: 'odd' }],
        counts: answer.counts
      }
    ]
    for (const raw of bad) {
      expect(() => asScheduleGamesResponse(raw), JSON.stringify(raw)).throws(
        TypeError
      )
    }
  })
})
