import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asVideoSummary,
  TeamStationClient,
  type VideoSummary
} from '../../common/api'
import {
  boardStep,
  layOutBoards,
  OVERLAY_T0,
  overlayServer,
  settle,
  SHOWN_OVERLAY,
  wallTimelineOf
} from '../../test/overlayFixtures'
import { lstrings } from '../locales/strings'
import { ThemeProvider } from '../theme/ThemeContext'
import { tileRects } from './multiCam/layout'
import { GAP, playerLayout } from './multiCam/playerLayout'
import { MultiCamView as BrowserGrid } from './MultiCamView'
import { MultiCamView as PhoneGrid } from './MultiCamView.native'
import { tileBoardRect } from './scoreboardOverlay/overlayLayout'

/**
 * The phone's grid, bundled for the browser: its own file, drawn with React
 * Native Web, its players the browser's `<video>`, and no insets, so what it
 * places can be held against the browser's grid at the same size.
 */

let root: Root | undefined

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
}

/** The window, as React Native reads it in a browser. */
async function windowSize(width: number, height: number): Promise<void> {
  const html = document.documentElement
  Object.defineProperty(html, 'clientWidth', {
    configurable: true,
    value: width
  })
  Object.defineProperty(html, 'clientHeight', {
    configurable: true,
    value: height
  })
  await act(async () => {
    window.dispatchEvent(new window.Event('resize'))
  })
}

function angle(id: string): VideoSummary {
  return asVideoSummary({
    id,
    kind: 'game',
    title: `Angle ${id}`,
    status: 'ready',
    storage: 'spaces',
    startAt: new Date(OVERLAY_T0).toISOString(),
    durationSec: 600,
    width: 1920,
    height: 1080,
    codecs: null
  })
}

const IDS = ['a', 'b', 'c', 'd']

const STEPS = [
  boardStep(OVERLAY_T0 + 10_000, 1),
  boardStep(OVERLAY_T0 + 95_000, 2)
]

async function grid(options: {
  Grid: typeof PhoneGrid
  width: number
  height: number
  gameId?: string
  steps?: Array<ReturnType<typeof boardStep>>
  /** Each angle's player is given an address, rather than waiting for one. */
  playable?: boolean
}): Promise<void> {
  await windowSize(options.width, options.height)
  const server = overlayServer()
  // b's frames are a minute and a half later than its start says, which only
  // its timeline knows.
  server.timelines.set('a', wallTimelineOf([[0, OVERLAY_T0]]))
  server.timelines.set('b', wallTimelineOf([[0, OVERLAY_T0 + 90_000]]))
  server.timelines.set('c', wallTimelineOf([[0, OVERLAY_T0]]))
  server.timelines.set('d', wallTimelineOf([[0, OVERLAY_T0]]))
  server.steps.set('g1', options.steps ?? STEPS)
  const client = new TeamStationClient({
    baseUrl: '/api/v1',
    fetch: server.fetch
  })
  client.playback =
    options.playable === true
      ? async videoId => ({
          videoId,
          storage: 'spaces',
          url: `https://media.example.test/${videoId}/index.m3u8`,
          expiresAt: null,
          durationSec: 600,
          unavailable: false
        })
      : async () => await new Promise(() => undefined)
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const { Grid } = options
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <Grid
          client={client}
          gameId={'gameId' in options ? options.gameId : 'g1'}
          videos={IDS.map(angle)}
          order={IDS}
          audioId="b"
          zoomedId={null}
          onChange={() => undefined}
          onClose={() => undefined}
        />
      </ThemeProvider>
    )
  })
  await settle(60)
  // Twenty seconds into every angle: the heard one's frame is 110 s on the
  // wall by its own timeline.
  for (const video of document.querySelectorAll('video'))
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      value: 20
    })
  await settle()
  await layOutBoards(607, 247)
}

const overlays = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(
    '[data-testid="scoreboard-overlay"]'
  )
]

