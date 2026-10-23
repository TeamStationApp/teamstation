import { expect } from 'chai'
import type { Request } from 'express'
import { after, before, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import {
  apiCall,
  credentialsOf,
  loopbackOrigin,
  MAX_RESULT_CHARS,
  TESS_HEADER
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
      app.get('/api/v1/__hang', () => {
        // Never answers.
      })
    })
  })
  after(async () => {
    await h?.close()
  })

  it('forwards the bearer token, and says the request is Tess’s', async () => {
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
