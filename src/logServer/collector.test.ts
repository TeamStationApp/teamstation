import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { collector } from './app'
import { envelope } from './envelope'
import { startCollector } from './main'
import {
  indexOf,
  type LogDocument,
  OpenSearch,
  searchQuery,
  searchTransport
} from './openSearch'
import { LogSpool } from './spool'

const row = (): LogDocument => ({
  D: new Date().toISOString(),
  A: 'TS',
  I: randomUUID(),
  E: 'service_started',
  L: 'info',
  R: 1,
  P: {},
  N: 'test',
  T: new Date().toISOString()
})
const wire = (document: LogDocument): string => {
  const { N, T, ...event } = document
  return JSON.stringify(event) + '\n'
}
const tick = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 25))
}

describe('collector durable HTTP and provider boundary', function () {
  this.timeout(30000)
  let root: string, provider: https.Server, url: string, ca: string
  const stored = new Map<string, unknown>()
  const requests: Array<{ method: string; path: string; body: any }> = []
  let transient = false
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'observability-'))
    const key = join(root, 'key.pem')
    const cert = join(root, 'cert.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost'
      ],
      { stdio: 'ignore' }
    )
    ca = await readFile(cert, 'utf8')
    provider = https.createServer(
      { key: await readFile(key), cert: ca },
      (req, res) => {
        ;(async () => {
          const buffers: Buffer[] = []
          for await (const buffer of req) buffers.push(buffer)
          const raw = Buffer.concat(buffers).toString('utf8')
          const body =
            req.url === '/_bulk'
              ? raw
              : raw !== ''
                ? JSON.parse(raw)
                : undefined
          requests.push({ method: req.method!, path: req.url!, body })
          if (req.url === '/bad') {
            res.end('bad')
            return
          }
          if (req.url === '/large') {
            res.end('x'.repeat(2 * 1024 * 1024 + 1))
            return
          }
          if (req.url === '/fail') {
            res.writeHead(503).end('{}')
            return
          }
          if (req.url === '/broken') {
            res.writeHead(200)
            res.write('{')
            setImmediate(() => res.destroy())
            return
          }
          if (req.url === '/_bulk') {
            const lines = raw
              .trim()
              .split('\n')
              .map(line => JSON.parse(line))
            const items = []
            for (let i = 0; i < lines.length; i += 2) {
              const status = transient && i === 0 ? 429 : 201
              if (status === 201) stored.set(lines[i].index._id, lines[i + 1])
              items.push({ index: { status } })
            }
            res.end(JSON.stringify({ items }))
            return
          }
          if (req.url?.endsWith('/_search') === true) {
            res.end(
              JSON.stringify({
                hits: {
                  hits: [...stored.values()].map(_source => ({ _source }))
                }
              })
            )
            return
          }
          res.end('{}')
        })().catch(() => res.destroy())
      }
    )
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    url = `https://localhost:${(provider.address() as AddressInfo).port}`
  })
  after(async () => {
    await new Promise<void>(resolve =>
      provider.close(() => {
        resolve()
      })
    )
    await rm(root, { recursive: true, force: true })
  })
  const search = (): OpenSearch =>
    new OpenSearch(
      searchTransport({ url, username: 'fixture', password: 'unused', ca })
    )

  it('validates TLS, response caps, per-item statuses, mapping and query surface', async () => {
    const transport = searchTransport({
      url,
      username: 'fixture',
      password: 'unused',
      ca
    })
    for (const path of ['/bad', '/large', '/fail', '/broken']) {
      let failed = false
      try {
        await transport('GET', path)
      } catch {
        failed = true
      }
      expect(failed, path).equals(true)
    }
    for (const bad of [
      'http://example.test',
      'https://name:secret@example.test',
      'https://example.test/path',
      'https://example.test/?x',
      'https://example.test/#x'
    ])
      expect(() =>
        searchTransport({ url: bad, username: '', password: '' })
      ).throws()
    let tlsFailed = false
    try {
      await searchTransport({ url, username: '', password: '' })('GET', '/')
    } catch {
      tlsFailed = true
    }
    expect(tlsFailed).equals(true)
    const sink = search()
    await sink.setup()
    const template = requests.find(
      r => r.path === '/_index_template/logs-v1'
    )!.body
    expect(template.template.mappings.dynamic).equals('strict')
    expect(template.template.mappings.properties.U.type).equals('keyword')
    const update = requests.find(r =>
      r.path.startsWith('/logs-v1-*/_mapping')
    )!.body
    expect(update.properties.P.properties.c0).deep.equals({ type: 'double' })
    expect(update.properties.U.type).equals('keyword')
    expect(update.properties.P.properties).deep.equals(
      template.template.mappings.properties.P.properties
    )
    expect(template.template.settings).deep.equals({
      number_of_shards: 1,
      number_of_replicas: 0
    })
    let created = false
    await new OpenSearch(async (method, path) => {
      if (method === 'GET') throw Error()
      created = path.includes('retention') || created
      return {}
    }).setup()
    expect(created).equals(true)
    const rows = Array.from({ length: 7 }, row)
    const statuses = [201, 400, 408, 429, 500, undefined, 503]
    const outcomes = await new OpenSearch(async () => ({
      items: statuses.map(status => ({ index: { status } }))
    })).bulk(rows)
    expect(outcomes).deep.equals([
      'done',
      'drop',
      'retry',
      'retry',
      'retry',
      'retry',
      'retry'
    ])
    for (const invalid of [{}, { items: [] }]) {
      let rejected = false
      try {
        await new OpenSearch(async () => invalid).bulk([row()])
      } catch {
        rejected = true
      }
      expect(rejected).equals(true)
    }
    expect(indexOf(row())).matches(/^logs-v1-test-/)
    const query = {
      environment: 'test',
      from: '2026-01-01',
      to: '2026-01-31',
      app: 'TS',
      event: 'app_error',
      level: 'error',
      session: randomUUID(),
      user: '42',
      groupBy: 'P.ec',
      limit: 1000
    }
    expect(searchQuery(query).prefix).equals('logs-v1-test-*')
    expect(JSON.stringify(searchQuery(query).body)).includes('"U":"42"')
    expect(
      JSON.stringify(searchQuery({ ...query, groupBy: 'U' }).body)
    ).includes('"field":"U"')
    await sink.search(query)
    for (const invalid of [
      null,
      [],
      {},
      { ...query, other: 1 },
      { ...query, environment: '*' },
      { ...query, from: 'bad' },
      { ...query, to: '2027-01-01' },
      { ...query, to: '2025-01-01' },
      { ...query, app: 'unknown' },
      { ...query, level: 'invalid' },
      { ...query, event: {} },
      { ...query, event: 'x'.repeat(101) },
      { ...query, event: '*' },
      { ...query, user: 'private-name' },
      { ...query, limit: -1 },
      { ...query, limit: 1001 },
      { ...query, limit: 1.5 },
      { ...query, groupBy: 'script' }
    ])
      expect(() => searchQuery(invalid)).throws()
    expect(
      searchQuery({ environment: 'test', from: '2026-01-01', to: '2026-01-02' })
    ).has.property('body')
  })

  it('durably acknowledges, restores, bounds and retries only unfinished bulk items', async () => {
    const file = join(root, 'spool', 'events.json')
    let now = Date.now()
    const sink = search()
    const spool = new LogSpool(file, sink, () => now)
    await spool.ready
    const first = row()
    const second = row()
    await spool.append([first, second, first])
    expect(spool.status().pending).equals(2)
    const restored = new LogSpool(file, sink, () => now)
    await restored.ready
    transient = true
    await restored.flush()
    await restored.flush()
    expect(restored.status().pending).equals(1)
    transient = false
    now += 61000
    await restored.flush()
    expect(restored.status().pending).equals(0)
    expect(restored.status().lastSuccess).is.a('string')
    const tiny = new LogSpool(join(root, 'tiny'), sink, Date.now, 2)
    await tiny.ready
    let failed = false
    try {
      await tiny.append([row()])
    } catch {
      failed = true
    }
    expect(failed).equals(true)
    for (const value of [
      'bad',
      JSON.stringify({}),
      JSON.stringify([{ ...row(), T: 'bad' }]),
      JSON.stringify([{ ...row(), N: '*' }])
    ]) {
      await writeFile(join(root, 'corrupt'), value)
      const bad = new LogSpool(join(root, 'corrupt'), sink)
      let failed = false
      try {
        await bad.ready
      } catch {
        failed = true
      }
      expect(failed).equals(true)
      expect(bad.status().healthy).equals(false)
    }
    await writeFile(join(root, 'oversized'), 'xxx')
    let failedSize = false
    try {
      await new LogSpool(join(root, 'oversized'), sink, Date.now, 2).ready
    } catch {
      failedSize = true
    }
    expect(failedSize).equals(true)
    const doomed = join(root, 'doomed')
    const bad = new LogSpool(doomed, sink)
    await bad.ready
    await mkdir(doomed)
    let failedWrite = false
    try {
      await bad.append([row()])
    } catch {
      failedWrite = true
    }
    expect(failedWrite).equals(true)
    expect(bad.status().healthy).equals(false)
    const refused = new LogSpool(join(root, 'refused'), {
      bulk: async () => ['drop']
    })
    await refused.append([row()])
    await refused.flush()
    expect(refused.status().dropped).equals(1)
    let release!: (value: Array<'done'>) => void
    const racing = new LogSpool(join(root, 'racing'), {
      bulk: async () =>
        await new Promise(resolve => {
          release = resolve
        })
    })
    await racing.append([row()])
    const flight = racing.flush()
    await tick()
    await racing.flush()
    await racing.append([row()])
    release(['done'])
    await flight
    expect(racing.status().pending).equals(1)
    const outage = new LogSpool(join(root, 'outage'), {
      bulk: async () => {
        throw Error()
      }
    })
    await outage.append([row()])
    await outage.flush()
    expect(outage.status().pending).equals(1)
  })

  it('serves authenticated search and CORS-safe bounded ingestion without exposing payloads', async () => {
    const spool = new LogSpool(join(root, 'http'), search())
    await spool.ready
    const token = '0'.repeat(64)
    const config = {
      origins: ['https://web.example.test'],
      readToken: token,
      projects: { demo: { app: 'TS web' as const, environment: 'test' } }
    }
    for (const bad of [
      { ...config, readToken: 'short' },
      { ...config, serverWriteToken: 'short' },
      { ...config, origins: ['https://web.example.test/path'] },
      {
        ...config,
        projects: { '*': { app: 'TS' as const, environment: 'test' } }
      },
      {
        ...config,
        projects: { demo: { app: 'TS' as const, environment: '*' } }
      }
    ])
      expect(() => collector(bad, spool, search())).throws()
    const app = collector(config, spool, search())
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const post = async (
      path: string,
      body: string,
      headers: Record<string, string> = {}
    ): Promise<Response> =>
      await fetch(origin + path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson', ...headers },
        body
      })
    try {
      expect((await fetch(origin + '/health')).status).equals(200)
      expect(
        (await post('/search', '{}', { 'content-type': 'application/json' }))
          .status
      ).equals(401)
      const request = {
        environment: 'test',
        from: new Date(Date.now() - 1000).toISOString(),
        to: new Date().toISOString()
      }
      const result = await post('/search', JSON.stringify(request), {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        origin: config.origins[0]
      })
      expect(result.status).equals(200)
      expect(result.headers.has('access-control-allow-origin')).equals(false)
      for (const [method, headers, status] of [
        ['POST', 'content-type', 204],
        ['GET', 'content-type', 405],
        ['POST', 'authorization', 403]
      ] as const) {
        const response = await fetch(origin + '/ingest/demo', {
          method: 'OPTIONS',
          headers: {
            origin: config.origins[0],
            'access-control-request-method': method,
            'access-control-request-headers': headers
          }
        })
        expect(response.status).equals(status)
        expect(response.headers.get('access-control-allow-origin')).equals(
          config.origins[0]
        )
      }
      expect(
        (
          await post('/ingest/demo', wire(row()), {
            origin: 'https://bad.example.test'
          })
        ).status
      ).equals(403)
      expect((await post('/ingest/missing', wire(row()))).status).equals(404)
      expect((await post('/ingest/__proto__', wire(row()))).status).equals(404)
      const accepted = await post('/ingest/demo', wire(row()), {
        origin: config.origins[0]
      })
      expect(accepted.status).equals(202)
      expect(accepted.headers.get('access-control-allow-origin')).equals(
        config.origins[0]
      )
      const rejected = await post('/ingest/demo', 'chat-secret-canary', {
        origin: config.origins[0]
      })
      expect(rejected.status).equals(400)
      expect(rejected.headers.get('access-control-allow-origin')).equals(
        config.origins[0]
      )
      expect((await post('/ingest/demo', 'x'.repeat(262145))).status).equals(
        413
      )
      const crash = {
        event_id: '00000000000000000000000000000001',
        timestamp: Date.now() / 1000,
        level: 'fatal',
        exception: { values: [{ type: 'Error', value: 'chat-secret-canary' }] }
      }
      expect(
        (
          await post(
            '/api/demo/envelope',
            '{}\n{"type":"event"}\n' + JSON.stringify(crash)
          )
        ).status
      ).equals(200)
      expect(await readFile(join(root, 'http'), 'utf8')).not.contains(
        'chat-secret-canary'
      )
      expect(
        (
          JSON.parse(
            await readFile(join(root, 'http'), 'utf8')
          ) as LogDocument[]
        ).every(r => r.A === 'TS web')
      ).equals(true)
      for (let i = 0; i < 125; i++) await post('/ingest/demo', 'bad')
      const limited = await post('/ingest/demo', 'bad', {
        origin: config.origins[0]
      })
      expect(limited.status).equals(429)
      expect(limited.headers.get('access-control-allow-origin')).equals(
        config.origins[0]
      )
    } finally {
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        })
      )
    }
    const full = new LogSpool(join(root, 'full'), search(), Date.now, 2)
    await full.ready
    const failureApp = collector(config, full, {
      search: async () => {
        throw Error()
      }
    })
    const failure = failureApp.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => failure.once('listening', resolve))
    try {
      const base = `http://127.0.0.1:${(failure.address() as AddressInfo).port}`
      const response = await fetch(base + '/ingest/demo', {
        method: 'POST',
        headers: { origin: config.origins[0] },
        body: wire(row())
      })
      expect(response.status).equals(503)
      expect(response.headers.get('access-control-allow-origin')).equals(
        config.origins[0]
      )
      expect(
        (
          await fetch(base + '/search', {
            method: 'POST',
            headers: {
              authorization: 'Bearer ' + token,
              'content-type': 'application/json'
            },
            body: '{}'
          })
        ).status
      ).equals(400)
    } finally {
      await new Promise<void>(resolve =>
        failure.close(() => {
          resolve()
        })
      )
    }
  })

  it('admits operational actors only from authenticated server ingestion and preserves them through restart', async () => {
    const file = join(root, 'trusted-actors')
    const spool = new LogSpool(file, search())
    const token = 'fixture-server-write'.repeat(3)
    const config = {
      origins: [],
      readToken: '0'.repeat(64),
      serverWriteToken: token,
      projects: {
        server: { app: 'TS srv' as const, environment: 'test' },
        client: { app: 'TS' as const, environment: 'test' }
      }
    }
    const app = collector(config, spool, search())
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const document = { ...row(), A: 'TS srv' as const, U: 'usr_demo' }
    const post = async (project: string, secret?: string): Promise<Response> =>
      await fetch(base + '/ingest/' + project, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-ndjson',
          ...(secret == null ? {} : { authorization: 'Bearer ' + secret })
        },
        body: wire(document)
      })
    try {
      expect((await post('server')).status).equals(403)
      expect((await post('server', 'x'.repeat(token.length))).status).equals(
        403
      )
      expect((await post('client', token)).status).equals(403)
      expect((await post('server', token)).status).equals(202)
      const persisted = await readFile(file, 'utf8')
      expect(persisted).not.contains(token)
      expect(JSON.parse(persisted)[0].U).equals('usr_demo')
      const restored = new LogSpool(file, search())
      await restored.ready
      await restored.flush()
      expect((stored.get(document.I) as LogDocument).U).equals('usr_demo')
      const withoutToken = collector(
        { ...config, serverWriteToken: undefined },
        spool,
        search()
      ).listen(0, '127.0.0.1')
      await new Promise<void>(resolve =>
        withoutToken.once('listening', resolve)
      )
      try {
        const response = await fetch(
          `http://127.0.0.1:${(withoutToken.address() as AddressInfo).port}/ingest/server`,
          { method: 'POST', body: wire(document) }
        )
        expect(response.status).equals(403)
      } finally {
        await new Promise<void>(resolve =>
          withoutToken.close(() => {
            resolve()
          })
        )
      }
    } finally {
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        })
      )
    }
  })

  it('parses SDK byte lengths and rejects malformed/unsupported items', () => {
    const raw = {
      event_id: randomUUID().replaceAll('-', ''),
      timestamp: Date.now() / 1000,
      message: '漢字',
      exception: { values: [{ type: 'TypeError', value: 'secret' }] }
    }
    const text = JSON.stringify(raw)
    for (const header of [
      { type: 'event' },
      { type: 'event', length: Buffer.byteLength(text) }
    ]) {
      const buffer = Buffer.from(
        '{}\n' +
          JSON.stringify(header) +
          '\n' +
          text +
          '\n' +
          JSON.stringify(header) +
          '\n' +
          text
      )
      expect(envelope(buffer, 'cam')).length(2)
    }
    for (const text of [
      '',
      '{}',
      '[]\n',
      '{}\n',
      '{}\n{"type":"attachment"}\nsecret',
      '{}\n{"type":"event","length":0}\n{}',
      '{}\n{"type":"event","length":999}\n{}',
      '{}\n{"type":"event","length":2}\n{}x',
      'x'.repeat(262145),
      '{}\n{"type":"event"}\nbad'
    ])
      expect(() => envelope(Buffer.from(text), 'TS')).throws()
    expect(() =>
      envelope(
        Buffer.from('{}\n' + ('{"type":"event"}\n' + text + '\n').repeat(51)),
        'TS'
      )
    ).throws()
  })

  it('runs the real collector process and recovers accepted events after restart', async () => {
    const config = {
      host: '127.0.0.1',
      port: 0,
      spool: join(root, 'process-spool'),
      origins: [],
      readToken: '0'.repeat(64),
      projects: { demo: { app: 'TS' as const, environment: 'test' } },
      search: { url, username: 'fixture', password: 'unused', ca }
    }
    const configPath = join(root, 'config.json')
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
    async function launch(): Promise<{ child: ChildProcess; origin: string }> {
      const child = spawn(
        process.execPath,
        process.env.TS_LOG_COMPILED_ENTRY == null
          ? ['-r', 'sucrase/register', 'src/logServer/main.ts']
          : [process.env.TS_LOG_COMPILED_ENTRY],
        {
          env: { ...process.env, TS_LOG_CONFIG: configPath },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill()
          reject(Error('Collector startup timeout'))
        }, 10000)
        child.once('exit', code => {
          clearTimeout(timeout)
          reject(Error('Collector exited ' + code))
        })
        let output = ''
        child.stdout.on('data', data => {
          output += String(data)
          if (output.includes('\n')) {
            clearTimeout(timeout)
            try {
              const ready = JSON.parse(output.trim().split('\n')[0])
              resolve({
                child,
                origin: 'http://127.0.0.1:' + ready.address.port
              })
            } catch {
              reject(Error('Invalid startup response'))
            }
          }
        })
      })
    }
    async function stop(child: ChildProcess): Promise<void> {
      const exited = new Promise<void>(resolve =>
        child.once('exit', () => {
          resolve()
        })
      )
      child.kill('SIGTERM')
      await exited
    }
    transient = true
    const first = await launch()
    const event = row()
    expect(
      (
        await fetch(first.origin + '/ingest/demo', {
          method: 'POST',
          body: wire(event)
        })
      ).status
    ).equals(202)
    await stop(first.child)
    expect(
      (JSON.parse(await readFile(config.spool, 'utf8')) as LogDocument[]).some(
        r => r.I === event.I
      )
    ).equals(true)
    transient = false
    const second = await launch()
    try {
      for (let i = 0; i < 80 && !stored.has(event.I); i++) await tick()
      expect(stored.has(event.I)).equals(true)
    } finally {
      await stop(second.child)
    }
    const direct = await startCollector({
      ...config,
      spool: join(root, 'direct')
    })
    await direct.stop()
    let invalid = false
    try {
      await startCollector({ ...config, port: -1 })
    } catch {
      invalid = true
    }
    expect(invalid).equals(true)
  })
})
