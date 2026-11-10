/* eslint-disable @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- Serialized browser callbacks cannot capture Sucrase's generated helper functions. */
import { expect } from 'chai'

import type {
  TessFixture,
  TessFixtureOptions
} from '../../src/test/tessFixture'
import { eventually } from '../core/readback'
import type { E2eContext, E2eSpec, WebSession } from '../core/spec'
import { fakeMicrophone } from './fakeMicrophone'

/**
 * Tess in a browser, on a fixture server whose model is a script and whose
 * recogniser hears one sentence, so nothing is paid for. Each scenario gets a
 * fixture of its own. The UI is driven through maestro-d. `page` only reads, so
 * every wait here fails as a check, never as a browser timeout.
 */

/** The mark's menu, on a tab root. Ask Tess is a row inside it. */
export const MARK_MENU = '[role="button"][aria-label="TeamStation menu"]'
export const ASK_TESS = '[role="button"][aria-label="Ask Tess"]'
export const TESS_BUTTON = ASK_TESS
export const NOTIFICATIONS = '[role="button"][aria-label="Notifications"]'
export const COLUMN = '[data-testid="Tess column"]'
export const LAYER = '[data-testid="Tess layer"]'
export const CHAT = '[data-testid="Tess chat"]'
export const FIELD = '[aria-label="Ask Tess"]'
export const THINKING = '[data-testid="Tess thinking"]'
export const MIC = '[role="button"][aria-label="Dictate"]'
export const DIVIDER = '[data-testid="Tess divider"]'
export const OPEN_FULL_SCREEN = '[role="button"][aria-label="Open full screen"]'
export const OVERLAY = '[data-testid="Tess overlay"]'
export const VIEWER = `${OVERLAY} [data-testid="Tess rich viewer"]`
export const VIEWER_CLOSE = `${OVERLAY} [role="button"][aria-label="Close"]`
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
  E2eSpec,
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
  fixtures: [],
  exclusive: false,
  surfaces: { 'web-chromium': { devices: [] } },
  services: ['web'],
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

export interface TessWeb {
  t: TessFixture
  session: WebSession
  m: WebSession['m']
  page: WebSession['page']
  origin: string
  /** Becomes this fixture user, by the session cookie the harness made them. */
  identity: (id: number, on?: TessFixture) => Promise<void>
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

export interface TessWebOptions {
  fixture?: TessFixtureOptions
  width?: number
  height?: number
  /** Leaves the browser's clock running, for what animates or measures time. */
  liveClock?: boolean
  /** Plays real video, which needs a browser with H.264. */
  video?: boolean
}

/** The instant every pinned scenario sees, ahead of the fixture's games. */
export const PINNED_CLOCK = '2027-02-01T18:00:00.000Z'

/**
 * Starts a fixture and a browser signed in as user 101, runs the scenario, and
 * always stops the fixture.
 */
export async function withTess(
  ctx: E2eContext,
  run: (web: TessWeb) => Promise<void>,
  options: TessWebOptions = {}
): Promise<void> {
  // Server code loads only when the scenario runs, so reading the spec has no
  // side effects.
  const { tessFixture } = await import('../../src/test/tessFixture')
  if (ctx.stack.webDir == null)
    throw new Error('This scenario needs a web build')
  const t = await tessFixture({
    webRoot: ctx.stack.webDir,
    videos: options.video === true,
    ...options.fixture
  })
  try {
    // Seasons that start alike sort by their random ids, which would move a golden.
    await t.f.h.db
      .updateTable('seasons')
      .set({ starts_on: '2027-01-01', ends_on: '2027-12-31' })
      .where('id', '=', t.f.playoffs)
      .execute()
    const origin = await ctx.stack.adopt(t.f.h.origin)
    const session = await ctx.browser(
      { width: options.width ?? 1280, height: options.height ?? 900 },
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
      await page.$eval(FIELD, node => (node as HTMLTextAreaElement).value)
    const web: TessWeb = {
      t,
      session,
      m,
      page,
      origin,
      identity: async (id, on = t) => {
        await m.setCookies({
          cookies: [
            {
              name: 'ts_session',
              value: on.f.h.tokens.get(id),
              domain: new URL(on.f.h.origin).hostname,
              path: '/',
              httpOnly: true
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
        await tap(MARK_MENU)
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
        await page.evaluate(column => {
          const left = document.querySelector(column)
          const pane = left == null ? null : left.nextElementSibling
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
    await web.identity(101)
    await run(web)
  } finally {
    await t.close()
  }
}
