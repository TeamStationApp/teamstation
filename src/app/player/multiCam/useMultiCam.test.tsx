import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asVideoSummary,
  TeamStationClient,
  type VideoSummary
} from '../../../common/api'
import { ThemeProvider } from '../../theme/ThemeContext'
import { SLOW_RATE } from '../slowMotion'
import type { VideoEventName } from '../videoHandle'
import type { AngleVideo } from '../wallClock'
import {
  fromFragments,
  MAPPING_WAIT_MS,
  type WallMapping
} from '../wallMapping'
import { JOIN_LEAD_SEC } from './align'
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
  /** Left unset, the tile does not say how much it holds, as on a phone. */
  buffered?: TileHandle['buffered']
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

/** Says the tile holds these stretches of its recording, in seconds. */
function fill(tile: FakeTile, ...ranges: Array<[number, number]>): void {
  tile.buffered = {
    length: ranges.length,
    start: index => ranges[index][0],
    end: index => ranges[index][1]
  }
}

/** Lets the watchdog look this many times. */
async function ticks(count: number): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, count * 1000 + 100))
  })
}

/** The grid, mounted, with its two tiles handed over and placed. */
async function grid(
  patch: Partial<MultiCamProps> = {},
  options: Partial<MultiCamOptions> = {},
  /** Done to the tiles before they are handed over. */
  before: (tiles: Record<string, FakeTile>) => void = () => undefined
): Promise<{
  mc: () => MultiCam
  tiles: Record<string, FakeTile>
  changes: Array<{ order?: string[] }>
  /** Renders the grid again with these props changed. */
  rerender: (next: Partial<MultiCamProps>) => Promise<void>
}> {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
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
  let props: MultiCamProps = {
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
  before(tiles)
  await act(async () => {
    for (const [id, tile] of Object.entries(tiles)) {
      mc().takeElement(id)(tile)
      mc().attached(id, tile, mc().attaching(id))
    }
  })
  const rerender = async (next: Partial<MultiCamProps>): Promise<void> => {
    props = { ...props, ...next }
    await act(async () => {
      root?.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>
      )
    })
  }
  return { mc, tiles, changes, rerender }
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
      mc().pressStart(1, WIDTH * 0.9, HEIGHT * 0.5, 0)
      mc().pressEnd(1, WIDTH * 0.9, HEIGHT * 0.5)
    })
    expect(tiles.A.currentTime).equals(130)
  })

  it('stops the clock where the pictures stop when paused', async function () {
    const { mc, tiles } = await grid()
    tiles.A.currentTime = 120.8
    tiles.B.currentTime = 60.8
    await act(async () => {
      mc().toggle()
    })
    expect(mc().playing).equals(false)
    expect(mc().atWallMs).closeTo(T0 + 120_800, 1e-3)
    // And a skip from there is ten seconds from the picture.
    await act(async () => {
      mc().skip(-10)
    })
    expect(tiles.A.currentTime).closeTo(110.8, 1e-6)
  })

  it('holds the heard tile’s sound for a tap when its player was left playing silent, and no other’s', async function () {
    const { mc } = await grid()
    expect(mc().heardId).equals('A')
    await act(async () => {
      mc().soundHeld('B')
    })
    expect(mc().soundBlocked).equals(false)
    await act(async () => {
      mc().soundHeld('A')
    })
    expect(mc().soundBlocked).equals(true)
  })

  it('holds the sound of the angle heard now, for a prime begun while another was', async function () {
    // B is heard, and its tile's prime takes this render's callback.
    const { mc, rerender } = await grid({ audioId: 'B' })
    expect(mc().heardId).equals('B')
    const { soundHeld } = mc()
    // The viewer moves the sound to A before the prime is done.
    await rerender({ audioId: 'A' })
    expect(mc().heardId).equals('A')
    await act(async () => {
      soundHeld('A')
    })
    expect(mc().soundBlocked).equals(true)
  })

  it('says where the pictures are now, for a close, not the clock’s last reading', async function () {
    const { mc, tiles } = await grid()
    expect(mc().wallNow()).equals(T0 + 120_000)
    tiles.A.currentTime = 120.8
    expect(mc().wallNow()).closeTo(T0 + 120_800, 1e-3)
    // Nothing playing: the clock.
    await act(async () => {
      tiles.A.pause()
      tiles.B.pause()
    })
    expect(mc().wallNow()).equals(mc().atWallMs)
  })

  it('skips ten seconds from where the pictures are, not from the clock’s last reading', async function () {
    const { mc, tiles } = await grid()
    expect(tiles.A.paused).equals(false)
    // Played on 0.8 s past the clock's last reading.
    tiles.A.currentTime = 120.8
    tiles.B.currentTime = 60.8
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.9, HEIGHT * 0.5, 0)
      mc().pressEnd(1, WIDTH * 0.9, HEIGHT * 0.5)
    })
    expect(tiles.A.currentTime).closeTo(130.8, 1e-6)
    expect(tiles.B.currentTime).closeTo(70.8, 1e-6)
  })

  it('crawls every tile while the middle right is held, and lets go on the lift', async function () {
    this.timeout(5000)
    const { mc, tiles } = await grid()
    // The pictures have played on past the clock's last reading.
    expect(mc().atWallMs).equals(T0 + 120_000)
    expect(tiles.A.paused).equals(false)
    tiles.A.currentTime = 120.8
    tiles.B.currentTime = 60.8
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.9, HEIGHT * 0.5, 0)
    })
    // Not yet at a quarter of a second: the hold is half of one.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    expect(mc().slow).equals(0)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    expect(mc().slow).equals(SLOW_RATE)
    expect(tiles.A.playbackRate).equals(SLOW_RATE)
    expect(tiles.B.playbackRate).equals(SLOW_RATE)
    expect(tiles.A.muted).equals(true)
    // It crawls on from there, not from the clock's reading: no tile is put
    // back.
    expect(mc().atWallMs).greaterThanOrEqual(T0 + 120_800)
    expect(tiles.A.currentTime).equals(120.8)
    expect(tiles.B.currentTime).equals(60.8)
    await act(async () => {
      expect(mc().pressEnd(1, WIDTH * 0.9, HEIGHT * 0.5)).equals('held')
    })
    expect(mc().slow).equals(0)
    expect(tiles.A.playbackRate).equals(1)
  })

  it('picks a tile up on a hold anywhere else, at half a second and not before (U14)', async function () {
    this.timeout(5000)
    const { mc } = await grid()
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.1, HEIGHT * 0.5, 1)
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    expect(mc().armedTile).equals(null)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    expect(mc().slow).equals(0)
    expect(mc().armedTile).equals(1)
    await act(async () => {
      expect(mc().pressEnd(1, WIDTH * 0.1, HEIGHT * 0.5)).equals('reorder')
    })
    expect(mc().armedTile).equals(null)
  })

  it('picks nothing up with one angle, nor on the black around the tiles, and still reads the lift as a tap', async function () {
    this.timeout(5000)
    const { mc, tiles } = await grid({ videos: [video('A', 0)], order: ['A'] })
    for (const tile of [0, null]) {
      await act(async () => {
        mc().pressStart(1, WIDTH * 0.1, HEIGHT * 0.5, tile)
      })
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 600))
      })
      expect(mc().armedTile).equals(null)
      // Rested and let go where it came down, it is a tap: ten seconds back.
      await act(async () => {
        expect(mc().pressEnd(1, WIDTH * 0.1, HEIGHT * 0.5)).equals('pending')
      })
    }
    expect(tiles.A.currentTime).equals(100)
  })

  it('pauses a one-angle grid for a press that rests on its centre before it lifts', async function () {
    this.timeout(5000)
    const { mc } = await grid({ videos: [video('A', 0)], order: ['A'] })
    expect(mc().playing).equals(true)
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.5, HEIGHT * 0.5, 0)
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 600))
    })
    await act(async () => {
      mc().pressEnd(1, WIDTH * 0.5, HEIGHT * 0.5)
    })
    expect(mc().playing).equals(false)
  })

  it('scrubs no more once a press has rested past the hold', async function () {
    this.timeout(5000)
    const { mc, tiles } = await grid({ videos: [video('A', 0)], order: ['A'] })
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.3, HEIGHT * 0.3, 0)
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 600))
    })
    await act(async () => {
      mc().pressMove(1, WIDTH * 0.7, HEIGHT * 0.3)
      // A frame, for a scrub's move to land if it were one.
      await new Promise(resolve => setTimeout(resolve, 50))
    })
    await act(async () => {
      expect(mc().pressEnd(1, WIDTH * 0.7, HEIGHT * 0.3)).equals('dead')
    })
    expect(tiles.A.currentTime).equals(120)
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

  it('reads a slip of the finger as no tap, and a cancelled press as nothing', async function () {
    const { mc, tiles } = await grid()
    // Past the tap's slop, short of a drag.
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.9, HEIGHT * 0.5, 0)
      mc().pressMove(1, WIDTH * 0.9 - 12, HEIGHT * 0.5)
      expect(mc().pressEnd(1, WIDTH * 0.9 - 12, HEIGHT * 0.5)).equals('pending')
    })
    expect(tiles.A.currentTime).equals(120)
    await act(async () => {
      mc().pressStart(2, WIDTH * 0.5, HEIGHT * 0.5, 0)
      mc().pressCancel(2)
    })
    expect(tiles.A.currentTime).equals(120)
    // Neither answers for a finger it is not following.
    expect(mc().pressEnd(3, 0, 0)).equals(null)
  })

  it('ignores a second finger while the first holds a crawl', async function () {
    this.timeout(5000)
    const { mc, tiles } = await grid()
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.9, HEIGHT * 0.5, 0)
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 600))
    })
    expect(mc().pressStart(2, WIDTH * 0.5, HEIGHT * 0.5, 0)).equals(false)
    await act(async () => {
      expect(mc().pressEnd(1, WIDTH * 0.9, HEIGHT * 0.5)).equals('held')
    })
    expect(mc().slow).equals(0)
    // A press only waiting is handed to the newer finger.
    await act(async () => {
      mc().pressStart(3, WIDTH * 0.5, HEIGHT * 0.5, 0)
      expect(mc().pressStart(4, WIDTH * 0.9, HEIGHT * 0.5, 0)).equals(true)
      mc().pressEnd(4, WIDTH * 0.9, HEIGHT * 0.5)
    })
    expect(tiles.A.currentTime).closeTo(130, 1)
  })
})

