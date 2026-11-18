import { expect } from 'chai'
import { describe, it } from 'mocha'

import { type Call, fakeDevice, jsonFixture } from './fakes.test'
import { clockSeconds, type HierarchyNode, readPagePlayer } from './hierarchy'
import { MobileSafariSurface, SAFARI } from './mobileSafari'
import type { Rect } from './regions'

/**
 * The game page's own player as Safari's hierarchy lays it out with its
 * controls hidden: the picture named by its position, the two times under
 * it, Jump to present and the full-screen button. The picture's bounds are
 * fractional, as an iPhone's points are.
 */
const AREA: Rect = { x: 0.4, y: 100.3, width: 389.2, height: 219.6 }
const JUMP: Rect = { x: 300, y: 110, width: 80, height: 30 }
const FULL: Rect = { x: 350, y: 290, width: 30, height: 24 }

function pageTree(
  options: {
    area?: string | null
    times?: string[]
    jump?: boolean
    fullScreen?: string | null
  } = {}
): HierarchyNode {
  const {
    area = '6 minutes 32 seconds',
    times = ['6:32', '1:05:00'],
    jump = true,
    fullScreen = 'fullscreen'
  } = options
  const timeNodes: HierarchyNode[] = times.map((text, index) => ({
    type: 'StaticText',
    text,
    bounds:
      index === 0
        ? { x: 10.5, y: 280, width: 40, height: 16 }
        : { x: 330, y: 280, width: 50, height: 16 }
  }))
  const controls: HierarchyNode[] = [
    ...timeNodes,
    ...(jump
      ? [{ type: 'Button', text: 'Jump to present', bounds: JUMP }]
      : []),
    ...(fullScreen == null
      ? []
      : [{ type: 'Button', id: fullScreen, bounds: FULL }])
  ]
  return {
    type: 'Application',
    bounds: { x: 0, y: 0, width: 390, height: 844 },
    children: [
      {
        type: 'StaticText',
        text: 'Game 0000',
        bounds: { x: 0, y: 40, width: 390, height: 30 }
      },
      // A time outside the picture is never one of its times.
      {
        type: 'StaticText',
        text: '9:99',
        bounds: { x: 10, y: 700, width: 40, height: 16 }
      },
      {
        type: 'Other',
        ...(area == null ? {} : { text: area }),
        bounds: AREA,
        children: controls
      }
    ]
  }
}

describe('reading the game page’s player', function () {
  it('reads m:ss and h:mm:ss as seconds', function () {
    expect(clockSeconds('6:32')).equals(392)
    expect(clockSeconds('0:05')).equals(5)
    expect(clockSeconds('1:05:00')).equals(3900)
  })

  it('finds the picture, the line between its times, and its hidden buttons', function () {
    const player = readPagePlayer(pageTree())
    expect(player).not.equals(null)
    expect(player!.area).deep.equals(AREA)
    // From 20 past the position's right edge to 20 before the duration, 6 under their middle.
    expect(player!.line).deep.equals({ from: 70.5, to: 310, y: 294 })
    expect(player!.fraction).closeTo(392 / 3900, 1e-9)
    expect(player!.jump).deep.equals(JUMP)
    expect(player!.fullScreen).deep.equals(FULL)
  })

  it('names the picture by seconds alone, a minute, or an indefinite time', function () {
    for (const label of ['32 seconds', '1 minute', 'indefinite time'])
      expect(readPagePlayer(pageTree({ area: label }))?.area).deep.equals(AREA)
  })

  it('finds the full-screen exit button too, and no buttons when the page has none', function () {
    expect(
      readPagePlayer(pageTree({ fullScreen: 'fullscreen_exit' }))?.fullScreen
    ).deep.equals(FULL)
    // Which of the two it is says whether the player is full screen.
    expect(
      readPagePlayer(pageTree({ fullScreen: 'fullscreen_exit' }))?.isFullScreen
    ).equals(true)
    expect(readPagePlayer(pageTree())?.isFullScreen).equals(false)
    const bare = readPagePlayer(pageTree({ jump: false, fullScreen: null }))
    expect(bare?.jump).equals(null)
    expect(bare?.fullScreen).equals(null)
    expect(bare?.isFullScreen).equals(null)
    expect(
      readPagePlayer(pageTree({ fullScreen: 'fullscreen button' }))?.fullScreen
    ).equals(null)
  })

  it('has no fraction for a zero duration, and never more than the whole line', function () {
    expect(
      readPagePlayer(pageTree({ times: ['0:00', '0:00'] }))?.fraction
    ).equals(null)
    expect(
      readPagePlayer(pageTree({ times: ['2:00:00', '1:00'] }))?.fraction
    ).equals(1)
  })

  it('is null with no picture, or fewer than two times on it', function () {
    expect(readPagePlayer(undefined)).equals(null)
    expect(readPagePlayer(pageTree({ area: null }))).equals(null)
    expect(readPagePlayer(pageTree({ times: ['6:32'] }))).equals(null)
    expect(readPagePlayer(pageTree({ times: ['6:32', 'LIVE'] }))).equals(null)
  })
})