const px = (value: string): number => Number.parseFloat(value)

/** A drawn element's box, as its own style places it. */
function boxOf(element: HTMLElement): {
  x: number
  y: number
  w: number
  h: number
} {
  return {
    x: px(element.style.left),
    y: px(element.style.top),
    w: px(element.style.width),
    h: px(element.style.height)
  }
}

/** Each tile's box, by the player it holds. */
function tileBoxes(): Array<{ x: number; y: number; w: number; h: number }> {
  return [...document.querySelectorAll('video')].map(video => {
    let node = video.parentElement
    while (node?.style.top === '') node = node.parentElement
    if (node == null) throw new Error('A tile with no place')
    return boxOf(node)
  })
}

/** Whether any tile draws its angle's name: none does. */
function namesShown(): boolean {
  return [...document.querySelectorAll<HTMLElement>('div')].some(
    one =>
      one.childElementCount === 0 && (one.textContent ?? '').includes('Angle ')
  )
}

/** The board, where it is placed, and where its clip is. */
function placed(): {
  at: string | null
  board: ReturnType<typeof boxOf>
  clip: ReturnType<typeof boxOf>
} {
  const drawn = overlays()
  expect(drawn).length(1)
  return {
    at: drawn[0].getAttribute('data-at'),
    board: boxOf(drawn[0]),
    clip: boxOf(drawn[0].parentElement!)
  }
}

