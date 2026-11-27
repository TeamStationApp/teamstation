import { expect } from 'chai'

import { defineHarness, type HarnessContext } from '../../../core/spec'
import {
  GRID_VIDEOS,
  gridPath,
  open,
  pause,
  type PlayerGame,
  type PlayerWeb,
  playerWeb,
  playerWorld,
  recordedGames,
  shot
} from './games'

/**
 * The player-layouts proving pictures of the web app: one state of the
 * games at one window size each, the same games, sizes and moments every
 * run, kept in the run directory as `<name>-after.png` (`<name>.png` for a
 * shot with no before). Each shot waits for what it shows, and the scenario
 * fails naming every shot whose state never came.
 */

/** A moment in the take, a minute in, when the board has a few innings. */
const AT = 60

interface Shot {
  name: string
  size: [number, number]
  /** A pair: the base build has a before. */
  paired: boolean
  path: (games: Record<'S' | 'L', PlayerGame>) => string
  ready: (web: PlayerWeb) => Promise<void>
}

async function inlineReady(web: PlayerWeb): Promise<void> {
  await web.page.waitForFunction(
    `(() => { const v = document.querySelector('#root video'); return v != null && v.readyState >= 2 })()`,
    { timeout: 60_000 }
  )
}

function gridReady(count: number) {
  return async (web: PlayerWeb): Promise<void> => {
    await web.page.waitForFunction(
      `(() => { const v = ${GRID_VIDEOS}; return v.length === ${count} && v.every(one => one.readyState >= 2) })()`,
      { timeout: 60_000 }
    )
    // Held where it opened, so every run shows the same frame: each tile's
    // pause control, which a viewer taps, until none plays.
    for (let tries = 0; tries < 3; tries++) {
      const playing = (await web.page.evaluate(
        `${GRID_VIDEOS}.some(v => !v.paused)`
      )) as boolean
      if (!playing) return
      const at = (await web.page.evaluate(`(() => {
        const icon = [...document.querySelectorAll('[data-testid="zoneIcon-pause"]')].find(n => n.closest('#root') == null)
        if (icon == null) return null
        const r = icon.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })()`)) as { x: number; y: number } | null
      if (at != null)
        await web.m.tapOnPoint({ x: Math.round(at.x), y: Math.round(at.y) })
      await pause(400)
    }
  }
}

const SHOTS: Shot[] = [
  {
    name: 'web-inline-portrait',
    size: [402, 874],
    paired: true,
    path: ({ S }) => `/games/${S.id}?tab=watch&video=${S.videos[1]}&t=${AT}`,
    ready: inlineReady
  },
  ...([1, 2, 3, 4] as const).flatMap(count => [
    {
      name: `web-portrait-${count}`,
      size: [402, 874] as [number, number],
      paired: true,
      path: ({ S }: Record<'S' | 'L', PlayerGame>) => gridPath(S, count, AT),
      ready: gridReady(count)
    },
    {
      name: `web-landscape-${count}`,
      size: [874, 402] as [number, number],
      paired: true,
      path: ({ S }: Record<'S' | 'L', PlayerGame>) => gridPath(S, count, AT),
      ready: gridReady(count)
    }
  ]),
  {
    name: 'web-landscape-2-logonly',
    size: [874, 402],
    paired: false,
    path: ({ L }) => gridPath(L, 2, AT),
    ready: gridReady(2)
  },
  {
    name: 'web-portrait-2-logonly',
    size: [402, 874],
    paired: false,
    path: ({ L }) => gridPath(L, 2, AT),
    ready: gridReady(2)
  },
  {
    name: 'web-bar',
    size: [1280, 720],
    paired: true,
    path: ({ S }) => gridPath(S, 2, AT),
    ready: async web => {
      await gridReady(2)(web)
      // The bar comes up for the pointer at the bottom of the grid.
      await web.m.tapOnPoint({ x: 640, y: 700 })
      await pause(500)
    }
  }
]

async function shots(ctx: HarnessContext): Promise<void> {
  const pw = await playerWorld(ctx)
  const { games } = await recordedGames(pw, ['S', 'L'], { quick: true })
  const both = games as Record<'S' | 'L', PlayerGame>
  const web = await playerWeb(pw, 402, 874)
  const failed: string[] = []
  for (const one of SHOTS) {
    await web.session.resize({ width: one.size[0], height: one.size[1] })
    await open(web, one.path(both))
    try {
      await one.ready(web)
      await shot(web, one.paired ? `${one.name}-after.png` : `${one.name}.png`)
    } catch (error) {
      pw.say(`${one.name}: ${String(error)}`)
      failed.push(one.name)
    }
  }
  expect(failed, 'shots whose state never came').deep.equals([])
}

async function unsupported(ctx: HarnessContext): Promise<void> {
  const pw = await playerWorld(ctx)
  const { games } = await recordedGames(pw, ['S'], { quick: true })
  const S = games.S!
  // Chrome without HEVC: Media Source says no to `hvc1` alone, and the
  // browser's own answers stand for everything else.
  const web = await playerWeb(pw, 1280, 720, {
    beforeLoad: `(() => {
      const supported = MediaSource.isTypeSupported.bind(MediaSource)
      MediaSource.isTypeSupported = type => !/hvc1|hev1/.test(type) && supported(type)
    })()`
  })
  await open(web, `/games/${S.id}?tab=watch&video=${S.videos[0]}`)
  await pause(8000)
  await shot(web, 'web-unsupported-after.png')
}

export default defineHarness({
  id: 'playback/player-layouts/screens',
  title: 'The player layouts, pictured at each window size and angle count',
  kind: 'e2e',
  covers: [
    'src/app/player/multiCam/**',
    'src/app/player/scoreboardOverlay/**',
    'src/app/player/MultiCamView.tsx'
  ],
  stack: 'isolated',
  fixtures: ['player-layouts'],
  exclusive: false,
  surfaces: {
    // The stack's recordings are HEVC: Chrome for Testing on the Mac.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['video'], codecs: ['hevc'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 20,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    shots,
    'unsupported-shot': unsupported
  }
})
