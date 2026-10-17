import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import {
  asGameDetail,
  asHighlightsResponse,
  asVideoSummary,
  TeamStationClient
} from '../../common/api'
import {
  boardStep,
  layOutBoards,
  OVERLAY_T0,
  overlayServer,
  settle,
  wallTimelineOf
} from '../../test/overlayFixtures'
import { GameScreen } from '../screens/GameScreen'
import { ThemeProvider } from '../theme/ThemeContext'
import { PlayerSurface } from './PlayerSurface'
import type { VideoHandle } from './videoHandle'
import { zoneFor } from './zones'

let root: Root | undefined

const gameFixture = asGameDetail({
  nonMemberView: false,
  id: 'g1',
  awayTeamId: 'away',
  homeTeamId: 'home',
  awayTeamName: 'Owls',
  homeTeamName: 'Hawks',
  seasonId: null,
  startAt: null,
  venue: null,
  status: 'final',
  homeScore: 5,
  awayScore: 3,
  ingestStatus: 'pending',
  ingestMessage: null,
  canScore: false,
  videos: []
})

/**
 * Unmounted inside each suite, before the shared setup empties the body: the
 * grid is portalled into the body, and React must take it out itself.
 */
async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
}

async function render(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <GestureHandlerRootView>{element}</GestureHandlerRootView>
      </ThemeProvider>
    )
  })
}

const overlay = (): HTMLElement | null =>
  document.querySelector('[data-testid="scoreboard-overlay"]')

/** A player that plays and pauses when told, and remembers being told. */
function fakeVideo(): VideoHandle & { calls: string[] } {
  const calls: string[] = []
  const video = {
    calls,
    currentTime: 2,
    duration: 600,
    paused: true,
    playbackRate: 1,
    async play() {
      calls.push('play')
      video.paused = false
    },
    pause() {
      calls.push('pause')
      video.paused = true
    },
    addEventListener() {},
    removeEventListener() {}
  }
  return video as unknown as VideoHandle & { calls: string[] }
}

describe('the board over the single player (C2)', function () {
  afterEach(unmount)

  it('is drawn over the picture, and a tap on it reaches the square beneath', async function () {
    const server = overlayServer()
    server.timelines.set('v1', wallTimelineOf([[0, OVERLAY_T0]]))
    server.steps.set('g1', [boardStep(OVERLAY_T0 + 1000, 1)])
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: server.fetch
    })
    const video = fakeVideo()
    const ref = { current: video as VideoHandle }
    await render(
      <PlayerSurface
        videoRef={ref}
        width={640}
        height={360}
        scoreboard={{
          client,
          gameId: 'g1',
          videoId: 'v1',
          live: false,
          durationSec: 600,
          picture: { x: 0, y: 0, w: 640, h: 360 }
        }}
      >
        <div data-testid="picture" />
      </PlayerSurface>
    )
    await settle()
    await layOutBoards(607, 247)

    const board = overlay()!
    expect(board).not.equals(null)
    expect(board.getAttribute('data-at')).equals(String(OVERLAY_T0 + 1000))
    // Inside the surface, after the picture: drawn over it.
    const surface = document.querySelector(
      '[data-testid="picture"]'
    )!.parentElement!
    expect(surface.contains(board)).equals(true)
    const order = [...surface.children]
    expect(order.indexOf(board)).greaterThan(
      order.indexOf(document.querySelector('[data-testid="picture"]')!)
    )
    expect(board.style.top).equals(`${0.01 * 360}px`)
    expect(board.style.height).equals(`${0.15 * 360}px`)
    // It takes no touches, and the squares are all still there after it.
    expect(getComputedStyle(board).pointerEvents).equals('none')
    // Each square is the one child of its gesture detector's wrapper.
    const squares = order
      .slice(order.indexOf(board) + 1)
      .map(node => node.firstElementChild as HTMLElement | null)
      .filter(node => node?.style.position === 'absolute') as HTMLElement[]
    expect(squares.length).greaterThan(0)

    // A press on the board lands on the square beneath it, which is drawn
    // over the board and covers it: the upper-left square, which plays and
    // pauses.
    const px = (value: string): number => Number.parseFloat(value)
    const under = squares.find(
      square =>
        px(square.style.left) <= px(board.style.left) &&
        px(square.style.top) <= px(board.style.top) &&
        px(square.style.left) + px(square.style.width) >=
          px(board.style.left) + px(board.style.width) &&
        px(square.style.top) + px(square.style.height) >=
          px(board.style.top) + px(board.style.height)
    )
    expect(under).not.equals(undefined)
    expect(
      zoneFor(px(board.style.left) + 1, px(board.style.top) + 1, 640, 360)
    ).equals('toggle')
  })

  it('draws no board, and asks for none, while the grid has the screen', async function () {
    const server = overlayServer()
    server.timelines.set('v1', wallTimelineOf([[0, OVERLAY_T0]]))
    server.steps.set('g1', [boardStep(OVERLAY_T0 + 1000, 1)])
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: server.fetch
    })
    await render(
      <PlayerSurface
        videoRef={{ current: fakeVideo() }}
        width={640}
        height={360}
        active={false}
        scoreboard={{
          client,
          gameId: 'g1',
          videoId: 'v1',
          live: false,
          durationSec: 600,
          picture: { x: 0, y: 0, w: 640, h: 360 }
        }}
      >
        <div />
      </PlayerSurface>
    )
    await settle()
    expect(document.querySelector('[data-scoreboard="board"]')).equals(null)
    expect(server.asked).deep.equals([])
  })

  it('draws no board without one to draw', async function () {
    const video = fakeVideo()
    await render(
      <PlayerSurface videoRef={{ current: video }} width={640} height={360}>
        <div />
      </PlayerSurface>
    )
    await settle()
    expect(document.querySelector('[data-scoreboard="board"]')).equals(null)
  })
})

