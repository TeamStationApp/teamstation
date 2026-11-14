import { expect } from 'chai'
import { describe, it } from 'mocha'
import { PNG } from 'pngjs'

import { drawnPicture } from '../clockReader.test'
import { type Call, fakeDevice, jsonFixture, noSleep, png } from './fakes.test'
import {
  barFraction,
  centre,
  findBounds,
  type HierarchyNode,
  playerBlock,
  readScreen,
  type ScreenRead,
  type TileNode,
  videoBlockOf
} from './hierarchy'
import { MobileSafariSurface, SAFARI } from './mobileSafari'
import { NativeAppSurface } from './nativeApp'
import {
  decodePng,
  regionAdvancing,
  regionDifference,
  toPixels
} from './regions'
import { DEFAULT_SKIPS, performAction, type SoakSurfaceDriver } from './surface'

const native = jsonFixture('nativeHierarchy.json') as HierarchyNode
const safari = jsonFixture('safariHierarchy.json') as HierarchyNode

describe('reading a hierarchy', function () {
  it('finds each angle tile, its notice, the bar and the screen in an app', function () {
    const read = readScreen(native)
    expect(read.screen).deep.equals({ x: 0, y: 0, width: 1024, height: 768 })
    expect(read.tiles.map(tile => [tile.angle, tile.notice])).deep.equals([
      ['PhoneA', null],
      ['PhoneB', null],
      ['Synthetic', 'Waiting for this camera to catch up to the game…']
    ])
    expect(read.bar).deep.equals({
      bounds: { x: 24, y: 720, width: 976, height: 24 },
      fraction: 0.4
    })
    expect(read.texts).includes('Jump to present')
  })

  it('reads the web app inside Safari the same way, with no bar value', function () {
    const read = readScreen(safari)
    expect(read.tiles.map(tile => tile.angle)).deep.equals([
      'PhoneA',
      'PhoneB',
      'Synthetic'
    ])
    expect(read.tiles[1].notice).equals('Camera catching up…')
    expect(read.bar!.fraction).equals(null)
    expect(read.screen!.height).equals(844)
  })

  it('reads a bar position as a percentage or a ratio, and empty trees', function () {
    expect(barFraction('Position in the game, 42%')).equals(0.42)
    expect(barFraction('Position in the game, 30 of 120')).equals(0.25)
    expect(barFraction('Position in the game, 3/0')).equals(null)
    expect(barFraction('Position in the game')).equals(null)
    expect(readScreen(undefined)).deep.equals({
      screen: null,
      tiles: [],
      bar: null,
      texts: []
    })
    expect(findBounds(native, 'Nowhere')).equals(null)
    expect(centre({ x: 10, y: 10, width: 10, height: 11 })).deep.equals({
      x: 15,
      y: 16
    })
  })
})

describe('the block of videos', function () {
  const tile = (
    x: number,
    y: number,
    width: number,
    height: number
  ): TileNode => ({
    angle: `${x},${y}`,
    bounds: { x, y, width, height },
    notice: null
  })

  it("is the app's videoBlock: the widest row, from the top tile to the bottom one", function () {
    // One video above two: the bottom pair is the widest row.
    expect(
      videoBlockOf([
        tile(300, 0, 400, 300),
        tile(100, 300, 400, 300),
        tile(500, 300, 400, 300),
        tile(0, 0, 0, 0)
      ])
    ).deep.equals({ x: 100, y: 0, width: 800, height: 600 })
    expect(videoBlockOf([])).equals(null)
  })

  it('is the player only when it covers enough of the screen', function () {
    const screen = { x: 0, y: 0, width: 1000, height: 1000 }
    const read = (tiles: TileNode[]): ScreenRead => ({
      screen,
      tiles,
      bar: null,
      texts: []
    })
    expect(playerBlock(read([tile(0, 0, 1000, 600)]))).deep.equals({
      x: 0,
      y: 0,
      width: 1000,
      height: 600
    })
    // The game page's card.
    expect(playerBlock(read([tile(0, 100, 1000, 250)]))).equals(null)
    expect(playerBlock(read([]))).equals(null)
    expect(playerBlock({ ...read([tile(0, 0, 10, 10)]), screen: null })).equals(
      null
    )
  })
})

