import {
  GAME_SOCKET_PROTOCOL,
  PROTOCOL_HEADER
} from '../../src/common/gameSocket'
import {
  SCORING_FEATURE_HEADER,
  SCORING_FEATURES
} from '../../src/common/scoring/teamRecord'
import type { Emulation } from '../core/browserCdp'
import type { FixtureAccount } from '../core/fixtures'
import type { HarnessContext, WebSession } from '../core/spec'
import type { Page } from '../core/web'
import { clearSignInLimits, stackSql } from './coach/coachApp'

/**
 * The web app in this run's browser, signed in as a world's person the way
 * a returning browser is: with the session cookie the API's password
 * sign-in hands out. Every step on the page goes through maestro-d; the
 * page itself is only read (its map frame included).
 */

/** The session cookie the web app reads (`src/server/auth/tokens.ts`). */
export const SESSION_COOKIE = 'ts_session'

type Account = Pick<FixtureAccount, 'email' | 'password'>

export interface Reply {
  status: number
  body: any
}

export interface EventWeb {
  session: WebSession
  m: any
  page: Page
  origin: string
  /** Page errors seen since the session opened. */
  errors: string[]
  /** The JSON value of `expression`, run in the page through maestro-d. */
  evaluate: <T>(expression: string) => Promise<T>
  /** Waits until `expression` is true in the page. */
  wait: (expression: string, timeoutMs?: number) => Promise<void>
  /** Opens `route` on the stack's web app. */
  go: (route: string) => Promise<void>
  /** Signs this browser in as `account`, replacing whoever was. */
  signInAs: (account: Account) => Promise<void>
  /** The screen, kept in the run directory as `name`. */
  shot: (name: string) => Promise<void>
}

