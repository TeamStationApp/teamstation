import { expect } from 'chai'
import type { Request } from 'express'
import { after, before, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { TESS_HEADER } from '../middleware/withAuth'
import {
  apiCall,
  credentialsOf,
  loopbackOrigin,
  MAX_RESULT_CHARS
} from './loopback'

/** A request as `credentialsOf` reads it. */
const requestWith = (headers: Record<string, string>, ip?: string): Request =>
  ({
    header: (name: string) => headers[name.toLowerCase()],
    ip
  }) as unknown as Request

describe("Tess's loopback to the API", function () {
  this.timeout(60000)
  let h: AccountHarness

  before(async () => {
    h = await accountHarness(undefined, undefined, '127.0.0.1', app => {
      // What the API saw: who was signed in, and the headers that matter.
      app.get('/api/v1/__echo', (req, res) => {
        res.json({
          userId: req.actor?.userId ?? null,
          viaTess: req.actor?.viaTess ?? null,
          tess: req.header(TESS_HEADER) ?? null,
          forwardedFor: req.header('x-forwarded-for') ?? null,
          query: req.query
        })
      })
      app.post('/api/v1/__echo', (req, res) => {
        res.status(201).json({ body: req.body as unknown })
      })
      app.get('/api/v1/__long', (_req, res) => {
        res.send('x'.repeat(MAX_RESULT_CHARS + 10))
      })
      // A player's stats answer for a long season, in the route's key order:
      // the totals and the filter, then the split rows last.
      app.get('/api/v1/__playerStats', (_req, res) => {
        res.json({
          userId: 'usr_1',
          filter: { seasonId: 'sea_1', teamId: null, year: null },
          games: 400,
          batting: { ab: 1200, h: 400 },
          pitching: { outs: 900, er: 120 },
          options: { seasons: [{ seasonId: 'sea_1', name: 'Spring' }] },
          splits: {
            by: 'game',
            batting: Array.from({ length: 400 }, (_, game) => ({
              split: { gameId: `gam_${game}`, opponentName: 'Ravens' },
              line: { ab: 3, h: 1, note: 'x'.repeat(200) }
            })),
            pitching: [
              {
                split: { gameId: 'gam_0', opponentName: 'Ravens' },
                line: { outs: 3, er: 0 }
              }
            ]
          }
        })
      })
      app.get('/api/v1/__hang', () => {
        // Never answers.
      })
      // A still in storage, as the media routes answer one: signed, elsewhere.
      app.get('/api/v1/__moved', (_req, res) => {
        res.redirect(302, 'https://media.example.test/still.jpg?signature=abc')
      })
      app.post('/api/v1/__moved', (_req, res) => {
        res.redirect(307, '/api/v1/__echo')
      })
    })
  })
  after(async () => {
    await h?.close()
  })

  it('forwards the bearer token, and says the request is Tess’s, which the server marks as a machine’s', async () => {
    const answer = await apiCall(
      h.origin,
      {
        authorization: `Bearer ${h.tokens.get(101) ?? ''}`,
        forwardedFor: '203.0.113.7'
      },
      'GET',
      '/__echo?team=tem_account',
      { season: ['sea_1', 'sea_2'], deep: { a: 1 }, skipped: undefined }
    )
    expect(answer.status).equals(200)
    expect(answer.truncated).equals(false)
    expect(JSON.parse(answer.body)).deep.equals({
      userId: userIdOfGumbo(101),
      viaTess: true,
      tess: '1',
      forwardedFor: '203.0.113.7',
      query: {
        team: 'tem_account',
        season: ['sea_1', 'sea_2'],
        deep: '{"a":1}'
      }
    })
  })

  it('forwards the session cookie of a web session', async () => {
    const answer = await apiCall(
      h.origin,
      { cookie: `ts_session=${h.tokens.get(102) ?? ''}` },
      'GET',
      '/__echo'
    )
    expect(JSON.parse(answer.body).userId).equals(userIdOfGumbo(102))
  })

  it('sends a write’s body as JSON', async () => {
    const answer = await apiCall(
      h.origin,
      { authorization: `Bearer ${h.tokens.get(101) ?? ''}` },
      'POST',
      '/__echo',
      undefined,
      { name: 'Demo Hawks' }
    )
    expect(answer.status).equals(201)
    expect(JSON.parse(answer.body)).deep.equals({
      body: { name: 'Demo Hawks' }
    })
  })

  it('answers a route the person may not use with that route’s own refusal', async () => {
    const anonymous = await apiCall(h.origin, {}, 'GET', '/me/roles')
    expect(anonymous.status).equals(401)
    const missing = await apiCall(
      h.origin,
      { authorization: `Bearer ${h.tokens.get(102) ?? ''}` },
      'GET',
      '/teams/tem_nobody_has/games'
    )
    expect([403, 404]).includes(missing.status)
    expect(JSON.parse(missing.body).code).to.be.a('string')
  })

  it('cuts a long answer and says so', async () => {
    const answer = await apiCall(h.origin, {}, 'GET', '/__long')
    expect(answer.truncated).equals(true)
    expect(answer.body.startsWith('x'.repeat(MAX_RESULT_CHARS))).equals(true)
    expect(answer.body).includes(`Cut at ${MAX_RESULT_CHARS}`)
  })

  it('keeps a player’s totals and filter whole when it cuts a long season of split rows', async () => {
    const answer = await apiCall(h.origin, {}, 'GET', '/__playerStats')
    expect(answer.truncated).equals(true)
    const head = answer.body.slice(0, answer.body.indexOf('"splits"'))
    expect(head).includes('"batting":{"ab":1200,"h":400}')
    expect(head).includes('"pitching":{"outs":900,"er":120}')
    expect(head).includes('"options":{"seasons":[{"seasonId":"sea_1"')
    expect(answer.body).includes(`Cut at ${MAX_RESULT_CHARS}`)
    // A cut inside the batting rows takes every pitching row with it.
    expect(answer.body.slice(head.length)).not.includes('"outs":3')
  })

  it('answers status 0 when the API does not answer in time', async () => {
    const answer = await apiCall(
      h.origin,
      {},
      'GET',
      '/__hang',
      undefined,
      undefined,
      {
        deadlineMs: 50
      }
    )
    expect(answer).deep.equals({
      status: 0,
      body: 'TeamStation did not answer that request',
      truncated: false
    })
  })

  it('answers a redirect with where it points, and does not follow it', async () => {
    const still = await apiCall(h.origin, {}, 'GET', '/__moved')
    expect(still).deep.equals({
      status: 302,
      body: 'Redirected to https://media.example.test/still.jpg, outside TeamStation, not followed',
      truncated: false
    })
    const write = await apiCall(
      h.origin,
      { authorization: `Bearer ${h.tokens.get(101) ?? ''}` },
      'POST',
      '/__moved',
      undefined,
      { name: 'Demo Hawks' }
    )
    expect(write).deep.equals({
      status: 307,
      body: 'Redirected to /api/v1/__echo, not followed',
      truncated: false
    })
  })

  it('checks the deny list itself, on the path the URL normalizes to, and sends nothing refused', async () => {
    const sent: string[] = []
    const fetch: typeof globalThis.fetch = async url => {
      sent.push((url as URL).href)
      return new Response('{}', { status: 200 })
    }
    for (const [method, path] of [
      ['DELETE', '/me/./account'],
      ['DELETE', '/me/%2e/account'],
      ['POST', '/games/g1/%2E/events'],
      ['POST', '/./director/events/g1/claim'],
      ['GET', '/./oauth/approvals/abc'],
      ['GET', '/me/tess'],
      ['GET', '/teams/../../auth/logout'],
      ['GET', '/../../teams']
    ] as const) {
      const answer = await apiCall(
        'http://127.0.0.1:9',
        {},
        method,
        path,
        undefined,
        undefined,
        { fetch }
      )
      expect(answer.status, `${method} ${path}`).equals(403)
      expect(answer.body, path).match(/^(Tess may not|That path)/)
    }
    expect(sent).deep.equals([])
    await apiCall(
      'http://127.0.0.1:9',
      {},
      'GET',
      '/games/g1/./events',
      {},
      undefined,
      {
        fetch
      }
    )
    expect(sent).deep.equals(['http://127.0.0.1:9/api/v1/games/g1/events'])
  })

  it('reaches a wildcard listen host on the loopback address', function () {
    expect(loopbackOrigin({ listenHost: '0.0.0.0', listenPort: 9100 })).equals(
      'http://127.0.0.1:9100'
    )
    expect(loopbackOrigin({ listenHost: '::', listenPort: 9100 })).equals(
      'http://127.0.0.1:9100'
    )
    expect(loopbackOrigin({ listenHost: '', listenPort: 9100 })).equals(
      'http://127.0.0.1:9100'
    )
    expect(loopbackOrigin({ listenHost: '127.0.0.1', listenPort: 80 })).equals(
      'http://127.0.0.1:80'
    )
    expect(loopbackOrigin({ listenHost: '::1', listenPort: 9100 })).equals(
      'http://[::1]:9100'
    )
  })

  it('takes the credentials a request carried, the header before the cookie', function () {
    expect(
      credentialsOf(
        requestWith(
          { authorization: ' Bearer abc ', cookie: 'ts_session=def' },
          '198.51.100.4'
        )
      )
    ).deep.equals({ authorization: 'Bearer abc', forwardedFor: '198.51.100.4' })
    expect(
      credentialsOf(requestWith({ cookie: 'other=1; ts_session=d%2Fef' }))
    ).deep.equals({ cookie: 'ts_session=d%2Fef' })
    expect(
      credentialsOf(requestWith({ authorization: 'Basic abc' }, ''))
    ).deep.equals({})
  })
})
