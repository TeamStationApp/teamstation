import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'

import {
  asJevControl,
  JEV_PATH,
  JEV_REQUESTS_KEPT,
  JEV_STUB_MODEL,
  JevStub,
  scriptedAnswers
} from './jevStub'
import { startPlacesStub } from './placesStub'

/** A System One request for these candidates, as the server's Jev client sends it. */
function systemOne(
  query: string,
  names: string[],
  labels: string[] = []
): Record<string, unknown> {
  const candidates: Record<string, { name: string }> = {}
  const locations: Record<string, { label: string }> = {}
  const questions: Record<string, unknown> = {}
  names.forEach((name, index) => {
    candidates[`c${index + 1}`] = { name }
    questions[`c${index + 1}`] = { type: 'noul' }
  })
  labels.forEach((label, index) => {
    locations[`l${index + 1}`] = { label }
    questions[`l${index + 1}`] = { type: 'noul' }
  })
  return {
    model: 'jev-latest',
    state: { query, candidates, locations },
    questions
  }
}

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('the Jev stand-in’s script', function () {
  it('reads a whole control, and leaves out what it is not given', function () {
    expect(asJevControl({})).deep.equals({
      passThrough: false,
      rule: {},
      queries: {}
    })
    expect(
      asJevControl({
        passThrough: true,
        rule: { nouls: { c1: 0.2, 'Hawks Gold': 1 }, defaultNoul: 0.1 },
        queries: { hawk: { status: 529, delayMs: 2000 }, gone: null }
      })
    ).deep.equals({
      passThrough: true,
      rule: { nouls: { c1: 0.2, 'Hawks Gold': 1 }, defaultNoul: 0.1 },
      queries: { hawk: { status: 529, delayMs: 2000 }, gone: {} }
    })
  })

  it('refuses what is not a script, naming what is wrong', function () {
    const refusal = (raw: unknown): string => {
      try {
        asJevControl(raw)
      } catch (error) {
        return (error as Error).message
      }
      throw new Error('expected a refusal')
    }
    expect(refusal(null)).includes('not an object')
    expect(refusal([])).includes('not an object')
    expect(refusal({ passThrough: 'yes' })).includes('passThrough')
    expect(refusal({ queries: 3 })).includes('queries is not an object')
    expect(refusal({ rule: 'x' })).includes('rule is not an object')
    expect(refusal({ rule: { nouls: [] } })).includes('rule.nouls')
    expect(refusal({ rule: { nouls: { c1: 2 } } })).includes('rule.nouls["c1"]')
    expect(refusal({ rule: { defaultNoul: -1 } })).includes('defaultNoul')
    expect(refusal({ rule: { status: 99 } })).includes('status')
    expect(refusal({ rule: { status: 500.5 } })).includes('status')
    expect(refusal({ rule: { status: '529' } })).includes('status')
    expect(refusal({ queries: { a: { delayMs: 60000 } } })).includes(
      'queries["a"].delayMs'
    )
  })

  it('answers by question id, then by name or label, then the default', function () {
    const body = systemOne(
      'hawk',
      ['Hawks Gold', 'Hawks Blue'],
      ['La Mesa, CA']
    )
    expect(
      scriptedAnswers(body, {
        nouls: { c2: 0.1, 'Hawks Gold': 0.9, 'La Mesa, CA': 0.7 }
      })
    ).deep.equals({
      c1: { type: 'noul', noul: 0.9 },
      c2: { type: 'noul', noul: 0.1 },
      l1: { type: 'noul', noul: 0.7 }
    })
    expect(scriptedAnswers(body, { defaultNoul: 0.3 }).c1.noul).equals(0.3)
    expect(scriptedAnswers(body, {}).l1.noul).equals(0.5)
    expect(scriptedAnswers({}, {})).deep.equals({})
  })
})