describe('the board over the phone’s grid (C5)', function () {
  afterEach(unmount)

  it('names each tile as a picture of its angle', async function () {
    await grid({ Grid: PhoneGrid, width: 402, height: 874 })
    const named = [...document.querySelectorAll('video')].map(video => {
      let node = video.parentElement
      while (node?.style.top === '') node = node.parentElement
      return node?.getAttribute('aria-label') ?? null
    })
    expect(named).length(4)
    for (const label of named) expect(label).match(/^Angle \S+ angle$/)
  })

  it('draws one board on the top of the screen, the stacked angles butted under it, upright', async function () {
    await grid({ Grid: PhoneGrid, width: 402, height: 874 })
    const { at, board } = placed()
    expect(at).equals(String(OVERLAY_T0 + 95_000))
    const layout = playerLayout({
      screen: { width: 402, height: 874 },
      safe: { x: 0, y: 0, w: 402, h: 874 },
      count: 4,
      aspect: 16 / 9,
      landscape: false,
      settings: SHOWN_OVERLAY,
      board: { width: 607, height: 247 },
      line: false
    })
    expect(board.x).closeTo(layout.board!.x, 0.01)
    expect(board.y).closeTo(0, 0.01)
    expect(board.h).closeTo(layout.board!.h, 0.01)
    const tiles = tileBoxes()
    expect(tiles).length(4)
    tiles.forEach((tile, index) => {
      expect(tile.y).closeTo(layout.tiles[index].y, 0.01)
      expect(tile.y).at.least(board.y + board.h + GAP - 0.01)
    })
  })

  it("draws one board over the top-left angle of four, sideways, where the node's setting puts it", async function () {
    await grid({ Grid: PhoneGrid, width: 874, height: 402 })
    const { board, clip } = placed()
    const [corner] = tileRects({ width: 874, height: 402, count: 4 })
    expect(clip.x).closeTo(corner.x, 0.01)
    expect(clip.y).closeTo(corner.y, 0.01)
    expect(clip.w).closeTo(corner.w, 0.01)
    expect(clip.h).closeTo(corner.h, 0.01)
    const landscape = { x: 0.01, y: 0.01, height: 0.15 }
    const expected = tileBoardRect(corner, landscape, {
      width: 607,
      height: 247
    })!
    expect(board.h).closeTo(expected.h, 0.01)
    expect(board.h).closeTo(0.15 * corner.h, 0.01)
    expect(tileBoxes()[0].y).closeTo(corner.y, 0.01)
    // No angle's name, over the board or anywhere, nor its sound marker.
    expect(namesShown()).equals(false)
    expect(document.body.textContent).not.includes('🔊')
  })

  it('has no band and no board without a game, or for a game with no steps', async function () {
    for (const options of [
      { gameId: undefined, steps: STEPS },
      { gameId: 'g1', steps: [] }
    ]) {
      await grid({ Grid: PhoneGrid, width: 402, height: 874, ...options })
      expect(overlays()).length(0)
      const [first] = tileRects({ width: 402, height: 874, count: 4 })
      expect(tileBoxes()[0].y).closeTo(first.y, 0.01)
      await unmount()
    }
  })

  for (const [width, height] of [
    [402, 874],
    [874, 402]
  ] as const)
    it(`keeps its notice on the angles, below the band, at ${width}×${height}`, async function () {
      // The test DOM's players neither play nor pause.
      const media = window.HTMLMediaElement.prototype
      const held = (['play', 'pause'] as const).map(
        name => [name, Object.getOwnPropertyDescriptor(media, name)!] as const
      )
      Object.defineProperty(media, 'play', {
        configurable: true,
        value: async () => undefined
      })
      Object.defineProperty(media, 'pause', {
        configurable: true,
        value: () => undefined
      })
      try {
        await grid({ Grid: PhoneGrid, width, height, playable: true })
        // Every angle has a picture up and nothing ahead of it, so the grid
        // waits for them to catch up, and says so.
        await act(async () => {
          for (const video of document.querySelectorAll('video')) {
            for (const [name, value] of [
              ['readyState', 4],
              ['buffered', { length: 0, start: () => 0, end: () => 0 }]
            ] as const)
              Object.defineProperty(video, name, { configurable: true, value })
            video.dispatchEvent(new window.Event('loadedmetadata'))
            video.dispatchEvent(new window.Event('loadeddata'))
          }
        })
        await settle(1500)
        await layOutBoards(607, 247)
        // The outermost element holding just the words: the notice's box.
        const notice = [...document.querySelectorAll('div')].find(
          node => node.textContent === lstrings.angles_waiting
        )
        if (notice == null) throw new Error('No notice of waiting')
        const { board } = placed()
        if (width > height) {
          // Sideways the band is over the angles, and the notice at their top.
          expect(px(notice.style.top)).lessThan(board.y + board.h)
        } else {
          expect(px(notice.style.top)).greaterThan(board.y + board.h)
        }
      } finally {
        for (const [name, descriptor] of held)
          Object.defineProperty(media, name, descriptor)
      }
    })
})

describe('the phone’s grid and the browser’s place the board alike (U39)', function () {
  afterEach(unmount)

  for (const [width, height] of [
    [402, 874],
    [874, 402],
    [1280, 720]
  ]) {
    it(`at ${width}×${height}`, async function () {
      await grid({ Grid: BrowserGrid, width, height })
      const browser = { ...placed(), tiles: tileBoxes() }
      await unmount()
      await grid({ Grid: PhoneGrid, width, height })
      const phone = { ...placed(), tiles: tileBoxes() }
      expect(phone.at).equals(browser.at)
      for (const key of ['x', 'y', 'w', 'h'] as const) {
        expect(phone.board[key]).closeTo(browser.board[key], 0.01)
      }
      if (width > height) {
        for (const key of ['x', 'y', 'w', 'h'] as const)
          expect(phone.clip[key]).closeTo(browser.clip[key], 0.01)
      }
      phone.tiles.forEach((tile, index) => {
        for (const key of ['x', 'y', 'w', 'h'] as const)
          expect(tile[key]).closeTo(browser.tiles[index][key], 0.01)
      })
    })
  }
})

