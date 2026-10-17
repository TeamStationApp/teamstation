import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { type BoardStep, TeamStationClient } from '../../../common/api'
import { SAMPLE_SCOREBOARD } from '../../../common/scoreboard'
import {
  boardStep,
  layOutBoards,
  OVERLAY_T0,
  overlayServer,
  settle,
  SHOWN_OVERLAY,
  urlOf,
  wallTimelineOf
} from '../../../test/overlayFixtures'
import type { Rect } from '../controlGeometry'
import type { VideoHandle } from '../videoHandle'
import { widthAt } from './overlayLayout'
import {
  PictureScoreboard,
  ScoreboardOverlay,
  type ScoreboardOverlayProps
} from './ScoreboardOverlay'
import { overlayRetry } from './useScoreboardOverlay'

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

const overlay = (): HTMLElement | null =>
  document.querySelector('[data-testid="scoreboard-overlay"]')

/** The transform that scales the board, as the browser was told it. */
function scaleOf(element: HTMLElement): number {
  const inner = element.firstElementChild?.firstElementChild as HTMLElement
  const match = /scale\(([\d.]+)\)/.exec(inner.style.transform)
  return match == null ? 1 : Number(match[1])
}

describe('the scoreboard overlay (C1, U32)', function () {
  const at =
    (rect: Rect): ScoreboardOverlayProps['place'] =>
    () =>
      rect

  it('draws nothing without a step', async function () {
    await render(
      <ScoreboardOverlay step={null} place={at({ x: 0, y: 0, w: 1, h: 1 })} />
    )
    expect(document.querySelector('[data-scoreboard="board"]')).equals(null)
    expect(overlay()).equals(null)
  })

  it('measures the board, then scales it to the height it is given', async function () {
    const step = boardStep(OVERLAY_T0 + 1234, 2)
    const sizes: Array<{ width: number; height: number }> = []
    const placed: Array<{ width: number; height: number }> = []
    await render(
      <ScoreboardOverlay
        step={step}
        place={natural => {
          placed.push(natural)
          return {
            x: 20,
            y: 10,
            w: widthAt(natural, 144),
            h: 144
          }
        }}
        onNaturalSize={size => sizes.push(size)}
      />
    )
    // Drawn, unseen, so it can be measured; not yet the overlay.
    expect(document.querySelector('[data-scoreboard="board"]')).not.equals(null)
    expect(overlay()).equals(null)

    await layOutBoards(607, 247)
    const drawn = overlay()!
    expect(drawn.getAttribute('data-at')).equals(String(OVERLAY_T0 + 1234))
    expect(drawn.style.left).equals('20px')
    expect(drawn.style.top).equals('10px')
    expect(drawn.style.height).equals('144px')
    // Its width follows the board's own shape.
    expect(Number.parseFloat(drawn.style.width)).closeTo(
      (144 * 607) / 247,
      0.01
    )
    expect(scaleOf(drawn)).closeTo(144 / 247, 1e-6)
    expect(placed.at(-1)).deep.equals({ width: 607, height: 247 })
    expect(sizes.at(-1)).deep.equals({ width: 607, height: 247 })
    // It catches no touches.
    expect(getComputedStyle(drawn).pointerEvents).equals('none')
  })

  it('grows wider, not shorter, for long team names', async function () {
    const step = boardStep(OVERLAY_T0, 0, {
      away: 'Port Kestrel Lighthouse Keepers of the North',
      home: 'Cedar Hollow Owls'
    })
    await render(
      <ScoreboardOverlay
        step={step}
        place={natural => ({ x: 0, y: 0, w: widthAt(natural, 100), h: 100 })}
      />
    )
    await layOutBoards(980, 247)
    const long = overlay()!
    expect(long.style.height).equals('100px')
    expect(Number.parseFloat(long.style.width)).closeTo((100 * 980) / 247, 0.01)
    expect(long.textContent).includes(
      'Port Kestrel Lighthouse Keepers of the North'
    )
  })

  it('keeps out of sight where there is no room for it', async function () {
    await render(
      <ScoreboardOverlay step={boardStep(OVERLAY_T0)} place={() => null} />
    )
    await layOutBoards(607, 247)
    expect(overlay()).equals(null)
    expect(document.querySelector('[data-scoreboard="board"]')).not.equals(null)
  })

  it('ignores a layout with no size, and the same size twice', async function () {
    const sizes: unknown[] = []
    await render(
      <ScoreboardOverlay
        step={boardStep(OVERLAY_T0)}
        place={natural => ({ x: 0, y: 0, w: natural.width, h: natural.height })}
        onNaturalSize={size => sizes.push(size)}
      />
    )
    await layOutBoards(0, 0)
    expect(overlay()).equals(null)
    await layOutBoards(607, 247)
    await layOutBoards(607, 247)
    expect(overlay()).not.equals(null)
    expect(scaleOf(overlay()!)).equals(1)
  })
})

