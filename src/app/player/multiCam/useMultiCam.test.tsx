import { mock } from 'node:test'

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
import { attachHls as attachNativeHls } from '../attachHls.native'
import { onExplicitSeek } from '../explicitSeek'
import { NativeVideoHandle } from '../nativeVideoHandle'
import { SLOW_RATE } from '../slowMotion'
import type { VideoEventName } from '../videoHandle'
import type { AngleVideo } from '../wallClock'
import {
  fromFragments,
  MAPPING_WAIT_MS,
  type WallMapping
} from '../wallMapping'
import { JOIN_LEAD_SEC, LIVE_OPEN_WAIT_MS, WATCHDOG_MS } from './align'
import { tileRects } from './layout'
import {
  type MultiCam,
  type MultiCamOptions,
  type MultiCamProps,
  type TileHandle,
  useAutoHide,
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

describe('playback control visibility deadline', function () {
  it('hides at two seconds and refreshes the whole interval on interaction', async function () {
    mock.timers.enable({ apis: ['setTimeout'] })
    let controls: ReturnType<typeof useAutoHide>
    function Controls(): null {
      controls = useAutoHide(2000)
      return null
    }
    try {
      host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      await act(async () => {
        root!.render(<Controls />)
      })
      await act(async () => {
        controls.show()
      })
      await act(async () => {
        mock.timers.tick(1999)
      })
      expect(controls!.shown).equals(true)
      await act(async () => {
        mock.timers.tick(1)
      })
      expect(controls!.shown).equals(false)
      expect(controls!.shownRef.current).equals(false)
      await act(async () => {
        controls.show()
        mock.timers.tick(1000)
        controls.show()
      })
      await act(async () => {
        mock.timers.tick(1999)
      })
      expect(controls!.shown).equals(true)
      await act(async () => {
        mock.timers.tick(1)
      })
      expect(controls!.shown).equals(false)
      await act(async () => {
        controls.setPressed(true)
        mock.timers.tick(5000)
        controls.show()
        mock.timers.tick(5000)
      })
      expect(controls!.shown).equals(true)
      await act(async () => {
        controls.setPressed(false)
        mock.timers.tick(1999)
      })
      expect(controls!.shown).equals(true)
      await act(async () => {
        mock.timers.tick(1)
      })
      expect(controls!.shown).equals(false)
    } finally {
      mock.timers.reset()
    }
  })
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
  /** How many times the grid has rendered. */
  renders: () => number
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
  let rendered = 0
  function Probe(): null {
    rendered += 1
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
  return { mc, tiles, changes, rerender, renders: () => rendered }
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

  it('applies rapid toggles before React renders the queued state updates', async () => {
    const { mc, tiles } = await grid()
    await act(async () => {
      mc().toggle()
      expect(tiles.A.paused).equals(true)
      mc().toggle()
      expect(tiles.A.paused).equals(false)
      expect(tiles.B.paused).equals(false)
    })
    expect(mc().playing).equals(true)
  })

  it('moves every tile when the take is moved, and parks one that was not recording yet', async function () {
    const { mc, tiles } = await grid()
    const intended: number[] = []
    onExplicitSeek(tiles.B, seconds => intended.push(seconds))
    await act(async () => {
      mc().goTo(T0 + 30_000)
    })
    expect(intended, 'the edge it is sent to').deep.equals([0])
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

  it('keeps a rewind, a seek and a drag inside the take', async function () {
    const { mc, tiles } = await grid({ atMs: T0 + 5000 })
    await act(async () => {
      mc().skip(-10)
      mc().skip(-10)
    })
    // At the first picture, not twenty seconds before it under a notice.
    expect(mc().atWallMs).equals(T0)
    expect(tiles.A.currentTime).equals(0)
    expect(mc().tiles.A?.parked ?? null).equals(null)
    expect(tiles.A.paused).equals(false)
    // B starts a minute in: that gap is real and stays one.
    expect(mc().tiles.B?.parked).equals('beforeStart')
    await act(async () => {
      mc().goTo(T0 - 30_000)
    })
    expect(mc().atWallMs).equals(T0)
    await act(async () => {
      mc().scrub(T0 - 90_000)
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    expect(mc().atWallMs).equals(T0)
    // A finished take ends at its last picture, B's at 660 s.
    await act(async () => {
      mc().goTo(T0 + 9_000_000)
    })
    expect(mc().atWallMs).equals(T0 + 660_000)
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

  it('leaves the heard tile silent after a crawl when the sound is off', async function () {
    this.timeout(5000)
    const { mc, tiles } = await grid()
    await act(async () => {
      mc().runZone('audio')
    })
    expect(mc().soundOff).equals(true)
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.9, HEIGHT * 0.5, 0)
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 600))
    })
    expect(mc().slow).equals(SLOW_RATE)
    await act(async () => {
      mc().pressEnd(1, WIDTH * 0.9, HEIGHT * 0.5)
    })
    expect(tiles.A.playbackRate).equals(1)
    expect(tiles.A.muted).equals(true)
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

  it('never takes the moment from a tile that has reloaded at its own start', async function () {
    this.timeout(10_000)
    const { mc, tiles } = await grid({}, {}, tiles => {
      fill(tiles.A, [100, 160])
      fill(tiles.B, [40, 100])
    })
    await ticks(1)
    const before = mc().atWallMs ?? 0
    expect(before).closeTo(T0 + 120_000, 1500)
    // The heard tile's player is handed its stream again after an outage:
    // it opens playing, at its own first frame, holding little.
    tiles.A.currentTime = 0
    tiles.A.paused = false
    fill(tiles.A, [0, 0.2])
    // The grid stops for it, where the game is, not where it reopened.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 400))
    })
    expect(mc().atWallMs ?? 0).closeTo(before, 2000)
    // And a step from there is a step from the game.
    await act(async () => {
      mc().skip(10)
    })
    expect(mc().atWallMs ?? 0).closeTo(before + 10_000, 2000)
    expect(tiles.B.currentTime).closeTo(70, 2)
  })

  it('sends a follower whose seek landed in a hole on to the footage after it', async function () {
    this.timeout(10_000)
    // B's place at this moment, 346.68 s, is in that hole.
    const { tiles } = await grid({ atMs: T0 + 406_680 }, {}, tiles => {
      fill(tiles.A, [380, 460])
      fill(tiles.B, [300, 346.2], [347.58, 400])
    })
    // B was sent into the second missing between two of its segments, and
    // its paused player waits there for footage that will never be written.
    tiles.B.pause()
    tiles.B.readyState = 1
    tiles.B.currentTime = 346.68
    Object.assign(tiles.B, { seeking: true })
    await ticks(1)
    expect(tiles.B.currentTime, 'a look to see it is stuck').equals(346.68)
    await ticks(2)
    expect(tiles.B.currentTime).equals(347.58)
    // Once for each hole: a seek that still will not land is not sent back
    // and forth.
    tiles.B.currentTime = 346.68
    await ticks(2)
    expect(tiles.B.currentTime).equals(346.68)
  })

  it('says nothing of catching up over a recording standing on its last frame', async function () {
    this.timeout(15000)
    // A phone's player at the end of a recording a little longer than its
    // row says: still "playing", stopped short of its last frame, drawing
    // nothing more and never saying it has ended.
    const { mc, tiles } = await grid({ atMs: T0 + 659_000 }, {}, tiles => {
      tiles.B.duration = 600.3
    })
    tiles.B.currentTime = 600.14
    tiles.B.paused = false
    await ticks(4)
    expect(mc().tiles.B?.stalledSince ?? null).equals(null)
    expect(mc().tileWaiting('B')).equals(false)
    expect(mc().ended).equals(true)
    // A rewind brings it back, and a later stall is still reported.
    await act(async () => {
      mc().skip(-30)
    })
    expect(mc().ended).equals(false)
    expect(tiles.B.currentTime).closeTo(570, 1.5)
    await ticks(4)
    expect(mc().tileWaiting('B')).equals(true)
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

  it('consumes hidden non-transport gestures from down through drag, hold, cancel and release', async function () {
    const { mc, tiles } = await grid()
    for (const zone of ['audio', 'corner', 'scrub'] as const) {
      await act(async () => {
        mc().hideControls()
      })
      const x = zone === 'audio' ? WIDTH * 0.1 : WIDTH * 0.9
      const y = zone === 'scrub' ? HEIGHT * 0.9 : HEIGHT * 0.1
      const before = tiles.A.currentTime
      await act(async () => {
        mc().pressStart(1, x, y, 0)
        mc().pressMove(1, WIDTH * 0.5, y)
        expect(mc().pressEnd(1, WIDTH * 0.5, y)).equals('dead')
      })
      expect(tiles.A.currentTime).equals(before)
      expect(mc().soundOff).equals(false)
      expect(mc().scrubShown).equals(true)
      expect(mc().controlsShown).equals(true)
    }
    await act(async () => {
      mc().hideBar()
      mc().pressStart(2, WIDTH * 0.5, HEIGHT * 0.9, 0)
      mc().pressCancel(2)
    })
    expect(tiles.A.currentTime).equals(120)
    await act(async () => {
      mc().pressStart(3, WIDTH * 0.3, HEIGHT * 0.9, 0)
      mc().pressMove(3, WIDTH * 0.6, HEIGHT * 0.9)
      mc().pressEnd(3, WIDTH * 0.6, HEIGHT * 0.9)
    })
    expect(tiles.A.currentTime).not.equals(120)
  })

  for (const zone of ['scrub', 'audio'] as const)
    it(`keeps a hidden ${zone} reveal consumed when a second pointer arrives`, async function () {
      const { mc, tiles } = await grid()
      const x = WIDTH * 0.1
      const y = HEIGHT * (zone === 'scrub' ? 0.9 : 0.1)
      const before = tiles.A.currentTime
      await act(async () => {
        mc().hideControls()
        expect(mc().pressStart(1, x, y, 0)).equals(true)
        expect(mc().pressStart(2, x, y, 0)).equals(false)
        mc().pressMove(2, WIDTH * 0.7, y)
        mc().pressEnd(2, WIDTH * 0.7, y)
        expect(mc().pressEnd(1, x, y)).equals('dead')
      })
      expect(tiles.A.currentTime).equals(before)
      expect(mc().soundOff).equals(false)
      await act(async () => {
        expect(mc().pressStart(3, x, y, 0)).equals(true)
        mc().pressEnd(3, x, y)
      })
      if (zone === 'scrub') expect(tiles.A.currentTime).not.equals(before)
      else expect(mc().soundOff).equals(true)
    })

  it('keeps a permitted gesture valid if controls expire before release', async function () {
    const { mc } = await grid()
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.1, HEIGHT * 0.1, 0)
      mc().hideControls()
      mc().pressEnd(1, WIDTH * 0.1, HEIGHT * 0.1)
    })
    expect(mc().soundOff).equals(true)
    expect(mc().controlsShown).equals(true)
  })

  it('reveals direct hidden audio activation without changing audio or blocked sound', async function () {
    const { mc, tiles } = await grid()
    await act(async () => {
      mc().soundHeld('A')
      tiles.A.muted = true
      mc().hideControls()
      mc().pressStart(1, WIDTH * 0.1, HEIGHT * 0.1, 0)
      mc().pressEnd(1, WIDTH * 0.1, HEIGHT * 0.1)
    })
    expect(mc().soundBlocked).equals(true)
    expect(tiles.A.muted).equals(true)
    await act(async () => {
      mc().hideControls()
      mc().runZone('audio')
    })
    expect(mc().soundOff).equals(false)
    expect(mc().scrubShown).equals(true)
  })

  it('permits hidden skip and pause gestures while revealing both groups', async function () {
    const { mc, tiles } = await grid()
    for (const [x, expected] of [
      [WIDTH * 0.9, 130],
      [WIDTH * 0.1, 120]
    ]) {
      await act(async () => {
        mc().hideControls()
        mc().pressStart(1, x, HEIGHT * 0.5, 0)
        mc().pressEnd(1, x, HEIGHT * 0.5)
      })
      expect(tiles.A.currentTime).equals(expected)
      expect(mc().scrubShown).equals(true)
    }
    await act(async () => {
      mc().hideControls()
      mc().pressStart(1, WIDTH * 0.5, HEIGHT * 0.5, 0)
      mc().pressEnd(1, WIDTH * 0.5, HEIGHT * 0.5)
    })
    expect(mc().playing).equals(false)
  })

  it('shows controls and scrub line on a bottom-row tap, and hides both two seconds on', async function () {
    this.timeout(6000)
    const { mc } = await grid()
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.5, HEIGHT * 0.9, 0)
      mc().pressEnd(1, WIDTH * 0.5, HEIGHT * 0.9)
    })
    expect(mc().scrubShown).equals(true)
    expect(mc().controlsShown).equals(true)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 2100))
    })
    expect(mc().scrubShown).equals(false)
  })

  it('shows every control above the scrub line together on a tap in any of their squares', async function () {
    this.timeout(12000)
    const { mc, tiles } = await grid()
    expect(mc().controlsShown).equals(true)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 2100))
    })
    expect(mc().controlsShown).equals(false)
    // The top-centre squares bring them up and do nothing else.
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.4, HEIGHT * 0.1, 0)
      mc().pressEnd(1, WIDTH * 0.4, HEIGHT * 0.1)
    })
    expect(mc().controlsShown).equals(true)
    expect(mc().scrubShown).equals(true)
    expect(mc().playing).equals(true)
    expect(tiles.A.currentTime).equals(120)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 2100))
    })
    // +10 s on either of its rows brings them up as well.
    for (const y of [HEIGHT * 0.3, HEIGHT * 0.6]) {
      await act(async () => {
        mc().pressStart(1, WIDTH * 0.9, y, 0)
        mc().pressEnd(1, WIDTH * 0.9, y)
      })
      expect(mc().controlsShown).equals(true)
      expect(mc().scrubShown).equals(true)
    }
    expect(tiles.A.currentTime).closeTo(140, 1)
  })

  it('turns the sound off and on in the top-left square, the heard tile at once', async function () {
    const { mc, tiles } = await grid()
    expect(mc().soundOff).equals(false)
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.1, HEIGHT * 0.1, 0)
      mc().pressEnd(1, WIDTH * 0.1, HEIGHT * 0.1)
    })
    expect(mc().soundOff).equals(true)
    expect(tiles.A.muted).equals(true)
    expect(mc().controlsShown).equals(true)
    await act(async () => {
      mc().runZone('audio')
      // Inside the touch, before any render.
      expect(tiles.A.muted).equals(false)
    })
    expect(mc().soundOff).equals(false)
  })

  it('gives a press up to the sheet while it is waiting or nothing, and not once it is a scrub', async function () {
    const { mc } = await grid()
    expect(mc().pressYields(9)).equals(true)
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.5, HEIGHT * 0.5, 0)
    })
    expect(mc().pressYields(1)).equals(true)
    // Slipped past the still slop, sideways and down: nothing, and yields.
    await act(async () => {
      mc().pressMove(1, WIDTH * 0.5 + 40, HEIGHT * 0.5 + 60)
    })
    expect(mc().pressYields(1)).equals(true)
    await act(async () => {
      mc().pressCancel(1)
      mc().pressStart(2, WIDTH * 0.3, HEIGHT * 0.9, 0)
      mc().pressMove(2, WIDTH * 0.6, HEIGHT * 0.9)
    })
    expect(mc().pressYields(2)).equals(false)
    await act(async () => {
      mc().pressEnd(2, WIDTH * 0.6, HEIGHT * 0.9)
    })
  })

  it('answers a press on an icon moved into another square with the icon, while it shows', async function () {
    // The sound icon drawn in the left middle square, below a board.
    const icons = [
      { zone: 'audio' as const, x: WIDTH * 0.1, y: HEIGHT * 0.4, r: 24 }
    ]
    const { mc, tiles } = await grid({}, { icons })
    expect(mc().controlsShown).equals(true)
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.1, HEIGHT * 0.4, 0)
      mc().pressEnd(1, WIDTH * 0.1, HEIGHT * 0.4)
    })
    expect(mc().soundOff).equals(true)
    expect(tiles.A.currentTime).equals(120)
  })

  it('gives the held sound back on a tap of the sound square, rather than turning it off', async function () {
    const { mc, tiles } = await grid()
    // The browser held the heard tile's sound until a touch.
    await act(async () => {
      mc().soundHeld('A')
    })
    expect(mc().soundBlocked).equals(true)
    tiles.A.muted = true
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.1, HEIGHT * 0.1, 0)
      mc().pressEnd(1, WIDTH * 0.1, HEIGHT * 0.1)
    })
    expect(mc().soundBlocked).equals(false)
    expect(mc().soundOff).equals(false)
    expect(tiles.A.muted).equals(false)
    // The next tap is the square's own: off.
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.1, HEIGHT * 0.1, 0)
      mc().pressEnd(1, WIDTH * 0.1, HEIGHT * 0.1)
    })
    expect(mc().soundOff).equals(true)
  })

  it('closes from the top-right square only once its ✕ is showing', async function () {
    this.timeout(6000)
    let closes = 0
    const { mc } = await grid(
      {},
      {
        onCorner: () => {
          closes += 1
        }
      }
    )
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 2100))
    })
    expect(mc().controlsShown).equals(false)
    const tap = async (): Promise<void> => {
      await act(async () => {
        mc().pressStart(1, WIDTH * 0.95, HEIGHT * 0.05, 0)
        mc().pressEnd(1, WIDTH * 0.95, HEIGHT * 0.05)
      })
    }
    await tap()
    expect(closes).equals(0)
    expect(mc().controlsShown).equals(true)
    await tap()
    expect(closes).equals(1)
  })

  it('lays the squares on the block it is given, not the window', async function () {
    const block = { x: 0, y: 100, w: WIDTH, h: 200 }
    const { mc, tiles } = await grid({}, { block })
    // Below the block is the scrub row; the block's own middle is a toggle.
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.5, 350, 0)
      mc().pressEnd(1, WIDTH * 0.5, 350)
    })
    expect(mc().scrubShown).equals(true)
    expect(mc().playing).equals(true)
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.5, 200, 0)
      mc().pressEnd(1, WIDTH * 0.5, 200)
    })
    expect(mc().playing).equals(false)
    expect(tiles.A.paused).equals(true)
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

  it('holds a crawl to its clock ten times a second, not every frame, and lets go at once', async function () {
    this.timeout(5000)
    const { mc, tiles } = await grid()
    const held: number[] = []
    onExplicitSeek(tiles.A, seconds => held.push(seconds))
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.9, HEIGHT * 0.5, 0)
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 600))
    })
    expect(mc().slow).equals(SLOW_RATE)
    const from = held.length
    const at = mc().atWallMs!
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1000))
    })
    // About ten looks, never the sixty frames the clock steps through.
    expect(held.length - from).within(5, 15)
    // The clock still moves at a quarter of the pictures' pace.
    expect(mc().atWallMs! - at).closeTo(250, 60)
    await act(async () => {
      expect(mc().pressEnd(1, WIDTH * 0.9, HEIGHT * 0.5)).equals('held')
    })
    expect(mc().slow).equals(0)
    expect(tiles.A.playbackRate).equals(1)
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

