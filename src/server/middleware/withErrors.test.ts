import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import { after, before, describe, it } from 'mocha'

import { forbidden } from '../../common/errors'
import { RequestAbandoned } from '../db/checkouts'
import { errorHandler, sparingly } from './withErrors'

describe('sparingly', function () {
  it('reports the first at once, then none until the time has passed', function () {
    let clock = 1000
    const reported: unknown[] = []
    const report = sparingly(
      error => reported.push(error),
      100,
      () => clock
    )
    report('first')
    clock += 99
    report('second')
    expect(reported).deep.equals(['first'])
    clock += 1
    report('third')
    expect(reported).deep.equals(['first', 'third'])
  })
})

describe('errorHandler', function () {
  let server: Server
  let base: string
  const errorOf: Record<string, Error> = {
    waiting: new Error('timeout exceeded when trying to connect'),
    opening: new Error('Connection terminated due to connection timeout'),
    pooler: new Error('query_wait_timeout'),
    lost: new Error('Connection terminated unexpectedly'),
    refused: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED'
    }),
    full: Object.assign(new Error('sorry, too many clients already'), {
      code: '53300'
    }),
    other: new Error('relation "secrets" does not exist'),
    abandoned: new RequestAbandoned(),
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

  for (const kind of [
    'waiting',
    'opening',
    'pooler',
    'lost',
    'refused',
    'full'
  ])
    it(`answers 503 with Retry-After when no connection is to be had (${kind})`, async function () {
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

  it('says nothing of a read stopped because its caller went away', async function () {
    const said: unknown[] = []
    console.error = (...args: unknown[]) => said.push(args)
    try {
      const response = await fetch(`${base}/fail/abandoned`)
      expect(await response.text()).equals('')
      expect(said).deep.equals([])
    } finally {
      console.error = () => undefined
    }
  })

  it('keeps a planned error as itself', async function () {
    const response = await fetch(`${base}/fail/planned`)
    expect(response.status).equals(403)
  })
})
