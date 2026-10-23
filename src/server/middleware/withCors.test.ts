import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import { after, before, describe, it } from 'mocha'

import { REVISION_HEADER } from '../socket/syncRevision'
import { withCors } from './withCors'

describe('withCors', function () {
  const ORIGIN = 'http://app.example.test:8080'
  let server: ReturnType<express.Express['listen']>
  let base = ''

  before(async () => {
    const app = express()
    app.use(withCors([ORIGIN]))
    app.get('/teams', (req, res) => {
      res.setHeader(REVISION_HEADER, '42')
      res.json([])
    })
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    await new Promise<void>(resolve =>
      server.close(() => {
        resolve()
      })
    )
  })

  it('lets a preflight send idempotency-key (CORS)', async function () {
    const response = await fetch(`${base}/teams`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'idempotency-key'
      }
    })
    expect(response.status).equals(204)
    expect(
      response.headers.get('access-control-allow-headers')?.split(',')
    ).includes('idempotency-key')
    expect(response.headers.get('access-control-allow-origin')).equals(ORIGIN)
  })

  it('lets a cross-origin GET read the revision (CORS)', async function () {
    const response = await fetch(`${base}/teams`, {
      headers: { origin: ORIGIN }
    })
    expect(response.status).equals(200)
    expect(response.headers.get('access-control-expose-headers')).equals(
      REVISION_HEADER
    )
    expect(response.headers.get(REVISION_HEADER)).equals('42')
  })

  it('admits the app classifier with authenticated browser API requests', async () => {
    const response = await fetch(`${base}/teams`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,x-teamstation-app'
      }
    })
    expect(response.status).equals(204)
    const allowed = response.headers
      .get('access-control-allow-headers')
      ?.split(',')
    expect(allowed).includes('authorization')
    expect(allowed).includes('x-teamstation-app')
    const result = await fetch(`${base}/teams`, {
      headers: { origin: ORIGIN, 'x-teamstation-app': 'TS web' }
    })
    expect(result.status).equals(200)
    expect(result.headers.get('access-control-allow-origin')).equals(ORIGIN)
  })

  it('refuses a preflight from an origin it does not list', async function () {
    const response = await fetch(`${base}/teams`, {
      method: 'OPTIONS',
      headers: { origin: 'http://elsewhere.example.test' }
    })
    expect(response.status).equals(403)
    expect(response.headers.get('access-control-allow-origin')).equals(null)
    expect(response.headers.get('access-control-expose-headers')).equals(null)
  })
})
