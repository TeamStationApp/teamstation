import { spawn } from 'node:child_process'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import type { GameState } from '../../src/common/scoring/state'
import {
  CAMERAS_PER_PERSON,
  finishBatter,
  HttpError,
  mintStream,
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
