import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { OnLoadData, VideoRef } from 'react-native-video'

import {
  asVideoSummary,
  TeamStationClient,
  type VideoSummary
} from '../../../common/api'
import type { WallAnchor } from '../../../common/wallTimeline'
import { ThemeProvider } from '../../theme/ThemeContext'
import { NativeVideoHandle } from '../nativeVideoHandle'
import { SLOW_RATE } from '../slowMotion'
import type { VideoEventName } from '../videoHandle'
import type { AngleVideo } from '../wallClock'
import {
  fromAnchors,
  fromFragments,
  MAPPING_WAIT_MS,
  type WallMapping
} from '../wallMapping'
import {
  JOIN_LEAD_SEC,
  LANDING_MS,
  LIVE_OPEN_WAIT_MS,
  nudgeRate,
  SEEKABLE_SLACK_SEC,
  WATCHDOG_MS
} from './align'
import { tileRects } from './layout'
import {
  acrossHole,
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
  volume = 1
  playbackRate = 1
  readyState = 4
  videoWidth = 1920
  videoHeight = 1080
  ended = false
  /** Left unset, the tile does not say how much it holds, as on a phone. */
  buffered?: TileHandle['buffered']
  seekable?: TileHandle['seekable']
  seeking?: boolean
  networkState?: number
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
  before: (tiles: Record<string, FakeTile>) => void = () => undefined,
  /** The tiles handed over, by angle. */
  ids: string[] = ['A', 'B']
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
  const tiles: Record<string, FakeTile> = Object.fromEntries(
    ids.map(id => [id, new FakeTile()])
  )
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

  it('sets the game’s volume under a reel on the heard tile only, and follows the heard angle (U27)', async function () {
    const { mc, tiles, rerender } = await grid()
    expect(mc().heardId).equals('A')
    await act(async () => {
      mc().setGameVolume(0.2)
    })
    expect([tiles.A.volume, tiles.B.volume]).deep.equals([0.2, 1])
    expect(mc().gameVolumeSettable()).equals(true)
    // The sound moved mid-reel: the angle heard now is at the game's volume
    // at once, and the one left is at full again.
    await rerender({ audioId: 'B' })
    expect([tiles.A.volume, tiles.B.volume]).deep.equals([1, 0.2])
    await act(async () => {
      mc().setGameVolume(0.6)
    })
    expect([tiles.A.volume, tiles.B.volume]).deep.equals([1, 0.6])
    await rerender({ audioId: 'A' })
    expect([tiles.A.volume, tiles.B.volume]).deep.equals([0.6, 1])
    await act(async () => {
      mc().setGameVolume(1)
    })
    expect([tiles.A.volume, tiles.B.volume]).deep.equals([1, 1])
    await rerender({ audioId: 'B' })
    expect(mc().gameVolumeSettable()).equals(true)
    // A tile that reads back 1 whatever it is told, as iOS Safari's does.
    Object.defineProperty(tiles.B, 'volume', {
      get: () => 1,
      set: () => undefined,
      configurable: true
    })
    // Known settable already: asked once a tile.
    expect(mc().gameVolumeSettable()).equals(true)
    expect(mc().gameDucked).equals(false)
    await act(async () => {
      mc().setGameDucked(true)
    })
    expect(mc().gameDucked).equals(true)
  })

  it('finds a heard tile whose volume cannot be set (U27)', async function () {
    const { mc, tiles } = await grid()
    Object.defineProperty(tiles.A, 'volume', {
      get: () => 1,
      set: () => undefined,
      configurable: true
    })
    expect(mc().gameVolumeSettable()).equals(false)
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

  it('lets a running camera coast after a seek that landed on an earlier frame', async function () {
    const { mc, tiles } = await grid()
    let now = Date.now()
    const wall = mock.method(Date, 'now', () => now)
    const clock = mock.method(performance, 'now', () => now)
    mock.timers.enable({ apis: ['setTimeout'] })
    let writes = 0
    Object.defineProperty(tiles.B, 'currentTime', {
      get: () => 5,
      set: () => {
        writes++
      }
    })
    try {
      await act(async () => {
        mc().pressStart(1, WIDTH * 0.9, HEIGHT / 2, 0)
        now += 2000
        mock.timers.tick(500)
      })
      expect(writes).equals(1)
      await act(async () => {
        for (let i = 0; i < 120; i++) {
          now += 250
          mock.timers.tick(250)
        }
        mc().pressEnd(1, WIDTH * 0.9, HEIGHT / 2)
      })
      expect(writes).equals(1)
      // A new explicit seek remains a user command.
      await act(async () => {
        mc().goTo(T0 + 250_000)
      })
      expect(writes).equals(2)
    } finally {
      clock.mock.restore()
      wall.mock.restore()
      mock.timers.reset()
    }
  })

  for (const duration of [5000, 30000]) {
    it(`restores both saved rates after a ${duration} ms hold and handles the next tap`, async function () {
      const { mc, tiles } = await grid()
      tiles.A.playbackRate = 0.98
      tiles.B.playbackRate = 1.02
      let now = 0
      const clock = mock.method(performance, 'now', () => now)
      mock.timers.enable({ apis: ['setTimeout'] })
      const x = WIDTH * 0.9
      const y = HEIGHT / 2
      try {
        await act(async () => {
          mc().pressStart(1, x, y, 0)
          mock.timers.tick(500)
        })
        expect(tiles.A.playbackRate).equals(SLOW_RATE)
        const from = mc().atWallMs!
        // B's player is still landing an earlier seek. Its stale report must
        // not send it on the same seek again while the viewer holds.
        tiles.B.seeking = true
        let reads = 0
        let writes = 0
        Object.defineProperty(tiles.B, 'currentTime', {
          get: () => {
            reads++
            return 5
          },
          set: () => {
            writes++
          }
        })
        await act(async () => {
          for (now = 250; now <= duration - 500; now += 250) {
            mc().pressMove(1, x + 1, y)
            mock.timers.tick(250)
          }
        })
        expect(reads).lessThan((duration / 250) * 5)
        expect(writes).equals(0)
        // The final fraction of a delayed tick still belongs to the hold.
        now = duration - 500 + 73
        await act(async () => {
          expect(mc().pressEnd(1, x, y)).equals('held')
        })
        expect(mc().atWallMs).closeTo(from + now * SLOW_RATE, 0.01)
        expect([tiles.A.playbackRate, tiles.B.playbackRate]).deep.equals([
          0.98, 1.02
        ])
        expect(mc().slow).equals(0)
        await act(async () => {
          expect(mc().pressStart(2, WIDTH / 2, y, 0)).equals(true)
          expect(mc().pressEnd(2, WIDTH / 2, y)).equals('pending')
        })
        expect(mc().playing).equals(false)
        await act(async () => {
          mock.timers.tick(1000)
        })
        expect(mc().slow).equals(0)
      } finally {
        clock.mock.restore()
        mock.timers.reset()
      }
    })
  }

  it('keeps a replaced camera’s saved rate and restores a newly attached camera on cancellation', async function () {
    const { mc, tiles } = await grid()
    tiles.A.playbackRate = 1.04
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const replacement = new FakeTile()
      const arriving = new FakeTile()
      arriving.playbackRate = 0.96
      await act(async () => {
        mc().pressStart(1, WIDTH * 0.9, HEIGHT / 2, 0)
        mock.timers.tick(500)
        mc().takeElement('A')(null)
        mc().takeElement('A')(replacement)
        mc().takeElement('C')(arriving)
      })
      expect([replacement.playbackRate, arriving.playbackRate]).deep.equals([
        SLOW_RATE,
        SLOW_RATE
      ])
      expect(arriving.muted).equals(true)
      await act(async () => {
        mc().pressCancel(1)
      })
      expect([replacement.playbackRate, arriving.playbackRate]).deep.equals([
        1.04, 0.96
      ])
      expect(replacement.muted).equals(false)
    } finally {
      mock.timers.reset()
    }
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
      /^A {8} buf 3\.0s {2}ready 4 {2}at 120\.0 {2}to 120\.0 {2}end — {2}paused {2}ok {2}short \d+(\.\d)?s/
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

  it('a tile’s readout line carries its seekable end, network state and seeking', async function () {
    this.timeout(5000)
    const { mc } = await grid({}, { debug: true }, tiles => {
      fill(tiles.A, [120, 123])
      fill(tiles.B, [60, 70])
      tiles.A.seekable = { length: 1, end: () => 760 }
      tiles.A.networkState = 2
      tiles.A.seeking = true
    })
    await ticks(1)
    const [a, b] = mc().readout
    expect(a).match(
      / {2}to 120\.0 {2}end 760\.0 {2}net 2 {2}seeking {2}paused /
    )
    // A phone's tile says no network state, and one not seeking says nothing of it.
    expect(b).match(/ {2}end — {2}paused /)
    expect(b).not.match(/net |seeking/)
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
    await until(() => mc().tiles.B?.parked === null, 5000)
    expect(mc().tiles.B?.parked ?? null).equals(null)
    expect(tiles.B.currentTime).greaterThan(140)
  })
  it('puts back a phone tile whose player went quiet while it waited, once its timeline has the moment past a hole', async function () {
    this.timeout(10_000)
    // B's camera was away for 64 s after its first 100 s: its media goes on
    // from 100 s at T0 + 164 s.
    const holed = (after: number): WallMapping =>
      fromFragments([
        ...Array.from({ length: 25 }, (unused, index) => ({
          start: index * 4,
          duration: 4,
          programDateTime: T0 + index * 4000
        })),
        ...Array.from({ length: after / 4 }, (unused, index) => ({
          start: 100 + index * 4,
          duration: 4,
          programDateTime: T0 + 164_000 + index * 4000
        }))
      ])
    const held: Record<string, WallMapping> = { A: dated(400), B: holed(0) }
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
        fill(tiles.A, [100, 400])
        Object.assign(tiles.A, { seekable: { length: 1, end: () => 400 } })
        // An iPhone's player: no seekable or buffered ranges, only the end
        // it last reported, short of the hole, and nothing more while it is
        // paused.
        Object.assign(tiles.B, { seekableEnd: 92, seekableQuiet: true })
        tiles.B.currentTime = 92
      }
    )
    await ticks(2)
    expect(mc().tiles.B?.parked).equals('notYet')
    expect(tiles.A.paused).equals(false)

    // The camera is back: the server's timeline goes on past the hole, while
    // B's player, paused, still says 92 s.
    held.B = holed(100)
    await until(() => mc().tiles.B?.parked === null, 5000)
    expect(mc().tiles.B?.parked ?? null).equals(null)
    // Sent to the first picture after the hole, or just ahead of it.
    expect(tiles.B.currentTime).within(100, 100 + JOIN_LEAD_SEC)
    expect(mc().waiting).equals(false)
  })

  it('keeps a quiet phone tile waiting while its timeline has no newer footage either', async function () {
    this.timeout(10_000)
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
        Object.assign(tiles.B, { seekableEnd: 92, seekableQuiet: true })
        tiles.B.currentTime = 92
      }
    )
    await ticks(3)
    expect(mc().tiles.B?.parked).equals('notYet')
    expect(tiles.B.currentTime, 'never sought').equals(92)
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

  describe('across a hole in a phone tile’s own recording', function () {
    /**
     * Four-second fragments from the take's start, `totalSec` of them in
     * all, with the camera away for `holeSec` after `holeAtSec`: its media
     * goes on from there `holeSec` later on the wall.
     */
    const holedAt = (
      holeAtSec: number,
      holeSec: number,
      totalSec: number
    ): WallMapping =>
      fromFragments(
        Array.from({ length: totalSec / 4 }, (unused, index) => ({
          start: index * 4,
          duration: 4,
          programDateTime:
            T0 + index * 4000 + (index * 4 >= holeAtSec ? holeSec * 1000 : 0)
        }))
      )

    /**
     * An iPhone tile: a `NativeVideoHandle` in front of a player that acts
     * as react-native-video's on iOS does. Props arrive a moment after they
     * are set; a seek lands a moment after it is sent and restores the
     * player's paused prop; progress is reported every quarter second, and
     * only while the picture moves. And `setRate` away from a rate other
     * than 1 first sets the AVPlayer's rate to 1 — which plays it — and only
     * a tenth of a second later puts the paused prop back, so a paused tile
     * whose rate the grid puts back to 1 plays for that tenth and says so.
     *
     * A seek empties its buffer, and AVPlayer says it is likely to keep up
     * again a quarter second after it is played, but paused only once it has
     * filled at its leisure, `pausedFillMs` later: until then the handle
     * reads it as short (`readyState` 2), and its picture does not move.
     *
     * `android` makes it a Pixel's instead: ExoPlayer reports progress while
     * paused too, fills its buffer paused as it does playing, and changes its
     * rate without playing. Either way it plays no further than the footage
     * it can reach, a live stream's edge.
     */
    const phone = (
      seekableEnd: () => number,
      options: { android?: boolean } = {}
    ): { handle: NativeVideoHandle; at: () => number; stop: () => void } => {
      const android = options.android === true
      const pausedFillMs = android ? 250 : 4000
      let at = 0
      let filled = true
      let fills = 0
      let nativePaused = true
      let nativeRate = 1
      let avRate = 0
      let sentPaused = true
      let sentRate = 1
      const timers = new Set<ReturnType<typeof setTimeout>>()
      const later = (ms: number, run: () => void): void => {
        const timer = setTimeout(() => {
          timers.delete(timer)
          run()
        }, ms)
        timers.add(timer)
      }
      /** Fills in `ms`; played to fill, only if it is still playing then. */
      const fillIn = (ms: number, playingToFill: boolean): void => {
        const fill = fills
        later(ms, () => {
          if (filled || fill !== fills || (playingToFill && avRate === 0)) {
            return
          }
          filled = true
          handle.handleBuffer({ isBuffering: false })
        })
      }
      const setAv = (rate: number): void => {
        const was = avRate > 0
        avRate = rate
        if (was === rate > 0) return
        if (rate > 0 && !filled) fillIn(250, true)
        later(10, () => {
          handle.handlePlaybackState({ isPlaying: rate > 0, isSeeking: false })
        })
      }
      const setPaused = (paused: boolean): void => {
        setAv(paused ? 0 : nativeRate)
        nativePaused = paused
      }
      const setRate = (rate: number): void => {
        if (nativeRate === 1 || android) {
          nativeRate = rate
          setPaused(nativePaused)
          return
        }
        setAv(1)
        later(100, () => {
          nativeRate = rate
          setPaused(nativePaused)
        })
      }
      const handle: NativeVideoHandle = new NativeVideoHandle(() => {
        later(30, () => {
          const { paused, rate } = handle.props
          if (paused !== sentPaused) {
            sentPaused = paused
            setPaused(paused)
          }
          if (rate !== sentRate) {
            sentRate = rate
            setRate(rate)
          }
        })
      })
      handle.attach({
        seek: (to: number) => {
          if (!nativePaused) setAv(0)
          fills += 1
          filled = false
          later(10, () => {
            handle.handleBuffer({ isBuffering: true })
          })
          if (avRate > 0) fillIn(250, true)
          fillIn(pausedFillMs, false)
          later(150, () => {
            // No further than the footage it can reach, a live stream's edge.
            at = Math.min(to, seekableEnd())
            setPaused(nativePaused)
            handle.handleSeek({ currentTime: to, seekTime: to })
          })
        },
        resume: () => {
          setPaused(false)
        },
        pause: () => {
          setPaused(true)
        },
        setSource: () => undefined
      } as unknown as VideoRef)
      handle.handleLoad({
        duration: 0,
        currentTime: 0,
        naturalSize: { width: 1920, height: 1080, orientation: 'landscape' }
      } as unknown as OnLoadData)
      handle.handleReadyForDisplay()
      const report = (): void => {
        handle.handleProgress({
          currentTime: at,
          seekableDuration: seekableEnd(),
          playableDuration: at + 10
        })
      }
      report()
      let last = Date.now()
      let unreported = 0
      const ticker = setInterval(() => {
        const now = Date.now()
        const moving = avRate > 0 && filled && at < seekableEnd()
        if (moving) {
          at = Math.min(at + ((now - last) / 1000) * avRate, seekableEnd())
        }
        if (moving || android) {
          unreported += now - last
          if (unreported >= 250) {
            unreported = 0
            report()
          }
        }
        last = now
      }, 20)
      return {
        handle,
        at: () => at,
        stop: () => {
          clearInterval(ticker)
          for (const timer of timers) clearTimeout(timer)
        }
      }
    }

    /**
     * A plays the game; B, an iPhone tile, has an 8 s hole after its first
     * 100 s. Runs the grid from `fromSec` into the game until A's clock is
     * at `untilSec`, and says how far ahead of A's picture B's has been, on
     * the wall, at any look once the clock was past the hole, and how long
     * after the clock reached B's first picture after the hole B's picture
     * began to move (null if it never did).
     */
    const across = async (options: {
      fromSec: number
      untilSec: number
      /** B's footage so far, in its own seconds, until the clock passes `backAtSec`. */
      footageSec?: number
      backAtSec?: number
      /** Asked for the game's own moment just as B starts, a moment before its picture. */
      askOnStart?: boolean
    }): Promise<{
      aheadMs: number
      startMs: number | null
      /** How often B was paused again once played near its far side, before the clock was 1 s past it. */
      pausedAgain: number
      mc: () => MultiCam
    }> => {
      const { footageSec, backAtSec } = options
      const held: Record<string, WallMapping> = {
        A: dated(400),
        B: holedAt(100, 8, footageSec ?? 400)
      }
      let footageEnd = footageSec ?? 400
      const B = phone(() => footageEnd)
      const A = new FakeTile()
      let aheadMs = 0
      let startMs: number | null = null
      let pausedAgain = 0
      let played = false
      let mcOf: (() => MultiCam) | undefined
      const play = B.handle.play.bind(B.handle)
      B.handle.play = async () => {
        const clock = held.A.wallAt(A.currentTime) ?? 0
        if (!played && clock >= T0 + 107_000 && clock < T0 + 108_000) {
          played = true
          // A look in the moment between its start and its picture.
          if (options.askOnStart === true) {
            setTimeout(
              () => mcOf?.().scrub(held.A.wallAt(A.currentTime) ?? 0),
              0
            )
          }
        }
        await play()
      }
      const pause = B.handle.pause.bind(B.handle)
      B.handle.pause = () => {
        const clock = held.A.wallAt(A.currentTime) ?? 0
        if (played && clock < T0 + 109_000) pausedAgain += 1
        pause()
      }
      let ticker: ReturnType<typeof setInterval> | undefined
      try {
        const { mc } = await grid(
          {
            videos: [liveVideo('A', 0), liveVideo('B', 0)],
            order: ['A', 'B'],
            atMs: T0 + options.fromSec * 1000
          },
          { fallbackMapping: id => held[id] ?? null },
          tiles => {
            A.duration = Number.POSITIVE_INFINITY
            fill(A, [0, 400])
            Object.assign(A, { seekable: { length: 1, end: () => 400 } })
            Object.assign(tiles, { A, B: B.handle })
          }
        )
        mcOf = mc
        let last = Date.now()
        let bWas = B.at()
        ticker = setInterval(() => {
          const now = Date.now()
          if (!A.paused) A.currentTime += ((now - last) / 1000) * A.playbackRate
          last = now
          // Moving, not sent somewhere by a seek, once the game is near the
          // far side of the hole, at 108 s on the wall.
          const step = B.at() - bWas
          bWas = B.at()
          const clock = held.A.wallAt(A.currentTime) ?? 0
          if (
            startMs == null &&
            clock >= T0 + 107_000 &&
            step > 0 &&
            step < 0.2
          ) {
            startMs = clock - (T0 + 108_000)
          }
        }, 20)
        for (let looks = 0; looks < 60; looks++) {
          const clock = held.A.wallAt(A.currentTime) ?? 0
          if (clock >= T0 + options.untilSec * 1000) break
          if (backAtSec != null && clock > T0 + backAtSec * 1000) {
            // The camera is back: the timeline goes on past the hole.
            held.B = holedAt(100, 8, 400)
            footageEnd = 400
          }
          await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 500))
          })
          const a = held.A.wallAt(A.currentTime) ?? 0
          const b = held.B.wallAt(B.at()) ?? 0
          if (a > T0 + 109_000) aheadMs = Math.max(aheadMs, b - a)
        }
        return { aheadMs, startMs, pausedAgain, mc }
      } finally {
        clearInterval(ticker)
        B.stop()
      }
    }

    it('keeps a phone tile that played into a hole at its far side until the game gets there', async function () {
      this.timeout(30_000)
      // B plays up to its hole and over it, on its own, a picture 8 s on;
      // brought back by speed and then made to wait, the rate it is given
      // back starts its player.
      const { aheadMs, mc } = await across({ fromSec: 96, untilSec: 113 })
      expect(aheadMs, 'B ahead of the game, ms').lessThan(1000)
      expect(mc().tiles.B?.parked ?? null).equals(null)
    })

    it('starts a phone tile waiting at the far side of its hole as the game gets there', async function () {
      this.timeout(30_000)
      // B, paused at its first picture after the hole, has filled its
      // buffer there long before the game arrives. Sent on from there to
      // join, an iPhone's player empties its buffer and, paused, says it is
      // ready only seconds later: the join, waiting on that, missed the game
      // and tried again further on, and B stood still for ten seconds.
      const { aheadMs, startMs, mc } = await across({
        fromSec: 96,
        untilSec: 122
      })

      expect(startMs, 'B starts, ms after the game reaches it').not.equals(null)
      expect(startMs ?? 0, 'B starts, ms after the game reaches it').lessThan(
        2000
      )
      expect(aheadMs, 'B ahead of the game, ms').lessThan(1000)
      expect(mc().tiles.B?.parked ?? null).equals(null)
    })

    it('leaves a phone tile started a moment before its far-side picture playing', async function () {
      this.timeout(30_000)
      // It starts START_LEAD_MS before the game reaches its picture; a look
      // in that moment still found the game inside its hole and held it again.
      const { startMs, pausedAgain } = await across({
        fromSec: 96,
        untilSec: 112,
        askOnStart: true
      })
      expect(startMs, 'B starts').not.equals(null)
      expect(pausedAgain, 'B paused again once started').equals(0)
    })

    it('sends a new player for a tile waiting at its far side there too', async function () {
      const held: Record<string, WallMapping> = {
        A: dated(400),
        B: holedAt(100, 8, 400)
      }
      const { mc, tiles } = await grid(
        {
          videos: [liveVideo('A', 0), liveVideo('B', 0)],
          order: ['A', 'B'],
          atMs: T0 + 90_000
        },
        { fallbackMapping: id => held[id] ?? null },
        given => {
          given.A.duration = Number.POSITIVE_INFINITY
          fill(given.A, [0, 400])
          Object.assign(given.A, { seekable: { length: 1, end: () => 400 } })
        }
      )
      await act(async () => {
        mc().scrub(T0 + 103_000)
      })
      expect(tiles.B.currentTime, 'B at its far side').closeTo(100, 0.5)
      // Its player is replaced, as a remount does: the new one starts at 0.
      const fresh = new FakeTile()
      await act(async () => {
        mc().takeElement('B')(fresh)
        mc().attached('B', fresh, mc().attaching('B'))
      })
      await act(async () => {
        mc().scrub(T0 + 103_500)
      })
      expect(fresh.currentTime, 'the new player at the far side').closeTo(
        100,
        0.5
      )
    })

    it('starts only the tile the game goes on from, when two wait at the far sides of their holes', async function () {
      this.timeout(20_000)
      // A is back 30 s after its hole begins, B 40 s after: the game goes on
      // from A's return, and B waits for it there.
      const held: Record<string, WallMapping> = {
        A: holedAt(100, 30, 400),
        B: holedAt(100, 40, 400)
      }
      const { mc, tiles } = await grid(
        {
          videos: [liveVideo('A', 0), liveVideo('B', 0)],
          order: ['A', 'B'],
          atMs: T0 + 90_000
        },
        { fallbackMapping: id => held[id] ?? null },
        given => {
          for (const tile of [given.A, given.B]) {
            tile.duration = Number.POSITIVE_INFINITY
            fill(tile, [0, 400])
            Object.assign(tile, { seekable: { length: 1, end: () => 400 } })
          }
        }
      )
      let last = Date.now()
      let bAhead = 0
      const ticker = setInterval(() => {
        const now = Date.now()
        for (const tile of [tiles.A, tiles.B]) {
          if (!tile.paused) {
            tile.currentTime += ((now - last) / 1000) * tile.playbackRate
          }
        }
        last = now
        const a = held.A.wallAt(tiles.A.currentTime) ?? 0
        const b = held.B.wallAt(tiles.B.currentTime) ?? 0
        if (!tiles.A.paused && !tiles.B.paused) bAhead = Math.max(bAhead, b - a)
      }, 20)
      try {
        await act(async () => {
          mc().scrub(T0 + 110_000)
        })
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 4000))
        })
        expect(tiles.A.paused, 'A carries the game').equals(false)
        expect(tiles.B.paused, 'B waits for the game at its return').equals(
          true
        )
        expect(bAhead, 'B ahead of A, ms').lessThan(1000)
      } finally {
        clearInterval(ticker)
      }
    })

    // B's live edge before A's hole and after it: either way the game holds
    // where the footage ends, A's own up to its hole, B's past it.
    for (const edge of [96, 108])
      it(`does not carry the game past a hole while another camera’s footage is still on its way (edge ${edge} s)`, async function () {
        this.timeout(40_000)
        // A is away from 100 s to 130 s. B is recording, its newest footage
        // at \`edge\`: at its live edge, the moment past it is B's, only not
        // here yet. The game was carried to A's return over it, and the
        // healthy cameras waited at their edge for footage that did not
        // exist yet (Chrome's stream cuts).
        const held: Record<string, WallMapping> = {
          A: holedAt(100, 30, 400),
          B: dated(edge)
        }
        const { mc, tiles } = await grid(
          {
            videos: [liveVideo('A', 0), liveVideo('B', 0)],
            order: ['A', 'B'],
            atMs: T0 + 90_000
          },
          { fallbackMapping: id => held[id] ?? null },
          given => {
            given.A.duration = Number.POSITIVE_INFINITY
            fill(given.A, [0, 400])
            Object.assign(given.A, { seekable: { length: 1, end: () => 400 } })
            given.B.duration = Number.POSITIVE_INFINITY
            fill(given.B, [0, edge])
            Object.assign(given.B, { seekable: { length: 1, end: () => edge } })
          }
        )
        let last = Date.now()
        const ticker = setInterval(() => {
          const now = Date.now()
          for (const [tile, end] of [
            [tiles.A, 400],
            [tiles.B, edge]
          ] as const) {
            if (!tile.paused) {
              tile.currentTime = Math.min(
                end,
                tile.currentTime + ((now - last) / 1000) * tile.playbackRate
              )
            }
          }
          last = now
        }, 20)
        try {
          await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 20_000))
          })
          // It waits where the footage ends; it does not leap the hole.
          expect(
            (mc().wallNow() ?? 0) - T0,
            'the game, ms into the take'
          ).closeTo(Math.max(edge, 100) * 1000, 1500)
          expect(tiles.A.paused, 'A waits at its far side').equals(true)
          expect(tiles.A.currentTime).closeTo(100, 0.5)
        } finally {
          clearInterval(ticker)
        }
      })

    it('does not run a quiet phone tile let go inside its hole ahead of the game', async function () {
      this.timeout(30_000)
      // B reaches the end of its footage at its hole and waits there, quiet;
      // the camera comes back while the clock is inside the hole.
      const { aheadMs, mc } = await across({
        fromSec: 99,
        untilSec: 114,
        footageSec: 100,
        backAtSec: 102
      })
      expect(aheadMs, 'B ahead of the game, ms').lessThan(1000)
      expect(mc().tiles.B?.parked ?? null).equals(null)
    })

    /**
     * The camera's stream away for 16 s of the wall from 100 s, while the
     * viewer watches 10 s behind live: the stream is back, at the live edge,
     * when the clock is at 106 s, inside the hole, and B's first picture
     * after the hole, at 116 s on the wall, grows from there in real time.
     * Runs the grid from 88 s until the clock is at 122 s, and says when B's
     * picture began to move, once the clock was near 116 s, and how far
     * ahead of the game it has been since.
     */
    const liveReturn = async (
      kind: 'ios' | 'android' | 'web'
    ): Promise<{ aheadMs: number; startMs: number | null }> => {
      const fromSec = 88
      const lagSec = 10
      const holeAtSec = 100
      const holeSec = 16
      const backWallSec = holeAtSec + holeSec
      /** B's footage, in its own seconds, at this live instant of the wall. */
      const footageAt = (liveSec: number): number =>
        liveSec < holeAtSec ? liveSec : Math.max(holeAtSec, liveSec - holeSec)
      /** B's mapping, with what it has written by then. */
      const mappingAt = (footageSec: number): WallMapping =>
        fromFragments(
          Array.from(
            { length: Math.ceil(footageSec / 2) },
            (unused, index) => ({
              start: index * 2,
              duration: Math.min(2, footageSec - index * 2),
              programDateTime:
                T0 +
                index * 2000 +
                (index * 2 >= holeAtSec ? holeSec * 1000 : 0)
            })
          )
        )
      const A = new FakeTile()
      const aMapping = dated(400)
      const clockSec = (): number =>
        ((aMapping.wallAt(A.currentTime) ?? T0) - T0) / 1000
      const footage = (): number => footageAt(clockSec() + lagSec)
      const held: Record<string, WallMapping> = {
        A: aMapping,
        B: mappingAt(footageAt(fromSec + lagSec))
      }
      const web = new FakeTile()
      const native =
        kind === 'web' ? null : phone(footage, { android: kind === 'android' })
      const B = native?.handle ?? web
      const bAt = (): number => native?.at() ?? web.currentTime
      if (kind === 'web') {
        web.duration = Number.POSITIVE_INFINITY
        Object.defineProperty(web, 'buffered', {
          get: () => ({ length: 1, start: () => 0, end: () => footage() })
        })
        Object.assign(web, { seekable: { length: 1, end: () => footage() } })
      }
      let aheadMs = 0
      let startMs: number | null = null
      let ticker: ReturnType<typeof setInterval> | undefined
      try {
        await grid(
          {
            videos: [liveVideo('A', 0), liveVideo('B', 0)],
            order: ['A', 'B'],
            atMs: T0 + fromSec * 1000
          },
          { fallbackMapping: id => held[id] ?? null },
          tiles => {
            A.duration = Number.POSITIVE_INFINITY
            fill(A, [0, 400])
            Object.assign(A, { seekable: { length: 1, end: () => 400 } })
            Object.assign(tiles, { A, B })
          }
        )
        let last = Date.now()
        let bWas = bAt()
        ticker = setInterval(() => {
          const now = Date.now()
          const dt = (now - last) / 1000
          last = now
          if (!A.paused) A.currentTime += dt * A.playbackRate
          if (kind === 'web' && !web.paused) {
            web.currentTime = Math.min(
              web.currentTime + dt * web.playbackRate,
              Math.max(web.currentTime, footage())
            )
          }
          held.B = mappingAt(footage())
          const step = bAt() - bWas
          bWas = bAt()
          const clock = clockSec()
          if (
            startMs == null &&
            clock >= backWallSec - 1 &&
            step > 0 &&
            step < 0.2
          ) {
            startMs = (clock - backWallSec) * 1000
          }
          const b = held.B.wallAt(bAt())
          if (clock > backWallSec + 1 && b != null) {
            aheadMs = Math.max(aheadMs, b - (T0 + clock * 1000))
          }
        }, 20)
        for (let looks = 0; looks < 90 && clockSec() < 122; looks++) {
          await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 500))
          })
        }
        return { aheadMs, startMs }
      } finally {
        clearInterval(ticker)
        native?.stop()
      }
    }

    for (const kind of ['ios', 'android', 'web'] as const) {
      it(`starts a ${kind} tile whose stream came back inside the viewer's hole as the game reaches its return`, async function () {
        this.timeout(60_000)
        // Before, B was sent on from its far side to join: an iPhone's,
        // paused, said it was ready there only seconds later, and the join
        // went further on each time it found it not; the others waited out
        // the join's own lead. Within a second now, and not early.
        const { aheadMs, startMs } = await liveReturn(kind)
        expect(startMs, 'B starts, ms after the game reaches it').not.equals(
          null
        )
        expect(startMs ?? 0, 'B starts, ms after the game reaches it')
          .lessThan(1000)
          .greaterThan(-500)
        expect(aheadMs, 'B ahead of the game, ms').lessThan(1000)
      })
    }
  })
})

