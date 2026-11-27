import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { stackDatabase } from './database'
import { PagesStandIn } from './pages'
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

describe('the fault server’s pages stand-in', function () {
  let api: Server
  let started: Awaited<ReturnType<typeof startFaultServer>>
  let base: string
  let apiHits = 0

  before(async function () {
    api = createServer((_req, res) => {
      apiHits += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    const apiPort = await listen(api)
    started = await startFaultServer({
      listen: { host: '127.0.0.1', port: 0 },
      target: `http://127.0.0.1:${apiPort}`,
      token: TOKEN
    })
    base = started.proxy.url
  })

  after(async function () {
    await started.close()
    api.close()
  })

  const page = async (
    path: string,
    init: { method?: string; signal?: AbortSignal } = {}
  ): Promise<Response> =>
    await fetch(`${base}${path}`, {
      ...init,
      headers: { 'x-e2e-site': 'pages' }
    })

  const script = async (body: unknown, token = TOKEN): Promise<Response> =>
    await fetch(`${base}/__e2e/pages`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })

  const requests = async (since: number): Promise<any[]> =>
    (
      await (
        await fetch(`${base}/__e2e/pages/requests?since=${since}`, {
          headers: { authorization: `Bearer ${TOKEN}` }
        })
      ).json()
    ).requests

  it('answers any path with a page that prints its address, never the API', async function () {
    const before = apiHits
    const reply = await page('/somewhere/else?x=1')
    expect(reply.status).equals(200)
    expect(reply.headers.get('content-type')).contains('text/html')
    const text = await reply.text()
    expect(text).contains('<title>Chat link destination</title>')
    expect(text).contains('location.pathname + location.search + location.hash')
    expect(apiHits).equals(before)
    // Without the site's mark the same path goes to the API as before.
    await fetch(`${base}/somewhere/else`)
    expect(apiHits).equals(before + 1)
  })

  it('serves a scripted path with its type, body and headers', async function () {
    const put = await script({
      '/shared': {
        type: 'text/html',
        body: '<title>Shared page</title>',
        headers: { 'access-control-allow-origin': '*' }
      },
      '/closed': { body: '<title>Closed page</title>' },
      '/card.png': {
        type: 'image/png',
        body: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
        encoding: 'base64'
      }
    })
    expect(put.status).equals(200)
    expect((await put.json()).paths).deep.equals([
      '/card.png',
      '/closed',
      '/shared'
    ])
    const card = await page('/card.png')
    expect([...new Uint8Array(await card.arrayBuffer())]).deep.equals([
      0x89, 0x50, 0x4e, 0x47
    ])
    const shared = await page('/shared')
    expect(await shared.text()).equals('<title>Shared page</title>')
    expect(shared.headers.get('access-control-allow-origin')).equals('*')
    const closed = await page('/closed')
    expect(await closed.text()).equals('<title>Closed page</title>')
    expect(closed.headers.get('access-control-allow-origin')).equals(null)
    expect(closed.headers.get('content-type')).contains('text/html')
    const listed = await fetch(`${base}/__e2e/pages`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect((await listed.json()).paths).deep.equals([
      '/card.png',
      '/closed',
      '/shared'
    ])
  })

  it('logs every request it served, since a time', async function () {
    await new Promise(resolve => setTimeout(resolve, 5))
    const since = Date.now()
    await page('/logged?probe=one')
    await page('/logged', { method: 'HEAD' })
    const rows = await requests(since)
    expect(rows.map(row => [row.method, row.path, row.query])).deep.equals([
      ['GET', '/logged', '?probe=one'],
      ['HEAD', '/logged', '']
    ])
    expect(rows[0].probe).equals('one')
    expect(await requests(Date.now() + 60_000)).deep.equals([])
  })

  it('holds a probe page, and answers its HEAD 204 only while the GET is held', async function () {
    await script({
      '/pending': { body: '<title>Delayed</title>', holdMs: 400, probe: true }
    })
    const probe = '/pending?probe=p1'
    expect((await page(probe, { method: 'HEAD' })).status).equals(404)
    const started = Date.now()
    const held = page(probe)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect((await page(probe, { method: 'HEAD' })).status).equals(204)
    expect(
      (await page('/pending?probe=other', { method: 'HEAD' })).status
    ).equals(404)
    // A second GET of a probe that is already held is refused.
    expect((await page(probe)).status).equals(429)
    const reply = await held
    expect(Date.now() - started).at.least(350)
    expect(await reply.text()).equals('<title>Delayed</title>')
    expect((await page(probe, { method: 'HEAD' })).status).equals(404)
  })

  it('frees a probe when its client closes the held GET', async function () {
    await script({
      '/pending': { body: 'late', holdMs: 5000, probe: true }
    })
    const abort = new AbortController()
    const held = page('/pending?probe=p2', { signal: abort.signal }).catch(
      (error: unknown) => error
    )
    await new Promise(resolve => setTimeout(resolve, 100))
    expect((await page('/pending?probe=p2', { method: 'HEAD' })).status).equals(
      204
    )
    abort.abort()
    await held
    await new Promise(resolve => setTimeout(resolve, 100))
    expect((await page('/pending?probe=p2', { method: 'HEAD' })).status).equals(
      404
    )
    // A held page without its probe, or another method, is refused.
    expect((await page('/pending')).status).equals(429)
    expect((await page('/pending', { method: 'POST' })).status).equals(405)
  })

  it('holds a page with no probe, and refuses a script it cannot follow', async function () {
    await script({ '/slow': { body: 'slow', holdMs: 150 } })
    const at = Date.now()
    expect(await (await page('/slow')).text()).equals('slow')
    expect(Date.now() - at).at.least(120)
    for (const bad of [
      [],
      { nope: { body: 'x' } },
      { '/a': null },
      { '/a': {} },
      { '/a': { body: 'x', type: 1 } },
      { '/a': { body: 'x', headers: { a: 1 } } },
      { '/a': { body: 'x', holdMs: -1 } },
      { '/a': { body: 'x', probe: 'yes' } },
      { '/a': { body: 'x', encoding: 'hex' } }
    ]) {
      expect((await script(bad)).status, JSON.stringify(bad)).equals(400)
    }
    expect((await script('not json')).status).equals(400)
    expect((await script({}, 'b'.repeat(64))).status).equals(401)
  })
})

describe('a fault server with no pages stand-in', function () {
  it('answers its pages routes 404', async function () {
    const { controlRoutes } = await import('./server')
    const route = controlRoutes(() => {
      throw new Error('unused')
    }, TOKEN)
    const req = Object.assign(new PassThrough(), {
      url: '/__e2e/pages',
      method: 'GET',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    let status = 0
    const res = {
      writeHead: (code: number) => {
        status = code
      },
      end: () => undefined
    }
    expect(route(req as never, res as never)).equals(true)
    expect(status).equals(404)
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
  it('gives the media work the checkout’s broadcaster actions', async function () {
    const checkout = mkdtempSync(join(tmpdir(), 'e2e-faults-checkout-'))
    const file = join(checkout, 'token')
    writeFileSync(file, `${TOKEN}\n`)
    writeFileSync(
      join(checkout, 'serverConfig.json'),
      JSON.stringify({
        mediaDir: join(checkout, 'media'),
        live: { port: 1936 }
      })
    )
    const { remux } = parseFaultServerArgs(
      [
        ...['--listen', '127.0.0.1:9200', '--target', 'http://127.0.0.1:9100'],
        ...['--token-file', file, '--checkout', checkout]
      ],
      {}
    )
    const act = remux!(new PagesStandIn())
    expect(await act({ action: 'ingest-files', videoId: 'vid_1' })).deep.equals(
      { live: { port: 1936 }, names: [], master: '' }
    )
  })

  it('reads its options and the token from its file', function () {
    const file = join(mkdtempSync(join(tmpdir(), 'e2e-faults-')), 'token')
    writeFileSync(file, `${TOKEN}\n`)
    const { remux, ...parsed } = parseFaultServerArgs(
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
    expect(typeof remux).equals('function')
    expect(parsed).deep.equals({
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
    expect(parseFaultServerArgs(args, {}).database).equals(undefined)
    const withDb = parseFaultServerArgs([...args, '--checkout', '/srv/c'], {
      DATABASE_URL: 'postgres://x/y'
    })
    expect(typeof withDb.seed).equals('function')
    expect(typeof withDb.database?.query).equals('function')
  })
})

describe('the fault server’s database routes', function () {
  const ran: Array<[string, unknown[]]> = []
  let started: Awaited<ReturnType<typeof startFaultServer>>
  let bare: Awaited<ReturnType<typeof startFaultServer>>
  let closed = 0
  const database = stackDatabase('postgres://stack/db', url => {
    expect(url).equals('postgres://stack/db')
    return {
      query: (async (text: string, values: unknown[]) => {
        ran.push([text, values])
        if (text === 'broken') throw new Error('syntax error')
        return {
          rows: text.startsWith('SELECT') ? [{ n: 1 }] : [],
          rowCount: text.startsWith('DELETE') ? 2 : 1
        }
      }) as never,
      end: async () => {
        closed += 1
      }
    }
  })

  before(async function () {
    started = await startFaultServer({
      listen: { host: '127.0.0.1', port: 0 },
      target: 'http://127.0.0.1:1',
      token: TOKEN,
      database
    })
    bare = await startFaultServer({
      listen: { host: '127.0.0.1', port: 0 },
      target: 'http://127.0.0.1:1',
      token: TOKEN
    })
  })

  after(async function () {
    await started.close()
    await bare.close()
  })

  const post = async (
    base: string,
    route: string,
    body: unknown
  ): Promise<{ status: number; body: any }> => {
    const reply = await fetch(`${base}/__e2e/${route}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json'
      },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })
    return { status: reply.status, body: await reply.json() }
  }

  it('runs a statement on the stack’s database and answers its rows', async function () {
    expect(
      await post(started.proxy.url, 'sql', {
        text: 'SELECT 1 AS n WHERE $1 = $1',
        values: ['x']
      })
    ).deep.equals({ status: 200, body: { rows: [{ n: 1 }], rowCount: 1 } })
    expect(ran.at(-1)).deep.equals(['SELECT 1 AS n WHERE $1 = $1', ['x']])
    expect(
      (await post(started.proxy.url, 'sql', { text: 'UPDATE t' })).body
    ).deep.equals({ rows: [], rowCount: 1 })
    expect(ran.at(-1)).deep.equals(['UPDATE t', []])
  })

  it('clears the sign-in limits of a scope and its family', async function () {
    ran.length = 0
    expect(
      await post(started.proxy.url, 'rate-limits', {
        clear: ['password', 'passwordParameters.address']
      })
    ).deep.equals({ status: 200, body: { cleared: 4 } })
    expect(ran).deep.equals([
      [
        'DELETE FROM rate_events WHERE scope = $1 OR left(scope, $2) = $3',
        ['password', 9, 'password.']
      ],
      [
        'DELETE FROM rate_events WHERE scope = $1 OR left(scope, $2) = $3',
        ['passwordParameters.address', 27, 'passwordParameters.address.']
      ]
    ])
    expect(await post(started.proxy.url, 'rate-limits', {})).deep.equals({
      status: 200,
      body: { cleared: 0 }
    })
    ran.length = 0
    expect(
      await post(started.proxy.url, 'rate-limits', { scale: 0.2 })
    ).deep.equals({ status: 200, body: { cleared: 0, scale: 0.2 } })
    expect(ran).has.length(1)
    expect(ran[0][0]).contains('test.rateLimitScale')
    expect(ran[0][1]).deep.equals(['0.2'])
  })

  it('refuses a body it cannot run, and reports a failed statement', async function () {
    for (const body of [{}, { text: ' ' }, { text: 'x', values: 'y' }]) {
      expect((await post(started.proxy.url, 'sql', body)).status).equals(400)
    }
    for (const body of [
      { clear: 'password' },
      { clear: ['bad scope'] },
      { scale: 0 },
      { scale: 'x' }
    ]) {
      expect(
        (await post(started.proxy.url, 'rate-limits', body)).status
      ).equals(400)
    }
    expect(
      await post(started.proxy.url, 'sql', { text: 'broken' })
    ).deep.equals({ status: 500, body: { error: 'syntax error' } })
  })

  it('answers 501 without a database, and closes its pool with the server', async function () {
    expect(
      (await post(bare.proxy.url, 'sql', { text: 'SELECT 1' })).status
    ).equals(501)
    expect(
      (await post(bare.proxy.url, 'rate-limits', { clear: [] })).status
    ).equals(501)
    await database.close()
    expect(closed).equals(1)
    // A query after closing opens a pool again.
    await database.query('SELECT 2', [])
  })
})
