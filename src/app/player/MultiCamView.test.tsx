import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asVideoSummary,
  type LineScoreStep,
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
import { type PaneFrame, PaneFrameContext } from '../components/useBreakpoint'
import { lstrings } from '../locales/strings'
import { ThemeProvider } from '../theme/ThemeContext'
import { tileRects } from './multiCam/layout'
import { GAP, playerLayout } from './multiCam/playerLayout'
import { MultiCamView } from './MultiCamView'
import { tileNameTop } from './scoreboardOverlay/overlayLayout'

let root: Root | undefined

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

async function grid(options: {
  width: number
  height: number
  gameId?: string
  steps?: Array<ReturnType<typeof boardStep>>
  /** Each angle's player is given an address, rather than waiting for one. */
  playable?: boolean
  /** The angles shown; all four by default. */
  ids?: string[]
  /** The game is before the overlay's start date. */
  early?: boolean
  /** An angle whose timeline arrives only once `until` settles. */
  hold?: { id: string; until: Promise<void> }
  /** An angle whose timeline cannot be fetched. */
  unplaced?: string
  /** An angle whose timeline holds no point to place it by. */
  pointless?: string
  /** Recorded angles whose length the server does not have yet. */
  unmeasured?: string[]
  /** The angle zoomed to the whole box. */
  zoomedId?: string
  /** The single-camera placement, when not the node's default. */
  single?: { x: number; y: number; height: number }
  /** The game's line score; none, as for a game with no events, by default. */
  lines?: LineScoreStep[]
  /** The angle heard; b by default. */
  audioId?: string
  /** Told the moment the grid had reached as it goes. */
  onGone?: (atWallMs: number | null) => void
  /** The moment the grid opens on. */
  atMs?: number
  /** The pane beside Tess's chat, which the grid covers instead of the window. */
  frame?: PaneFrame
}): Promise<ReturnType<typeof overlayServer>> {
  await windowSize(options.width, options.height)
  const server = overlayServer()
  // Each angle's own clock: b's frames are a minute and a half later than
  // its start says, which only its timeline knows.
  server.timelines.set('a', wallTimelineOf([[0, OVERLAY_T0]]))
  server.timelines.set('b', wallTimelineOf([[0, OVERLAY_T0 + 90_000]]))
  server.timelines.set('c', wallTimelineOf([[0, OVERLAY_T0]]))
  server.timelines.set('d', wallTimelineOf([[0, OVERLAY_T0]]))
  server.steps.set('g1', options.steps ?? [])
  if (options.lines != null) server.lines.set('g1', options.lines)
  if (options.pointless != null)
    server.timelines.set(options.pointless, wallTimelineOf([]))
  if (options.unplaced != null)
    server.fail.add(`/videos/${options.unplaced}/wall-timeline`)
  if (options.early === true)
    server.overlays.set('g1', { ...SHOWN_OVERLAY, show: false })
  if (options.single != null)
    server.overlays.set('g1', { ...SHOWN_OVERLAY, single: options.single })
  const ids = options.ids ?? IDS
  const client = new TeamStationClient({
    baseUrl: '/api/v1',
    fetch: server.fetch
  })
  const hold = options.hold
  if (hold != null) {
    const wallTimeline = client.wallTimeline.bind(client)
    client.wallTimeline = async (videoId, afterMs) => {
      if (videoId === hold.id) await hold.until
      return await wallTimeline(videoId, afterMs)
    }
  }
  // The pictures themselves never arrive: the grid's board is all this
  // looks at.
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
  const videos = ids.map(id =>
    options.unmeasured?.includes(id) === true
      ? { ...angle(id), durationSec: null }
      : angle(id)
  )
  const view = (order: string[]): React.ReactElement => (
    <ThemeProvider>
      <PaneFrameContext.Provider value={options.frame ?? null}>
        <MultiCamView
          client={client}
          gameId={options.gameId}
          videos={videos}
          order={order}
          audioId={options.audioId ?? 'b'}
          zoomedId={options.zoomedId ?? null}
          atMs={options.atMs}
          onChange={() => undefined}
          onClose={() => undefined}
          onGone={atWallMs => options.onGone?.(atWallMs)}
        />
      </PaneFrameContext.Provider>
    </ThemeProvider>
  )
  await act(async () => {
    root!.render(view(ids))
  })
  reorder = async order => {
    await act(async () => {
      root!.render(view(order))
    })
  }
  await settle(60)
  return server
}

