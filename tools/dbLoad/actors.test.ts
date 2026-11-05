import { spawn } from 'node:child_process'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'

import { expect } from 'chai'
import { after, afterEach, before, beforeEach, describe, it } from 'mocha'

import type { GameState } from '../../src/common/scoring/state'
import {
  cacheStatusOf,
  CAMERAS_PER_PERSON,
  finishBatter,
  getRaw,
  HttpError,
  LIVE_EDGE_PIECES,
  LiveViewer,
  masterVariant,
  mintStream,
  mintWithRetry,
  PATTERN_MARGIN_SEC,
  parseMediaPlaylist,
  paced,
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
import { TEST_AMOUNTS } from './testAmounts'
import {
  openScratch,
  type Scratch,
  startTestServer,
  type TestServer
} from './testSupport'

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
      const video = await scratch.db
        .selectFrom('live_streams')
        .select('video_id')
        .where('id', '=', stream.streamId)
        .executeTakeFirstOrThrow()
      expect(stream.videoId).equals(video.video_id).and.not.equals(null)
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
      // Each camera's video, under the game it was minted for, for viewers.
      expect(publishers.videos.length).equals(4)
      expect(new Set(publishers.videos.map(row => row.videoId)).size).equals(4)
      expect(
        publishers.videos.every(
          row =>
            row.videographer === 'videographer00001' &&
            row.gameId ===
              tokens.games[account('videographer00001').gameIndex ?? 0].id
        )
      ).equals(true)
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

      // The route refuses the fifth, which is not asked again, and it is
      // counted rather than thrown.
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
      expect(over.errors['stream-mint']).equals(1)
      expect(over.errors['stream-mint-retry']).equals(undefined)
      expect(over.requests.length).equals(1)
    })

    describe('through a server that answers 5xx or drops the connection', function () {
      let flaky: Server
      let base: string
      /** What the next answers to a create are, in order; then 201. */
      let plan: Array<number | 'drop'>
      let creates = 0
      let reveals = 0

      before(async function () {
        flaky = createServer((req: IncomingMessage, res: ServerResponse) => {
          req.resume()
          req.on('end', () => {
            if (req.url?.endsWith('/reveal') === true) {
              reveals += 1
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(
                JSON.stringify({ url: `rtmp://127.0.0.1/live/key${reveals}` })
              )
              return
            }
            creates += 1
            const answer = plan.shift() ?? 201
            if (answer === 'drop') {
              req.socket.destroy()
              return
            }
            res.writeHead(answer, { 'content-type': 'application/json' })
            res.end(
              answer === 201
                ? JSON.stringify({
                    id: `stream${creates}`,
                    videoId: `video${creates}`
                  })
                : JSON.stringify({ error: 'unavailable' })
            )
          })
        })
        await new Promise<void>(done => flaky.listen(0, '127.0.0.1', done))
        base = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}`
      })
      after(async function () {
        await new Promise(done => flaky.close(done))
      })
      beforeEach(function () {
        plan = []
        creates = 0
        reveals = 0
      })

      const noWait = { backoffMs: 1, backoffMaxMs: 4, sleep: async () => {} }

      it('ask again after a 503, a 502 and a dropped connection, then mint', async function () {
        plan = [503, 'drop', 502]
        const tally = new Tally()
        const stream = await mintWithRetry(
          base,
          account('videographer00003'),
          'game',
          tally,
          { ...noWait, retryMs: 60_000 }
        )
        expect(stream).deep.equals({
          streamId: 'stream4',
          url: 'rtmp://127.0.0.1/live/key1',
          videoId: 'video4'
        })
        expect(creates).equals(4)
        expect(tally.errors['stream-mint-retry']).equals(3)
      })

      it('wait twice as long each time, up to the most', async function () {
        plan = [503, 503, 503, 503]
        const waits: number[] = []
        await mintWithRetry(
          base,
          account('videographer00003'),
          'game',
          new Tally(),
          {
            retryMs: 60_000,
            backoffMs: 10,
            backoffMaxMs: 30,
            sleep: async ms => {
              waits.push(ms)
            }
          }
        )
        expect(waits).deep.equals([10, 20, 30, 30])
      })

      it('wait for real between tries when given no sleep', async function () {
        plan = [503]
        const started = performance.now()
        await mintWithRetry(
          base,
          account('videographer00003'),
          'game',
          new Tally(),
          {
            retryMs: 60_000,
            backoffMs: 50
          }
        )
        expect(performance.now() - started).at.least(45)
      })

      it('give up once the retry time is spent, and the stream counts as stream-mint', async function () {
        plan = Array.from({ length: 1000 }, () => 503)
        const tally = new Tally()
        const started: string[] = []
        const publishers = new Publishers(
          [base],
          { ...tokens, accounts: [account('videographer00003')] },
          tally,
          1,
          5,
          url => {
            started.push(url)
            throw new Error('not reached')
          },
          { retryMs: 30, backoffMs: 5, backoffMaxMs: 5 }
        )
        await publishers.start()
        expect(started).deep.equals([])
        expect(tally.streamsStarted).equals(0)
        expect(tally.errors['stream-mint']).equals(1)
        expect(tally.errors['stream-mint-retry']).at.least(1)
        expect(tally.errors['http-503']).equals(undefined)
      })

      it('mint several at once, keep their order, and run each pattern past the load', async function () {
        plan = [503, 503]
        const tally = new Tally()
        const started: Array<{ url: string; seconds: number }> = []
        const publishers = new Publishers(
          [base],
          {
            ...tokens,
            accounts: [
              account('videographer00003'),
              account('videographer00004')
            ]
          },
          tally,
          6,
          60,
          (url, seconds) => {
            started.push({ url, seconds })
            return spawn(process.execPath, ['-e', ''])
          },
          { ...noWait, retryMs: 60_000, concurrency: 3 }
        )
        await publishers.start()
        expect(tally.streamsStarted).equals(6)
        expect(started.length).equals(6)
        expect(
          started.every(row => row.seconds === 60 + PATTERN_MARGIN_SEC)
        ).equals(true)
        expect(publishers.minted.length).equals(6)
        // Dealt in turn across the two videographers, in the order asked.
        expect(publishers.videos.map(row => row.videographer)).deep.equals([
          'videographer00003',
          'videographer00004',
          'videographer00003',
          'videographer00004',
          'videographer00003',
          'videographer00004'
        ])
        expect(tally.errors['stream-mint-retry']).equals(2)
        publishers.stop()
      })
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

  describe('the rest of it', function () {
    it('reports which servers cannot be reached', async function () {
      expect(await reachable([server.base])).deep.equals([])
      expect(await reachable(['http://127.0.0.1:1'])).deep.equals([
        'http://127.0.0.1:1'
      ])
      expect(await reachable([`${server.base}/nowhere`])).deep.equals([
        `${server.base}/nowhere`
      ])
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

/**
 * A video's routes and its CDN, as a live viewer meets them: `/playback`, the
 * two playlists behind a token, and pieces that answer a range with a cache
 * status. Each playlist goes out gzipped, and the media URLs are signed afresh
 * on every reload, as the base build's are.
 */
class FakeVideo {
  server: Server | undefined
  base = ''
  /** The token `/playback` hands out; any other is refused with a 403. */
  token = 1
  playbackPending = 0
  playbackCalls = 0
  playbackStatus = 200
  pieces = 5
  target = 2
  ended = false
  indexStatus = 200
  masterStatus = 200
  reloads = 0
  playlistWireBytes = 0
  /** How each media request is answered, in turn: a header, or a status. */
  mediaAnswers: Array<{ header?: [string, string]; status?: number }> = []
  readonly media: Array<{ path: string; range: string | undefined }> = []

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.answer(req, res)
    })
    await new Promise<void>(resolve =>
      this.server?.listen(0, '127.0.0.1', resolve)
    )
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async close(): Promise<void> {
    await new Promise(resolve => {
      this.server?.close(resolve)
      this.server?.closeAllConnections()
    })
  }

  private gzipped(res: ServerResponse, text: string): void {
    const body = gzipSync(text)
    this.playlistWireBytes += body.length
    res.writeHead(200, { 'content-encoding': 'gzip' })
    res.end(body)
  }

  private answer(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', this.base)
    const token = Number(url.searchParams.get('t'))
    if (url.pathname === '/api/v1/videos/vid1/playback') {
      this.playbackCalls += 1
      if (this.playbackStatus !== 200) {
        res.writeHead(this.playbackStatus).end('{"code":"membersOnly"}')
        return
      }
      const pending = this.playbackPending > 0
      if (pending) this.playbackPending -= 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          url: pending
            ? null
            : `${this.base}/api/v1/videos/vid1/hls/master.m3u8?t=${this.token}`
        })
      )
      return
    }
    if (url.pathname.startsWith('/api/v1/videos/vid1/hls/')) {
      const file = url.pathname.split('/').pop()
      const status =
        file === 'master.m3u8' ? this.masterStatus : this.indexStatus
      if (token !== this.token || status !== 200) {
        res.writeHead(token !== this.token ? 403 : status).end()
        return
      }
      if (file === 'master.m3u8') {
        this.gzipped(
          res,
          `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n${this.base}/api/v1/videos/vid1/hls/index.m3u8?t=${token}\n`
        )
        return
      }
      this.reloads += 1
      const signed = `sig=${this.reloads}`
      const lines = [
        '#EXTM3U',
        `#EXT-X-TARGETDURATION:${this.target}`,
        `#EXT-X-MAP:URI="${this.base}/media/videos/vid1-secret/init.mp4?${signed}"`,
        ...Array.from({ length: this.pieces }, (_, i) => [
          '#EXTINF:2.0,',
          // Relative, as a playlist may give them.
          `/media/videos/vid1-secret/seg${String(i).padStart(6, '0')}.m4s?${signed}`
        ]).flat(),
        ...(this.ended ? ['#EXT-X-ENDLIST'] : [])
      ]
      this.gzipped(res, `${lines.join('\n')}\n`)
      return
    }
    if (url.pathname.startsWith('/media/')) {
      this.media.push({ path: url.pathname, range: req.headers.range })
      const answer = this.mediaAnswers.shift() ?? {}
      const headers: Record<string, string> =
        answer.header == null ? {} : { [answer.header[0]]: answer.header[1] }
      res.writeHead(answer.status ?? 206, headers).end('x')
      return
    }
    res.writeHead(404).end()
  }
}

