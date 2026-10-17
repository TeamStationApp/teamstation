import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import { after, before, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import { measureOffset } from '../../common/serverClock'
import { openApiDocument } from '../openapi'
import { timeRoutes } from './time'

describe('GET /time (U18)', function () {
  let server: ReturnType<ReturnType<typeof express>['listen']>
  let base = ''
  before(async function () {
    const app = express()
    app.use('/api/v1', timeRoutes())
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        resolve()
      })
    })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })
  after(async function () {
    await new Promise(resolve => server.close(resolve))
  })

  it("answers the server's clock to anybody, and lets nothing keep it", async function () {
    const before = Date.now()
    const response = await fetch(`${base}/time`)
    const after = Date.now()
    expect(response.status).equals(200)
    expect(response.headers.get('cache-control')).equals('no-store')
    const { now } = (await response.json()) as { now: number }
    expect(now).within(before, after)
  })

  it('is what the client and the offset measurement read', async function () {
    const client = new TeamStationClient({ baseUrl: base })
    const now = await client.serverTime()
    expect(now).closeTo(Date.now(), 1000)
    // This machine is the server, so the two clocks are the same.
    const sample = await measureOffset(async () => await client.serverTime())
    expect(Math.abs(sample.offsetMs)).lessThan(sample.roundTripMs / 2 + 2)
  })

  it('is documented as needing no sign-in', function () {
    const time = (
      openApiDocument('0.0.0').paths as Record<
        string,
        { get?: { security?: unknown; description?: string } }
      >
    )['/time']?.get
    expect(time).not.equals(undefined)
    expect(time?.security).equals(undefined)
    expect(time?.description).includes('no sign-in')
    expect(time?.description).includes('no-store')
  })
})
