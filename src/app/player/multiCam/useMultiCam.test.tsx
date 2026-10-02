import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asVideoSummary,
  GameStationClient,
  type VideoSummary
} from '../../../common/api'
import { ThemeProvider } from '../../theme/ThemeContext'
import { SLOW_RATE } from '../slowMotion'
import type { VideoEventName } from '../videoHandle'
import { tileRects } from './layout'
import {
  type MultiCam,
  type MultiCamOptions,
  type MultiCamProps,
  type TileHandle,
  useMultiCam
} from './useMultiCam'

/** A tile that does what it is told and remembers it. */
class FakeTile implements TileHandle {
  currentTime = 0
  duration = 600
  paused = true
  muted = false
  playbackRate = 1
  readyState = 4
  videoWidth = 1920
  videoHeight = 1080
  ended = false
  async play(): Promise<void> {
    this.paused = false
  }

  pause(): void {
    this.paused = true
  }

  addEventListener(_type: VideoEventName, _listener: () => void): void {}
  removeEventListener(_type: VideoEventName, _listener: () => void): void {}
}

const T0 = Date.parse('2026-09-27T22:30:00Z')

function video(id: string, startOffsetSec: number): VideoSummary {
  return asVideoSummary({
    id,
    kind: 'game',
    title: id,
    status: 'ready',
    storage: 'spaces',
    startAt: new Date(T0 + startOffsetSec * 1000).toISOString(),
    durationSec: 600,
    width: 1920,
    height: 1080,
    codecs: null
  })
}

const WIDTH = 400
const HEIGHT = 800

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

/** The grid, mounted, with its two tiles handed over and placed. */
async function grid(
  patch: Partial<MultiCamProps> = {},
  options: Partial<MultiCamOptions> = {}
): Promise<{
  mc: () => MultiCam
  tiles: Record<string, FakeTile>
  changes: Array<{ order?: string[] }>
}> {
  const client = new GameStationClient({ baseUrl: '/api/v1' })
  client.playback = async (id: string) => ({
    videoId: id,
    storage: 'spaces',
    url: `https://media/${id}.m3u8`,
    expiresAt: null,
    durationSec: null,
    unavailable: false
  })
  const changes: Array<{ order?: string[] }> = []
  let latest: MultiCam | undefined
  const props: MultiCamProps = {
    client,
    // A starts at the take's beginning; B a minute later.
    videos: [video('A', 0), video('B', 60)],
    order: ['A', 'B'],
    audioId: 'A',
    zoomedId: null,
    atMs: T0 + 120_000,
    onChange: next => changes.push(next),
    onClose: () => undefined,
    ...patch
  }
  function Probe(): null {
    latest = useMultiCam(props, {
      width: WIDTH,
      height: HEIGHT,
      ...options
    })
    return null
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    )
  })
  const mc = (): MultiCam => {
    if (latest == null) throw new Error('not mounted')
    return latest
  }
  const tiles = { A: new FakeTile(), B: new FakeTile() }
  await act(async () => {
    for (const [id, tile] of Object.entries(tiles)) {
      mc().takeElement(id)(tile)
      mc().attached(id, tile, mc().attaching(id))
    }
  })
  return { mc, tiles, changes }
}

/** Four angles, A to D, all from the take's beginning. */
const four = {
  videos: [video('A', 0), video('B', 0), video('C', 0), video('D', 0)],
  order: ['A', 'B', 'C', 'D']
}

