import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import { after, before, describe, it } from 'mocha'

import { jsonBody } from './jsonBody'

describe('the JSON body limit', function () {
  let server: Server | undefined
  let base = ''

  before(async function () {
    const app = express()
    app.use(jsonBody)
    app.use((req, res) => {
      res.json({ keys: Object.keys(req.body ?? {}) })
    })
    // Only the parser's own status matters here.
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
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(function () {
    server?.close()
  })

  /** A body a little over 2 MB: past the small limit, far below the large. */
  const post = async (path: string): Promise<number> =>
    (
      await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plays: 'x'.repeat(2_100_000) })
      })
    ).status

  it("takes a whole game's plays in one post", async function () {
    expect(await post('/api/v1/games/gam_one/events')).equals(200)
  })

  it('holds every other route to 1 MB', async function () {
    expect(await post('/api/v1/auth/code')).equals(413)
    expect(await post('/api/v1/logs')).equals(413)
    expect(await post('/api/v1/games/gam_one/events/extra')).equals(413)
  })
})