describe('a live viewer', function () {
  let video: FakeVideo
  let delays: number[]
  const viewer = (tally: Tally, retryMs = 50): LiveViewer =>
    new LiveViewer(
      video.base,
      { token: 'viewer-token', kind: 'viewer' },
      'vid1',
      tally,
      0,
      {
        retryMs,
        timers: {
          // The test takes each turn itself, and keeps when it was asked for.
          set: (_run, ms) => {
            delays.push(ms)
            return delays.length
          },
          clear: () => undefined
        }
      }
    )
  const turn = async (actor: LiveViewer): Promise<void> => {
    await actor.step()
    await Promise.all(actor.media)
  }

  beforeEach(async function () {
    video = new FakeVideo()
    await video.start()
    delays = []
  })
  afterEach(async function () {
    await video.close()
  })

  it('reloads once per target duration and sends one ranged GET per new piece', async function () {
    const tally = new Tally()
    const actor = viewer(tally)
    video.playbackPending = 1
    actor.start()
    expect(delays).deep.equals([0])
    // Not live yet: asked again after the retry.
    await turn(actor)
    expect(delays).deep.equals([0, 50])
    // The master playlist names the variant, which is read at once.
    await turn(actor)
    expect(delays.at(-1)).equals(0)
    // Joining live: the init file and the last few pieces, a byte each.
    await turn(actor)
    expect(delays.at(-1)).equals(video.target * 1000)
    expect(video.media.map(row => row.path.split('/').pop())).deep.equals([
      'init.mp4',
      'seg000002.m4s',
      'seg000003.m4s',
      'seg000004.m4s'
    ])
    expect(LIVE_EDGE_PIECES).equals(3)
    // Two new pieces, signed afresh along with the old: two requests.
    video.pieces = 7
    await turn(actor)
    expect(
      video.media.slice(4).map(row => row.path.split('/').pop())
    ).deep.equals(['seg000005.m4s', 'seg000006.m4s'])
    // Nothing new, nothing asked; a new target duration is the new reload time.
    video.target = 4
    await turn(actor)
    expect(video.media.length).equals(6)
    expect(delays.slice(3)).deep.equals([2000, 2000, 4000])
    expect(video.media.every(row => row.range === 'bytes=0-0')).equals(true)
    expect(video.reloads).equals(3)
    expect(tally.viewersStarted).equals(1)
    // master and three reloads, counted by what came over the wire.
    expect(tally.playlistRequests).equals(4)
    expect(tally.playlistBytesByViewer).deep.equals([video.playlistWireBytes])
    expect(tally.requests.map(row => row.route)).deep.equals([
      'GET /videos/:id/playback',
      'GET /videos/:id/playback'
    ])
    expect(tally.errors).deep.equals({})
    // A closed playlist is not reloaded.
    video.ended = true
    video.pieces = 8
    await turn(actor)
    expect(delays.length).equals(6)
    expect(video.media.length).equals(7)
    await actor.stop()
  })

  it('asks /playback again on a 403, and counts a fresh URL refused as a failure', async function () {
    const tally = new Tally()
    const actor = viewer(tally)
    actor.start()
    await turn(actor)
    await turn(actor)
    expect(video.playbackCalls).equals(1)
    // The token expires: the playlist is refused and `/playback` asked at once.
    video.token = 2
    await turn(actor)
    expect(delays.at(-1)).equals(0)
    await turn(actor)
    expect(video.playbackCalls).equals(2)
    await turn(actor)
    expect(video.reloads).equals(2)
    expect(tally.errors).deep.equals({})
    // A URL refused straight from `/playback` waits for the retry.
    video.masterStatus = 403
    video.token = 3
    await turn(actor)
    await turn(actor)
    expect(video.playbackCalls).equals(3)
    expect(tally.errors).deep.equals({ 'playlist-http-403': 1 })
    expect(delays.at(-1)).equals(50)
    // Another status is counted, and the same URL is asked again.
    video.masterStatus = 200
    video.indexStatus = 503
    await turn(actor)
    await turn(actor)
    expect(tally.errors['playlist-http-503']).equals(1)
    expect(delays.at(-1)).equals(50)
    // And `/playback` refusing the viewer is counted as its route's failure.
    video.playbackStatus = 403
    video.token = 4
    video.indexStatus = 200
    await turn(actor)
    await turn(actor)
    expect(tally.errors['http-403']).equals(1)
    await actor.stop()
  })

  it('records each media answer by its cache status', async function () {
    const tally = new Tally()
    const actor = viewer(tally)
    video.mediaAnswers = [
      { header: ['cf-cache-status', 'HIT'] },
      { header: ['x-cache', 'Miss'] },
      {},
      { header: ['cf-cache-status', 'HIT'], status: 404 }
    ]
    actor.start()
    await turn(actor)
    await turn(actor)
    await turn(actor)
    expect(tally.mediaRequestsByCache).deep.equals({ HIT: 2, MISS: 1, NONE: 1 })
    expect(tally.errors).deep.equals({ 'media-http-404': 1 })
    // A piece nobody answers is counted by why.
    const gone = new FakeVideo()
    await gone.start()
    await gone.close()
    const late = new Tally()
    const orphan = new LiveViewer(
      gone.base,
      { token: 't', kind: 'viewer' },
      'vid1',
      late,
      0,
      { timers: { set: () => 0, clear: () => undefined } }
    )
    await orphan.step()
    expect(late.errors).deep.equals({ unreachable: 1 })
    await actor.stop()
    await orphan.stop()
  })

  it('runs on real timers until stopped', async function () {
    const tally = new Tally()
    video.target = 0.05
    const actor = new LiveViewer(
      video.base,
      { token: 'viewer-token', kind: 'viewer' },
      'vid1',
      tally,
      3
    )
    actor.start()
    await waitFor(() => video.reloads >= 3, 5000)
    await actor.stop()
    const reloads = video.reloads
    await new Promise(resolve => {
      setTimeout(resolve, 150)
    })
    expect(video.reloads).equals(reloads)
    expect(tally.playlistBytesByViewer[3]).above(0)
  })

  it('reads playlists, their target, their pieces and cache headers', async function () {
    expect(
      masterVariant(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n\n# note\nindex.m3u8\n'
      )
    ).equals('index.m3u8')
    expect(masterVariant('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n')).equals(
      null
    )
    expect(masterVariant('#EXTM3U\nseg0.m4s\n')).equals(null)
    expect(
      parseMediaPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:0\nseg0.m4s\n')
    ).deep.equals({
      targetSeconds: 6,
      ended: false,
      maps: [],
      pieces: ['seg0.m4s']
    })
    expect(cacheStatusOf({})).equals('NONE')
    expect(cacheStatusOf({ 'x-cache': ' ' })).equals('NONE')
    expect(cacheStatusOf({ 'x-cache': 'hit' })).equals('HIT')
    expect(
      cacheStatusOf({ 'x-cache': ['miss', 'hit'] as unknown as string })
    ).equals('MISS, HIT')
    // cf-cache-status wins over x-cache when both are there.
    expect(
      cacheStatusOf({ 'cf-cache-status': 'MISS', 'x-cache': 'HIT' })
    ).equals('MISS')
  })

  it('counts bytes as sent and decodes each encoding, or fails by code', async function () {
    const server = createServer((req, res) => {
      const text = Buffer.from('#EXTM3U\n')
      if (req.url === '/deflate') {
        res
          .writeHead(200, { 'content-encoding': 'deflate' })
          .end(deflateSync(text))
      } else if (req.url === '/br') {
        res
          .writeHead(200, { 'content-encoding': 'br' })
          .end(brotliCompressSync(text))
      } else if (req.url === '/broken') {
        res.writeHead(200, { 'content-encoding': 'gzip' }).end('not gzip')
      } else if (req.url === '/slow') {
        // Never answers.
      } else res.writeHead(200).end(text)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      for (const path of ['/deflate', '/br', '/plain']) {
        const answer = await getRaw(`${base}${path}`)
        expect(answer.body.toString()).equals('#EXTM3U\n')
        expect(answer.status).equals(200)
      }
      expect((await getRaw(`${base}/plain`)).wireBytes).equals(8)
      const failure = async (
        url: string,
        timeoutMs?: number
      ): Promise<string> => {
        const tally = new Tally()
        await getRaw(url, {}, timeoutMs).catch((error: unknown) => {
          tally.failure(error)
        })
        return Object.keys(tally.errors).join()
      }
      expect(await failure(`${base}/broken`)).equals('Z_DATA_ERROR')
      expect(await failure(`${base}/slow`, 50)).equals('ETIMEDOUT')
      expect(await failure('https://127.0.0.1:1/none')).equals('unreachable')
    } finally {
      await new Promise(resolve => {
        server.close(resolve)
        server.closeAllConnections()
      })
    }
  })
})
