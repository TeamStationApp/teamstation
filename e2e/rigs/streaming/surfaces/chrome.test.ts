import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  ChromeSurface,
  compareReads,
  pageBlock,
  type PageRead,
  parsePageRead,
  READ_SCRIPT
} from './chrome'
import { type Call, fakeDevice, noSleep } from './fakes.test'

function read(
  overrides: Partial<Record<string, Partial<PageRead['tiles'][number]>>> = {},
  extra: Partial<PageRead> = {}
): PageRead {
  const tile = (
    angle: string,
    currentTime: number,
    frames: number
  ): PageRead['tiles'][number] => ({
    angle,
    currentTime,
    paused: false,
    readyState: 4,
    seeking: false,
    frames,
    notice: null as string | null,
    rect: {
      x: angle === 'PhoneB' ? 720 : 0,
      y: angle === 'Synthetic' ? 405 : 0,
      width: 720,
      height: 405
    },
    ...overrides[angle]
  })
  return {
    tiles: [
      tile('PhoneA', 10, 300),
      tile('PhoneB', 10, 300),
      tile('Synthetic', 10, 300)
    ],
    viewport: { width: 1440, height: 900 },
    bar: {
      now: 30,
      max: 120,
      rect: { x: 100, y: 600, width: 1000, height: 24 }
    },
    visible: true,
    signIn: false,
    ...extra
  }
}

