import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import express from 'express'

import { requestRecorder } from './requestRecorder'

describe('the development request recorder', function () {
  let dir: string
  beforeEach(function () {
    dir = mkdtempSync(join(tmpdir(), 'teamstation-record-'))
  })
  afterEach(function () {
    rmSync(dir, { recursive: true, force: true })
  })

  it('is not installed with TS_REQUEST_RECORD unset or empty', function () {
    expect(requestRecorder({})).equals(undefined)
    expect(requestRecorder({ TS_REQUEST_RECORD: '' })).equals(undefined)
  })

  it('appends each request’s method, path with query and status in arrival order, and no header or body', async function () {
    const file = join(dir, 'requests.log')
    const recorder = requestRecorder({ TS_REQUEST_RECORD: file })!
    const app = express()
    app.use(recorder)
    app.use(express.json())
    app.get('/api/v1/events', (_req, res) => {
      res.json([])
    })
    app.post('/api/v1/games/:id/swap-sides', (_req, res) => {
      res.status(201).json({ ok: true })
    })
    const server = app.listen(0)
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      await fetch(`${base}/api/v1/events?paged=1&when=upcoming`, {
        headers: { authorization: 'Bearer secret-token' }
      })
      await fetch(`${base}/api/v1/games/g1/swap-sides`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'hunter2' })
      })
      await fetch(`${base}/api/v1/nothing`)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines.map(line => line.split(' ').slice(1))).deep.equals([
      ['GET', '/api/v1/events?paged=1&when=upcoming', '200'],
      ['POST', '/api/v1/games/g1/swap-sides', '201'],
      ['GET', '/api/v1/nothing', '404']
    ])
    for (const line of lines)
      expect(Number.isNaN(Date.parse(line.split(' ')[0]))).equals(false)
    const written = readFileSync(file, 'utf8')
    expect(written).not.includes('secret-token')
    expect(written).not.includes('hunter2')
  })

  it('leaves the request as it was when the record cannot be written', async function () {
    const recorder = requestRecorder({
      TS_REQUEST_RECORD: join(dir, 'missing', 'dir', 'requests.log')
    })!
    const app = express()
    app.use(recorder)
    app.get('/x', (_req, res) => {
      res.json({ ok: true })
    })
    const server = app.listen(0)
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const answer = await fetch(`${base}/x`)
      expect(answer.status).equals(200)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})
