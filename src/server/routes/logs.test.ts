import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, afterEach, before, beforeEach, describe, it } from 'mocha'

import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { jsonBody } from '../jsonBody'
import { withAudit } from '../middleware/withAudit'
import { errorHandler } from '../middleware/withErrors'
import { logRoutes, MAX_LINE, MAX_LINES } from './logs'

describe('client logs', function () {
  let server: Server | undefined
  let base = ''
  let written: string[] = []
  const realLog = console.log
  /** The paths `withAudit` wrote a row for. */
  let audited: string[] = []
  const auditDb = {
    insertInto: () => ({
      values: (row: { path: string }) => ({
        execute: async () => {
          audited.push(row.path)
        }
      })
    })
  } as unknown as Kysely<Database>

  before(async function () {
    const app = express()
    app.use(jsonBody)
    // Stands in for withActor: a header names who is signed in.
    app.use((req, res, next) => {
      const user = req.header('x-test-user')
      if (user != null) {
        const actor: Actor = {
          userId: Number(user),
          isAdmin: false,
          scopes: []
        }
        req.actor = actor
      }
      next()
    })
    app.use(withAudit(auditDb))
    app.use('/api/v1', logRoutes())
    // Any other write, so the audit stand-in is seen to record one.
    app.post('/api/v1/other', (req, res) => {
      res.status(204).end()
    })
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(function () {
    server?.close()
  })

  beforeEach(function () {
    written = []
    audited = []
    console.log = (line: string) => {
      written.push(line)
    }
  })

  afterEach(function () {
    console.log = realLog
  })

  const post = async (
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<Response> =>
    await fetch(`${base}/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })

  it('writes each line to the server log, tagged with the client and who is signed in', async function () {
    const response = await post(
      {
        source: 'scorer',
        run: 'run-1',
        build: '46a78dd',
        lines: [
          { at: '2026-09-24T23:00:00.000Z', level: 'info', text: 'walk step' },
          {
            at: '2026-09-24T23:00:01.000Z',
            level: 'warn',
            text: 'push answered',
            data: { status: 401, path: '/games/x/events' }
          }
        ]
      },
      { 'x-test-user': '42' }
    )
    expect(response.status).equals(204)
    expect(written).deep.equals([
      '[client scorer] run=run-1 build=46a78dd user=42 at=2026-09-24T23:00:00.000Z info walk step',
      '[client scorer] run=run-1 build=46a78dd user=42 at=2026-09-24T23:00:01.000Z warn push answered {"status":401,"path":"/games/x/events"}'
    ])
  })

  it('takes lines from somebody not signed in, and cleans the labels', async function () {
    const response = await post({
      source: 'team station!\n',
      lines: [{ at: 'now', level: 'error', text: 'two\nlines' }]
    })
    expect(response.status).equals(204)
    expect(written).deep.equals([
      '[client teamstation] run=- build=- user=anonymous at=now error two lines'
    ])
  })

  it('keeps a forged line inside the one it came in', async function () {
    await post({
      source: 'app',
      lines: [
        {
          at: 'x\n[client app] user=1 at=now',
          level: 'info',
          text: 'hello'
        }
      ]
    })
    expect(written).to.have.length(1)
    expect(written[0]).not.include('\n')
    expect(written[0]).include('at=x [client app] user=1 ')
  })

  it('names an empty label and cuts a long line', async function () {
    await post({
      source: '!!!',
      lines: [{ at: 'now', level: 'debug', text: 'x'.repeat(MAX_LINE + 50) }]
    })
    expect(written[0]).to.match(/^\[client unknown\] /)
    expect(written[0].endsWith('x'.repeat(MAX_LINE))).equals(true)
    expect(written[0]).not.include('x'.repeat(MAX_LINE + 1))
  })

  it('refuses a malformed body or too many lines', async function () {
    expect(
      (await post({ source: 'x', lines: [{ level: 'loud' }] })).status
    ).equals(400)
    const many = Array.from({ length: MAX_LINES + 1 }, () => ({
      at: 'now',
      level: 'info',
      text: 'x'
    }))
    expect((await post({ source: 'x', lines: many })).status).equals(400)
    expect(written).deep.equals([])
  })

  it('writes no audit row for a post of lines', async function () {
    const lines = [{ at: 'now', level: 'info', text: 'x' }]
    expect((await post({ source: 'x', lines })).status).equals(204)
    expect(
      (await post({ source: 'x', lines }, { 'x-test-user': '42' })).status
    ).equals(204)
    const other = await fetch(`${base}/other`, { method: 'POST' })
    expect(other.status).equals(204)
    // The audit row is written once the response has finished.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(audited).deep.equals(['/api/v1/other'])
  })
})