describe('the Chrome surface', function () {
  it('reads advancing from currentTime and decoded frames two seconds apart', function () {
    const before = read()
    const after = read({
      PhoneA: { currentTime: 12, frames: 360 },
      PhoneB: { currentTime: 12, frames: 300 },
      Synthetic: {
        currentTime: 10.2,
        frames: 306,
        notice: 'Camera catching up…'
      }
    })
    expect(compareReads(before, after, 2000)).deep.equals([
      { angle: 'PhoneA', advancing: true, notice: null },
      { angle: 'PhoneB', advancing: false, notice: null },
      { angle: 'Synthetic', advancing: false, notice: 'Camera catching up…' }
    ])
    const paused = read({
      PhoneA: {
        currentTime: 12,
        frames: 360,
        paused: true,
        notice: 'PhoneA'
      }
    })
    expect(compareReads(before, paused, 2000)[0]).deep.equals({
      angle: 'PhoneA',
      advancing: false,
      notice: null
    })
    const unknown = read({ PhoneA: { currentTime: null } })
    expect(compareReads(before, unknown, 2000)[0].advancing).equals(null)
    const noFrames = read({
      PhoneA: { currentTime: 12, frames: null, readyState: null }
    })
    expect(compareReads(before, noFrames, 2000)[0].advancing).equals(false)
    expect(
      compareReads({ ...before, tiles: [] }, after, 2000)[0].advancing
    ).equals(null)
  })

  it('parses what the page script returns, as a string or an object', function () {
    expect(parsePageRead(JSON.stringify(read())).tiles).length(3)
    expect(parsePageRead(JSON.stringify(read())).viewport).deep.equals({
      width: 1440,
      height: 900
    })
    expect(parsePageRead({ visible: false, signIn: true })).deep.equals({
      tiles: [],
      bar: null,
      visible: false,
      signIn: true
    })
    expect(READ_SCRIPT).contains('aria-label="Position in the game"')
  })

  function chrome(reads: PageRead[] | (() => unknown)): {
    surface: ChromeSurface
    calls: Call[]
  } {
    const { device, calls } = fakeDevice()
    let index = 0
    const page = {
      evaluate: async (script: string) => {
        expect(script).equals(READ_SCRIPT)
        if (typeof reads === 'function') return reads()
        return JSON.stringify(reads[Math.min(index++, reads.length - 1)])
      }
    }
    return {
      surface: new ChromeSurface({
        device,
        page,
        gameUrl: 'https://app.example.test/games/game_0000',
        sleep: noSleep
      }),
      calls
    }
  }

  it('probes the page without acting on it', async function () {
    const { surface, calls } = chrome([
      read(),
      read({ PhoneA: { currentTime: 12, frames: 360 } })
    ])
    const probe = await surface.probe()
    expect(probe.tiles![0].advancing).equals(true)
    expect(probe.bar).equals(0.25)
    expect(probe.foreground).equals(true)
    expect(probe.sessionLost).equals(false)
    expect(calls).deep.equals([])
    const noBar = chrome([read({}, { bar: null })])
    expect((await noBar.surface.probe()).bar).equals(null)
    const failing = chrome(() => {
      throw new Error('target closed')
    })
    expect(await failing.surface.probe()).deep.equals({
      tiles: null,
      bar: null,
      foreground: null,
      reason: 'chrome: target closed'
    })
  })

  it('acts through maestro-d: join, cut, scrubs, skips, slow key, jump, exit and reload', async function () {
    const { surface, calls } = chrome([read()])
    await surface.join()
    expect(calls[0]).deep.equals([
      'openLink',
      { link: 'https://app.example.test/games/game_0000' }
    ])
    calls.length = 0
    await surface.scrub(0.5)
    expect(calls).deep.equals([
      [
        'swipe',
        { startX: 350, startY: 612, endX: 600, endY: 612, duration: 800 }
      ]
    ])
    calls.length = 0
    await surface.rapidScrub([0.1, 0.9])
    expect(calls).length(2)
    calls.length = 0
    await surface.skip()
    // The grid's back and forward squares over the 1440 × 810 block of videos.
    const back = { x: 180, y: 304 }
    const forward = { x: 1260, y: 304 }
    expect(calls.map(call => call[1])).deep.equals([
      back,
      back,
      back,
      forward,
      forward
    ])
    calls.length = 0
    await surface.slowMotion(8000)
    expect(
      calls.map(call => (call[1] as { script: string }).script)
    ).deep.equals([
      "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))",
      "window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true }))"
    ])
    calls.length = 0
    await surface.cut('Synthetic')
    await surface.jumpToPresent()
    await surface.exitAndReenter(1)
    await surface.relaunch()
    // Controls that take a tap get it with no press on the grid.
    expect(
      calls
        .filter(call => call[0] !== 'assertVisible')
        .map(call =>
          call[0] === 'tapOnPoint'
            ? call[1]
            : [call[0], (call[1] as { text?: string }).text]
        )
    ).deep.equals([
      ['tapOn', 'Synthetic angle'],
      ['tapOn', 'Jump to present'],
      ['tapOn', 'Close'],
      ['tapOn', 'All angles'],
      ['tapOn', 'Watch'],
      ['openLink', undefined],
      ['tapOn', 'All angles'],
      ['tapOn', 'Watch']
    ])
    expect(surface.takeNotes()).deep.equals([])
    const flat = chrome([
      read(
        {},
        {
          bar: { now: 0, max: 0, rect: { x: 0, y: 0, width: 100, height: 10 } }
        }
      )
    ])
    await flat.surface.scrub(1)
    expect((flat.calls[0][1] as { startX: number }).startX).equals(50)
    const none = chrome([read({}, { bar: null })])
    expect(
      await none.surface.scrub(1).then(
        () => '',
        (e: unknown) => (e as Error).message
      )
    ).match(/no bar/)
  })

  it('brings hidden controls up with the grid only when a control takes no pointer', async function () {
    let refusals = 1
    const { device, calls } = fakeDevice({
      tapOn: () => {
        if (refusals-- > 0)
          throw new Error(
            'tapOn: text="Jump to present": Element not actionable (last rejection: pointer-events-none)'
          )
        return { status: 'passed' }
      }
    })
    const surface = new ChromeSurface({
      device,
      page: { evaluate: async () => JSON.stringify(read()) },
      gameUrl: 'https://app.example.test/games/game_0000',
      sleep: noSleep
    })
    await surface.jumpToPresent()
    expect(calls.map(call => call[0])).deep.equals([
      'tapOn',
      'tapOnPoint',
      'tapOn'
    ])
    expect(calls[1][1]).deep.equals({ x: 540, y: 101 })
    refusals = 5
    expect(
      await surface.jumpToPresent().then(
        () => '',
        (e: unknown) => (e as Error).message
      )
    ).match(/not actionable/)
    const missing = new ChromeSurface({
      device: fakeDevice({
        tapOn: () => {
          throw new Error('Element not found')
        }
      }).device,
      page: { evaluate: async () => JSON.stringify(read()) },
      gameUrl: 'https://app.example.test/games/game_0000',
      sleep: noSleep
    })
    expect(
      await missing.jumpToPresent().then(
        () => '',
        (e: unknown) => (e as Error).message
      )
    ).equals('Element not found')
  })

  it('rejoins a player it finds closed, notes it, and says when it stays closed', async function () {
    // The game page: no angle tiles, then the player once rejoined.
    const { surface, calls } = chrome([read({}, { tiles: [] }), read()])
    await surface.skip([10])
    expect(calls.map(call => call[0]).slice(0, 2)).deep.equals([
      'openLink',
      'tapOn'
    ])
    expect(calls.filter(call => call[0] === 'tapOnPoint')).length(1)
    expect(surface.takeNotes()).deep.equals([
      'rejoined: the full-screen player was not up'
    ])
    const closed = chrome([read({}, { tiles: [] })])
    expect(
      await closed.surface.jumpToPresent().then(
        () => '',
        (e: unknown) => (e as Error).message
      )
    ).equals('chrome: the full-screen player is not up')
  })

  it('finds the block of videos only on a page that says its size', function () {
    expect(pageBlock(read())).deep.equals({
      x: 0,
      y: 0,
      width: 1440,
      height: 810
    })
    expect(pageBlock({ ...read(), viewport: undefined })).equals(null)
    expect(
      pageBlock(
        read({
          PhoneA: { rect: undefined },
          PhoneB: { rect: undefined },
          Synthetic: { rect: undefined }
        })
      )
    ).equals(null)
  })
})