describe('comparing tile regions', function () {
  it('sees a region that moved and one that did not', function () {
    const a = decodePng(png(100, 50))
    const b = decodePng(png(100, 50, [{ x: 0, y: 0, width: 50, height: 50 }]))
    expect(
      regionAdvancing(a, b, { x: 0, y: 0, width: 50, height: 50 }, 1)
    ).equals(true)
    expect(
      regionAdvancing(a, b, { x: 50, y: 0, width: 50, height: 50 }, 1)
    ).equals(false)
    expect(
      regionAdvancing(a, b, { x: 200, y: 0, width: 10, height: 10 }, 1)
    ).equals(null)
    expect(
      regionDifference(a, decodePng(png(10, 10)), {
        x: 0,
        y: 0,
        width: 5,
        height: 5
      })
    ).equals(1)
    expect(regionDifference(a, a, { x: 0, y: 0, width: 0, height: 0 })).equals(
      0
    )
    expect(toPixels({ x: 10, y: 10, width: 100, height: 50 }, 2)).deep.equals({
      x: 40,
      y: 30,
      width: 160,
      height: 80
    })
  })
})

function appSurface(answers: Record<string, unknown> = {}): {
  surface: NativeAppSurface
  calls: Call[]
  shots: string[]
} {
  const { device, calls } = fakeDevice({
    hierarchy: native,
    state: { foregroundApp: 'app.example.develop' },
    ...answers
  })
  const shots: string[] = []
  const surface = new NativeAppSurface({
    name: 'ipad',
    device,
    appId: 'app.example.develop',
    gameLink: 'https://app.example.test/games/game_0000',
    sleep: noSleep,
    saveShot: name => {
      shots.push(name)
      return `shots/${name}`
    }
  })
  return { surface, calls, shots }
}

