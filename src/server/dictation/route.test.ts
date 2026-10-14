import { createServer, type Server } from 'node:http'
import { type AddressInfo, connect as connectTcp } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'
import WebSocket from 'ws'

import {
  asDictationReply,
  type DictationReply,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { toolSchema } from '../../common/scoring/actions'
import { rosterToolSchema } from '../../common/scoring/rosterCommands'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { Actor } from '../auth/sessions'
import { hashToken, SESSION_COOKIE } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { healthRoutes } from '../routes/health'
import { asServerConfig } from '../serverConfig'
import { bindUpgrades } from '../socket/bindUpgrades'
import type { InterpreterConfig, Turn } from './interpreter'
import {
  attachDictation,
  type Conversation,
  type DictationConfig,
  type Recogniser
} from './route'
import { type Scope, SCOPES } from './scopes'
import type { SttHandlers } from './stt'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_dictation_route_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const MEMBER = 'tok_dictation_member_0000000000000'
const STRANGER = 'tok_dictation_stranger_00000000000'
const COACH = 'tok_dictation_coach_000000000000000'

const member = mintUserId(() => false)
const stranger = mintUserId(id => id === member.userId)
const coach = mintUserId(id => [member, stranger].some(u => u.userId === id))
const assistant = mintUserId(id =>
  [member, stranger, coach].some(u => u.userId === id)
)
const scorekeeper = mintUserId(id =>
  [member, stranger, coach, assistant].some(u => u.userId === id)
)

const CONFIG: DictationConfig = {
  apiKey: 'key',
  baseUrl: 'https://llm.example/v1',
  sttUrl: 'wss://stt.example',
  sttModel: 'stt-model',
  model: 'grok-4.7'
}

/** The recogniser a connection opened, driven by hand. */
class FakeRecogniser implements Recogniser {
  calls: string[] = []
  audio: Buffer[] = []
  terms: string[][] = []
  constructor(readonly handlers: SttHandlers) {}
  retarget(terms: readonly string[]): void {
    this.terms.push([...terms])
  }

  begin(): void {
    this.calls.push('begin')
  }

  write(pcm: Buffer): void {
    this.audio.push(pcm)
  }

  end(): void {
    this.calls.push('end')
  }

  close(): void {
    this.calls.push('close')
  }
}

/** One utterance's conversation, answering from a script. */
class FakeConversation implements Conversation {
  answers: number[] = []
  constructor(
    readonly config: InterpreterConfig,
    readonly context: string,
    readonly transcript: string,
    private readonly turns: Array<Turn | Error | Promise<Turn>>
  ) {}

  async start(): Promise<Turn> {
    return await this.next()
  }

  async answer(index: number): Promise<Turn> {
    this.answers.push(index)
    return await this.next()
  }

  private async next(): Promise<Turn> {
    const turn = this.turns.shift() ?? {
      kind: 'error',
      message: 'script ran out'
    }
    if (turn instanceof Error) throw turn
    return await turn
  }
}

interface Client {
  ws: WebSocket
  next: () => Promise<DictationReply>
  replies: DictationReply[]
  send: (frame: object) => void
  audio: (bytes: number) => void
}

const ball = { type: 'pitch' as const, call: 'B' as const }
const pause = async (ms = 30): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('dictation route', function () {
  this.timeout(60000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: Server | undefined
  let detach: (() => void) | undefined
  let port = 0
  const recognisers: FakeRecogniser[] = []
  const conversations: FakeConversation[] = []
  const script: Array<Turn | Error | Promise<Turn>> = []
  const logs: string[] = []
  const scopes = new Map<string, Scope>(SCOPES)
  const home = makeId('team')
  const away = makeId('team')
  const elsewhere = makeId('team')
  const ownGame = makeId('game')
  const otherGame = makeId('game')

  before(async function () {
    adminPool = new Pool({ connectionString: adminUrl })
    try {
      await adminPool.query('select 1')
    } catch {
      await adminPool.end()
      adminPool = undefined
      this.skip()
      return
    }
    await adminPool.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    const now = new Date()
    await db
      .insertInto('users')
      .values([
        {
          id: member.userId,
          legacyId: member.legacyId,
          display_name: 'Cam',
          created_at: now,
          updated_at: now
        },
        {
          id: stranger.userId,
          legacyId: stranger.legacyId,
          display_name: 'Bea',
          created_at: now,
          updated_at: now
        },
        ...[
          [coach, 'Judge'],
          [assistant, 'Soto'],
          [scorekeeper, 'Betts']
        ].map(([user, name]) => ({
          id: (user as typeof coach).userId,
          legacyId: (user as typeof coach).legacyId,
          display_name: name as string,
          created_at: now,
          updated_at: now
        }))
      ])
      .execute()
    const expires = new Date(now.getTime() + 3_600_000)
    await db
      .insertInto('auth_sessions')
      .values([
        {
          id: 'ses_dictation_member',
          user_id: member.userId,
          token_hash: hashToken(MEMBER),
          created_at: now,
          expires_at: expires
        },
        {
          id: 'ses_dictation_stranger',
          user_id: stranger.userId,
          token_hash: hashToken(STRANGER),
          created_at: now,
          expires_at: expires
        },
        {
          id: 'ses_dictation_coach',
          user_id: coach.userId,
          token_hash: hashToken(COACH),
          created_at: now,
          expires_at: expires
        }
      ])
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: home, name: 'Home', kind: 'full' },
        { id: away, name: 'Away', kind: 'full' },
        { id: elsewhere, name: 'Elsewhere', kind: 'full' }
      ])
      .execute()
    await db
      .insertInto('games')
      .values([
        { id: ownGame, home_team_id: home, away_team_id: away, start_at: now },
        {
          id: otherGame,
          home_team_id: elsewhere,
          away_team_id: away,
          start_at: now
        }
      ])
      .execute()
    await db
      .insertInto('memberships')
      .values([
        {
          id: makeId('membership'),
          user_id: member.userId,
          team_id: home,
          role: 'member'
        },
        ...[coach, assistant].map(user => ({
          id: makeId('membership'),
          user_id: user.userId,
          team_id: home,
          role: 'member' as const
        })),
        {
          id: makeId('membership'),
          user_id: scorekeeper.userId,
          team_id: away,
          role: 'member'
        }
      ])
      .execute()
    await db
      .insertInto('scope_roles')
      .values(
        (
          [
            [coach, home, 'coach'],
            [assistant, home, 'assistant'],
            [scorekeeper, away, 'scorekeeper']
          ] as const
        ).map(([user, teamId, role]) => ({
          id: makeId('scopeRole'),
          user_id: user.userId,
          scope_type: 'team' as const,
          scope_id: teamId,
          role
        }))
      )
      .execute()

    scopes.set('broken', {
      tools: [],
      authorise: async () => {
        throw new Error('database fell over')
      }
    })
    const app = express()
    app.use(
      '/api/v1',
      healthRoutes(db, '1.2.3', {
        dictation: true,
        dictationModels: ['grok-4.3', 'grok-4.7']
      })
    )
    server = createServer(app)
    detach = attachDictation(server, {
      db,
      config: CONFIG,
      scopes,
      openRecogniser: handlers => {
        const recogniser = new FakeRecogniser(handlers)
        recognisers.push(recogniser)
        return recogniser
      },
      converse: (config, context, transcript) => {
        const conversation = new FakeConversation(
          config,
          context,
          transcript,
          script
        )
        conversations.push(conversation)
        return conversation
      },
      log: message => logs.push(message)
    }).close
    // Stands in for any other upgrade handler, answering a moment later so
    // that a handler which wrongly took the path would win the race.
    server.on('upgrade', (request, socket) => {
      if (request.url?.startsWith('/api/v1/dictation') === true) return
      setTimeout(
        () => socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'),
        50
      )
    })
    server.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    port = (server.address() as AddressInfo).port
  })

  after(async function () {
    detach?.()
    server?.close()
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(`drop database if exists ${scratchName}`)
      await adminPool.end()
    }
  })

  async function refusal(
    headers: Record<string, string>,
    path = '/api/v1/dictation'
  ): Promise<number> {
    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
      ws.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0)
      })
      ws.on('open', () => {
        ws.close()
        reject(new Error('the upgrade was admitted'))
      })
      ws.on('error', () => undefined)
    })
  }

  async function connect(
    headers: Record<string, string> = { authorization: `Bearer ${MEMBER}` }
  ): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/dictation`, {
      headers
    })
    const replies: DictationReply[] = []
    const waiting: Array<(reply: DictationReply) => void> = []
    const queued: DictationReply[] = []
    ws.on('message', data => {
      const reply = asDictationReply(
        JSON.parse((data as Buffer).toString('utf8'))
      )
      replies.push(reply)
      const waiter = waiting.shift()
      if (waiter != null) waiter(reply)
      else queued.push(reply)
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    return {
      ws,
      replies,
      next: async () => {
        const ready = queued.shift()
        if (ready != null) return ready
        return await new Promise(resolve => waiting.push(resolve))
      },
      send: frame => {
        ws.send(JSON.stringify(frame))
      },
      audio: bytes => {
        ws.send(Buffer.alloc(bytes, 1))
      }
    }
  }

  const start = (id: string, more: Record<string, unknown> = {}): object => ({
    kind: 'start',
    id,
    scope: 'scoring',
    target: { gameId: ownGame },
    context: 'Top of the 1st, 0 outs.',
    ...more
  })

  /** Waits until the route has done what the last frames asked. */
  async function settled(
    recogniser: FakeRecogniser,
    call: string
  ): Promise<void> {
    for (let i = 0; i < 100 && !recogniser.calls.includes(call); i++)
      await pause(10)
    expect(recogniser.calls).includes(call)
  }

  describe('the upgrade', function () {
    it('is refused without a signed-in actor', async function () {
      expect(await refusal({})).equals(401)
      expect(await refusal({ authorization: 'Bearer tok_nobody' })).equals(401)
    })

    it('admits a bearer token and a session cookie alike', async function () {
      const bearer = await connect({ authorization: `Bearer ${MEMBER}` })
      const cookie = await connect({ cookie: `${SESSION_COOKIE}=${MEMBER}` })
      bearer.ws.close()
      cookie.ws.close()
    })

    it('leaves every other path to whoever else listens', async function () {
      expect(
        await refusal({ authorization: `Bearer ${MEMBER}` }, '/api/v1/other')
      ).equals(404)
    })

    it('leaves another path an ordinary request when nothing else listens', async function () {
      // Node 24.9 and later; engines asks for it, and older Node takes the 404 below.
      const probe = createServer() as unknown as {
        shouldUpgradeCallback?: unknown
      }
      if (typeof probe.shouldUpgradeCallback !== 'function') this.skip()
      const lone = createServer((request, response) => {
        response.end(`plain ${String(request.url)}`)
      })
      const handle = attachDictation(lone, {
        db: db!,
        config: CONFIG
      })
      lone.listen(0, '127.0.0.1')
      await new Promise<void>(resolve => lone.once('listening', resolve))
      const port = (lone.address() as AddressInfo).port
      // A websocket asked for elsewhere is answered by the ordinary handler.
      const status = await new Promise<number>(resolve => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/health`, {
          headers: { authorization: `Bearer ${MEMBER}` }
        })
        ws.on('unexpected-response', (_request, response) => {
          resolve(response.statusCode ?? 0)
        })
        ws.on('error', () => undefined)
      })
      expect(status).equals(200)
      // So is a plain request that offers to upgrade to h2c.
      const h2c = await new Promise<string>(resolve => {
        const socket = connectTcp(port, '127.0.0.1', () => {
          socket.write(
            'GET /api/v1/health HTTP/1.1\r\nHost: x\r\nConnection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings: AAMAAABkAAQCAAAAAAIAAAAA\r\n\r\n'
          )
        })
        let reply = ''
        socket.on('data', chunk => {
          reply += String(chunk)
          if (!reply.includes('plain /api/v1/health')) return
          socket.destroy()
          resolve(reply)
        })
      })
      expect(h2c).match(/^HTTP\/1\.1 200/)
      expect(h2c).includes('plain /api/v1/health')
      handle.close()
      // Detached, the server is as it was before.
      expect(lone.listenerCount('upgrade')).equals(0)
      lone.close()
    })

    it('is one claim of a server whose one listener asks each socket in turn', async function () {
      const shared = createServer()
      const handle = attachDictation(shared, {
        db: db!,
        config: CONFIG,
        listenForUpgrades: false
      })
      // After dictation, a socket that takes whatever is left, as the
      // scoreboard does.
      const unbind = bindUpgrades(shared, [
        handle.acceptUpgrade,
        (_request, socket) => {
          socket.end('HTTP/1.1 418 Taken\r\nContent-Length: 0\r\n\r\n')
          return true
        }
      ])
      shared.listen(0, '127.0.0.1')
      await new Promise<void>(resolve => shared.once('listening', resolve))
      const sharedPort = (shared.address() as AddressInfo).port
      const status = async (path: string): Promise<string> =>
        await new Promise<string>(resolve => {
          const socket = connectTcp(sharedPort, '127.0.0.1', () => {
            socket.write(
              `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`
            )
          })
          socket.once('data', data => {
            resolve(data.toString().split('\r\n')[0])
            socket.destroy()
          })
        })
      try {
        // Dictation's own path is dictation's, refused here for want of a
        // signed-in scorer; any other goes on to the next socket.
        expect(await status('/api/v1/dictation')).match(/ 401 /)
        expect(await status('/api/v1/scoreboard')).match(/ 418 /)
      } finally {
        unbind()
        handle.close()
        shared.close()
      }
    })

    it('answers another path 404 on a Node with no upgrade hook', async function () {
      const older = createServer((request, response) => {
        response.end('plain')
      }) as ReturnType<typeof createServer> & {
        shouldUpgradeCallback?: unknown
      }
      // What a server looks like on Node before 24.9.
      older.shouldUpgradeCallback = undefined
      const handle = attachDictation(older, {
        db: db!,
        config: CONFIG
      })
      expect(older.shouldUpgradeCallback).equals(undefined)
      // And how it behaves there: every upgrade goes to the listeners.
      older.shouldUpgradeCallback = () => older.listenerCount('upgrade') > 0
      older.listen(0, '127.0.0.1')
      await new Promise<void>(resolve => older.once('listening', resolve))
      const status = await new Promise<number>(resolve => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${(older.address() as AddressInfo).port}/api/v1/health`
        )
        ws.on('unexpected-response', (_request, response) => {
          resolve(response.statusCode ?? 0)
        })
        ws.on('error', () => undefined)
      })
      expect(status).equals(404)
      handle.close()
      older.close()
    })

    it('admits only the allowed pages, and a client with no Origin', async function () {
      const guarded = createServer()
      const handle = attachDictation(guarded, {
        db: db!,
        config: CONFIG,
        allowedOrigins: [
          'https://devhost2.example-ts.test/',
          'http://127.0.0.1:8080'
        ],
        openRecogniser: handlers => new FakeRecogniser(handlers)
      })
      guarded.listen(0, '127.0.0.1')
      await new Promise<void>(resolve => guarded.once('listening', resolve))
      const url = `ws://127.0.0.1:${(guarded.address() as AddressInfo).port}/api/v1/dictation`
      const attempt = async (origin?: string): Promise<number> =>
        await new Promise(resolve => {
          const ws = new WebSocket(url, {
            headers: { cookie: `${SESSION_COOKIE}=${MEMBER}` },
            ...(origin == null ? {} : { origin })
          })
          ws.on('open', () => {
            ws.close()
            resolve(101)
          })
          ws.on('unexpected-response', (_request, response) => {
            resolve(response.statusCode ?? 0)
          })
          ws.on('error', () => undefined)
        })
      expect(await attempt('https://evil.example')).equals(403)
      expect(await attempt('https://devhost3.example-ts.test')).equals(403)
      expect(await attempt('https://devhost2.example-ts.test')).equals(101)
      expect(await attempt('http://127.0.0.1:8080')).equals(101)
      expect(await attempt()).equals(101)
      handle.close()
      guarded.close()
    })

    it('answers 500 when the actor cannot be read', async function () {
      const broken = createServer()
      const handle = attachDictation(broken, {
        db: {} as unknown as Kysely<Database>,
        config: CONFIG,
        log: message => logs.push(message)
      })
      broken.listen(0, '127.0.0.1')
      await new Promise<void>(resolve => broken.once('listening', resolve))
      const status = await new Promise<number>(resolve => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${(broken.address() as AddressInfo).port}/api/v1/dictation/`,
          { headers: { authorization: `Bearer ${MEMBER}` } }
        )
        ws.on('unexpected-response', (_request, response) => {
          resolve(response.statusCode ?? 0)
        })
        ws.on('error', () => undefined)
      })
      expect(status).equals(500)
      expect(
        logs.some(line =>
          line.startsWith('dictation: could not read the actor')
        )
      ).equals(true)
      handle.close()
      broken.close()
    })
  })

  it('turns a hold into actions, and never reads audio outside one', async function () {
    const client = await connect()
    const recogniser = recognisers[recognisers.length - 1]
    const terms = Array.from({ length: 3 }, (_, i) => `Player ${i}.`)
    client.send({ kind: 'keyterms', keyterms: terms })
    client.audio(10)
    client.send(start('u1'))
    await settled(recogniser, 'begin')
    expect(recogniser.terms).deep.equals([terms])
    expect(recogniser.audio).deep.equals([])
    client.audio(4)
    client.audio(6)
    await pause()
    recogniser.handlers.onPartial('Ba')
    expect(await client.next()).deep.equals({
      kind: 'partial',
      id: 'u1',
      text: 'Ba'
    })
    client.send({ kind: 'release', id: 'u1' })
    await settled(recogniser, 'end')
    expect(recogniser.audio.map(b => b.length)).deep.equals([4, 6])
    script.push({ kind: 'actions', actions: [ball], dropped: [] })
    recogniser.handlers.onFinal('Ball.')
    expect(await client.next()).deep.equals({
      kind: 'transcript',
      id: 'u1',
      text: 'Ball.'
    })
    expect(await client.next()).deep.equals({
      kind: 'actions',
      id: 'u1',
      transcript: 'Ball.',
      actions: [ball],
      dropped: []
    })
    const conversation = conversations[conversations.length - 1]
    expect(conversation.context).equals('Top of the 1st, 0 outs.')
    expect(conversation.transcript).equals('Ball.')
    expect(conversation.config.model).equals('grok-4.7')
    expect(conversation.config.baseUrl).equals('https://llm.example/v1')
    expect(conversation.config.tools).deep.equals(
      toolSchema().filter(tool => tool.name !== 'lineup')
    )
    expect(conversation.config.rosterTools).deep.equals(rosterToolSchema())
    // Audio after the utterance is over is dropped.
    client.audio(2)
    await pause()
    expect(recogniser.audio).to.have.length(2)
    client.ws.close()
    await pause()
    expect(recogniser.calls).includes('close')
  })

  it('gives one scorer’s sentences one cache key, and another scorer another', async function () {
    const count = async (
      recogniser: FakeRecogniser,
      call: string,
      times: number
    ): Promise<void> => {
      for (
        let i = 0;
        i < 100 && recogniser.calls.filter(c => c === call).length < times;
        i++
      )
        await pause(10)
    }
    const keyOf = async (
      client: Awaited<ReturnType<typeof connect>>,
      recogniser: FakeRecogniser,
      id: string,
      n: number
    ): Promise<string | undefined> => {
      client.send(start(id))
      await count(recogniser, 'begin', n)
      client.audio(4)
      await pause()
      client.send({ kind: 'release', id })
      await count(recogniser, 'end', n)
      script.push({ kind: 'actions', actions: [ball], dropped: [] })
      recogniser.handlers.onFinal('Ball.')
      await client.next()
      await client.next()
      return conversations[conversations.length - 1].config.cacheKey
    }
    const one = await connect()
    const oneRecogniser = recognisers[recognisers.length - 1]
    const first = await keyOf(one, oneRecogniser, 'k1', 1)
    const again = await keyOf(one, oneRecogniser, 'k2', 2)
    expect(first).to.be.a('string').and.not.equal('')
    expect(again).equals(first)
    const other = await connect()
    const otherKey = await keyOf(
      other,
      recognisers[recognisers.length - 1],
      'k3',
      1
    )
    expect(otherKey).to.be.a('string').and.not.equal(first)
    one.ws.close()
    other.ws.close()
    await pause()
  })

  it('authorises every start against its own target, before reading audio', async function () {
    const client = await connect()
    const recogniser = recognisers[recognisers.length - 1]
    client.send(start('u1', { target: { gameId: otherGame } }))
    client.audio(4)
    expect(await client.next()).deep.equals({
      kind: 'error',
      id: 'u1',
      message: 'That game is not one you can dictate for'
    })
    client.send({ kind: 'release', id: 'u1' })
    await pause()
    expect(recogniser.calls).deep.equals([])
    expect(recogniser.audio).deep.equals([])

    client.send(start('u2'))
    await settled(recogniser, 'begin')
    client.audio(2)
    client.send({ kind: 'release', id: 'u2' })
    await settled(recogniser, 'end')
    script.push({ kind: 'actions', actions: [ball], dropped: [] })
    recogniser.handlers.onFinal('Ball.')
    await client.next()
    expect((await client.next()).kind).equals('actions')

    // The same socket, a game this person cannot see: refused again.
    client.send(start('u3', { target: { gameId: otherGame } }))
    expect(await client.next()).deep.equals({
      kind: 'error',
      id: 'u3',
      message: 'That game is not one you can dictate for'
    })
    client.ws.close()
  })

  it('refuses a stranger, an unknown scope and a target it cannot read', async function () {
    const client = await connect({ authorization: `Bearer ${STRANGER}` })
    client.send(start('u1'))
    expect((await client.next()).id).equals('u1')
    client.send(start('u2', { scope: 'settings' }))
    expect(await client.next()).deep.equals({
      kind: 'error',
      id: 'u2',
      message: 'Dictation cannot talk about settings'
    })
    client.send(start('u3', { target: { game: ownGame } }))
    const bad = await client.next()
    expect(bad.kind === 'error' && bad.id).equals('u3')
    client.send(start('u4', { scope: 'broken' }))
    expect(await client.next()).deep.equals({
      kind: 'error',
      id: 'u4',
      message: 'Dictation could not check that game'
    })
    expect(logs.some(line => line.includes('database fell over'))).equals(true)
    client.send({ kind: 'nonsense' })
    const nonsense = await client.next()
    expect(nonsense.kind === 'error' && nonsense.id).equals(null)
    client.ws.send('not json')
    expect((await client.next()).kind).equals('error')
    client.ws.close()
  })

  it('keeps one utterance in flight and answers a second start with an error', async function () {
    const client = await connect()
    const recogniser = recognisers[recognisers.length - 1]
    client.send(start('u1', { model: 'grok-4.3' }))
    await settled(recogniser, 'begin')
    client.send(start('u2'))
    expect(await client.next()).deep.equals({
      kind: 'error',
      id: 'u2',
      message: 'The last thing said is still being answered'
    })
    client.audio(2)
    client.send({ kind: 'release', id: 'u2' })
    await pause()
    expect(recogniser.calls).deep.equals(['begin'])
    client.send({ kind: 'release', id: 'u1' })
    await settled(recogniser, 'end')
    script.push({ kind: 'actions', actions: [ball], dropped: [] })
    recogniser.handlers.onFinal('Ball.')
    await client.next()
    expect(await client.next()).deep.include({ kind: 'actions', id: 'u1' })
    expect(conversations[conversations.length - 1].config).deep.include({
      model: 'grok-4.3',
      api: 'chat',
      apiKey: 'key',
      baseUrl: 'https://llm.example/v1'
    })
    client.ws.close()
  })

  it('refuses a model this server has no key for, before any audio', async function () {
    const client = await connect()
    const recogniser = recognisers[recognisers.length - 1]
    client.send(start('u1', { model: 'gpt-6-luna' }))
    expect(await client.next()).deep.equals({
      kind: 'error',
      id: 'u1',
      message: 'GPT-6 Luna is not set up on this server'
    })
    // Nothing is in flight: the next start is taken.
    client.send(start('u2'))
    await settled(recogniser, 'begin')
    expect(recogniser.calls).deep.equals(['begin'])
    client.ws.close()
  })

  it('holds audio that arrives while a start is authorised, and a release with it', async function () {
    const client = await connect()
    const recogniser = recognisers[recognisers.length - 1]
    client.send(start('u1'))
    client.audio(4)
    client.send({ kind: 'release', id: 'u1' })
    await settled(recogniser, 'end')
    expect(recogniser.calls).deep.equals(['begin', 'end'])
    expect(recogniser.audio.map(b => b.length)).deep.equals([4])
    client.ws.close()
  })

  it('replies with a reason when a hold carried no audio or no words', async function () {
    const client = await connect()
    const recogniser = recognisers[recognisers.length - 1]
    client.send(start('u1'))
    await settled(recogniser, 'begin')
    client.send({ kind: 'release', id: 'u1' })
    expect(await client.next()).deep.equals({
      kind: 'error',
      id: 'u1',
      message: 'No audio arrived before the button was released'
    })
    expect(recogniser.calls).deep.equals(['begin', 'end'])

    client.send(start('u2'))
    await pause()
    client.audio(2)
    client.send({ kind: 'release', id: 'u2' })
    await pause()
    recogniser.handlers.onFinal('  ')
    expect(await client.next()).deep.equals({
      kind: 'transcript',
      id: 'u2',
      text: '  '
    })
    expect(await client.next()).deep.equals({
      kind: 'error',
      id: 'u2',
      message: 'Nothing was heard'
    })
    client.ws.close()
  })

  it('reports a recogniser failure, and a conversation that throws', async function () {
    const client = await connect()
    const recogniser = recognisers[recognisers.length - 1]
    client.send(start('u1'))
    await settled(recogniser, 'begin')
    recogniser.handlers.onError('The recogniser disconnected')
    expect(await client.next()).deep.equals({
      kind: 'error',
      id: 'u1',
      message: 'The recogniser disconnected'
    })
    recogniser.handlers.onError('late')
    recogniser.handlers.onFinal('late')
    recogniser.handlers.onPartial('late')

    client.send(start('u2'))
    await pause()
    client.audio(2)
    client.send({ kind: 'release', id: 'u2' })
    await pause()
    script.push(new Error('boom'))
    recogniser.handlers.onFinal('Ball.')
    await client.next()
    expect(await client.next()).deep.equals({
      kind: 'error',
      id: 'u2',
      message: 'Error: boom'
    })

    client.send(start('u3'))
    await pause()
    client.audio(2)
    client.send({ kind: 'release', id: 'u3' })
    await pause()
    script.push({ kind: 'error', message: 'api.x.ai answered 503: down' })
    recogniser.handlers.onFinal('Ball.')
    await client.next()
    expect(await client.next()).deep.equals({
      kind: 'error',
      id: 'u3',
      message: 'api.x.ai answered 503: down'
    })
    client.ws.close()
  })

  describe('a question from the LLM', function () {
    async function asked(
      client: Client,
      recogniser: FakeRecogniser,
      id: string
    ): Promise<void> {
      client.send(start(id))
      await pause()
      client.audio(2)
      client.send({ kind: 'release', id })
      await pause()
      script.push({
        kind: 'ask',
        question: 'Which Chase?',
        options: [{ label: 'Chase L.', actions: [ball] }, { label: 'Chase M.' }]
      })
      recogniser.handlers.onFinal('Chase singled.')
      await client.next()
      expect(await client.next()).deep.equals({
        kind: 'ask',
        id,
        question: 'Which Chase?',
        options: [{ label: 'Chase L.', actions: [ball] }, { label: 'Chase M.' }]
      })
    }

    it('is answered by option, and refuses one it does not have', async function () {
      const client = await connect()
      const recogniser = recognisers[recognisers.length - 1]
      await asked(client, recogniser, 'u1')
      client.send({ kind: 'answer', id: 'u1', option: 2 })
      expect(await client.next()).deep.equals({
        kind: 'error',
        id: 'u1',
        message: 'There is no option 2'
      })
      client.send({ kind: 'answer', id: 'other', option: 0 })
      expect(await client.next()).deep.equals({
        kind: 'error',
        id: 'other',
        message: 'No question is open for that'
      })
      script.push({
        kind: 'actions',
        actions: [{ type: 'result', eventType: 'single' }],
        dropped: []
      })
      client.send({ kind: 'answer', id: 'u1', option: 1 })
      expect(await client.next()).deep.equals({
        kind: 'actions',
        id: 'u1',
        transcript: 'Chase singled.',
        actions: [{ type: 'result', eventType: 'single' }],
        dropped: []
      })
      expect(conversations[conversations.length - 1].answers).deep.equals([1])
      client.ws.close()
    })

    it('is dismissed with nothing further sent, and frees the socket', async function () {
      const client = await connect()
      const recogniser = recognisers[recognisers.length - 1]
      await asked(client, recogniser, 'u1')
      client.send({ kind: 'dismiss', id: 'u1' })
      client.send({ kind: 'dismiss', id: 'u1' })
      client.send({ kind: 'answer', id: 'u1', option: 0 })
      expect(await client.next()).deep.equals({
        kind: 'error',
        id: 'u1',
        message: 'No question is open for that'
      })
      client.send(start('u2'))
      await pause()
      expect(recogniser.calls.filter(call => call === 'begin')).to.have.length(
        2
      )
      client.ws.close()
    })

    it('is dropped with the socket, and a late answer goes nowhere', async function () {
      const client = await connect()
      const recogniser = recognisers[recognisers.length - 1]
      client.send(start('u1'))
      await pause()
      client.audio(2)
      client.send({ kind: 'release', id: 'u1' })
      await pause()
      let answer: (turn: Turn) => void = () => undefined
      script.push(new Promise<Turn>(resolve => (answer = resolve)))
      recogniser.handlers.onFinal('Ball.')
      await client.next()
      const seen = client.replies.length
      client.ws.close()
      await pause()
      expect(recogniser.calls).includes('close')
      answer({ kind: 'actions', actions: [ball], dropped: [] })
      await pause()
      expect(client.replies).to.have.length(seen)
      expect(
        logs.some(line => line.includes('abandoned: the socket closed'))
      ).equals(true)
    })
  })

  it('closes its sockets and stops listening when the server stops', async function () {
    const lone = createServer()
    const handle = attachDictation(lone, {
      db: db!,
      config: CONFIG
    })
    lone.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => lone.once('listening', resolve))
    const ws = new WebSocket(
      `ws://127.0.0.1:${(lone.address() as AddressInfo).port}/api/v1/dictation`,
      {
        headers: { authorization: `Bearer ${MEMBER}` }
      }
    )
    await new Promise(resolve => ws.once('open', resolve))
    const closed = new Promise<number>(resolve =>
      ws.once('close', code => {
        resolve(code)
      })
    )
    handle.close()
    expect(await closed).equals(1001)
    expect(lone.listenerCount('upgrade')).equals(0)
    lone.close()
  })

  describe('health', function () {
    it('says whether dictation is configured, and the client reads it', async function () {
      const client = new TeamStationClient({
        baseUrl: `http://127.0.0.1:${port}/api/v1`
      })
      expect(await client.health()).deep.include({
        status: 'ok',
        version: '1.2.3',
        dictation: true,
        dictationModels: ['grok-4.3', 'grok-4.7']
      })

      const plain = express()
      plain.use('/api/v1', healthRoutes(db!, '1.2.3'))
      const bare = plain.listen(0, '127.0.0.1')
      await new Promise<void>(resolve => bare.once('listening', resolve))
      const off = new TeamStationClient({
        baseUrl: `http://127.0.0.1:${(bare.address() as AddressInfo).port}/api/v1`
      })
      expect(await off.health()).deep.include({
        dictation: false,
        dictationModels: []
      })
      bare.close()

      const older = new TeamStationClient({
        baseUrl: 'http://older',
        fetch: async () =>
          new Response(
            JSON.stringify({
              status: 'ok',
              version: '1',
              database: 'ok',
              migrations: 3
            }),
            { status: 200 }
          )
      })
      expect((await older.health()).dictation).equals(false)
    })

    it('reads the dictation block from the server config, with xAI defaults', function () {
      expect(asServerConfig({}).dictation).equals(undefined)
      expect(
        asServerConfig({ dictation: { apiKey: 'k' } }).dictation
      ).deep.equals({
        apiKey: 'k',
        baseUrl: 'https://api.x.ai/v1',
        sttUrl: 'wss://api.x.ai/v1/stt',
        sttModel: 'grok-voice-transcribe-2.0',
        model: 'grok-4.3',
        openai: undefined,
        anthropic: undefined
      })
      // OpenAI's and Anthropic's keys, each at its own address by default.
      expect(
        asServerConfig({
          dictation: {
            apiKey: 'k',
            openai: { apiKey: 'o' },
            anthropic: { apiKey: 'a' }
          }
        }).dictation
      ).deep.include({
        openai: { apiKey: 'o', baseUrl: 'https://api.openai.com/v1' },
        anthropic: { apiKey: 'a', baseUrl: 'https://api.anthropic.com/v1' }
      })
      expect(() => asServerConfig({ dictation: {} })).throws()
    })
  })

  it('registers scoring with the library’s tools and the visible-game check', async function () {
    const scoring = SCOPES.get('scoring')
    // Substitutions are roster commands: the model is offered no lineup tool.
    expect(scoring?.tools.map(tool => tool.name)).not.includes('lineup')
    expect(scoring?.tools).deep.equals(
      toolSchema().filter(tool => tool.name !== 'lineup')
    )
    expect(scoring?.rosterTools).deep.equals(rosterToolSchema())
    expect([...SCOPES.keys()]).deep.equals(['scoring', 'roster'])
    let refused: unknown
    try {
      await scoring?.authorise(
        db!,
        { userId: stranger.userId, isAdmin: false, scopes: [] },
        { gameId: ownGame }
      )
    } catch (error) {
      refused = error
    }
    expect(refused).instanceOf(HttpError)
    expect((refused as HttpError).status).equals(404)
  })

  describe('the roster scope', function () {
    const roster = SCOPES.get('roster')!
    const actor = (user: { userId: number }): Actor => ({
      userId: user.userId,
      isAdmin: false,
      scopes: []
    })
    const refusal = async (
      user: { userId: number },
      target: Record<string, unknown>
    ): Promise<unknown> => {
      try {
        await roster.authorise(db!, actor(user), target)
      } catch (error) {
        return error
      }
      return undefined
    }

    it('offers the roster tools only', function () {
      expect(roster.tools).deep.equals([])
      expect(roster.rosterTools).deep.equals(rosterToolSchema())
    })

    it('admits a scorekeeper of either team, with or without a side', async function () {
      expect(await refusal(scorekeeper, { gameId: ownGame })).equals(undefined)
      expect(
        await refusal(scorekeeper, { gameId: ownGame, side: 'home' })
      ).equals(undefined)
    })

    it('admits a head coach for his own side', async function () {
      expect(await refusal(coach, { gameId: ownGame, side: 'home' })).equals(
        undefined
      )
    })

    it('refuses a head coach with no side or the other side, an assistant and a member', async function () {
      for (const [user, target] of [
        [coach, { gameId: ownGame }],
        [coach, { gameId: ownGame, side: 'away' }],
        [assistant, { gameId: ownGame, side: 'home' }],
        [member, { gameId: ownGame, side: 'home' }]
      ] as const) {
        const error = await refusal(user, target)
        expect(error).instanceOf(HttpError)
        expect((error as HttpError).status).equals(403)
        expect((error as HttpError).message).equals(
          "Only the team's head coach or a scorekeeper may change its lineup"
        )
      }
    })

    it('refuses a game the person cannot see, and a target it cannot read', async function () {
      const hidden = await refusal(stranger, { gameId: ownGame, side: 'home' })
      expect(hidden).instanceOf(HttpError)
      expect((hidden as HttpError).status).equals(404)
      expect(
        await refusal(coach, { gameId: ownGame, side: 'left' })
      ).instanceOf(TypeError)
      expect(await refusal(coach, { side: 'home' })).instanceOf(TypeError)
    })

    it('hands a coach’s sentence the roster tools, and its commands back on the wire', async function () {
      const client = await connect({ authorization: `Bearer ${COACH}` })
      const recogniser = recognisers[recognisers.length - 1]
      client.send(
        start('r1', {
          scope: 'roster',
          target: { gameId: ownGame, side: 'away' }
        })
      )
      expect(await client.next()).deep.equals({
        kind: 'error',
        id: 'r1',
        message:
          "Only the team's head coach or a scorekeeper may change its lineup"
      })
      client.send(
        start('r2', {
          scope: 'roster',
          target: { gameId: ownGame, side: 'home' }
        })
      )
      await settled(recogniser, 'begin')
      client.audio(4)
      client.send({ kind: 'release', id: 'r2' })
      await settled(recogniser, 'end')
      // As said: number 3, the team found by the client.
      const atThird = {
        type: 'setPositions' as const,
        places: [{ player: { jersey: '3' }, position: '3B' as const }]
      }
      script.push({
        kind: 'actions',
        actions: [],
        roster: [atThird],
        dropped: []
      })
      recogniser.handlers.onFinal('Number 3 subs in at third base.')
      await client.next()
      expect(await client.next()).deep.equals({
        kind: 'actions',
        id: 'r2',
        transcript: 'Number 3 subs in at third base.',
        actions: [],
        roster: [atThird],
        dropped: []
      })
      const conversation = conversations[conversations.length - 1]
      expect(conversation.config.tools).deep.equals([])
      expect(conversation.config.rosterTools).deep.equals(rosterToolSchema())
      expect(logs.at(-1)).match(
        /dictation r2 model grok-4\.7 user .+ 0 actions, 1 roster commands, 0 dropped/
      )
      expect(
        logs.some(
          line =>
            line.startsWith('dictation-state r2 ') &&
            line.includes('screen=set roster') &&
            line.includes('model=grok-4.7')
        )
      ).equals(true)
      expect(
        logs.some(
          line =>
            line.includes('"tag":"dictation-reply"') &&
            line.includes('"model":"grok-4.7"') &&
            line.includes('Number 3 subs in at third base.')
        )
      ).equals(true)
      conversation.config.log?.({
        model: 'claude-haiku-5-5',
        messages: [{ role: 'user', content: conversation.transcript }],
        calls: [{ name: 'setPositions', arguments: { jersey: '3' } }],
        said: ''
      })
      expect(
        logs.some(
          line =>
            line.includes('"tag":"dictation-prompt"') &&
            line.includes('"model":"claude-haiku-5-5"') &&
            line.includes(conversation.transcript)
        )
      ).equals(true)
      expect(
        logs.some(
          line =>
            line.includes('"tag":"dictation-calls"') &&
            line.includes('setPositions') &&
            line.includes('claude-haiku-5-5')
        )
      ).equals(true)
      client.ws.close()
    })
  })
})