/** Shows the last grid's tiles in another order. */
let reorder: (order: string[]) => Promise<void> = async () => undefined

const overlays = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(
    '[data-testid="scoreboard-overlay"]'
  )
]

/** The tiles, by the `<video>` each holds. */
const tiles = (): HTMLElement[] =>
  [...document.querySelectorAll('video')].map(video => video.parentElement!)

const px = (value: string): number => Number.parseFloat(value)

/** The box a tile's name sits in. */
function nameOf(tile: HTMLElement): HTMLElement {
  const text = [...tile.querySelectorAll<HTMLElement>('div')].find(
    node =>
      node.childElementCount === 0 &&
      (node.textContent ?? '').includes('Angle ')
  )
  if (text?.parentElement == null) throw new Error('A tile with no name')
  return text.parentElement
}

/** Sets the position each tile's player reports. */
function playAt(seconds: number): void {
  for (const video of document.querySelectorAll('video'))
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      value: seconds
    })
}

/** Sets every tile's player playing, or not. */
function playingIs(playing: boolean): void {
  for (const video of document.querySelectorAll('video'))
    Object.defineProperty(video, 'paused', {
      configurable: true,
      value: !playing
    })
}

/** The grid's own layer, put straight into the document's body. */
const layer = (): HTMLElement => {
  const found = [...document.body.children].find(
    node => node.querySelector('video') != null && node.tagName === 'DIV'
  )
  if (!(found instanceof HTMLElement)) throw new Error('No grid layer')
  return found
}

describe("the grid beside Tess's chat", function () {
  afterEach(unmount)

  it("covers the pane's frame, and lays its tiles out in it", async function () {
    await grid({
      width: 1280,
      height: 900,
      playable: true,
      frame: { x: 400, y: 0, width: 880, height: 900 }
    })
    const { left, top, width, height } = layer().style
    expect({ left, top, width, height }).deep.equals({
      left: '400px',
      top: '0px',
      width: '880px',
      height: '900px'
    })
    for (const tile of tiles())
      expect(px(tile.style.left) + px(tile.style.width)).lessThanOrEqual(880)
  })

  it('covers the window as before with no frame', async function () {
    await grid({ width: 1280, height: 900, playable: true })
    const { left, top, width, height } = layer().style
    expect({ left, top, width, height }).deep.equals({
      left: '',
      top: '',
      width: '',
      height: ''
    })
    expect(
      Math.max(
        ...tiles().map(tile => px(tile.style.left) + px(tile.style.width))
      )
    ).greaterThan(880)
  })
})

