import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import { after, before, describe, it } from 'mocha'

import { jsonBody } from './jsonBody'

describe('the JSON body limit', function () {
  this.timeout(60000)
  let server: Server | undefined
  let base = ''

  before(async function () {
    const app = express()
    // Signed in when the request says so, as `withActor` would have it.
    app.use((req, res, next) => {
      if (req.header('x-signed-in') != null) {
        req.actor = { userId: 1, isAdmin: false, scopes: [] }
      }
      next()
    })
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

  const put = async (path: string, length: number): Promise<number> =>
    (
      await fetch(`${base}${path}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-signed-in': '1' },
        body: JSON.stringify({
          image: { contentType: 'image/png', base64: 'A'.repeat(length) },
          source: 'upload'
        })
      })
    ).status

  it('takes a 10 MiB picture as base64, and nothing past 14 MB', async function () {
    // 10 MiB of bytes is 13,981,016 characters of base64.
    const tenMiB = 4 * Math.ceil((10 * 1024 * 1024) / 3)
    for (const path of [
      '/api/v1/teams/tem_one/logo',
      '/api/v1/teams/tem_one/players/123/avatar'
    ]) {
      expect(await put(path, tenMiB), path).equals(200)
      expect(await put(path, 15_000_000), path).equals(413)
    }
    // Only a PUT of a picture: a POST there is held to 1 MB.
    expect(await post('/api/v1/teams/tem_one/logo')).equals(413)
  })

  it('answers 401 to a picture from nobody, without reading its body', async function () {
    const started = Date.now()
    const response = await fetch(`${base}/api/v1/teams/tem_one/logo`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      // Not JSON at all, and as large as a picture may be: parsed, it
      // would be a 400.
      body: '{'.repeat(14_000_000)
    })
    expect(response.status).equals(401)
    expect(Date.now() - started).lessThan(5000)
  })

  it('uses the authenticated picture boundary for onboarding, every group creation and group editing route', async function () {
    const tenMiB = 4 * Math.ceil((10 * 1024 * 1024) / 3)
    const routes = [
      ['PUT', '/api/v1/me/onboarding/photo'],
      ['POST', '/api/v1/leagues'],
      ['POST', '/api/v1/seasons'],
      ['POST', '/api/v1/teams'],
      ['PUT', '/api/v1/groups/league/lea_demo'],
      ['PUT', '/api/v1/groups/season/sea_demo'],
      ['PUT', '/api/v1/groups/team/tem_demo']
    ]
    for (const [method, path] of routes.flatMap(([method, path]) => [
      [method, path],
      [method, path.toUpperCase() + '/']
    ])) {
      const request = async (
        length: number,
        signedIn: boolean
      ): Promise<number> =>
        (
          await fetch(base + path, {
            method,
            headers: {
              'content-type': 'application/json',
              ...(signedIn ? { 'x-signed-in': '1' } : {})
            },
            body: JSON.stringify({
              image: { contentType: 'image/png', base64: 'A'.repeat(length) }
            })
          })
        ).status
      expect(await request(tenMiB, true), path).equals(200)
      expect(await request(15_000_000, true), path).equals(413)
      expect(await request(tenMiB, false), path).equals(401)
    }
  })

  it('holds every other route to 1 MB', async function () {
    expect(await post('/api/v1/auth/code')).equals(413)
    expect(await post('/api/v1/games/gam_one/events/extra')).equals(413)
  })
})