describe('leaving either grid says where it had got to (U12)', function () {
  afterEach(unmount)

  for (const [name, Grid] of [
    ['browser', BrowserGrid],
    ['phone', PhoneGrid]
  ] as const) {
    it(`in the ${name}'s`, async function () {
      const server = overlayServer()
      const client = new TeamStationClient({
        baseUrl: '/api/v1',
        fetch: server.fetch
      })
      client.playback = async () => await new Promise(() => undefined)
      const closed: Array<number | null> = []
      const at = OVERLAY_T0 + 65_000
      const host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <Grid
              client={client}
              gameId="g1"
              videos={IDS.map(angle)}
              order={['a']}
              audioId="a"
              zoomedId={null}
              atMs={at}
              onChange={() => undefined}
              onClose={atWallMs => {
                closed.push(atWallMs)
              }}
            />
          </ThemeProvider>
        )
      })
      await settle()
      const exit = document.querySelector<HTMLElement>(
        `[aria-label="${lstrings.angles_close}"]`
      )!
      await act(async () => {
        exit.click()
      })
      // The phone's sheet slides away first, then says.
      if (name === 'phone') await settle(400)
      expect(closed).deep.equals([at])
      // The phone's Back button, which its full-screen sheet is told of: on a
      // sheet of its own, as one closed by the ✕ is gone.
      if (name === 'phone') {
        await unmount()
        const again = document.createElement('div')
        document.body.appendChild(again)
        root = createRoot(again)
        await act(async () => {
          root!.render(
            <ThemeProvider>
              <Grid
                client={client}
                gameId="g1"
                videos={IDS.map(angle)}
                order={['a']}
                audioId="a"
                zoomedId={null}
                atMs={at}
                onChange={() => undefined}
                onClose={atWallMs => {
                  closed.push(atWallMs)
                }}
              />
            </ThemeProvider>
          )
        })
        await settle()
        // The sheet hears it once its slide-in has ended, which the test DOM
        // does not run: the end is sent to the sheet's own element.
        let sheet: Element = document.querySelector(
          `[aria-label="${lstrings.angles_close}"]`
        )!
        while (sheet.parentElement?.parentElement !== document.body)
          sheet = sheet.parentElement!
        await act(async () => {
          // Under its WebKit name where the DOM has no AnimationEvent.
          for (const type of ['animationend', 'webkitAnimationEnd'])
            sheet.dispatchEvent(new window.Event(type, { bubbles: true }))
        })
        await act(async () => {
          document.dispatchEvent(
            new window.KeyboardEvent('keyup', { key: 'Escape' })
          )
        })
        await settle(400)
        expect(closed).deep.equals([at, at])
      }
    })
  }
})