describe('useMultiCam scrubbing by a drag across the pictures (U14)', function () {
  /** Lets an animation frame or two go by. */
  const frame = async (): Promise<void> => {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })
  }

  it('moves every tile by a quarter of the track for a sideways drag from the middle', async function () {
    const { mc, tiles } = await grid()
    // The take is A's start to B's end: eleven minutes.
    const span = 660_000
    mc().setTrackWidth(300)
    const start = mc().atWallMs!
    const dx = WIDTH * 0.25
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.5, HEIGHT * 0.3, 0)
      mc().pressMove(1, WIDTH * 0.5 + dx / 2, HEIGHT * 0.3 + 4)
      mc().pressMove(1, WIDTH * 0.5 + dx, HEIGHT * 0.3 + 4)
    })
    await frame()
    const expected = start + ((dx * span) / 300) * 0.25
    expect(mc().atWallMs).closeTo(expected, 1)
    expect(mc().barShown).equals(true)
    expect(tiles.A.currentTime).closeTo((expected - T0) / 1000, 0.01)
    expect(tiles.B.currentTime).closeTo((expected - T0) / 1000 - 60, 0.01)
    await act(async () => {
      expect(mc().pressEnd(1, WIDTH * 0.5 + dx, HEIGHT * 0.3)).equals('scrub')
    })
    // And back the other way, kept inside the take.
    await act(async () => {
      mc().pressStart(2, WIDTH * 0.8, HEIGHT * 0.3, 0)
      mc().pressMove(2, 0, HEIGHT * 0.3)
      mc().pressEnd(2, 0, HEIGHT * 0.3)
    })
    expect(mc().atWallMs).equals(T0)
  })

  it('scrubs from where the pictures are, not from the clock’s last reading', async function () {
    const { mc, tiles } = await grid()
    mc().setTrackWidth(300)
    // The pictures have played on 0.8 s past the clock's last reading.
    tiles.A.currentTime = 120.8
    tiles.B.currentTime = 60.8
    const dx = WIDTH * 0.25
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.5, HEIGHT * 0.3, 0)
      mc().pressMove(1, WIDTH * 0.5 + dx, HEIGHT * 0.3)
    })
    await frame()
    const expected = T0 + 120_800 + ((dx * 660_000) / 300) * 0.25
    expect(mc().atWallMs).closeTo(expected, 1)
    expect(tiles.A.currentTime).closeTo((expected - T0) / 1000, 0.01)
    await act(async () => {
      mc().pressEnd(1, WIDTH * 0.5 + dx, HEIGHT * 0.3)
    })
  })

  it('measures against the window until the bar has said how wide its track is', async function () {
    const { mc } = await grid()
    const start = mc().atWallMs!
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.5, HEIGHT * 0.3, null)
      mc().pressMove(1, WIDTH * 0.75, HEIGHT * 0.3)
      mc().pressEnd(1, WIDTH * 0.75, HEIGHT * 0.3)
    })
    expect(mc().atWallMs).closeTo(start + 0.25 * 660_000 * 0.25, 1)
  })

  for (const playing of [false, true])
    it(`leaves the tiles ${playing ? 'playing' : 'paused'}`, async function () {
      const { mc, tiles } = await grid()
      if (mc().playing !== playing)
        await act(async () => {
          mc().toggle()
        })
      const before = [mc().playing, tiles.A.paused, tiles.B.paused]
      await act(async () => {
        mc().pressStart(1, WIDTH * 0.5, HEIGHT * 0.3, 0)
        mc().pressMove(1, WIDTH * 0.7, HEIGHT * 0.3)
        mc().pressEnd(1, WIDTH * 0.7, HEIGHT * 0.3)
      })
      expect([mc().playing, tiles.A.paused, tiles.B.paused]).deep.equals(before)
    })

  it('does not scrub from the edges, nor for an up-and-down drag', async function () {
    const { mc, tiles } = await grid()
    for (const [x0, x1, y1] of [
      [WIDTH * 0.05, WIDTH * 0.4, HEIGHT * 0.3],
      [WIDTH * 0.95, WIDTH * 0.6, HEIGHT * 0.3],
      [WIDTH * 0.5, WIDTH * 0.52, HEIGHT * 0.5]
    ]) {
      await act(async () => {
        mc().pressStart(1, x0, HEIGHT * 0.3, 0)
        mc().pressMove(1, x1, y1)
      })
      await frame()
      await act(async () => {
        expect(mc().pressEnd(1, x1, y1)).equals('dead')
      })
    }
    expect(tiles.A.currentTime).equals(120)
  })

  it('never turns a crawl into a scrub', async function () {
    this.timeout(5000)
    const { mc } = await grid()
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.9, HEIGHT * 0.5, 0)
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 600))
    })
    const crawling = mc().atWallMs!
    await act(async () => {
      mc().pressMove(1, WIDTH * 0.5, HEIGHT * 0.5)
    })
    await frame()
    // A quarter-speed crawl moves the clock a little, never a drag's worth.
    expect(mc().atWallMs! - crawling).lessThan(1000)
    await act(async () => {
      expect(mc().pressEnd(1, WIDTH * 0.5, HEIGHT * 0.5)).equals('held')
    })
  })
})

