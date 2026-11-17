import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, afterEach, before, describe, it } from 'mocha'
import WebSocket from 'ws'

import type { WebSocketConstructor } from '../../common/gameSocket'
import { makeId } from '../../common/ids'
import {
  asSearchServerFrame,
  SEARCH_FRAME_MAX_BYTES,
  SEARCH_SOCKET_PATH,
  type SearchAsk,
  type SearchResultsFrame,
  type SearchServerFrame
} from '../../common/search/types'
import { SearchSocket } from '../../common/searchSocket'
import { type FakeJev, fakeJev } from '../../test/fakeJev'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import {
  fixtureUserId,
  insertFixtureUsers
} from '../../test/insertFixtureUsers'
import { databaseUrlOf } from '../../test/screenScopeNotices'
import { createSession, revokeSession } from '../auth/sessions'
import { SESSION_COOKIE } from '../auth/tokens'
import type { Database } from '../db/database'
import { bindUpgrades, claimUpgrade } from '../socket/bindUpgrades'
import { attachGameSocket } from '../socket/gameSocket'
import {
  attachSearchSocket,
  type SearchSocketHandle,
  type SearchSocketOptions,
  SIGNED_OUT_CLOSE
} from './socket'

/**
 * The search socket on a real server, port 0, against a real database and
 * the fake Jev. Most cases shorten the Jev delay to keep the suite quick;
 * one keeps the real second.
 */

const ALLOWED_ORIGIN = 'https://app.example.test'
const SHORT_DELAY_MS = 60

interface Client {
  ws: WebSocket
  frames: Array<{ at: number; frame: SearchServerFrame }>
  next: (timeoutMs?: number) => Promise<SearchServerFrame>
  send: (frame: object | string) => void
  closed: Promise<number>
}

const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const ask = (text: string, more: Partial<SearchAsk> = {}): SearchAsk => ({
  text,
  location: null,
  mode: 'all',
  ...more
})

/** A database that throws `error` on every use. */
const unreachable = (error: Error): Kysely<Database> =>
  new Proxy({} as unknown as Kysely<Database>, {
    get() {
      throw error
    }
  })

