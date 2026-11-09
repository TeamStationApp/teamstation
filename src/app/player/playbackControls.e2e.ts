/**
 * Issue 239 through the real Videos route and 1–4 full-screen layouts.
 * Uses the playerLayouts fixture/server and MAESTRO_D environment documented
 * in playerLayouts.e2e.ts. Run:
 *   npx mocha -r sucrase/register --extension ts --timeout 900000 \
 *     src/app/player/playbackControls.e2e.ts
 * TS_CONTROLS_CAPTURE=before captures the integration build without assertions.
 * Maestro drives every tap and swipe; Puppeteer reads state and records video.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, describe, it } from 'mocha'

import {
  artifacts,
  finish,
  fixture,
  GRID_VIDEOS,
  open,
  pause,
  shot,
  type WebSession,
  webSession
} from './playerLayoutsRig.e2e'

interface Driver {
  pressKey: (args: { key: string }) => Promise<unknown>
  tapOnPoint: (args: {
    x: number
    y: number
    waitToSettleTimeoutMs?: number
  }) => Promise<unknown>
  dragAndDrop: (args: {
    from: { point: string }
    to: { point: string }
    holdDuration: number
    duration: number
  }) => Promise<unknown>
  takeScreenshot: (args: { path: string }) => Promise<unknown>
}
interface Box {
  x: number
  y: number
  w: number
  h: number
}
interface State {
  time: number
  muted: boolean
  paused: boolean
  icons: boolean
  line: boolean
  seeks: number
}
const before = process.env.TS_CONTROLS_CAPTURE === 'before'
const videos = (full: boolean): string =>
  full ? GRID_VIDEOS : "[...document.querySelectorAll('#root video')]"
const find = (selector: string, full: boolean): string =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(n => (n.closest('#root') == null) === ${full})`
async function rect(
  s: WebSession,
  selector: string,
  full: boolean
): Promise<Box> {
  return await s.page.evaluate(
    (selector, full) => {
      const node = [...document.querySelectorAll(selector)].find(
        one => (one.closest('#root') == null) === full
      )
      if (node == null) throw new Error(`Missing playback control: ${selector}`)
      const r = node.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    },
    selector,
    full
  )
}
async function state(s: WebSession, full: boolean): Promise<State> {
  return (await s.page.evaluate(`(() => {
    const v = ${videos(full)}[0];
    const icon = ${find('[data-testid="zoneIcon-replay_10"]', full)};
    const line = ${find(full ? '[aria-label="Position in the game"]' : '[data-testid="gameVideoScrubLine"]', full)};
    return {time:v.currentTime,muted:v.muted,paused:v.paused,seeks:(window.__seeks.get(v)||[]).length,
      icons:icon.parentElement.style.opacity==='1',
      line:${full ? "line.closest('[aria-hidden]').getAttribute('aria-hidden')==='false'" : "line.style.opacity==='1'"}};
  })()`)) as State
}
async function tap(s: WebSession, x: number, y: number): Promise<void> {
  await (s.m as unknown as Driver).tapOnPoint({
    x: Math.round(x),
    y: Math.round(y),
    waitToSettleTimeoutMs: 0
  })
}
async function at(s: WebSession, b: Box, x = 0.5, y = 0.5): Promise<void> {
  await tap(s, b.x + b.w * x, b.y + b.h * y)
}
async function hold(s: WebSession, b: Box): Promise<void> {
  const point = `${Math.round(b.x + b.w / 2)},${Math.round(b.y + b.h / 2)}`
  await (s.m as unknown as Driver).dragAndDrop({
    from: { point },
    to: { point },
    holdDuration: 2300,
    duration: 1
  })
}
async function drag(s: WebSession, b: Box): Promise<void> {
  await (s.m as unknown as Driver).dragAndDrop({
    from: {
      point: `${Math.round(b.x + b.w * 0.8)},${Math.round(b.y + b.h * 0.5)}`
    },
    to: {
      point: `${Math.round(b.x + b.w * 0.3)},${Math.round(b.y + b.h * 0.5)}`
    },
    holdDuration: 1,
    duration: 300
  })
}
async function ready(
  s: WebSession,
  full: boolean,
  count: number
): Promise<void> {
  await s.page.waitForFunction(
    `(() => {const v=${videos(full)}; return v.length===${count} && v.every(n=>n.readyState>=2)})()`,
    { timeout: 60000 }
  )
}
async function capture(s: WebSession, name: string): Promise<void> {
  if (artifacts == null) return
  mkdirSync(artifacts, { recursive: true })
  await (s.m as unknown as Driver).takeScreenshot({
    path: join(artifacts, `${name}-${before ? 'before' : 'after'}.png`)
  })
}
async function session(
  name: string,
  width: number,
  height: number
): Promise<WebSession> {
  const s = await webSession(name, width, height)
  // The web Maestro driver emits mouse input. For the touch scenarios, mark
  // its pointer motion as touch so positioning a tap does not first hover-
  // reveal the controls. Down/up and drags still travel through the real UI.
  // Native reliability separately exercises actual phone touches.
  await s.page
    .evaluateOnNewDocument(`document.addEventListener('pointermove', event => {
    if (window.__touchControls !== false) Object.defineProperty(event,'pointerType',{value:'touch'});
  },true)`)
  return s
}

describe('playback control visibility', function () {
  after(finish)
  it('starts playback when Videos is selected from another event tab', async function () {
    if (before) return
    const s = await session('videos-autoplay', 402, 874)
    const recording =
      artifacts == null
        ? undefined
        : await s.page.screencast({
            path: join(artifacts, 'videos-autoplay.mp4') as `${string}.mp4`,
            format: 'mp4'
          })
    const select = async (label: string): Promise<void> => {
      const selector = `[aria-label="Game sections"] [aria-label="${label}"]`
      await s.page.waitForSelector(selector)
      await at(s, await rect(s, selector, false))
    }
    const advancing = async (): Promise<number> => {
      await ready(s, false, 1)
      const time = (await state(s, false)).time
      await s.page.waitForFunction(
        `(() => {const v=document.querySelector('#root video');return !v.paused && v.currentTime>${time + 0.5}})()`,
        { timeout: 30000 }
      )
      return (await state(s, false)).time
    }
    try {
      await open(s, `/games/${fixture().games.S.id}?tab=boxScore`)
      await pause(1000)
      await select('Videos')
      await advancing()
      await pause(1000)
      await shot(s, 'videos-autoplay-after.png')
      for (const tab of ['Info', 'Box score']) {
        const middle = await rect(s, '[data-testid="zoneIcon-pause"]', false)
        await at(s, middle)
        const paused = await state(s, false)
        expect(paused.paused, 'viewer pauses before leaving').equals(true)
        await select(tab)
        await select('Videos')
        const resumed = await advancing()
        expect(resumed, 'tab entry retains the saved position').at.least(
          paused.time - 0.5
        )
      }
      await open(s, `/games/${fixture().games.V.id}?tab=boxScore`)
      await select('Videos')
      await advancing()
    } finally {
      await recording?.stop()
    }
  })
  for (const [width, height] of [
    [402, 874],
    [874, 402]
  ]) {
    for (const count of [0, 1, 2, 3, 4]) {
      it(`${count === 0 ? 'Videos' : `${count} angles`} at ${width}x${height}`, async function () {
        const s = await session(`controls-${count}-${width}`, width, height)
        const S = fixture().games.S
        const full = count !== 0
        const path = full
          ? `/games/${S.id}?angles=${S.videos.slice(0, count).join(',')}&audio=${S.videos[0]}&t=35`
          : `/games/${S.id}?tab=watch&t=35`
        await open(s, path)
        await ready(s, full, Math.max(1, count))
        const middle = await rect(
          s,
          '[data-testid="zoneIcon-play_arrow"], [data-testid="zoneIcon-pause"]',
          full
        )
        const reveal = await rect(
          s,
          '[data-testid="zoneIcon-volume_off"], [data-testid="zoneIcon-volume_up"]',
          full
        )
        if (!(await state(s, full)).paused) await at(s, middle)
        await pause(250)
        const scrub = await rect(
          s,
          full
            ? '[aria-label="Position in the game"]'
            : '[data-testid="gameVideoScrubLine"]',
          full
        )
        // At the actual icon, so its placement around the board is covered.
        await at(s, reveal)
        if (width === 402)
          await capture(s, count === 0 ? 'videos' : `fullscreen${count}`)
        if (before) return
        expect((await state(s, full)).icons).equals(true)
        expect((await state(s, full)).line).equals(true)
        await pause(2300)
        expect((await state(s, full)).icons).equals(false)
        expect((await state(s, full)).line).equals(false)
        let prior = await state(s, full)
        await at(s, scrub, 0.7)
        let next = await state(s, full)
        expect(next.seeks, 'hidden scrub tap').equals(prior.seeks)
        expect(next.time, 'hidden scrub position').closeTo(prior.time, 0.15)
        expect(next.icons && next.line, 'both revealed').equals(true)
        await at(s, scrub, 0.7)
        await pause(300)
        expect((await state(s, full)).seeks, 'visible scrub tap').greaterThan(
          prior.seeks
        )
        await pause(2300)
        prior = await state(s, full)
        await drag(s, scrub)
        next = await state(s, full)
        expect(next.seeks, 'hidden scrub drag').equals(prior.seeks)
        await drag(s, scrub)
        await pause(300)
        expect((await state(s, full)).seeks, 'visible scrub drag').greaterThan(
          prior.seeks
        )
        await pause(2300)
        prior = await state(s, full)
        await at(s, reveal)
        expect((await state(s, full)).muted, 'hidden audio').equals(prior.muted)
        await at(s, reveal)
        expect((await state(s, full)).muted, 'visible audio').equals(
          !prior.muted
        )
        // A mouse hover refreshes both controls; it does not remove the line.
        await s.page.evaluate('window.__touchControls=false')
        await s.page.mouse.move(
          middle.x + middle.w / 2,
          middle.y + middle.h / 2
        )
        expect(
          (await state(s, full)).icons && (await state(s, full)).line
        ).equals(true)
        await s.page.evaluate('window.__touchControls=true')
        const corner = await rect(
          s,
          full ? '[aria-label="Close"]' : '[data-testid="gameVideoOpen"]',
          full
        )
        await pause(2300)
        await at(s, corner)
        expect(
          await s.page.evaluate(`${GRID_VIDEOS}.length`),
          'hidden corner'
        ).equals(count)
        // A visible button held beyond the hide deadline still activates.
        await hold(s, corner)
        await s.page.waitForFunction(
          `${GRID_VIDEOS}.length ${full ? '===' : '>'} 0`,
          { timeout: 10000 }
        )
      })
    }
  }

  it('shows jump only for live video and returns card/grid to a fresh playable edge', async function () {
    if (before) return
    const s = await session('controls-live', 874, 402)
    const { V, S } = fixture().games
    await open(s, `/games/${S.id}?tab=watch&t=10`)
    await ready(s, false, 1)
    expect(await s.page.$('[data-testid="jumpToPresent"]')).equals(null)
    const recording =
      artifacts == null
        ? undefined
        : await s.page.screencast({
            path: join(artifacts, 'playback-controls.mp4') as `${string}.mp4`,
            format: 'mp4'
          })
    try {
      for (const full of [false, true]) {
        await open(
          s,
          full
            ? `/games/${V.id}?angles=${V.videos.join(',')}&audio=${V.videos[0]}&t=10`
            : `/games/${V.id}?tab=watch&t=10`
        )
        await ready(s, full, full ? V.videos.length : 1)
        await s.page.waitForFunction(
          `${find('[data-testid="jumpToPresent"]', full)} != null`,
          { timeout: 60000 }
        )
        const jump = await rect(s, '[data-testid="jumpToPresent"]', full)
        const middle = await rect(
          s,
          '[data-testid="zoneIcon-play_arrow"], [data-testid="zoneIcon-pause"]',
          full
        )
        if (!(await state(s, full)).paused) await at(s, middle)
        // Live links open near live; deliberately rewind before testing return.
        const back = await rect(s, '[data-testid="zoneIcon-replay_10"]', full)
        for (let step = 0; step < 6; step++) {
          await at(s, back)
          await pause(100)
        }
        await pause(2300)
        const prior = await state(s, full)
        await at(s, jump)
        expect((await state(s, full)).seeks, 'hidden live jump').equals(
          prior.seeks
        )
        await hold(s, jump)
        await pause(500)
        const next = await state(s, full)
        expect(next.time, 'jump advances toward present').greaterThan(
          prior.time + 5
        )
        await s.page.waitForFunction(
          `(() => { const v=${videos(full)}[0];return !v.seeking && v.readyState>=2 })()`,
          { timeout: 30000 }
        )
        // Refresh the interval with a real hover so the controls cannot
        // expire while the screenshot waits for fonts and paint.
        await s.page.evaluate('window.__touchControls=false')
        await s.page.mouse.move(
          middle.x + middle.w / 2,
          middle.y + middle.h / 2
        )
        await shot(
          s,
          full ? 'live-fullscreen-after.png' : 'live-videos-after.png'
        )
        await s.page.evaluate('window.__touchControls=true')
      }
    } finally {
      await recording?.stop()
    }
  })
  for (const key of ['ENTER', 'SPACE'])
    it(`reveals hidden controls and opens fullscreen using only the keyboard (${key})`, async function () {
      if (before) return
      const s = await session(`controls-keyboard-${key}`, 874, 402)
      await open(s, `/games/${fixture().games.S.id}?tab=watch&t=35`)
      await ready(s, false, 1)
      await pause(2300)
      const focused = async (): Promise<boolean> =>
        (await s.page.evaluate(
          `document.activeElement?.getAttribute('data-testid') === 'gameVideoOpen'`
        )) === true
      for (let tabs = 0; tabs < 40 && !(await focused()); tabs++)
        await (s.m as unknown as Driver).pressKey({ key: 'TAB' })
      expect(
        await focused(),
        'hidden fullscreen remains in the tab order'
      ).equals(true)
      expect((await state(s, false)).icons).equals(false)
      await (s.m as unknown as Driver).pressKey({ key })
      expect((await state(s, false)).icons).equals(true)
      expect(await s.page.evaluate(`${GRID_VIDEOS}.length`)).equals(0)
      await (s.m as unknown as Driver).pressKey({ key })
      await s.page.waitForFunction(`${GRID_VIDEOS}.length > 0`, {
        timeout: 10000
      })
    })
})