/** A camera live now, which began `startOffsetSec` into the take. */
function liveVideo(id: string, startOffsetSec: number): VideoSummary {
  return { ...video(id, startOffsetSec), status: 'live', durationSec: null }
}

/** Lets the grid run until `done` holds, or `ms` have passed. */
async function until(done: () => boolean, ms = 3000): Promise<void> {
  for (const end = Date.now() + ms; !done() && Date.now() < end;) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 25))
    })
  }
}

/** Asks again at once, as often as needed: a grid test's live retry. */
const quickRetry = (): number => 10
/** Asks again twice, then gives up. */
const twoQuickRetries = (asks: number): number | undefined =>
  asks < 2 ? 10 : undefined

describe('useMultiCam on live angles', function () {
  // A began at the take's start and B a minute later. Each opens near its own
  // live edge: A 100 s in, B 30 s in, which is 90 s into the take.
  const live = {
    videos: [liveVideo('A', 0), liveVideo('B', 60)],
    atMs: undefined
  }
  /**
   * Each at its newest footage: A's ends three minutes into the take, B's
   * (a minute later to start) two and a half minutes into its own, which is
   * half a minute later on the wall. Each holds the stretch 45 s behind A's.
   */
  const atTheirEdges = (tiles: Record<string, FakeTile>): void => {
    tiles.A.duration = Number.POSITIVE_INFINITY
    tiles.B.duration = Number.POSITIVE_INFINITY
    tiles.A.currentTime = 180
    tiles.B.currentTime = 150
    Object.assign(tiles.A, { seekable: { length: 1, end: () => 180 } })
    Object.assign(tiles.B, { seekable: { length: 1, end: () => 150 } })
    fill(tiles.A, [130, 180])
    fill(tiles.B, [70, 150])
  }

  it('opens 45 s behind the newest footage of the slowest tile, and plays every tile (U25)', async function () {
    this.timeout(5000)
    const { mc, tiles } = await grid(live, {}, atTheirEdges)
    // No moment to open on until the tiles have said where they are.
    expect(mc().atWallMs).equals(null)
    expect(tiles.A.paused).equals(true)
    expect(tiles.B.paused).equals(true)

    await ticks(1)
    expect(mc().atWallMs).equals(T0 + 135_000)
    expect(tiles.A.currentTime).equals(135)
    expect(tiles.B.currentTime).equals(75)
    expect(tiles.A.paused).equals(false)
    expect(tiles.B.paused).equals(false)
    expect(mc().waiting).equals(false)
  })

  it('asks again for a live angle that has no address yet, until it has one', async function () {
    this.timeout(5000)
    // B's stream is publishing, but its first segment is not written yet: the
    // server has no address for it on the first two asks.
    const asked: string[] = []
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.playback = async (id: string) => {
      asked.push(id)
      const ready = id !== 'B' || asked.filter(one => one === 'B').length > 2
      return {
        videoId: id,
        storage: 'spaces',
        url: ready ? `https://media/${id}.m3u8` : null,
        expiresAt: null,
        durationSec: null,
        unavailable: false
      }
    }
    const { mc } = await grid(
      { ...live, client },
      { liveRetryDelay: quickRetry },
      atTheirEdges
    )
    expect(mc().urls.B).equals(null)
    await until(() => mc().urls.B != null)
    expect(mc().urls.B).equals('https://media/B.m3u8')
    expect(asked.filter(one => one === 'B').length).equals(3)
    // A had its address at once and was not asked for again.
    expect(asked.filter(one => one === 'A').length).equals(1)
  })

  it('stops asking for a live angle once the delay says to give up', async function () {
    this.timeout(5000)
    const asked: string[] = []
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.playback = async (id: string) => {
      asked.push(id)
      return {
        videoId: id,
        storage: 'spaces',
        url: id === 'B' ? null : `https://media/${id}.m3u8`,
        expiresAt: null,
        durationSec: null,
        unavailable: false
      }
    }
    const { mc } = await grid(
      { ...live, client },
      { liveRetryDelay: twoQuickRetries },
      atTheirEdges
    )
    await until(() => asked.filter(one => one === 'B').length >= 3)
    await until(() => false, 500)
    expect(mc().urls.B).equals(null)
    expect(asked.filter(one => one === 'B').length).equals(3)
  })

  it('never asks again for a recorded angle with no address', async function () {
    this.timeout(5000)
    const asked: string[] = []
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.playback = async (id: string) => {
      asked.push(id)
      return {
        videoId: id,
        storage: 'spaces',
        url: id === 'B' ? null : `https://media/${id}.m3u8`,
        expiresAt: null,
        durationSec: null,
        unavailable: true
      }
    }
    const { mc } = await grid({ client }, { liveRetryDelay: quickRetry })
    await until(() => false, 500)
    expect(mc().urls.B).equals(null)
    expect(asked.filter(one => one === 'B').length).equals(1)
  })

  it('asks once for each address, and waits once for a timeline that never comes', async function () {
    this.timeout(8000)
    const asked: string[] = []
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.playback = async (id: string) => {
      asked.push(id)
      return {
        videoId: id,
        storage: 'spaces',
        url: `https://media/${id}.m3u8`,
        expiresAt: null,
        durationSec: null,
        unavailable: false
      }
    }
    const opened = Date.now()
    // A's timeline is in; B's and C's are never fetched.
    const { mc } = await grid(
      {
        client,
        videos: [video('A', 0), video('B', 0), video('C', 0)],
        order: ['A', 'B', 'C']
      },
      { fallbackMapping: id => (id === 'A' ? null : undefined) }
    )
    await until(() => mc().urls.A != null, 1000)
    expect(mc().urls.B).equals(undefined)
    await until(() => mc().urls.B != null && mc().urls.C != null, 4000)
    // Both after the one wait, not one wait after the other.
    expect(Date.now() - opened).lessThan(MAPPING_WAIT_MS + 1000)
    expect(asked.sort()).deep.equals(['A', 'B', 'C'])
  })

  it('waits a moment for a tile with no picture yet, and then opens without it', async function () {
    this.timeout(8000)
    const { mc } = await grid(live, {}, tiles => {
      atTheirEdges(tiles)
      tiles.B.readyState = 1
    })
    await ticks(2)
    expect(mc().atWallMs).equals(null)
    await ticks(2)
    expect(mc().atWallMs).equals(T0 + 135_000)
  })
})

