import type { FixtureAccount } from '../../core/fixtures'
import { readJson } from '../../core/readback'
import { BlockedError } from '../../core/result'
import type { HarnessContext, Surface, WebSession } from '../../core/spec'
import { appLink } from '../app/pointAtStack'
import { clearSignInLimits, serverKeptOnHubPhone } from '../coach/coachApp'

/**
 * The scoring screen's sheets as a scorekeeper drives them, on the surface
 * the run was handed: the develop app on a phone, Safari on an iPhone, or
 * the web in the runner's browser. Every step is a maestro-d command on that
 * device; a control is found by what it reads in the device's hierarchy and
 * pressed where it is drawn.
 */

export interface Node {
  text?: string
  accessibilityText?: string
  id?: string
  type?: string
  enabled?: boolean
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}

export const flat = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flat)
]

/** What a node reads: its text, or on the web its accessible name. */
export function textOf(node: Node): string | undefined {
  return node.text ?? node.accessibilityText
}

/**
 * What the page shows, as text, read and never acted on: its text, then
 * each element's accessible name (an icon button's only name), a line each.
 */
export const PAGE_TEXT = `[document.body.innerText, ...[...document.querySelectorAll('[aria-label]')].map(node => node.getAttribute('aria-label'))].join('\\n')`

export async function pageText(web: WebSession): Promise<string> {
  return String(await web.page.evaluate(PAGE_TEXT))
}

/** `text` as a pattern that matches it literally. */
export function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** How long a step waits between looks, and for a control to be drawn. */
export const timing = { step: 500, draw: 15000 }

export const pause = async (ms = timing.step): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** The device role every scorer spec names. */
export const SCORER_ROLE = 'phone'

/** The app kind a phone surface launches. */
export function appKindOf(surface: Surface): string {
  return surface === 'android-app' ? 'teamstation-android' : 'teamstation-ios'
}

/** A phone's window in points, for the runner's browser. */
export const PHONE_SIZE = { width: 430, height: 932 }

/** How far from the screen's top and foot a control must be, and where to swipe. */
export interface Clearance {
  top?: number
  foot?: number
  /** The swipe's x, as a share of the window. */
  x?: string
}

export interface Scorer {
  m: any
  surface: Surface
  /** The app on a phone, not a browser. */
  native: boolean
  /** The runner's browser session, on web-chromium. */
  web: WebSession | undefined
  /** What is on screen: in a phone browser, only the page's own nodes. */
  nodes: () => Promise<Node[]>
  /** The last node `label` names: its text, its id, or a row it heads. */
  find: (label: string) => Promise<Node | undefined>
  /** Opens a page of the app (`games/<id>/score`). */
  open: (path: string) => Promise<void>
  /** Waits until a node's text, or the screen's text, matches `pattern`. */
  shown: (pattern: string, timeout?: number) => Promise<void>
  /** Waits until nothing `label` names is on screen. */
  gone: (label: string, timeout?: number) => Promise<void>
  /** Presses the control `label` names where it is drawn. */
  tap: (label: string) => Promise<void>
  /** Presses the last control whose text starts with `prefix`. */
  tapStarts: (prefix: string) => Promise<string>
  /** Presses a point of the screen. */
  point: (x: number, y: number) => Promise<void>
  /** Scrolls until `label` is clear of the bars at the screen's top and foot. */
  reach: (label: string, clear?: Clearance) => Promise<void>
  /** Replaces what the text field `label` holds with `value`. */
  input: (label: string, value: string) => Promise<void>
  /** Puts the keyboard away as a person finishing a form does. */
  finishKeyboard: () => Promise<void>
  /** The scoring menu's item `label`. */
  menu: (label: string) => Promise<void>
  /** Keeps the screen as `<surface>-<name>.png` in the run directory. */
  capture: (name: string) => Promise<void>
  /** Every text on screen. */
  texts: () => Promise<string[]>
}

/** The screen's own window, in the hierarchy's units. */
export function windowOf(nodes: Node[]): NonNullable<Node['bounds']> {
  const window =
    nodes.find(node => node.type === 'Window')?.bounds ??
    nodes.find(node => node.bounds != null)?.bounds
  if (window == null) throw new Error('The screen has no bounds')
  return window
}

/**
 * The last node `label` names: its text, its id, or a row it heads
 * (`label, …`); an Undo button is named by the start of what it reads.
 */
export function named(nodes: Node[], label: string): Node | undefined {
  const undo = label.startsWith('Undo ')
  return nodes
    .filter(node => {
      const text = textOf(node)
      return (
        node.bounds != null &&
        // Safari's own toolbar has a More button of its own.
        node.id !== 'MoreMenuButton' &&
        (text === label ||
          node.id === label ||
          text?.startsWith(label + ',') === true ||
          (undo && text?.startsWith(label) === true))
      )
    })
    .at(-1)
}

/**
 * Drives the screen of `m` on `surface`. `origin` is the stack's web build,
 * which a phone browser and the runner's browser open pages on.
 */
