import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'
import { WebSocketServer } from 'ws'

import {
  angleTiles,
  ask,
  boardBrowser,
  type BoardStack,
  boardStack,
  broadcast,
  camera,
  clock,
  dashboard,
  DEFAULT_SEGMENT_SECONDS,
  endCamera,
  frameLogger,
  gridReady,
  gridState,
  iso,
  mediaAt,
  nameTexts,
  overrides,
  pause,
  picture,
  pitch,
  print,
  probe,
  readFrames,
  ready,
  seekReads,
  segmentMs,
  sizeOf,
  until,
  videoTimeline
} from './overlayRig'

/** A maestro-d page that answers each probe in turn, and keeps what it was sent. */
function fakePage(answers: unknown[]): {
  m: any
  scripts: string[]
  calls: Array<[string, unknown]>
} {
  const scripts: string[] = []
  const calls: Array<[string, unknown]> = []
  let last: unknown
  const m = {
    evalBrowserScript: async (options: { script: string }) => {
      scripts.push(options.script)
      last = answers.length > 1 ? answers.shift() : answers[0]
    },
    vars: async () => ({ probe: JSON.stringify(last) }),
    setCookies: async (options: unknown) => {
      calls.push(['setCookies', options])
    },
    screenshot: async () => Buffer.from('png')
  }
  return { m, scripts, calls }
}

const realFetch = globalThis.fetch
/** Answers fetches by `METHOD path`, and keeps them. */
function routeFetch(
  routes: Record<string, { status: number; body?: unknown }>
): Array<{ url: string; init: RequestInit | undefined }> {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init })
    const path = new URL(url).pathname.replace(/^\/api\/v1/, '')
    const route = routes[`${init?.method ?? 'GET'} ${path}`]
    if (route == null) return new Response('', { status: 404 })
    return new Response(
      route.body === undefined ? null : JSON.stringify(route.body),
      { status: route.status }
    )
  }) as typeof fetch
  return seen
}

function stackOf(overrides: Partial<BoardStack> = {}): BoardStack {
  return {
    origin: 'https://stack.example.test',
    api: 'https://stack.example.test/api/v1',
    token: 'tok',
    client: {} as any,
    media: {} as any,
    ...overrides
  }
}