describe('the native app surface', function () {
  it('joins by the game link, then opens every angle', async function () {
    const { surface, calls } = appSurface()
    await surface.join()
    expect(
      calls.map(call => call[0]).filter(name => name !== 'assertVisible')
    ).deep.equals(['launchApp', 'openLink', 'tapOn', 'tapOn', 'tapOn'])
    expect(calls[0][1]).deep.equals({
      appId: 'app.example.develop',
      stopApp: false
    })
    expect(calls[1][1]).deep.equals({
      link: 'https://app.example.test/games/game_0000'
    })
    expect((calls[2][1] as { text: string }).text).equals('All angles')
  })

  it('drags the bar from where it is to the asked fraction', async function () {
    const { surface, calls } = appSurface()
    await surface.scrub(0.9)
    const swipe = calls.find(call => call[0] === 'swipe')![1] as Record<
      string,
      number
    >
    expect(swipe).deep.equals({
      startX: 414,
      startY: 732,
      endX: 902,
      endY: 732,
      duration: 800
    })
  })

  it('scrubs five times a second apart, skips by the ten-second squares and holds for slow motion', async function () {
    const { surface, calls } = appSurface()
    await surface.rapidScrub([0.1, 0.2, 0.3, 0.4, 0.5])
    expect(calls.filter(call => call[0] === 'swipe')).length(5)
    calls.length = 0
    await surface.skip()
    const taps = calls
      .filter(call => call[0] === 'tapOnPoint')
      .map(call => call[1])
    // The press grid's back and forward squares, in the second row of four
    // over the block of videos, which ends above the controls.
    const block = { x: 0, y: 0, width: 1024, height: 700 }
    const square = (column: number): { x: number; y: number } => ({
      x: Math.round(block.x + (block.width * (column + 0.5)) / 4),
      y: Math.round(block.y + (block.height * 1.5) / 4)
    })
    expect(taps).deep.equals([
      ...DEFAULT_SKIPS.slice(0, 3).map(() => square(0)),
      square(3),
      square(3)
    ])
    calls.length = 0
    await surface.slowMotion(8000)
    expect(calls.at(-1)).deep.equals([
      'tapOnPoint',
      { ...square(3), longPress: true, duration: 8000 }
    ])
  })

  it("pauses and plays with a tap on the grid's centre square", async function () {
    const { surface, calls } = appSurface()
    await surface.togglePause()
    // The second column of the second row over the 1024 × 700 block of videos.
    expect(
      calls.filter(call => call[0] === 'tapOnPoint').map(call => call[1])
    ).deep.equals([{ x: 384, y: 263 }])
  })

  it('brings hidden controls back with a tap on the view, and says when they never come', async function () {
    let reads = 0
    const hidden: HierarchyNode = {
      bounds: { x: 0, y: 0, width: 1024, height: 768 }
    }
    // The first read finds the player up; the controls are hidden by the next.
    const { surface, calls } = appSurface({
      hierarchy: () => (reads++ === 1 ? hidden : native)
    })
    await surface.jumpToPresent()
    expect(
      calls.filter(call => call[0] === 'tapOnPoint').map(call => call[1])
    ).deep.equals([
      // The grid's top-centre square over the block of videos, never its
      // centre, which would pause the picture.
      { x: 384, y: 88 },
      { x: 930, y: 662 }
    ])
    const never = appSurface({ hierarchy: {} })
    expect(
      await never.surface.jumpToPresent().then(
        () => '',
        (e: unknown) => (e as Error).message
      )
    ).match(/the full-screen player is not up/)
    // The player is up, but its controls never come back.
    let bareReads = 0
    const bare = appSurface({
      hierarchy: () => (bareReads++ === 0 ? native : hidden)
    })
    expect(
      await bare.surface.jumpToPresent().then(
        () => '',
        (e: unknown) => (e as Error).message
      )
    ).match(/no "Jump to present"/)
    expect(
      await never.surface.scrub(0.5).then(
        () => '',
        (e: unknown) => (e as Error).message
      )
    ).match(/the full-screen player is not up/)
  })

  it('cuts by tapping the angle, exits and re-enters, and relaunches', async function () {
    const { surface, calls } = appSurface()
    await surface.cut('PhoneB')
    expect(calls[0]).deep.equals(['tapOn', { text: 'PhoneB angle' }])
    calls.length = 0
    await surface.exitAndReenter(10000)
    expect(
      calls.map(call => call[0]).filter(name => name !== 'assertVisible')
    ).deep.equals([
      'hierarchy',
      'hierarchy',
      'tapOnPoint',
      'tapOn',
      'tapOn',
      'tapOn'
    ])
    calls.length = 0
    await surface.relaunch()
    expect(calls[0]).deep.equals(['stopApp', { appId: 'app.example.develop' }])
    expect(calls[1][0]).equals('launchApp')
    calls.length = 0
    await surface.resume()
    expect(calls).deep.equals([
      ['launchApp', { appId: 'app.example.develop', stopApp: false }]
    ])
  })

  it('rejoins a player it finds closed before a press-grid action, and notes it once', async function () {
    // The game page: a camera list, no angle tiles.
    const gamePage: HierarchyNode = {
      bounds: { x: 0, y: 0, width: 1024, height: 768 },
      children: [
        { text: 'CAMERAS', bounds: { x: 0, y: 400, width: 200, height: 30 } },
        { text: 'End', bounds: { x: 900, y: 700, width: 60, height: 40 } }
      ]
    }
    let reads = 0
    const { surface, calls } = appSurface({
      hierarchy: () => (reads++ === 0 ? gamePage : native)
    })
    await surface.skip([10])
    const names = calls.map(call => call[0])
    expect(names.indexOf('openLink')).lessThan(names.indexOf('tapOnPoint'))
    expect(calls.filter(call => call[0] === 'tapOnPoint')).length(1)
    expect(surface.takeNotes()).deep.equals([
      'rejoined: the full-screen player was not up'
    ])
    expect(surface.takeNotes()).deep.equals([])
    calls.length = 0
    await surface.slowMotion(1000)
    expect(calls.some(call => call[0] === 'openLink')).equals(false)
    expect(surface.takeNotes()).deep.equals([])
  })

  it('holds no longer than the driver can, and notes the shortened hold', async function () {
    const { device, calls } = fakeDevice({ hierarchy: native })
    const surface = new NativeAppSurface({
      name: 'android',
      device,
      appId: 'app.example.develop',
      gameLink: 'teamstation://games/game_0000',
      sleep: noSleep,
      maxHoldMs: 7000
    })
    await surface.slowMotion(8000)
    expect(
      (calls.find(call => call[0] === 'tapOnPoint')![1] as { duration: number })
        .duration
    ).equals(7000)
    expect(surface.takeNotes()).deep.equals(['held 7000 ms of 8000'])
    await surface.slowMotion(5000)
    expect(surface.takeNotes()).deep.equals([])
  })

  it('scrubs along the block of videos with no bar, never from a screen edge', async function () {
    // An Android phone on its side: three angles, one row of two above one.
    const tile = (angle: string, x: number, y: number): HierarchyNode => ({
      text: `${angle} angle`,
      bounds: { x, y, width: 960, height: 540 }
    })
    const sideways: HierarchyNode = {
      bounds: { x: 0, y: 0, width: 2400, height: 1080 },
      children: [
        tile('PhoneA', 240, 0),
        tile('PhoneB', 1200, 0),
        tile('Synthetic', 240, 540)
      ]
    }
    const { surface, calls } = appSurface({ hierarchy: sideways })
    await surface.scrub(0)
    expect(calls.find(call => call[0] === 'tapOnPoint')![1]).deep.equals({
      x: 480,
      y: 945
    })
    expect(calls.find(call => call[0] === 'swipe')![1]).deep.equals({
      startX: 1200,
      startY: 945,
      endX: 278,
      endY: 945,
      duration: 800
    })
    // A block as wide as the screen: the swipe still stops short of the edge.
    const wide: HierarchyNode = {
      bounds: { x: 0, y: 0, width: 2400, height: 1080 },
      children: [
        {
          text: 'PhoneA angle',
          bounds: { x: 0, y: 0, width: 2400, height: 1080 }
        }
      ]
    }
    const full = appSurface({ hierarchy: wide })
    await full.surface.scrub(0)
    await full.surface.scrub(1)
    const swipes = full.calls
      .filter(call => call[0] === 'swipe')
      .map(call => call[1] as Record<string, number>)
    expect(swipes[0].endX).equals(120)
    expect(swipes[1].endX).equals(2280)
  })

  it("reads each tile's burned-in clock from one screenshot, by its bounds in points", async function () {
    // A 2× screenshot of a 640 × 360 point screen whose one tile is a
    // synthetic frame drawn at half size, from (0, 0).
    const frame = drawnPicture('SYNTHA', 2)
    const shot = new PNG({ width: 1280, height: 720 })
    shot.data.fill(24)
    for (let y = 0; y < frame.height; y++) {
      for (let x = 0; x < frame.width; x++) {
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1]
        ]) {
          const to = ((y * 2 + dy) * 1280 + x * 2 + dx) * 4
          shot.data.set(
            frame.data.subarray(
              (y * frame.width + x) * 4,
              (y * frame.width + x) * 4 + 4
            ),
            to
          )
        }
      }
    }
    const screen: HierarchyNode = {
      bounds: { x: 0, y: 0, width: 640, height: 360 },
      children: [
        {
          text: 'SynthA angle',
          bounds: { x: 0, y: 0, width: 640, height: 360 }
        }
      ]
    }
    const { surface } = appSurface({
      hierarchy: screen,
      screenshot: PNG.sync.write(shot)
    })
    const clocks = await surface.readClocks()
    expect(clocks).length(1)
    expect(clocks[0].angle).equals('SynthA')
    expect(clocks[0].reading).deep.include({
      label: 'SYNTHA',
      confidence: 1
    })
    const none = appSurface({ hierarchy: {}, screenshot: png(10, 10) })
    expect(await none.surface.readClocks()).deep.equals([])
  })

  it('probes each tile from two screenshots, with notices, bar and foreground', async function () {
    let shot = 0
    // 2x screenshots: PhoneA's region (0,0)-(512,350) in points changes between them.
    const shots = [
      png(2048, 1536),
      png(2048, 1536, [{ x: 100, y: 100, width: 800, height: 500 }])
    ]
    const { surface, shots: saved } = appSurface({
      screenshot: () => shots[shot++ % 2]
    })
    const probe = await surface.probe()
    expect(probe.tiles).deep.equals([
      { angle: 'PhoneA', advancing: true, notice: null },
      { angle: 'PhoneB', advancing: false, notice: null },
      {
        angle: 'Synthetic',
        advancing: false,
        notice: 'Waiting for this camera to catch up to the game…'
      }
    ])
    expect(probe.bar).equals(0.4)
    expect(probe.foreground).equals(true)
    expect(probe.screenshots).deep.equals([
      'shots/ipad-1-a.png',
      'shots/ipad-1-b.png'
    ])
    expect(saved).length(2)
  })

  it('answers nothing it cannot see', async function () {
    const broken = appSurface({
      screenshot: () => {
        throw new Error('device gone')
      }
    })
    expect(await broken.surface.probe()).deep.equals({
      tiles: null,
      bar: null,
      foreground: null,
      reason: 'ipad: device gone'
    })
    const empty = appSurface({
      screenshot: png(10, 10),
      hierarchy: {},
      state: {}
    })
    const probe = await empty.surface.probe()
    expect(probe.tiles).equals(null)
    expect(probe.foreground).equals(null)
    expect(probe.reason).match(/empty hierarchy/)
    const away = appSurface({
      screenshot: png(1024, 768),
      state: () => {
        throw new Error('no state')
      }
    })
    expect((await away.surface.probe()).foreground).equals(null)
    const other = appSurface({
      screenshot: png(1024, 768),
      state: { foregroundApp: 'com.example.other' }
    })
    expect((await other.surface.probe()).foreground).equals(false)
  })
})