describe('the Jev stand-in on the Places listener', function () {
  let upstream: Server
  let upstreamSeen: Array<{ authorization?: string; body: string }>
  let upstreamStatus = 200
  let upstreamBody = '{"model":"jev-1.13.0","answers":{}}'
  let upstreamDelay = 0
  let stub: JevStub
  let places: Awaited<ReturnType<typeof startPlacesStub>>

  before(async function () {
    upstreamSeen = []
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        upstreamSeen.push({
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString()
        })
        setTimeout(() => {
          if (res.destroyed) return
          res.writeHead(upstreamStatus, { 'content-type': 'application/json' })
          res.end(upstreamBody)
        }, upstreamDelay)
      })
    })
    await new Promise<void>(resolve => {
      upstream.listen(0, '127.0.0.1', resolve)
    })
    const port = (upstream.address() as AddressInfo).port
    stub = new JevStub({ upstream: `http://127.0.0.1:${port}/` })
    places = await startPlacesStub('127.0.0.1', undefined, 0, stub)
  })

  afterEach(function () {
    stub.set(asJevControl({}))
    upstreamSeen.length = 0
    upstreamStatus = 200
    upstreamBody = '{"model":"jev-1.13.0","answers":{}}'
    upstreamDelay = 0
  })

  after(async function () {
    places.server.closeAllConnections()
    places.server.close()
    upstream.closeAllConnections()
    upstream.close()
  })

  const post = async (
    body: unknown,
    init: RequestInit = {}
  ): Promise<{ status: number; body: any }> => {
    const reply = await fetch(`${places.url}${JEV_PATH}`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer placeholder-key',
        'content-type': 'application/json'
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...init
    })
    const text = await reply.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
    return { status: reply.status, body: parsed }
  }

  it('answers every noul from the script, and keeps what it was asked', async function () {
    stub.set(
      asJevControl({ rule: { nouls: { 'Hawks Gold': 0.9 }, defaultNoul: 0.2 } })
    )
    const reply = await post(systemOne('hawk', ['Hawks Blue', 'Hawks Gold']))
    expect(reply.status).equals(200)
    expect(reply.body.model).equals(JEV_STUB_MODEL)
    expect(reply.body.answers).deep.equals({
      c1: { type: 'noul', noul: 0.2 },
      c2: { type: 'noul', noul: 0.9 }
    })
    expect(reply.body.usage.output_tokens).equals(2)
    const [seen] = stub.view().requests
    expect(seen).to.include({
      query: 'hawk',
      candidates: 2,
      status: 200,
      model: JEV_STUB_MODEL,
      aborted: false,
      passedThrough: false
    })
    expect(JSON.stringify(stub.view())).not.includes('placeholder-key')
    // Places still answers beside it.
    expect((await fetch(`${places.url}/nowhere`)).status).equals(404)
  })

  it('fails with a status, and lets one query’s rule override the general one', async function () {
    stub.set(
      asJevControl({
        rule: { status: 529 },
        queries: { 'hawk gold': { status: 200, defaultNoul: 0.4 } }
      })
    )
    expect((await post(systemOne('hawk', ['A']))).status).equals(529)
    const gold = await post(systemOne('hawk gold', ['A']))
    expect(gold.status).equals(200)
    expect(gold.body.answers.c1.noul).equals(0.4)
    expect(stub.view().requests.map(row => row.status)).deep.equals([529, 200])
  })

  it('refuses a body with no questions, a body that is not JSON, and a GET', async function () {
    expect((await post({ state: { query: 'x' } })).status).equals(400)
    expect((await post('{not json')).status).equals(400)
    const got = await fetch(`${places.url}${JEV_PATH}`)
    expect(got.status).equals(405)
    expect(stub.view().requests.map(row => row.status)).deep.equals([400, 400])
  })

  it('waits before answering, and records a caller that gave up first', async function () {
    stub.set(asJevControl({ queries: { slow: { delayMs: 300 } } }))
    const started = Date.now()
    expect((await post(systemOne('slow', ['A']))).status).equals(200)
    expect(Date.now() - started).greaterThanOrEqual(250)
    const abort = new AbortController()
    const gaveUp = post(systemOne('slow', ['A']), {
      signal: abort.signal
    }).catch(() => 'gave up')
    await wait(50)
    abort.abort()
    expect(await gaveUp).equals('gave up')
    await wait(50)
    const rows = stub.view().requests
    expect(rows.map(row => [row.status, row.aborted])).deep.equals([
      [200, false],
      [0, true]
    ])
  })

  it('passes a request through to TypeSafe with its own Authorization, and reads the model', async function () {
    stub.set(asJevControl({ passThrough: true }))
    const body = systemOne('san diego', ['San Diego Hawks'])
    const reply = await post(body)
    expect(reply.status).equals(200)
    expect(reply.body.model).equals('jev-1.13.0')
    expect(upstreamSeen).deep.equals([
      {
        authorization: 'Bearer placeholder-key',
        body: JSON.stringify(body)
      }
    ])
    expect(stub.view().requests[0]).to.include({
      query: 'san diego',
      status: 200,
      model: 'jev-1.13.0',
      passedThrough: true
    })
    // TypeSafe's refusal comes back as it is, with no model to read.
    upstreamStatus = 401
    upstreamBody = 'unauthorized'
    const refused = await post(body, {
      headers: { 'content-type': 'application/json' }
    })
    expect(refused.status).equals(401)
    expect(upstreamSeen[1].authorization).equals(undefined)
    expect(stub.view().requests[1].model).equals(undefined)
  })

  it('answers 502 when TypeSafe cannot be reached, and stops asking when the caller gives up', async function () {
    const down = new JevStub({
      upstream: 'http://127.0.0.1:1',
      fetchFn: async () => {
        throw new Error('connection refused')
      }
    })
    down.set(asJevControl({ passThrough: true }))
    const server = await startPlacesStub('127.0.0.1', undefined, 0, down)
    try {
      const reply = await fetch(`${server.url}${JEV_PATH}`, {
        method: 'POST',
        body: '{}'
      })
      expect(reply.status).equals(502)
      expect(await reply.text()).includes('connection refused')
      expect(down.view().requests[0]).to.include({
        status: 502,
        aborted: false
      })
    } finally {
      server.server.close()
    }
    stub.set(asJevControl({ passThrough: true }))
    upstreamDelay = 400
    const abort = new AbortController()
    const gaveUp = post(systemOne('slow', ['A']), {
      signal: abort.signal
    }).catch(() => 'gave up')
    await wait(100)
    abort.abort()
    expect(await gaveUp).equals('gave up')
    await wait(50)
    expect(stub.view().requests[0]).to.include({ status: 0, aborted: true })
  })

  it('refuses a body too large to be a search, and keeps only the latest requests', async function () {
    const big = 'x'.repeat((1 << 20) + 10)
    const reply = await fetch(`${places.url}${JEV_PATH}`, {
      method: 'POST',
      body: big
    }).then(
      response => response.status,
      () => 'closed'
    )
    expect([413, 'closed']).includes(reply)
    let now = 0
    const counted = new JevStub({ now: () => now++ })
    const server = await startPlacesStub('127.0.0.1', undefined, 0, counted)
    try {
      for (let i = 0; i < JEV_REQUESTS_KEPT + 5; i++) {
        await fetch(`${server.url}${JEV_PATH}`, { method: 'POST', body: '{}' })
      }
      expect(counted.view().requests).length(JEV_REQUESTS_KEPT)
    } finally {
      server.server.close()
    }
  })
})
