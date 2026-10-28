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
import { lstrings } from '../locales/strings'
import { GameScreen } from '../screens/GameScreen'
import { ThemeProvider } from '../theme/ThemeContext'
import { PlayerSurface } from './PlayerSurface'
import type { VideoHandle } from './videoHandle'

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
function fakeVideo(): VideoHandle & {
  calls: string[]
  emit: (name: string) => void
} {
  const calls: string[] = []
  const listeners = new Map<string, Set<() => void>>()
  const video = {
    calls,
    emit(name: string) {
      for (const listener of listeners.get(name) ?? []) listener()
    },
    currentTime: 2,
    duration: 600,
    paused: true,
    playbackRate: 1,
    muted: true,
    async play() {
      calls.push('play')
      video.paused = false
      video.emit('play')
    },
    pause() {
      calls.push('pause')
      video.paused = true
      video.emit('pause')
    },
    addEventListener(name: string, listener: () => void) {
      listeners.set(name, (listeners.get(name) ?? new Set()).add(listener))
    },
    removeEventListener(name: string, listener: () => void) {
      listeners.get(name)?.delete(listener)
    }
  }
  return video as unknown as VideoHandle & {
    calls: string[]
    emit: (name: string) => void
  }
}

describe('the board over the single player (C2)', function () {
  afterEach(unmount)

  it('is drawn over the picture at single, with one press to open the player and nothing else (U11)', async function () {
    const server = overlayServer()
    server.timelines.set('v1', wallTimelineOf([[0, OVERLAY_T0]]))
    server.steps.set('g1', [boardStep(OVERLAY_T0 + 1000, 1)])
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: server.fetch
    })
    const video = fakeVideo()
    const ref = { current: video as VideoHandle }
    let opened = 0
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
        onOpen={() => {
          opened += 1
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
    // Inside the surface, after the picture: drawn over it, at `single`.
    const picture = document.querySelector('[data-testid="picture"]')!
    const surface = picture.parentElement!
    const order = [...surface.children]
    expect(order.indexOf(board)).greaterThan(order.indexOf(picture))
    expect(board.style.top).equals(`${0.01 * 360}px`)
    expect(board.style.height).equals(`${0.15 * 360}px`)
    // The sound icon sits in the very top-left corner, level with full
    // screen top right, over the board while the controls show.
    const sound = document.querySelector<HTMLElement>(
      '[data-testid="zoneIcon-volume_off"]'
    )!
    const fullScreen = document.querySelector<HTMLElement>(
      '[data-testid="zoneIcon-fullscreen"]'
    )!
    expect(sound.style.top).equals(fullScreen.style.top)
    expect(Number.parseFloat(sound.style.left)).equals(
      640 -
        Number.parseFloat(fullScreen.style.left) -
        Number.parseFloat(fullScreen.style.width)
    )
    expect(Number.parseFloat(sound.style.top)).lessThan(
      Number.parseFloat(board.style.top) + Number.parseFloat(board.style.height)
    )
    expect(getComputedStyle(board).pointerEvents).equals('none')

    // The top-right square opens the player.
    const open = document.querySelector<HTMLElement>(
      '[data-testid="gameVideoOpen"]'
    )!
    expect(open.getAttribute('aria-label')).equals(lstrings.game_video_open)
    expect(order.indexOf(open)).greaterThan(order.indexOf(board))
    expect(order.at(-1)).equals(open)
    await act(async () => {
      open.click()
    })
    expect(opened).equals(1)
    expect(open.style.left).equals(`${640 * 0.75}px`)
    expect(open.style.width).equals(`${640 / 4}px`)
    // No keys: the picture was not touched.
    await act(async () => {
      document.body.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'ArrowRight',
          bubbles: true
        })
      )
      document.body.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'k', bubbles: true })
      )
    })
    expect(video.calls).deep.equals([])
    expect(video.currentTime).equals(2)
  })

  it('has nothing to press without somewhere to open', async function () {
    await render(
      <PlayerSurface
        videoRef={{ current: fakeVideo() }}
        width={640}
        height={360}
      >
        <div />
      </PlayerSurface>
    )
    expect(document.querySelector('[data-testid="gameVideoOpen"]')).equals(null)
    // Nor a full-screen icon for a square that opens nothing.
    expect(
      document.querySelector('[data-testid="zoneIcon-fullscreen"]')
    ).equals(null)
  })

  it('has no controls while there is no video to play', async function () {
    const video = fakeVideo()
    await render(
      <PlayerSurface
        videoRef={{ current: video }}
        player={video}
        width={640}
        height={360}
        playable={false}
      >
        <div />
      </PlayerSurface>
    )
    expect(document.querySelector('[data-testid="gameVideoZones"]')).equals(
      null
    )
    const icon = document.querySelector<HTMLElement>(
      '[data-testid="zoneIcon-replay_10"]'
    )!
    expect(icon.parentElement!.style.opacity).equals('0')
    const line = document.querySelector<HTMLElement>(
      '[data-testid="gameVideoScrubLine"]'
    )!
    expect(line.style.opacity).equals('0')
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

describe("the event card's press grid (U14)", function () {
  afterEach(unmount)
  const W = 400
  const H = 200

  async function card(): Promise<{
    video: ReturnType<typeof fakeVideo>
    muted: boolean[]
    opened: () => number
    press: (x: number, y: number, holdMs?: number) => Promise<void>
    drag: (y: number, from: number, to: number) => Promise<void>
    shown: () => { icons: boolean; line: boolean }
    rerender: (muted: boolean) => Promise<void>
  }> {
    const video = fakeVideo()
    const ref = { current: video as VideoHandle }
    const muted: boolean[] = []
    let opened = 0
    const view = (mute: boolean): React.ReactElement => (
      <PlayerSurface
        videoRef={ref}
        player={video}
        width={W}
        height={H}
        muted={mute}
        onMutedChange={next => muted.push(next)}
        onOpen={() => {
          opened += 1
        }}
      >
        <div />
      </PlayerSurface>
    )
    await render(view(true))
    const layer = document.querySelector('[data-testid="gameVideoZones"]')!
    const mouse = async (type: string, x: number, y: number): Promise<void> => {
      await act(async () => {
        layer.dispatchEvent(
          new window.MouseEvent(type, {
            bubbles: true,
            clientX: x,
            clientY: y,
            button: 0,
            buttons: type === 'mouseup' ? 0 : 1
          })
        )
      })
    }
    const wait = async (ms: number): Promise<void> => {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, ms))
      })
    }
    return {
      video,
      muted,
      opened: () => opened,
      press: async (x, y, holdMs = 0) => {
        await mouse('mousedown', x, y)
        if (holdMs > 0) await wait(holdMs)
        await mouse('mouseup', x, y)
      },
      drag: async (y, from, to) => {
        await mouse('mousedown', from, y)
        for (const step of [1, 2, 3, 4])
          await mouse('mousemove', from + ((to - from) * step) / 4, y)
        await mouse('mouseup', to, y)
      },
      shown: () => {
        const icon = document.querySelector(
          '[data-testid="zoneIcon-replay_10"]'
        )
        const line = document.querySelector<HTMLElement>(
          '[data-testid="gameVideoScrubLine"]'
        )!
        return {
          icons: icon?.parentElement?.style.opacity === '1',
          line: line.style.opacity === '1'
        }
      },
      rerender: async (mute: boolean) => {
        await act(async () => {
          root!.render(
            <ThemeProvider>
              <GestureHandlerRootView>{view(mute)}</GestureHandlerRootView>
            </ThemeProvider>
          )
        })
      }
    }
  }

  it('runs each square, away from its icon, and shows the controls above the scrub line together', async function () {
    const c = await card()
    expect(c.shown()).deep.equals({ icons: false, line: false })
    // Top left: the sound. Near the square's corner, not its icon.
    await c.press(5, 5)
    expect(c.muted).deep.equals([false])
    expect(c.shown()).deep.equals({ icons: true, line: false })
    // The two top-centre squares bring the controls up and do nothing else.
    await c.press(W * 0.3, 10)
    await c.press(W * 0.7, 40)
    expect(c.video.calls).deep.equals([])
    // The four in the middle play and pause.
    await c.press(W * 0.3, H * 0.3)
    expect(c.video.calls).deep.equals(['play'])
    await c.press(W * 0.7, H * 0.7)
    expect(c.video.calls).deep.equals(['play', 'pause'])
    // Down the sides, two rows each: ten seconds back and on.
    c.video.currentTime = 100
    await c.press(5, H * 0.3)
    expect(c.video.currentTime).equals(90)
    await c.press(5, H * 0.7)
    expect(c.video.currentTime).equals(80)
    await c.press(W - 5, H * 0.3)
    expect(c.video.currentTime).equals(90)
    await c.press(W - 5, H * 0.7)
    expect(c.video.currentTime).equals(100)
    expect(c.shown()).deep.equals({ icons: true, line: false })
  })

  it('shows the sound as it is, and hides the controls a second after the press', async function () {
    const c = await card()
    expect(
      document.querySelector('[data-testid="zoneIcon-volume_off"]')
    ).not.equals(null)
    await c.rerender(false)
    expect(
      document.querySelector('[data-testid="zoneIcon-volume_up"]')
    ).not.equals(null)
    await c.press(W * 0.5, 10)
    expect(c.shown().icons).equals(true)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1100))
    })
    expect(c.shown().icons).equals(false)
  })

  it('seeks on the bottom row without pausing, with only the scrub line showing', async function () {
    const c = await card()
    await c.press(W * 0.5, H * 0.5)
    expect(c.video.paused).equals(false)
    await c.press(W * 0.75, H * 0.9)
    expect(c.video.currentTime).equals(450)
    expect(c.video.paused).equals(false)
    expect(c.shown()).deep.equals({ icons: false, line: true })
    // A drag along it follows the finger, the line alone showing.
    await c.drag(H * 0.95, W * 0.5, W * 0.25)
    expect(c.video.currentTime).equals(150)
    expect(c.shown()).deep.equals({ icons: false, line: true })
    expect(c.video.paused).equals(false)
  })

  it('shows the group under a mouse, but not under one dragging with its button down', async function () {
    const c = await card()
    const layer = document.querySelector('[data-testid="gameVideoZones"]')!
    const hover = async (x: number, y: number, buttons = 0): Promise<void> => {
      const event = new window.MouseEvent('pointermove', {
        buttons,
        bubbles: true
      })
      Object.defineProperty(event, 'pointerType', { value: 'mouse' })
      Object.defineProperty(event, 'offsetX', { value: x })
      Object.defineProperty(event, 'offsetY', { value: y })
      await act(async () => {
        layer.dispatchEvent(event)
      })
    }
    await hover(W * 0.5, H * 0.5)
    expect(c.shown()).deep.equals({ icons: true, line: false })
    await hover(W * 0.5, H * 0.9, 1)
    expect(c.shown()).deep.equals({ icons: true, line: false })
    await hover(W * 0.5, H * 0.9)
    expect(c.shown()).deep.equals({ icons: false, line: true })
  })

  it('shows where the video is on the scrub line’s left and its length on the right, as full screen does', async function () {
    const c = await card()
    const line = document.querySelector<HTMLElement>(
      '[data-testid="gameVideoScrubLine"]'
    )!
    const times = (): string[] =>
      [...line.querySelectorAll<HTMLElement>('div')]
        .filter(node => node.childElementCount === 0)
        .map(node => node.textContent ?? '')
        .filter(text => text !== '')
    expect(times()).deep.equals(['0:02', '10:00'])
    await c.press(W * 0.75, H * 0.9)
    await act(async () => {
      c.video.emit('timeupdate')
    })
    expect(times()).deep.equals(['7:30', '10:00'])
    expect(c.shown().line).equals(true)
  })

  it('seeks to where the finger is on the drawn track, once the track is laid out', async function () {
    const c = await card()
    const line = document.querySelector<HTMLElement>(
      '[data-testid="gameVideoScrubLine"]'
    )!
    // The bar's middle child is the track: between the two clocks.
    const track = line.children[1] as HTMLElement & {
      __reactLayoutHandler?: (event: unknown) => void
    }
    await act(async () => {
      track.__reactLayoutHandler?.({
        nativeEvent: { layout: { x: 60, y: 0, width: 200, height: 24 } }
      })
    })
    // A quarter and three quarters of the way along the track, not the card.
    await c.press(60 + 50, H * 0.9)
    expect(c.video.currentTime).equals(150)
    await c.press(60 + 150, H * 0.9)
    expect(c.video.currentTime).equals(450)
    // Over the left clock, before the track starts: its start.
    await c.press(20, H * 0.9)
    expect(c.video.currentTime).equals(0)
  })

  it('follows the finger along the bar while it drags, before the player has got there', async function () {
    await card()
    const layer = document.querySelector('[data-testid="gameVideoZones"]')!
    const mouse = async (type: string, x: number): Promise<void> => {
      await act(async () => {
        layer.dispatchEvent(
          new window.MouseEvent(type, {
            bubbles: true,
            clientX: x,
            clientY: H * 0.9,
            button: 0,
            buttons: type === 'mouseup' ? 0 : 1
          })
        )
      })
    }
    const left = (): string =>
      [
        ...document
          .querySelector('[data-testid="gameVideoScrubLine"]')!
          .querySelectorAll<HTMLElement>('div')
      ].find(node => node.childElementCount === 0 && node.textContent !== '')!
        .textContent ?? ''
    await mouse('mousedown', W * 0.5)
    await mouse('mousemove', W * 0.5 + 20)
    await mouse('mousemove', W * 0.25)
    // The finger is a quarter of the way along: 2:30 of 10:00, held down.
    expect(left()).equals('2:30')
    await mouse('mousemove', W * 0.75)
    expect(left()).equals('7:30')
    await mouse('mouseup', W * 0.75)
    expect(left()).equals('7:30')
  })

  it('clears its times when its player goes or changes', async function () {
    const video = fakeVideo()
    const view = (player: VideoHandle | null): React.ReactElement => (
      <ThemeProvider>
        <GestureHandlerRootView>
          <PlayerSurface
            videoRef={{ current: player }}
            player={player}
            width={W}
            height={H}
          >
            <div />
          </PlayerSurface>
        </GestureHandlerRootView>
      </ThemeProvider>
    )
    await render(
      <PlayerSurface
        videoRef={{ current: video }}
        player={video}
        width={W}
        height={H}
      >
        <div />
      </PlayerSurface>
    )
    const times = (): string[] =>
      [
        ...document
          .querySelector('[data-testid="gameVideoScrubLine"]')!
          .querySelectorAll<HTMLElement>('div')
      ]
        .filter(node => node.childElementCount === 0)
        .map(node => node.textContent ?? '')
        .filter(text => text !== '')
    const layerPress = (x: number): void => {
      const layer = document.querySelector('[data-testid="gameVideoZones"]')!
      for (const type of ['mousedown', 'mouseup'])
        layer.dispatchEvent(
          new window.MouseEvent(type, {
            bubbles: true,
            clientX: x,
            clientY: H * 0.9,
            button: 0,
            buttons: type === 'mouseup' ? 0 : 1
          })
        )
    }
    expect(times()).deep.equals(['0:02', '10:00'])
    // A seek on its way when the player changes: the new one's time, not it.
    await act(async () => {
      layerPress(W * 0.75)
    })
    expect(times()).deep.equals(['7:30', '10:00'])
    const next = fakeVideo()
    await act(async () => {
      root!.render(view(next))
    })
    expect(times()).deep.equals(['0:02', '10:00'])
    await act(async () => {
      root!.render(view(null))
    })
    expect(times()).deep.equals(['0:00', '0:00'])
  })

  it('keeps the slow motion badge clear of the full-screen icon while it is held', async function () {
    this.timeout(5000)
    await card()
    const layer = document.querySelector('[data-testid="gameVideoZones"]')!
    await act(async () => {
      layer.dispatchEvent(
        new window.MouseEvent('mousedown', {
          bubbles: true,
          clientX: W - 5,
          clientY: H * 0.5,
          button: 0,
          buttons: 1
        })
      )
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 600))
    })
    const badge = [...document.querySelectorAll<HTMLElement>('div')].find(
      node =>
        node.childElementCount === 0 &&
        node.textContent === lstrings.player_slow_mo
    )!.parentElement!
    const icon = document.querySelector<HTMLElement>(
      '[data-testid="zoneIcon-fullscreen"]'
    )!
    expect(icon.parentElement!.style.opacity).equals('1')
    // The badge's right edge is left of the icon's left edge.
    expect(W - Number.parseFloat(badge.style.right)).lessThanOrEqual(
      Number.parseFloat(icon.style.left)
    )
    await act(async () => {
      layer.dispatchEvent(
        new window.MouseEvent('mouseup', {
          bubbles: true,
          clientX: W - 5,
          clientY: H * 0.5,
          button: 0,
          buttons: 0
        })
      )
    })
  })

  it('plays slow for as long as fast forward is held, and opens full screen from the top right', async function () {
    this.timeout(5000)
    const c = await card()
    await c.press(W - 5, H * 0.5, 700)
    // Put back as it was found once the finger lifts.
    expect(c.video.playbackRate).equals(1)
    expect(c.video.calls).includes('play')
    expect(c.video.currentTime).equals(2)
    const open = document.querySelector<HTMLElement>(
      '[data-testid="gameVideoOpen"]'
    )!
    await act(async () => {
      open.click()
    })
    expect(c.opened()).equals(1)
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