describe("the phone's full screen is a sheet that a downward swipe closes (U9)", function () {
  afterEach(unmount)

  async function sheet(endAtMs?: number): Promise<{
    closed: Array<number | null>
    playing: boolean[]
    layer: Element
    drag: (from: [number, number], to: [number, number]) => Promise<void>
    mouse: (
      type: string,
      x: number,
      y: number,
      buttons: number
    ) => Promise<void>
  }> {
    await windowSize(402, 874)
    const server = overlayServer()
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: server.fetch
    })
    client.playback = async () => await new Promise(() => undefined)
    const closed: Array<number | null> = []
    const playing: boolean[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <PhoneGrid
            client={client}
            gameId="g1"
            videos={IDS.map(angle)}
            order={['a', 'b']}
            audioId="a"
            zoomedId={null}
            atMs={OVERLAY_T0 + 120_000}
            endAtMs={endAtMs}
            onChange={() => undefined}
            onClose={(atWallMs, wasPlaying) => {
              closed.push(atWallMs)
              playing.push(wasPlaying)
            }}
          />
        </ThemeProvider>
      )
    })
    await settle()
    const layer = document.querySelector('[data-testid="grid-touches"]')!
    const mouse = async (
      type: string,
      x: number,
      y: number,
      buttons: number
    ): Promise<void> => {
      await act(async () => {
        layer.dispatchEvent(
          new window.MouseEvent(type, {
            bubbles: true,
            clientX: x,
            clientY: y,
            button: 0,
            buttons
          })
        )
      })
    }
    const drag = async (
      from: [number, number],
      to: [number, number]
    ): Promise<void> => {
      await mouse('mousedown', from[0], from[1], 1)
      const steps = 6
      for (let step = 1; step <= steps; step++) {
        await mouse(
          'mousemove',
          from[0] + ((to[0] - from[0]) * step) / steps,
          from[1] + ((to[1] - from[1]) * step) / steps,
          1
        )
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 40))
        })
      }
      await mouse('mouseup', to[0], to[1], 0)
    }
    return { closed, playing, layer, drag, mouse }
  }

  it('has a grabber in the top inset that is not one of the controls', async function () {
    await sheet()
    const grabber = document.querySelector<HTMLElement>(
      '[data-testid="sheet-grabber"]'
    )!
    expect(grabber.getAttribute('aria-label')).equals(
      lstrings.angles_swipe_to_close
    )
    // At the very top, centred: with no inset here, over the pictures' top
    // edge; under a status bar or a notch, in the band above them.
    expect(px(grabber.style.top)).at.most(6)
    expect(px(grabber.style.left)).equals(402 / 2 - 18)
    // The sheet's own, outside the layer the video controls are drawn in.
    const exit = document.querySelector(
      `[aria-label="${lstrings.angles_close}"]`
    )!
    expect(grabber.contains(exit)).equals(false)
    expect(grabber.parentElement!.contains(exit)).equals(true)
  })

  it('closes on a pull a quarter of the screen down, from the pictures', async function () {
    this.timeout(8000)
    const { closed, drag } = await sheet()
    await drag([200, 300], [205, 600])
    await settle(400)
    expect(closed).length(1)
  })

  it("slides away at a highlight's end, saying it stopped there", async function () {
    this.timeout(8000)
    // An end the grid has already reached.
    const { closed, playing } = await sheet(OVERLAY_T0 + 119_000)
    await settle(600)
    expect(closed).length(1)
    expect(playing).deep.equals([false])
  })

  it('springs back on a short slow pull, and stays up', async function () {
    this.timeout(8000)
    const { closed, drag } = await sheet()
    await drag([200, 300], [200, 360])
    await settle(400)
    expect(closed).deep.equals([])
  })

  it('keeps a scrub already under way from being taken for a swipe', async function () {
    this.timeout(8000)
    const { closed, mouse } = await sheet()
    const boxes = tileBoxes()
    const bottom = Math.max(...boxes.map(box => box.y + box.h))
    const top = Math.min(...boxes.map(box => box.y))
    const row = bottom - (bottom - top) * 0.1
    // Sideways first, on the bottom row: a scrub, which keeps its finger
    // when it then goes down.
    await mouse('mousedown', 100, row, 1)
    for (const x of [130, 160, 200]) await mouse('mousemove', x, row, 1)
    for (const y of [row + 100, row + 300]) await mouse('mousemove', 200, y, 1)
    await mouse('mouseup', 200, row + 300, 0)
    await settle(400)
    expect(closed).deep.equals([])
  })
})