export interface EventWebDeps {
  /** The API's password sign-in, answering a session token. */
  signIn?: (apiBase: string, account: Account) => Promise<string>
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

const realSleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Each account's session token, signed in once: sign-ins are rate limited. */
const tokens = new Map<string, string>()

async function apiSignIn(apiBase: string, account: Account): Promise<string> {
  const { signInTestAccount } = await import('../../src/test/passwordFixtures')
  return await signInTestAccount(apiBase, account)
}

/** `account`'s session token on this stack. */
export async function tokenOf(
  ctx: HarnessContext,
  account: Account,
  deps: EventWebDeps = {}
): Promise<string> {
  const key = `${ctx.stack.origin} ${account.email}`
  const known = tokens.get(key)
  if (known != null) return known
  const token = await (deps.signIn ?? apiSignIn)(
    `${ctx.stack.origin}/api/v1`,
    account
  )
  tokens.set(key, token)
  return token
}

/** Asks the stack's API as `account`. */
export async function api(
  ctx: HarnessContext,
  account: Account,
  method: string,
  path: string,
  body?: unknown,
  deps: EventWebDeps = {}
): Promise<Reply> {
  const token = await tokenOf(ctx, account, deps)
  const response = await (deps.fetch ?? fetch)(
    `${ctx.stack.origin}/api/v1${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        // As this checkout's app sends them: a save of a game's plays from
        // an older app is refused, and newer records are read only by name.
        [PROTOCOL_HEADER]: String(GAME_SOCKET_PROTOCOL),
        [SCORING_FEATURE_HEADER]: SCORING_FEATURES,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }
  )
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed }
}

/** A setup or read-back statement on the stack's own database. */
export async function sql(
  ctx: HarnessContext,
  text: string,
  values: unknown[] = []
): Promise<Array<Record<string, any>>> {
  return (await stackSql(ctx, text, values)).rows
}

/**
 * Marks the stack's organization setup finished, as a production node is
 * once its ownership preflight passed (`src/server/dev/fixtures/nodeSettings.ts`):
 * game requests, scheduling and withdrawals refuse until it is.
 */
export async function hierarchyReady(ctx: HarnessContext): Promise<void> {
  await stackSql(
    ctx,
    `insert into system_settings (key, value) values ('creation.hierarchyReady', 'true')
     on conflict (key) do update set value = 'true'`
  )
}

/** Opens this run's browser on the stack, signed in as `account`. */
export async function openEventWeb(
  ctx: HarnessContext,
  account: Account,
  size: { width: number; height: number },
  emulation: Emulation = {},
  deps: EventWebDeps = {}
): Promise<EventWeb> {
  const sleep = deps.sleep ?? realSleep
  const origin = ctx.stack.origin
  await clearSignInLimits(ctx)
  const session = await ctx.browser(size, emulation)
  const { m, page } = session
  const errors: string[] = []
  page.on('pageerror', (error: unknown) => {
    errors.push(String(error))
  })
  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = (await m.evalBrowserScript({
      script: `return JSON.stringify(${expression})`,
      output: 'eventProbe'
    })) as { data?: unknown } | undefined
    const data =
      typeof result?.data === 'string'
        ? result.data
        : (await m.vars()).eventProbe
    return (data == null ? undefined : JSON.parse(data)) as T
  }
  const web: EventWeb = {
    session,
    m,
    page,
    origin,
    errors,
    evaluate,
    wait: async (expression, timeoutMs = 30000) => {
      const end = Date.now() + timeoutMs
      while (!(await evaluate<boolean>(expression))) {
        if (Date.now() > end)
          throw new Error(`Never held in the page: ${expression}`)
        await sleep(150)
      }
    },
    go: async route => {
      await m.openBrowser({ url: origin + route })
    },
    signInAs: async who => {
      await m.setCookies({
        cookies: [
          {
            name: SESSION_COOKIE,
            value: await tokenOf(ctx, who, deps),
            domain: new URL(origin).hostname,
            path: '/'
          }
        ]
      })
    },
    shot: async name => {
      await m.takeScreenshot({ path: ctx.artifact(name) })
    }
  }
  await m.openBrowser({ url: origin })
  await web.signInAs(account)
  return web
}

type Frame = ReturnType<Page['frames']>[number]

/**
 * The map frame on show. A map draws in a sandboxed frame the page's own
 * scripts cannot reach, so it is read from the browser; a screen covered by
 * the top of the stack stays mounted, hidden, with its map frame in it.
 */
export async function mapFrameOf(
  page: Page,
  timeout = 25000,
  sleep = realSleep
): Promise<Frame> {
  const deadline = Date.now() + timeout
  for (;;) {
    for (const frame of page.frames()) {
      if (!frame.url().endsWith('/mapFrame.html')) continue
      const element = await frame.frameElement().catch(() => null)
      const shown =
        element != null &&
        (await element
          .evaluate(node => getComputedStyle(node).visibility === 'visible')
          .catch(() => false))
      if (shown) return frame
    }
    if (Date.now() >= deadline) throw new Error('The map frame never appeared')
    await sleep(100)
  }
}

/** An expression's value inside the map frame, by way of JSON. */
export async function inMapFrame<T>(
  page: Page,
  expression: string
): Promise<T> {
  const frame = await mapFrameOf(page)
  const json = await frame.evaluate(`JSON.stringify((${expression})??null)`)
  return JSON.parse(json as string) as T
}

/**
 * Waits for an expression to hold inside the map frame. A frame between
 * documents refuses the read, or answers from the old one, so a failed
 * read is tried again.
 */
export async function waitInMapFrame(
  page: Page,
  expression: string,
  timeout = 30000,
  sleep = realSleep
): Promise<void> {
  const deadline = Date.now() + timeout
  let last: Error | undefined
  while (Date.now() < deadline) {
    try {
      if (await inMapFrame<boolean>(page, expression)) return
      last = undefined
    } catch (error) {
      last = error as Error
    }
    await sleep(100)
  }
  throw new Error(
    `Never held in the map frame: ${expression}${last == null ? '' : ` (${last.message})`}`
  )
}

/**
 * Where the map frame's tiles come from, read off a drawn tile: the server
 * names the tile provider, so a scenario that fails its tiles reads it.
 */
export async function mapTileHost(page: Page): Promise<string> {
  await waitInMapFrame(
    page,
    `document.querySelector('img.leaflet-tile[src^="http"]')!=null`
  )
  const src = await inMapFrame<string>(
    page,
    `document.querySelector('img.leaflet-tile[src^="http"]').src`
  )
  return new URL(src).host
}

/** The middle of an element in the map frame, in the page's coordinates. */
export async function pointInMapFrame(
  page: Page,
  selector: string
): Promise<{ x: number; y: number }> {
  const frame = await mapFrameOf(page)
  const element = await frame.frameElement()
  const box = await element?.boundingBox()
  if (box == null) throw new Error('The map frame has no box')
  const inner = (await frame.evaluate(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`
  )) as { x: number; y: number }
  return { x: box.x + inner.x, y: box.y + inner.y }
}

/** The notification ask's Not Now (`NotificationAskHost`). */
export const ASK_NOT_NOW = 'notification-ask-not-now'

/**
 * Answers the notification ask Not Now if it comes up within `ms`: the app
 * asks once per person per device after an RSVP. Says whether it answered.
 */
export async function dismissNotificationAsk(
  m: any,
  ms = 10000,
  sleep = realSleep
): Promise<boolean> {
  try {
    await m.assertVisible({ id: ASK_NOT_NOW, timeout: ms })
  } catch {
    return false
  }
  // The sheet slides up: a tap while it moves can land beside the button.
  await sleep(800)
  await m.tapOn({ id: ASK_NOT_NOW, timeout: 5000 })
  return true
}

/** A point string for maestro-d, rounded. */
export function at(x: number, y: number): string {
  return `${Math.round(x)},${Math.round(y)}`
}