describe('useMultiCam moving tiles by hand', function () {
  it('upright, slides the others out of the way and inserts on the drop', async function () {
    const shuffles: number[] = []
    const { mc, changes } = await grid(four, {
      beforeShuffle: () => shuffles.push(1)
    })
    const rects = mc().rects
    expect(rects.map(rect => rect.x)).deep.equals(rects.map(() => rects[0].x))
    const down = rects[2].y - rects[0].y
    // Within its own row: nothing stands aside.
    await act(async () => {
      mc().moveTile(0, 0, 10)
    })
    expect(shuffles).length(0)
    expect(mc().shownRects).deep.equals(rects)
    // Over the third row: the second and third slide up a row each.
    await act(async () => {
      mc().moveTile(0, 0, down)
    })
    expect(shuffles).length(1)
    expect(mc().drag?.target).equals(2)
    expect(mc().shownRects).deep.equals([
      rects[0],
      rects[0],
      rects[1],
      rects[3]
    ])
    // A move that keeps the same target animates nothing new.
    await act(async () => {
      mc().moveTile(0, 0, down + 4)
    })
    expect(shuffles).length(1)
    await act(async () => {
      mc().dropTile(0, 0, down)
    })
    expect(changes).deep.equals([{ order: ['B', 'C', 'A', 'D'] }])
    expect(mc().shownRects).deep.equals(mc().rects)
  })

  it('sideways, swaps with the tile it is dropped on', async function () {
    const { mc, changes } = await grid(four, { width: 1600, height: 900 })
    const rects = mc().rects
    const dx = rects[3].x - rects[0].x
    const dy = rects[3].y - rects[0].y
    await act(async () => {
      mc().moveTile(0, dx, dy)
    })
    // Only the one underneath moves, into the gap.
    expect(mc().shownRects).deep.equals([
      rects[0],
      rects[1],
      rects[2],
      rects[0]
    ])
    await act(async () => {
      mc().dropTile(0, dx, dy)
    })
    expect(changes).deep.equals([{ order: ['D', 'B', 'C', 'A'] }])
  })

  it('keeps angles that are not on the grid after the ones that are', async function () {
    const { mc, changes } = await grid({
      ...four,
      order: ['A', 'gone', 'B', 'C', 'D']
    })
    const down = mc().rects[1].y - mc().rects[0].y
    await act(async () => {
      mc().dropTile(0, 0, down)
    })
    expect(changes).deep.equals([{ order: ['B', 'A', 'C', 'D', 'gone'] }])
  })

  it('drops nothing over its own slot', async function () {
    const { mc, changes } = await grid(four, { width: 1600, height: 900 })
    await act(async () => {
      mc().dropTile(1, 12, 12)
    })
    expect(changes).length(0)
  })
})