describe('driving the game page’s player in Safari', function () {
  function surface(
    tree: HierarchyNode | (() => HierarchyNode),
    angle: string | null = 'SynthA'
  ): { surface: MobileSafariSurface; calls: Call[]; sleeps: number[] } {
    const { device, calls } = fakeDevice({
      hierarchy: typeof tree === 'function' ? tree : () => tree,
      state: { foregroundApp: SAFARI }
    })
    const sleeps: number[] = []
    return {
      surface: new MobileSafariSurface({
        name: 'safari',
        device,
        gameUrl: 'https://app.example.test/games/game_0000',
        angle: angle ?? undefined,
        sleep: async (ms: number) => {
          sleeps.push(ms)
        }
      }),
      calls,
      sleeps
    }
  }

  /**
   * A page whose full-screen button follows its presses, as Safari's does,
   * read from the calls since the last look; `leave` is Safari leaving full
   * screen on its own.
   */
  function fullScreenPage(): {
    tree: (calls: Call[]) => HierarchyNode
    leave: () => void
  } {
    let full = false
    let seen = 0
    return {
      tree: calls => {
        if (calls.length < seen) seen = 0
        for (const [name, arg] of calls.slice(seen)) {
          if (name === 'tapOn' && (arg as { point?: string }).point === FULL_AT)
            full = !full
        }
        seen = calls.length
        return pageTree({ fullScreen: full ? 'fullscreen_exit' : 'fullscreen' })
      },
      leave: () => {
        full = false
      }
    }
  }

  const points = (calls: Call[]): string[] =>
    calls
      .filter(([name]) => name === 'tapOn')
      .map(([, arg]) => (arg as { point: string }).point)

  // The picture's bottom-left, 30 in from each edge, in whole points.
  const REVEAL = '30,290'
  // The middles of the buttons.
  const JUMP_AT = '340,125'
  const FULL_AT = '365,302'

  it('scrubs on the page: reveals at the bottom-left, then taps the line at the fraction', async function () {
    const { surface: safari, calls, sleeps } = surface(pageTree())
    await safari.scrub(0.25)
    // 70.5 + 239.5 × 0.25 = 130.375.
    expect(points(calls)).deep.equals([REVEAL, '130,294'])
    expect(sleeps).deep.equals([])
  })

  it('clamps a fraction to the line’s ends', async function () {
    const { surface: safari, calls } = surface(pageTree())
    await safari.scrub(-1)
    expect(points(calls).at(-1)).equals('71,294')
    calls.length = 0
    await safari.scrub(2)
    // Second action, full screen first: reveal, full screen, reveal, line.
    expect(points(calls)).deep.equals([REVEAL, FULL_AT, REVEAL, '310,294'])
  })

  it('enters full screen for every other action and leaves it for the next', async function () {
    const page = fullScreenPage()
    let read: Call[] = []
    const { surface: safari, calls, sleeps } = surface(() => page.tree(read))
    read = calls
    await safari.scrub(0.5)
    expect(points(calls)).deep.equals([REVEAL, '190,294'])
    calls.length = 0
    await safari.jumpToPresent()
    expect(points(calls)).deep.equals([REVEAL, FULL_AT, REVEAL, JUMP_AT])
    expect(sleeps).deep.equals([1500])
    calls.length = 0
    await safari.rapidScrub([0, 1], 250)
    // Out of full screen again, then two scrubs a quarter second apart.
    expect(points(calls)).deep.equals([
      REVEAL,
      FULL_AT,
      REVEAL,
      '71,294',
      REVEAL,
      '310,294'
    ])
    expect(sleeps).deep.equals([1500, 1500, 250])
    calls.length = 0
    await safari.scrub(0.5)
    expect(points(calls)).deep.equals([REVEAL, FULL_AT, REVEAL, '190,294'])
  })

  it('reads where the player is each time, after Safari left full screen by itself', async function () {
    const page = fullScreenPage()
    let read: Call[] = []
    const { surface: safari, calls } = surface(() => page.tree(read))
    read = calls
    await safari.scrub(0.5)
    await safari.scrub(0.5)
    // Full screen for the second; then Safari leaves it on its own.
    page.leave()
    calls.length = 0
    await safari.scrub(0.5)
    // On the page already, as the third wants: nothing is pressed.
    expect(points(calls)).deep.equals([REVEAL, '190,294'])
    calls.length = 0
    await safari.scrub(0.5)
    expect(points(calls)).deep.equals([REVEAL, FULL_AT, REVEAL, '190,294'])
  })

  it('stays on the page when the player has no full-screen button', async function () {
    const {
      surface: safari,
      calls,
      sleeps
    } = surface(pageTree({ fullScreen: null }))
    await safari.scrub(0)
    await safari.scrub(1)
    expect(points(calls)).deep.equals([REVEAL, '71,294', REVEAL, '310,294'])
    expect(sleeps).deep.equals([])
  })

  it('jumps to present on the page: reveals, then presses Jump', async function () {
    const { surface: safari, calls } = surface(pageTree())
    await safari.jumpToPresent()
    expect(points(calls)).deep.equals([REVEAL, JUMP_AT])
  })

  it('says so when the page shows no player, or a player with no Jump to present', async function () {
    const message = async (run: Promise<void>): Promise<string> =>
      await run.then(
        () => '',
        (error: unknown) => (error as Error).message
      )
    const empty = surface({ type: 'Application', children: [] })
    expect(await message(empty.surface.scrub(0.5))).equals(
      "safari: the game page's player is not up"
    )
    const noJump = surface(pageTree({ jump: false }))
    expect(await message(noJump.surface.jumpToPresent())).equals(
      'safari: the player shows no Jump to present'
    )
    expect(points(noJump.calls)).deep.equals([])
  })

  it('leaves every angle at once to the touch surface’s own scrubbing and Jump to present', async function () {
    const angles = jsonFixture('nativeHierarchy.json') as HierarchyNode
    const all = surface(angles, null)
    await all.surface.scrub(0.5)
    await all.surface.rapidScrub([0.2], 0)
    await all.surface.jumpToPresent()
    const names = all.calls.map(([name]) => name)
    expect(names.filter(name => name === 'swipe')).length(2)
    expect(names).includes('tapOnPoint')
    expect(points(all.calls)).deep.equals([])
  })
})