export function scorerOn(
  m: any,
  surface: Surface,
  origin: string,
  artifact: (name: string) => string,
  web?: WebSession
): Scorer {
  const native = surface === 'ios-app' || surface === 'android-app'
  const phoneBrowser = surface === 'web-safari-ios'
  const nodes = async (): Promise<Node[]> => {
    const all = flat((await m.hierarchy()) as Node)
    if (!phoneBrowser) return all
    const page = all.find(node => node.type === 'WebView')
    return page == null ? all : flat(page)
  }
  const find = async (label: string): Promise<Node | undefined> =>
    named(await nodes(), label)
  const point = async (x: number, y: number): Promise<void> => {
    await m.tapOn({ point: `${Math.round(x)},${Math.round(y)}` })
    await pause()
  }
  const centre = async (node: Node): Promise<void> => {
    const b = node.bounds!
    await point(b.x + b.width / 2, b.y + b.height / 2)
  }
  const texts = async (): Promise<string[]> =>
    (await nodes()).flatMap(node => {
      const text = textOf(node)
      return text == null ? [] : [text]
    })
  const shown = async (pattern: string, timeout = 30000): Promise<void> => {
    const wanted = new RegExp(pattern)
    const until = Date.now() + timeout
    for (;;) {
      const all = await nodes()
      if (
        all.some(
          node => wanted.test(textOf(node) ?? '') || wanted.test(node.id ?? '')
        ) ||
        wanted.test(all.map(node => textOf(node) ?? '').join(' ')) ||
        // In the runner's browser maestro-d's hierarchy leaves out a sheet's
        // text: the page's own text is read instead.
        (web != null && wanted.test(await pageText(web)))
      )
        return
      if (Date.now() > until) throw new Error(`Not on screen: ${pattern}`)
      await pause()
    }
  }
  const gone = async (label: string, timeout = 15000): Promise<void> => {
    const until = Date.now() + timeout
    while ((await find(label)) != null) {
      if (Date.now() > until) throw new Error(`Still on screen: ${label}`)
      await pause()
    }
  }
  const tap = async (label: string): Promise<void> => {
    await m.waitForAnimationToEnd({ timeout: 3000 })
    const until = Date.now() + timing.draw
    let node = await find(label)
    while (node == null && Date.now() < until) {
      await pause()
      node = await find(label)
    }
    if (node == null) {
      // Not in the hierarchy by name: maestro-d's own text match.
      await m.tapOn({ text: `^${literal(label)}$`, timeout: 15000 })
      await pause()
      return
    }
    await centre(node)
  }
  const tapStarts = async (prefix: string): Promise<string> => {
    await m.waitForAnimationToEnd({ timeout: 3000 })
    const node = (await nodes())
      .filter(
        found =>
          textOf(found)?.startsWith(prefix) === true && found.bounds != null
      )
      .at(-1)
    if (node == null) throw new Error(`Nothing on screen starts ${prefix}`)
    await centre(node)
    return textOf(node)!
  }
  const reach = async (
    label: string,
    { top = 80, foot = 120, x = '65%' }: Clearance = {}
  ): Promise<void> => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const all = await nodes()
      const window = windowOf(flat((await m.hierarchy()) as Node))
      const target = named(all, label)?.bounds
      if (
        target != null &&
        target.height > 0 &&
        target.y >= top &&
        target.y + target.height <= window.y + window.height - foot
      )
        return
      await m.swipe({ start: `${x},75%`, end: `${x},35%`, duration: 400 })
      await pause()
    }
    throw new Error(`${label} never came clear on screen`)
  }
  const input = async (label: string, value: string): Promise<void> => {
    const field = (await nodes())
      .filter(
        node =>
          (textOf(node) === label || node.id === label) &&
          /TextField|EditText|textbox/i.test(node.type ?? 'TextField')
      )
      .at(-1)
    if (field?.bounds == null) throw new Error(`No field ${label}`)
    await centre(field)
    await m.eraseText({ characters: 200 })
    if (value !== '') await m.inputText({ text: value })
  }
  const finishKeyboard = async (): Promise<void> => {
    if (!native) {
      await tap('Done')
      return
    }
    for (let i = 0; i < 3; i++) {
      if (!(await nodes()).some(node => node.type === 'Keyboard')) return
      await m.pressKey('Enter')
    }
  }
  const open = async (path: string): Promise<void> => {
    const relative = path.replace(/^\/+/, '')
    if (native) {
      await m.openLink({ link: appLink(relative) })
      // iOS asks once before a link opens the app it names.
      if ((await find('Open')) != null) await tap('Open')
    } else {
      await m.openLink({
        link: `${origin}/${relative}`,
        ...(phoneBrowser ? { browser: true } : {})
      })
    }
    await pause(timing.step * 3)
  }
  return {
    m,
    surface,
    native,
    web,
    nodes,
    find,
    open,
    shown,
    gone,
    tap,
    tapStarts,
    point,
    reach,
    input,
    finishKeyboard,
    menu: async label => {
      await tap('Open scoring menu')
      await tap(label)
    },
    capture: async name => {
      await m.waitForAnimationToEnd({ timeout: 3000 })
      await m.takeScreenshot({ path: artifact(`${surface}-${name}.png`) })
    },
    texts
  }
}

