import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import { after, before, describe, it } from 'mocha'

import { type CheckoutOwner, checkoutOwner } from '../db/checkouts'
import { checkoutOwners } from './checkoutOwners'

describe('checkoutOwners', () => {
  let server: ReturnType<express.Express['listen']>
  let base = ''
  /** The owner a checkout made before routing would have had. */
  let beforeRouting: CheckoutOwner | undefined

  before(async () => {
    const app = express()
    app.use(checkoutOwners)
    app.use((req, res, next) => {
      // As the session lookup does: a read before any route is matched.
      setImmediate(() => {
        beforeRouting = checkoutOwner()
        next()
      })
    })
    app.use(express.json())
    const router = express.Router()
    router.get('/videos/:videoId/wall-timeline', (req, res) => {
      setImmediate(() => {
        res.json({ label: checkoutOwner()?.label() })
      })
    })
    router.post('/games/:gameId/notes', (req, res) => {
      setImmediate(() => {
        res.json({ label: checkoutOwner()?.label() })
      })
    })
    app.use('/api/v1', router)
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

  it('names a request by its route’s pattern, never by its ids', async () => {
    const response = await fetch(
      `${base}/api/v1/videos/0d5c7e2a-secret-id/wall-timeline?afterMs=12`
    )
    const { label } = (await response.json()) as { label: string }
    expect(label).to.equal('GET /api/v1/videos/:videoId/wall-timeline')
    // What was read before routing is named by the route it went on to.
    expect(beforeRouting?.label()).to.equal(label)
  })

  it('keeps the name past a body read from the socket', async () => {
    const response = await fetch(`${base}/api/v1/games/1234/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(100_000) })
    })
    const { label } = (await response.json()) as { label: string }
    expect(label).to.equal('POST /api/v1/games/:gameId/notes')
  })

  it('names a request no route took as before routing', async () => {
    await fetch(`${base}/api/v1/nowhere/42`)
    expect(beforeRouting?.label()).to.equal('GET (before route)')
  })
})