describe('the grid coming and going', function () {
  afterEach(unmount)

  it("says the picture's own moment as it goes, not the clock's", async function () {
    const gone: Array<number | null> = []
    await grid({
      width: 1280,
      height: 720,
      gameId: 'g1',
      playable: true,
      onGone: atWallMs => gone.push(atWallMs)
    })
    playAt(20)
    playingIs(true)
    await unmount()
    // The heard angle, b, 20 s in, by its own timeline.
    expect(gone).deep.equals([OVERLAY_T0 + 110_000])
  })

  it('opens a tile on the moment by its timeline, though its address came first', async function () {
    // Every position a player is sent to, by element.
    const sent = new Map<HTMLMediaElement, number[]>()
    const time = Object.getOwnPropertyDescriptor(
      window.HTMLMediaElement.prototype,
      'currentTime'
    )!
    Object.defineProperty(window.HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get(this: HTMLMediaElement) {
        return sent.get(this)?.at(-1) ?? 0
      },
      set(this: HTMLMediaElement, value: number) {
        sent.set(this, [...(sent.get(this) ?? []), value])
      }
    })
    try {
      let answer = (): void => undefined
      await grid({
        width: 1280,
        height: 720,
        gameId: 'g1',
        playable: true,
        ids: ['b'],
        audioId: 'b',
        atMs: OVERLAY_T0 + 120_000,
        hold: {
          id: 'b',
          until: new Promise(resolve => {
            answer = resolve
          })
        }
      })
      // The address is in; the timeline is not.
      expect(document.querySelectorAll('video')).length(1)
      await act(async () => {
        answer()
      })
      await settle(60)
      const [video] = document.querySelectorAll('video')
      await act(async () => {
        Object.defineProperty(video, 'readyState', {
          configurable: true,
          value: 1
        })
        video.dispatchEvent(new window.Event('loadedmetadata'))
      })
      // b's frames are a minute and a half later than its start says: two
      // minutes in on the wall is 30 s into it, not 120 s.
      expect(sent.get(video)?.at(-1)).closeTo(30, 0.01)
      expect(sent.get(video) ?? []).not.include(120)
    } finally {
      Object.defineProperty(
        window.HTMLMediaElement.prototype,
        'currentTime',
        time
      )
    }
  })
})

const STEPS = [
  boardStep(OVERLAY_T0 + 10_000, 1),
  boardStep(OVERLAY_T0 + 95_000, 2)
]

