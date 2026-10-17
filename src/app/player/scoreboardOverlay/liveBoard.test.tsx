import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { type BoardStep, TeamStationClient } from '../../../common/api'
import type { WallTimeline } from '../../../common/wallTimeline'
import { fakeClock, fakeSockets } from '../../../test/fakeScoreboardSocket'
import {
  boardStep,
  OVERLAY_T0,
  overlayServer,
  urlOf,
  wallTimelineOf
} from '../../../test/overlayFixtures'
import {
  BOARD_POLL_MS,
  type BoardTimelineHandle,
  type BoardTimelineOptions,
  LOOK_BACK_MS,
  NOTICE_DEBOUNCE_MS,
  useBoardTimeline
} from './useBoardTimeline'
import {
  type FrameLoop,
  SEEK_JUMP_MS,
  usePlayheadStep
} from './usePlayheadStep'
import {
  type TimelineWanted,
  useWallTimeline,
  useWallTimelines,
  WALL_POLL_MS
} from './useWallTimeline'

let root: Root | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})

async function render(element: React.ReactElement): Promise<void> {
  if (root == null) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(element)
  })
}

/** Lets the fake server's answers land. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function advance(
  clock: ReturnType<typeof fakeClock>,
  ms: number
): Promise<void> {
  await act(async () => {
    clock.advance(ms)
  })
  await flush()
}

const boardAsks = (server: ReturnType<typeof overlayServer>): number[] =>
  server.asked
    .filter(one => one.path.endsWith('/scoreboard-timeline'))
    .map(one => Number(one.query.get('from')))

describe('the live wall timeline (U36)', function () {
  function Timelines(props: {
    client: TeamStationClient
    videos: TimelineWanted[]
    schedule: ReturnType<typeof fakeClock>['schedule']
    out: { current: Record<string, WallTimeline> }
  }): null {
    props.out.current = useWallTimelines(
      props.client,
      props.videos,
      props.schedule
    )
    return null
  }

  function setup(): {
    server: ReturnType<typeof overlayServer>
    client: TeamStationClient
    clock: ReturnType<typeof fakeClock>
    out: { current: Record<string, WallTimeline> }
  } {
    const server = overlayServer()
    return {
      server,
      client: new TeamStationClient({
        baseUrl: '/api/v1',
        fetch: server.fetch
      }),
      clock: fakeClock(),
      out: { current: {} }
    }
  }

  it('appends the points each poll brings while live, and refetches whole at the end', async function () {
    const { server, client, clock, out } = setup()
    let points: Array<[number, number]> = [[0, OVERLAY_T0]]
    let live = true
    server.timelines.set('v1', () => wallTimelineOf(points, live))
    await render(
      <Timelines
        client={client}
        videos={[{ id: 'v1', live: true }]}
        schedule={clock.schedule}
        out={out}
      />
    )
    await flush()
    expect(out.current.v1?.anchors).deep.equals([[0, OVERLAY_T0]])

    points = [
      [0, OVERLAY_T0],
      [500, OVERLAY_T0 + 500],
      [1000, OVERLAY_T0 + 1000]
    ]
    await advance(clock, WALL_POLL_MS)
    expect(out.current.v1?.anchors).deep.equals(points)
    const polls = server.asked.filter(one => one.query.has('afterMs'))
    expect(polls.map(one => one.query.get('afterMs'))).deep.equals(['0'])

    // A poll that fails is tried again from the same point.
    server.fail.add('/videos/v1/wall-timeline')
    await advance(clock, WALL_POLL_MS)
    server.fail.clear()
    await advance(clock, WALL_POLL_MS)
    expect(
      server.asked
        .filter(one => one.query.has('afterMs'))
        .map(one => one.query.get('afterMs'))
    ).deep.equals(['0', '1000', '1000'])

    // The stream ends: the recording's points replace the live ones.
    live = false
    points = [
      [0, OVERLAY_T0],
      [1000, OVERLAY_T0 + 1000],
      [1500, OVERLAY_T0 + 21_500]
    ]
    await advance(clock, WALL_POLL_MS)
    expect(out.current.v1?.live).equals(false)
    expect(out.current.v1?.anchors).deep.equals(points)
    const asks = server.asked.length
    await advance(clock, WALL_POLL_MS * 3)
    expect(server.asked.length).equals(asks)
  })

  it('keeps asking for the whole timeline while it holds only the start, and then only for what follows', async function () {
    const { server, client, clock, out } = setup()
    // The first fetch comes before the stream has stored a point.
    let stored: Array<[number, number]> = []
    server.timelines.set('v1', () =>
      stored.length === 0
        ? {
            anchors: [[0, OVERLAY_T0 - 5000]],
            source: 'start',
            confidence: 'approximate',
            live: true,
            startAt: new Date(OVERLAY_T0 - 5000).toISOString()
          }
        : { ...wallTimelineOf(stored, true), source: 'arrival' }
    )
    await render(
      <Timelines
        client={client}
        videos={[{ id: 'v1', live: true }]}
        schedule={clock.schedule}
        out={out}
      />
    )
    await flush()
    expect(out.current.v1?.source).equals('start')
    await advance(clock, WALL_POLL_MS)
    expect(out.current.v1?.source).equals('start')

    // The first point is at media time zero, and it replaces the start.
    stored = [
      [0, OVERLAY_T0 - 1000],
      [2000, OVERLAY_T0 + 1000]
    ]
    await advance(clock, WALL_POLL_MS)
    expect(out.current.v1?.anchors).deep.equals(stored)
    stored = [...stored, [4000, OVERLAY_T0 + 3000]]
    await advance(clock, WALL_POLL_MS)
    expect(out.current.v1?.anchors).deep.equals(stored)
    expect(
      server.asked
        .filter(one => one.path === '/videos/v1/wall-timeline')
        .map(one => one.query.get('afterMs'))
    ).deep.equals([null, null, null, '2000'])
  })

  it('refetches whole when the video stops being live, and retries a live one it could not fetch', async function () {
    const { server, client, clock, out } = setup()
    server.fail.add('/videos/v2/wall-timeline')
    server.timelines.set('v1', wallTimelineOf([[0, OVERLAY_T0]], false))
    server.timelines.set('v2', wallTimelineOf([[0, OVERLAY_T0 + 9]], false))
    const videos = (live: boolean): TimelineWanted[] => [
      { id: 'v1', live },
      { id: 'v2', live: true }
    ]
    await render(
      <Timelines
        client={client}
        videos={videos(true)}
        schedule={clock.schedule}
        out={out}
      />
    )
    await flush()
    expect(out.current.v2).equals(undefined)
    server.fail.clear()
    await advance(clock, WALL_POLL_MS)
    expect(out.current.v2?.anchors).deep.equals([[0, OVERLAY_T0 + 9]])

    const before = server.asked.filter(one => one.path.includes('v1')).length
    await render(
      <Timelines
        client={client}
        videos={videos(false)}
        schedule={clock.schedule}
        out={out}
      />
    )
    await flush()
    expect(server.asked.filter(one => one.path.includes('v1')).length).equals(
      before + 1
    )
  })

  it('has nothing for no video', async function () {
    const { client, clock } = setup()
    const seen: Array<WallTimeline | null> = []
    function One(): null {
      seen.push(useWallTimeline(client, null, false, clock.schedule))
      return null
    }
    await render(<One />)
    await flush()
    expect(seen.every(one => one == null)).equals(true)
  })
})

describe('the live board timeline (U36)', function () {
  interface Harness {
    server: ReturnType<typeof overlayServer>
    clock: ReturnType<typeof fakeClock>
    sockets: ReturnType<typeof fakeSockets>
    out: { current: BoardTimelineHandle | undefined }
    playhead: { wall: number | null }
    /** How many sockets existed when each board request was made. */
    socketsAtAsk: number[]
    rerender: (options?: Partial<BoardTimelineOptions>) => Promise<void>
  }

  function Board(props: {
    options: BoardTimelineOptions
    out: { current: BoardTimelineHandle | undefined }
  }): null {
    props.out.current = useBoardTimeline(props.options)
    return null
  }

  async function setup(
    options: Partial<BoardTimelineOptions> = {},
    steps: BoardStep[] = []
  ): Promise<Harness> {
    const server = overlayServer()
    server.steps.set('g1', steps)
    const sockets = fakeSockets()
    const socketsAtAsk: number[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      if (urlOf(input).includes('scoreboard-timeline'))
        socketsAtAsk.push(sockets.sockets.length)
      return await server.fetch(input, init)
    }
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: fetchImpl
    })
    const clock = fakeClock()
    const playhead = { wall: null as number | null }
    const out: { current: BoardTimelineHandle | undefined } = {
      current: undefined
    }
    const base: BoardTimelineOptions = {
      client,
      gameId: 'g1',
      fromMs: OVERLAY_T0,
      live: true,
      playheadWall: () => playhead.wall,
      WebSocketImpl: sockets.Impl,
      schedule: clock.schedule,
      origin: { protocol: 'http:', host: 'localhost' },
      ...options
    }
    const rerender = async (
      more: Partial<BoardTimelineOptions> = {}
    ): Promise<void> => {
      await render(<Board options={{ ...base, ...more }} out={out} />)
      await flush()
    }
    await rerender()
    return { server, clock, sockets, out, playhead, socketsAtAsk, rerender }
  }

  it('opens the change socket first, then fetches the window', async function () {
    const steps = [
      boardStep(OVERLAY_T0 - 5000, 0),
      boardStep(OVERLAY_T0 + 1000, 1)
    ]
    const { out, sockets, socketsAtAsk, server } = await setup({}, steps)
    expect(sockets.sockets).length(1)
    expect(sockets.latest().url).equals(
      'ws://localhost/api/v1/scoreboard/g1/socket?timeline=1'
    )
    expect(socketsAtAsk[0]).equals(1)
    expect(boardAsks(server)).deep.equals([OVERLAY_T0])
    expect(out.current?.steps).deep.equals(steps)
  })

  it('refetches from a minute before the frame on each change notice, keeping the steps before', async function () {
    const early = boardStep(OVERLAY_T0, 0)
    const middle = boardStep(OVERLAY_T0 + 100_000, 1)
    const late = boardStep(OVERLAY_T0 + 200_000, 2)
    const h = await setup({}, [early, middle, late])
    h.sockets.latest().open()
    await flush()
    h.playhead.wall = OVERLAY_T0 + 230_000
    const heldEarly = h.out.current?.steps?.[0]

    // An undo took the last step back, and a later pitch arrived.
    const corrected = [early, middle, boardStep(OVERLAY_T0 + 210_000, 3)]
    h.server.steps.set('g1', corrected)
    const asked = boardAsks(h.server).length
    h.sockets.latest().receive({ type: 'changed' })
    h.sockets.latest().receive({ type: 'changed' })
    h.sockets.latest().receive('not json')
    h.sockets.latest().receive({ type: 'something else' })
    await advance(h.clock, NOTICE_DEBOUNCE_MS - 1)
    expect(boardAsks(h.server)).length(asked)
    await advance(h.clock, 1)
    // One refetch for the burst, from a minute before the frame on screen.
    expect(boardAsks(h.server).slice(asked)).deep.equals([
      OVERLAY_T0 + 230_000 - LOOK_BACK_MS
    ])
    expect(h.out.current?.steps).deep.equals(corrected)
    // The steps before that point are the ones already held.
    expect(h.out.current?.steps?.[0]).equals(heldEarly)
  })

  it('never refetches from before the window', async function () {
    const h = await setup({}, [boardStep(OVERLAY_T0)])
    h.sockets.latest().open()
    await flush()
    h.playhead.wall = OVERLAY_T0 + 10_000
    h.sockets.latest().receive({ type: 'changed' })
    await advance(h.clock, NOTICE_DEBOUNCE_MS)
    expect(boardAsks(h.server).at(-1)).equals(OVERLAY_T0)
  })

  it('refetches the window around every seek', async function () {
    const h = await setup({ live: false }, [boardStep(OVERLAY_T0)])
    expect(h.sockets.sockets).length(0)
    await act(async () => {
      h.out.current?.refetchAround(OVERLAY_T0 + 3_600_000)
    })
    await flush()
    expect(boardAsks(h.server)).deep.equals([
      OVERLAY_T0,
      OVERLAY_T0 + 3_600_000 - LOOK_BACK_MS
    ])
    await act(async () => {
      h.out.current?.refetchAround(null)
    })
    await flush()
    expect(boardAsks(h.server).at(-1)).equals(OVERLAY_T0)
  })

  it('polls every ten seconds while its socket is closed, and catches up on each open', async function () {
    const h = await setup({}, [boardStep(OVERLAY_T0)])
    h.playhead.wall = OVERLAY_T0 + 120_000
    const asks = (): number => boardAsks(h.server).length
    const opened = asks()
    // Never opened yet: closed, so it polls.
    await advance(h.clock, BOARD_POLL_MS)
    expect(asks()).equals(opened + 1)
    h.sockets.latest().open()
    await flush()
    expect(asks()).equals(opened + 2)
    // Open: no polling.
    await advance(h.clock, BOARD_POLL_MS * 2)
    expect(asks()).equals(opened + 2)
    // Lost: polls again until the socket is back.
    h.sockets.latest().drop(1006)
    await advance(h.clock, BOARD_POLL_MS)
    expect(asks()).greaterThan(opened + 2)
  })

  it('keeps polling when the board is gone for good, and when the request fails', async function () {
    const h = await setup({}, [boardStep(OVERLAY_T0)])
    h.sockets.latest().open()
    await flush()
    h.sockets.latest().drop(4404)
    h.server.fail.add('/games/g1/scoreboard-timeline')
    const asks = boardAsks(h.server).length
    await advance(h.clock, BOARD_POLL_MS)
    expect(boardAsks(h.server).length).equals(asks + 1)
    expect(h.out.current?.steps).length(1)
  })

  it('signs its socket in with the session a phone holds, and none in a browser', async function () {
    const h = await setup({
      client: new TeamStationClient({
        baseUrl: '/api/v1',
        token: 'tok_phone',
        fetch: async (input, init) => await overlayServer().fetch(input, init)
      })
    })
    expect(h.sockets.latest().headers).deep.equals({
      Authorization: 'Bearer tok_phone'
    })
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    // A browser's client holds no token: its cookie goes by itself.
    const browser = await setup()
    expect(browser.sockets.latest().headers).equals(undefined)
  })

  for (const code of [4401, 4403]) {
    it(`stops trying the socket after ${code}, and polls every ten seconds instead`, async function () {
      const h = await setup({}, [boardStep(OVERLAY_T0)])
      h.playhead.wall = OVERLAY_T0 + 120_000
      h.sockets.latest().open()
      await flush()
      const asks = boardAsks(h.server).length
      h.sockets.latest().drop(code)
      await advance(h.clock, BOARD_POLL_MS)
      expect(boardAsks(h.server).length).equals(asks + 1)
      for (let i = 0; i < 3; i++) await advance(h.clock, BOARD_POLL_MS)
      expect(boardAsks(h.server).length).equals(asks + 4)
      // Never reopened.
      expect(h.sockets.sockets).length(1)
    })
  }

  it('closes its socket when unmounted, and when the stream ends', async function () {
    const h = await setup({}, [boardStep(OVERLAY_T0)])
    const first = h.sockets.latest()
    first.open()
    await flush()
    // The stream ended: the same game's steps stay while it is fetched again.
    await h.rerender({ live: false })
    expect(first.closedWith).equals(1000)
    expect(h.out.current?.steps).length(1)
    expect(h.sockets.sockets).length(1)

    await h.rerender({ live: true })
    const second = h.sockets.latest()
    expect(second).not.equals(first)
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    expect(second.closedWith).equals(1000)
  })

  it('fetches nothing for no game, or before the window is known, and forgets another game’s steps', async function () {
    const h = await setup({ gameId: null }, [boardStep(OVERLAY_T0)])
    expect(boardAsks(h.server)).length(0)
    expect(h.sockets.sockets).length(0)
    expect(h.out.current?.steps).equals(null)
    await h.rerender({ gameId: 'g1', fromMs: null })
    expect(boardAsks(h.server)).length(0)
    await h.rerender({ gameId: 'g1' })
    expect(h.out.current?.steps).length(1)
    h.server.steps.set('g2', [])
    await h.rerender({ gameId: 'g2', live: false })
    expect(h.out.current?.steps).deep.equals([])
  })

  it('has no socket where there is no address for one, and polls instead', async function () {
    const h = await setup({
      origin: undefined,
      client: new TeamStationClient({ baseUrl: 'not a url at all' })
    })
    expect(h.sockets.sockets).length(0)
  })
})

