import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { type AddressInfo, createServer, type Server, Socket } from 'node:net'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Agent } from 'undici'
import { WebSocketServer } from 'ws'

import type { ScoringSession } from '../../src/common/scoring/session'
import type { GameState } from '../../src/common/scoring/state'
import {
  CAMERAS_PER_PERSON,
  finishBatter,
  follow,
  HttpError,
  mintStream,
  paced,
  placingConnector,
  Publishers,
  requireServerHost,
  reachable,
  readsFor,
  request,
  RestReaders,
  Scorekeeper,
  serverFor,
  SocketViewer,
  spawnTestPattern,
  Tally
} from './actors'
import { type SeededAccount, seedFixture, type TokensFile } from './fixture'
import { buildReport, renderReport } from './report'
import { TEST_AMOUNTS } from './testAmounts'
import {
  openScratch,
  type Scratch,
  startTestServer,
  type TestServer
} from './testSupport'

/** A server on a free local port, and its base URL. */
const listening = async (
  server: Pick<Server, 'listen' | 'address'>,
  scheme = 'http'
): Promise<string> => {
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return `${scheme}://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const waitFor = async (
  check: () => boolean,
  timeoutMs = 15_000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting')
    await new Promise(resolve => {
      setTimeout(resolve, 20)
    })
  }
}

describe('the actors', function () {
  this.timeout(120_000)

  let scratch: Scratch
  let server: TestServer
  let tokens: TokensFile

  const account = (label: string): SeededAccount => {
    const found = tokens.accounts.find(row => row.label === label)
    if (found == null) throw new Error(`no account ${label}`)
    return found
  }

  before(async function () {
    scratch = await openScratch('actors')
    tokens = await seedFixture(scratch.db, {
      runId: 'actors',
      scale: 'small',
      overrides: TEST_AMOUNTS
    })
    server = await startTestServer(scratch)
  })
  after(async function () {
    await server.close()
    await scratch.drop()
  })

  describe('publishers', function () {
    it('mint a key as a seeded videographer through the real routes', async function () {
      const tally = new Tally()
      const videographer = account('videographer00000')
      const game = tokens.games[videographer.gameIndex ?? 0]
      const stream = await mintStream(server.base, videographer, game.id, tally)
      expect(stream.url).matches(/^rtmp:\/\/.+\/.+/)
      const row = await scratch.db
        .selectFrom('live_streams')
        .select(['game_id', 'user_id'])
        .where('id', '=', stream.streamId)
        .executeTakeFirstOrThrow()
      expect(row.game_id).equals(game.id)
      expect(row.user_id).equals(videographer.userId)
      expect(tally.requests.map(request_ => request_.route)).deep.equals([
        'POST /games/:id/live-streams',
        'POST /games/:id/live-streams/:id/reveal'
      ])
    })

    it('are refused as a scorekeeper without the role', async function () {
      const game = tokens.games[0]
      let refused: unknown
      await mintStream(
        server.base,
        account(game.scorekeeper),
        game.id,
        new Tally()
      ).catch((error: unknown) => {
        refused = error
      })
      expect(refused).instanceOf(HttpError)
      expect((refused as HttpError).status).equals(404)
    })

    it('hold each videographer to four cameras, and start a pattern on each', async function () {
      const tally = new Tally()
      const started: string[] = []
      const publishers = new Publishers(
        [server.base],
        { ...tokens, accounts: [account('videographer00001')] },
        tally,
        CAMERAS_PER_PERSON,
        5,
        url => {
          started.push(url)
          return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'])
        }
      )
      await publishers.start()
      expect(started.length).equals(4)
      expect(new Set(started).size).equals(4)
      expect(tally.streamsStarted).equals(4)
      publishers.stop()
      await Promise.all(
        publishers.children.map(
          async child =>
            await new Promise(resolve => {
              if (child.exitCode != null || child.signalCode != null) resolve(0)
              child.on('exit', resolve)
            })
        )
      )
      expect(publishers.children.every(child => child.killed)).equals(true)

      // The route refuses the fifth, and it is counted rather than thrown.
      const over = new Tally()
      const more = new Publishers(
        [server.base],
        { ...tokens, accounts: [account('videographer00001')] },
        over,
        1,
        5,
        () => {
          throw new Error('not reached')
        }
      )
      await more.start()
      expect(over.errors['http-400']).equals(1)
    })

    it('refuse more streams than the seeded people may hold', async function () {
      const publishers = new Publishers(
        [server.base],
        tokens,
        new Tally(),
        5 * CAMERAS_PER_PERSON + 1,
        5
      )
      let message = ''
      await publishers.start().catch((error: Error) => {
        message = error.message
      })
      expect(message).contains('--streams 21 is above the 20')
    })

    it('start no pattern for a stream URL on another host, and say whose', async function () {
      const started: string[] = []
      // The server's own name is 127.0.0.1, and the rig knows it as localhost.
      const publishers = new Publishers(
        [server.base.replace('127.0.0.1', 'localhost')],
        { ...tokens, accounts: [account('videographer00002')] },
        new Tally(),
        1,
        5,
        url => {
          started.push(url)
          throw new Error('not reached')
        }
      )
      let message = ''
      await publishers.start().catch((error: Error) => {
        message = error.message
      })
      expect(started).deep.equals([])
      expect(publishers.minted).deep.equals([])
      expect(message).contains('stream URL for 127.0.0.1')
      expect(message).contains('--server host (localhost)')
      expect(message).contains('primaryUrlOverride')
      expect(message).not.contains('ts_')
    })

    it('take a stream URL on any of the server hosts, in any case', function () {
      const servers = [
        'http://Node1.example.test:9100',
        'https://node2.example.test'
      ]
      requireServerHost('rtmp://NODE2.example.test:1936/live/ts_key', servers)
      requireServerHost('rtmp://node1.example.test/live/ts_key', servers)
      expect(() => {
        requireServerHost('rtmp://production.example.test/live/ts_key', servers)
      }).throws('stream URL for production.example.test')
      expect(() => {
        requireServerHost('not a url', servers)
      }).throws('stream URL for something unreadable')
    })

    it('push the repository test pattern', async function () {
      const child = spawnTestPattern('rtmp://127.0.0.1:1/live/none', 1)
      const code = await new Promise(resolve => {
        child.on('exit', resolve)
      })
      expect(code).not.equals(undefined)
    })
  })

  describe('a scorekeeper and a viewer', function () {
    it('deliver a pitch through a real post, a real socket and a real frame', async function () {
      const tally = new Tally()
      const game = tokens.games[2]
      const viewer = new SocketViewer(
        server.base,
        account('person.admin'),
        game.id,
        tally
      )
      viewer.start()
      await waitFor(() => tally.socketsOpened === 1)
      // Long enough for the subscribe to be answered before the post.
      await new Promise(resolve => {
        setTimeout(resolve, 300)
      })
      const keeper = new Scorekeeper(
        server.base,
        account(game.scorekeeper),
        game,
        tally,
        20
      )
      await keeper.open()
      await keeper.pitch()
      await waitFor(() => tally.framesDelivered > 0)
      expect(tally.postMs.length).equals(1)
      expect(tally.deliveryLagMs.length).above(0)
      expect(tally.errors).deep.equals({})
      // On a timer it goes on until told to stop, and each scorer's tap posts.
      keeper.start()
      await waitFor(() => tally.postMs.length >= 4)
      keeper.stop()
      viewer.stop()
    })

    it('score on in the long game, which holds every record version', async function () {
      const tally = new Tally()
      const game = tokens.games[tokens.games.length - 1]
      const keeper = new Scorekeeper(
        server.base,
        account(game.scorekeeper),
        game,
        tally,
        1000
      )
      await keeper.open()
      for (let i = 0; i < 2; i++) await keeper.pitch()
      // Answered only its edits, it keeps the digests they carry: the game
      // as a read gives it now is the one it left.
      const read = (await request(
        server.base,
        account(game.scorekeeper),
        'GET',
        `/games/${game.id}/events`
      )) as { playsDigest: string; lineupsDigest: string }
      const session = (keeper as unknown as { session: ScoringSession }).session
      expect(session.holdsPlays(read.playsDigest)).equals(true)
      expect(session.holdsLineups(read.lineupsDigest)).equals(true)
      keeper.stop()
      expect(tally.errors).deep.equals({})
      expect(tally.postMs.length).at.least(2)
    })

    it('walks out a batter a previous run left at the plate', async function () {
      const tally = new Tally()
      const game = tokens.games[3]
      const scorer = account(game.scorekeeper)
      const first = new Scorekeeper(server.base, scorer, game, tally, 1000)
      await first.open()
      const inner = first as unknown as { queue: unknown[] }
      inner.queue = [{ type: 'pitch', call: 'B' }]
      await first.pitch()
      first.stop()
      const next = new Scorekeeper(server.base, scorer, game, tally, 1000)
      await next.open()
      for (let i = 0; i < 6; i++) await next.pitch()
      next.stop()
      expect(tally.errors).deep.equals({})
    })

    it('knows what ends a batter at any count', function () {
      const stateAt = (balls: number, strikes: number): GameState =>
        ({
          liveData: { plays: { currentPlay: { count: { balls, strikes } } } }
        }) as unknown as GameState
      expect(finishBatter(stateAt(0, 0))).deep.equals([])
      expect(finishBatter(stateAt(4, 0)).length).equals(1)
      expect(finishBatter(stateAt(0, 3)).length).equals(1)
      expect(finishBatter(stateAt(1, 2)).length).equals(4)
    })

    it('counts a scorer who cannot score, and cannot pitch before opening', async function () {
      const game = tokens.games[3]
      const tally = new Tally()
      const keeper = new Scorekeeper(
        server.base,
        account('person.stranger'),
        game,
        tally,
        10
      )
      let message = ''
      await keeper.pitch().catch((error: Error) => {
        message = error.message
      })
      expect(message).contains('has not opened')
      let refused: unknown
      await keeper.open().catch((error: unknown) => {
        refused = error
      })
      expect(refused).instanceOf(HttpError)
      expect((refused as HttpError).status).equals(404)

      const stopped = new Tally()
      const real = new Scorekeeper(
        server.base,
        account(game.scorekeeper),
        game,
        stopped,
        10
      )
      await real.open()
      // The token is gone mid-run: each tick fails, and each failure is counted.
      const original = globalThis.fetch
      globalThis.fetch = async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ECONNREFUSED' }
        })
      }
      try {
        real.start()
        await waitFor(() => (stopped.errors.unreachable ?? 0) > 0)
      } finally {
        real.stop()
        globalThis.fetch = original
      }
    })

    it('counts a problem with the scoring itself, and starts the batter over', async function () {
      const tally = new Tally()
      const game = tokens.games[1]
      const keeper = new Scorekeeper(
        server.base,
        account(game.scorekeeper),
        game,
        tally,
        1000
      )
      await keeper.open()
      const inner = keeper as unknown as {
        session: { apply: () => { problems: Array<{ message: string }> } }
      }
      inner.session.apply = () => ({ problems: [{ message: 'not now' }] })
      await keeper.pitch()
      expect(tally.errors['scoring-problem']).equals(1)
      keeper.stop()
    })
  })

  describe('a socket viewer', function () {
    it('counts a refused token, and goes on trying', async function () {
      const tally = new Tally()
      const viewer = new SocketViewer(
        server.base,
        { token: 'tok_nobody' },
        tokens.games[0].id,
        tally
      )
      viewer.start()
      await waitFor(() => (tally.errors['socket-http-401'] ?? 0) > 0)
      viewer.stop()
      expect(tally.socketsOpened).equals(0)
    })

    it('counts a game it may not see, a frame it cannot read and a resync', async function () {
      const tally = new Tally()
      const viewer = new SocketViewer(
        server.base,
        account('person.stranger'),
        'gam_none',
        tally
      )
      viewer.start()
      await waitFor(() => (tally.errors['socket-notFound'] ?? 0) > 0)
      const inner = viewer as unknown as { onFrame: (data: Buffer) => void }
      const frame = (text: string): void => {
        inner.onFrame(Buffer.from(text))
      }
      frame('not json')
      frame('{"type":"resync"}')
      frame('{"type":"error"}')
      expect(tally.errors['socket-malformed']).equals(1)
      expect(tally.errors['socket-resync']).equals(1)
      expect(tally.errors['socket-error']).equals(1)
      // The type comes first from a server, and a frame is read whole only
      // when it does not: a frame in another order still counts as what it is.
      frame('{"id":"1","type":"resync"}')
      frame('{"id":"1","type":"changed"}')
      frame('{"id":"1","type":"subscribed"}')
      expect(tally.errors['socket-resync']).equals(2)
      expect(tally.framesDelivered).equals(1)
      viewer.stop()
    })

    it('counts a large change frame without reading what is in it', function () {
      const tally = new Tally()
      const viewer = new SocketViewer(
        'http://a.example.test',
        { token: 't' },
        'g',
        tally
      )
      const inner = viewer as unknown as { onFrame: (data: Buffer) => void }
      const large = Buffer.from(
        `{"type":"change","gameId":"g","data":"${'x'.repeat(1_000_000)}`
      )
      const realParse = JSON.parse
      let parses = 0
      JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
        parses += 1
        return realParse(...args)
      }
      try {
        inner.onFrame(large)
      } finally {
        JSON.parse = realParse
      }
      expect(tally.framesDelivered).equals(1)
      expect(tally.frameSeconds.length).equals(1)
      expect(parses).equals(0)
    })

    it('counts the bytes of each change of the plays, either kind, and no other', function () {
      const tally = new Tally()
      const viewer = new SocketViewer(
        'http://a.example.test',
        { token: 't' },
        'g',
        tally
      )
      const inner = viewer as unknown as { onFrame: (data: Buffer) => void }
      const change = (kind: string, data: string): Buffer =>
        Buffer.from(
          `{"type":"change","gameId":"gam_abcdefghijklmnop","at":"2026-11-03T12:00:00.000Z","kind":"${kind}","data":${data}}`
        )
      const edits = change('playEdits', '{"edits":[]}')
      const whole = change('plays', `{"plays":[${'{},'.repeat(100)}{}]}`)
      inner.onFrame(edits)
      inner.onFrame(whole)
      inner.onFrame(change('game', '{}'))
      inner.onFrame(change('lineups', '{}'))
      inner.onFrame(
        Buffer.from('{"type":"changed","scope":"home","revision":"1"}')
      )
      expect(tally.framesDelivered).equals(5)
      expect(tally.frameBytes).deep.equals([edits.length, whole.length])
    })

    it('reconnects after a close, counting it', async function () {
      const tally = new Tally()
      const viewer = new SocketViewer(
        server.base,
        account('person.admin'),
        tokens.games[0].id,
        tally
      )
      viewer.start()
      await waitFor(() => tally.socketsOpened === 1)
      const inner = viewer as unknown as {
        ws: { terminate: () => void }
      }
      inner.ws.terminate()
      await waitFor(() => tally.socketsOpened === 2)
      expect(tally.errors['socket-close-1006']).equals(1)
      viewer.stop()
    })

    it('does not subscribe on another socket, and counts its notices', async function () {
      const tally = new Tally()
      const viewer = new SocketViewer(
        server.base,
        account('person.admin'),
        tokens.games[0].id,
        tally,
        '/not-the-socket'
      )
      viewer.start()
      // This server has no such socket, which is a failure of its own kind.
      await waitFor(() => Object.keys(tally.errors).length > 0)
      const inner = viewer as unknown as { onFrame: (text: string) => void }
      inner.onFrame('{"type":"changed"}')
      expect(tally.framesDelivered).equals(1)
      viewer.stop()
    })
  })

  describe('REST readers', function () {
    it('read round the screens at their rate, and count what fails', async function () {
      const tally = new Tally()
      const viewers = tokens.accounts
        .filter(row => row.kind === 'viewer')
        .slice(0, 5)
      const readers = new RestReaders(
        [server.base],
        viewers,
        tokens.games,
        tally,
        200
      )
      readers.start()
      await waitFor(() => tally.requests.length >= 20)
      await readers.stop()
      expect(tally.requests.map(row => row.route)).include('GET /me/roles')
      // This server carries only some routes: the rest answer 404, by kind.
      expect(tally.errors['http-404']).above(0)
      expect(tally.requests[0].accountKind).equals('viewer')
    })

    it('stand still with nothing to do', async function () {
      const readers = new RestReaders(
        [server.base],
        [],
        tokens.games,
        new Tally(),
        10
      )
      readers.start()
      await readers.stop()
      expect(readers.inFlight.size).equals(0)
    })

    it('read a team only for somebody on one', function () {
      const game = { id: 'g', seasonId: 's' }
      expect(
        readsFor({ teamId: null }, game).map(row => row.route)
      ).not.include('/teams/:id/roster')
      expect(readsFor({ teamId: 't' }, game).map(row => row.path)).include(
        '/teams/t/roster'
      )
    })
  })

  describe('connection resets', function () {
    const nobody = { token: 'tok_nobody', kind: 'viewer' as const }
    const servers: Array<{ close: () => unknown }> = []
    after(function () {
      for (const each of servers) each.close()
    })
    /** Answers every connection by resetting it once `when` has happened. */
    const resetting = async (
      when: 'hello' | 'request' | 'partway' | 'upgrade' | 'open'
    ): Promise<string> => {
      if (when === 'hello') {
        // A TLS server's side of a handshake that never finishes.
        const tcp = createServer(socket => {
          socket.once('data', () => socket.resetAndDestroy())
        })
        servers.push(tcp)
        return await listening(tcp, 'https')
      }
      if (when === 'open') {
        const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
        servers.push(wss)
        wss.on('connection', (_, upgrade) => {
          setTimeout(() => upgrade.socket.resetAndDestroy(), 20)
        })
        await new Promise(resolve => wss.once('listening', resolve))
        return `http://127.0.0.1:${(wss.address() as AddressInfo).port}`
      }
      const http = createHttpServer((incoming, answer) => {
        if (when === 'request') incoming.socket.resetAndDestroy()
        else {
          answer.writeHead(200, { 'content-length': '100' })
          answer.write('{"half":')
          setTimeout(() => answer.socket?.resetAndDestroy(), 20)
        }
      })
      http.on('upgrade', (_, socket: Socket) => socket.resetAndDestroy())
      servers.push(http)
      return await listening(http)
    }
    const failing = async (
      tally: Tally,
      server: string,
      options: Parameters<typeof request>[4] = {}
    ): Promise<void> => {
      await request(server, nobody, 'GET', '/me/roles', options).then(
        () => expect.fail('the request was answered'),
        (error: unknown) => {
          tally.failure(error)
        }
      )
    }

    it('places a reset of a request or a socket at its phase, target and minute, in the report', async function () {
      // Started two minutes ago and a little more.
      const tally = new Tally(Date.now() - 125_000)
      const tls = await resetting('hello')
      tally.loadBalancers.add(tls)

      // A reset before the connection is made, as a connector would see it.
      const neverConnected = new Agent({
        connect: placingConnector((_, callback) => {
          const socket = new Socket()
          setImmediate(() => {
            callback(
              Object.assign(new Error('connect ECONNRESET'), {
                code: 'ECONNRESET'
              }),
              null
            )
          })
          return socket
        })
      })
      // Never reached: the connector stands in for the connection.
      await failing(tally, 'http://192.0.2.1:8080', {
        dispatcher: neverConnected
      })
      await failing(tally, tls)
      await failing(tally, await resetting('request'))
      await failing(tally, await resetting('partway'))
      expect(tally.errors).deep.equals({ ECONNRESET: 4 })
      expect(tally.resets).deep.equals([
        { phase: 'connect', target: 'node', minute: 2 },
        { phase: 'tls', target: 'load balancer', minute: 2 },
        { phase: 'request-sent', target: 'node', minute: 2 },
        { phase: 'response-partial', target: 'node', minute: 2 }
      ])

      // A socket's, before and after it opens.
      for (const server of [
        tls,
        await resetting('upgrade'),
        await resetting('open')
      ]) {
        const viewer = new SocketViewer(server, nobody, 'game', tally)
        const before = tally.resets.length
        viewer.start()
        await waitFor(() => tally.resets.length > before)
        viewer.stop()
      }
      expect(tally.resets.slice(4)).deep.equals([
        { phase: 'tls', target: 'load balancer', minute: 2 },
        { phase: 'request-sent', target: 'node', minute: 2 },
        { phase: 'response-partial', target: 'node', minute: 2 }
      ])

      const text = renderReport(
        buildReport({
          title: 'resets',
          startedAt: 0,
          finishedAt: 1000,
          measurements: tally,
          samples: [],
          statements: [],
          sequentialScans: [],
          hasStatements: false
        })
      )
      expect(text).contains(
        [
          '## Connection resets',
          'total: 7',
          '  by phase: connect 1, tls 2, request-sent 2, response-partial 2',
          '  by target: load balancer 2, node 5',
          '  by minute: 2:7',
          ''
        ].join('\n')
      )
    })

    it('follows a connection from its connect through its handshake', function () {
      const plain = new Socket()
      const reached = follow(plain, false)
      expect(reached()).equals('connect')
      plain.emit('connect')
      expect(reached()).equals('request-sent')
      const secure = new Socket()
      const handshake = follow(secure, true)
      secure.emit('connect')
      expect(handshake()).equals('tls')
      secure.emit('secureConnect')
      expect(handshake()).equals('request-sent')
    })
  })

  describe('the rest of it', function () {
    it('reports which servers cannot be reached, and why', async function () {
      const quick = { attempts: 2, backoffMs: 1 }
      expect(await reachable([server.base])).deep.equals([])
      expect(
        await reachable([`${server.base}/nowhere`, 'http://127.0.0.1:1'], quick)
      ).deep.equals([
        {
          server: 'http://127.0.0.1:1',
          reason:
            'GET /api/v1/health failed 2 time(s), the last with fetch failed: bad port'
        },
        {
          server: `${server.base}/nowhere`,
          reason: 'GET /api/v1/health failed 2 time(s), the last with HTTP 404'
        }
      ])
    })

    it('tries a failed health check again, within a bounded time', async function () {
      let checks = 0
      const flaky = createHttpServer((req, res) => {
        checks += 1
        // The first check is reset, as a load balancer's TLS can be; the
        // second answers 502; then the server is healthy.
        if (checks === 1) req.socket.resetAndDestroy()
        else res.writeHead(checks === 2 ? 502 : 200).end('{}')
      })
      // A server that takes every connection and never answers.
      const silent = createHttpServer(() => undefined)
      await Promise.all(
        [flaky, silent].map(
          async listening =>
            await new Promise<void>(resolve =>
              listening.listen(0, '127.0.0.1', resolve)
            )
        )
      )
      const base = (listening: typeof flaky): string =>
        `http://127.0.0.1:${(listening.address() as AddressInfo).port}`
      try {
        expect(
          await reachable([base(flaky)], { attempts: 3, backoffMs: 1 })
        ).deep.equals([])
        expect(checks).equals(3)

        const startedAt = Date.now()
        const [down] = await reachable([base(silent)], {
          attempts: 2,
          backoffMs: 1,
          timeoutMs: 50
        })
        expect(down.reason).matches(
          /^GET \/api\/v1\/health failed 2 time\(s\), the last with .*timeout/
        )
        expect(Date.now() - startedAt).below(2000)
      } finally {
        silent.closeAllConnections()
        await Promise.all(
          [flaky, silent].map(
            async listening =>
              await new Promise(resolve => listening.close(resolve))
          )
        )
      }
    })

    it('counts failures by kind', function () {
      const tally = new Tally()
      tally.failure(new HttpError(503, 'starved'))
      tally.failure(new HttpError(503, 'starved'))
      tally.failure(new TypeError('odd'))
      tally.failure(
        Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ECONNREFUSED' }
        })
      )
      tally.failure(
        Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ECONNRESET' }
        })
      )
      expect(tally.errors).deep.equals({
        'http-503': 2,
        TypeError: 1,
        unreachable: 1,
        ECONNRESET: 1
      })
    })

    it('throws on a refused request, and reads an empty answer as nothing', async function () {
      let refused: unknown
      await request(
        server.base,
        { token: 'tok_nobody', kind: 'viewer' },
        'GET',
        '/me/roles'
      ).catch((error: unknown) => {
        refused = error
      })
      expect((refused as HttpError).status).equals(401)
      expect((refused as HttpError).message).contains('HTTP 401')
    })

    it('deals evenly and paces a crowd', async function () {
      expect(serverFor(['a', 'b'], 3)).equals('b')
      const seen: number[] = []
      const started = Date.now()
      await paced([1, 2, 3], 100, (item, index) => {
        seen.push(item + index)
      })
      expect(seen).deep.equals([1, 3, 5])
      expect(Date.now() - started).at.least(20)
    })

    it('counts sockets by second, and lag only for a game that was posted to', function () {
      const tally = new Tally()
      tally.noteSocketOpen()
      tally.noteSocketOpen()
      expect(
        Object.values(tally.socketOpensBySecond).reduce((a, b) => a + b, 0)
      ).equals(2)
      tally.noteFrame('never')
      expect(tally.deliveryLagMs).deep.equals([])
      tally.notePost('game')
      tally.noteFrame('game')
      expect(tally.deliveryLagMs.length).equals(1)
    })
  })
})
