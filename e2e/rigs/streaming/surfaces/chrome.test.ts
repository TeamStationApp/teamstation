import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  ChromeSurface,
  compareReads,
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
    ...overrides[angle]
  })
  return {
    tiles: [
      tile('PhoneA', 10, 300),
      tile('PhoneB', 10, 300),
      tile('Synthetic', 10, 300)
    ],
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
    expect(calls.map(call => (call[1] as { text: string }).text)).deep.equals([
      'Back ten seconds',
      'Back ten seconds',
      'Back ten seconds',
      'Forward ten seconds',
      'Forward ten seconds'
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
    expect(calls.map(call => call[0])).deep.equals([
      'tapOn',
      'tapOn',
      'tapOn',
      'tapOn',
      'tapOn',
      'evalBrowserScript',
      'tapOn',
      'tapOn'
    ])
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
})