describe('the step for the frame on screen (U36)', function () {
  /** Frames the test runs by hand. */
  function manualFrames(): FrameLoop & { run: () => void; pending: number } {
    let queued: (() => void) | null = null
    const loop = {
      pending: 0,
      request: (run: () => void) => {
        queued = run
        loop.pending++
        return loop.pending
      },
      cancel: () => {
        queued = null
      },
      run: () => {
        const run = queued
        queued = null
        run?.()
      }
    }
    return loop
  }

  it('changes on the frame the wall time reaches a step, and reports seeks', async function () {
    const frames = manualFrames()
    const steps = [boardStep(OVERLAY_T0, 0), boardStep(OVERLAY_T0 + 1000, 1)]
    let wall: number | null = null
    let clock = 0
    const seeks: number[] = []
    const shown: Array<BoardStep | null> = []
    function Step(): null {
      shown.push(
        usePlayheadStep({
          steps,
          wallNow: () => wall,
          onSeek: at => seeks.push(at),
          frames,
          now: () => clock
        })
      )
      return null
    }
    await render(<Step />)
    expect(shown.at(-1)).equals(null)
    const frame = async (
      wallMs: number | null,
      atMs: number
    ): Promise<void> => {
      wall = wallMs
      clock = atMs
      await act(async () => {
        frames.run()
      })
    }
    await frame(OVERLAY_T0 + 999, 16)
    expect(shown.at(-1)).equals(steps[0])
    const renders = shown.length
    await frame(OVERLAY_T0 + 999, 32)
    expect(shown.length).equals(renders)
    await frame(OVERLAY_T0 + 1016, 48)
    expect(shown.at(-1)).equals(steps[1])
    expect(seeks).deep.equals([])
    // A jump forward past the clock, and one back, are seeks.
    await frame(OVERLAY_T0 + 1016 + SEEK_JUMP_MS + 100, 64)
    await frame(OVERLAY_T0 + 500, 80)
    expect(seeks).deep.equals([
      OVERLAY_T0 + 1016 + SEEK_JUMP_MS + 100,
      OVERLAY_T0 + 500
    ])
    // No picture yet: no board.
    await frame(null, 96)
    expect(shown.at(-1)).equals(null)
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })
})