describe('useMultiCam scrubbing on the bottom row (U14)', function () {
  /** Lets an animation frame or two go by. */
  const frame = async (): Promise<void> => {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })
  }
  /** The drawn track: from a tenth in to a tenth from the right. */
  const TRACK = { x: WIDTH * 0.1, y: 0, w: WIDTH * 0.8, h: 24 }
  // The take is A's start to B's end: eleven minutes.
  const SPAN = 660_000
  const ROW = HEIGHT * 0.9

  it('follows the finger along the drawn line, with all controls showing', async function () {
    const { mc, tiles } = await grid()
    mc().setTrackRect(TRACK)
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.5, ROW, 0)
      mc().pressMove(1, WIDTH * 0.5 + 20, ROW + 2)
      mc().pressMove(1, WIDTH * 0.7, ROW + 2)
    })
    await frame()
    // 0.7 of the window is three quarters of the way along the line.
    const expected = T0 + 0.75 * SPAN
    expect(mc().atWallMs).closeTo(expected, 1)
    expect(mc().scrubShown).equals(true)
    expect(mc().controlsShown).equals(true)
    expect(tiles.A.currentTime).closeTo((expected - T0) / 1000, 0.01)
    expect(tiles.B.currentTime).closeTo((expected - T0) / 1000 - 60, 0.01)
    await act(async () => {
      expect(mc().pressEnd(1, WIDTH * 0.7, ROW)).equals('scrub')
    })
    // Past either end of the line lands at that end.
    await act(async () => {
      mc().pressStart(2, WIDTH * 0.5, ROW, 0)
      mc().pressMove(2, 0, ROW)
      mc().pressEnd(2, 0, ROW)
    })
    expect(mc().atWallMs).equals(T0)
  })

  it('seeks where a tap lands on the line, and to the end at its right end', async function () {
    const { mc } = await grid()
    mc().setTrackRect(TRACK)
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.3, ROW, 0)
      mc().pressEnd(1, WIDTH * 0.3, ROW)
    })
    expect(mc().atWallMs).closeTo(T0 + 0.25 * SPAN, 1)
    await act(async () => {
      mc().pressStart(1, TRACK.x + TRACK.w, ROW, 0)
      mc().pressEnd(1, TRACK.x + TRACK.w, ROW)
    })
    expect(mc().atWallMs).closeTo(T0 + SPAN, 1)
  })

  it('measures against the block until the bar has said where its track is', async function () {
    const { mc } = await grid()
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.25, ROW, null)
      mc().pressEnd(1, WIDTH * 0.25, ROW)
    })
    expect(mc().atWallMs).closeTo(T0 + 0.25 * SPAN, 1)
  })

  for (const playing of [false, true])
    it(`leaves the tiles ${playing ? 'playing' : 'paused'}`, async function () {
      const { mc, tiles } = await grid()
      mc().setTrackRect(TRACK)
      if (mc().playing !== playing)
        await act(async () => {
          mc().toggle()
        })
      const before = [mc().playing, tiles.A.paused, tiles.B.paused]
      await act(async () => {
        mc().pressStart(1, WIDTH * 0.5, ROW, 0)
        mc().pressMove(1, WIDTH * 0.7, ROW)
        mc().pressEnd(1, WIDTH * 0.7, ROW)
      })
      expect([mc().playing, tiles.A.paused, tiles.B.paused]).deep.equals(before)
    })

  it('moves nothing for a sideways drag above the scrub row, nor an up-and-down one on it', async function () {
    const { mc, tiles } = await grid()
    mc().setTrackRect(TRACK)
    for (const [x0, y0, x1, y1] of [
      [WIDTH * 0.5, HEIGHT * 0.5, WIDTH * 0.8, HEIGHT * 0.5],
      [WIDTH * 0.5, HEIGHT * 0.1, WIDTH * 0.2, HEIGHT * 0.1],
      [WIDTH * 0.5, ROW, WIDTH * 0.51, ROW - 40]
    ]) {
      await act(async () => {
        mc().pressStart(1, x0, y0, 0)
        mc().pressMove(1, x1, y1)
      })
      await frame()
      await act(async () => {
        expect(mc().pressEnd(1, x1, y1)).equals('dead')
      })
    }
    expect(tiles.A.currentTime).equals(120)
  })

  it('never turns a crawl into a scrub, and a hold on the scrub row is nothing', async function () {
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
    await act(async () => {
      mc().pressStart(2, WIDTH * 0.5, ROW, 0)
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 600))
    })
    expect(mc().armedTile).equals(null)
    expect(mc().slow).equals(0)
    await act(async () => {
      mc().pressCancel(2)
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

  it('jumps to the current playable live point, consumes hidden activation and never rewinds', async function () {
    const { mc, tiles } = await grid(
      { ...live, atMs: T0 + 60_000 },
      {},
      atTheirEdges
    )
    await act(async () => {
      mc().hideControls()
      mc().jumpToPresent()
    })
    expect(mc().atWallMs).equals(T0 + 60_000)
    expect(mc().anyLive).equals(true)
    await act(async () => {
      mc().jumpToPresent()
    })
    expect(mc().atWallMs).equals(T0 + 135_000)
    expect(tiles.A.currentTime).equals(135)
    Object.assign(tiles.A, { seekable: { length: 1, end: () => 240 } })
    Object.assign(tiles.B, { seekable: { length: 1, end: () => 180 } })
    await act(async () => {
      mc().jumpToPresent()
    })
    expect(mc().atWallMs).equals(T0 + 195_000)
    await act(async () => {
      mc().jumpToPresent()
    })
    expect(mc().atWallMs).equals(T0 + 195_000)
  })

  it('does not jump a recorded take', async function () {
    const { mc } = await grid()
    expect(mc().anyLive).equals(false)
    await act(async () => {
      mc().jumpToPresent()
    })
    expect(mc().atWallMs).equals(T0 + 120_000)
  })

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

  it('traces what a live grid that has not opened is waiting for', async function () {
    this.timeout(5000)
    const records: Array<{ event: string; values: Record<string, unknown> }> =
      []
    const traced = globalThis as { __TS_PLAYER_TRACE__?: unknown }
    traced.__TS_PLAYER_TRACE__ = (record: {
      event: string
      values: Record<string, unknown>
    }) => records.push(record)
    try {
      // A phone's paused players: a picture, and nothing to say where their
      // newest footage is.
      const { mc } = await grid(live, {}, tiles => {
        for (const tile of Object.values(tiles))
          tile.duration = Number.POSITIVE_INFINITY
      })
      await ticks(1)
      expect(mc().atWallMs).equals(null)
      const waits = records.filter(one => one.event === 'grid.opening.wait')
      expect(waits.map(one => one.values.tile)).include.members([0, 1])
      expect(waits[0].values).deep.equals({
        tile: 0,
        address: true,
        readyState: 4,
        newestAgoMs: null,
        mapped: false,
        byTimeline: false
      })
    } finally {
      delete traced.__TS_PLAYER_TRACE__
    }
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

  it('retries a finished angle awaiting publication through a failed request', async function () {
    this.timeout(5000)
    let asked = 0
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.playback = async id => {
      if (id === 'B') {
        asked++
        if (asked === 2) throw new Error('offline')
      }
      const pending = id === 'B' && asked < 3
      return {
        videoId: id,
        storage: 'spaces',
        url: pending ? null : `https://media/${id}.m3u8`,
        expiresAt: null,
        durationSec: null,
        unavailable: pending,
        pending
      }
    }
    const { mc } = await grid({ client }, { liveRetryDelay: quickRetry })
    await until(() => mc().urls.B != null)
    expect(asked).equals(3)
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
    const realNow = Date.now
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    const looks = new Map<unknown, () => void>()
    let now = T0
    Date.now = () => now
    globalThis.setInterval = ((
      callback: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (ms !== WATCHDOG_MS) return realSet(callback, ms, ...rest)
      const id = {}
      looks.set(id, callback)
      return id
    }) as unknown as typeof setInterval
    globalThis.clearInterval = (id: unknown) => {
      if (!looks.delete(id))
        realClear(id as Parameters<typeof clearInterval>[0])
    }
    const tick = async (elapsed: number): Promise<void> => {
      now = T0 + elapsed
      await act(async () => {
        for (const look of looks.values()) look()
      })
    }
    try {
      const { mc } = await grid(live, {}, tiles => {
        atTheirEdges(tiles)
        tiles.B.readyState = 1
      })
      expect(looks.size).equals(1)
      // Start the grace period at the first observed picture, then check
      // its boundary without assuming the runner schedules ticks on time.
      await tick(0)
      await tick(LIVE_OPEN_WAIT_MS - 1)
      expect(mc().atWallMs).equals(null)
      await tick(LIVE_OPEN_WAIT_MS)
      expect(mc().atWallMs).equals(T0 + 135_000)
    } finally {
      try {
        await act(async () => root?.unmount())
      } finally {
        root = undefined
        Date.now = realNow
        globalThis.setInterval = realSet
        globalThis.clearInterval = realClear
      }
    }
  })
})

describe('useMultiCam buffering', function () {
  for (const restoring of [false, true])
    it(`preserves the selected moment when controls encounter a reset source (restoring=${restoring})`, async () => {
      const { mc, tiles } = await grid({
        videos: [video('A', 0)],
        order: ['A'],
        atMs: T0 + 190_000
      })
      await act(async () => {
        tiles.A.currentTime = 0
        tiles.A.readyState = restoring ? 4 : 0
        tiles.A.paused = false
        if (restoring) mc().attaching('A')
        mc().toggle()
      })
      await act(async () => {
        mc().skip(-10)
        mc().skip(-10)
      })
      expect(mc().atWallMs).equals(T0 + 170_000)
      expect(mc().playing).equals(false)
    })
  it('preserves a paused grid rewind made while a network replacement opens', async function () {
    this.timeout(5000)
    const { mc } = await grid({
      videos: [video('A', 0)],
      order: ['A'],
      atMs: T0 + 190_000
    })
    let loads = 0
    let opening = false
    const seeks: number[] = []
    const handle = new NativeVideoHandle(() => undefined)
    handle.source = 'https://media/A.m3u8'
    handle.attach({
      pause: () => undefined,
      resume: () => undefined,
      seek: (seconds: number) => {
        seeks.push(seconds)
        if (!opening)
          handle.handleSeek({ seekTime: seconds, currentTime: seconds })
      },
      setSource: () => {
        opening = true
        loads++
      }
    } as unknown as Parameters<NativeVideoHandle['attach']>[0])
    const load: Parameters<NativeVideoHandle['handleLoad']>[0] = {
      currentTime: 190,
      duration: 600,
      naturalSize: { width: 640, height: 360, orientation: 'landscape' },
      audioTracks: [],
      textTracks: [],
      videoTracks: []
    }
    handle.handleLoad(load)
    handle.handleReadyForDisplay()
    handle.handleProgress({
      currentTime: 190,
      playableDuration: 600,
      seekableDuration: 600
    })
    await act(async () => {
      mc().takeElement('A')(handle)
      mc().attached('A', handle, mc().attaching('A'))
      if (mc().playing) mc().toggle()
    })
    const stop = attachNativeHls(handle, handle.source, () => undefined, {
      wantsToPlay: () => mc().intents.current.get('A') === true,
      wantsRecovery: () => mc().playing,
      buffer: { aheadSec: 30 }
    })
    try {
      await act(async () => {
        handle.handleError({
          error: { errorString: 'Temporary network interruption' }
        })
      })
      await until(() => loads > 0, 2000)
      expect(loads).equals(1)
      await act(async () => {
        mc().goTo(T0 + 80_000)
      })
      await act(async () => {
        opening = false
        handle.handleLoad({ ...load, currentTime: 0 })
        handle.handleReadyForDisplay()
      })
      expect(seeks.at(-1)).equals(80)
      expect(handle.currentTime).equals(80)
      expect(mc().atWallMs).equals(T0 + 80_000)
      expect(mc().playing).equals(false)
      expect(handle.paused).equals(true)
    } finally {
      stop()
    }
  })
  // A is two minutes in at 120 s; B, which started a minute later, at 60 s.

  it('clears the ended notice when a paused viewer rewinds into the recording', async function () {
    this.timeout(8000)
    const { mc } = await grid({ atMs: T0 + 660_000 }, {}, tiles => {
      for (const tile of Object.values(tiles)) {
        tile.currentTime = 600
        tile.ended = true
      }
    })
    await ticks(2)
    expect(mc().ended).equals(true)
    await act(async () => {
      mc().toggle()
    })
    expect(mc().playing).equals(false)
    await act(async () => {
      mc().goTo(T0 + 120_000)
    })
    expect(mc().ended).equals(false)
    expect(mc().playing).equals(false)
  })

  it('recognizes a native frozen picture despite an advancing optimistic clock', async function () {
    this.timeout(5000)
    const { mc, tiles } = await grid({}, {}, tiles => {
      Object.assign(tiles.A, { reportedTime: 120 })
      Object.assign(tiles.B, { reportedTime: 60 })
    })
    await ticks(1)
    // A's interpolation moves, but no native picture has advanced. B really
    // reports another second; neither tile is seeking or buffering.
    tiles.A.currentTime = 121
    tiles.B.currentTime = 61
    Object.assign(tiles.B, { reportedTime: 61 })
    await ticks(1)
    expect(mc().tiles.A?.stalledSince).a('number')
    expect(mc().tiles.B?.stalledSince ?? null).equals(null)
  })

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

  for (const ahead of [0.1, 0.5015])
    it(`resumes a lone cold seek with ${ahead}s buffered without pausing it again`, async function () {
      this.timeout(8000)
      const { mc, tiles } = await grid({
        videos: [video('A', 0)],
        order: ['A'],
        atMs: T0 + 120_000
      })
      await act(async () => {
        fill(tiles.A)
        tiles.A.readyState = 2
        mc().goTo(T0 + 434_188)
      })
      await ticks(1)
      expect(tiles.A.paused).equals(true)
      await act(async () => {
        fill(tiles.A, [430, 434.188 + ahead])
        tiles.A.readyState = 4
      })
      await ticks(1)
      expect(tiles.A.currentTime).closeTo(434.188, 0.001)
      expect(tiles.A.paused).equals(false)
      expect(mc().waiting).equals(false)
      await ticks(1)
      expect(tiles.A.paused).equals(false)
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

  it('leaves an active download alone during alignment but honors a new user seek', async function () {
    this.timeout(8000)
    const { mc, tiles } = await grid()
    await ticks(1)
    tiles.A.currentTime = 125
    tiles.B.currentTime = 60
    tiles.B.readyState = 2
    Object.assign(tiles.B, { seeking: true })
    await ticks(1)
    expect(tiles.B.currentTime).equals(60)
    await act(async () => {
      mc().goTo(T0 + 140_000)
    })
    expect(tiles.B.currentTime).equals(80)
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

  it('joins a follower whose speed does not close its gap', async function () {
    this.timeout(15_000)
    const { tiles } = await grid({}, {}, tiles => {
      fill(tiles.A, [100, 200])
      fill(tiles.B, [40, 140])
    })
    // B plays half a second behind A whatever speed it is given, as a
    // phone's player that ignores a small change of rate does.
    let seconds = 0
    const playOn = async (): Promise<void> => {
      seconds += 1
      tiles.A.currentTime = 120 + seconds
      if (!tiles.B.paused) tiles.B.currentTime = 60 + seconds - 0.5
      await ticks(1)
    }
    await playOn()
    expect(tiles.B.playbackRate, 'nudged first').greaterThan(1)
    let joined = false
    for (let look = 0; look < 8 && !joined; look++) {
      await playOn()
      joined = tiles.B.paused
    }
    expect(joined, 'sent ahead to join').equals(true)
    expect(tiles.B.playbackRate).equals(1)
    expect(tiles.B.currentTime).closeTo(60 + seconds + JOIN_LEAD_SEC, 1.1)
  })

  it('leaves a follower its speed is bringing back in step', async function () {
    this.timeout(15_000)
    const { tiles } = await grid({}, {}, tiles => {
      fill(tiles.A, [100, 200])
      fill(tiles.B, [40, 140])
    })
    let behind = 0.5
    for (let second = 1; second <= 9; second++) {
      tiles.A.currentTime = 120 + second
      tiles.B.currentTime = 60 + second - behind
      await ticks(1)
      // Its speed is honoured: a tenth of a second closed each second.
      behind = Math.max(0, behind - 0.1 * (tiles.B.playbackRate > 1 ? 1 : 0))
      expect(tiles.B.paused).equals(false)
    }
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

describe('useMultiCam bounded recovery', () => {
  for (const mode of ['stuck', 'browser', 'native'])
    it(`allows a slow follower join and bounds a stuck browser seek (${mode})`, async () => {
      const realNow = Date.now
      const realSet = globalThis.setInterval
      const realClear = globalThis.clearInterval
      let now = T0
      const intervals = new Map<unknown, () => void>()
      Date.now = () => now
      globalThis.setInterval = ((callback: () => void) => {
        const id = {}
        intervals.set(id, callback)
        return id
      }) as unknown as typeof setInterval
      globalThis.clearInterval = (id: unknown) => {
        if (!intervals.delete(id))
          realClear(id as Parameters<typeof clearInterval>[0])
      }
      try {
        const client = new TeamStationClient({ baseUrl: '/api/v1' })
        const requests: Record<string, number> = {}
        client.playback = async (id: string) => {
          requests[id] = (requests[id] ?? 0) + 1
          return {
            videoId: id,
            storage: 'spaces',
            url: `https://media/${id}-${requests[id]}.m3u8`,
            expiresAt: null,
            durationSec: null,
            unavailable: false
          }
        }
        const { mc, tiles } = await grid({ client })
        const tick = async (seconds: number): Promise<void> => {
          now = T0 + seconds * 1000
          tiles.A.currentTime = 120 + seconds
          await act(async () => {
            for (const callback of [...intervals.values()]) callback()
          })
        }
        await tick(1)
        tiles.B.currentTime = 58
        await tick(2)
        tiles.B.readyState = 2
        Object.assign(tiles.B, { seeking: true })
        let supervised = 0
        if (mode === 'native')
          Object.assign(tiles.B, {
            checkSeekTimeout: () => {
              supervised++
            }
          })
        const pendingUntil = mode === 'native' ? 145 : 45
        const landingAt = tiles.B.currentTime
        for (let second = 3; second <= pendingUntil; second++)
          await tick(second)
        expect(tiles.B.currentTime).equals(landingAt)
        expect(requests.B).equals(1)
        if (mode !== 'stuck') {
          // Landed, but the player says it is ready only a few seconds later.
          Object.assign(tiles.B, { seeking: false })
          for (let second = 1; second <= 3; second++)
            await tick(pendingUntil + second)
          expect(requests.B, 'a landed slow seek is kept').equals(1)
          tiles.B.readyState = 4
          let second = pendingUntil + 4
          for (; tiles.B.paused && second <= pendingUntil + 30; second++)
            await tick(second)
          expect(requests.B).equals(1)
          expect(tiles.B.paused).equals(false)
          if (mode === 'native') expect(supervised).greaterThan(100)
        } else {
          for (let second = 46; second <= 123; second++) await tick(second)
          expect(requests.B).equals(2)
          expect(mc().urls.B).contains('B-2')
        }
        expect(requests.A).equals(1)
        expect(tiles.A.paused).equals(false)
      } finally {
        await act(async () => root?.unmount())
        root = undefined
        Date.now = realNow
        globalThis.setInterval = realSet
        globalThis.clearInterval = realClear
      }
    })
})

describe('useMultiCam asking again for a tile left out too long', () => {
  it('asks for its address afresh, at longer and longer intervals, until it fills', async () => {
    const realNow = Date.now
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    let now = T0
    const intervals = new Map<unknown, () => void>()
    Date.now = () => now
    globalThis.setInterval = ((callback: () => void) => {
      const id = {}
      intervals.set(id, callback)
      return id
    }) as unknown as typeof setInterval
    globalThis.clearInterval = (id: unknown) => {
      if (!intervals.delete(id))
        realClear(id as Parameters<typeof clearInterval>[0])
    }
    try {
      const client = new TeamStationClient({ baseUrl: '/api/v1' })
      const requests: Record<string, number> = {}
      client.playback = async (id: string) => {
        requests[id] = (requests[id] ?? 0) + 1
        return {
          videoId: id,
          storage: 'spaces',
          url: `https://media/${id}-${requests[id]}.m3u8`,
          expiresAt: null,
          durationSec: null,
          unavailable: false
        }
      }
      const { mc, tiles } = await grid({ client }, {}, tiles => {
        fill(tiles.A, [120, 400])
        fill(tiles.B, [60, 340])
      })
      const at = async (seconds: number): Promise<void> => {
        now = T0 + seconds * 1000
        tiles.A.currentTime = 120 + seconds
        await act(async () => {
          for (const callback of [...intervals.values()]) callback()
        })
      }
      await at(1)
      // B's player is handed its source again while A plays: it is left out
      // until it fills, and its stream never gives it anything.
      const stale = new FakeTile()
      fill(stale)
      await act(async () => {
        mc().takeElement('B')(stale)
        mc().attached('B', stale, mc().attaching('B'))
      })
      expect(mc().tileWaiting('B')).equals(true)
      for (let second = 2; second <= 31; second++) await at(second)
      expect(requests.B, 'not yet').equals(1)
      await at(33)
      expect(requests.B).equals(2)
      expect(mc().urls.B).contains('B-2')
      // Then twice as long.
      for (let second = 34; second <= 90; second++) await at(second)
      expect(requests.B).equals(2)
      await at(94)
      expect(requests.B).equals(3)
      // Filled, it joins, and is asked for no more.
      fill(stale, [60, 340])
      stale.currentTime = 154
      await at(95)
      expect(mc().tileWaiting('B')).equals(false)
      for (let second = 96; second <= 400; second += 5) await at(second)
      expect(requests.B).equals(3)
      expect(requests.A).equals(1)
    } finally {
      await act(async () => root?.unmount())
      root = undefined
      Date.now = realNow
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
    }
  })
})

describe('useMultiCam on each tile’s own dates (U22)', function () {
  it('parks missing footage without showing a future frame and resumes after the gap', async function () {
    const { mc, tiles } = await grid({
      videos: [video('A', 0), video('B', 0)],
      order: ['A', 'B']
    })
    await act(async () => {
      mc().takeMapping('B')(
        fromFragments([
          { start: 0, duration: 100, programDateTime: T0 },
          { start: 100, duration: 400, programDateTime: T0 + 120_000 }
        ])
      )
      mc().goTo(T0 + 99_000)
    })
    expect(tiles.B.currentTime).closeTo(99, 0.01)
    const intended: number[] = []
    onExplicitSeek(tiles.B, seconds => intended.push(seconds))
    await act(async () => {
      mc().goTo(T0 + 110_000)
    })
    expect(intended, 'nothing sought for a gap').deep.equals([])
    expect(mc().tiles.B?.parked).equals('gap')
    expect(tiles.B.paused).equals(true)
    expect(tiles.B.currentTime, 'no seek into future footage').closeTo(99, 0.01)
    expect(tiles.A.currentTime).closeTo(110, 0.01)
    expect(tiles.A.paused).equals(false)
    await act(async () => {
      mc().goTo(T0 + 120_000)
    })
    expect(mc().tiles.B?.parked).equals(null)
    expect(tiles.B.currentTime).closeTo(100, 0.01)
    expect(tiles.B.paused).equals(false)
  })

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
    await until(() => mc().tiles.B?.parked === null, 5000)
    expect(mc().tiles.B?.parked ?? null).equals(null)
    expect(tiles.B.currentTime).greaterThan(140)
  })
  it('runs a live game’s bar from its first camera to the newest footage any angle has, and honors explicit seeks up to the footage every angle has', async function () {
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
          // The angles can have different available ends.
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
    // Explicit seeks reach the newest footage both angles have, B's 250 s,
    // not the opening cushion — and not A's 260 s, where B has nothing yet.
    await act(async () => {
      mc().goTo(T0 + 255_000)
    })
    expect(mc().atWallMs).equals(T0 + 250_000)
    // A drag released beyond the bar's far end lands there too.
    await act(async () => {
      mc().scrub(T0 + 260_000)
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    expect(mc().atWallMs).equals(T0 + 250_000)
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
    const { mc, tiles } = await grid(
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
    // Ten seconds on is honored even inside the opening cushion.
    await act(async () => {
      mc().goTo(T0 + 240_000)
    })
    expect(mc().atWallMs).equals(T0 + 240_000)
    // Back is still back.
    await act(async () => {
      mc().goTo(T0 + 220_000)
    })
    expect(mc().atWallMs).equals(T0 + 220_000)
    // Pictures decoded past the bar's end: a move forward stays where they are.
    for (const tile of Object.values(tiles)) tile.currentTime = 265
    await act(async () => {
      mc().goTo(T0 + 280_000)
    })
    expect(mc().atWallMs).equals(T0 + 265_000)
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
    // A move beyond available footage is capped at the displayed end.
    await act(async () => {
      mc().goTo(T0 + 300_000)
    })
    expect(mc().atWallMs).equals(T0 + 260_000)
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
    // A's available end, not B's stopped footage.
    expect(mc().atWallMs).equals(T0 + 260_000)
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
    // A's available end, not the unavailable angle's older footage.
    expect(mc().atWallMs).equals(T0 + 260_000)
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

describe("useMultiCam stopping at a highlight's end (U10)", function () {
  const look = async (ms = 400): Promise<void> => {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, ms))
    })
  }

  it('says once that the pictures have reached the end, and not before', async function () {
    let ends = 0
    const { tiles } = await grid({
      endAtMs: T0 + 125_000,
      onEndReached: () => {
        ends += 1
      }
    })
    tiles.A.currentTime = 124
    tiles.B.currentTime = 64
    await look()
    expect(ends).equals(0)
    tiles.A.currentTime = 125.3
    tiles.B.currentTime = 65.3
    await look()
    expect(ends).equals(1)
    tiles.A.currentTime = 126
    tiles.B.currentTime = 66
    await look()
    expect(ends).equals(1)
  })

  it('ends once per highlight, though its instant is worked out again', async function () {
    let ends = 0
    const { tiles, rerender } = await grid({
      endAtMs: T0 + 125_000,
      onEndReached: () => {
        ends += 1
      }
    })
    tiles.A.currentTime = 126
    tiles.B.currentTime = 66
    await look()
    expect(ends).equals(1)
    // The page worked its end out again, a little later.
    await rerender({ endAtMs: T0 + 125_400 })
    await look()
    expect(ends).equals(1)
    // Another highlight, once there was none: that one ends.
    await rerender({ endAtMs: null })
    await rerender({ endAtMs: T0 + 125_000 })
    await look()
    expect(ends).equals(2)
  })

  it('never stops a game opened without a highlight', async function () {
    let ends = 0
    const { tiles } = await grid({
      onEndReached: () => {
        ends += 1
      }
    })
    tiles.A.currentTime = 500
    tiles.B.currentTime = 440
    await look()
    expect(ends).equals(0)
  })

  it('lets the end go once the viewer seeks past it', async function () {
    let ends = 0
    const { mc, tiles } = await grid({
      endAtMs: T0 + 125_000,
      onEndReached: () => {
        ends += 1
      }
    })
    await act(async () => {
      mc().skip(10)
    })
    tiles.A.currentTime = 131
    tiles.B.currentTime = 71
    await look()
    expect(ends).equals(0)
  })

  it('keeps its end through a drag that passes it and lets go before it', async function () {
    let ends = 0
    const { mc, tiles } = await grid(
      {
        endAtMs: T0 + 125_000,
        onEndReached: () => {
          ends += 1
        }
      },
      { block: { x: 0, y: 0, w: WIDTH, h: HEIGHT } }
    )
    // A drag along the scrub row past the end, back to before it.
    await act(async () => {
      mc().scrub(T0 + 400_000, false)
      mc().scrub(T0 + 121_000, true)
    })
    tiles.A.currentTime = 126
    tiles.B.currentTime = 66
    await look()
    expect(ends).equals(1)
  })

  it('does not end while a drag along the line is held past it, nor after it lets go there', async function () {
    let ends = 0
    const { mc, tiles } = await grid(
      {
        endAtMs: T0 + 125_000,
        onEndReached: () => {
          ends += 1
        }
      },
      { block: { x: 0, y: 0, w: WIDTH, h: HEIGHT } }
    )
    mc().setTrackRect({ x: WIDTH * 0.1, y: 0, w: WIDTH * 0.8, h: 24 })
    const row = HEIGHT * 0.9
    await act(async () => {
      mc().pressStart(1, WIDTH * 0.5, row, 0)
      mc().pressMove(1, WIDTH * 0.5 + 20, row + 2)
      mc().pressMove(1, WIDTH * 0.7, row + 2)
    })
    // Held there, well past the end, with the pictures there too.
    tiles.A.currentTime = 495
    tiles.B.currentTime = 435
    await look()
    expect(ends, 'held').equals(0)
    await act(async () => {
      mc().pressEnd(1, WIDTH * 0.7, row)
    })
    await look()
    expect(ends, 'let go past it').equals(0)
  })

  for (const how of ['cancelled', 'taken over by a second finger'] as const)
    it(`does not end after a drag past it is ${how}`, async function () {
      let ends = 0
      const { mc, tiles } = await grid(
        {
          endAtMs: T0 + 125_000,
          onEndReached: () => {
            ends += 1
          }
        },
        { block: { x: 0, y: 0, w: WIDTH, h: HEIGHT } }
      )
      mc().setTrackRect({ x: WIDTH * 0.1, y: 0, w: WIDTH * 0.8, h: 24 })
      const row = HEIGHT * 0.9
      await act(async () => {
        mc().pressStart(1, WIDTH * 0.5, row, 0)
        mc().pressMove(1, WIDTH * 0.5 + 20, row + 2)
        mc().pressMove(1, WIDTH * 0.7, row + 2)
      })
      tiles.A.currentTime = 495
      tiles.B.currentTime = 435
      await act(async () => {
        if (how === 'cancelled') mc().pressCancel(1)
        else mc().pressStart(2, WIDTH * 0.5, HEIGHT * 0.5, 0)
      })
      await look()
      expect(ends).equals(0)
    })

  it('ends with the recordings when they all stop before it', async function () {
    this.timeout(8000)
    let ends = 0
    const { mc, tiles } = await grid({
      endAtMs: T0 + 900_000,
      onEndReached: () => {
        ends += 1
      }
    })
    for (const tile of Object.values(tiles)) {
      tile.ended = true
      tile.paused = true
    }
    for (let round = 0; round < 25 && !mc().ended; round++) await look(200)
    await look()
    expect(ends).equals(1)
  })
})
