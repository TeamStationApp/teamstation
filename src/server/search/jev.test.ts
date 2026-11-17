import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'

import { FAKE_JEV_MODEL, type FakeJev, fakeJev } from '../../test/fakeJev'
import {
  JEV_MAX_CANDIDATES,
  JEV_MAX_LOCATIONS,
  JEV_MODEL,
  JEV_TIMEOUT_MS,
  type JevCandidateFacts,
  type JevLocationFacts,
  jevQuestions,
  jevRank,
  type JevState
} from './jev'

const KEY = 'ts-test-placeholder-key'

function team(name: string): JevCandidateFacts {
  return {
    kind: 'team',
    name,
    city: 'Demo City',
    region: 'California',
    country: 'US',
    placeLabel: 'Demo City, CA',
    words: [{ word: 'hawks', match: 'perfect' }],
    coverage: 0.5,
    lastActivityOn: '2026-10-01',
    ties: { member: false, follows: true }
  }
}

function place(label: string): JevLocationFacts {
  return {
    kind: 'city',
    label,
    city: label,
    region: 'California',
    country: 'US'
  }
}

function stateOf(names: string[], places: string[] = []): JevState {
  return {
    query: 'hawks',
    location: null,
    today: '2026-11-16',
    candidates: Object.fromEntries(
      names.map((name, at) => [`c${at + 1}`, team(name)])
    ),
    locations: Object.fromEntries(
      places.map((label, at) => [`l${at + 1}`, place(label)])
    )
  }
}

