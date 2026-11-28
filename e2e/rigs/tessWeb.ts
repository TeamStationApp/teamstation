/* eslint-disable @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- Serialized browser callbacks cannot capture Sucrase's generated helper functions. */
import { expect } from 'chai'

import type { FakeCall } from '../../src/test/fakeAnthropic'
import { retryWhileBusy } from '../core/busyRetry'
import type { FixtureManifest } from '../core/fixtures'
import { eventually } from '../core/readback'
import { BlockedError } from '../core/result'
import type {
  E2eContext,
  HarnessSpec,
  HarnessStackHandle,
  StackControl,
  SurfaceNeeds,
  WebSession
} from '../core/spec'
import { toWire } from '../faults/standIns'
import { fakeMicrophone } from './fakeMicrophone'
import { stackMedia } from './media/stackSpace'

/**
 * Tess in this machine's browser, on the pool stack's web build: each
 * scenario seeds a `tess` world of its own, and the stack's stand-ins answer
 * as her model (a script) and her recogniser (one sentence), so nothing is
 * paid for. The UI is driven through maestro-d. `page` only reads, so every
 * wait here fails as a check, never as a browser timeout.
 */

/** The mark's menu, on a tab root. Ask Tess is a row inside it. */
export const MARK_MENU = '[role="button"][aria-label="TeamStation menu"]'
export const ASK_TESS = '[role="button"][aria-label="Ask Tess"]'
export const TESS_BUTTON = ASK_TESS
export const NOTIFICATIONS = '[role="button"][aria-label="Notifications"]'
export const COLUMN = '[data-testid="Tess column"]'
export const LAYER = '[data-testid="Tess layer"]'
export const CHAT = '[data-testid="Tess chat"]'
// The text field: the sidebar's Ask Tess (develop 30f330991) is a button.
export const FIELD = 'textarea[aria-label="Ask Tess"]'
export const THINKING = '[data-testid="Tess thinking"]'
export const MIC = '[role="button"][aria-label="Dictate"]'
export const DIVIDER = '[data-testid="Tess divider"]'
export const OPEN_FULL_SCREEN = '[role="button"][aria-label="Open full screen"]'
export const OVERLAY = '[data-testid="Tess overlay"]'
export const VIEWER = `${OVERLAY} [data-testid="Tess rich viewer"]`
export const VIEWER_CLOSE = `${OVERLAY} [role="button"][aria-label="Close"]`
/**
 * Team, season and league tiles, which the app tints by id (`teamTile.ts`):
 * the fixture's ids are new each run, so a golden leaves them out.
 */
// Every one drawn: maestro-d masks one element a selector finds.
export const EMBLEMS = [{ css: '[data-testid="emblem"]', every: true }]
/** A golden of a screen with the fixture's groups on it. */
export const TESS_GOLDEN = { mask: EMBLEMS }
export const SETTINGS_BUBBLE =
  '[role="link"][aria-label="Go to Home, Demo Hawks, Settings"]'

/** The caret blinks, which would move a golden of a focused field. */
const STEADY_CARET = `document.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style')
  style.textContent = '* { caret-color: transparent !important; }'
  document.head.appendChild(style)
})`

/** What every browser spec in this feature declares alike. */
export const TESS_WEB_SPEC: Pick<
  HarnessSpec,
  | 'kind'
  | 'stack'
  | 'fixtures'
  | 'exclusive'
  | 'surfaces'
  | 'services'
  | 'apps'
  | 'secrets'
  | 'costUsd'
  | 'guards'
  | 'manual'
> = {
  kind: 'e2e',
  stack: 'isolated',
  fixtures: ['tess'],
  exclusive: false,
  surfaces: {
    'web-chromium': { devices: [], browser: { role: 'browser', needs: [] } }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  guards: [],
  manual: false
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A 440 Hz tone, 16 kHz mono, as a base64 WAV, for the fake microphone. */
export function toneWav(seconds = 1.2): string {
  const rate = 16000
  const samples = Math.round(rate * seconds)
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++)
    buffer.writeInt16LE(
      Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)),
      44 + i * 2
    )
  return buffer.toString('base64')
}