describe('useMultiCam with one live angle on Safari’s own player', function () {
  /**
   * Safari's own player on a live stream: a seek lands `offSec` from where
   * it was sent — a segment's worth either way — a quarter second later,
   * and says it is seeking meanwhile. It plays no further than the live
   * edge, which grows as the clock on the wall does.
   */
  const safari = (
    offSec: number,
    edge: () => number
  ): { tile: FakeTile; stop: () => void } => {
    const tile = new FakeTile()
    tile.duration = Number.POSITIVE_INFINITY
    let at = 0
    let seeking = false
    let landing: ReturnType<typeof setTimeout> | undefined
    Object.defineProperty(tile, 'currentTime', {
      get: () => at,
      set: (to: number) => {
        clearTimeout(landing)
        at = to
        seeking = true
        landing = setTimeout(() => {
          at = Math.max(0, Math.min(to + offSec, edge()))
          seeking = false
        }, 250)
      }
    })
    Object.defineProperty(tile, 'seeking', { get: () => seeking })
    Object.assign(tile, { seekable: { length: 1, end: () => edge() } })
    Object.defineProperty(tile, 'buffered', {
      get: () => ({ length: 1, start: () => 0, end: () => edge() })
    })
    let last = Date.now()
    const ticker = setInterval(() => {
      const now = Date.now()
      if (!tile.paused && !seeking) {
        at = Math.min(at + ((now - last) / 1000) * tile.playbackRate, edge())
      }
      last = now
    }, 20)
    return {
      tile,
      stop: () => {
        clearInterval(ticker)
        clearTimeout(landing)
      }
    }
  }

  /**
   * One live angle, A, at the take's start, with its newest footage
   * `edgeSec` in and growing, placed by the server's timeline `anchors`;
   * its player a Safari one whose seeks land `offSec` off. Opens at
   * `fromSec` into the take and plays.
   */
  const alone = async (options: {
    anchors: WallAnchor[]
    edgeSec: number
    fromSec: number
    offSec: number
  }): Promise<{
    mc: () => MultiCam
    tile: FakeTile
    stop: () => void
  }> => {
    const began = Date.now()
    const edge = (): number => options.edgeSec + (Date.now() - began) / 1000
    const mapping = fromAnchors(options.anchors, edge)
    const { tile, stop } = safari(options.offSec, edge)
    const { mc } = await grid(
      {
        videos: [liveVideo('A', 0)],
        order: ['A'],
        audioId: 'A',
        atMs: T0 + options.fromSec * 1000
      },
      { fallbackMapping: id => (id === 'A' ? mapping : null) },
      tiles => {
        delete (tiles as Partial<Record<string, FakeTile>>).B
        Object.assign(tiles, { A: tile })
      }
    )
    return { mc, tile, stop }
  }

  /** Lets the grid run `ms`. */
  const run = async (ms: number): Promise<void> => {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, ms))
    })
  }

  /**
   * Whether the lone tile plays on: not waiting, and its picture and the
   * clock both a good way further on `ms` later.
   */
  const playsOn = async (
    mc: () => MultiCam,
    tile: FakeTile,
    ms = 3000
  ): Promise<void> => {
    const at = tile.currentTime
    const clock = mc().wallNow() ?? 0
    await run(ms)
    expect(mc().waiting, 'waiting for the pictures').equals(false)
    expect(tile.paused, 'paused').equals(false)
    expect(tile.currentTime - at, 'picture moved, s').greaterThan(
      (ms / 1000) * 0.6
    )
    expect((mc().wallNow() ?? 0) - clock, 'clock moved, ms').greaterThan(
      ms * 0.6
    )
  }

  for (const offSec of [2, -2]) {
    it(`keeps playing after five rapid scrubs whose seeks land ${offSec} s off, with no camera away`, async function () {
      this.timeout(60_000)
      // Two-second segments, every one on time but two: one point out of
      // line — a frame's clock that jumped 2 s and came back — and, from
      // 300 s, a segment that arrived 1.5 s late, which every one after
      // keeps to. Neither is a camera away, and the timing of the scrubs is
      // what found them: before, a scrub that ended inside the step paused
      // the one tile at the far side of what was taken for a hole, to wait
      // for a game only that tile could move, and it stood still for good.
      const anchors: WallAnchor[] = []
      for (let ms = 0; ms <= 600_000; ms += 2000) {
        anchors.push([ms, T0 + ms + (ms >= 300_000 ? 1500 : 0)])
        if (ms === 200_000) anchors.push([200_500, T0 + 202_000])
      }
      const { mc, tile, stop } = await alone({
        anchors,
        edgeSec: 600,
        fromSec: 500,
        offSec
      })
      try {
        await until(() => !tile.paused && !mc().waiting, 8000)
        for (const sec of [150, 240, 200.7, 474, 300.2]) {
          await act(async () => {
            mc().scrub(T0 + sec * 1000)
          })
          await run(1000)
        }
        await run(2000)
        await playsOn(mc, tile)
      } finally {
        stop()
      }
    })
  }

  it('crosses a real 8 s hole in its camera’s recording, scrubbed into', async function () {
    this.timeout(60_000)
    // Before, it waited at the first picture after the hole for the game to
    // get there, and the game is only ever where a playing tile is.
    const { mc, tile, stop } = await alone({
      anchors: [
        [0, T0],
        [100_000, T0 + 108_000]
      ],
      edgeSec: 400,
      fromSec: 90,
      offSec: 0
    })
    try {
      await until(() => !tile.paused && !mc().waiting, 8000)
      await act(async () => {
        mc().scrub(T0 + 103_000)
      })
      await run(3000)
      await playsOn(mc, tile)
      // From the far side of the hole, and the clock with it.
      expect(mc().wallNow() ?? 0).greaterThan(T0 + 108_000)
      expect(tile.currentTime).greaterThan(100)
    } finally {
      stop()
    }
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

describe('useMultiCam landing its tiles after a viewer’s seek (U10–U17)', function () {
  // The default grid: A, heard, two minutes in at 120 s; B, which started a
  // minute later, at 60 s.
  let stops: Array<() => void> = []
  afterEach(function () {
    for (const stop of stops) stop()
    stops = []
  })

  /**
   * Plays each tile that is playing and has pictures on in real time, at its
   * rate, as a player does: the game moves, and a join is reached.
   */
  let playing = false
  const playOn = (tiles: Record<string, FakeTile>): void => {
    let last = Date.now()
    const timer = setInterval(() => {
      const now = Date.now()
      playing = true
      for (const tile of Object.values(tiles)) {
        if (!tile.paused && tile.readyState >= 3 && tile.seeking !== true)
          tile.currentTime += ((now - last) / 1000) * tile.playbackRate
      }
      playing = false
      last = now
    }, 20)
    stops.push(() => {
      clearInterval(timer)
    })
  }

  /** Every place the grid or the test sends this tile to from now on. */
  const seeksOf = (tile: FakeTile): number[] => {
    const sent: number[] = []
    let at = tile.currentTime
    Object.defineProperty(tile, 'currentTime', {
      configurable: true,
      get: () => at,
      set: (to: number) => {
        at = to
        // Not the picture moving on as it plays (`playOn`).
        if (!playing) sent.push(to)
      }
    })
    return sent
  }

  /** Lets the grid run for this many milliseconds. */
  const wait = async (ms: number): Promise<void> => {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, ms))
    })
  }

  /** Until the next watchdog look has been and gone. */
  const nextLook = async (): Promise<void> => {
    await ticks(1)
  }

  /** Browser tiles: each holds the whole of its recording. */
  const full = (tiles: Record<string, FakeTile>): void => {
    for (const tile of Object.values(tiles)) fill(tile, [0, 600])
  }

  it('joins a follower 1.4 s out at the open after a step past what the tiles hold, and starts it on the game (U10)', async function () {
    this.timeout(10_000)
    const { mc, tiles } = await grid({}, {}, tiles => {
      fill(tiles.A, [100, 180])
      fill(tiles.B, [40, 120])
    })
    playOn(tiles)
    await act(async () => {
      mc().goTo(T0 + 400_000)
    })
    expect(tiles.A.paused).equals(true)
    // B's player lands 1.4 s short of the moment while the grid holds.
    tiles.B.currentTime = 338.6
    const sent = seeksOf(tiles.B)
    fill(tiles.A, [395, 460])
    fill(tiles.B, [335, 400])
    await until(() => !tiles.A.paused, 3000)
    expect(tiles.A.paused).equals(false)
    expect(tiles.B.paused, 'held at the lead').equals(true)
    expect(tiles.B.currentTime).equals(340 + JOIN_LEAD_SEC)
    expect(sent, 'never sought to the moment').not.include(340)
    // Started once the game reaches its picture.
    await until(() => !tiles.B.paused, 3000)
    expect(tiles.B.paused).equals(false)
    expect(tiles.A.currentTime).greaterThanOrEqual(400 + JOIN_LEAD_SEC - 0.05)
  })

  it('times the landing from the open after a long hold the seek caused (U10a)', async function () {
    this.timeout(20_000)
    const { mc, tiles } = await grid(four, {}, full, ['A', 'B', 'C', 'D'])
    playOn(tiles)
    // Nothing there yet, for nine seconds.
    for (const tile of Object.values(tiles)) fill(tile, [0, 300])
    await act(async () => {
      mc().goTo(T0 + 400_000)
    })
    expect(tiles.A.paused).equals(true)
    await ticks(9)
    expect(tiles.A.paused).equals(true)
    tiles.B.currentTime = 398.6
    const sent = seeksOf(tiles.B)
    full(tiles)
    await until(() => !tiles.A.paused, 3000)
    expect(tiles.B.paused).equals(true)
    expect(tiles.B.currentTime).equals(400 + JOIN_LEAD_SEC)
    expect(sent).not.include(400)

    // Three looks on, more than ten seconds after the seek but inside the
    // window from the open: a second follower 0.7 s out is joined, not
    // nudged.
    await ticks(3)
    tiles.C.currentTime = tiles.A.currentTime - 0.7
    await until(() => tiles.C.paused, 1500)
    expect(tiles.C.paused, 'joined').equals(true)
    expect(tiles.C.playbackRate).equals(1)
    expect(tiles.C.currentTime - tiles.A.currentTime).within(
      0.3,
      JOIN_LEAD_SEC + 0.01
    )
  })

  it('joins a playing follower 0.7 s out inside the window, rather than nudging it (U11)', async function () {
    this.timeout(8000)
    const { mc, tiles } = await grid({}, {}, full)
    playOn(tiles)
    await act(async () => {
      mc().goTo(T0 + 200_000)
    })
    expect(tiles.A.paused).equals(false)
    tiles.B.currentTime = tiles.A.currentTime - 60 - 0.7
    await until(() => tiles.B.paused, 1500)
    expect(tiles.B.paused).equals(true)
    expect(tiles.B.playbackRate).equals(1)
    expect(tiles.B.currentTime - (tiles.A.currentTime - 60)).within(
      0.3,
      JOIN_LEAD_SEC + 0.01
    )
  })

  it('nudges a follower its landing join started 0.6 s behind, and does not join it again (U12)', async function () {
    this.timeout(10_000)
    const { mc, tiles } = await grid({}, {}, full)
    playOn(tiles)
    await act(async () => {
      mc().goTo(T0 + 200_000)
    })
    tiles.B.currentTime = tiles.A.currentTime - 60 - 0.7
    await until(() => tiles.B.paused, 1500)
    expect(tiles.B.paused).equals(true)
    await until(() => !tiles.B.paused, 3000)
    expect(tiles.B.paused).equals(false)
    // It started late.
    tiles.B.currentTime = tiles.A.currentTime - 60 - 0.6
    await nextLook()
    expect(tiles.B.paused, 'not joined again').equals(false)
    expect(tiles.B.playbackRate).greaterThan(1)
  })

  it('nudges a follower 0.4 s out inside the window (U13)', async function () {
    this.timeout(8000)
    const { mc, tiles } = await grid({}, {}, full)
    playOn(tiles)
    await act(async () => {
      mc().goTo(T0 + 200_000)
    })
    tiles.B.currentTime = tiles.A.currentTime - 60 - 0.4
    await nextLook()
    expect(tiles.B.paused).equals(false)
    expect(tiles.B.playbackRate).closeTo(nudgeRate(0.4), 1e-9)
  })

  it('nudges a follower 0.7 s out once the window has passed, and at a cold open (U14)', async function () {
    this.timeout(20_000)
    const { mc, tiles } = await grid({}, {}, full)
    playOn(tiles)
    // The cold open: no seek yet.
    await ticks(2)
    tiles.B.currentTime = tiles.A.currentTime - 60 - 0.7
    await nextLook()
    expect(tiles.B.paused, 'cold open').equals(false)
    expect(tiles.B.playbackRate).closeTo(nudgeRate(0.7), 0.01)

    tiles.B.currentTime = tiles.A.currentTime - 60
    await act(async () => {
      mc().goTo(T0 + 200_000)
    })
    await ticks(11)
    tiles.B.currentTime = tiles.A.currentTime - 60 - 0.7
    await nextLook()
    expect(tiles.B.paused, `past ${LANDING_MS} ms`).equals(false)
    expect(tiles.B.playbackRate).closeTo(nudgeRate(0.7), 0.01)
  })

  it('seeks a follower 1.2 s out exactly at the grid’s cold open, as before (U14a)', async function () {
    this.timeout(8000)
    const { tiles } = await grid({}, {}, tiles => {
      fill(tiles.A, [120, 123])
      // Nor does its player say it can play there.
      tiles.A.readyState = 2
      fill(tiles.B, [50, 70])
    })
    await ticks(2)
    expect(tiles.A.paused).equals(true)
    tiles.B.currentTime = 58.8
    fill(tiles.A, [100, 180])
    tiles.A.readyState = 4
    await until(() => !tiles.A.paused, 3000)
    expect(tiles.A.paused).equals(false)
    expect(tiles.B.currentTime).equals(60)
    expect(tiles.B.paused).equals(false)
  })

  it('never joins a starved follower 1.2 s out inside the window (U14b)', async function () {
    this.timeout(10_000)
    const { mc, tiles } = await grid({}, {}, full)
    playOn(tiles)
    await act(async () => {
      mc().goTo(T0 + 200_000)
    })
    tiles.B.readyState = 1
    const sent = seeksOf(tiles.B)
    for (let look = 0; look < 3; look++) {
      // Starved, it stands still while the game goes on: kept 1.2 s out,
      // short of REPLACE_SEC, at every look.
      tiles.B.currentTime = tiles.A.currentTime - 60 - 1.2
      sent.length = 0
      await nextLook()
      expect(tiles.B.paused, `look ${look}`).equals(false)
      expect(sent, `look ${look}`).deep.equals([])
    }
  })

  for (const held of [false, true]) {
    it(`opens with the steady rule after a hold no seek caused, ${LANDING_MS} ms after a seek that ${held ? 'held' : 'did not hold'} the grid (U14c)`, async function () {
      this.timeout(30_000)
      const { mc, tiles } = await grid(four, {}, full, ['A', 'B', 'C', 'D'])
      playOn(tiles)
      if (held) for (const tile of Object.values(tiles)) fill(tile, [0, 100])
      await act(async () => {
        mc().goTo(T0 + 200_000)
      })
      expect(tiles.A.paused).equals(held)
      if (held) {
        full(tiles)
        await until(() => !tiles.A.paused, 3000)
        expect(tiles.A.paused).equals(false)
      }
      await ticks(11)
      // D runs dry, and the grid holds.
      const at = tiles.D.currentTime
      fill(tiles.D, [0, at + 0.3])
      await until(() => tiles.A.paused, 1500)
      expect(tiles.A.paused).equals(true)
      const there = tiles.A.currentTime
      tiles.B.currentTime = there - 0.7
      tiles.C.currentTime = there - 1.2
      full(tiles)
      await until(() => !tiles.A.paused, 3000)
      expect(tiles.A.paused).equals(false)
      expect(tiles.B.paused, 'B not joined').equals(false)
      expect(tiles.B.playbackRate).closeTo(nudgeRate(0.7), 0.01)
      expect(tiles.C.paused, 'C not joined').equals(false)
      expect(tiles.C.currentTime, 'C sought exactly').closeTo(there, 0.1)
    })
  }

  it('lets a second seek inside the window join a tile once more (U15)', async function () {
    this.timeout(12_000)
    const { mc, tiles } = await grid({}, {}, full)
    playOn(tiles)
    await act(async () => {
      mc().goTo(T0 + 200_000)
    })
    tiles.B.currentTime = tiles.A.currentTime - 60 - 0.7
    await until(() => tiles.B.paused, 1500)
    expect(tiles.B.paused).equals(true)
    await until(() => !tiles.B.paused, 3000)
    expect(tiles.B.paused).equals(false)

    await act(async () => {
      mc().goTo(T0 + 210_000)
    })
    tiles.B.currentTime = tiles.A.currentTime - 60 - 0.7
    await until(() => tiles.B.paused, 1500)
    expect(tiles.B.paused, 'joined for the second seek').equals(true)
    expect(tiles.B.playbackRate).equals(1)
  })

  /** Two live phone tiles, from the take's start, that say where they end. */
  const live = async (
    endOf: Record<string, () => number>,
    quiet = false
  ): ReturnType<typeof grid> =>
    await grid(
      {
        videos: [liveVideo('A', 0), liveVideo('B', 0)],
        order: ['A', 'B'],
        atMs: T0 + 150_000
      },
      {},
      tiles => {
        for (const [id, tile] of Object.entries(tiles)) {
          tile.duration = Number.POSITIVE_INFINITY
          Object.defineProperty(tile, 'seekableEnd', { get: endOf[id] })
          if (id === 'B' && quiet) Object.assign(tile, { seekableQuiet: true })
          tile.currentTime = 150
        }
      }
    )

  it('fits a join’s lead short of the tile’s seekable end, and its retry and its wait (U16)', async function () {
    this.timeout(12_000)
    let bEnd = 300
    const { tiles } = await live({ A: () => 300, B: () => bEnd })
    await ticks(1)
    expect(tiles.A.paused).equals(false)
    // B is far out, and its newest footage half a second past the moment.
    tiles.A.currentTime = 151
    tiles.B.currentTime = 148
    bEnd = 151.5
    await nextLook()
    expect(tiles.B.paused).equals(true)
    expect(tiles.B.currentTime).closeTo(151 + 0.5 - SEEKABLE_SLACK_SEC, 1e-9)

    // The game passes it before it is ready: sent on by the doubled fitted
    // lead, not JOIN_LEAD_SEC's.
    tiles.B.readyState = 2
    bEnd = 153
    tiles.A.currentTime = 151.75
    await wait(150)
    expect(tiles.B.paused).equals(true)
    expect(tiles.B.currentTime).closeTo(151.75 + 2 * 0.25, 1e-9)

    // Again, with no game to follow: started after the fitted lead.
    tiles.B.readyState = 4
    tiles.A.currentTime = 152
    tiles.B.currentTime = 149
    bEnd = 152.5
    await nextLook()
    expect(tiles.B.paused).equals(true)
    expect(tiles.B.currentTime).closeTo(152.25, 1e-9)
    tiles.A.pause()
    await wait(500)
    expect(tiles.B.paused, 'started after the fitted lead').equals(false)
  })

  it('does not send again a joining tile whose footage ends where it waits, and starts it once it is ready (U16b)', async function () {
    this.timeout(12_000)
    let bEnd = 300
    const { tiles } = await live({ A: () => 300, B: () => bEnd })
    await ticks(1)
    // B is far out, and its footage ends just past the moment: no lead.
    tiles.A.currentTime = 151
    tiles.B.currentTime = 148
    bEnd = 151 + SEEKABLE_SLACK_SEC
    // Its seek does not land when the game passes it, nor for a while.
    tiles.B.seeking = true
    await nextLook()
    expect(tiles.B.paused).equals(true)
    expect(tiles.B.currentTime).closeTo(151, 1e-9)

    const sent = seeksOf(tiles.B)
    for (const at of [151.5, 152, 152.5]) {
      tiles.A.currentTime = at
      bEnd = at + SEEKABLE_SLACK_SEC
      await wait(150)
    }
    expect(sent, 'never sent again').deep.equals([])
    expect(tiles.B.paused).equals(true)

    // It lands: started from where it stands.
    tiles.B.seeking = false
    await wait(150)
    expect(tiles.B.paused).equals(false)
    expect(sent).deep.equals([])
  })

  it('gives a join its whole lead where the tile’s seekable end has gone quiet (U16a)', async function () {
    this.timeout(8000)
    let bEnd = 300
    const { tiles } = await live({ A: () => 300, B: () => bEnd }, true)
    await ticks(1)
    tiles.A.currentTime = 151
    tiles.B.currentTime = 148
    bEnd = 151.5
    await nextLook()
    expect(tiles.B.paused).equals(true)
    expect(tiles.B.currentTime).closeTo(151 + JOIN_LEAD_SEC, 1e-9)
  })

  it('never joins the heard tile, and keeps parked tiles parked, inside the window (U17)', async function () {
    this.timeout(10_000)
    // B was recording for its first minute only; C not yet.
    const short = { ...video('B', 0), durationSec: 60 }
    const { mc, tiles } = await grid(
      {
        videos: [video('A', 0), short, video('C', 300)],
        order: ['A', 'B', 'C']
      },
      {},
      tiles => {
        full(tiles)
        tiles.B.duration = 60
      },
      ['A', 'B', 'C']
    )
    playOn(tiles)
    await act(async () => {
      mc().goTo(T0 + 200_000)
    })
    const heard = seeksOf(tiles.A)
    for (let look = 0; look < 3; look++) {
      await nextLook()
      expect(tiles.A.paused, `heard, look ${look}`).equals(false)
      expect(tiles.A.playbackRate).equals(1)
      expect(heard, 'the heard tile never moved').deep.equals([])
      expect(mc().tiles.B?.parked).equals('afterEnd')
      expect(tiles.B.paused).equals(true)
      expect(tiles.B.currentTime).equals(60)
      expect(mc().tiles.C?.parked).equals('beforeStart')
      expect(tiles.C.paused).equals(true)
      expect(tiles.C.currentTime).equals(0)
    }
  })

  it('keeps a live tile whose footage has not reached the moment parked, never sought, inside the window (U17)', async function () {
    this.timeout(10_000)
    const dated = (seconds: number): WallMapping =>
      fromFragments(
        Array.from({ length: seconds / 4 }, (unused, index) => ({
          start: index * 4,
          duration: 4,
          programDateTime: T0 + index * 4000
        }))
      )
    const held: Record<string, WallMapping> = { A: dated(300), B: dated(100) }
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
    playOn(tiles)
    await ticks(1)
    await act(async () => {
      mc().goTo(T0 + 160_000)
    })
    for (let look = 0; look < 3; look++) {
      await nextLook()
      expect(mc().tiles.B?.parked, `look ${look}`).equals('notYet')
      expect(tiles.B.paused).equals(true)
      expect(tiles.B.currentTime, 'never sought').equals(99)
      expect(tiles.A.paused).equals(false)
    }
  })

  it('keeps a tile at the far side of a hole waiting there inside the window, and starts it where it stands (U17)', async function () {
    this.timeout(15_000)
    // B's camera was away for 8 s after its first 100 s.
    const fragments = (holeAtSec: number, holeSec: number): WallMapping =>
      fromFragments(
        Array.from({ length: 100 }, (unused, index) => ({
          start: index * 4,
          duration: 4,
          programDateTime:
            T0 + index * 4000 + (index * 4 >= holeAtSec ? holeSec * 1000 : 0)
        }))
      )
    const held: Record<string, WallMapping> = {
      A: fragments(400, 0),
      B: fragments(100, 8)
    }
    const { mc, tiles } = await grid(
      {
        videos: [liveVideo('A', 0), liveVideo('B', 0)],
        order: ['A', 'B'],
        atMs: T0 + 90_000
      },
      { fallbackMapping: id => held[id] ?? null },
      tiles => {
        for (const tile of Object.values(tiles)) {
          tile.duration = Number.POSITIVE_INFINITY
          fill(tile, [0, 400])
          Object.assign(tile, { seekable: { length: 1, end: () => 400 } })
        }
      }
    )
    playOn(tiles)
    await ticks(1)
    await act(async () => {
      mc().goTo(T0 + 105_000)
    })
    // Inside its hole: it waits at its first picture after it.
    await nextLook()
    expect(tiles.B.paused).equals(true)
    expect(tiles.B.currentTime).equals(100)
    expect(mc().tiles.B?.parked ?? null).equals(null)
    // And starts from there when the game reaches it, three seconds on.
    await until(() => !tiles.B.paused, 5000)
    expect(tiles.B.paused).equals(false)
    expect(tiles.A.currentTime).greaterThanOrEqual(107)
    expect(tiles.B.currentTime).closeTo(100, 1)
  })
})

