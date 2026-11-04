/**
 * The private fixture-control proxy the chat2 harness drives through
 * `fixtureControl`. It stands between the disposable clients and the owned API
 * and media origins, records metadata only (history pages, sends, media
 * requests, socket traffic), fails, defers or empties exactly the requests its
 * rules name, and changes nothing else. The per-call client is
 * `chat2FixtureControl.e2e.ts`.
 */
import assert from 'node:assert/strict'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse
} from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

/** What the harness's `prepare` requires the proxy to offer. */
export const CHAT2_PROXY_CAPABILITIES = [
  'precise-one-shot-fail',
  'bounded-defer-release',
  'history-envelope-metadata',
  'recorded-read-cursor-restore',
  'media-metadata-only',
  'websocket-duplex-metadata'
] as const

export type Chat2FaultPhase =
  'send' | 'preferences' | 'history-jump' | 'history-original'
export type Chat2FaultMode = 'fail' | 'defer' | 'empty'

export interface Chat2FaultRule {
  id: string
  phase: Chat2FaultPhase
  mode: Chat2FaultMode
  viewerId: string
  conversationId: string
  beforeAtMost?: number
  remaining: number
}

export type Chat2Event = Record<string, unknown> & {
  event: number
  type: string
  at: string
}

/** The state-changing actions, done by the owner (`chat2FixtureProxyServe`). */
export interface Chat2ProxyActions {
  restoreAttention: (
    viewerId: string,
    conversationId: string
  ) => Promise<number>
  setLao: (playerId: string, on: boolean) => Promise<string[]>
  claimLocked: (detail: Record<string, unknown>) => Promise<void>
  prepareLoop: (viewerId: string) => Promise<Record<string, unknown>>
  postLoop: (viewerId: string) => Promise<Record<string, unknown>>
}

export interface Chat2ProxyOptions {
  ownershipId: string
  applicationSource: string
  apiUpstream: string
  mediaUpstream: string
  controlToken: string
  actions: Chat2ProxyActions
  /** The longest a deferred request is held before it is released anyway. */
  deferLimitMs?: number
  now?: () => Date
  /** Called once `cleanup` has been answered; the owner then stops. */
  onCleanup?: () => void
}

export interface Chat2Proxy {
  apiOrigin: string
  mediaOrigin: string
  close: () => Promise<void>
}

const MESSAGES =
  /^\/api\/v1\/chat\/conversations\/(cnv_[a-zA-Z0-9_-]+)\/messages$/
const PREFERENCES =
  /^\/api\/v1\/chat\/conversations\/(cnv_[a-zA-Z0-9_-]+)\/preferences$/

function localOrigin(value: string): URL {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:')
  assert(['127.0.0.1', 'localhost'].includes(url.hostname))
  assert.equal(url.pathname, '/')
  assert.equal(url.username + url.password + url.search + url.hash, '')
  return url
}

async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const part of req) {
    const chunk = Buffer.from(part as Uint8Array)
    length += chunk.length
    assert(length <= limit, 'Request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Counts websocket payload bytes and reads the server's text frames. */
class FrameReader {
  private pending = Buffer.alloc(0)
  payloadBytes = 0

  constructor(private readonly onText: (text: string) => void) {}

  push(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk])
    for (;;) {
      if (this.pending.length < 2) return
      const opcode = this.pending[0] & 0x0f
      const masked = (this.pending[1] & 0x80) !== 0
      let length = this.pending[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.pending.length < 4) return
        length = this.pending.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.pending.length < 10) return
        length = Number(this.pending.readBigUInt64BE(2))
        offset = 10
      }
      const keyOffset = offset
      if (masked) offset += 4
      if (this.pending.length < offset + length) return
      const payload = Buffer.from(
        this.pending.subarray(offset, offset + length)
      )
      if (masked)
        for (let i = 0; i < payload.length; i++)
          payload[i] ^= this.pending[keyOffset + (i % 4)]
      this.pending = this.pending.subarray(offset + length)
      this.payloadBytes += length
      if (opcode === 1) this.onText(payload.toString('utf8'))
    }
  }
}