export async function pause(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** What the stack's model, recogniser and beacon have seen since the scenario began. */
export interface TessStack {
  /** The `tess` world this scenario seeded. */
  world: FixtureManifest
  /** The world's groups, by the names the old fixture gave them. */
  f: {
    teamA: string
    teamB: string
    seasonA: string
    leagueA: string
    standaloneTeam: string
  }
  /** The six final games, oldest first, then the May 3 game and an open one. */
  games: { finals: string[]; may3: string; scheduled: string }
  /** The May 3 game's two camera angles, made on the stack for `video`. */
  videos: { firstBase: string; homePlate: string }
  /** The app paths the scripted answers link to. */
  links: { teamSettings: string; firstBaseAngle: string }
  /** The players' user ids: one the admin may see, and one they may not. */
  players: { visible: string; hidden: string }
  /** The scripted model's calls since the scenario began. */
  modelCalls: () => Promise<FakeCall[]>
  /** What those calls answered, summed as the model's own totals are. */
  modelTotals: () => Promise<ModelTotals>
  /** Utterances the microphone started since the scenario began, and what each was heard as. */
  dictation: () => Promise<{ begun: number; heard: string[] }>
  /** Hits on `/__tess/beacon` since the scenario began, which a remote load from rich HTML would make. */
  beaconHits: () => Promise<number>
  /** The stack's API, as `role` (the admin by default). */
  request: (
    method: string,
    path: string,
    body?: unknown,
    role?: string
  ) => Promise<Response>
}

export interface ModelTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  requests: number
}

export interface TessWeb {
  t: TessStack
  session: WebSession
  m: WebSession['m']
  page: WebSession['page']
  origin: string
  /** Becomes the world's `role` (the admin by default), by a session cookie. */
  identity: (role?: string) => Promise<void>
  open: (path: string, origin?: string) => Promise<void>
  /** Moves to a path without a page load, so an open chat stays open. */
  goInApp: (path: string) => Promise<void>
  see: (selector: string, timeout?: number) => Promise<void>
  gone: (selector: string, timeout?: number) => Promise<void>
  /** Waits for words on the screen. */
  shown: (words: string, timeout?: number) => Promise<void>
  tap: (selector: string) => Promise<void>
  /** Opens the chat from the header, and waits for what opens. */
  openChat: (opens?: string) => Promise<void>
  /** Types into the focused field, key by key. */
  type: (words: string) => Promise<void>
  /** Sends a message, and waits for the reply to finish. */
  say: (words: string, answered: string) => Promise<void>
  /** Selects what the field holds and deletes it. */
  clearField: () => Promise<void>
  fieldValue: () => Promise<string>
  rectOf: (selector: string) => Promise<Rect | null>
  /** The right pane: the element after Tess's column. */
  paneRect: () => Promise<Rect | null>
  /** Waits for the address's path. */
  pathIs: (path: string) => Promise<void>
  /** How many of the person's messages hold these words. */
  userBubbles: (words: string) => Promise<number>
  /** The dictation status line's words, or null while push-to-talk is off. */
  dictationStatus: () => Promise<string | null>
  waitForStatus: (words: string | null, timeoutMs?: number) => Promise<void>
}

/**
 * The web surface of a spec whose page does more: plays the fixture's HEVC
 * angles (`video`), or draws a 3D screen (`gpu`), which put its browser on
 * the Mac driving the runner.
 */
export function tessWebSurface(
  needs: Array<'video' | 'gpu'>
): Record<'web-chromium', SurfaceNeeds> {
  return {
    'web-chromium': {
      devices: [],
      browser: {
        role: 'browser',
        needs,
        ...(needs.includes('video') ? { codecs: ['hevc'] } : {})
      }
    }
  }
}