describe('a tile a hole away from the moment', function () {
  const T0 = Date.parse('2026-05-01T18:00:00.000Z')
  const on = (anchors: WallAnchor[]): AngleVideo => {
    const mapping = fromAnchors(anchors)
    return {
      startAt: new Date(T0).toISOString(),
      syncOffsetSec: 0,
      durationSec: null,
      clock: () => mapping
    }
  }

  it('says a tile that played on over a hole is a hole away from the moment, and no other', function () {
    const video = on([
      [0, T0],
      [100_000, T0 + 108_000]
    ])
    // Just before the hole, the tile a second on, past it: a second apart in
    // media, 8 s apart on the wall.
    expect(acrossHole(video, 100.5, T0 + 99_500, 2)).equals(true)
    // Inside the hole, at its far side.
    expect(acrossHole(video, 100, T0 + 103_000, 2)).equals(true)
    // At the moment, before the hole or after it.
    expect(acrossHole(video, 99.5, T0 + 99_500, 2)).equals(false)
    expect(acrossHole(video, 102, T0 + 110_000, 2)).equals(false)
    // Far from the moment in its own media: not this question at all.
    expect(acrossHole(video, 10, T0 + 99_500, 3)).equals(false)
    // Behind the moment, still before its hole: the probes look forward.
    expect(acrossHole(video, 99, T0 + 108_500, 2)).equals(false)
  })

  it('finds no hole for a tile at one point out of line', function () {
    const video = on([
      [0, T0],
      [200_000, T0 + 202_000],
      [200_500, T0 + 200_500]
    ])
    expect(acrossHole(video, 200, T0 + 200_000, 2)).equals(false)
  })
})
