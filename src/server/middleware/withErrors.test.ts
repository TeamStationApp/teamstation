import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import { after, before, describe, it } from 'mocha'

import { forbidden } from '../../common/errors'
import { errorHandler } from './withErrors'

describe('errorHandler', function () {
  let server: Server
  let base: string
  const errorOf: Record<string, Error> = {
    waiting: new Error('timeout exceeded when trying to connect'),
    opening: new Error('Connection terminated due to connection timeout'),
    other: new Error('relation "secrets" does not exist'),
    planned: forbidden('No')
  }
  const quiet = console.error

  before(async function () {
    const app = express()
    app.get('/fail/:kind', (req, res, next) => {
      next(errorOf[req.params.kind])
    })
    app.get('/partial', (req, res, next) => {
      res.write('so far')
      next(errorOf.waiting)
    })
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    console.error = () => undefined
  })

  after(async function () {
    console.error = quiet
    await new Promise(resolve => server.close(resolve))
  })

  for (const kind of ['waiting', 'opening'])
    it(`answers 503 with Retry-After for a pool timeout (${kind})`, async function () {
      const response = await fetch(`${base}/fail/${kind}`)
      expect(response.status).equals(503)
      expect(response.headers.get('retry-after')).equals('1')
      const body = (await response.json()) as { error: { code: string } }
      expect(JSON.stringify(body)).contains('unavailable')
      expect(JSON.stringify(body)).not.contains('timeout exceeded')
    })

  it('leaves a response already under way to express', async function () {
    let cut = false
    await fetch(`${base}/partial`)
      .then(async response => await response.text())
      .catch(() => {
        cut = true
      })
    expect(cut).equals(true)
  })

  it('keeps any other error a bare 500', async function () {
    const response = await fetch(`${base}/fail/other`)
    expect(response.status).equals(500)
    expect(response.headers.get('retry-after')).equals(null)
    expect(await response.text()).not.contains('secrets')
  })

  it('keeps a planned error as itself', async function () {
    const response = await fetch(`${base}/fail/planned`)
    expect(response.status).equals(403)
  })
})