describe('useMultiCam', function () {
  it('opens every tile at its own place on the one clock, and plays them', async function () {
    const { tiles } = await grid()
    // Two minutes into the take: A two minutes in, B one.
    expect(tiles.A.currentTime).equals(120)
    expect(tiles.B.currentTime).equals(60)
    expect(tiles.A.paused).equals(false)
    expect(tiles.B.paused).equals(false)
  })

  it('pauses and plays every tile together', async function () {
    const { mc, tiles } = await grid()
    await act(async () => {
      mc().toggle()
    })
    expect(tiles.A.paused).equals(true)
    expect(tiles.B.paused).equals(true)
    await act(async () => {
      mc().toggle()
    })
    expect(tiles.A.paused).equals(false)
    expect(tiles.B.paused).equals(false)
  })

  it('moves every tile when the take is moved, and parks one that was not recording yet', async function () {
    const { mc, tiles } = await grid()
    await act(async () => {
      mc().goTo(T0 + 30_000)
    })
    expect(tiles.A.currentTime).equals(30)
    // B had not started thirty seconds in: held at its first frame, stopped.
    expect(tiles.B.paused).equals(true)
    expect(tiles.B.currentTime).equals(0)
    expect(mc().tiles.B?.parked).equals('beforeStart')
    await act(async () => {
      mc().skip(60)
    })
    expect(tiles.A.currentTime).equals(90)
    expect(tiles.B.currentTime).equals(30)
    expect(tiles.B.paused).equals(false)
    expect(mc().tiles.B?.parked).equals(null)
  })

  it('swaps two tiles when one is dropped on the other, and nothing for a tap', async function () {
    const { mc, changes } = await grid()
    const rects = tileRects({
      width: WIDTH,
      height: HEIGHT,
      count: 2,
      aspect: 16 / 9,
      zoomed: null
    })
    const [first, second] = rects
    const dx = second.x + second.w / 2 - (first.x + first.w / 2)
    const dy = second.y + second.h / 2 - (first.y + first.h / 2)
    await act(async () => {
      mc().moveTile(0, dx, dy)
    })
    expect(mc().drag).deep.equals({ index: 0, x: dx, y: dy, target: 1 })
    await act(async () => {
      mc().dropTile(0, dx, dy)
    })
    expect(changes).deep.equals([{ order: ['B', 'A'] }])
    expect(mc().drag).equals(null)
    await act(async () => {
      mc().dropTile(0, 2, 2)
    })
    expect(changes).length(1)
  })

  it('reads a quick tap on the middle right as ten seconds on', async function () {
    const { mc, tiles } = await grid()
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.9, HEIGHT * 0.5)
      mc().pressEnd(1, true, WIDTH * 0.9, HEIGHT * 0.5)
    })
    expect(tiles.A.currentTime).equals(130)
  })

  it('crawls every tile while the middle right is held, and lets go on the lift', async function () {
    this.timeout(5000)
    const { mc, tiles } = await grid()
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.9, HEIGHT * 0.5)
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    expect(mc().slow).equals(SLOW_RATE)
    expect(tiles.A.playbackRate).equals(SLOW_RATE)
    expect(tiles.B.playbackRate).equals(SLOW_RATE)
    expect(tiles.A.muted).equals(true)
    await act(async () => {
      expect(mc().pressEnd(1, true, WIDTH * 0.9, HEIGHT * 0.5)).equals(true)
    })
    expect(mc().slow).equals(0)
    expect(tiles.A.playbackRate).equals(1)
  })

  it('does not crawl on a hold anywhere else', async function () {
    this.timeout(5000)
    const { mc } = await grid()
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.1, HEIGHT * 0.5)
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    expect(mc().slow).equals(0)
    await act(async () => {
      mc().pressCancel(1)
    })
  })

  it('follows the clock of the tile that is showing, once a second', async function () {
    this.timeout(5000)
    const { mc, tiles } = await grid()
    // Both tiles play on by a second and a half: close enough to the clock
    // to be believed, which a tile two seconds off is not.
    tiles.A.currentTime = 121.5
    tiles.B.currentTime = 61.5
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1100))
    })
    expect(mc().atWallMs).equals(T0 + 121_500)
    expect(mc().waiting).equals(false)
    expect(mc().ended).equals(false)
  })

  it('says every angle has ended once they all have', async function () {
    this.timeout(8000)
    const { mc, tiles } = await grid()
    for (const tile of Object.values(tiles)) {
      tile.ended = true
      tile.paused = true
    }
    // A few looks: the first records each tile as ended, a later one reads
    // it, and the look starts afresh whenever a tile's state changes.
    for (let look = 0; look < 25 && !mc().ended; look++) {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 200))
      })
    }
    expect(mc().ended).equals(true)
  })

  it('draws a strip on the bar for each angle, where it was recording', async function () {
    const { mc } = await grid()
    const take = mc().take
    if (take == null) throw new Error('no take')
    expect(mc().barAngles(take)).deep.equals([
      { id: 'A', name: 'A', fromMs: T0, toMs: T0 + 600_000 },
      { id: 'B', name: 'B', fromMs: T0 + 60_000, toMs: T0 + 660_000 }
    ])
    expect(mc().tileWaiting('A')).equals(false)
  })

  it('asks again for an address its player has given up on', async function () {
    const { mc } = await grid()
    expect(mc().urls.A).equals('https://media/A.m3u8')
    await act(async () => {
      mc().askAgain('A')
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    // Fetched again, and the same address is back.
    expect(mc().urls.A).equals('https://media/A.m3u8')
  })

  it('shows the bar on a tap in the bottom third, and hides it three seconds on', async function () {
    this.timeout(6000)
    const { mc } = await grid()
    await act(async () => {
      mc().runZone('controls')
    })
    expect(mc().barShown).equals(true)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 3200))
    })
    expect(mc().barShown).equals(false)
  })

  it('shows the way out with any control: the bar, or the flash of a tap', async function () {
    this.timeout(8000)
    const { mc } = await grid()
    expect(mc().controlsShown).equals(true)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 3200))
    })
    expect(mc().controlsShown).equals(false)
    // +10 s flashes its arrow without calling the bar up, and the way out
    // comes with the flash.
    await act(async () => {
      mc().runZone('seekForward')
    })
    expect(mc().barShown).equals(false)
    expect(mc().controlsShown).equals(true)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1200))
    })
    expect(mc().controlsShown).equals(false)
  })

  it('reads a slip of the finger as a drag, which is never a tap', async function () {
    const { mc, tiles } = await grid()
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.9, HEIGHT * 0.5)
      mc().pressMoved(1)
      mc().pressEnd(1, true, WIDTH * 0.9, HEIGHT * 0.5)
    })
    expect(tiles.A.currentTime).equals(120)
    // A second finger is ignored while the first holds a crawl, and a
    // cancelled press does nothing.
    expect(mc().mayReorder(1)).equals(false)
    await act(async () => {
      mc().pressStart(2, WIDTH * 0.5, HEIGHT * 0.5)
      mc().pressCancel(2)
    })
    expect(tiles.A.currentTime).equals(120)
  })
})