describe('a press on either grid: a tap, a scrub, a hold that picks a tile up (U14)', function () {
  afterEach(unmount)

  /** Where the bar says the take is, in seconds. */
  const playhead = (): number =>
    Number(
      document
        .querySelector('[aria-label="Position in the game"]')!
        .getAttribute('aria-valuenow')
    )
  const wait = async (ms: number): Promise<void> => {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, ms))
    })
  }

  /** The browser's pointers on one element, or the phone's touches. */
  type Press = (
    target: Element,
    type: 'down' | 'move' | 'up',
    x: number,
    y: number
  ) => Promise<void>
  const pointer: Press = async (target, type, x, y) => {
    const event = new window.MouseEvent(`pointer${type}`, {
      bubbles: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === 'up' ? 0 : 1
    })
    Object.defineProperty(event, 'pointerId', { value: 7 })
    Object.defineProperty(event, 'pointerType', { value: 'touch' })
    await act(async () => {
      target.dispatchEvent(event)
    })
  }
  const touch: Press = async (target, type, x, y) => {
    await act(async () => {
      target.dispatchEvent(
        new window.MouseEvent(type === 'move' ? 'mousemove' : `mouse${type}`, {
          bubbles: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: type === 'up' ? 0 : 1
        })
      )
    })
  }

  for (const [name, Grid, press] of [
    ['browser', BrowserGrid, pointer],
    ['phone', PhoneGrid, touch]
  ] as const) {
    it(`in the ${name}'s`, async function () {
      this.timeout(10_000)
      const [width, height] = [402, 874]
      await windowSize(width, height)
      const server = overlayServer()
      const client = new TeamStationClient({
        baseUrl: '/api/v1',
        fetch: server.fetch
      })
      client.playback = async () => await new Promise(() => undefined)
      const orders: string[][] = []
      const host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <Grid
              client={client}
              gameId="g1"
              videos={IDS.map(angle)}
              order={['a', 'b']}
              audioId="a"
              zoomedId={null}
              atMs={OVERLAY_T0 + 120_000}
              onChange={next => {
                if (next.order != null) orders.push(next.order)
              }}
              onClose={() => undefined}
            />
          </ThemeProvider>
        )
      })
      await settle()
      const tileLayer = (index: number): Element =>
        name === 'browser'
          ? document.querySelectorAll('div[style*="cursor: grab"]')[index]
          : document.querySelector('[data-testid="grid-touches"]')!
      const margin =
        name === 'browser'
          ? document.querySelector('div[style*="z-index: 0"]')!
          : document.querySelector('[data-testid="grid-touches"]')!
      // Upright, the tiles stack: the first is the top one.
      const tiles = [...document.querySelectorAll('video')].map(video => {
        const style = video.parentElement!.style
        return {
          x: Number.parseFloat(style.left),
          y: Number.parseFloat(style.top),
          width: Number.parseFloat(style.width),
          height: Number.parseFloat(style.height)
        }
      })
      expect(playhead()).equals(120)

      // The press grid is on the block of videos: the stack, top to bottom.
      const top = Math.min(...tiles.map(tile => tile.y))
      const bottom = Math.max(...tiles.map(tile => tile.y + tile.height))
      const middle = (top + bottom) / 2
      // A tap on its middle right skips on.
      await press(margin, 'down', width * 0.9, middle)
      await press(margin, 'up', width * 0.9, middle)
      expect(playhead()).equals(130)

      // A sideways drag across the middle moves nothing.
      await press(margin, 'down', width * 0.5, middle)
      await press(margin, 'move', width * 0.75, middle)
      await wait(50)
      await press(margin, 'up', width * 0.75, middle)
      expect(playhead()).equals(130)

      // On the bottom row it scrubs, to where the finger is along the line —
      // the block's width until the bar has said where its track is.
      const row = bottom - (bottom - top) * 0.1
      await press(margin, 'down', width * 0.5, row)
      await press(margin, 'move', width * 0.75, row)
      await wait(50)
      await press(margin, 'up', width * 0.75, row)
      // Three quarters of a ten-minute take.
      expect(playhead()).closeTo(600 * 0.75, 1)

      // Held still on the first tile for half a second, it is picked up, and
      // dropped on the second it swaps with it.
      const first = tiles[0]
      const from = [first.x + first.width * 0.1, first.y + first.height * 0.5]
      const jump = tiles[1].y - first.y
      await press(tileLayer(0), 'down', from[0], from[1])
      await wait(600)
      await press(tileLayer(0), 'move', from[0], from[1] + jump)
      await press(tileLayer(0), 'up', from[0], from[1] + jump)
      expect(orders).deep.equals([['b', 'a']])
    })
  }
})
