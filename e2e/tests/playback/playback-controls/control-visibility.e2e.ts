import { expect } from 'chai'

import {
  defineHarness,
  type HarnessContext,
  type HarnessScenario
} from '../../../core/spec'
import {
  type Box,
  GRID_VIDEOS,
  gridPath,
  liveGame,
  open,
  pause,
  type PlayerWeb,
  playerWeb,
  playerWorld,
  recordedGames,
  rectOf,
  shot,
  tapIn
} from '../player-layouts/games'

/**
 * Issue 239 through the real Videos route and the 1–4 angle full-screen
 * layouts: the controls show for a tap and hide after a while, a tap or a
 * drag on hidden controls only shows them, and a live video alone offers
 * Jump to present. Every tap, drag and key is maestro-d's; the page is only
 * read. The pointer reads as a finger's (`playerBeforeLoad`'s
 * `touchPointer`), so placing a tap does not first hover-reveal the
 * controls; down, up and drags still travel through the real UI.
 */

interface State {
  time: number
  muted: boolean
  paused: boolean
  icons: boolean
  line: boolean
  seeks: number
}

const videos = (full: boolean): string =>
  full ? GRID_VIDEOS : "[...document.querySelectorAll('#root video')]"
const find = (selector: string, full: boolean): string =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(n => (n.closest('#root') == null) === ${full})`

async function rect(
  s: PlayerWeb,
  selector: string,
  full: boolean
): Promise<Box> {
  return await rectOf(s.page, selector, { full })
}

async function state(s: PlayerWeb, full: boolean): Promise<State> {
  return (await s.page.evaluate(`(() => {
    const v = ${videos(full)}[0];
    const icon = ${find('[data-testid="zoneIcon-replay_10"]', full)};
    const line = ${find(full ? '[aria-label="Position in the game"]' : '[data-testid="gameVideoScrubLine"]', full)};
    return {time:v.currentTime,muted:v.muted,paused:v.paused,seeks:(window.__seeks.get(v)||[]).length,
      icons:icon.parentElement.style.opacity==='1',
      line:${full ? "line.closest('[aria-hidden]').getAttribute('aria-hidden')==='false'" : "line.style.opacity==='1'"}};
  })()`)) as State
}

async function hold(s: PlayerWeb, b: Box): Promise<void> {
  const point = `${Math.round(b.x + b.w / 2)},${Math.round(b.y + b.h / 2)}`
  await s.m.dragAndDrop({
    from: { point },
    to: { point },
    holdDuration: 2300,
    duration: 1
  })
}

async function drag(s: PlayerWeb, b: Box): Promise<void> {
  await s.m.dragAndDrop({
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
  s: PlayerWeb,
  full: boolean,
  count: number
): Promise<void> {
  await s.page.waitForFunction(
    `(() => {const v=${videos(full)}; return v.length===${count} && v.every(n=>n.readyState>=2)})()`,
    { timeout: 60000 }
  )
}

async function session(
  ctx: HarnessContext,
  width: number,
  height: number
): Promise<{ s: PlayerWeb; pw: Awaited<ReturnType<typeof playerWorld>> }> {
  const pw = await playerWorld(ctx)
  return { pw, s: await playerWeb(pw, width, height, { touchPointer: true }) }
}

async function videosAutoplay(ctx: HarnessContext): Promise<void> {
  const { pw, s } = await session(ctx, 402, 874)
  const { games } = await recordedGames(pw, ['S'], { quick: true })
  const live = await liveGame(pw)
  try {
    const S = games.S!
    await s.m.startRecording({ path: ctx.artifact('videos-autoplay.mp4') })
    const select = async (label: string): Promise<void> => {
      const selector = `[aria-label="Game sections"] [aria-label="${label}"]`
      await s.page.waitForSelector(selector)
      await tapIn(s, await rect(s, selector, false))
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
      await open(s, `/games/${S.id}?tab=boxScore`)
      await pause(1000)
      await select('Videos')
      await advancing()
      await pause(1000)
      await shot(s, 'videos-autoplay-after.png')
      for (const tab of ['Info', 'Box score']) {
        const middle = await rect(s, '[data-testid="zoneIcon-pause"]', false)
        await tapIn(s, middle)
        const paused = await state(s, false)
        expect(paused.paused, 'viewer pauses before leaving').equals(true)
        await select(tab)
        await select('Videos')
        const resumed = await advancing()
        expect(resumed, 'tab entry retains the saved position').at.least(
          paused.time - 0.5
        )
      }
      await open(s, `/games/${live.id}?tab=boxScore`)
      await select('Videos')
      await advancing()
    } finally {
      await s.m.stopRecording()
    }
  } finally {
    await live.stop()
  }
}

function controls(count: number, width: number, height: number) {
  return async (ctx: HarnessContext): Promise<void> => {
    const { pw, s } = await session(ctx, width, height)
    const { games } = await recordedGames(pw, ['S'], { quick: true })
    const S = games.S!
    const full = count !== 0
    const path = full ? gridPath(S, count, 35) : `/games/${S.id}?tab=watch&t=35`
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
    if (!(await state(s, full)).paused) await tapIn(s, middle)
    await pause(250)
    const scrub = await rect(
      s,
      full
        ? '[aria-label="Position in the game"]'
        : '[data-testid="gameVideoScrubLine"]',
      full
    )
    // At the actual icon, so its placement around the board is covered.
    await tapIn(s, reveal)
    if (width === 402)
      await s.shot(`${count === 0 ? 'videos' : `fullscreen${count}`}-after.png`)
    expect((await state(s, full)).icons).equals(true)
    expect((await state(s, full)).line).equals(true)
    await pause(2300)
    expect((await state(s, full)).icons).equals(false)
    expect((await state(s, full)).line).equals(false)
    let prior = await state(s, full)
    await tapIn(s, scrub, 0.7)
    let next = await state(s, full)
    expect(next.seeks, 'hidden scrub tap').equals(prior.seeks)
    expect(next.time, 'hidden scrub position').closeTo(prior.time, 0.15)
    expect(next.icons && next.line, 'both revealed').equals(true)
    await tapIn(s, scrub, 0.7)
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
    await tapIn(s, reveal)
    expect((await state(s, full)).muted, 'hidden audio').equals(prior.muted)
    await tapIn(s, reveal)
    expect((await state(s, full)).muted, 'visible audio').equals(!prior.muted)
    // A mouse hover refreshes both controls; it does not remove the line.
    // The pointer reads as a mouse's while it hovers, as it is one.
    await s.m.evalBrowserScript({ script: 'window.__touchControls = false' })
    await s.m.hoverOn({
      point: `${Math.round(middle.x + middle.w / 2)},${Math.round(middle.y + middle.h / 2)}`
    })
    expect(
      (await state(s, full)).icons && (await state(s, full)).line,
      'a hover refreshes both controls'
    ).equals(true)
    await s.m.evalBrowserScript({ script: 'window.__touchControls = true' })
    const corner = await rect(
      s,
      full ? '[aria-label="Close"]' : '[data-testid="gameVideoOpen"]',
      full
    )
    await pause(2300)
    await tapIn(s, corner)
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
  }
}

async function liveJump(ctx: HarnessContext): Promise<void> {
  const { pw, s } = await session(ctx, 874, 402)
  const { games } = await recordedGames(pw, ['S'], { quick: true })
  const S = games.S!
  const V = await liveGame(pw)
  try {
    await open(s, `/games/${S.id}?tab=watch&t=10`)
    await ready(s, false, 1)
    expect(
      await s.page.evaluate(
        `document.querySelector('[data-testid="jumpToPresent"]') != null`
      )
    ).equals(false)
    await s.m.startRecording({ path: ctx.artifact('playback-controls.mp4') })
    try {
      for (const full of [false, true]) {
        await open(
          s,
          full
            ? gridPath(V, V.videos.length, 10)
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
        if (!(await state(s, full)).paused) await tapIn(s, middle)
        // Live links open near live; deliberately rewind before testing return.
        const back = await rect(s, '[data-testid="zoneIcon-replay_10"]', full)
        for (let step = 0; step < 6; step++) {
          await tapIn(s, back)
          await pause(100)
        }
        await pause(2300)
        const prior = await state(s, full)
        await tapIn(s, jump)
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
        // The held jump left the controls up: the picture with them.
        await shot(
          s,
          full ? 'live-fullscreen-after.png' : 'live-videos-after.png'
        )
      }
    } finally {
      await s.m.stopRecording()
    }
  } finally {
    await V.stop()
  }
}

function keyboard(key: 'enter' | 'space') {
  return async (ctx: HarnessContext): Promise<void> => {
    const { pw, s } = await session(ctx, 874, 402)
    const { games } = await recordedGames(pw, ['S'], { quick: true })
    await open(s, `/games/${games.S!.id}?tab=watch&t=35`)
    await ready(s, false, 1)
    await pause(2300)
    const focused = async (): Promise<boolean> =>
      (await s.page.evaluate(
        `document.activeElement?.getAttribute('data-testid') === 'gameVideoOpen'`
      )) === true
    for (let tabs = 0; tabs < 40 && !(await focused()); tabs++)
      await s.m.pressKey({ key: 'tab' })
    expect(
      await focused(),
      'hidden fullscreen remains in the tab order'
    ).equals(true)
    expect((await state(s, false)).icons).equals(false)
    await s.m.pressKey({ key })
    expect((await state(s, false)).icons).equals(true)
    expect(await s.page.evaluate(`${GRID_VIDEOS}.length`)).equals(0)
    await s.m.pressKey({ key })
    await s.page.waitForFunction(`${GRID_VIDEOS}.length > 0`, {
      timeout: 10000
    })
  }
}

const sizeScenarios: Record<string, HarnessScenario> = {}
for (const [width, height] of [
  [402, 874],
  [874, 402]
] as const)
  for (const count of [0, 1, 2, 3, 4])
    sizeScenarios[
      `${count === 0 ? 'videos' : `angles-${count}`}-${width}x${height}`
    ] = controls(count, width, height)

export default defineHarness({
  id: 'playback/playback-controls/control-visibility',
  title:
    'Playback controls show for a tap, hide again, ignore a tap or drag while hidden, and offer Jump to present only live',
  kind: 'e2e',
  covers: [
    'src/app/player/ZoneIcons.tsx',
    'src/app/player/zones.ts',
    'src/app/player/controlGeometry.ts',
    'src/app/player/cardScrub.ts',
    'src/app/player/stillLive.ts',
    'src/app/player/multiCam/barParts.tsx'
  ],
  stack: 'isolated',
  fixtures: ['player-layouts'],
  exclusive: false,
  surfaces: {
    // The stack's recordings and live angles are HEVC: Chrome for Testing on the Mac.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['video'], codecs: ['hevc'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 90,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'videos-autoplay': videosAutoplay,
    ...sizeScenarios,
    'live-jump': liveJump,
    'keyboard-enter': keyboard('enter'),
    'keyboard-space': keyboard('space')
  }
})