describe('useMultiCam buffering', function () {
  // A is two minutes in at 120 s; B, which started a minute later, at 60 s.

  it('holds every tile until each holds five seconds, then plays them together', async function () {
    this.timeout(5000)
    const { mc, tiles } = await grid({}, {}, tiles => {
      fill(tiles.A, [120, 123])
      fill(tiles.B, [60, 70])
    })
    expect(tiles.A.paused).equals(true)
    expect(tiles.B.paused).equals(true)
    await ticks(1)
    expect(mc().waiting).equals(true)
    expect(tiles.B.paused).equals(true)

    fill(tiles.A, [120, 126])
    await ticks(1)
    expect(mc().waiting).equals(false)
    expect(tiles.A.paused).equals(false)
    expect(tiles.B.paused).equals(false)
  })

  it('reads out, under debug, what the gate holds against each tile and who is heard', async function () {
    this.timeout(5000)
    const { mc, tiles } = await grid({}, { debug: true }, tiles => {
      fill(tiles.A, [120, 123])
      fill(tiles.B, [60, 70])
    })
    await ticks(1)
    const [a, b, clock] = mc().readout
    expect(a).match(
      /^A {8} buf 3\.0s {2}ready 4 {2}at 120\.0 {2}to 120\.0 {2}paused {2}ok {2}short \d+(\.\d)?s/
    )
    // No tile has said where it sits on the wall yet.
    expect(a).match(/ {2}map none$/)
    expect(b).not.match(/short/)
    expect(clock).match(
      / {2}held {2}ahead ≤ \d+s {2}heard A {2}gate 1 short \d+(\.\d)?s$/
    )

    fill(tiles.A, [120, 126])
    await ticks(2)
    expect(mc().readout[2]).match(/ {2}playing {2}ahead ≤ \d+s {2}heard A$/)
    expect(tiles.A.paused).equals(false)
  })

  it('keeps looking once a second while the grid re-renders faster than that, as it does after a scrub', async function () {
    this.timeout(8000)
    const { mc, tiles, rerender } = await grid({}, { debug: true }, tiles => {
      fill(tiles.A, [120, 130])
      fill(tiles.B, [60, 70])
    })
    await ticks(1)
    expect(tiles.A.paused).equals(false)
    /** What the readout last said A holds: it is only rewritten by a look. */
    const shown = (): number =>
      Number(/ buf (-?[0-9.]+)s/.exec(mc().readout[0] ?? '')?.[1])
    // Three seconds of renders a third of a second apart, each changing
    // something the look reads (which angle is heard), while A's buffer
    // grows a second at a time.
    for (let step = 1; step <= 10; step++) {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 300))
      })
      fill(tiles.A, [120, 130 + step])
      await rerender({ audioId: step % 2 === 0 ? 'A' : 'B' })
    }
    // Looked at within the last second or so: at least 17 of the 20 s.
    expect(shown()).least(16)
  })

  it('plays a lone angle its player calls ready, though the gate measures it short at the clock for ever (the iPhone freeze)', async function () {
    this.timeout(8000)
    // Safari's state when it froze: paused at 306 s, six seconds loaded and
    // no more, ready to play by its own word; the clock 3.5 s ahead of it.
    const { mc, tiles } = await grid(
      { videos: [video('A', 0)], order: ['A'], atMs: T0 + 309_500 },
      { debug: true },
      tiles => {
        fill(tiles.A, [306, 312])
        tiles.A.currentTime = 306
      }
    )
    // Alone, it waits only for its player's word — not two seconds, not
    // five seconds of buffer at the clock.
    await ticks(1)
    expect(tiles.A.paused).equals(false)
    expect(mc().waiting).equals(false)
  })

  it('holds a grid of several angles for two seconds before trusting a player that stands ready', async function () {
    this.timeout(8000)
    const { mc, tiles } = await grid(
      {
        videos: [video('A', 0), video('B', 0)],
        order: ['A', 'B'],
        atMs: T0 + 309_500
      },
      {},
      tiles => {
        for (const tile of [tiles.A, tiles.B]) {
          fill(tile, [306, 312])
          tile.currentTime = 306
        }
      }
    )
    await ticks(1)
    expect(mc().waiting).equals(true)
    expect(tiles.A.paused).equals(true)
    await ticks(3)
    expect(tiles.A.paused).equals(false)
    expect(tiles.B.paused).equals(false)
  })

  it('sends a lone recording across a start hole wider than its player jumps, and plays it', async function () {
    this.timeout(5000)
    // Three seconds of nothing where it is to start, then the footage.
    const { mc, tiles } = await grid(
      { videos: [video('A', 0)], order: ['A'], atMs: T0 + 300_000 },
      {},
      tiles => {
        fill(tiles.A, [303, 340])
      }
    )
    await ticks(2)
    // Sent to 300 s, the moment, and from there to the footage at 303 s.
    expect(tiles.A.currentTime).equals(303)
    expect(tiles.A.paused).equals(false)
    expect(mc().waiting).equals(false)
  })

  it('stops every tile the moment one is about to run dry, and starts them once it has filled', async function () {
    this.timeout(5000)
    const { mc, tiles } = await grid({}, {}, tiles => {
      fill(tiles.A, [120, 180])
      fill(tiles.B, [60, 120])
    })
    expect(tiles.A.paused).equals(false)

    fill(tiles.B, [60, 60.3])
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 400))
    })
    expect(tiles.A.paused).equals(true)
    expect(tiles.B.paused).equals(true)
    expect(mc().waiting).equals(true)

    // Back to a second: still not enough to go again.
    fill(tiles.B, [60, 61])
    await ticks(1)
    expect(tiles.A.paused).equals(true)

    fill(tiles.B, [60, 66])
    await ticks(1)
    expect(tiles.A.paused).equals(false)
    expect(tiles.B.paused).equals(false)
    expect(mc().waiting).equals(false)
  })

  it('stops the clock where the tiles stopped, and starts again from there', async function () {
    this.timeout(5000)
    const { mc, tiles } = await grid({}, {}, tiles => {
      fill(tiles.A, [120, 180])
      fill(tiles.B, [60, 120])
    })
    // They play on past the clock's last reading before B runs short.
    tiles.A.currentTime = 120.8
    tiles.B.currentTime = 60.8
    fill(tiles.B, [60, 61])
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 400))
    })
    expect(tiles.A.paused).equals(true)
    expect(mc().atWallMs).equals(T0 + 120_800)

    fill(tiles.B, [60, 70])
    await ticks(1)
    expect(tiles.A.paused).equals(false)
    expect(tiles.A.currentTime).equals(120.8)
    expect(tiles.B.currentTime).equals(60.8)
  })

  it('forgives a phone tile buffering while it joins, and no longer', async function () {
    this.timeout(9000)
    // Phone tiles: no `buffered`, only whether the player is ready.
    const { mc, tiles } = await grid()
    expect(tiles.A.paused).equals(false)
    // Past the first look, which finds both still landing from being placed.
    await ticks(1)
    // B is too far out to close by speed: it is sent just ahead to wait, and
    // its player buffers there.
    tiles.A.currentTime = 121
    tiles.B.currentTime = 58
    await ticks(1)
    expect(tiles.B.currentTime).equals(61 + JOIN_LEAD_SEC)
    tiles.B.readyState = 2
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 400))
    })
    expect(tiles.A.paused).equals(false)
    expect(mc().waiting).equals(false)

    // Still buffering once it has started and had its moment: running dry.
    await act(async () => {
      await new Promise(resolve =>
        setTimeout(resolve, JOIN_LEAD_SEC * 2000 + 300)
      )
    })
    expect(tiles.A.paused).equals(true)
  })

  it('brings a tile a little out back by speed, and starts one far out on the moment', async function () {
    this.timeout(8000)
    const { tiles } = await grid()
    await ticks(1)
    // Half a second behind: it runs faster, and is not moved.
    tiles.A.currentTime = 121
    tiles.B.currentTime = 60.5
    await ticks(1)
    expect(tiles.B.currentTime).equals(60.5)
    expect(tiles.B.playbackRate).closeTo(1.1, 1e-9)
    // The heard tile is the clock, and is never sped up.
    expect(tiles.A.playbackRate).equals(1)

    // Back on the moment: normal speed again.
    tiles.A.currentTime = 122
    tiles.B.currentTime = 62
    await ticks(1)
    expect(tiles.B.playbackRate).equals(1)

    // Three seconds out is too far to close by speed: it is sent just ahead,
    // held on that picture, and started when the game reaches it.
    tiles.A.currentTime = 123
    tiles.B.currentTime = 60
    await ticks(1)
    expect(tiles.B.currentTime).equals(63 + JOIN_LEAD_SEC)
    expect(tiles.B.paused).equals(true)
    expect(tiles.B.playbackRate).equals(1)
    // Not before the game reaches its picture…
    tiles.A.currentTime = 124
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
    })
    expect(tiles.B.paused).equals(true)
    // …and on it once it does.
    tiles.A.currentTime = 123 + JOIN_LEAD_SEC
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
    })
    expect(tiles.B.paused).equals(false)
    expect(tiles.B.currentTime).equals(63 + JOIN_LEAD_SEC)
  })

  it('sends a joining tile further ahead when the game passes it before it is ready', async function () {
    this.timeout(8000)
    const { tiles } = await grid()
    await ticks(1)
    tiles.A.currentTime = 121
    tiles.B.currentTime = 58
    await ticks(1)
    expect(tiles.B.currentTime).equals(61 + JOIN_LEAD_SEC)
    // Its player is still landing when the game gets there, and after.
    tiles.B.readyState = 2
    tiles.A.currentTime = 121 + JOIN_LEAD_SEC + 0.5
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
    })
    expect(tiles.B.paused).equals(true)
    expect(tiles.B.currentTime).equals(
      61 + JOIN_LEAD_SEC + 0.5 + 2 * JOIN_LEAD_SEC
    )
  })

  it('plays the heard tile without sound when the browser refuses it, and gives it back on a tap', async function () {
    // iOS Safari: a video with sound plays only when a touch starts it.
    const strict = (tile: FakeTile): void => {
      tile.play = async function (this: FakeTile) {
        if (!this.muted) {
          const refused = new Error('needs a gesture')
          refused.name = 'NotAllowedError'
          throw refused
        }
        this.paused = false
      }
    }
    const { mc, tiles } = await grid({}, {}, tiles => {
      strict(tiles.A)
      tiles.B.muted = true
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })
    expect(tiles.A.paused).equals(false)
    expect(tiles.A.muted).equals(true)
    expect(mc().soundBlocked).equals(true)

    await act(async () => {
      mc().pressStart(1, 10, 10, null)
      mc().pressEnd(1, 10, 10)
    })
    expect(tiles.A.muted).equals(false)
    expect(mc().soundBlocked).equals(false)
  })

  it('plays a step within what the tiles hold straight on, and holds one beyond it', async function () {
    const { tiles, mc } = await grid({}, {}, tiles => {
      fill(tiles.A, [120, 180])
      fill(tiles.B, [60, 120])
    })
    await act(async () => {
      mc().goTo(T0 + 130_000)
    })
    expect(tiles.A.currentTime).equals(130)
    expect(tiles.A.paused).equals(false)
    expect(tiles.B.paused).equals(false)

    await act(async () => {
      mc().goTo(T0 + 400_000)
    })
    expect(tiles.A.currentTime).equals(400)
    expect(tiles.A.paused).equals(true)
    expect(tiles.B.paused).equals(true)
  })

  it('leaves a tile that arrives while the others play out until it has filled', async function () {
    this.timeout(7000)
    const { mc, tiles } = await grid({}, {}, tiles => {
      fill(tiles.A, [120, 180])
      fill(tiles.B, [60, 120])
    })
    // B's player is handed a new source: it starts with nothing.
    const fresh = new FakeTile()
    fill(fresh)
    await act(async () => {
      mc().takeElement('B')(fresh)
      mc().attached('B', fresh, mc().attaching('B'))
    })
    expect(fresh.paused).equals(true)
    expect(tiles.A.paused).equals(false)
    expect(mc().tileWaiting('B')).equals(true)

    // The master plays on, as a real one does.
    tiles.A.currentTime = 121
    await ticks(1)
    expect(tiles.A.paused).equals(false)
    expect(fresh.paused).equals(true)

    tiles.A.currentTime = 122
    fill(fresh, [60, 70])
    await ticks(1)
    // It joins just ahead of the moment, and starts when the game gets there.
    expect(mc().tileWaiting('B')).equals(false)
    expect(fresh.currentTime).equals(62 + JOIN_LEAD_SEC)
    expect(fresh.paused).equals(true)
    tiles.A.currentTime = 122 + JOIN_LEAD_SEC
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
    })
    expect(fresh.paused).equals(false)
  })

  it('loads every tile half a minute ahead, however full the others are (U29)', async function () {
    this.timeout(5000)
    const { mc, tiles } = await grid({}, {}, tiles => {
      fill(tiles.A, [120, 128])
      fill(tiles.B, [60, 100])
    })
    // Half a minute each, whatever the others hold: nobody is held back for
    // anybody else.
    for (const id of ['A', 'B'])
      expect(mc().bufferFor(id), id).deep.equals({ aheadSec: 30 })
    fill(tiles.A, [120, 175])
    await ticks(1)
    expect(mc().bufferFor('A')).deep.equals({ aheadSec: 30 })
    expect(tiles.A.paused).equals(false)
  })

  it('does not pull the others back to a master that has stopped drawing', async function () {
    this.timeout(5000)
    const { tiles } = await grid({}, {}, tiles => {
      fill(tiles.A, [120, 180])
      fill(tiles.B, [60, 120])
    })
    await ticks(1)
    // A, the master, is frozen at 120 s while B plays on.
    tiles.B.currentTime = 62
    await ticks(1)
    expect(tiles.B.currentTime).equals(62)
  })
})