describe('the iPhone Safari surface', function () {
  function safariSurface(): { surface: MobileSafariSurface; calls: Call[] } {
    const { device, calls } = fakeDevice({
      hierarchy: safari,
      state: { foregroundApp: SAFARI },
      screenshot: png(390, 844)
    })
    return {
      surface: new MobileSafariSurface({
        name: 'iphone-safari',
        device,
        gameUrl: 'https://app.example.test/games/game_0000',
        sleep: noSleep
      }),
      calls
    }
  }

  it('opens the game in a new tab through the address field', async function () {
    const { surface, calls } = safariSurface()
    expect(surface.hasTab).equals(false)
    await surface.join()
    expect(surface.hasTab).equals(true)
    expect(calls[0]).deep.equals([
      'launchApp',
      { appId: SAFARI, stopApp: false }
    ])
    expect(calls.find(call => call[0] === 'inputText')![1]).equals(
      'https://app.example.test/games/game_0000'
    )
    expect(calls.find(call => call[0] === 'pressKey')![1]).equals('Enter')
    expect(calls.some(call => call[0] === 'openLink')).equals(false)
    expect(calls.at(-1)).deep.equals(['tapOn', { text: 'Tap for sound' }])
  })

  it('relaunches by closing the tab and opening the address again', async function () {
    const { surface, calls } = safariSurface()
    await surface.relaunch()
    const ids = calls
      .map(call => (call[1] as { id?: string } | undefined)?.id)
      .filter(id => id != null)
    expect(ids).includes('Close')
    expect(calls.some(call => call[0] === 'inputText')).equals(true)
    calls.length = 0
    await surface.resume()
    expect(calls).deep.equals([
      ['launchApp', { appId: SAFARI, stopApp: false }]
    ])
  })

  it('probes the web page through the hierarchy and screenshots', async function () {
    const { surface } = safariSurface()
    const probe = await surface.probe()
    expect(probe.tiles!.map(tile => tile.notice)).deep.equals([
      null,
      'Camera catching up…',
      null
    ])
    expect(probe.foreground).equals(true)
    expect(probe.bar).equals(null)
  })
})