describe('the board overlay rig', function () {
  afterEach(function () {
    globalThis.fetch = realFetch
  })

  it('seeds the scoring world and signs its scorer in', async function () {
    const seeded: string[] = []
    const ctx = {
      stack: {
        origin: 'https://stack.example.test/',
        control: { remux: async () => ({}) }
      },
      fixture: async (name: string) => {
        seeded.push(name)
        return {
          world: name,
          nonce: 'n',
          accounts: { scorer: { email: 'a@example.test', password: 'p' } },
          ids: { games: 'g1,g2' }
        }
      }
    } as any
    const { stack, games } = await boardStack(ctx, async (api, account) => {
      expect(api).equals('https://stack.example.test/api/v1')
      expect(account.email).equals('a@example.test')
      return 'tok'
    })
    expect(seeded).deep.equals(['scoring-game'])
    expect(games).deep.equals(['g1', 'g2'])
    expect(stack.origin).equals('https://stack.example.test')
    expect(stack.token).equals('tok')
  })

  it('asks the API with the token, and makes and ends a camera', async function () {
    const seen = routeFetch({
      'GET /empty': { status: 204 },
      'POST /games/g1/live-streams': {
        status: 201,
        body: { id: 's1', videoId: 'v1', url: 'rtmp://x/live/k' }
      },
      'POST /games/g1/live-streams/s1/end': { status: 200, body: {} }
    })
    const stack = stackOf()
    expect(await ask(stack, '/empty')).deep.equals({ status: 204, json: null })
    const made = await camera(stack, 'g1', 'E8 one')
    expect(made).deep.equals({
      gameId: 'g1',
      streamId: 's1',
      videoId: 'v1',
      url: 'rtmp://x/live/k'
    })
    expect((seen[1].init?.headers as any).authorization).equals('Bearer tok')
    await endCamera(stack, made)
    let failed = ''
    try {
      await camera(stack, 'g2', 'no')
    } catch (error) {
      failed = String(error)
    }
    expect(failed).contains('no camera: 404')
  })

  it('broadcasts through the stack and waits for its exit', async function () {
    const asked: unknown[] = []
    let polls = 0
    const stack = stackOf({
      media: {
        broadcast: async (options: unknown) => {
          asked.push(options)
          return { id: 'b1', t0: 5, events: [], exit: null }
        },
        broadcastStatus: async () => ({
          events: [],
          exit: ++polls > 1 ? 0 : null
        })
      } as any
    })
    const show = await broadcast(
      stack,
      { gameId: 'g', streamId: 's', videoId: 'v', url: 'rtmp://x/live/k' },
      { stamped: true, duration: 10 },
      1
    )
    expect(show.t0).equals(5)
    expect(asked).deep.equals([
      { url: 'rtmp://x/live/k', stamped: true, duration: 10 }
    ])
    expect(await show.done()).equals(0)
  })

  it('waits for a recording, and gives up on one never packed up', async function () {
    let looks = 0
    const stack = stackOf({
      client: {
        game: async () => ({
          videos: [
            looks++ > 0
              ? { id: 'v', status: 'ready', width: 1280 }
              : { id: 'v', status: 'live', width: null }
          ]
        })
      } as any
    })
    await ready(stack, 'g', 'v', 3, 1)
    let failed = ''
    try {
      await ready(stack, 'g', 'other', 2, 1)
    } catch (error) {
      failed = String(error)
    }
    expect(failed).contains('never packed up')
  })

  it('reads the segment length and a video’s timeline', async function () {
    let segment: unknown = 2
    const stack = stackOf({
      media: {
        ingestFiles: async () => ({
          live: { segmentSeconds: segment },
          names: [],
          master: ''
        })
      } as any,
      client: {
        wallTimeline: async () => ({ anchors: [[0, 10]], live: false }),
        playback: async (id: string) => ({
          durationSec: id === 'v' ? 3 : null
        })
      } as any
    })
    expect(await segmentMs(stack, 'v')).equals(2000)
    segment = undefined
    expect(await segmentMs(stack, 'v')).equals(DEFAULT_SEGMENT_SECONDS * 1000)
    const timeline = await videoTimeline(stack, 'v')
    expect(timeline.endMs).equals(3000)
    let failed = ''
    try {
      await videoTimeline(stack, 'w')
    } catch (error) {
      failed = String(error)
    }
    expect(failed).contains('has no length')
  })

  it('places a wall time in a video, and nowhere in an outage or outside it', function () {
    const anchors: Array<[number, number]> = [
      [0, 1000],
      [5000, 26_000]
    ]
    expect(mediaAt(anchors, 500, 9000)).equals(null)
    expect(mediaAt(anchors, 3000, 9000)).equals(2000)
    expect(mediaAt(anchors, 10_000, 9000)).equals(null)
    expect(mediaAt(anchors, 27_000, 9000)).equals(6000)
    expect(mediaAt(anchors, 40_000, 9000)).equals(null)
  })

  it('pitches through a session and names a refused one', function () {
    const before = Date.now()
    expect(
      pitch({ apply: () => ({ problems: [] }) } as any, 'B')
    ).greaterThanOrEqual(before)
    expect(() =>
      pitch(
        { apply: () => ({ problems: [{ message: 'not now' }] }) } as any,
        'C'
      )
    ).throws('not now')
  })

  describe('the dashboard socket', function () {
    let server: WebSocketServer
    let port = 0
    const heard: string[] = []
    before(async function () {
      server = new WebSocketServer({ port: 0 })
      await new Promise(resolve => server.once('listening', resolve))
      port = (server.address() as { port: number }).port
      server.on('connection', (_socket, request) => {
        heard.push(`${request.url} ${request.headers.authorization}`)
      })
    })
    after(function () {
      server.close()
    })
    it('opens as the dashboard screen does', async function () {
      const socket = await dashboard(
        stackOf({ api: `http://localhost:${port}/api/v1` }),
        'g 1'
      )
      socket.close()
      await pause(20)
      expect(heard).deep.equals([
        '/api/v1/scoreboard/g%201/dashboard Bearer tok'
      ])
    })
  })

  it('turns the overrides on and off', function () {
    expect(overrides(true).overrideCountEnabled).equals(true)
    expect(overrides(true).overrideTeam?.awayTeam).contains('Port Kestrel')
    expect(overrides(false).overrideCountEnabled).equals(false)
    expect(sizeOf('402x874')).deep.equals({ width: 402, height: 874 })
  })

  it('opens a page in this machine’s Chrome, signed in', async function () {
    const page = fakePage([true])
    const sizes: unknown[] = []
    const session = await boardBrowser(
      {
        browser: async (size: unknown, emulation: unknown) => {
          sizes.push(size, emulation)
          return { m: page.m } as any
        }
      },
      stackOf(),
      '1280x720'
    )
    expect(session.m).equals(page.m)
    expect(sizes).deep.equals([{ width: 1280, height: 720 }, { h264: true }])
    expect(page.calls[0][1]).deep.equals({
      cookies: [
        {
          name: 'ts_session',
          value: 'tok',
          domain: 'stack.example.test',
          path: '/'
        }
      ]
    })
  })

  it('probes the page, and waits until a probe holds', async function () {
    const page = fakePage([false, true])
    await until(page.m, 'return x', 'x', 1000, 1)
    expect(page.scripts).length(2)
    expect(page.scripts[0]).contains('return x')
    const never = fakePage([false])
    let failed = ''
    try {
      await until(never.m, 'return y', 'y holds', 0, 1)
    } catch (error) {
      failed = String(error)
    }
    expect(failed).contains('never: y holds')
    expect(await probe(fakePage([{ a: 1 }]).m, '')).deep.equals({ a: 1 })
    expect(gridReady(3)).contains('v.length === 3')
  })

  it('reads the board at each seek against the marker and the frame', async function () {
    const steps = [{ at: 1500 }, { at: 3000 }] as any
    const timeline = { anchors: [[0, 1000]], endMs: 5000 } as any
    const page = fakePage([
      {
        marker: 2000,
        frameSec: 1,
        at: '1500',
        board: { x: 1, y: 1, w: 2, h: 2 },
        video: { x: 0, y: 0, w: 10, h: 10 }
      },
      {
        marker: null,
        frameSec: null,
        at: null,
        board: null,
        video: { x: 0, y: 0, w: 10, h: 10 }
      }
    ])
    const reads = await seekReads(page.m, timeline, steps, [2000, 2100, 9000])
    expect(reads.map(one => [one.ok, one.okByFrame])).deep.equals([
      [true, true],
      [false, false],
      [false, false]
    ])
    expect(reads[0].at).equals(1500)
    expect(reads[2].video.w).equals(0)
  })

  it('reads the grid, its names and its tiles', async function () {
    const page = fakePage([
      { window: { w: 1, h: 2 }, boards: [], tiles: [], masterSec: 0 }
    ])
    expect((await gridState(page.m)).window).deep.equals({ w: 1, h: 2 })
    expect(await nameTexts(fakePage([['a']]).m, ['a'])).deep.equals(['a'])
    expect(await angleTiles(fakePage([[null]]).m, ['a'])).deep.equals([null])
  })

  it('saves a picture once the fonts are in, and refuses one without', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'overlay-rig-'))
    try {
      const file = join(dir, 'shot.png')
      const page = fakePage([true])
      await picture(page.m, file)
      expect(readFileSync(file, 'utf8')).equals('png')
      expect(
        page.scripts.some(one => one.includes('stream key hidden'))
      ).equals(true)
      let failed = ''
      try {
        await picture(fakePage([false]).m, join(dir, 'never.png'))
      } catch (error) {
        failed = String(error)
      }
      expect(failed).contains('fonts never loaded')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('logs every frame, and reads the log back whole', async function () {
    expect(frameLogger()).contains(`document.querySelector('video')`)
    expect(frameLogger(1)).contains(')[1]')
    expect(frameLogger('mine()')).contains('const v = mine()')
    const frames = await readFrames(
      fakePage([
        [
          [10, 5, 7, 0.5],
          [11, null, null, 0.6]
        ]
      ]).m,
      0
    )
    expect(frames).deep.equals([
      { now: 10, wall: 5, at: 7, mediaSec: 0.5 },
      { now: 11, wall: null, at: null, mediaSec: 0.6 }
    ])
  })

  it('tells the time and waits out a clock', async function () {
    print('a line')
    print('a line', { with: 'detail' })
    expect(iso(0)).equals('1970-01-01T00:00:00.000Z')
    await clock(Date.now() - 10_000)(1)
  })
})
