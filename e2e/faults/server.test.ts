import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  fixtureSeeder,
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
      token: TOKEN,
      modelPort: 0,
      speechPort: 0
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

  it('serves the stand-ins behind the token, the beacon to anyone, and delays and logs the API', async function () {
    expect((await control('GET', 'speech', undefined, null)).status).equals(401)
    expect((await control('GET', 'speech')).body).deep.include({ begun: 0 })
    expect((await fetch(`${base}/__tess/beacon`)).status).equals(204)
    expect((await control('GET', 'beacon')).body).deep.equals({ hits: 1 })
    await control('PUT', 'delay', { prefix: '/api/v1/teams', ms: 300 })
    const startedAt = Date.now()
    expect((await fetch(`${base}/api/v1/teams/t1`)).status).equals(200)
    expect(Date.now() - startedAt).greaterThanOrEqual(290)
    await control('PUT', 'delay', null)
    const logged = await control(
      'GET',
      `requests?since=${startedAt}&path=/api/v1/teams`
    )
    expect(
      logged.body.requests.map((row: { path: string }) => row.path)
    ).includes('/api/v1/teams/t1')
    expect(started.standIns?.model.baseUrl).matches(
      /^http:\/\/127\.0\.0\.1:\d+\/v1$/
    )
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
      parseFaultServerArgs(
        [
          '--listen',
          '127.0.0.1:9200',
          '--target',
          'http://127.0.0.1:9100',
          '--places',
          '127.0.0.1:9300',
          '--token-file',
          file
        ],
        {}
      )
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

describe('the fault server’s seed route', function () {
  const seeded: string[] = []
  let started: Awaited<ReturnType<typeof startFaultServer>>
  before(async function () {
    started = await startFaultServer({
      listen: { host: '127.0.0.1', port: 0 },
      target: 'http://127.0.0.1:1',
      token: TOKEN,
      seed: async (world, mailbox) => {
        seeded.push(`${world} ${mailbox}`)
        if (world === 'broken') throw new Error('the world failed')
        return { world, nonce: 'n', accounts: {}, ids: {} }
      }
    })
  })
  after(async function () {
    await started.close()
  })
  const seed = async (
    body: unknown,
    token: string | null = TOKEN
  ): Promise<{ status: number; body: any }> => {
    const reply = await fetch(`${started.proxy.url}/__e2e/seed`, {
      method: 'POST',
      headers: {
        ...(token == null ? {} : { authorization: `Bearer ${token}` }),
        'content-type': 'application/json'
      },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })
    return { status: reply.status, body: await reply.json() }
  }

  it('seeds the world on the mailbox and answers its manifest', async function () {
    const reply = await seed({
      world: 'coach-game',
      mailbox: 'e2e@example.test'
    })
    expect(reply.status).equals(200)
    expect(reply.body.world).equals('coach-game')
    expect(seeded).deep.equals(['coach-game e2e@example.test'])
  })

  it('refuses a request without the token, and a bad world or mailbox', async function () {
    seeded.length = 0
    expect(
      (await seed({ world: 'coach-game', mailbox: 'e2e@example.test' }, null))
        .status
    ).equals(401)
    expect(
      (await seed({ world: '../x', mailbox: 'e2e@example.test' })).status
    ).equals(400)
    expect(
      (await seed({ world: 'w', mailbox: 'e+x@example.test' })).status
    ).equals(400)
    expect((await seed('not json')).status).equals(400)
    expect(seeded).deep.equals([])
    const failed = await seed({ world: 'broken', mailbox: 'e2e@example.test' })
    expect(failed.status).equals(500)
    expect(failed.body.error).equals('the world failed')
  })

  it('answers 501 on a fault server with no database', async function () {
    const bare = await startFaultServer({
      listen: { host: '127.0.0.1', port: 0 },
      target: 'http://127.0.0.1:1',
      token: TOKEN
    })
    try {
      const reply = await fetch(`${bare.proxy.url}/__e2e/seed`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: '{}'
      })
      expect(reply.status).equals(501)
    } finally {
      await bare.close()
    }
  })

  it('runs the fixtures CLI with the world and mailbox against the stack database', async function () {
    const ran: Array<{
      file: string
      args: string[]
      cwd: string
      config: string
    }> = []
    const spawnFn = ((
      file: string,
      args: string[],
      options: { cwd: string }
    ) => {
      ran.push({
        file,
        args,
        cwd: options.cwd,
        config: readFileSync(join(options.cwd, 'serverConfig.json'), 'utf8')
      })
      const child: any = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      setImmediate(() => {
        child.stdout.end(args[3] === 'broken' ? '' : '{"world":"coach-game"}')
        child.stderr.end(args[3] === 'broken' ? 'no such world' : '')
        setImmediate(() => child.emit('close', args[3] === 'broken' ? 1 : 0))
      })
      return child
    }) as any
    const seed = fixtureSeeder(
      '/srv/checkout',
      'postgres://127.0.0.1/ts',
      spawnFn
    )
    expect(await seed('coach-game', 'e2e@example.test')).deep.equals({
      world: 'coach-game'
    })
    expect(ran[0].file).equals(process.execPath)
    expect(ran[0].args).deep.equals([
      '-r',
      '/srv/checkout/node_modules/sucrase/register',
      '/srv/checkout/src/server/dev/fixtures/cli.ts',
      'coach-game',
      '--json',
      '--mailbox',
      'e2e@example.test'
    ])
    expect(JSON.parse(ran[0].config)).deep.equals({
      testSettings: true,
      databaseUrl: 'postgres://127.0.0.1/ts'
    })
    // The config names the database's password: gone once the seed is.
    expect(existsSync(ran[0].cwd)).equals(false)
    let message = ''
    try {
      await seed('broken', 'e2e@example.test')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).contains('no such world')
  })

  it('gives the seed route a seeder only when DATABASE_URL is set', function () {
    const file = join(mkdtempSync(join(tmpdir(), 'e2e-faults-')), 'token')
    writeFileSync(file, TOKEN)
    const args = [
      '--listen',
      '127.0.0.1:1',
      '--target',
      'http://x',
      '--token-file',
      file
    ]
    expect(parseFaultServerArgs(args, {}).seed).equals(undefined)
    expect(
      typeof parseFaultServerArgs([...args, '--checkout', '/srv/c'], {
        DATABASE_URL: 'postgres://x/y'
      }).seed
    ).equals('function')
  })
})