/** `db`, except that reading `table` throws `error`. */
const failingTable = (
  db: Kysely<Database>,
  table: string,
  error: Error
): Kysely<Database> =>
  new Proxy(db, {
    get(target, prop) {
      if (prop === 'selectFrom')
        return (from: unknown) => {
          if (from === table) throw error
          return (target.selectFrom as (from: unknown) => unknown)(from)
        }
      const value: unknown = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })

const names = (frame: SearchServerFrame): string[] =>
  frame.type === 'results' ? frame.results.map(result => result.name) : []

describe('search socket', function () {
  this.timeout(60000)

  let f: GroupFixture
  let jev: FakeJev
  let socketUrl: string
  let detach: () => void
  let handle: SearchSocketHandle
  let options: Omit<SearchSocketOptions, 'db' | 'deps'> = {}
  /** The database the socket reads, when a case swaps in a failing one. */
  let mountedDb: Kysely<Database> | undefined
  const open: Client[] = []

  /** The socket with these options, in place of the last. */
  function mount(
    more: Omit<SearchSocketOptions, 'db' | 'deps'> = {},
    db?: Kysely<Database>
  ): void {
    detach?.()
    handle?.close()
    options = more
    mountedDb = db
    handle = attachSearchSocket({
      db: db ?? f.h.db,
      deps: {
        space: f.h.space,
        jevBaseUrl: jev.baseUrl,
        log: () => undefined
      },
      allowedOrigins: [ALLOWED_ORIGIN],
      jevDelayMs: SHORT_DELAY_MS,
      log: () => undefined,
      ...options
    })
    detach = bindUpgrades(f.h.server, [
      (req, socket, head) => handle.acceptUpgrade(req, socket, head)
    ])
  }

  async function connect(
    headers: Record<string, string> = {}
  ): Promise<Client> {
    const ws = new WebSocket(socketUrl, { headers })
    const frames: Client['frames'] = []
    const waiting: Array<(frame: SearchServerFrame) => void> = []
    let read = 0
    ws.on('message', data => {
      const frame = asSearchServerFrame(
        JSON.parse((data as Buffer).toString('utf8'))
      )
      frames.push({ at: Date.now(), frame })
      waiting.shift()?.(frame)
    })
    const closed = new Promise<number>(resolve => {
      ws.on('close', code => {
        resolve(code)
      })
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        resolve()
      })
      ws.once('error', reject)
    })
    const client: Client = {
      ws,
      frames,
      closed,
      next: async (timeoutMs = 5000) => {
        if (read < frames.length) return frames[read++].frame
        return await new Promise<SearchServerFrame>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('No frame arrived'))
          }, timeoutMs)
          waiting.push(frame => {
            clearTimeout(timer)
            read++
            resolve(frame)
          })
        })
      },
      send: frame => {
        ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame))
      }
    }
    open.push(client)
    return client
  }

  const search = (
    client: Client,
    seq: number,
    text: string,
    more: Partial<SearchAsk> = {}
  ): void => {
    client.send({ type: 'search', seq, ...ask(text, more) })
  }

  const bearer = (token: string): Record<string, string> => ({
    authorization: `Bearer ${token}`
  })

  before(async () => {
    f = await groupFixture()
    // Each case mounts its own socket in place of the harness's.
    f.h.detachSearchSocket()
    jev = await fakeJev()
    socketUrl = `ws://127.0.0.1:${(f.h.server.address() as AddressInfo).port}${SEARCH_SOCKET_PATH}`
    await insertFixtureUsers(f.h.db, {
      id: 410,
      legacyId: 'usr_socket_410',
      display_name: 'Mookie Betts',
      first_name: 'Mookie',
      last_name: 'Betts'
    })
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: fixtureUserId(410),
        team_id: f.teamA,
        role: 'member',
        is_player: true
      })
      .execute()
    await f.h.db
      .insertInto('system_settings')
      .values({ key: 'jev.apiKey', value: JSON.stringify('ts-socket-key') })
      .execute()
    mount()
  })

  after(async () => {
    detach?.()
    handle?.close()
    await jev?.close()
    await f?.h.close()
  })

  afterEach(async () => {
    for (const client of open.splice(0)) client.ws.close()
    jev.reset()
    if (Object.keys(options).length > 0 || mountedDb != null) mount()
    await pause(20)
  })

  it('answers a signed-out reader with organizations and no people', async () => {
    const client = await connect()
    search(client, 1, 'demo')
    const first = (await client.next()) as SearchResultsFrame
    expect(first).include({ type: 'results', seq: 1, stage: 'lexicographic' })
    expect(names(first)).include.members(['Demo Hawks', 'Demo Eagles'])
    expect(
      first.results.every(
        result => result.kind !== 'person' && result.follow == null
      )
    ).equals(true)
    search(client, 2, 'mookie betts')
    expect(names(await client.next())).deep.equals([])
  })

  it('answers a signed-in reader, by bearer or cookie, with people in reach and Follow pills', async () => {
    const token = f.h.tokens.get(101)!
    for (const headers of [
      bearer(token),
      { cookie: `${SESSION_COOKIE}=${token}` }
    ]) {
      const client = await connect(headers)
      search(client, 1, 'mookie betts')
      const people = (await client.next()) as SearchResultsFrame
      expect(people.results.map(result => result.kind)).deep.equals(['person'])
      expect(names(people)).deep.equals(['Mookie Betts'])
      search(client, 2, 'demo eagles')
      const groups = (await client.next()) as SearchResultsFrame
      const eagles = groups.results.find(
        result => result.name === 'Demo Eagles'
      )
      expect(eagles).include({ kind: 'team', follow: 'follow' })
    }
  })

  it('closes with 4401 at once on a bearer token that signs nobody in, and leaves the app’s client unauthorized', async () => {
    const client = await connect(bearer('tok_nobody_000000000000000000000'))
    expect(await client.closed).equals(SIGNED_OUT_CLOSE)
    expect(client.frames).length(0)
    // A session that ended before the socket opened is refused alike.
    const ended = await createSession(
      f.h.db,
      fixtureUserId(101),
      'search-socket-test'
    )
    await revokeSession(f.h.db, ended.token)
    const app = new SearchSocket({
      url: socketUrl,
      token: () => ended.token,
      WebSocketImpl: WebSocket as unknown as WebSocketConstructor
    })
    const statuses: string[] = []
    app.onStatus(status => statuses.push(status))
    try {
      app.search(ask('mookie betts'))
      while (app.status !== 'unauthorized') await pause(20)
      expect(statuses).deep.equals(['open', 'unauthorized'])
    } finally {
      app.close()
    }
  })

  it('reads a session cookie that signs nobody in as signed out, with organizations and no people', async () => {
    const revoked = await createSession(
      f.h.db,
      fixtureUserId(101),
      'search-socket-test'
    )
    await revokeSession(f.h.db, revoked.token)
    for (const cookie of [
      `${SESSION_COOKIE}=${revoked.token}`,
      `${SESSION_COOKIE}=tok_nobody_000000000000000000000`
    ]) {
      const client = await connect({ cookie })
      search(client, 1, 'demo')
      const first = (await client.next()) as SearchResultsFrame
      expect(names(first)).include.members(['Demo Hawks', 'Demo Eagles'])
      expect(
        first.results.every(
          result => result.kind !== 'person' && result.follow == null
        )
      ).equals(true)
      search(client, 2, 'mookie betts')
      expect(names(await client.next())).deep.equals([])
    }
  })

  it('closes with 4401 on a bearer token that signs nobody in, though a good cookie comes with it', async () => {
    const client = await connect({
      ...bearer('tok_nobody_000000000000000000000'),
      cookie: `${SESSION_COOKIE}=${f.h.tokens.get(101)!}`
    })
    expect(await client.closed).equals(SIGNED_OUT_CLOSE)
    expect(client.frames).length(0)
  })

  it('refuses a page from another origin before reading a session, and admits its own', async () => {
    const status = await new Promise<number>(resolve => {
      const ws = new WebSocket(socketUrl, {
        headers: {
          origin: 'https://elsewhere.example.test',
          ...bearer(f.h.tokens.get(101)!)
        }
      })
      ws.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0)
      })
      ws.on('error', () => undefined)
    })
    expect(status).equals(403)
    const client = await connect({ origin: `${ALLOWED_ORIGIN}/` })
    search(client, 1, 'demo hawks')
    expect(names(await client.next())).include('Demo Hawks')
  })

  it('leaves other paths to the next claim', async () => {
    const status = await new Promise<number>(resolve => {
      const ws = new WebSocket(socketUrl.replace(SEARCH_SOCKET_PATH, '/nope'))
      ws.on('error', () => {
        resolve(-1)
      })
    })
    expect(status).equals(-1)
  })

  it('answers an empty field with nothing and asks Jev nothing', async () => {
    const client = await connect()
    search(client, 1, '   ')
    expect(await client.next()).deep.equals({
      type: 'results',
      seq: 1,
      stage: 'lexicographic',
      results: [],
      locations: []
    })
    await pause(SHORT_DELAY_MS * 4)
    expect(client.frames).length(1)
    expect(jev.requests).length(0)
  })

  it('sends Jev’s order a second after the last frame, once, for the latest seq', async () => {
    mount({ jevDelayMs: undefined })
    jev.setNouls({ 'Demo Eagles': 0.99, 'Demo Hawks': 0.01 }, 0.5)
    const client = await connect()
    const start = Date.now()
    search(client, 1, 'demo')
    const first = (await client.next()) as SearchResultsFrame
    expect(first.stage).equals('lexicographic')
    expect(Date.now() - start).lessThan(900)
    await pause(300)
    search(client, 2, 'demo ')
    const lastAt = Date.now()
    const second = (await client.next()) as SearchResultsFrame
    expect(second).include({ seq: 2, stage: 'lexicographic' })
    expect(jev.requests).length(0)
    const ranked = (await client.next(3000)) as SearchResultsFrame
    expect(ranked).include({ seq: 2, stage: 'jev' })
    const waited = client.frames[2].at - lastAt
    expect(waited).within(950, 2000)
    expect(names(ranked)[0]).equals('Demo Eagles')
    expect(names(ranked).indexOf('Demo Hawks')).greaterThan(
      names(ranked).indexOf('Demo Eagles')
    )
    expect(jev.requests).length(1)
    await pause(300)
    expect(client.frames).length(3)
  })

  it('cancels the Jev call in flight when a newer frame arrives', async () => {
    jev.delay(600)
    const client = await connect()
    search(client, 1, 'demo')
    expect(await client.next()).include({ seq: 1, stage: 'lexicographic' })
    await pause(SHORT_DELAY_MS + 150)
    expect(jev.requests).length(1)
    search(client, 2, 'demo hawks')
    expect(await client.next()).include({ seq: 2, stage: 'lexicographic' })
    expect(await client.next(3000)).include({ seq: 2, stage: 'jev' })
    await pause(800)
    expect(
      client.frames.map(({ frame }) =>
        frame.type === 'results' ? `${frame.seq}:${frame.stage}` : frame.type
      )
    ).deep.equals(['1:lexicographic', '2:lexicographic', '2:jev'])
  })

  it('never delivers a stale seq after a newer one', async () => {
    const client = await connect(bearer(f.h.tokens.get(101)!))
    for (let seq = 1; seq <= 6; seq++) search(client, seq, 'demo'.slice(0, seq))
    await pause(SHORT_DELAY_MS + 1000)
    const seqs = client.frames.map(({ frame }) =>
      frame.type === 'results' ? frame.seq : -1
    )
    expect(seqs.at(-1)).equals(6)
    for (let at = 1; at < seqs.length; at++)
      expect(seqs[at]).at.least(seqs[at - 1])
    const jevAnswers = client.frames.filter(
      ({ frame }) => frame.type === 'results' && frame.stage === 'jev'
    )
    expect(jevAnswers.map(({ frame }) => frame.seq)).deep.equals([6])
  })

  it('searches one frame at a time, and only the newest that waited', async () => {
    // Every query waits, so that frames arrive while a search runs. Each
    // search reads the leagues, seasons and teams once each, by one query
    // per kind; what it reads of the reader the socket keeps.
    let kinds = 0
    const counting = f.h.db.withPlugin({
      transformQuery: args => {
        const node = args.node as { kind: string; sqlFragments?: string[] }
        if (
          node.kind === 'RawNode' &&
          (node.sqlFragments ?? []).join('').includes('with src as')
        )
          kinds++
        return args.node
      },
      transformResult: async args => {
        await pause(40)
        return args.result
      }
    })
    mount({}, counting)
    const client = await connect(bearer(f.h.tokens.get(101)!))
    search(client, 1, 'demo')
    await pause(20)
    for (let seq = 2; seq <= 6; seq++) {
      search(client, seq, `demo ${'hawks'.slice(0, seq - 1)}`)
      await pause(10)
    }
    const answer = await client.next(10000)
    // The first frame's answer was out of date before it was ready.
    expect(answer).include({ seq: 6, stage: 'lexicographic' })
    expect(names(answer)).include('Demo Hawks')
    expect(await client.next(10000)).include({ seq: 6, stage: 'jev' })
    expect(kinds / 3).equals(2)
    expect(client.frames).length(2)
  })

  it('keeps Jev’s failure out of the answer', async () => {
    jev.fail(529)
    const client = await connect()
    search(client, 1, 'demo')
    expect(await client.next()).include({ stage: 'lexicographic' })
    await pause(SHORT_DELAY_MS + 300)
    expect(jev.requests).length(1)
    expect(client.frames).length(1)
  })

  it('answers an oversized or unreadable frame with an error and stays open', async () => {
    const client = await connect()
    client.send(
      JSON.stringify({
        type: 'search',
        seq: 1,
        ...ask('x'.repeat(SEARCH_FRAME_MAX_BYTES))
      })
    )
    expect(await client.next()).deep.include({
      type: 'error',
      code: 'tooLarge'
    })
    client.send('not json')
    expect(await client.next()).include({ type: 'error', code: 'malformed' })
    client.send({ type: 'search', seq: 2, text: 'demo' })
    const unreadable = await client.next()
    expect(unreadable).include({ type: 'error', seq: 2, code: 'malformed' })
    // A frame that is not even an object carries no seq to answer.
    client.send('5')
    expect(await client.next()).deep.include({
      type: 'error',
      code: 'malformed'
    })
    expect(client.frames.at(-1)!.frame).not.have.property('seq')
    client.ws.send(Buffer.from('{}'), { binary: true })
    expect(await client.next()).include({ type: 'error', code: 'malformed' })
    search(client, 3, 'demo hawks')
    expect(names(await client.next())).include('Demo Hawks')
    // Past four times the limit, the socket is closed.
    client.send('x'.repeat(SEARCH_FRAME_MAX_BYTES * 4 + 1))
    expect(await client.closed).equals(1009)
  })

  it('answers a team the reader may not add players to with an error frame', async () => {
    const client = await connect(bearer(f.h.tokens.get(101)!))
    search(client, 1, 'mookie', { mode: 'people', forTeam: 'tem_missing' })
    expect(await client.next()).deep.equals({
      type: 'error',
      seq: 1,
      code: 'notFound',
      message: 'Not found'
    })
  })

  it('closes with 4401 once the session is revoked', async () => {
    const { token } = await createSession(
      f.h.db,
      fixtureUserId(101),
      'search-socket-test'
    )
    const client = await connect(bearer(token))
    search(client, 1, 'mookie betts')
    expect(names(await client.next())).deep.equals(['Mookie Betts'])
    await revokeSession(f.h.db, token)
    search(client, 2, 'mookie betts')
    expect(await client.closed).equals(SIGNED_OUT_CLOSE)
    expect(client.frames).length(1)
  })

  it('leaves the app’s client unauthorized at 4401, with no reconnect on the dead token, until a new sign-in', async () => {
    const dead = await createSession(
      f.h.db,
      fixtureUserId(101),
      'search-socket-test'
    )
    let token = dead.token
    let opened = 0
    const Counting = class extends WebSocket {
      constructor(
        url: string,
        protocols?: string | string[],
        options?: WebSocket.ClientOptions
      ) {
        super(url, protocols, options)
        opened++
      }
    }
    const client = new SearchSocket({
      url: socketUrl,
      token: () => token,
      WebSocketImpl: Counting as unknown as WebSocketConstructor
    })
    const statuses: string[] = []
    const answers: string[][] = []
    client.onStatus(status => statuses.push(status))
    const status = (): string => client.status
    client.onResults(each =>
      answers.push(
        each.results.flatMap(result =>
          result.kind === 'person' ? [result.name] : []
        )
      )
    )
    try {
      client.search(ask('mookie betts'))
      while (answers.length === 0) await pause(20)
      await revokeSession(f.h.db, dead.token)
      client.search(ask('mookie betts'))
      while (status() !== 'unauthorized') await pause(20)
      // Past the first reconnect's second: nothing opened with the dead token.
      await pause(1300)
      expect(opened).equals(1)
      const fresh = await createSession(
        f.h.db,
        fixtureUserId(101),
        'search-socket-test'
      )
      token = fresh.token
      while (status() !== 'open') await pause(20)
      expect(opened).equals(2)
      while (answers.length < 2) await pause(20)
      expect(answers.at(-1)).deep.equals(['Mookie Betts'])
      expect(statuses).deep.equals(['open', 'unauthorized', 'open'])
    } finally {
      client.close()
    }
  })

  it('refuses an upgrade it cannot sign in: 503 while the database is out of reach, else 500', async () => {
    const statusOf = async (headers: Record<string, string>): Promise<number> =>
      await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(socketUrl, { headers })
        ws.on('unexpected-response', (_request, response) => {
          resolve(response.statusCode ?? 0)
          ws.terminate()
        })
        ws.on('open', () => {
          reject(new Error('It opened'))
        })
        ws.on('error', () => undefined)
      })
    const token = bearer(f.h.tokens.get(101)!)
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED'
    })
    const said: string[] = []
    mount({ log: line => said.push(line) }, unreachable(refused))
    expect(await statusOf(token)).equals(503)
    mount({ log: line => said.push(line) }, unreachable(new Error('broken')))
    expect(await statusOf(token)).equals(500)
    expect(said.every(line => line.includes('signing in an upgrade'))).equals(
      true
    )
    expect(said).length(2)
  })

  it('answers a search that fails inside the server with internal, and writes it to the default log', async () => {
    const written: string[] = []
    const original = console.error
    console.error = (...line: unknown[]) => {
      written.push(line.map(String).join(' '))
    }
    try {
      // The socket's own log is the default one.
      detach?.()
      handle?.close()
      mountedDb = unreachable(new Error('broken'))
      options = {}
      handle = attachSearchSocket({
        db: mountedDb,
        deps: { space: f.h.space, jevBaseUrl: jev.baseUrl },
        jevDelayMs: SHORT_DELAY_MS
      })
      detach = bindUpgrades(f.h.server, [
        (req, socket, head) => handle.acceptUpgrade(req, socket, head)
      ])
      const client = await connect()
      search(client, 1, 'demo')
      expect(await client.next()).deep.equals({
        type: 'error',
        seq: 1,
        code: 'internal',
        message: 'The server could not search; try again'
      })
      await pause(SHORT_DELAY_MS + 100)
      expect(client.frames).length(1)
    } finally {
      console.error = original
    }
    expect(
      written.some(line => line.includes('search 1: Error: broken'))
    ).equals(true)
  })

  it('logs a Jev ranking that throws and keeps the lexicographic answer', async () => {
    const said: string[] = []
    mount(
      { log: line => said.push(line) },
      failingTable(f.h.db, 'system_settings', new Error('settings unreadable'))
    )
    const client = await connect()
    search(client, 1, 'demo')
    expect(await client.next()).include({ seq: 1, stage: 'lexicographic' })
    await pause(SHORT_DELAY_MS + 300)
    expect(client.frames).length(1)
    expect(said).deep.equals([
      'search socket: jev 1: Error: settings unreadable'
    ])
  })

  it('pings: a socket that answers stays, one that misses two pings is closed', async () => {
    mount({ pingMs: 40 })
    const answering = await connect()
    const silent = new WebSocket(socketUrl, { autoPong: false })
    const silentClosed = new Promise<number>(resolve => {
      silent.on('close', code => {
        resolve(code)
      })
    })
    await new Promise<void>((resolve, reject) => {
      silent.once('open', () => {
        resolve()
      })
      silent.once('error', reject)
    })
    expect(await silentClosed).equals(1006)
    expect(answering.ws.readyState).equals(WebSocket.OPEN)
    // The server forgets the closed one once its close event runs.
    for (let tries = 0; handle.size() > 1 && tries < 50; tries++)
      await pause(20)
    expect(handle.size()).equals(1)
  })

  it('closes every socket when it stops', async () => {
    const client = await connect()
    expect(handle.size()).equals(1)
    mount()
    expect(await client.closed).equals(1001)
  })
})