describe('jevRank', function () {
  let jev: FakeJev
  const lines: string[] = []
  const log = (line: string): void => {
    lines.push(line)
  }
  before(async () => {
    jev = await fakeJev()
  })
  afterEach(() => {
    jev.reset()
    lines.length = 0
  })
  after(async () => {
    await jev.close()
  })

  it('asks one noul per candidate and location, with the key in the header only', async () => {
    const state = stateOf(['Demo Hawks', 'Hawks Juniors'], ['Demo City'])
    await jevRank(state, KEY, jev.baseUrl, undefined, { log })
    expect(jev.requests).has.length(1)
    const [request] = jev.requests
    expect(request.method).equals('POST')
    expect(request.path).equals('/v1/systemone')
    expect(request.authorization).equals(`Bearer ${KEY}`)
    expect(request.contentType).equals('application/json')
    expect(request.body.model).equals(JEV_MODEL)
    expect(request.body.state).deep.equals(state)
    expect(Object.keys(request.body.questions ?? {})).deep.equals([
      'c1',
      'c2',
      'l1'
    ])
    const c2 = request.body.questions?.c2
    expect(c2?.type).equals('noul')
    expect(c2?.instructions).equals(
      'Is candidate `c2` one of the results this user most likely wants for the search `query`?'
    )
    expect(c2?.criteria?.true).equals(
      'The name matches the typed words closely (a perfect word match over starts-with over substring, more typed words over fewer, a name the query covers more fully), and the candidate is active recently: a team or season with events this year, a current season, a group inside the chosen location or near it, or a group or person the user is connected to.'
    )
    expect(c2?.criteria?.false).equals(
      'A weak or partial name match, or a team or season whose last event was years ago, a past season, or a place far from the chosen location.'
    )
    expect(request.body.questions?.l1?.instructions).equals(
      'Is location `l1` the place this user means by the search `query`?'
    )
    expect(JSON.stringify(request.body)).not.contains(KEY)
    // The versioned model is logged; the key never is.
    expect(lines).deep.equals([`jev: ranked by ${FAKE_JEV_MODEL}`])
  })

  it('orders by noul, highest first, a tie keeping the order it was given', async () => {
    jev.setNouls({ c1: 0.2, c2: 0.9, 'Hawks Juniors': 0.6, l1: 0.1, l2: 0.8 })
    const ranking = await jevRank(
      stateOf(
        ['Demo Hawks', 'Demo Eagles', 'Hawks Juniors', 'Hawks Seniors'],
        ['Demo City', 'Hawk Town']
      ),
      KEY,
      `${jev.baseUrl}/`,
      undefined,
      { log }
    )
    expect(ranking).deep.equals({
      // c4 takes the default 0.5, below c3's 0.6 by name.
      order: ['c2', 'c3', 'c4', 'c1'],
      locations: ['l2', 'l1'],
      model: FAKE_JEV_MODEL
    })

    jev.setNouls({}, 0.7)
    const tied = await jevRank(
      stateOf(['A', 'B', 'C'], ['X', 'Y']),
      KEY,
      jev.baseUrl,
      undefined,
      { log }
    )
    expect(tied?.order).deep.equals(['c1', 'c2', 'c3'])
    expect(tied?.locations).deep.equals(['l1', 'l2'])
  })

  it('keeps the best 50 candidates and 4 locations', async () => {
    const names = Array.from({ length: 60 }, (_, at) => `Team ${at + 1}`)
    const places = Array.from({ length: 12 }, (_, at) => `Place ${at + 1}`)
    // Later keys score higher, so the kept ones are the last.
    jev.setNouls(
      Object.fromEntries([
        ...names.map((_, at) => [`c${at + 1}`, (at + 1) / 100]),
        ...places.map((_, at) => [`l${at + 1}`, (at + 1) / 100])
      ])
    )
    const ranking = await jevRank(
      stateOf(names, places),
      KEY,
      jev.baseUrl,
      undefined,
      { log }
    )
    expect(ranking?.order).has.length(JEV_MAX_CANDIDATES)
    expect(ranking?.order[0]).equals('c60')
    expect(ranking?.order.at(-1)).equals('c11')
    expect(ranking?.locations).deep.equals(['l12', 'l11', 'l10', 'l9'])
    expect(ranking?.locations).has.length(JEV_MAX_LOCATIONS)
  })

  it('is null with no key or nothing to rank, and asks nothing', async () => {
    expect(await jevRank(stateOf(['A']), null, jev.baseUrl)).equals(null)
    expect(await jevRank(stateOf(['A']), undefined, jev.baseUrl)).equals(null)
    expect(await jevRank(stateOf(['A']), '', jev.baseUrl)).equals(null)
    expect(await jevRank(stateOf([]), KEY, jev.baseUrl)).equals(null)
    expect(jev.requests).deep.equals([])
  })

  for (const status of [401, 429, 500, 529] as const)
    it(`is null on a ${status}, asked once with no retry`, async () => {
      jev.fail(status)
      expect(
        await jevRank(stateOf(['A', 'B']), KEY, jev.baseUrl, undefined, { log })
      ).equals(null)
      expect(jev.requests).has.length(1)
      expect(lines).deep.equals([])
    })

  for (const how of ['json', 'noAnswers', 'missing', 'range'] as const)
    it(`is null on a malformed answer (${how})`, async () => {
      jev.malformed(how)
      expect(
        await jevRank(stateOf(['A', 'B'], ['X']), KEY, jev.baseUrl, undefined, {
          log
        })
      ).equals(null)
    })

  it('is null on an answer that is not a noul, a bad model or a bad body', async () => {
    const answers = [
      { model: '', answers: { c1: { type: 'noul', noul: 0.5 } } },
      { model: 'jev-x', answers: [] },
      { model: 'jev-x', answers: { c1: { type: 'choice', noul: 0.5 } } },
      { model: 'jev-x', answers: { c1: { type: 'noul', noul: 'high' } } },
      { model: 'jev-x', answers: { c1: { type: 'noul', noul: -0.1 } } },
      { model: 'jev-x', answers: { c1: 'yes' } },
      ['not', 'an', 'object']
    ]
    const realFetch = globalThis.fetch
    try {
      for (const answer of answers) {
        globalThis.fetch = async () =>
          new Response(JSON.stringify(answer), { status: 200 })
        expect(
          await jevRank(stateOf(['A']), KEY, 'https://jev.example.test'),
          JSON.stringify(answer)
        ).equals(null)
      }
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('is null when Jev cannot be reached', async () => {
    const closed = await fakeJev()
    const baseUrl = closed.baseUrl
    await closed.close()
    expect(await jevRank(stateOf(['A']), KEY, baseUrl)).equals(null)
  })

  it('gives up after its timeout, 3 seconds unless told otherwise', async () => {
    expect(JEV_TIMEOUT_MS).equals(3000)
    jev.delay(500)
    const started = Date.now()
    expect(
      await jevRank(stateOf(['A']), KEY, jev.baseUrl, undefined, {
        timeoutMs: 50,
        log
      })
    ).equals(null)
    expect(Date.now() - started).lessThan(400)
  })

  it('stops when the caller aborts, its signal composed with the timeout', async () => {
    jev.delay(500)
    const controller = new AbortController()
    const started = Date.now()
    const ranking = jevRank(stateOf(['A']), KEY, jev.baseUrl, controller.signal)
    setTimeout(() => {
      controller.abort()
    }, 30)
    expect(await ranking).equals(null)
    expect(Date.now() - started).lessThan(400)

    expect(
      await jevRank(stateOf(['A']), KEY, jev.baseUrl, AbortSignal.abort(), {
        log
      })
    ).equals(null)
  })

  it('writes the questions for a state with no locations', () => {
    expect(Object.keys(jevQuestions(stateOf(['A', 'B'])))).deep.equals([
      'c1',
      'c2'
    ])
  })
})

describe('fakeJev', function () {
  it('answers 404 off its path and 400 without questions', async () => {
    const jev = await fakeJev()
    try {
      expect((await fetch(`${jev.baseUrl}/v1/other`)).status).equals(404)
      const bad = await fetch(`${jev.baseUrl}/v1/systemone`, {
        method: 'POST',
        body: 'not json'
      })
      expect(bad.status).equals(400)
      expect(jev.requests.map(request => request.path)).deep.equals([
        '/v1/other',
        '/v1/systemone'
      ])
    } finally {
      await jev.close()
    }
  })
})