export async function chat2FixtureProxy(
  options: Chat2ProxyOptions
): Promise<Chat2Proxy> {
  const api = localOrigin(options.apiUpstream)
  const media = localOrigin(options.mediaUpstream)
  assert(options.controlToken.length >= 32)
  const now = options.now ?? (() => new Date())
  const deferLimit = options.deferLimitMs ?? 10 * 60 * 1000
  const events: Chat2Event[] = []
  let lastEvent = 0
  const record = (type: string, fields: Record<string, unknown>): void => {
    events.push({
      ...fields,
      type,
      event: ++lastEvent,
      at: now().toISOString()
    })
  }
  let rules: Chat2FaultRule[] = []
  const held = new Map<string, Set<() => void>>()
  const release = (ruleId: string): number => {
    const waiting = held.get(ruleId)
    held.delete(ruleId)
    for (const resume of waiting ?? []) resume()
    return waiting?.size ?? 0
  }
  const sockets = new Set<Socket>()
  const connections = new Map<
    string,
    {
      connectionId: string
      actorId?: string
      status: number
      open: boolean
      client: FrameReader
      server: FrameReader
      chatMessageHints: Array<{ conversationId: string; seq: number }>
    }
  >()
  const actors = new Map<string, Promise<string | undefined>>()
  const actorOf = async (req: IncomingMessage): Promise<string | undefined> => {
    const credential =
      (req.headers.authorization ?? '') + '\n' + (req.headers.cookie ?? '')
    if (credential === '\n') return undefined
    let known = actors.get(credential)
    if (known == null) {
      known = (async () => {
        const answer = await fetch(new URL('/api/v1/auth/me', api), {
          headers: {
            ...(req.headers.cookie == null
              ? {}
              : { cookie: req.headers.cookie }),
            ...(req.headers.authorization == null
              ? {}
              : { authorization: req.headers.authorization })
          },
          redirect: 'error',
          signal: AbortSignal.timeout(5000)
        })
        if (!answer.ok) return undefined
        const id = ((await answer.json()) as { id?: unknown }).id
        return typeof id === 'string' ? id : undefined
      })()
      actors.set(credential, known)
      // A failed lookup is not remembered: the next request asks again.
      known.then(
        id => {
          if (id == null) actors.delete(credential)
        },
        () => actors.delete(credential)
      )
    }
    return await known
  }

  const matchRule = (
    actorId: string | undefined,
    method: string,
    url: URL
  ): Chat2FaultRule | undefined => {
    if (actorId == null) return undefined
    const messages = MESSAGES.exec(url.pathname)?.[1]
    const preferences = PREFERENCES.exec(url.pathname)?.[1]
    const before = url.searchParams.get('before')
    for (const rule of rules) {
      if (rule.viewerId !== actorId || rule.remaining <= 0) continue
      const matched =
        rule.phase === 'send'
          ? method === 'POST' && messages === rule.conversationId
          : rule.phase === 'preferences'
            ? method === 'PATCH' && preferences === rule.conversationId
            : method === 'GET' &&
              messages === rule.conversationId &&
              before != null &&
              !url.searchParams.has('after') &&
              (rule.beforeAtMost == null || Number(before) <= rule.beforeAtMost)
      if (!matched) continue
      rule.remaining--
      record('fault-matched', {
        ruleId: rule.id,
        mode: rule.mode,
        phase: rule.phase,
        actorId,
        conversationId: rule.conversationId,
        query: { before: before == null ? undefined : Number(before) }
      })
      return rule
    }
    return undefined
  }

  const historyEvent = (
    actorId: string | undefined,
    conversationId: string,
    url: URL,
    status: number,
    rows: Array<{ id?: unknown; seq?: unknown; kind?: unknown }>,
    injected = false
  ): void => {
    const number = (name: string): number | undefined => {
      const value = url.searchParams.get(name)
      return value == null ? undefined : Number(value)
    }
    record('history-response', {
      actorId,
      conversationId,
      status,
      query: { before: number('before'), after: number('after') },
      rows: rows.map(row => ({ id: row.id, seq: row.seq })),
      empty: rows.length === 0,
      operationsOnly: rows.length > 0 && rows.every(row => row.kind !== 'post'),
      ...(injected ? { injected: true } : {})
    })
  }

  const control = async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> => {
    const actual = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from('Bearer ' + options.controlToken)
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      res.writeHead(403).end()
      return
    }
    const input = JSON.parse((await body(req, 65536)).toString()) as Record<
      string,
      unknown
    >
    const answer = (value: Record<string, unknown>, status = 200): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          ok: status === 200,
          uiActions: false,
          ownershipId: options.ownershipId,
          ...value
        })
      )
    }
    try {
      assert.equal(input.ownershipId, options.ownershipId, 'Another ownership')
      const text = (name: string): string => {
        const value = input[name]
        assert(typeof value === 'string' && value !== '', name + ' required')
        return value
      }
      switch (input.action) {
        case 'prepare':
          assert.equal(
            input.source,
            options.applicationSource,
            'The proxy serves another application source'
          )
          answer({
            source: options.applicationSource,
            capabilities: [...CHAT2_PROXY_CAPABILITIES]
          })
          return
        case 'snapshot': {
          const after = Number(input.afterEvent ?? 0)
          if (input.kind === 'socket') {
            answer({
              lastEvent,
              activeSockets: [...connections.values()]
                .filter(row => row.open)
                .map(row => ({
                  connectionId: row.connectionId,
                  actorId: row.actorId,
                  status: row.status,
                  clientPayloadBytes: row.client.payloadBytes,
                  serverPayloadBytes: row.server.payloadBytes,
                  chatMessageHints: row.chatMessageHints
                }))
            })
            return
          }
          const media = input.kind === 'media'
          answer({
            lastEvent,
            events: events.filter(
              event =>
                event.event > after &&
                (media
                  ? event.type === 'media-request'
                  : event.type !== 'media-request' &&
                    (input.viewerId == null ||
                      event.actorId === input.viewerId) &&
                    (input.conversationId == null ||
                      event.conversationId === input.conversationId))
            )
          })
          return
        }
        case 'fault': {
          const mode = (input.mode ?? 'fail') as Chat2FaultMode
          assert(['fail', 'defer', 'empty'].includes(mode))
          const phase = text('phase') as Chat2FaultPhase
          assert(
            [
              'send',
              'preferences',
              'history-jump',
              'history-original'
            ].includes(phase)
          )
          assert(mode !== 'empty' || phase.startsWith('history-'))
          const remaining = Number(input.remaining ?? 1)
          assert(
            Number.isInteger(remaining) && remaining >= 1 && remaining <= 20
          )
          const rule: Chat2FaultRule = {
            id: randomUUID(),
            phase,
            mode,
            viewerId: text('viewerId'),
            conversationId: text('conversationId'),
            ...(input.beforeAtMost == null
              ? {}
              : { beforeAtMost: Number(input.beforeAtMost) }),
            remaining
          }
          assert(rule.conversationId.startsWith('cnv_'))
          rules.push(rule)
          answer({ rule })
          return
        }
        case 'clear-fault': {
          const ids = rules.map(rule => rule.id)
          rules = []
          let released = 0
          for (const id of [...held.keys()]) released += release(id)
          answer({ cleared: ids.length, released })
          return
        }
        case 'restore-attention':
          answer({
            cursor: await options.actions.restoreAttention(
              text('viewerId'),
              text('conversationId')
            )
          })
          return
        case 'set-lao':
          answer({
            leagues: await options.actions.setLao(
              text('playerId'),
              input.on === true
            )
          })
          return
        case 'claim-locked':
          await options.actions.claimLocked(input)
          answer({ claimed: true })
          return
        case 'prepare-loop':
          answer(await options.actions.prepareLoop(text('viewerId')))
          return
        case 'post-loop':
          answer(await options.actions.postLoop(text('viewerId')))
          return
        case 'cleanup':
          answer({
            cleanupRequested: true,
            heldReleased: [...held.keys()].length,
            rulesCleared: rules.length
          })
          setImmediate(() => options.onCleanup?.())
          return
        default:
          throw new Error('Unsupported fixture action')
      }
    } catch (error) {
      answer({ error: String((error as Error).message ?? error) }, 409)
    }
  }

  const forward = (
    upstream: URL,
    req: IncomingMessage,
    res: ServerResponse,
    payload: Buffer,
    host: string,
    onDone: (status: number, body: Buffer | undefined) => Buffer | undefined
  ): void => {
    const url = new URL(req.url ?? '/', upstream)
    const proxied = request(
      url,
      {
        method: req.method,
        headers: {
          ...req.headers,
          host,
          'accept-encoding': 'identity',
          'content-length': String(payload.length)
        }
      },
      response => {
        const type = String(response.headers['content-type'] ?? '')
        if (!type.includes('application/json')) {
          onDone(response.statusCode ?? 502, undefined)
          res.writeHead(response.statusCode ?? 502, response.headers)
          response.pipe(res)
          return
        }
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const raw = Buffer.concat(chunks)
          const out = onDone(response.statusCode ?? 502, raw) ?? raw
          const headers = { ...response.headers }
          delete headers['content-length']
          delete headers['transfer-encoding']
          headers['content-length'] = String(out.length)
          res.writeHead(response.statusCode ?? 502, headers)
          res.end(out)
        })
      }
    )
    proxied.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    proxied.end(payload)
  }

  let mediaOrigin = ''
  const apiServer = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      const url = new URL(req.url ?? '/', api)
      assert.equal(url.origin, api.origin)
      if (url.pathname === '/__chat2_fixture' && req.method === 'POST') {
        await control(req, res)
        return
      }
      const payload = await body(req, 64 * 1024 * 1024)
      const method = req.method ?? 'GET'
      const conversationId = MESSAGES.exec(url.pathname)?.[1]
      const actorId =
        conversationId != null || PREFERENCES.test(url.pathname)
          ? await actorOf(req)
          : undefined
      const rule = matchRule(actorId, method, url)
      if (rule?.mode === 'fail') {
        res
          .writeHead(503, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'Synthetic fixture fault' }))
        return
      }
      if (rule?.mode === 'empty') {
        historyEvent(actorId, rule.conversationId, url, 200, [], true)
        res.writeHead(200, { 'content-type': 'application/json' }).end('[]')
        return
      }
      if (rule?.mode === 'defer') {
        await new Promise<void>(resolve => {
          const waiting = held.get(rule.id) ?? new Set()
          held.set(rule.id, waiting)
          const timer = setTimeout(() => {
            waiting.delete(done)
            done()
          }, deferLimit)
          const done = (): void => {
            clearTimeout(timer)
            resolve()
          }
          waiting.add(done)
        })
        record('deferred-closed', {
          ruleId: rule.id,
          actorId,
          conversationId: rule.conversationId
        })
      }
      forward(api, req, res, payload, api.host, (status, raw) => {
        if (conversationId != null && method === 'GET' && raw != null) {
          let rows: unknown = []
          try {
            rows = JSON.parse(raw.toString())
          } catch {}
          historyEvent(
            actorId,
            conversationId,
            url,
            status,
            Array.isArray(rows) ? rows : []
          )
        }
        if (conversationId != null && method === 'POST')
          record('send', { actorId, conversationId, status })
        // Presigned media addresses point the client at the media front.
        return raw == null
          ? undefined
          : Buffer.from(raw.toString().split(media.origin).join(mediaOrigin))
      })
    }
    handle().catch(() => {
      if (!res.headersSent) res.writeHead(400)
      res.end()
    })
  })
  apiServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', api)
    if (url.origin !== api.origin) {
      socket.destroy()
      return
    }
    const connectionId = randomUUID()
    const row = {
      connectionId,
      actorId: undefined as string | undefined,
      status: 0,
      open: false,
      chatMessageHints: [] as Array<{ conversationId: string; seq: number }>,
      client: new FrameReader(() => undefined),
      server: new FrameReader(text => {
        try {
          const frame = JSON.parse(text) as Record<string, unknown>
          if (
            frame.type === 'chat' &&
            frame.kind === 'message' &&
            typeof frame.conversationId === 'string' &&
            typeof frame.seq === 'number'
          )
            row.chatMessageHints.push({
              conversationId: frame.conversationId,
              seq: frame.seq
            })
        } catch {}
      })
    }
    connections.set(connectionId, row)
    actorOf(req)
      .then(id => {
        row.actorId = id
      })
      .catch(() => undefined)
    const proxied = request(url, {
      headers: { ...req.headers, host: api.host }
    })
    proxied.on('upgrade', (response, target, targetHead) => {
      row.status = response.statusCode ?? 101
      row.open = true
      socket.write(`HTTP/1.1 ${row.status} Switching Protocols\r\n`)
      for (let i = 0; i < response.rawHeaders.length; i += 2)
        socket.write(
          `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`
        )
      socket.write('\r\n')
      if (targetHead.length > 0) {
        row.server.push(targetHead)
        socket.write(targetHead)
      }
      if (head.length > 0) {
        row.client.push(head)
        target.write(head)
      }
      target.on('data', (chunk: Buffer) => {
        row.server.push(chunk)
        socket.write(chunk)
      })
      socket.on('data', (chunk: Buffer) => {
        row.client.push(chunk)
        target.write(chunk)
      })
      const closed = (): void => {
        row.open = false
        target.destroy()
        socket.destroy()
      }
      for (const side of [socket, target]) {
        side.once('end', closed)
        side.once('close', closed)
        side.once('error', closed)
      }
    })
    proxied.on('response', () => socket.destroy())
    proxied.on('error', () => socket.destroy())
    socket.once('error', () => proxied.destroy())
    proxied.end()
  })
  const mediaServer = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      const url = new URL(req.url ?? '/', media)
      const payload = await body(req, 128 * 1024 * 1024)
      // The address was signed for the media origin, and is checked as such.
      forward(media, req, res, payload, media.host, status => {
        record('media-request', {
          method: req.method,
          path: url.pathname,
          status
        })
        return undefined
      })
    }
    handle().catch(() => {
      if (!res.headersSent) res.writeHead(400)
      res.end()
    })
  })
  for (const server of [apiServer, mediaServer])
    server.on('connection', socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
  const listen = async (server: Server): Promise<string> => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }
  const apiOrigin = await listen(apiServer)
  mediaOrigin = await listen(mediaServer)
  return {
    apiOrigin,
    mediaOrigin,
    close: async () => {
      rules = []
      for (const id of [...held.keys()]) release(id)
      for (const socket of sockets) socket.destroy()
      await Promise.all(
        [apiServer, mediaServer].map(async server => {
          await new Promise<void>(resolve => {
            server.close(() => {
              resolve()
            })
          })
        })
      )
    }
  }
}

/** A private JSON file only its owner can read. */
export function writePrivate(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), {
    mode: 0o600,
    flag: 'wx'
  })
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}