describe('the board over the grid (C3)', function () {
  afterEach(unmount)

  /** The layout the grid is drawn by, for a board 607 × 247 and no box. */
  const layoutOf = (
    width: number,
    height: number,
    count: number
  ): ReturnType<typeof playerLayout> =>
    playerLayout({
      screen: { width, height },
      safe: { x: 0, y: 0, w: width, h: height },
      count,
      aspect: 16 / 9,
      landscape: width > height,
      settings: SHOWN_OVERLAY,
      board: { width: 607, height: 247 },
      line: false
    })

  it('draws one board at the top above the stacked angles, upright', async function () {
    await grid({ width: 402, height: 874, gameId: 'g1', steps: STEPS })
    playAt(20)
    await settle()
    await layOutBoards(607, 247)
    const drawn = overlays()
    expect(drawn).length(1)
    // The heard angle's frame, 20 s in, is 110 s on the wall by its own
    // timeline: the second step, not the first its start would give.
    expect(drawn[0].getAttribute('data-at')).equals(String(OVERLAY_T0 + 95_000))

    // Four angles: the full board 15% of one angle's height, on the top of
    // the screen, the angles butted against it.
    const layout = layoutOf(402, 874, 4)
    const expected = layout.tiles
    // As tall as the stacked angles really are, which at this size is less
    // than the screen's width would give them.
    expect(px(drawn[0].style.height)).closeTo(0.15 * expected[0].h, 0.01)
    expect(expected[0].h).lessThan(402 / (16 / 9))
    expect(px(drawn[0].style.top)).closeTo(0, 0.01)
    expect(px(drawn[0].style.top) + px(drawn[0].style.height) + GAP).closeTo(
      expected[0].y,
      0.01
    )
    const placed = tiles()
    expect(placed).length(4)
    placed.forEach((tile, index) => {
      expect(px(tile.style.top)).closeTo(expected[index].y, 0.01)
      // Clear of the board in its band, every name stays at its tile's top.
      expect(nameOf(tile).style.top).equals('')
    })
  })

  it("draws one board over the top-left angle of four, sideways, where the node's setting puts it", async function () {
    await grid({ width: 1280, height: 720, gameId: 'g1', steps: STEPS })
    playAt(20)
    await settle()
    await layOutBoards(607, 247)
    const drawn = overlays()
    expect(drawn).length(1)
    const [corner] = tileRects({ width: 1280, height: 720, count: 4 })
    const clip = drawn[0].parentElement!
    expect(px(clip.style.left)).closeTo(corner.x, 0.01)
    expect(px(clip.style.top)).closeTo(corner.y, 0.01)
    expect(px(clip.style.width)).closeTo(corner.w, 0.01)
    // Clipped to the tile: React Native Web writes `overflow` as a class.
    expect(clip.className).match(/\br-overflow-/)
    expect(px(drawn[0].style.height)).closeTo(0.15 * corner.h, 0.01)
    expect(px(drawn[0].style.top)).closeTo(0.01 * corner.h, 0.01)
    expect(px(drawn[0].style.left)).closeTo(0.01 * corner.w, 0.01)
    // The tiles are where they always were.
    expect(px(tiles()[0].style.top)).closeTo(corner.y, 0.01)
    // The top-left angle's name, and its sound marker, are below the board;
    // every other angle's is where it always was.
    const name = nameOf(tiles()[0])
    expect(px(name.style.top)).closeTo(
      tileNameTop(corner, { x: 0.01, y: 0.01, height: 0.15 }),
      0.01
    )
    expect(px(name.style.top)).greaterThan(
      px(drawn[0].style.top) + px(drawn[0].style.height)
    )
    for (const tile of tiles().slice(1))
      expect(nameOf(tile).style.top).equals('')
  })

  it('puts its notice on the angles below the band, not over the board', async function () {
    // iOS Safari: a picture with sound plays only when a touch starts it, so
    // the heard angle plays silent and the grid says to tap for sound.
    const play = Object.getOwnPropertyDescriptor(
      window.HTMLMediaElement.prototype,
      'play'
    )!
    Object.defineProperty(window.HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: async function (this: HTMLMediaElement) {
        if (this.muted) return
        const refused = new Error('needs a gesture')
        refused.name = 'NotAllowedError'
        throw refused
      }
    })
    try {
      // Heard on a, which is recording from the take's start: b's own
      // timeline puts its first picture a minute and a half in.
      await grid({
        width: 402,
        height: 874,
        gameId: 'g1',
        steps: STEPS,
        playable: true,
        audioId: 'a'
      })
      playAt(20)
      await act(async () => {
        for (const video of document.querySelectorAll('video')) {
          // Loaded, and holding the whole recording, so the grid starts.
          Object.defineProperty(video, 'readyState', {
            configurable: true,
            value: 4
          })
          Object.defineProperty(video, 'buffered', {
            configurable: true,
            value: { length: 1, start: () => 0, end: () => 600 }
          })
          video.dispatchEvent(new window.Event('loadedmetadata'))
        }
      })
      await settle(1200)
      await layOutBoards(607, 247)
      // The outermost element holding just the words: the notice's box.
      const notice = [...document.querySelectorAll('div')].find(
        node => node.textContent === lstrings.angles_tap_for_sound
      )
      if (notice == null) throw new Error('No notice to tap for sound')
      expect(px(notice.style.top)).greaterThan(layoutOf(402, 874, 4).tiles[0].y)
      const [board] = overlays()
      expect(px(board.style.top) + px(board.style.height)).lessThan(
        px(notice.style.top)
      )
    } finally {
      Object.defineProperty(window.HTMLMediaElement.prototype, 'play', play)
    }
  })

  it('shows the board from the first frame, zeroed before the first event', async function () {
    // The game's first event is 200 s on the wall clock; every angle five
    // seconds in is well before it, the heard one (90 s late) included.
    await grid({
      width: 1280,
      height: 720,
      gameId: 'g1',
      steps: [boardStep(OVERLAY_T0 + 200_000, 1)]
    })
    playAt(5)
    await settle()
    await layOutBoards(607, 170)
    const [board] = overlays()
    expect(board).not.equals(undefined)
    expect(board.getAttribute('data-at')).equals(String(OVERLAY_T0))
    expect(
      document.querySelector('[data-scoreboard="inning"]')?.textContent
    ).equals('0')
    expect(
      document.querySelector('[data-scoreboard="count"]')?.textContent
    ).equals('0-0')
  })

  it('draws no board for angles with none of the game’s events in their time frame, by the server’s lengths', async function () {
    // Every angle is ten minutes long, the latest ending at 11.5 minutes on
    // the wall; the game's only event is at twenty. The players have not
    // loaded their lengths, and are not waited on.
    await grid({
      width: 1280,
      height: 720,
      gameId: 'g1',
      steps: [boardStep(OVERLAY_T0 + 20 * 60_000, 1)]
    })
    playAt(5)
    await settle()
    await layOutBoards(607, 247)
    expect(overlays()).length(0)
  })

  it('counts an angle still loading as no frame, never an open-ended one', async function () {
    // Every angle ends by 11.5 minutes on the wall, before the game's only
    // event at twenty; one angle's timeline is slow to arrive.
    let release = (): void => undefined
    const until = new Promise<void>(resolve => {
      release = resolve
    })
    await grid({
      width: 1280,
      height: 720,
      gameId: 'g1',
      steps: [boardStep(OVERLAY_T0 + 20 * 60_000, 1)],
      hold: { id: 'd', until }
    })
    playAt(5)
    await settle()
    await layOutBoards(607, 247)
    expect(overlays()).length(0)
    release()
    await settle(60)
    await layOutBoards(607, 247)
    expect(overlays()).length(0)
  })

  it('counts an angle whose timeline holds no point as no frame', async function () {
    // The placed angles all end before the game's only event; the fourth has
    // a timeline with nothing to place it by.
    await grid({
      width: 1280,
      height: 720,
      gameId: 'g1',
      steps: [boardStep(OVERLAY_T0 + 20 * 60_000, 1)],
      pointless: 'd'
    })
    playAt(5)
    await settle()
    await layOutBoards(607, 247)
    expect(overlays()).length(0)
  })

  it('counts a recorded angle with no length yet as no frame, never an open-ended one', async function () {
    await grid({
      width: 1280,
      height: 720,
      gameId: 'g1',
      steps: [boardStep(OVERLAY_T0 + 20 * 60_000, 1)],
      unmeasured: ['d']
    })
    playAt(5)
    await settle()
    await layOutBoards(607, 247)
    expect(overlays()).length(0)
  })

  it('draws no board while no angle has a length yet, never an open-ended frame', async function () {
    // Every angle starts before the game's only event, twenty minutes on.
    await grid({
      width: 1280,
      height: 720,
      gameId: 'g1',
      steps: [boardStep(OVERLAY_T0 + 20 * 60_000, 1)],
      unmeasured: IDS
    })
    playAt(5)
    await settle()
    await layOutBoards(607, 247)
    expect(overlays()).length(0)
  })

  it('asks for the overlay again for a new set of angles, not for moving a tile', async function () {
    const server = await grid({
      width: 1280,
      height: 720,
      gameId: 'g1',
      steps: STEPS
    })
    const asks = (): number =>
      server.asked.filter(one => one.path.endsWith('/scoreboard-overlay'))
        .length
    const first = asks()
    expect(first).greaterThan(0)
    await reorder(['d', 'c', 'b', 'a'])
    await settle(60)
    expect(asks()).equals(first)
    await reorder(['a', 'b', 'c'])
    await settle(60)
    expect(asks()).greaterThan(first)
  })

  it('leaves out an angle that cannot be placed, rather than waiting for it', async function () {
    await grid({
      width: 1280,
      height: 720,
      gameId: 'g1',
      steps: STEPS,
      unplaced: 'd'
    })
    playAt(20)
    await settle()
    await layOutBoards(607, 247)
    expect(overlays()).length(1)
  })

  it("draws the game's box score where the layout puts it, at the playhead, and none for a game with no events", async function () {
    const lines: LineScoreStep[] = [
      {
        at: OVERLAY_T0 + 50_000,
        line: {
          away: { innings: [2], r: 2, h: 3, e: 0 },
          home: { innings: [null], r: 0, h: 0, e: 0 }
        }
      }
    ]
    for (const [width, height] of [
      [402, 874],
      [1280, 720]
    ] as const) {
      await grid({
        width,
        height,
        gameId: 'g1',
        steps: STEPS,
        ids: ['a', 'b'],
        lines
      })
      playAt(20)
      await settle()
      await layOutBoards(607, 247)
      const box = document.querySelector<HTMLElement>(
        '[data-testid="line-score-box"]'
      )
      if (box == null) throw new Error('no box score')
      const expected = playerLayout({
        screen: { width, height },
        safe: { x: 0, y: 0, w: width, h: height },
        count: 2,
        aspect: 16 / 9,
        landscape: width > height,
        settings: SHOWN_OVERLAY,
        board: { width: 607, height: 247 },
        line: true
      }).box!
      expect(px(box.style.left)).closeTo(expected.x, 0.01)
      expect(px(box.style.top)).closeTo(expected.y, 0.01)
      expect(px(box.style.width)).closeTo(expected.w, 0.01)
      // The heard angle's frame is 110 s on the wall: past the line's step.
      expect(box.getAttribute('data-at')).equals(String(OVERLAY_T0 + 50_000))
      expect(box.textContent).includes('Visitors')
      await unmount()
    }
    await grid({ width: 402, height: 874, gameId: 'g1', steps: STEPS })
    playAt(20)
    await settle()
    await layOutBoards(607, 247)
    expect(document.querySelector('[data-testid="line-score-box"]')).equals(
      null
    )
  })

  it('centres the board above two angles on the bottom, sideways, with no box score', async function () {
    await grid({
      width: 1280,
      height: 720,
      gameId: 'g1',
      steps: STEPS,
      ids: ['a', 'b']
    })
    playAt(20)
    await settle()
    await layOutBoards(607, 247)
    const [board] = overlays()
    const rects = layoutOf(1280, 720, 2).tiles
    const top = rects[0].y
    // On the bottom of the screen, which leaves the space above them whole.
    expect(rects[0].y + rects[0].h).closeTo(720, 0.01)
    expect(px(board.style.height)).closeTo(top - 16, 0.01)
    expect(px(board.style.left) + px(board.style.width) / 2).closeTo(640, 0.01)
    expect(px(board.style.top) + px(board.style.height)).at.most(top)
    tiles().forEach((tile, index) => {
      expect(px(tile.style.top)).closeTo(rects[index].y, 0.01)
    })
  })

  it('gives the board the top of the top-left quadrant of three angles, against the angle on its right, sideways', async function () {
    await grid({
      width: 1280,
      height: 720,
      gameId: 'g1',
      steps: STEPS,
      ids: ['a', 'b', 'c']
    })
    playAt(20)
    await settle()
    await layOutBoards(607, 247)
    const [board] = overlays()
    const rects = tileRects({
      width: 1280,
      height: 720,
      count: 3,
      boardCell: true
    })
    // The angles take the top right, bottom left and bottom right.
    tiles().forEach((tile, index) => {
      expect(px(tile.style.left)).closeTo(rects[index].x, 0.01)
      expect(px(tile.style.top)).closeTo(rects[index].y, 0.01)
    })
    expect(px(board.style.top)).closeTo(rects[0].y + 8, 0.01)
    expect(px(board.style.left) + px(board.style.width)).closeTo(
      rects[1].x + rects[1].w - GAP,
      0.01
    )
    expect(px(board.style.width)).closeTo(rects[1].w - 8 - GAP, 0.01)
  })

  it('puts the board on a lone angle, sideways, where the single-camera setting puts it', async function () {
    await grid({
      width: 1280,
      height: 720,
      gameId: 'g1',
      steps: STEPS,
      ids: ['a'],
      // Apart from the landscape setting, so the test can tell them apart.
      single: { x: 0.1, y: 0.2, height: 0.3 }
    })
    playAt(20)
    await settle()
    await layOutBoards(607, 247)
    const [board] = overlays()
    const [picture] = tileRects({ width: 1280, height: 720, count: 1 })
    expect(px(board.style.left)).closeTo(picture.x + 0.1 * picture.w, 0.01)
    expect(px(board.style.top)).closeTo(picture.y + 0.2 * picture.h, 0.01)
    expect(px(board.style.height)).closeTo(0.3 * picture.h, 0.01)
    // Its name, and its sound marker, just below the board.
    expect(px(nameOf(tiles()[0]).style.top)).closeTo(
      tileNameTop(picture, { x: 0.1, y: 0.2, height: 0.3 }),
      0.01
    )
  })

  it('puts the board on a zoomed angle where the single-camera setting puts it, two or three across', async function () {
    for (const ids of [
      ['a', 'b'],
      ['a', 'b', 'c']
    ]) {
      await grid({
        width: 1280,
        height: 720,
        gameId: 'g1',
        steps: STEPS,
        ids,
        zoomedId: 'b',
        single: { x: 0.1, y: 0.2, height: 0.3 }
      })
      playAt(20)
      await settle()
      await layOutBoards(607, 247)
      const [board] = overlays()
      expect(board, ids.join()).not.equals(undefined)
      // The zoomed angle takes the whole box: a single picture.
      const picture = tileRects({
        width: 1280,
        height: 720,
        count: ids.length,
        boardCell: ids.length === 3,
        zoomed: 1
      })[1]
      expect(px(board.style.left), ids.join()).closeTo(
        picture.x + 0.1 * picture.w,
        0.01
      )
      expect(px(board.style.top), ids.join()).closeTo(
        picture.y + 0.2 * picture.h,
        0.01
      )
      expect(px(board.style.height), ids.join()).closeTo(0.3 * picture.h, 0.01)
      // The zoomed angle's name goes just below the board; the others'
      // stay where they always are, the top-left one's included.
      tiles().forEach((tile, index) => {
        if (index === 1)
          expect(px(nameOf(tile).style.top), ids.join()).closeTo(
            tileNameTop(picture, { x: 0.1, y: 0.2, height: 0.3 }),
            0.01
          )
        else expect(nameOf(tile).style.top, ids.join()).equals('')
      })
      await unmount()
    }
  })

  it('has no band and no board for a game before the start date', async function () {
    const server = await grid({
      width: 402,
      height: 874,
      gameId: 'g1',
      steps: STEPS,
      early: true
    })
    playAt(20)
    await settle()
    await layOutBoards(607, 247)
    expect(overlays()).length(0)
    const expected = tileRects({ width: 402, height: 874, count: 4 })
    tiles().forEach((tile, index) => {
      expect(px(tile.style.top)).closeTo(expected[index].y, 0.01)
    })
    expect(
      server.asked.some(one => one.path.includes('scoreboard-timeline'))
    ).equals(false)
  })

  it('has no band and no board without a game, or for a game with no steps', async function () {
    for (const options of [
      { gameId: undefined, steps: STEPS },
      { gameId: 'g1', steps: [] }
    ]) {
      await grid({ width: 402, height: 874, ...options })
      playAt(20)
      await settle()
      await layOutBoards(607, 247)
      expect(overlays()).length(0)
      const expected = tileRects({ width: 402, height: 874, count: 4 })
      expect(px(tiles()[0].style.top)).closeTo(expected[0].y, 0.01)
      await unmount()
    }
    // Sideways with no board, the top-left angle's name stays at the top.
    await grid({ width: 1280, height: 720, gameId: 'g1', steps: [] })
    expect(overlays()).length(0)
    expect(nameOf(tiles()[0]).style.top).equals('')
  })
})