describe('the account harness’s search socket', function () {
  this.timeout(60000)

  it('answers the search path as the server does, beside a fixture’s own socket', async () => {
    const f = await groupFixture()
    try {
      const ws = new WebSocket(
        `${f.h.origin.replace(/^http/, 'ws')}${SEARCH_SOCKET_PATH}`,
        {
          headers: {
            authorization: `Bearer ${f.h.tokens.get(101)!}`,
            origin: f.h.origin
          }
        }
      )
      const answer = new Promise<SearchServerFrame>((resolve, reject) => {
        ws.once('message', data => {
          resolve(
            asSearchServerFrame(JSON.parse((data as Buffer).toString('utf8')))
          )
        })
        ws.once('error', reject)
      })
      await new Promise(resolve => ws.once('open', resolve))
      ws.send(JSON.stringify({ type: 'search', seq: 1, ...ask('demo hawks') }))
      const frame = await answer
      expect(frame).include({ seq: 1, stage: 'lexicographic' })
      expect(names(frame)).include('Demo Hawks')
      ws.close()
      // Any other path is left for another listener: here, nobody's.
      const other = new WebSocket(
        `${f.h.origin.replace(/^http/, 'ws')}/socket-elsewhere`
      )
      f.h.server.once('upgrade', (_req, socket) => {
        socket.end('HTTP/1.1 418 Teapot\r\nContent-Length: 0\r\n\r\n')
      })
      const refused = await new Promise<string>(resolve => {
        other.once('unexpected-response', (_req, res) => {
          resolve(String(res.statusCode))
        })
        other.once('error', error => {
          resolve(String(error))
        })
      })
      expect(refused).equals('418')
    } finally {
      await f.h.close()
    }
  })

  it('destroys an upgrade nobody takes at once, as Node does with no listener', async () => {
    const f = await groupFixture()
    try {
      expect(f.h.server.listenerCount('upgrade')).equals(1)
      const started = Date.now()
      const game = new WebSocket(`${wsOrigin(f)}/socket`, {
        headers: { authorization: `Bearer ${f.h.tokens.get(101)!}` }
      })
      const ended = await new Promise<string>(resolve => {
        game.once('open', () => {
          resolve('open')
        })
        game.once('unexpected-response', (_req, res) => {
          resolve(String(res.statusCode))
        })
        game.once('error', () => {
          resolve('error')
        })
      })
      expect(ended).equals('error')
      expect(Date.now() - started).below(1000)
    } finally {
      await f.h.close()
    }
  })

  it('answers the game socket and the search socket side by side', async () => {
    const f = await groupFixture()
    const game = attachGameSocket(
      f.h.server,
      f.h.db,
      await databaseUrlOf(f.h.db),
      { stopSignals: null }
    )
    try {
      const token = f.h.tokens.get(101)!
      // The game listener, after the harness's, writes no 404 onto the
      // search socket's handshake.
      const search = await opened(
        new WebSocket(`${wsOrigin(f)}${SEARCH_SOCKET_PATH}`, {
          headers: { authorization: `Bearer ${token}`, origin: f.h.origin }
        })
      )
      const answer = new Promise<SearchServerFrame>(resolve => {
        search.once('message', data => {
          resolve(
            asSearchServerFrame(JSON.parse((data as Buffer).toString('utf8')))
          )
        })
      })
      search.send(
        JSON.stringify({ type: 'search', seq: 1, ...ask('demo hawks') })
      )
      expect(names(await answer)).include('Demo Hawks')
      // The harness waits for the game listener rather than destroying it.
      const socket = await opened(
        new WebSocket(`${wsOrigin(f)}/socket`, {
          headers: { authorization: `Bearer ${token}` }
        })
      )
      expect(socket.readyState).equals(WebSocket.OPEN)
      // A path neither takes is still answered: the game listener's 404.
      const elsewhere = new WebSocket(`${wsOrigin(f)}/socket-elsewhere`)
      const refused = await new Promise<string>(resolve => {
        elsewhere.once('unexpected-response', (_req, res) => {
          resolve(String(res.statusCode))
        })
        elsewhere.once('error', () => {
          resolve('error')
        })
      })
      expect(['404', 'error']).include(refused)
      search.close()
      socket.close()
    } finally {
      await game.close()
      await f.h.close()
    }
  })

  it('closes with a search socket open and an upgrade left hanging', async () => {
    const f = await groupFixture()
    // A listener that takes its path and never answers it.
    f.h.server.on('upgrade', (req, socket) => {
      if (req.url === '/hangs') claimUpgrade(socket)
    })
    const search = await opened(
      new WebSocket(`${wsOrigin(f)}${SEARCH_SOCKET_PATH}`, {
        headers: { origin: f.h.origin }
      })
    )
    const searchClosed = new Promise(resolve => search.once('close', resolve))
    const hanging = new WebSocket(`${wsOrigin(f)}/hangs`)
    const hangingEnded = new Promise(resolve => {
      hanging.once('error', resolve)
      hanging.once('close', resolve)
    })
    hanging.on('error', () => undefined)
    // The server has the hanging upgrade before the close starts.
    await pause(200)
    expect(hanging.readyState).equals(WebSocket.CONNECTING)
    let timer: NodeJS.Timeout | undefined
    const closed = await Promise.race([
      f.h.close().then(() => 'closed'),
      new Promise<string>(resolve => {
        timer = setTimeout(() => {
          resolve('still open')
        }, 5000)
      })
    ])
    clearTimeout(timer)
    expect(closed).equals('closed')
    await searchClosed
    await hangingEnded
  })
})

function wsOrigin(f: GroupFixture): string {
  return f.h.origin.replace(/^http/, 'ws')
}

async function opened(ws: WebSocket): Promise<WebSocket> {
  return await new Promise((resolve, reject) => {
    ws.once('open', () => {
      resolve(ws)
    })
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`upgrade answered ${String(res.statusCode)}`))
    })
  })
}
