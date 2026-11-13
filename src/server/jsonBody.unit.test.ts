import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import { after, before, describe, it } from 'mocha'

import { userIdOfGumbo } from '../common/userId'
import { jsonBody, scheduleResultBody } from './jsonBody'

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
    // As the result route reads its body, once the actor may complete it.
    app.put('/direct/result', scheduleResultBody)
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
  const send = async (
    path: string,
    body: string,
    signedIn = true,
    method = 'PUT'
  ): Promise<Response> =>
    await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(signedIn ? { 'x-signed-in': '1' } : {})
      },
      body
    })
  const request = async (...args: Parameters<typeof send>): Promise<number> =>
    (await send(...args)).status
  it('leaves the result body to its route, which reads a multi-option result over 1 MiB', async () => {
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
    // The shared parser leaves the result route's body to the route, read
    // for nobody before the route has checked who is asking.
    for (const path of [
      '/api/v1/schedule-previews/preview/result',
      '/API/V1/SCHEDULE-PREVIEWS/preview/RESULT/'
    ])
      for (const signedIn of [true, false])
        expect(await (await send(path, body, signedIn)).json()).deep.equals({
          parsed: false
        })
    expect(
      await request('/api/v1/schedule-previews/preview/result', '{invalid')
    ).equals(200)
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
    // The route's own parser takes the multi-option result and no more than 64 MiB.
    expect(await (await send('/direct/result', body)).json()).deep.equals({
      parsed: true
    })
    expect(
      await request(
        '/direct/result',
        JSON.stringify({ data: 'x'.repeat(64 * 1024 * 1024) })
      )
    ).equals(413)
  })
})