/**
 * Signs a phone's browser out of an earlier run's session: Safari cannot be
 * cleared from here, and it keeps the last account signed in. The account
 * page shows the sign-in form when nobody is signed in.
 */
export async function signedOut(m: any, origin: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await m.openLink({ link: `${origin}/account`, browser: true })
    const out: boolean = await m
      .assertVisible({ text: 'Sign in to TeamStation', timeout: 8000 })
      .then(
        () => true,
        () => false
      )
    if (out) return
    try {
      await m.scrollUntilVisible({
        element: { text: 'Sign out' },
        direction: 'DOWN'
      })
      await m.tapOn({ text: 'Sign out' })
      await pause(timing.step * 6)
    } catch {
      // Not drawn yet: looked for again.
    }
  }
  throw new Error('The browser stays signed in after three Sign outs')
}

/**
 * The scorer `role` of the scenario's world, signed in through the real
 * password form on the run's surface: the develop app cleared and pointed
 * at the stack, Safari on the phone, or a phone-sized window of the
 * runner's browser.
 */
export async function openScorer(
  ctx: HarnessContext,
  role = 'scorer',
  size = PHONE_SIZE
): Promise<Scorer> {
  const origin = ctx.stack.origin
  await clearSignInLimits(ctx)
  if (ctx.surface === 'web-chromium') {
    const session = await ctx.browser(size)
    await session.m.openLink({ link: `${origin}/sign-in` })
    await ctx.signIn(role, session.m)
    return scorerOn(session.m, ctx.surface, origin, ctx.artifact, session)
  }
  if (ctx.surface === 'web-safari-ios') {
    const m = await ctx.mobileBrowser(SCORER_ROLE, `${origin}/sign-in`)
    await signedOut(m, origin)
    await m.openLink({ link: `${origin}/sign-in`, browser: true })
    await ctx.signIn(role, m)
    return scorerOn(m, ctx.surface, origin, ctx.artifact)
  }
  const appId = ctx.app(appKindOf(ctx.surface))
  const m = ctx.attached(SCORER_ROLE)
  await m.launchApp({ appId, clearState: true })
  // A clear forgets the server: the link points the app back at the stack.
  await serverKeptOnHubPhone(m, appId, origin)
  await ctx.signIn(role, m)
  return scorerOn(m, ctx.surface, origin, ctx.artifact)
}

/** Signs an account in through the API, answering its bearer token. */
export type SignIn = (
  baseUrl: string,
  account: Pick<FixtureAccount, 'email' | 'password'>
) => Promise<string>

async function signInWithApi(
  baseUrl: string,
  account: Pick<FixtureAccount, 'email' | 'password'>
): Promise<string> {
  const { signInTestAccount } =
    await import('../../../src/test/passwordFixtures')
  return await signInTestAccount(baseUrl, account)
}

/** A game's book as the server keeps it: each stored play and the open at-bat. */
export interface Book {
  plays: any[]
  currentPlay: any
}

/**
 * Reads games' books as `account` reads them, through the stack's API: what
 * the screen saved, never what it shows.
 */
export function bookReader(
  ctx: HarnessContext,
  account: Pick<FixtureAccount, 'email' | 'password'>,
  signIn: SignIn = signInWithApi
): (gameId: string) => Promise<Book> {
  let token: string | undefined
  return async gameId => {
    token ??= await signIn(`${ctx.stack.origin}/api/v1`, account)
    const answer = (await readJson(
      ctx.stack.origin,
      `/api/v1/games/${encodeURIComponent(gameId)}/events`,
      { headers: { authorization: `Bearer ${token}` } }
    )) as { plays?: any[]; currentPlay?: any }
    return {
      plays: (answer.plays ?? []).map(play => play?.gumbo ?? play),
      currentPlay: answer.currentPlay ?? null
    }
  }
}

/** Polls `read` until `matches` holds, or fails naming `what`. */
export async function until<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  what: string,
  timeout = 20000
): Promise<T> {
  const end = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (matches(value)) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await pause(timing.step / 2)
  }
}

/**
 * Holds every API request under `prefix` for `ms` on the stack's fault
 * server (its `delay` stand-in), so a save the screen makes stays unsent;
 * `null` lets the next ones through at once.
 */
export async function holdRequests(
  ctx: HarnessContext,
  prefix: string | null,
  ms = 30000
): Promise<void> {
  const control = ctx.stack.control
  if (control == null)
    throw new BlockedError('this stack has no control routes to hold a save')
  await control.call('PUT', 'delay', prefix == null ? null : { prefix, ms })
}

/** A world id list (`a,b,c`) as its parts. */
export function listOf(ids: Record<string, string>, name: string): string[] {
  const value = ids[name]
  if (value == null) throw new Error(`The world has no ${name}`)
  return value.split(',')
}
