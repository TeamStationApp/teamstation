/**
 * The player-layouts proving screenshots of the web app, before and after.
 *
 *   MAESTRO_D=<daemon> MAESTRO_D_BIN=… MAESTRO_D_CLIENT_ROOT=… \
 *   TS_PLAYER_APP=<app origin> TS_PLAYER_FIXTURE=<fixture.json> \
 *   TS_E2E_ARTIFACT_DIR=/path/to/artifacts \
 *     node -r sucrase/register scripts/e2e/playerLayouts/capture.ts \
 *       [--before] [--only <name>,…]
 *
 * Each shot opens one state of the fixture's games at one window size and
 * saves `<name>-before.png` with `--before` (run against the base build and
 * its server) or `<name>-after.png` without; a shot with no before state
 * saves `<name>.png`. The same games, sizes and moments either way, so a
 * pair differs only by the code.
 */
import { parseArgs } from 'node:util'

import {
  finish,
  fixture,
  GRID_VIDEOS,
  open,
  print,
  shot,
  type WebSession,
  webSession
} from '../../../e2e/rigs/playerLayoutsRig'

const { values } = parseArgs({
  options: {
    before: { type: 'boolean', default: false },
    only: { type: 'string' }
  }
})

interface Shot {
  name: string
  size: [number, number]
  /** A pair: taken before and after. */
  paired: boolean
  /** Not in the base build: only after. */
  afterOnly?: boolean
  path: () => string
  ready: (session: WebSession) => Promise<void>
  before?: (session: WebSession) => Promise<void>
}

const f = fixture()
const S = f.games.S
const L = f.games.L
/** A moment in the take, a minute in, when the board has a few innings. */
const AT = 60

async function inlineReady(session: WebSession): Promise<void> {
  await session.page.waitForFunction(
    `(() => { const v = document.querySelector('#root video'); return v != null && v.readyState >= 2 })()`,
    { timeout: 60_000 }
  )
}
function gridReady(count: number) {
  return async (session: WebSession): Promise<void> => {
    await session.page.waitForFunction(
      `(() => { const v = ${GRID_VIDEOS}; return v.length === ${count} && v.every(one => one.readyState >= 2) })()`,
      { timeout: 60_000 }
    )
    // Paused where it opened, so the pair shows the same frame.
    await session.page.evaluate(
      `(() => { for (const v of ${GRID_VIDEOS}) v.pause() })()`
    )
  }
}
const grid = (game: typeof S, count: number): string =>
  `/games/${game.id}?angles=${game.videos.slice(0, count).join(',')}&audio=${game.videos[0]}&t=${AT}`

const shots: Shot[] = [
  {
    name: 'web-inline-portrait',
    size: [402, 874],
    paired: true,
    path: () => `/games/${S.id}?tab=watch&video=${S.videos[1]}&t=${AT}`,
    ready: inlineReady
  },
  ...([1, 2, 3, 4] as const).flatMap(count => [
    {
      name: `web-portrait-${count}`,
      size: [402, 874] as [number, number],
      paired: true,
      path: () => grid(S, count),
      ready: gridReady(count)
    },
    {
      name: `web-landscape-${count}`,
      size: [874, 402] as [number, number],
      paired: true,
      path: () => grid(S, count),
      ready: gridReady(count)
    }
  ]),
  {
    name: 'web-landscape-2-logonly',
    size: [874, 402],
    paired: false,
    afterOnly: true,
    path: () => grid(L, 2),
    ready: gridReady(2)
  },
  {
    name: 'web-portrait-2-logonly',
    size: [402, 874],
    paired: false,
    afterOnly: true,
    path: () => grid(L, 2),
    ready: gridReady(2)
  },
  {
    name: 'web-bar',
    size: [1280, 720],
    paired: true,
    path: () => grid(S, 2),
    ready: async session => {
      await gridReady(2)(session)
      // The bar comes up for the pointer over the bottom of the grid.
      await session.page.mouse.move(640, 700)
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  },
  {
    name: 'web-unsupported',
    size: [1280, 720],
    paired: true,
    path: () => `/games/${S.id}?tab=watch&video=${S.videos[0]}`,
    // Chrome without HEVC: Media Source says no to `hvc1` alone, and the
    // browser's own answers stand for everything else.
    before: async session => {
      await session.page.evaluateOnNewDocument(`(() => {
        const supported = MediaSource.isTypeSupported.bind(MediaSource)
        MediaSource.isTypeSupported = type => !/hvc1|hev1/.test(type) && supported(type)
      })()`)
    },
    ready: async () => {
      await new Promise(resolve => setTimeout(resolve, 8000))
    }
  }
]

async function main(): Promise<void> {
  const only = values.only?.split(',')
  for (const one of shots) {
    if (only != null && !only.includes(one.name)) continue
    if (values.before && one.afterOnly === true) continue
    const file = one.paired
      ? `${one.name}-${values.before ? 'before' : 'after'}.png`
      : `${one.name}.png`
    const session = await webSession(one.name, one.size[0], one.size[1])
    await one.before?.(session)
    await open(session, one.path())
    try {
      await one.ready(session)
      await shot(session, file)
    } catch (error) {
      print(`${one.name}: ${String(error)}`)
      process.exitCode = 1
    }
  }
  await finish()
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