/**
 * A ten-minute video, paused at its start, that the test moves by hand. Its
 * player has not loaded its length: the board goes by the server's.
 */
function fakeVideo(): VideoHandle {
  return {
    currentTime: 0,
    duration: Number.NaN,
    paused: true
  } as unknown as VideoHandle
}

describe('the board over a single picture', function () {
  async function picture(options: {
    gameId: string | null
    steps?: BoardStep[]
    /** The game is before the overlay's start date. */
    early?: boolean
    /** The overlay's answer cannot be had until the test allows it. */
    overlayDown?: boolean
    /** The video's length as the server has it; ten minutes by default. */
    durationSec?: number | null
  }): Promise<{
    video: VideoHandle
    asked: ReturnType<typeof overlayServer>['asked']
    server: ReturnType<typeof overlayServer>
    show: (gameId: string, videoId: string) => Promise<void>
  }> {
    const server = overlayServer()
    server.timelines.set('v1', wallTimelineOf([[0, OVERLAY_T0]]))
    server.steps.set('g1', options.steps ?? [])
    if (options.early === true)
      server.overlays.set('g1', { ...SHOWN_OVERLAY, show: false })
    if (options.overlayDown === true)
      server.fail.add('/games/g1/scoreboard-overlay')
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: server.fetch
    })
    const video = fakeVideo()
    const ref = { current: video }
    const show = async (
      gameId: string | null,
      videoId: string
    ): Promise<void> => {
      await render(
        <PictureScoreboard
          client={client}
          gameId={gameId}
          videoId={videoId}
          live={false}
          durationSec={
            options.durationSec === undefined ? 600 : options.durationSec
          }
          picture={{ x: 0, y: 0, w: 1280, h: 720 }}
          videoRef={ref}
        />
      )
      await settle()
    }
    await show(options.gameId, 'v1')
    return { video, asked: server.asked, server, show }
  }

  it("shows the step at the wall time of the frame on screen, where the node's setting puts it", async function () {
    const { video } = await picture({
      gameId: 'g1',
      steps: [boardStep(OVERLAY_T0 + 1000, 1), boardStep(OVERLAY_T0 + 5000, 2)]
    })
    // Before the first step: the board already, with the team names and
    // every other figure zero.
    await layOutBoards(607, 170)
    expect(overlay()).not.equals(null)
    const text = overlay()?.textContent ?? ''
    expect(text).contains(SAMPLE_SCOREBOARD.awayTeam)
    expect(text).contains(SAMPLE_SCOREBOARD.homeTeam)
    expect(
      document.querySelector('[data-scoreboard="count"]')?.textContent
    ).equals('0-0')
    expect(
      document.querySelector('[data-scoreboard="inning"]')?.textContent
    ).equals('0')
    expect(
      [
        ...document.querySelectorAll(
          '[data-scoreboard="top"], [data-scoreboard="bottom"]'
        )
      ].map(node => node.getAttribute('data-lit'))
    ).deep.equals(['false', 'false'])
    expect(document.querySelector('[data-scoreboard="batter"]')).equals(null)

    video.currentTime = 2
    await settle()
    await layOutBoards(607, 247)
    expect(overlay()?.getAttribute('data-at')).equals(String(OVERLAY_T0 + 1000))
    // The defaults: 1% in from the picture's top-left, the full board 15%
    // of its height.
    expect(overlay()?.style.height).equals(`${0.15 * 720}px`)
    expect(overlay()?.style.top).equals(`${0.01 * 720}px`)
    expect(overlay()?.style.left).equals(`${0.01 * 1280}px`)

    video.currentTime = 6
    await settle()
    expect(overlay()?.getAttribute('data-at')).equals(String(OVERLAY_T0 + 5000))
  })

  it('draws nothing for a recording whose length the server does not have yet', async function () {
    // The game's only event is twenty minutes after the video starts.
    const { video } = await picture({
      gameId: 'g1',
      steps: [boardStep(OVERLAY_T0 + 20 * 60_000, 1)],
      durationSec: null
    })
    video.currentTime = 5
    await settle()
    await layOutBoards(607, 247)
    expect(overlay()).equals(null)
  })

  it('draws nothing for a video with none of its game’s events in its time frame', async function () {
    // The game's only event is twenty minutes in; the video is ten long.
    const { video } = await picture({
      gameId: 'g1',
      steps: [boardStep(OVERLAY_T0 + 20 * 60_000, 1)]
    })
    for (const seconds of [0, 300, 590]) {
      video.currentTime = seconds
      await settle()
      await layOutBoards(607, 247)
      expect(overlay(), `${seconds} s`).equals(null)
    }
  })

  it('keeps the board once shown, through videos with none of the game’s events, but not for another game', async function () {
    const steps = [
      boardStep(OVERLAY_T0 + 1000, 1),
      boardStep(OVERLAY_T0 + 5000, 2)
    ]
    const { video, server, show } = await picture({ gameId: 'g1', steps })
    video.currentTime = 2
    await settle()
    await layOutBoards(607, 247)
    expect(overlay()?.getAttribute('data-at')).equals(String(OVERLAY_T0 + 1000))

    // An hour after the game: the board as the game left it.
    server.timelines.set('after', wallTimelineOf([[0, OVERLAY_T0 + 3_600_000]]))
    await show('g1', 'after')
    await layOutBoards(607, 247)
    expect(overlay()?.getAttribute('data-at')).equals(String(OVERLAY_T0 + 5000))

    // An hour before it: the zeroed board.
    server.timelines.set(
      'before',
      wallTimelineOf([[0, OVERLAY_T0 - 3_600_000]])
    )
    await show('g1', 'before')
    await layOutBoards(607, 170)
    expect(overlay()?.getAttribute('data-at')).equals(
      String(OVERLAY_T0 - 3_600_000 + 2000)
    )
    expect(
      document.querySelector('[data-scoreboard="inning"]')?.textContent
    ).equals('0')

    // A video whose timeline cannot be had: the last board, still there.
    server.fail.add('/videos/broken/wall-timeline')
    await show('g1', 'broken')
    await layOutBoards(607, 170)
    expect(overlay()).not.equals(null)

    // Another game, with none of its events in the frame: no board.
    server.steps.set('g2', [boardStep(OVERLAY_T0 + 20 * 60_000, 1)])
    await show('g2', 'v1')
    await layOutBoards(607, 247)
    expect(overlay()).equals(null)
  })

  it("reads the node's placement again when the next video loads", async function () {
    const steps = [boardStep(OVERLAY_T0 + 1000, 1)]
    const { video, server, show } = await picture({ gameId: 'g1', steps })
    video.currentTime = 2
    await settle()
    await layOutBoards(607, 247)
    expect(overlay()?.style.top).equals(`${0.01 * 720}px`)

    // An administrator moves the board down; the next video has it there.
    server.overlays.set('g1', {
      ...SHOWN_OVERLAY,
      single: { x: 0.005, y: 0.5, height: 0.15 }
    })
    server.timelines.set('v2', wallTimelineOf([[0, OVERLAY_T0]]))
    await show('g1', 'v2')
    await layOutBoards(607, 247)
    expect(overlay()?.style.top).equals(`${0.5 * 720}px`)
  })

  it('takes the board away when the next video is told the game shows none', async function () {
    const steps = [boardStep(OVERLAY_T0 + 1000, 1)]
    const { video, server, show } = await picture({ gameId: 'g1', steps })
    video.currentTime = 2
    await settle()
    await layOutBoards(607, 247)
    expect(overlay()).not.equals(null)
    // An administrator moves the start date past the game.
    server.overlays.set('g1', { ...SHOWN_OVERLAY, show: false })
    server.timelines.set('v2', wallTimelineOf([[0, OVERLAY_T0]]))
    await show('g1', 'v2')
    await layOutBoards(607, 247)
    expect(document.querySelector('[data-scoreboard="board"]')).equals(null)
  })

  it('asks again after an answer that failed, while the player is open', async function () {
    const was = { ...overlayRetry }
    overlayRetry.firstMs = 20
    try {
      const { video, server } = await picture({
        gameId: 'g1',
        steps: [boardStep(OVERLAY_T0 + 1000, 1)],
        overlayDown: true
      })
      video.currentTime = 2
      await settle()
      await layOutBoards(607, 247)
      expect(overlay()).equals(null)
      server.fail.delete('/games/g1/scoreboard-overlay')
      await settle(200)
      await layOutBoards(607, 247)
      expect(overlay()).not.equals(null)
    } finally {
      Object.assign(overlayRetry, was)
    }
  })

  it('does not ask again after a refusal or an answer it cannot read', async function () {
    const was = { ...overlayRetry }
    overlayRetry.firstMs = 20
    try {
      for (const refusal of [
        new Response(
          JSON.stringify({ code: 'membersOnly', message: 'For members' }),
          { status: 403, headers: { 'content-type': 'application/json' } }
        ),
        new Response(JSON.stringify({ shows: 'maybe' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      ]) {
        const server = overlayServer()
        server.timelines.set('v1', wallTimelineOf([[0, OVERLAY_T0]]))
        const client = new TeamStationClient({
          baseUrl: '/api/v1',
          fetch: async (input, init) => {
            const path = new URL(urlOf(input), 'http://localhost').pathname
            if (path.endsWith('/scoreboard-overlay')) {
              server.asked.push({ path, query: new URLSearchParams() })
              return refusal.clone()
            }
            return await server.fetch(input, init)
          }
        })
        await render(
          <PictureScoreboard
            client={client}
            gameId="g1"
            videoId="v1"
            live={false}
            durationSec={600}
            picture={{ x: 0, y: 0, w: 1280, h: 720 }}
            videoRef={{ current: fakeVideo() }}
          />
        )
        await settle(200)
        const asks = server.asked.filter(one =>
          one.path.endsWith('/scoreboard-overlay')
        )
        expect(asks, String(refusal.status)).length(1)
      }
    } finally {
      Object.assign(overlayRetry, was)
    }
  })

  it('asks again after a body that broke off on the way, or a 429', async function () {
    const was = { ...overlayRetry }
    overlayRetry.firstMs = 20
    try {
      for (const [name, failure] of [
        [
          'a body that broke off',
          // Answered, then the connection dropped while the body was read.
          () =>
            ({
              ok: true,
              status: 200,
              text: async () => {
                throw new TypeError('Load failed')
              }
            }) as unknown as Response
        ],
        [
          'a 429',
          () =>
            new Response(
              JSON.stringify({ code: 'rateLimited', message: 'Slow down' }),
              { status: 429, headers: { 'content-type': 'application/json' } }
            )
        ]
      ] as const) {
        const server = overlayServer()
        server.timelines.set('v1', wallTimelineOf([[0, OVERLAY_T0]]))
        let first = true
        const client = new TeamStationClient({
          baseUrl: '/api/v1',
          fetch: async (input, init) => {
            const path = new URL(urlOf(input), 'http://localhost').pathname
            if (path.endsWith('/scoreboard-overlay') && first) {
              first = false
              server.asked.push({ path, query: new URLSearchParams() })
              return failure()
            }
            return await server.fetch(input, init)
          }
        })
        await render(
          <PictureScoreboard
            client={client}
            gameId="g1"
            videoId="v1"
            live={false}
            durationSec={600}
            picture={{ x: 0, y: 0, w: 1280, h: 720 }}
            videoRef={{ current: fakeVideo() }}
          />
        )
        await settle(200)
        const asks = server.asked.filter(one =>
          one.path.endsWith('/scoreboard-overlay')
        )
        expect(asks, name).length(2)
      }
    } finally {
      Object.assign(overlayRetry, was)
    }
  })

  it('forgets an earlier answer once the game is refused, and draws no board', async function () {
    const steps = [boardStep(OVERLAY_T0 + 1000, 1)]
    const { video, server, show } = await picture({ gameId: 'g1', steps })
    video.currentTime = 2
    await settle()
    await layOutBoards(607, 247)
    expect(overlay()).not.equals(null)
    // The viewer loses access; the next video is refused.
    server.fail.add('/games/g1/scoreboard-overlay')
    server.failStatus = 403
    server.timelines.set('v2', wallTimelineOf([[0, OVERLAY_T0]]))
    await show('g1', 'v2')
    await layOutBoards(607, 247)
    expect(document.querySelector('[data-scoreboard="board"]')).equals(null)
  })

  it('draws nothing, and asks for no board, for a game before the start date', async function () {
    const { video, asked } = await picture({
      gameId: 'g1',
      early: true,
      steps: [boardStep(OVERLAY_T0 + 1000, 1)]
    })
    video.currentTime = 2
    await settle()
    await layOutBoards(607, 247)
    expect(document.querySelector('[data-scoreboard="board"]')).equals(null)
    expect(asked.some(one => one.path.includes('scoreboard-overlay'))).equals(
      true
    )
    expect(asked.some(one => one.path.includes('scoreboard-timeline'))).equals(
      false
    )
  })

  it('draws nothing, and asks for no board, for a video with no game', async function () {
    const { video, asked } = await picture({ gameId: null })
    video.currentTime = 2
    await settle()
    expect(document.querySelector('[data-scoreboard="board"]')).equals(null)
    expect(asked.some(one => one.path.includes('scoreboard-timeline'))).equals(
      false
    )
  })
})
