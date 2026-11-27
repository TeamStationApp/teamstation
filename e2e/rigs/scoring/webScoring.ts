import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import { PerspectiveCamera, type Scene, Vector3 } from 'three'

import { applyFieldCamera } from '../../../src/app/field/cameraModel'
import { BASES } from '../../../src/app/field/fieldModel'
import { asGameDetail, type RosterEntry } from '../../../src/common/api'
import type { FixtureManifest } from '../../core/fixtures'
import { readJson } from '../../core/readback'
import { BlockedError } from '../../core/result'
import type {
  HarnessContext,
  HarnessScenario,
  WebSession
} from '../../core/spec'
import type { HTTPRequest, HTTPResponse, Page } from '../../core/web'
import {
  aimLanding,
  type FieldDriver,
  installSceneProbe,
  maestroDriver,
  placeOffered,
  setTrajectory
} from '../fieldPointer'

/**
 * The scoring screen's field tests in the runner's own browser, on the
 * stack's web build and API with the `scoring-field` world: Owls at Hawks,
 * nine players a side, one scorer who keeps score for both.
 *
 * The tests were written against a page whose API was a script in the
 * browser, with the game called `g1`, its teams `away` and `home`, and its
 * players' gumbo ids 101–109 (the Owls) and 201–209 (the Hawks), the
 * scorer 100. `scoringPage` keeps those names: every path, selector and
 * page script going in has them turned into the world's own ids, and every
 * address and saved document coming out has the world's ids turned back.
 *
 * Every press, drag, key and navigation is a maestro-d command on the
 * session's device. The page is read through puppeteer, and a page script
 * that acts (a `click()`, an event, `history.back()`) goes through
 * maestro-d's `evalBrowserScript`. A pointer pressed and moved is one
 * maestro-d drag when it is let go: maestro-d cannot hold a pointer down
 * between commands, so a scenario that reads the page in the middle of a
 * drag is blocked, naming that.
 */

/** The game the tests read, as the page's own API named it. */
export const game = asGameDetail({
  nonMemberView: false,
  id: 'g1',
  awayTeamId: 'away',
  homeTeamId: 'home',
  awayTeamName: 'Owls',
  homeTeamName: 'Hawks',
  seasonId: null,
  startAt: null,
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'pending',
  ingestMessage: null,
  canScore: true,
  assignedRoles: { away: ['scorekeeper'], home: ['scorekeeper'] },
  videos: []
})

export interface HeldCount {
  balls: number
  strikes: number
  outs: number
}

/** A mocha `this`: a timeout the runner sets, and a skip that blocks. */
export interface MochaLike {
  timeout: (ms: number) => void
  skip: () => never
}

type Body = (this: MochaLike) => Promise<void>

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** A test's title as a scenario name: lower case words joined by `-`. */
export function scenarioName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** The running scenario's scoring, for the tests' module-level helpers. */
let current: Scoring | undefined

export function scoring(): Scoring {
  if (current == null) throw new Error('No scoring scenario is running')
  return current
}

/** A collection of tests, `add`ed as mocha `it`s were, as harness scenarios. */
export function suite(): {
  add: (title: string, body: Body) => void
  scenarios: Record<string, HarnessScenario>
} {
  const scenarios: Record<string, HarnessScenario> = {}
  const add = (title: string, body: Body): void => {
    let name = scenarioName(title)
    for (let n = 2; Object.hasOwn(scenarios, name); n++)
      name = `${scenarioName(title)}-${n}`
    scenarios[name] = async ctx => {
      await run(ctx, body)
    }
  }
  return { add, scenarios }
}

/** Runs one test body with its scoring, and closes what it opened. */
export async function run(ctx: HarnessContext, body: Body): Promise<void> {
  const own = new Scoring(ctx)
  current = own
  const mocha: MochaLike = {
    timeout: () => undefined,
    skip: () => {
      throw new BlockedError('the test skips itself here')
    }
  }
  try {
    await body.call(mocha)
  } finally {
    current = undefined
    await own.close()
  }
}

/** Where the scenario keeps its pictures and logs: its run directory. */
export function artifactDir(): string {
  const dir = scoring().ctx.runDir
  mkdirSync(dir, { recursive: true })
  return dir
}

/** The world's ids for the names the tests use, and back. */
export class Ids {
  private readonly real: Array<[string, string]>
  constructor(world: FixtureManifest, scorerGumbo: string) {
    const pairs: Array<[string, string]> = [
      ['g1', world.ids.game],
      ['away', world.ids.awayTeam],
      ['home', world.ids.homeTeam],
      ['100', scorerGumbo]
    ]
    for (let i = 1; i <= 9; i++) {
      pairs.push([String(100 + i), world.ids[`away${i}`]])
      pairs.push([String(200 + i), world.ids[`home${i}`]])
    }
    this.real = pairs
  }

  /** The world's id for a test's `g1`, `away`, `home` or gumbo id. */
  of(name: string): string {
    return this.real.find(([fixture]) => fixture === name)?.[1] ?? name
  }

  /** The test's name for one of the world's ids, or the id itself. */
  nameOf(id: string): string {
    return this.real.find(([, real]) => real === id)?.[0] ?? id
  }