describe('performing a schedule action', function () {
  it('calls the driver with the schedule arguments', async function () {
    const seen: unknown[][] = []
    const driver: SoakSurfaceDriver = new Proxy<SoakSurfaceDriver>(
      Object.create(null),
      {
        get:
          (_t, name: string) =>
          async (...args: unknown[]) => {
            seen.push([name, ...args])
          }
      }
    )
    await performAction(driver, 'join')
    await performAction(driver, 'scrubLeft', { fraction: 0.3 })
    await performAction(driver, 'scrubRight', {})
    await performAction(driver, 'rapidScrub', {
      fractions: [0.1],
      intervalMs: 5
    })
    await performAction(driver, 'rapidScrub')
    await performAction(driver, 'skip', { steps: [-10] })
    await performAction(driver, 'slowMotion', {})
    await performAction(driver, 'cameraCut', { angle: 'PhoneA' })
    await performAction(driver, 'cameraCutBack', { angle: 'PhoneB' })
    await performAction(driver, 'jumpToPresent')
    await performAction(driver, 'exitAndReenter', { waitSec: 3 })
    await performAction(driver, 'relaunch')
    await performAction(driver, 'scrubLeft')
    expect(seen).deep.equals([
      ['join'],
      ['scrub', 0.3],
      ['scrub', 1],
      ['rapidScrub', [0.1], 5],
      ['rapidScrub', [0.3, 0.6, 0.2, 0.8, 0.5], undefined],
      ['skip', [-10]],
      ['slowMotion', 8000],
      ['cut', 'PhoneA'],
      ['cut', 'PhoneB'],
      ['jumpToPresent'],
      ['exitAndReenter', 3000],
      ['relaunch'],
      ['scrub', 0.4]
    ])
    expect(
      await performAction(driver, 'dance').then(
        () => '',
        (e: unknown) => (e as Error).message
      )
    ).match(/no surface action/)
  })
})