describe('useMultiCam on each tile’s own dates (U22)', function () {
  it('lines two angles up by their program date-times, not by their starts', async function () {
    // Both rows say the same start, but their playlists begin a minute
    // apart on the wall: A's first fragment was captured at T0 + 60 s.
    const { mc, tiles } = await grid({
      videos: [video('A', 0), video('B', 0)],
      order: ['A', 'B']
    })
    const dated = (wall0: number): WallMapping =>
      fromFragments(
        Array.from({ length: 150 }, (unused, index) => ({
          start: index * 4,
          duration: 4,
          programDateTime: wall0 + index * 4000
        }))
      )
    await act(async () => {
      mc().takeMapping('A')(dated(T0 + 60_000))
      mc().takeMapping('B')(dated(T0))
    })
    await act(async () => {
      mc().goTo(T0 + 180_000)
    })
    expect(tiles.A.currentTime).closeTo(120, 0.01)
    expect(tiles.B.currentTime).closeTo(180, 0.01)
    // Without dates a tile falls back to its start, as before.
    await act(async () => {
      mc().takeMapping('A')(null)
      mc().goTo(T0 + 200_000)
    })
    expect(tiles.A.currentTime).closeTo(200, 0.01)
    expect(tiles.B.currentTime).closeTo(200, 0.01)
  })

  it('falls back to the server’s wall timeline for a tile with no dates', async function () {
    const { mc, tiles } = await grid(
      { videos: [video('A', 0), video('B', 0)], order: ['A', 'B'] },
      {
        fallbackMapping: id =>
          id === 'B'
            ? fromFragments([
                { start: 0, duration: 600, programDateTime: T0 + 30_000 }
              ])
            : null
      }
    )
    await act(async () => {
      mc().goTo(T0 + 100_000)
    })
    expect(tiles.A.currentTime).closeTo(100, 0.01)
    expect(tiles.B.currentTime).closeTo(70, 0.01)
  })
})