  /** A path, selector or page script with the tests' names made the world's. */
  in(text: string): string {
    let out = text
      .replace(/\/games\/g1(?=[/?#'"`]|$)/g, `/games/${this.of('g1')}`)
      .replace(/(['"`])g1\1/g, (_, q: string) => `${q}${this.of('g1')}${q}`)
      .replace(
        /\/teams\/(away|home)(?=[/?#'"`]|$)/g,
        (_, side: string) => `/teams/${this.of(side)}`
      )
      .replace(/:100:/g, `:${this.of('100')}:`)
    for (const [fixture, real] of this.real.slice(4)) {
      out = out
        .replace(
          new RegExp(`(data-[a-z-]+=\\\\?["'])${fixture}(\\\\?["'])`, 'g'),
          `$1${real}$2`
        )
        .replace(new RegExp(`(['"\`])${fixture}\\1`, 'g'), `$1${real}$1`)
    }
    return out
  }

  /** An address or saved document with the world's ids turned back. */
  out(text: string): string {
    let back = text.replaceAll(this.of('g1'), 'g1')
    back = back.replaceAll(this.of('away'), 'away')
    back = back.replaceAll(this.of('home'), 'home')
    for (const [fixture, real] of this.real.slice(3)) {
      back = back
        .replace(new RegExp(`("id":)${real}(?=[,}])`, 'g'), `$1${fixture}`)
        .replace(new RegExp(`(["'])${real}\\1`, 'g'), `$1${fixture}$1`)
        .replace(new RegExp(`:${real}:`, 'g'), `:${fixture}:`)
    }
    return back
  }

  /** A value read from the page, with any string in it turned back. */
  value<T>(read: T): T {
    if (typeof read === 'string') return this.out(read) as T
    if (read == null || typeof read !== 'object') return read
    try {
      return JSON.parse(this.out(JSON.stringify(read))) as T
    } catch {
      return read
    }
  }
}

/**
 * `fn` with the tests' ids in its source made the world's: the same function
 * when nothing in it names one, else one built from the mapped source, which
 * puppeteer sends to the page as it would the original.
 */
export function revived(fn: unknown, ids: Ids): unknown {
  if (typeof fn !== 'function') return ids.in(String(fn))
  const text = fn.toString()
  const mapped = ids.in(text)
  if (mapped === text) return fn
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func -- the page function, rebuilt from its own mapped source
  return new Function(`return (${mapped})`)()
}

/** What the page script in `source` does that is more than reading. */
const ACTS =
  /\.click\(\)|dispatchEvent|history\.(back|forward|go)\(|\.focus\(|\.blur\(|scrollIntoView|scrollTo\(|scrollBy\(|scrollTop\s*=[^=]|scrollLeft\s*=[^=]|localStorage\.(setItem|removeItem|clear)|sessionStorage\.(setItem|removeItem|clear)|location\.(reload|assign|replace)\(|location\.href\s*=|\.value\s*=[^=]|\.submit\(|requestSubmit/

export function acts(source: string): boolean {
  return ACTS.test(source)
}

/** maestro-d's name for a puppeteer key. */
export function keyName(key: string): string {
  const names: Record<string, string> = {
    ArrowDown: 'arrow_down',
    ArrowUp: 'arrow_up',
    ArrowLeft: 'arrow_left',
    ArrowRight: 'arrow_right',
    ' ': 'space',
    Space: 'space',
    Enter: 'enter',
    Escape: 'escape',
    Tab: 'tab',
    Backspace: 'backspace',
    Delete: 'delete',
    Home: 'home',
    End: 'end',
    PageUp: 'page_up',
    PageDown: 'page_down'
  }
  const name = names[key]
  if (name == null)
    throw new BlockedError(`maestro-d's web driver has no key "${key}"`)
  return name
}

interface Step {
  x: number
  y: number
  at: number
}

/** How far `point` lies from the segment `a`–`b`. */
export function offLine(point: Step, a: Step, b: Step): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = dx * dx + dy * dy
  const t =
    length === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)
        )
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

/** The maestro-d command a pointer pressed, moved and let go comes to. */
export function gestureCommand(
  steps: Step[],
  upAt: number
): { tap: { x: number; y: number } } | { drag: Record<string, unknown> } {
  const [first] = steps
  const last = steps[steps.length - 1]
  const point = (step: Step): string =>
    `${Math.round(step.x)},${Math.round(step.y)}`
  const moved = steps.some(
    step => Math.hypot(step.x - first.x, step.y - first.y) > 4
  )
  if (!moved && upAt - first.at < 450)
    return { tap: { x: Math.round(first.x), y: Math.round(first.y) } }
  if (!moved)
    // A long press where it stands: a drag that goes nowhere.
    return {
      drag: {
        from: { point: point(first) },
        to: { point: point(first) },
        holdDuration: upAt - first.at,
        duration: 50
      }
    }
  if (steps.some(step => offLine(step, first, last) > 24))
    throw new BlockedError(
      'the drag bends on its way: maestro-d drags in a straight line'
    )
  const moving = steps.find(
    step => Math.hypot(step.x - first.x, step.y - first.y) > 4
  )!
  return {
    drag: {
      from: { point: point(first) },
      to: { point: point(last) },
      holdDuration: Math.max(0, moving.at - first.at),
      duration: Math.max(100, upAt - moving.at)
    }
  }
}

/**
 * What the scoring tests ran against, now the stack: its world, its
 * browser sessions, and the switches the page's old API had (offline,
 * stalled, held saves, refused saves), as the stack's fault server and
 * database set them.
 */
export class Scoring {
  readonly ctx: HarnessContext
  private readonly sessions: WebSession[] = []
  private faultOn = { offline: false, stall: false, hold: false }
  private refusing = false
  hiddenOpponent = false
  awayTeamName: string | undefined
  private token: string | undefined
  ids: Ids | undefined
  world: FixtureManifest | undefined
  readonly fields = new WeakMap<object, FieldDriver>()
  /** Signs the scorer in through the API; a unit test gives its own. */
  signIn = async (
    api: string,
    account: { email: string; password: string }
  ): Promise<string> => {
    const { signInTestAccount } =
      await import('../../../src/test/passwordFixtures')
    return await signInTestAccount(api, account)
  }

  constructor(ctx: HarnessContext) {
    this.ctx = ctx
  }

  private async sql(text: string, values: unknown[] = []): Promise<void> {
    const control = this.ctx.stack.control
    if (control == null)
      throw new BlockedError('needs a stack whose database can be set up')
    await control.sql(text, values)
  }

  /** The scorer's API answer for `path`. */
  async api(path: string): Promise<any> {
    const world = this.world
    if (world == null) throw new Error('No scoring world is open')
    if (this.token == null) {
      // Every scenario signs a fresh scorer in: sign-ins are rate limited.
      await this.ctx.stack.control?.rateLimits({
        clear: ['password', 'passwordParameters']
      })
      this.token = await this.signIn(
        `${this.ctx.stack.origin}/api/v1`,
        world.accounts.scorer
      )
    }
    return await readJson(this.ctx.stack.origin, `/api/v1${path}`, {
      headers: { authorization: `Bearer ${this.token}` }
    })
  }

  private async applyFault(): Promise<void> {
    const on = Object.values(this.faultOn).some(Boolean)
    const setFault = this.ctx.stack.setFault
    if (setFault == null)
      throw new BlockedError('needs a stack whose fault server can be set')
    await setFault(on ? 'api-hang' : null)
  }

  /** No answer from the API at all, as with no connection. */
  async setOffline(on: boolean): Promise<void> {
    this.faultOn.offline = on
    await this.applyFault()
  }

  /** Every request waits, unanswered, until let go. */
  async setStall(on: boolean): Promise<void> {
    this.faultOn.stall = on
    await this.applyFault()
  }

  /** Saves wait, unanswered, until let go: the API holds every request. */
  async setHoldSaves(on: boolean): Promise<void> {
    this.faultOn.hold = on
    await this.applyFault()
  }

  /** The server refuses the scorer's saves: he keeps score for nobody. */
  async setRefuseSaves(on: boolean): Promise<void> {
    if (on === this.refusing || this.world == null) {
      this.refusing = on
      return
    }
    this.refusing = on
    const { world } = this
    const scorer = world.accounts.scorer.userId
    const teams = [world.ids.awayTeam, world.ids.homeTeam]
    if (on)
      await this.sql(
        "delete from scope_roles where user_id = $1 and role = 'scorekeeper' and scope_id = any($2)",
        [scorer, teams]
      )
    else
      for (const team of teams)
        await this.sql(
          "insert into scope_roles (id, user_id, scope_type, scope_id, role) values ($1, $2, 'team', $3, 'scorekeeper')",
          [`scr_${Math.random().toString(36).slice(2, 12)}`, scorer, team]
        )
  }

  /**
   * Opens the scoring tests' page on a fresh world, signed in as the scorer:
   * the old page's arguments, each as the stack can have it.
   */
  async open(
    path: string,
    scored: boolean | number = false,
    failed = false,
    failedRoster = false,
    bats: 'switch' | 'left' | 'right' = 'switch',
    _probe = false,
    logos?: 'valid' | 'broken',
    uiAnimations = false
  ): Promise<Opened> {
    if (failedRoster)
      throw new BlockedError(
        "the stack's fault server fails every API path at once: it cannot fail only each team's first roster read"
      )
    if (logos != null)
      throw new BlockedError(
        "team logos are files on the stack's Space: the scoring-field world stores none to show or to break"
      )
    if (uiAnimations)
      throw new BlockedError(
        'the scoring-field world has no live video for the game page to show'
      )
    const { ctx } = this
    const world = await ctx.fixture('scoring-field')
    this.world = world
    this.token = undefined
    const scorer = world.accounts.scorer.userId
    const gumbo = (await this.sqlRows(
      'select gumbo_id from gumbo_ids where user_id = $1',
      [scorer]
    )) as Array<{ gumbo_id: number | null }>
    const ids = new Ids(world, String(gumbo[0]?.gumbo_id ?? '100'))
    this.ids = ids
    await this.sql('update users set bats = $1 where id = $2', [
      bats,
      world.ids.awayUser1
    ])
    if (scored !== false)
      await this.sql(
        'update games set away_score = $1, home_score = 0 where id = $2',
        [typeof scored === 'number' ? scored : 0, world.ids.game]
      )
    if (this.awayTeamName != null)
      await this.sql('update teams set name = $1 where id = $2', [
        this.awayTeamName,
        world.ids.awayTeam
      ])
    if (this.hiddenOpponent) {
      // The away team is one the scorer may not see.
      await this.sql(
        'delete from scope_roles where user_id = $1 and scope_id = $2',
        [scorer, world.ids.awayTeam]
      )
      await this.sql(
        'delete from memberships where user_id = $1 and team_id = $2',
        [scorer, world.ids.awayTeam]
      )
    }
    if (this.refusing) {
      this.refusing = false
      await this.setRefuseSaves(true)
    }
    const session = await ctx.browser(
      { width: 1200, height: 900 },
      { observeNetwork: true }
    )
    this.sessions.push(session)
    await installSceneProbe(session.page)
    const token = await this.apiToken()
    const origin = ctx.stack.origin
    await session.m.openBrowser({ url: `${origin}/` })
    await session.m.setCookies({
      cookies: [
        {
          name: 'ts_session',
          value: token,
          domain: new URL(origin).hostname,
          path: '/',
          secure: origin.startsWith('https:'),
          httpOnly: true
        }
      ]
    })
    const opened = new Opened(this, session, ids)
    await session.m.openBrowser({
      url: `${origin}${failed ? path.replace('/games/g1', '/games/gam_missing') : ids.in(path)}`
    })
    return opened
  }

  private async apiToken(): Promise<string> {
    await this.api('/auth/me')
    return this.token!
  }

  private async sqlRows(text: string, values: unknown[]): Promise<unknown[]> {
    const control = this.ctx.stack.control
    if (control == null)
      throw new BlockedError('needs a stack whose database can be set up')
    return (await control.sql(text, values)).rows
  }

  async close(): Promise<void> {
    if (Object.values(this.faultOn).some(Boolean)) {
      this.faultOn = { offline: false, stall: false, hold: false }
      await this.applyFault().catch(() => undefined)
    }
    for (const session of this.sessions.splice(0))
      await session.close().catch(() => undefined)
  }
}

/** Requests the old page's API never expected: a write that is no save. */
export function unexpectedWrite(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS')
    return false
  if (!path.startsWith('/api/')) return false
  return !(
    (method === 'POST' && path.endsWith('/events')) ||
    path.endsWith('/swap-sides') ||
    path.endsWith('/roster-players') ||
    path.endsWith('/guest-players') ||
    path === '/api/v1/analytics/events'
  )
}

/** One opened page: what the old page's API let a test see of the server. */
export class Opened {
  readonly page: Page
  readonly unexpected: string[] = []
  readonly requests: string[] = []
  private readonly scoring: Scoring
  private readonly ids: Ids

  constructor(scoring: Scoring, session: WebSession, ids: Ids) {
    this.scoring = scoring
    this.ids = ids
    session.page.on('request', request => {
      const url = new URL(request.url())
      if (!url.pathname.startsWith('/api/')) return
      const path = ids.out(`${url.pathname}${url.search}`)
      this.requests.push(`${request.method()} ${path}`)
      if (unexpectedWrite(request.method(), url.pathname))
        this.unexpected.push(`${request.method()} ${ids.out(url.pathname)}`)
    })
    this.page = scoringPage(scoring, session, ids)
  }

  /** The game's current count, as the server holds it. */
  serverCount = async (): Promise<HeldCount | undefined> => {
    const events = await this.scoring.api(`/games/${this.ids.of('g1')}/events`)
    return (events?.currentPlay as { count?: HeldCount } | null)?.count
  }

  /** Whether the server has the game's sides swapped, and its generation. */
  serverSides = async (): Promise<{ swapped: boolean; generation: number }> => {
    const read = await this.scoring.api(`/games/${this.ids.of('g1')}`)
    return {
      swapped: read.homeTeamId !== this.ids.of('home'),
      generation: Number(read.generation ?? 0)
    }
  }

  /** The players the server holds for `teamId` that a test created. */
  createdPlayers = async (teamId: string): Promise<RosterEntry[]> => {
    const roster = (await this.scoring.api(
      `/teams/${this.ids.of(teamId)}/roster`
    )) as RosterEntry[]
    const world = this.scoring.world!
    const seeded = new Set(
      Object.entries(world.ids)
        .filter(([key]) => /^(away|home)User\d$/.test(key))
        .map(([, id]) => id)
    )
    return roster.filter(entry => !seeded.has(String(entry.userId)))
  }
}

const READS = new Set([
  '$',
  '$$',
  '$eval',
  '$$eval',
  'evaluate',
  'waitForSelector',
  'waitForFunction',
  'waitForResponse',
  'content',
  'url'
])

/**
 * The page the scoring tests drive, as a puppeteer `Page`: reads go to the
 * page, with the tests' ids turned into the world's; everything that acts
 * is a maestro-d command on the session's device.
 */
export function scoringPage(
  scoring: Scoring,
  session: WebSession,
  ids: Ids
): Page {
  const { m, page } = session
  const ctx = scoring.ctx
  let pointer = { x: 0, y: 0 }
  let gesture: Step[] | undefined
  let touched = false
  const now = (): number => Date.now()
  const pending = (what: string): void => {
    if (gesture != null)
      throw new BlockedError(
        `the test reads the page (${what}) in the middle of a drag: maestro-d cannot hold a pointer down between commands`
      )
  }
  const press = async (steps: Step[]): Promise<void> => {
    const command = gestureCommand(steps, now())
    if ('tap' in command) await m.tapOnPoint(command.tap)
    else await m.dragAndDrop(command.drag)
  }
  const touch = (): void => {
    if (touched) return
    touched = true
    ctx.degrade(
      "maestro-d's web driver presses with a mouse: the test's touches were mouse presses"
    )
  }
  const evalScript = async (script: string): Promise<unknown> => {
    await m.evalBrowserScript({ script, output: 'scoringEval' })
    const raw = (await m.vars()).scoringEval
    return raw == null || raw === '' || raw === 'undefined'
      ? undefined
      : JSON.parse(raw)
  }
  const literal = (value: unknown): string =>
    value === undefined ? 'undefined' : ids.in(JSON.stringify(value))
  const source = (fn: unknown): string =>
    typeof fn === 'function' ? ids.in(fn.toString()) : ids.in(String(fn))
  const inValue = (value: unknown): unknown =>
    value === undefined ? value : JSON.parse(literal(value))
  const revive = (fn: any): any => revived(fn, ids)
  /** A page script run through maestro-d: one that acts. */
  const actIn = async (
    target: string | null,
    all: boolean,
    fn: unknown,
    args: unknown[]
  ): Promise<unknown> => {
    const call =
      typeof fn === 'function'
        ? `(${source(fn)})(${[
            ...(target == null ? [] : ['__target']),
            ...args.map(literal)
          ].join(', ')})`
        : source(fn)
    const find =
      target == null
        ? ''
        : all
          ? `const __target = [...document.querySelectorAll(${JSON.stringify(ids.in(target))})];`
          : `const __target = document.querySelector(${JSON.stringify(ids.in(target))}); if (__target == null) throw new Error('No element ${target.replace(/'/g, "\\'")}');`
    return ids.value(
      await evalScript(
        `${find} const __value = await ${call}; return JSON.stringify(__value === undefined ? null : __value)`
      )
    )
  }
  const centreOf = async (handle: any): Promise<{ x: number; y: number }> => {
    const box = await handle.boundingBox()
    if (box == null) throw new Error('The element is not on screen')
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  const handleOf = (handle: any): any =>
    handle == null
      ? handle
      : new Proxy(handle, {
          get(target, prop) {
            if (prop === 'click' || prop === 'tap')
              return async () => {
                const at = await centreOf(target)
                await m.tapOnPoint({ x: Math.round(at.x), y: Math.round(at.y) })
              }
            if (prop === 'hover')
              return async () => {
                pointer = await centreOf(target)
              }
            if (prop === 'focus')
              return async () => {
                const at = await centreOf(target)
                await evalScript(
                  `document.elementFromPoint(${at.x}, ${at.y})?.focus(); return 'null'`
                )
              }
            if (prop === 'type')
              return async (text: string) => {
                await m.inputText({ text })
              }
            if (prop === 'press')
              return async (key: string) => {
                await m.pressKey({ key: keyName(key) })
              }
            if (prop === 'asLocator')
              return () => ({
                click: async () => {
                  const at = await centreOf(target)
                  await m.tapOnPoint({
                    x: Math.round(at.x),
                    y: Math.round(at.y)
                  })
                }
              })
            if (prop === 'evaluate')
              return async (fn: unknown, ...args: unknown[]) => {
                if (acts(source(fn))) {
                  const at = await centreOf(target)
                  return ids.value(
                    await evalScript(
                      `const __target = document.elementFromPoint(${at.x}, ${at.y}); return JSON.stringify(await (${source(fn)})(__target, ${args.map(literal).join(', ')}) ?? null)`
                    )
                  )
                }
                return ids.value(
                  await target.evaluate(revived(fn, ids), ...args)
                )
              }
            const value = Reflect.get(target, prop)
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
  const locator = (selector: string): any => ({
    click: async () => {
      const found = await page.waitForSelector(ids.in(selector), {
        visible: true
      })
      const at = await centreOf(found)
      await m.tapOnPoint({ x: Math.round(at.x), y: Math.round(at.y) })
    }
  })
  const network = (item: any): any =>
    new Proxy(item, {
      get(target, prop) {
        if (prop === 'url') return () => ids.out(target.url())
        if (prop === 'request')
          return () => network((target as HTTPResponse).request())
        if (prop === 'fetchPostData')
          return async () => {
            const text = await (target as HTTPRequest).fetchPostData()
            return text == null ? text : ids.out(text)
          }
        if (prop === 'json')
          return async () => ids.value(await (target as HTTPResponse).json())
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  const mouse = {
    move: async (x: number, y: number): Promise<void> => {
      pointer = { x, y }
      gesture?.push({ x, y, at: now() })
    },
    down: async (): Promise<void> => {
      gesture = [{ ...pointer, at: now() }]
    },
    up: async (): Promise<void> => {
      const steps = gesture ?? [{ ...pointer, at: now() }]
      gesture = undefined
      await press(steps)
    },
    click: async (x: number, y: number): Promise<void> => {
      pointer = { x, y }
      await m.tapOnPoint({ x: Math.round(x), y: Math.round(y) })
    }
  }
  const touchscreen = {
    touchStart: async (x: number, y: number): Promise<void> => {
      touch()
      pointer = { x, y }
      gesture = [{ x, y, at: now() }]
    },
    touchMove: async (x: number, y: number): Promise<void> => {
      pointer = { x, y }
      gesture?.push({ x, y, at: now() })
    },
    touchEnd: async (): Promise<void> => {
      const steps = gesture ?? [{ ...pointer, at: now() }]
      gesture = undefined
      await press(steps)
    },
    tap: async (x: number, y: number): Promise<void> => {
      touch()
      await m.tapOnPoint({ x: Math.round(x), y: Math.round(y) })
    }
  }
  const keyboard = {
    press: async (key: string): Promise<void> => {
      await m.pressKey({ key: keyName(key) })
    },
    type: async (text: string): Promise<void> => {
      await m.inputText({ text })
    }
  }
  const acting: Record<string, unknown> = {
    mouse,
    touchscreen,
    keyboard,
    $: async (selector: string) => {
      pending('$')
      return handleOf(await page.$(ids.in(selector)))
    },
    $$: async (selector: string) => {
      pending('$$')
      return (await page.$$(ids.in(selector))).map(handleOf)
    },
    $eval: async (selector: string, fn: any, ...args: unknown[]) => {
      pending('$eval')
      if (acts(source(fn))) return await actIn(selector, false, fn, args)
      return ids.value(
        await page.$eval(ids.in(selector), revive(fn), ...args.map(inValue))
      )
    },
    $$eval: async (selector: string, fn: any, ...args: unknown[]) => {
      pending('$$eval')
      if (acts(source(fn))) return await actIn(selector, true, fn, args)
      return ids.value(
        await page.$$eval(ids.in(selector), revive(fn), ...args.map(inValue))
      )
    },
    evaluate: async (fn: any, ...args: unknown[]) => {
      pending('evaluate')
      if (acts(source(fn))) return await actIn(null, false, fn, args)
      return ids.value(await page.evaluate(revive(fn), ...args.map(inValue)))
    },
    waitForSelector: async (selector: string, options?: unknown) => {
      pending('waitForSelector')
      return handleOf(
        await page.waitForSelector(ids.in(selector), options as any)
      )
    },
    waitForFunction: async (fn: any, options?: unknown, ...args: unknown[]) => {
      pending('waitForFunction')
      return await page.waitForFunction(
        revive(fn),
        options ?? {},
        ...args.map(inValue)
      )
    },
    waitForResponse: async (
      match: (response: HTTPResponse) => boolean,
      options?: unknown
    ) =>
      network(
        await page.waitForResponse(
          response => match(network(response)),
          options as any
        )
      ),
    on: (event: string, listener: (...args: any[]) => void) => {
      if (event === 'dialog')
        throw new BlockedError(
          'the test answers a page dialog through puppeteer: maestro-d has no step for a beforeunload dialog'
        )
      page.on(event as any, (item: any) => {
        listener(
          event === 'request' || event === 'response' ? network(item) : item
        )
      })
      return proxy
    },
    once: (event: string, listener: (...args: any[]) => void) => {
      if (event === 'dialog')
        throw new BlockedError(
          'the test answers a page dialog through puppeteer: maestro-d has no step for a beforeunload dialog'
        )
      page.once(event as any, listener)
      return proxy
    },
    url: () => ids.out(page.url()),
    content: async () => ids.out(await page.content()),
    focus: async (selector: string) => {
      await evalScript(
        `document.querySelector(${JSON.stringify(ids.in(selector))}).focus(); return 'null'`
      )
    },
    click: async (selector: string) => {
      await locator(selector).click()
    },
    locator,
    goto: async (url: string) => {
      await m.openBrowser({ url: ids.in(url) })
    },
    goBack: async () => {
      await m.back()
    },
    reload: async (options?: { timeout?: number }) => {
      const loaded = page
        .waitForNavigation({ timeout: options?.timeout ?? 30000 })
        .catch(() => undefined)
      await evalScript('setTimeout(() => location.reload(), 0); return "null"')
      await loaded
    },
    setViewport: async (viewport: { width: number; height: number }) => {
      await session.resize(viewport)
    },
    addStyleTag: async ({ content }: { content: string }) => {
      await evalScript(
        `const style = document.createElement('style'); style.textContent = ${JSON.stringify(content)}; document.head.appendChild(style); return 'null'`
      )
    },
    screenshot: async (options: { path?: string } = {}) => {
      const name = basename(options.path ?? `screen-${Date.now()}.png`)
      await m.takeScreenshot({ path: join(ctx.runDir, name) })
    },
    browserContext: () => {
      throw new BlockedError(
        'the test acts on a page while another tab is in front: maestro-d drives the tab in front'
      )
    },
    bringToFront: async () => undefined,
    emulateCPUThrottling: async () => undefined,
    close: async () => undefined
  }
  const proxy: Page = new Proxy(page, {
    get(target, prop) {
      if (typeof prop === 'string' && Object.hasOwn(acting, prop)) {
        const value = acting[prop]
        if (typeof value === 'function' && READS.has(prop) && gesture != null)
          return async () => {
            pending(prop)
          }
        return value
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  scoring.fields.set(proxy, maestroDriver(m))
  return proxy
}

/** The field driver for a scoring page: its device, through maestro-d. */
export function fieldOf(page: Page): FieldDriver {
  const field = scoring().fields.get(page)
  if (field == null) throw new Error('No scoring page')
  return field
}

/** Opens the tests' page on the stack, as the old `open` did. */
export async function open(
  path: string,
  scored: boolean | number = false,
  failed = false,
  failedRoster = false,
  bats: 'switch' | 'left' | 'right' = 'switch',
  probe = false,
  logos?: 'valid' | 'broken',
  uiAnimations = false
): Promise<Opened> {
  return await scoring().open(
    path,
    scored,
    failed,
    failedRoster,
    bats,
    probe,
    logos,
    uiAnimations
  )
}

export interface ProbeFiber {
  memoizedProps?: {
    value?: { getState?: () => { scene?: Scene; camera?: PerspectiveCamera } }
  }
  child?: ProbeFiber
  sibling?: ProbeFiber
}

/** What the scene probe keeps on the page's window. */
export interface SceneProbeWindow {
  qaRoots: Array<{ current: ProbeFiber }>
  qaScene?: Scene
  qaCamera?: PerspectiveCamera
  __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown
}

/** Keeps the field's three.js scene and camera on `window.qaScene`. */
/* eslint-disable @typescript-eslint/prefer-optional-chain -- Browser evaluation cannot reference generated Sucrase helpers. */
export async function captureScene(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = window as unknown as SceneProbeWindow
    const scan = (fiber?: ProbeFiber): void => {
      if (fiber == null) return
      const value =
        fiber.memoizedProps == null ? undefined : fiber.memoizedProps.value
      const state =
        value == null || value.getState == null ? undefined : value.getState()
      if (state != null && state.scene != null) {
        host.qaScene = state.scene
        host.qaCamera = state.camera
      }
      scan(fiber.child)
      scan(fiber.sibling)
    }
    for (const root of host.qaRoots) scan(root.current)
  })
}
/* eslint-enable @typescript-eslint/prefer-optional-chain */

/** The hit guide's bearing and where its marker lands. */
export async function readGuide(
  page: Page
): Promise<{ bearing: number; x: number; z: number }> {
  await captureScene(page)
  return await page.evaluate(() => {
    const scene = (window as any).qaScene
    const arc = scene.getObjectByName('ball-arc')
    const target = arc.getObjectByName('destination-marker').position
    return { bearing: Number(arc.userData.bearing), x: target.x, z: target.z }
  })
}

/** Presses the visible, enabled control labelled `label`. */
export async function click(page: Page, label: string): Promise<void> {
  const selector = `[aria-label="${label}"]:not([aria-disabled="true"]):not(:disabled)`
  const opening =
    label === 'Create Player' &&
    (await page.$('[aria-label="First Name"]')) == null
  await page.waitForFunction(
    (selector: string) =>
      Array.from(document.querySelectorAll(selector)).some(node =>
        node.checkVisibility()
      ),
    {},
    selector
  )
  for (const match of (await page.$$(selector)).reverse()) {
    if (!(await match.isVisible())) continue
    await match.asLocator().click()
    // Let the sheet transition finish before targeting its next control.
    await sleep(350)
    break
  }
  if (opening) await page.waitForSelector('[aria-label="First Name"]')
}

/** The Score pill, then the Score screen's Full game scoring. */
export async function startScoring(page: Page): Promise<void> {
  await click(page, 'Score')
  await page.waitForFunction(() => location.pathname.endsWith('/score-game'))
  await click(page, 'Full game scoring')
  await page.waitForFunction(() => location.pathname.endsWith('/score'))
}

export async function openPlaceholderSheet(page: Page): Promise<void> {
  // Players are made on the roster tab; the other tabs stay drawn, hidden.
  const shown = async (label: string): Promise<boolean> =>
    (await (await page.$(`[aria-label="${label}"]`))?.isVisible()) === true
  if (!(await shown('First Name')) && !(await shown('Create Player')))
    await click(page, 'Roster')
  if ((await page.$('[aria-label="First Name"]')) == null)
    await click(page, 'Create Player')
  await click(page, 'Create Placeholder Player')
}

export async function addPlaceholders(
  page: Page,
  count: 1 | 16
): Promise<void> {
  await openPlaceholderSheet(page)
  // Let the slide-up Modal install its focus trap before keyboard input.
  await sleep(400)
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Number of placeholder players"]')!
        .closest('[role="dialog"]') != null
  )
  await page.focus('[aria-label="Number of placeholder players"]')
  await page.keyboard.press(count === 16 ? 'End' : 'Home')
  await page.waitForSelector(
    `[aria-label="Player count ${count}"][aria-selected="true"]`
  )
  await click(page, 'Create')
  await page.waitForSelector('[aria-label="Number of placeholder players"]', {
    hidden: true
  })
  await sleep(400)
  // Making placeholders closes the player sheet; Escape is only for one
  // still open, since on the roster it would close the editor.
  if ((await page.$('[aria-label="First Name"]')) != null)
    await page.keyboard.press('Escape')
  await page.waitForSelector('[aria-label="First Name"]', { hidden: true })
}

export async function chooseHit(page: Page, outcome: string): Promise<void> {
  await click(page, 'Swing in Play')
  if (outcome === 'Batter Interference') await click(page, 'Batter Out')
  await click(page, outcome)
  await page.waitForSelector('canvas[data-field-ready="true"]')
  await page.waitForSelector(
    outcome === 'Home Run'
      ? '[aria-label^="Drag where the ball was hit"]'
      : '[aria-label^="Tap or drag a player to where the ball was fielded"]'
  )
  const field = fieldOf(page)
  // A home run lands in the stands beyond center; anything else is taken by
  // the first player the field offers, just where he stands.
  if (outcome === 'Home Run') await aimLanding(field, 0.5, 0.18)
  else await placeOffered(field)
  await setTrajectory(field)
}

export async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Ball"]')!
        .getAttribute('aria-disabled') !== 'true',
    { timeout: 30000 }
  )
}

/** Where a base's point at height `y` sits on the canvas, in the home view. */
export async function projectBase(
  page: Page,
  base: number,
  y = 0
): Promise<[number, number]> {
  const rect = await page.$eval('canvas', canvas => {
    const r = canvas.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  const camera = new PerspectiveCamera()
  applyFieldCamera(camera, {
    width: rect.width,
    height: rect.height,
    view: 'home',
    zoom: 1.25,
    tilt: (-11 * Math.PI) / 180,
    heightOffset: 33,
    bottomExtension: 112
  })
  const point = new Vector3(BASES[base].x, y, BASES[base].z).project(camera)
  return [
    rect.x + ((point.x + 1) * rect.width) / 2,
    rect.y + ((1 - point.y) * rect.height) / 2
  ]
}

/** A theme colour, `#rrggbb` or `#rrggbbaa`, as computed style reads it. */
export function cssColor(hex: string): string {
  const [r, g, b, a] = [1, 3, 5, 7].map(i => parseInt(hex.slice(i, i + 2), 16))
  return Number.isNaN(a)
    ? `rgb(${r}, ${g}, ${b})`
    : `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 100) / 100})`
}

/** Taps a sheet's control once the sheet has stopped sliding. */
export async function tapSettled(page: Page, label: string): Promise<void> {
  await page
    .locator(`[aria-label="${label}"]:not([aria-disabled="true"])`)
    .click()
}

export async function overrideBases(
  page: Page,
  bases: Array<['First base' | 'Second base' | 'Third base', string]>
): Promise<void> {
  if (bases.length === 0) return
  await tapSettled(page, 'Open scoring menu')
  await tapSettled(page, 'Overrides')
  for (const [base, player] of bases) {
    await tapSettled(page, base)
    const label = `Choose ${base} ${player}`
    // Empty and unnumbered players have no suffix; numbered players end in #N.
    await page
      .locator(
        `[aria-label="${label}"]:not([aria-disabled="true"]), [aria-label^="${label} #"]:not([aria-disabled="true"])`
      )
      .click()
  }
  await tapSettled(page, 'Apply Override')
}

/** Presses the runner at `fromBase` and holds him over `toBase`, still down. */
export async function dragRunner(
  page: Page,
  fromBase: number,
  toBase: number
): Promise<void> {
  const from = await projectBase(page, fromBase, 6)
  const to = await projectBase(page, toBase, 0)
  await page.touchscreen.touchStart(...from)
  await sleep(400)
  await page.touchscreen.touchMove(to[0], to[1])
}

export async function runnerNearBase(
  page: Page,
  base: number
): Promise<boolean> {
  await captureScene(page)
  const { x, z } = BASES[base]
  return await page.evaluate(
    (tx: number, tz: number) => {
      const scene = (window as any).qaScene as
        | {
            traverse: (
              visit: (obj: {
                name: string
                position: { x: number; z: number }
              }) => void
            ) => void
          }
        | undefined
      if (scene == null) return false
      let best = Infinity
      interface Placed {
        name: string
        position: { x: number; z: number }
      }
      scene.traverse((obj: Placed) => {
        if (!obj.name.startsWith('player-offense-')) return
        const dx = obj.position.x - tx
        const dz = obj.position.z - tz
        best = Math.min(best, dx * dx + dz * dz)
      })
      return best < 36
    },
    x,
    z
  )
}

export async function waitRunnerNearBase(
  page: Page,
  base: number
): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (await runnerNearBase(page, base)) return
    await sleep(100)
  }
  if (!(await runnerNearBase(page, base)))
    throw new Error(`runner near ${base}: expected true`)
}

/** The scorer's mock-era switches, as the running scenario sets them. */
export const server = {
  offline: async (on: boolean): Promise<void> => {
    await scoring().setOffline(on)
  },
  stall: async (on: boolean): Promise<void> => {
    await scoring().setStall(on)
  },
  holdSaves: async (on: boolean): Promise<void> => {
    await scoring().setHoldSaves(on)
  },
  refuseSaves: async (on: boolean): Promise<void> => {
    await scoring().setRefuseSaves(on)
  },
  hiddenOpponent: (on: boolean): void => {
    scoring().hiddenOpponent = on
  },
  awayTeamName: (name: string | undefined): void => {
    scoring().awayTeamName = name
  },
  /** The away team's name a test set, for what it expects to read. */
  awayTeamNameNow: (): string | undefined => scoring().awayTeamName
}