describe('Safari watching one angle in the game page’s player', function () {
  /** A white landscape page with the frame of `epochMs` at half size, 100 px in and 300 down. */
  function page(epochMs: number | null): Uint8Array {
    const out = new PNG({ width: 1000, height: 700 })
    out.data.fill(255)
    if (epochMs != null) {
      const frame = drawnPicture('SYNTHA', 2, epochMs)
      for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
          const from = (y * frame.width + x) * 4
          const to = ((y + 300) * out.width + x + 100) * 4
          for (let c = 0; c < 4; c++) out.data[to + c] = frame.data[from + c]
        }
      }
    }
    return PNG.sync.write(out)
  }

  function single(shots: Uint8Array[]): {
    surface: MobileSafariSurface
    calls: Call[]
  } {
    let shot = 0
    const { device, calls } = fakeDevice({
      state: { foregroundApp: SAFARI },
      screenshot: () => shots[Math.min(shot++, shots.length - 1)]
    })
    return {
      surface: new MobileSafariSurface({
        name: 'safari',
        device,
        gameUrl: 'https://app.example.test/games/game_0000',
        angle: 'SynthA',
        sleep: noSleep
      }),
      calls
    }
  }

  it('picks the angle’s pill, scrolled to, upright so the whole player shows', async function () {
    const { surface, calls } = single([page(null)])
    await surface.join()
    const names = calls.map(([name]) => name)
    expect(names).includes('scrollUntilVisible')
    const tapped = calls.filter(([name]) => name === 'tapOn').map(c => c[1])
    expect(tapped).deep.include({ text: 'SynthA', timeout: 15000 })
    // Upright first, where the whole player fits under the page's tabs.
    expect(calls.map(([, arg]) => arg)).deep.include({
      orientation: 'PORTRAIT'
    })
    expect(names.indexOf('setOrientation')).lessThan(
      names.indexOf('scrollUntilVisible')
    )
    expect(names).not.includes('swipe')
  })

  it('finds the player on the screenshot, tells it moving or still, and reads its clock', async function () {
    const moving = await single([
      page(61_000_000),
      page(61_002_000)
    ]).surface.probe()
    expect(moving.tiles).deep.equals([
      { angle: 'SynthA', advancing: true, notice: null }
    ])
    const still = await single([
      page(61_000_000),
      page(61_000_000)
    ]).surface.probe()
    expect(still.tiles?.[0].advancing).equals(false)
    const none = await single([page(null)]).surface.probe()
    expect(none.tiles).deep.equals([])
    expect(none.reason).equals('safari: no picture of SynthA on screen')
    const clocks = await single([page(61_000_000)]).surface.readClocks()
    expect(clocks[0].angle).equals('SynthA')
    expect(clocks[0].reading?.label).equals('SYNTHA')
    expect(await single([page(null)]).surface.readClocks()).deep.equals([
      { angle: 'SynthA', reading: null }
    ])
  })
})