describe('the game page’s player', function () {
  afterEach(unmount)

  function video(id: string): ReturnType<typeof asVideoSummary> {
    return asVideoSummary({
      id,
      title: `Game — ${id}`,
      numCameras: 1,
      kind: 'primary',
      status: 'ready',
      storage: 'local',
      startAt: new Date(OVERLAY_T0).toISOString(),
      durationSec: 300,
      width: 1920,
      height: 1080,
      codecs: null
    })
  }

  async function page(
    videos: Array<ReturnType<typeof asVideoSummary>>,
    angles?: string[]
  ): Promise<ReturnType<typeof overlayServer>> {
    const server = overlayServer()
    for (const one of videos)
      server.timelines.set(one.id, wallTimelineOf([[0, OVERLAY_T0]]))
    server.steps.set(gameFixture.id, [boardStep(OVERLAY_T0 - 1000, 3)])
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: server.fetch
    })
    client.game = async () => ({ ...gameFixture, videos })
    client.highlights = async () =>
      asHighlightsResponse({ withheld: null, droppedCount: 0, highlights: [] })
    client.teams = async () => []
    client.gameScheduling = async () => {
      throw new Error('not a scheduler')
    }
    client.playback = async () => await new Promise(() => undefined)
    // A bare game address opens the event's default section, not Videos, so
    // the page is opened on Videos the way `?video=` or `?angles=` opens it.
    await render(
      <GameScreen
        client={client}
        gameId={gameFixture.id}
        initialTab="watch"
        angles={angles}
      />
    )
    await settle(60)
    return server
  }

  const askedBoard = (server: ReturnType<typeof overlayServer>): boolean =>
    server.asked.some(
      one =>
        one.path === `/games/${gameFixture.id}/scoreboard-timeline` &&
        one.query.get('from') === String(OVERLAY_T0)
    )

  it('hands the player its game, video, start, liveness and picture', async function () {
    const server = await page([video('v1')])
    expect(
      server.asked.some(one => one.path === '/videos/v1/wall-timeline')
    ).equals(true)
    expect(askedBoard(server)).equals(true)
  })

  it('asks for no board for a game with no video', async function () {
    const server = await page([])
    expect(
      server.asked.filter(one => one.path.includes('timeline'))
    ).deep.equals([])
  })

  it('hands the grid its game', async function () {
    const server = await page([video('v1'), video('v2')], ['v1', 'v2'])
    // Each angle's own timeline, for the grid's board; the single player
    // still mounted beneath it asks for its own as well.
    expect(
      new Set(
        server.asked
          .filter(one => one.path.endsWith('/wall-timeline'))
          .map(one => one.path)
      )
    ).deep.equals(
      new Set(['/videos/v1/wall-timeline', '/videos/v2/wall-timeline'])
    )
    expect(askedBoard(server)).equals(true)
  })
})
