import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import { after, before, describe, it } from 'mocha'

import { userIdOfGumbo } from '../common/userId'
import { jsonBody } from './jsonBody'

describe('device schedule result body boundary', function () {
  this.timeout(15000)
  let server: Server
  let base: string
  before(async () => {
    const app = express()
    app.use((req, res, next) => {
      if (req.header('x-signed-in') === '1')
        req.actor = { userId: userIdOfGumbo(1), isAdmin: false, scopes: [] }
      next()
    })
    app.use(jsonBody)
    app.use((req, res) => {
      res.json({ parsed: req.body != null })
    })
    app.use(
      (
        error: { status?: number },
        req: express.Request,
        res: express.Response,
        next: express.NextFunction
      ) => {
        res.status(error.status ?? 500).end()
      }
    )
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => {
    server.close()
  })
  const request = async (
    path: string,
    body: string,
    signedIn = true,
    method = 'PUT'
  ): Promise<number> =>
    (
      await fetch(base + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(signedIn ? { 'x-signed-in': '1' } : {})
        },
        body
      })
    ).status
  it('accepts a multi-option result over 1 MiB only on the authenticated result route', async () => {
    const game = {
      key: 'schedule:'.padEnd(80, 'x'),
      seasonId: 'sea_demo'.padEnd(40, 's'),
      fieldId: 'fld_demo'.padEnd(40, 'f'),
      homeTeamId: 'tem_home'.padEnd(40, 'h'),
      awayTeamId: 'tem_away'.padEnd(40, 'a'),
      startAt: '2027-03-06T16:00:00Z',
      endAt: '2027-03-06T17:30:00Z',
      size: '50/70',
      exhibition: false
    }
    const body = JSON.stringify({
      options: Array.from({ length: 3 }, () => ({
        games: Array(1200).fill(game)
      })),
      blocking: null
    })
    expect(Buffer.byteLength(body)).greaterThan(1024 * 1024)
    expect(
      await request('/api/v1/schedule-previews/preview/result', body)
    ).equals(200)
    expect(
      await request('/API/V1/SCHEDULE-PREVIEWS/preview/RESULT/', body)
    ).equals(200)
    expect(
      await request(
        '/api/v1/schedule-previews/preview/result',
        '{invalid',
        false
      )
    ).equals(401)
    expect(
      await request('/api/v1/schedule-previews/preview/result/extra', body)
    ).equals(413)
    expect(
      await request(
        '/api/v1/schedule-previews/preview/result',
        body,
        true,
        'POST'
      )
    ).equals(413)
    expect(
      await request(
        '/api/v1/schedule-previews/preview/result',
        JSON.stringify({ data: 'x'.repeat(64 * 1024 * 1024) })
      )
    ).equals(413)
  })
})