describe('useMultiCam with a lone recording that has no start (M5, M8)', function () {
  it('plays it on its own media time, whatever dates its player hands over', async function () {
    const lone = { ...video('A', 0), startAt: null }
    const { mc, tiles } = await grid({
      videos: [lone],
      order: ['A'],
      atMs: 40_000
    })
    await act(async () => {
      mc().takeMapping('A')(
        fromFragments([
          { start: 0, duration: 600, programDateTime: T0 + 30_000 }
        ])
      )
      mc().goTo(70_000)
    })
    expect(tiles.A.currentTime).closeTo(70, 0.01)
  })
})

describe('useMultiCam with a live camera behind the game (U27)', function () {
  /** Four-second fragments from the take's start, `seconds` of them in all. */
  const dated = (seconds: number): WallMapping =>
    fromFragments(
      Array.from({ length: seconds / 4 }, (unused, index) => ({
        start: index * 4,
        duration: 4,
        programDateTime: T0 + index * 4000
      }))
    )

  it('holds a tile whose newest footage is behind the moment, labelled, out of the gate, never sought, and puts it back once it has caught up', async function () {
    this.timeout(10_000)
    // Each tile's dates, as its playlist gives them before its pictures.
    const held: Record<string, WallMapping> = {
      A: dated(300),
      B: dated(100)
    }
    const { mc, tiles } = await grid(
      {
        videos: [liveVideo('A', 0), liveVideo('B', 0)],
        order: ['A', 'B'],
        atMs: T0 + 150_000
      },
      { fallbackMapping: id => held[id] ?? null },
      tiles => {
        for (const tile of Object.values(tiles))
          tile.duration = Number.POSITIVE_INFINITY
        fill(tiles.A, [100, 300])
        Object.assign(tiles.A, { seekable: { length: 1, end: () => 300 } })
        fill(tiles.B, [60, 100])
        Object.assign(tiles.B, { seekable: { length: 1, end: () => 100 } })
        tiles.B.currentTime = 99
      }
    )
    await ticks(2)
    expect(mc().tiles.B?.parked).equals('notYet')
    expect(tiles.B.paused).equals(true)
    expect(tiles.B.currentTime, 'never sought').equals(99)
    // The other plays on, and the grid is not held for it.
    expect(tiles.A.paused).equals(false)
    expect(mc().waiting).equals(false)

    // B's playlist grows past the moment: it is put back on it.
    fill(tiles.B, [60, 260])
    Object.assign(tiles.B, { seekable: { length: 1, end: () => 260 } })
    held.B = dated(260)
    await ticks(2)
    expect(mc().tiles.B?.parked ?? null).equals(null)
    expect(tiles.B.currentTime).greaterThan(140)
  })
  it('runs a live game’s bar from its first camera to the newest footage any angle has, and lands a move past live at the live point', async function () {
    const served: Record<string, WallMapping | null> = {
      A: dated(300),
      B: dated(300)
    }
    const { mc } = await grid(
      {
        videos: [liveVideo('A', 0), liveVideo('B', 0)],
        order: ['A', 'B'],
        atMs: T0 + 150_000
      },
      { fallbackMapping: id => served[id] ?? null },
      tiles => {
        for (const tile of Object.values(tiles)) {
          tile.duration = Number.POSITIVE_INFINITY
          // B's player can reach less than A's: the slower angle sets it.
          Object.assign(tile, {
            seekable: { length: 1, end: () => (tile === tiles.B ? 250 : 260) }
          })
          fill(tile, [140, 200])
        }
      }
    )
    // From the first camera's first picture to the newest footage either
    // angle has, A's 260 s, though the viewer has played only to 150 s.
    expect(mc().take?.fromMs).equals(T0)
    expect(mc().take?.toMs).equals(T0 + 260_000)
    // Dragged to the end, the grid goes to the live point: 45 s behind the
    // slower angle's newest footage, B's 250 s.
    await act(async () => {
      mc().goTo(T0 + 260_000)
    })
    expect(mc().atWallMs).equals(T0 + 205_000)
    // Back is anywhere in the take.
    await act(async () => {
      mc().goTo(T0 + 60_000)
    })
    expect(mc().atWallMs).equals(T0 + 60_000)
  })

  it('never sends a forward move back, when the grid already plays past the live point', async function () {
    // The live point moves a segment at a time, and an angle whose camera
    // has just gone holds it still: the pictures can be past it.
    const served: Record<string, WallMapping | null> = {
      A: dated(300),
      B: dated(300)
    }
    const { mc } = await grid(
      {
        videos: [liveVideo('A', 0), liveVideo('B', 0)],
        order: ['A', 'B'],
        atMs: T0 + 230_000
      },
      { fallbackMapping: id => served[id] ?? null },
      tiles => {
        for (const tile of Object.values(tiles)) {
          tile.duration = Number.POSITIVE_INFINITY
          // B's footage reaches 250 s: the live point is 205 s.
          Object.assign(tile, {
            seekable: { length: 1, end: () => (tile === tiles.B ? 250 : 260) }
          })
          fill(tile, [200, 260])
        }
      }
    )
    expect(mc().atWallMs).equals(T0 + 230_000)
    // Ten seconds on, past the live point: it stays where it is.
    await act(async () => {
      mc().goTo(T0 + 240_000)
    })
    expect(mc().atWallMs).equals(T0 + 230_000)
    // Back is still back.
    await act(async () => {
      mc().goTo(T0 + 220_000)
    })
    expect(mc().atWallMs).equals(T0 + 220_000)
  })

  it('keeps the bar’s end and the live point while every tile seeks out of what it holds', async function () {
    this.timeout(5000)
    const served: Record<string, WallMapping | null> = {
      A: dated(300),
      B: dated(300)
    }
    const { mc, tiles } = await grid(
      {
        videos: [liveVideo('A', 0), liveVideo('B', 0)],
        order: ['A', 'B'],
        atMs: T0 + 150_000
      },
      { fallbackMapping: id => served[id] ?? null },
      tiles => {
        for (const tile of Object.values(tiles)) {
          tile.duration = Number.POSITIVE_INFINITY
          Object.assign(tile, { seekable: { length: 1, end: () => 260 } })
          fill(tile, [140, 200])
        }
      }
    )
    // A move out of what they hold: a browser's tiles keep only their
    // metadata until the new place loads.
    await act(async () => {
      mc().goTo(T0 + 100_000)
    })
    for (const tile of Object.values(tiles)) tile.readyState = 1
    await ticks(1)
    expect(mc().take?.toMs).equals(T0 + 260_000)
    // And a move past live still lands at the live point.
    await act(async () => {
      mc().goTo(T0 + 260_000)
    })
    expect(mc().atWallMs).equals(T0 + 215_000)
  })

  it('lets no angle whose camera has stopped hold the live point back once the grid has played past it', async function () {
    // B keeps its address and its picture, but its footage stopped at 150 s,
    // and the grid already plays at 170 s.
    const served: Record<string, WallMapping | null> = {
      A: dated(300),
      B: dated(300)
    }
    const { mc } = await grid(
      {
        videos: [liveVideo('A', 0), liveVideo('B', 0)],
        order: ['A', 'B'],
        atMs: T0 + 170_000
      },
      { fallbackMapping: id => served[id] ?? null },
      tiles => {
        for (const tile of Object.values(tiles)) {
          tile.duration = Number.POSITIVE_INFINITY
          Object.assign(tile, {
            seekable: { length: 1, end: () => (tile === tiles.B ? 150 : 260) }
          })
          fill(tile, [140, 260])
        }
      }
    )
    await act(async () => {
      mc().goTo(T0 + 260_000)
    })
    // A's live point, not B's last picture less the delay.
    expect(mc().atWallMs).equals(T0 + 215_000)
  })

  it('ends a live bar at an angle’s seekable end where it has no mapping yet', async function () {
    // A phone's tile has no dates of its own, and the server's timeline has
    // not arrived: its player's seekable end, placed by its start.
    const { mc } = await grid(
      {
        videos: [liveVideo('A', 0), liveVideo('B', 0)],
        order: ['A', 'B'],
        atMs: T0 + 150_000
      },
      {},
      tiles => {
        for (const tile of Object.values(tiles)) {
          tile.duration = Number.POSITIVE_INFINITY
          Object.assign(tile, { seekable: { length: 1, end: () => 260 } })
          fill(tile, [140, 200])
        }
      }
    )
    expect(mc().take?.toMs).equals(T0 + 260_000)
  })

  it('lets no angle it cannot play hold the live point back at its own last footage', async function () {
    // B's camera has gone: the server still lists it as live, its timeline
    // ends at 100 s, and there is no address for it.
    const served: Record<string, WallMapping | null> = {
      A: dated(300),
      B: dated(100)
    }
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.playback = async (id: string) => ({
      videoId: id,
      storage: 'spaces',
      url: id === 'B' ? null : `https://media/${id}.m3u8`,
      expiresAt: null,
      durationSec: null,
      unavailable: id === 'B'
    })
    const { mc } = await grid(
      {
        client,
        videos: [liveVideo('A', 0), liveVideo('B', 0)],
        order: ['A', 'B'],
        atMs: T0 + 150_000
      },
      { fallbackMapping: id => served[id] ?? null },
      tiles => {
        for (const tile of Object.values(tiles)) {
          tile.duration = Number.POSITIVE_INFINITY
          // B's player stopped at its last footage.
          Object.assign(tile, {
            seekable: { length: 1, end: () => (tile === tiles.B ? 100 : 260) }
          })
          fill(tile, [140, 200])
        }
      }
    )
    await until(() => mc().urls.B === null)
    await act(async () => {
      mc().goTo(T0 + 260_000)
    })
    // A's live point, 45 s behind its newest footage: not B's, minutes back.
    expect(mc().atWallMs).equals(T0 + 215_000)
  })

  it('places a tile by the server’s wall timeline before its own stream’s dates, and reaches its newest footage by it', async function () {
    // The server's, by the frames' own clocks; the stream's dates 4.57 s
    // later, as a live ingest writes them.
    const served: Record<string, WallMapping | null> = {
      A: dated(300),
      B: dated(300)
    }
    const { mc } = await grid(
      {
        videos: [liveVideo('A', 0), liveVideo('B', 0)],
        order: ['A', 'B'],
        atMs: T0 + 150_000
      },
      { fallbackMapping: id => served[id] ?? null },
      tiles => {
        for (const tile of Object.values(tiles)) {
          tile.duration = Number.POSITIVE_INFINITY
          Object.assign(tile, { seekable: { length: 1, end: () => 260 } })
          fill(tile, [140, 200])
        }
      }
    )
    const own = fromFragments(
      Array.from({ length: 75 }, (unused, index) => ({
        start: index * 4,
        duration: 4,
        programDateTime: T0 + index * 4000 + 4570
      }))
    )
    await act(async () => {
      mc().takeMapping('A')(own)
    })
    const clockOf = (index: number): WallMapping =>
      (mc().chosen[index] as AngleVideo).clock!()!
    const clockA = clockOf(0)
    expect(clockA.wallAt(150)).equals(T0 + 150_000)
    expect(clockA.newestWall()).equals(T0 + 260_000)
    // With no timeline from the server, the stream's own dates.
    served.A = null
    expect(clockOf(0).wallAt(150)).equals(T0 + 154_570)
  })

  it('moves a held tile to where its dates put the moment once they arrive, once for each place', async function () {
    this.timeout(10_000)
    const held: Record<string, WallMapping> = {
      A: dated(300),
      B: dated(300)
    }
    const { mc, tiles } = await grid(
      {
        videos: [liveVideo('A', 0), liveVideo('B', 0)],
        order: ['A', 'B'],
        atMs: T0 + 150_000
      },
      { fallbackMapping: id => held[id] ?? null },
      tiles => {
        for (const tile of Object.values(tiles)) {
          tile.duration = Number.POSITIVE_INFINITY
          Object.assign(tile, { seekable: { length: 1, end: () => 300 } })
        }
        fill(tiles.A, [148, 190])
        fill(tiles.B, [150, 152])
      }
    )
    await ticks(1)
    expect(mc().waiting).equals(true)
    expect(tiles.A.currentTime).equals(150)

    // A's own dates put the moment 4.6 s earlier than its start did, where
    // it holds nothing — within a start hole of what it holds, so it would
    // count as ready there — and it is sent there; B, which holds where it
    // stands, is not.
    held.A = fromFragments(
      Array.from({ length: 75 }, (unused, index) => ({
        start: index * 4,
        duration: 4,
        programDateTime: T0 + index * 4000 + 4600
      }))
    )
    await ticks(1)
    expect(tiles.A.currentTime).closeTo(145.4, 1e-6)
    expect(tiles.B.currentTime).equals(150)

    // Its player steps over a hole there, and short of enough it is not
    // sent back for it.
    tiles.A.currentTime = 147
    fill(tiles.A, [147, 149])
    await ticks(1)
    expect(tiles.A.currentTime).equals(147)
    expect(mc().waiting).equals(true)

    fill(tiles.A, [147, 170])
    fill(tiles.B, [150, 200])
    await ticks(1)
    expect(mc().waiting).equals(false)
    expect(tiles.A.paused).equals(false)
    expect(tiles.A.currentTime).equals(147)
  })
})