export interface TessWebOptions {
  /**
   * `tess: false` asks for a stack whose server has no Tess, which a pool
   * stack is not: such a scenario is blocked, naming that.
   */
  fixture?: { tess?: boolean }
  width?: number
  height?: number
  /** Leaves the browser's clock running, for what animates or measures time. */
  liveClock?: boolean
  /** Plays the May 3 game's two camera angles, which the stack makes first. */
  video?: boolean
}

/** The instant every pinned scenario sees, ahead of the fixture's games. */
export const PINNED_CLOCK = '2027-02-01T18:00:00.000Z'

/** How long each camera angle the stack makes for `video` runs. */
const ANGLE_SECONDS = 90

/** The stack's control routes, or blocked: Tess's stand-ins live behind them. */
function controlOf(ctx: E2eContext): StackControl {
  const control = (ctx.stack as HarnessStackHandle).control
  if (control == null) {
    throw new BlockedError(
      "this stack has no control routes for Tess's model, recogniser and beacon"
    )
  }
  return control
}

/** A model's answered calls, summed as `fakeAnthropic`'s totals are. */
export function totalsOf(calls: FakeCall[]): ModelTotals {
  const answered = calls.flatMap(call =>
    call.usage == null ? [] : [call.usage]
  )
  const sum = (count: (usage: (typeof answered)[number]) => number): number =>
    answered.reduce((total, usage) => total + count(usage), 0)
  return {
    input: sum(
      usage =>
        usage.input_tokens +
        usage.cache_creation_input_tokens +
        usage.cache_read_input_tokens
    ),
    output: sum(usage => usage.output_tokens),
    cacheRead: sum(usage => usage.cache_read_input_tokens),
    cacheWrite: sum(usage => usage.cache_creation_input_tokens),
    requests: answered.length
  }
}

/** What the stand-ins have counted so far, so a scenario reads only its own. */
interface Counts {
  calls: number
  begun: number
  said: number
  beacon: number
}

async function countsNow(control: StackControl): Promise<Counts> {
  const model = (await control.call('GET', 'model/calls')) as {
    calls: FakeCall[]
  }
  const speech = (await control.call('GET', 'speech')) as {
    begun: number
    said: string[]
  }
  const beacon = (await control.call('GET', 'beacon')) as { hits: number }
  return {
    calls: model.calls.length,
    begun: speech.begun,
    said: speech.said.length,
    beacon: beacon.hits
  }
}

/**
 * Seeds the `tess` world on the stack, scripts its model and recogniser,
 * opens a browser on the stack's web build signed in as the world's admin,
 * and runs the scenario. Nothing runs on this machine but the browser.
 */
