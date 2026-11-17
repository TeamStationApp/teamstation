import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  hostPort,
  parseFaultServerArgs,
  PROXY_FAULTS,
  startFaultServer
} from './server'

const TOKEN = 'a'.repeat(64)

async function listen(server: Server): Promise<number> {
  return await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
}

describe('the fault server', function () {
  let api: Server
  let started: Awaited<ReturnType<typeof startFaultServer>>
  let base: string

  before(async function () {
    api = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"teams":[]}')
    })
    const apiPort = await listen(api)
    started = await startFaultServer({
      listen: { host: '127.0.0.1', port: 0 },
      target: `http://127.0.0.1:${apiPort}`,
      places: { host: '127.0.0.1', port: 0 },
      token: TOKEN
    })
    base = started.proxy.url
  })

  after(async function () {
    await started.close()
    api.close()
  })

  const control = async (
    method: string,
    route: string,
    body?: unknown,
    token: string | null = TOKEN
  ): Promise<{ status: number; body: any }> => {
    const reply = await fetch(`${base}/__e2e/${route}`, {
      method,
      headers: {
        ...(token == null ? {} : { authorization: `Bearer ${token}` }),
        'content-type': 'application/json'
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) })
    })
    return { status: reply.status, body: await reply.json() }
  }

  it('answers its health with no token, and nothing else without the right one', async function () {
    expect((await control('GET', 'health', undefined, null)).status).equals(200)
    expect((await control('GET', 'fault', undefined, null)).status).equals(401)
    expect(
      (await control('GET', 'fault', undefined, 'b'.repeat(64))).status
    ).equals(401)
    expect((await control('GET', 'nowhere')).status).equals(404)
  })

  it('breaks the API while a fault is set, says so, and forwards again once cleared', async function () {
    const since = Date.now()
    expect(
      (await control('PUT', 'fault', { fault: 'api-500' })).body
    ).deep.equals({ fault: 'api-500' })
    expect((await control('GET', 'fault')).body).deep.equals({
      fault: 'api-500'
    })
    expect((await fetch(`${base}/api/v1/teams`)).status).equals(500)
    const errors = (await control('GET', `errors?since=${since}`)).body.errors
    expect(
      errors.map((row: { path: string; status: number }) => [
        row.path,
        row.status
      ])
    ).deep.equals([['/api/v1/teams', 500]])
    expect(
      (await control('GET', `injections?since=${since}`)).body.injections
    ).length(1)
    expect(
      (await control('GET', `errors?since=${Date.now() + 1000}`)).body.errors
    ).deep.equals([])
    expect((await control('PUT', 'fault', { fault: null })).status).equals(200)
    const reply = await fetch(`${base}/api/v1/teams`)
    expect(reply.status).equals(200)
    expect(await reply.json()).deep.equals({ teams: [] })
  })

  it('refuses a fault it cannot apply, and a body that is not JSON', async function () {
    expect(PROXY_FAULTS).includes('api-500').and.not.includes('app-crash')
    expect(
      (await control('PUT', 'fault', { fault: 'app-crash' })).status
    ).equals(400)
    expect((await control('PUT', 'fault', '{not json')).status).equals(400)
    expect((await control('GET', 'fault')).body).deep.equals({ fault: null })
  })

  it('lets go of the requests api-hang held once it is cleared', async function () {
    await control('PUT', 'fault', { fault: 'api-hang' })
    const hung = fetch(`${base}/api/v1/teams`).then(
      reply => reply.status,
      () => 'let go'
    )
    await new Promise(resolve => setTimeout(resolve, 50))
    await control('PUT', 'fault', { fault: null })
    expect(await hung).equals('let go')
  })

  it('serves the Places stand-in beside it', async function () {
    expect(started.placesUrl).matches(/^http:\/\/127\.0\.0\.1:\d+$/)
    const reply = await fetch(`${started.placesUrl}/nowhere`)
    expect(reply.status).equals(404)
  })

  it('scripts the Jev stand-in on the Places listener, behind the token', async function () {
    expect((await control('GET', 'jev', undefined, null)).status).equals(401)
    expect((await control('GET', 'jev')).body).deep.equals({
      passThrough: false,
      rule: {},
      queries: {},
      requests: []
    })
    const set = await control('PUT', 'jev', {
      rule: { nouls: { 'Hawks Gold': 0.9 } }
    })
    expect(set.status).equals(200)
    expect(set.body.rule).deep.equals({ nouls: { 'Hawks Gold': 0.9 } })
    const answered = await fetch(`${started.placesUrl}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        state: { query: 'hawk', candidates: { c1: { name: 'Hawks Gold' } } },
        questions: { c1: { type: 'noul' } }
      })
    })
    expect((await answered.json()).answers.c1.noul).equals(0.9)
    const seen = (await control('GET', 'jev')).body.requests
    expect(seen.map((row: { query: string }) => row.query)).deep.equals([
      'hawk'
    ])
    expect(started.jev?.view().requests).length(1)
    // A new script forgets the requests seen under the last one.
    expect((await control('PUT', 'jev', {})).body.requests).deep.equals([])
  })

  it('refuses a Jev script it cannot follow, and a body that is not JSON', async function () {
    const refused = await control('PUT', 'jev', { rule: { status: 'x' } })
    expect(refused.status).equals(400)
    expect(refused.body.error).includes('status')
    expect((await control('PUT', 'jev', '{not json')).status).equals(400)
    expect((await control('PUT', 'fault', 'null')).status).equals(400)
    expect((await control('DELETE', 'jev')).status).equals(404)
  })
})

describe('a fault server with no Places listener', function () {
  it('has no Jev stand-in to script', async function () {
    const started = await startFaultServer({
      listen: { host: '127.0.0.1', port: 0 },
      target: 'http://127.0.0.1:1',
      token: TOKEN
    })
    try {
      expect(started.jev).equals(undefined)
      const reply = await fetch(`${started.proxy.url}/__e2e/jev`, {
        headers: { authorization: `Bearer ${TOKEN}` }
      })
      expect(reply.status).equals(404)
      expect((await reply.json()).error).includes('no Jev stand-in')
    } finally {
      await started.close()
    }
  })
})

describe('the fault server’s command line', function () {
  it('reads its options and the token from its file', function () {
    const file = join(mkdtempSync(join(tmpdir(), 'e2e-faults-')), 'token')
    writeFileSync(file, `${TOKEN}\n`)
    expect(
      parseFaultServerArgs([
        '--listen',
        '127.0.0.1:9200',
        '--target',
        'http://127.0.0.1:9100',
        '--places',
        '127.0.0.1:9300',
        '--token-file',
        file
      ])
    ).deep.equals({
      listen: { host: '127.0.0.1', port: 9200 },
      target: 'http://127.0.0.1:9100',
      places: { host: '127.0.0.1', port: 9300 },
      token: TOKEN
    })
    expect(() => parseFaultServerArgs(['--listen', '127.0.0.1:9200'])).to.throw(
      '--target is needed'
    )
    expect(() => parseFaultServerArgs(['--bogus', 'x'])).to.throw(
      'unknown or empty option --bogus'
    )
    expect(() => hostPort('9200', '--listen')).to.throw(
      '--listen wants host:port'
    )
    expect(() => hostPort('h:70000', '--listen')).to.throw(
      '--listen wants host:port'
    )
  })

  it('refuses a token too short to guard anything', async function () {
    let failure: unknown
    try {
      await startFaultServer({
        listen: { host: '127.0.0.1', port: 0 },
        target: 'http://127.0.0.1:1',
        token: 'short'
      })
    } catch (error) {
      failure = error
    }
    expect(String(failure)).includes('too short')
  })
})