export async function withTess(
  ctx: E2eContext,
  run: (web: TessWeb) => Promise<void>,
  options: TessWebOptions = {}
): Promise<void> {
  if (options.fixture?.tess === false) {
    throw new BlockedError(
      'needs a stack whose server has no Tess; a pool stack always has her'
    )
  }
  const control = controlOf(ctx)
  // Server code loads only when the scenario runs, so reading the spec has no
  // side effects.
  const { HEARD, tessScript } = await import('../../src/test/tessFixture')
  const { routePath } = await import('../../src/app/navigation/routes')
  const world = await ctx.fixture('tess')
  const id = (name: string): string => world.ids[name]
  const games = {
    finals: id('finals').split(','),
    may3: id('may3'),
    scheduled: id('scheduled')
  }
  // The angles are this scenario's own, so two scenarios on one stack never
  // meet.
  const videos = {
    firstBase: `vid_tess_first_${world.nonce}`,
    homePlate: `vid_tess_home_${world.nonce}`
  }
  if (options.video === true) {
    const media = stackMedia(control)
    for (const [videoId, camera] of [
      [videos.firstBase, 'First base'],
      [videos.homePlate, 'Home plate']
    ] as const) {
      await media.singleFile({
        videoId,
        gameId: games.may3,
        title: `Demo game — ${camera}`,
        startAt: '2027-05-03T18:00:00.000Z',
        seconds: ANGLE_SECONDS
      })
    }
  }
  const links = {
    teamSettings: routePath({
      name: 'groupSettings',
      kind: 'team',
      id: id('teamA')
    }),
    firstBaseAngle: routePath({
      name: 'game',
      gameId: games.may3,
      tab: 'watch',
      videoId: videos.firstBase,
      angles: [videos.firstBase]
    })
  }
  const players = { visible: id('visiblePlayer'), hidden: id('hiddenPlayer') }
  const origin = ctx.stack.origin.replace(/\/+$/, '')
  await control.call(
    'PUT',
    'model/script',
    toWire(
      tessScript({
        teamA: id('teamA'),
        seasonA: id('season'),
        may3: games.may3,
        scheduled: games.scheduled,
        links,
        players,
        origin: () => origin
      })
    )
  )
  await control.call('PUT', 'speech', { heard: HEARD })
  const from = await countsNow(control)
  // One API session per role, signed in with its password as the app does.
  const tokens = new Map<string, string>()
  const tokenOf = async (role: string): Promise<string> => {
    const known = tokens.get(role)
    if (known != null) return known
    const account = world.accounts[role]
    if (account == null) {
      throw new BlockedError(`the tess world has no account "${role}"`)
    }
    const { TeamStationClient } = await import('../../src/common/api')
    const { passwordBytes } = await import('../../src/common/passwordProtocol')
    const { nativeArgon } = await import('../../src/server/auth/passwords')
    const client = new TeamStationClient({
      baseUrl: `${origin}/api/v1`,
      passwordKdf: async (password: string, parameters: any) =>
        await nativeArgon(passwordBytes(password), parameters)
    })
    const what = `signing ${role} (${account.email}) in on ${origin}`
    const session = await retryWhileBusy(
      what,
      async () =>
        await client.signInWithPassword(account.email, account.password)
    )
    const token = (session as { token?: unknown } | undefined)?.token
    if (typeof token !== 'string' || token === '') {
      throw new Error(`${what} answered no session`)
    }
    tokens.set(role, token)
    return token
  }
  const t: TessStack = {
    world,
    f: {
      teamA: id('teamA'),
      teamB: id('teamB'),
      seasonA: id('season'),
      leagueA: id('league'),
      standaloneTeam: id('standaloneTeam')
    },
    games,
    videos,
    links,
    players,
    modelCalls: async () =>
      (
        (await control.call('GET', 'model/calls')) as { calls: FakeCall[] }
      ).calls.slice(from.calls),
    modelTotals: async () => totalsOf(await t.modelCalls()),
    dictation: async () => {
      const speech = (await control.call('GET', 'speech')) as {
        begun: number
        said: string[]
      }
      return {
        begun: speech.begun - from.begun,
        heard: speech.said.slice(from.said)
      }
    },
    beaconHits: async () =>
      ((await control.call('GET', 'beacon')) as { hits: number }).hits -
      from.beacon,
    request: async (method, path, body, role = 'admin') =>
      await fetch(`${origin}/api/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await tokenOf(role)}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
  }
  const session = await ctx.browser(
    // Wide enough for the navigation sidebar, her column and an 880-point
    // pane beside it, as develop's own Tess script draws it (fb5ef504a).
    { width: options.width ?? 1536, height: options.height ?? 900 },
    {
      timeZone: 'America/Los_Angeles',
      ...(options.liveClock === true ? {} : { clock: PINNED_CLOCK }),
      ...(options.video === true ? { h264: true } : {}),
      beforeLoad: `${STEADY_CARET}
        ;(${fakeMicrophone.toString()})(${JSON.stringify(toneWav())})`
    }
  )
  const { m, page } = session
  const see: TessWeb['see'] = async (selector, timeout = 20000) => {
    await m.assertVisible({ css: selector, timeout })
  }
  const gone: TessWeb['gone'] = async (selector, timeout = 20000) => {
    await m.assertNotVisible({ css: selector, timeout })
  }
  const tap: TessWeb['tap'] = async selector => {
    await see(selector)
    await m.tapOn({ css: selector, timeout: 15000 })
  }
  const type: TessWeb['type'] = async words => {
    await m.inputText({ text: words })
  }
  const fieldValue: TessWeb['fieldValue'] = async () =>
    await page.$eval(FIELD, node => node.value)
  const web: TessWeb = {
    t,
    session,
    m,
    page,
    origin,
    identity: async (role = 'admin') => {
      await m.setCookies({
        cookies: [
          {
            name: 'ts_session',
            value: await tokenOf(role),
            domain: new URL(origin).hostname,
            path: '/',
            httpOnly: true,
            secure: origin.startsWith('https:')
          }
        ]
      })
    },
    open: async (path, base = origin) => {
      await m.openBrowser({ url: base + path })
    },
    goInApp: async path => {
      await page.evaluate(path => {
        const state = history.state
        const index = (state == null ? 0 : Number(state.tsRouteIndex)) + 1
        history.pushState({ tsRouteIndex: index }, '', path)
        window.dispatchEvent(
          new PopStateEvent('popstate', { state: history.state })
        )
      }, path)
    },
    see,
    gone,
    shown: async (words, timeout = 20000) => {
      await m.assertVisible({ text: words, timeout })
    },
    tap,
    openChat: async (opens = COLUMN) => {
      // Wide, the sidebar holds Ask Tess; narrower, the mark's menu does.
      await eventually(async () => {
        expect(
          await page.evaluate(
            () =>
              window.innerWidth >= 1216 ===
              (document.querySelector('[data-testid="navigation-sidebar"]') !=
                null)
          )
        ).equals(true)
      }, 20000)
      if ((await page.$(MARK_MENU)) != null) await tap(MARK_MENU)
      await tap(ASK_TESS)
      await see(opens)
      // The microphone comes up once its socket has: a screen and a Space key depend
      // on that.
      await web.waitForStatus('Off')
    },
    type,
    say: async (words, answered) => {
      await see(FIELD)
      // Inserted whole, since the keys of a message are not what is being proved.
      await m.inputText({ css: FIELD, text: words })
      await m.pressKey({ key: 'Enter' })
      await m.assertVisible({ text: answered, timeout: 20000 })
      await gone(THINKING)
    },
    clearField: async () => {
      await m.evalBrowserScript({
        script: `document.querySelector(${JSON.stringify(FIELD)}).select()`
      })
      await m.pressKey({ key: 'Backspace' })
      await eventually(async () => {
        expect(await fieldValue()).equals('')
      }, 5000)
    },
    fieldValue,
    rectOf: async selector =>
      await page.evaluate(selector => {
        const node = document.querySelector(selector)
        if (node == null) return null
        const box = node.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height }
      }, selector),
    paneRect: async () =>
      // The pane between the navigation and her column on the right.
      await page.evaluate(column => {
        const pane =
          document.querySelector(column) == null
            ? null
            : document.querySelector('[data-testid="navigation-scenes"]')
        if (pane == null) return null
        const box = pane.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height }
      }, COLUMN),
    pathIs: async path => {
      await eventually(async () => {
        expect(await page.evaluate(() => location.pathname)).equals(path)
      }, 20000)
    },
    userBubbles: async words =>
      await page.evaluate(
        words =>
          Array.from(
            document.querySelectorAll('[data-testid="Tess user message"]')
          ).filter(node => (node.textContent || '').includes(words)).length,
        words
      ),
    dictationStatus: async () =>
      await page.evaluate(() => {
        const node = document.querySelector('[aria-label="Dictate"]')
        if (node == null) return null
        return node.getAttribute('aria-valuetext')
      }),
    waitForStatus: async (words, timeoutMs = 20000) => {
      await eventually(
        async () => {
          expect(await web.dictationStatus()).equals(words)
        },
        timeoutMs,
        50
      )
    }
  }
  await web.identity()
  await run(web)
}
