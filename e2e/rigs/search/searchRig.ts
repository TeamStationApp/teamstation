import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'

import type { FixtureAccount, FixtureManifest } from '../../core/fixtures'
import type { JevControl, JevView } from '../../core/jevStub'
import { BlockedError } from '../../core/result'
import {
  defineE2e,
  type E2eContext,
  type E2eSpec,
  type WebSession
} from '../../core/spec'

/**
 * What the search scenarios share: a phone-sized browser on the stack's
 * web app, signed in through the real form, the Search tab's field, its
 * result rows as the page shows them, the Jev stand-in, and the after
 * screenshots the plan's proving artifacts name. maestro-d does every tap
 * and keystroke; the page is only read.
 */

/** The size the proving screenshots are taken at. */
export const PHONE = { width: 390, height: 844 }

/** The Search tab field's accessibility label, its placeholder. */
export const SEARCH_FIELD = 'Search leagues, seasons, teams and people'

/**
 * Where a run also copies its proving screenshots, besides its run
 * directory: `TS_SEARCH_ARTIFACTS=<dir>`.
 */
export const ARTIFACTS_ENV = 'TS_SEARCH_ARTIFACTS'

/** A CSS selector for an element by its whole accessible name. */
export function byLabel(label: string): string {
  return `[aria-label="${label.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
}

/** A CSS selector for an element whose accessible name starts so. */
export function byLabelStart(start: string): string {
  return `[aria-label^="${start.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
}

/**
 * maestro-d matches `text` as a regular expression: this one matches `text`
 * alone. Metacharacters go in a one-character class, `[.]`, because
 * maestro-d's web driver reports an element matched by a backslash escape
 * such as `\.` as not visible even when it is on screen. `]`, `\\` and `^`
 * mean something else in a class, so they keep their backslash.
 */
export function exactly(text: string): string {
  return text.replace(/[\]\\^]/g, '\\$&').replace(/[.*+?${}()|[]/g, '[$&]')
}

/** One result row as the page shows it. */
export interface SearchRow {
  /** `Open <name>` and maybe its place. */
  label: string
  /** Everything the row reads, its kind pill and city included. */
  text: string
  /** The Follow pill's accessible name, if the row has one. */
  follow: string | null
}

/** The page script that reads the result rows, top to bottom. */
export const ROWS_SCRIPT = `[...document.querySelectorAll('[data-testid="search-result-row"]')].map(row => {
  const open = row.querySelector('[aria-label^="Open "]')
  const follow = row.querySelector('[aria-label^="Follow "], [aria-label^="Unfollow "]')
  return {
    label: open == null ? '' : open.getAttribute('aria-label'),
    text: row.innerText,
    follow: follow == null ? null : follow.getAttribute('aria-label')
  }
})`

/** The rows of this world, whose organizations' names end in its nonce. */
export function ownRows(rows: SearchRow[], tag: string): SearchRow[] {
  return rows.filter(row => row.label.includes(` ${tag}`))
}

/** The name a row opens, its place left off. */
export function rowName(row: SearchRow): string {
  return row.label.replace(/^Open /, '')
}

/** The kind pill a row reads. */
export function rowKind(row: SearchRow): string | undefined {
  return ['League', 'Season', 'Team', 'Person'].find(kind =>
    row.text.split('\n').some(line => line.trim() === kind)
  )
}

/** The search world's cities, as a pill or a row reads them, by miles from San Diego. */
const CITIES: Array<[string, number, number]> = [
  ['San Diego, CA', 32.71571, -117.16472],
  ['National City, CA', 32.67811, -117.0992],
  ['Chula Vista, CA', 32.64005, -117.0842],
  ['La Mesa, CA', 32.76783, -117.02308],
  ['El Cajon, CA', 32.79477, -116.96253],
  ['Escondido, CA', 33.11921, -117.08642],
  ['Phoenix, AZ', 33.44838, -112.07404],
  ['Sacramento, CA', 38.58157, -121.4944]
]

function milesBetween(a: [number, number], b: [number, number]): number {
  const radians = (degrees: number): number => (degrees * Math.PI) / 180
  const dLat = radians(b[0] - a[0])
  const dLon = radians(b[1] - a[1])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a[0])) * Math.cos(radians(b[0])) * Math.sin(dLon / 2) ** 2
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)))
}

export const MILES_FROM_SAN_DIEGO: Record<string, number> = Object.fromEntries(
  CITIES.map(([label, lat, lon]) => [
    label,
    milesBetween([CITIES[0][1], CITIES[0][2]], [lat, lon])
  ])
)

/** The search world's city a row reads, if any. */
export function rowCity(row: SearchRow): string | undefined {
  return Object.keys(MILES_FROM_SAN_DIEGO).find(label =>
    row.text.split('\n').some(line => line.trim() === label)
  )
}

/**
 * Why rows with a San Diego pill are out of order, if they are: San Diego's
 * first, then the rest by 5-mile ring outward.
 */
export function ringProblems(rows: SearchRow[]): string[] {
  const problems: string[] = []
  let last = -Infinity
  for (const row of rows) {
    const city = rowCity(row)
    if (city == null) continue
    const ring =
      city === 'San Diego, CA' ? -1 : Math.floor(MILES_FROM_SAN_DIEGO[city] / 5)
    if (ring < last)
      problems.push(`${row.label} (${city}) is after a farther row`)
    last = Math.max(last, ring)
  }
  return problems
}

/**
 * A wait that can no longer succeed, however long it is given: `within`
 * throws it at once instead of asking again.
 */
export class Overtaken extends Error {
  override name = 'Overtaken'
}

/**
 * Asks `check` until it stops throwing, or the time is up. An `Overtaken`
 * error ends the wait at once.
 */
export async function within<T>(
  timeoutMs: number,
  check: () => Promise<T>,
  stepMs = 100
): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    try {
      return await check()
    } catch (error) {
      if (error instanceof Overtaken || Date.now() >= end) throw error
    }
    await new Promise(resolve => setTimeout(resolve, stepMs))
  }
}

/** The stack's Jev stand-in, or a blocked run on a stack without one. */
export function jevOf(ctx: E2eContext): {
  read: () => Promise<JevView>
  set: (control: Partial<JevControl>) => Promise<JevView>
} {
  const jev = ctx.stack.jev
  if (jev == null) {
    throw new BlockedError(
      'this stack has no Jev stand-in: bring one up with stack up from a ref that has it'
    )
  }
  return jev
}

/** The API's base on the stack. */
export function apiBase(ctx: E2eContext): string {
  const api = ctx.stack.attached?.api
  return (typeof api === 'string' ? api : `${ctx.stack.origin}/api/v1`).replace(
    /\/$/,
    ''
  )
}

/**
 * A session on the stack's API for setup and read-back, signed in with the
 * account's password as the app does. Server code loads here, not when the
 * spec is imported.
 */
export async function apiClient(
  ctx: E2eContext,
  account: FixtureAccount
): Promise<any> {
  const { TeamStationClient } = await import('../../../src/common/api')
  const { passwordBytes } = await import('../../../src/common/passwordProtocol')
  const { nativeArgon } = await import('../../../src/server/auth/passwords')
  const client = new TeamStationClient({
    baseUrl: apiBase(ctx),
    passwordKdf: async (password: string, parameters: any) =>
      await nativeArgon(passwordBytes(password), parameters)
  })
  await client.signInWithPassword(account.email, account.password)
  return client
}

/** The world's organization's whole name. */
export function named(world: FixtureManifest, name: string): string {
  return `${name} ${world.nonce}`
}

/** Opens a phone-sized browser on the stack, signed in as `role`, or signed out. */
export async function openSignedIn(
  ctx: E2eContext,
  role: string | null
): Promise<WebSession> {
  const web = await ctx.browser(PHONE)
  if (role == null) return web
  await web.m.openLink({ link: `${ctx.stack.origin}/sign-in` })
  await ctx.signIn(role, web.m)
  return web
}

/** Opens the Search tab, its field empty. */
export async function openSearch(
  ctx: E2eContext,
  web: WebSession
): Promise<void> {
  await web.m.openLink({ link: `${ctx.stack.origin}/discover` })
  await web.m.assertVisible({ css: byLabel(SEARCH_FIELD), timeout: 60000 })
}

/** Where a search field and the first answer under it are drawn, in a browser. */
export interface FieldPlacement {
  /** Null when no field is drawn. */
  fieldTop: number | null
  fieldBottom: number | null
  /** Null when no answer is drawn. */
  firstTop: number | null
  windowHeight: number
}

/**
 * Reads where the search field (`fieldCss`, its whole rounded box) and the
 * first answer (`firstCss`) are drawn, for `expectFieldOnTop`.
 */
export async function fieldPlacement(
  web: WebSession,
  fieldCss: string,
  firstCss: string
): Promise<FieldPlacement> {
  return (await web.page.evaluate(`(() => {
    const box = css => {
      const node = document.querySelector(css)
      return node == null ? null : node.getBoundingClientRect()
    }
    const field = box(${JSON.stringify(fieldCss)})
    const first = box(${JSON.stringify(firstCss)})
    return {
      fieldTop: field == null ? null : field.top,
      fieldBottom: field == null ? null : field.bottom,
      firstTop: first == null ? null : first.top,
      windowHeight: window.innerHeight
    }
  })()`)) as FieldPlacement
}

/**
 * A browser draws a search field at the top, as Search and Add Player both
 * do: in the top third of the window, above the first answer.
 */
export function expectFieldOnTop(placement: FieldPlacement): void {
  expect(placement.fieldTop, 'a search field drawn').not.equals(null)
  expect(placement.firstTop, 'an answer drawn').not.equals(null)
  expect(placement.fieldTop!, 'the field in the top third').lessThan(
    placement.windowHeight / 3
  )
  expect(
    placement.fieldBottom!,
    'the field above the first answer'
  ).lessThanOrEqual(placement.firstTop! + 1)
}

/** Types into the Search field after what it holds. */
export async function typeSearch(web: WebSession, text: string): Promise<void> {
  await web.m.tapOn({ css: byLabel(SEARCH_FIELD), timeout: 15000 })
  await web.m.inputText({ text })
}

/** Empties the Search field with its clear button. */
export async function clearSearch(web: WebSession): Promise<void> {
  await web.m.tapOn({ css: byLabel('Clear search'), timeout: 15000 })
}

/** What the Search field holds. */
export async function fieldText(web: WebSession): Promise<string> {
  return (await web.page.evaluate(
    `document.querySelector(${JSON.stringify(byLabel(SEARCH_FIELD))}).value`
  )) as string
}

export async function readRows(web: WebSession): Promise<SearchRow[]> {
  return (await web.page.evaluate(ROWS_SCRIPT)) as SearchRow[]
}

/** The alerts the page shows, which a search that went well has none of. */
export async function alerts(web: WebSession): Promise<string[]> {
  return (await web.page.evaluate(
    `[...document.querySelectorAll('[role="alert"]')].map(node => node.innerText)`
  )) as string[]
}

/** The page's path, for a row that opened a page. */
export async function pathname(web: WebSession): Promise<string> {
  return (await web.page.evaluate('location.pathname')) as string
}

/**
 * Saves the screen as one of the plan's proving screenshots: in the run
 * directory, and in `TS_SEARCH_ARTIFACTS` when the run names one.
 */
export async function proveScreen(
  ctx: E2eContext,
  web: WebSession,
  name: string
): Promise<void> {
  const file = ctx.artifact(name)
  writeFileSync(file, await web.m.screenshot())
  const dir = process.env[ARTIFACTS_ENV]
  if (dir != null && dir !== '') {
    mkdirSync(dir, { recursive: true })
    copyFileSync(file, join(dir, name))
  }
}

/** Writes a proving log beside the screenshots, the same way. */
export function proveLog(ctx: E2eContext, name: string, text: string): void {
  const file = ctx.artifact(name)
  writeFileSync(file, text)
  const dir = process.env[ARTIFACTS_ENV]
  if (dir != null && dir !== '') {
    mkdirSync(dir, { recursive: true })
    copyFileSync(file, join(dir, name))
  }
}

const run = promisify(execFile)

/** The shell's quoting of one word. */
export function shellWord(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/**
 * How many lines of the stack API's log hold `needle`, read over the
 * observer's SSH, or undefined when the stack's handle names no log.
 */
export async function serverLogCount(
  ctx: E2eContext,
  needle: string,
  exec: typeof run = run
): Promise<number | undefined> {
  const handle = ctx.stack.attached
  const ssh = handle?.ssh
  const log = handle?.serverLog
  if (typeof ssh !== 'string' || typeof log !== 'string') return undefined
  const { SSH_OPTIONS } = await import('../../core/streamingStack')
  // grep exits 1 for no line, which is an answer: 0.
  const reply = await exec('ssh', [
    ...SSH_OPTIONS,
    ssh,
    `grep -c -F -- ${shellWord(needle)} ${shellWord(log)} || true`
  ])
  const count = String(reply.stdout).trim()
  return count === '' ? 0 : Number(count)
}

/** What every search spec declares alike. */
export function searchSpec(options: {
  id: string
  title: string
  covers: string[]
  minutes: number
  secrets?: string[]
  scenarios: E2eSpec['scenarios']
}): E2eSpec {
  return defineE2e({
    id: options.id,
    title: options.title,
    kind: 'e2e',
    covers: options.covers,
    stack: 'isolated',
    fixtures: ['search'],
    // The Jev key and the Jev stand-in are the stack's, not the world's.
    exclusive: true,
    surfaces: { 'web-chromium': { devices: [] } },
    services: ['web', 'api'],
    apps: [],
    secrets: options.secrets ?? [],
    costUsd: 0,
    minutes: options.minutes,
    guards: [],
    faults: [],
    manual: false,
    scenarios: options.scenarios
  })
}

/**
 * Seeds the scenario's own search world and opens a phone-sized browser
 * signed in as `role`, or signed out, with the Jev stand-in back to its
 * default script. The search socket's frames are watched from before any
 * Search tab or Add Player list opens one.
 */
export async function searchWorld(
  ctx: E2eContext,
  role: string | null
): Promise<{
  world: FixtureManifest
  web: WebSession
  tag: string
  frames: SearchFrames
}> {
  await jevOf(ctx).set({})
  const world = await ctx.fixture('search')
  const web = await openSignedIn(ctx, role)
  const frames = await watchSearchFrames(web)
  return { world, web, tag: world.nonce, frames }
}

/** A `search` frame the page sent, on one socket. */
export interface SentSearch {
  /** Chrome's id for the socket it went over. */
  socket: string
  seq: number
  text: string
  /** When the frame was seen leaving the page, by this process's clock. */
  at: number
}

/** The search socket's frames, as the page sent and received them. */
export interface SearchFrames {
  /** The stage of every `results` frame received, in order. */
  stages: () => string[]
  /** The last `search` frame sent, on whichever socket. */
  lastSent: () => SentSearch | undefined
  /** The stages of the `results` frames received for one sent frame. */
  answers: (sent: Pick<SentSearch, 'socket' | 'seq'>) => string[]
  /** How many sockets have sent a `search` frame: more than one is a reconnect. */
  sockets: () => number
}

/**
 * Keeps the search socket's frames by socket: `sent` and `received` take
 * a socket's id and a frame's JSON text, and ignore any other frame.
 */
export function searchFrameLog(): {
  sent: (socket: string, payload: string, at?: number) => void
  received: (socket: string, payload: string) => void
  frames: SearchFrames
} {
  const parse = (payload: string): any => {
    try {
      return JSON.parse(payload)
    } catch {
      return undefined
    }
  }
  let last: SentSearch | undefined
  const sockets = new Set<string>()
  const stages: string[] = []
  const answered = new Map<string, string[]>()
  const keyOf = (socket: string, seq: number): string => `${socket} ${seq}`
  return {
    sent: (socket, payload, at = Date.now()) => {
      const frame = parse(payload)
      if (
        frame?.type !== 'search' ||
        typeof frame.seq !== 'number' ||
        typeof frame.text !== 'string'
      )
        return
      last = { socket, seq: frame.seq, text: frame.text, at }
      sockets.add(socket)
    },
    received: (socket, payload) => {
      const frame = parse(payload)
      if (
        frame?.type !== 'results' ||
        typeof frame.seq !== 'number' ||
        typeof frame.stage !== 'string'
      )
        return
      stages.push(frame.stage)
      const key = keyOf(socket, frame.seq)
      answered.set(key, [...(answered.get(key) ?? []), frame.stage])
    },
    frames: {
      stages: () => [...stages],
      lastSent: () => (last == null ? undefined : { ...last }),
      answers: sent => [...(answered.get(keyOf(sent.socket, sent.seq)) ?? [])],
      sockets: () => sockets.size
    }
  }
}

/**
 * The search socket's frames as the browser sends and receives them, from
 * Chrome's own network record: reading, not acting. Start it before the
 * page opens its search socket.
 */
export async function watchSearchFrames(
  web: WebSession
): Promise<SearchFrames> {
  const cdp = await web.page.createCDPSession()
  await cdp.send('Network.enable')
  const log = searchFrameLog()
  cdp.on('Network.webSocketFrameSent', event => {
    log.sent(event.requestId, event.response.payloadData)
  })
  cdp.on('Network.webSocketFrameReceived', event => {
    log.received(event.requestId, event.response.payloadData)
  })
  return log.frames
}

/** The settle window: two equal reads this far apart. */
export const SETTLE_MS = 300

/**
 * The rows the page shows for `typed`, once they are its answer: the last
 * frame the page sent asks for exactly `typed`, a `results` frame (of
 * `stage`, if named) answered that frame, and two reads `SETTLE_MS` apart
 * agree. `ready` may ask more of the rows; it throws while they fall short.
 * Rows read sooner can be the answer to a prefix of `typed`, which another
 * world's names can match. `seenAt` is when the first of the two reads
 * began.
 *
 * With `stage: 'lexicographic'`, the rows are that answer only if no `jev`
 * frame for the same seq had arrived by the end of the second read: one
 * that had may already be on screen. That throws `Overtaken`, since
 * waiting longer cannot help; the caller types again.
 */
export async function answered<T = SearchRow[]>(
  web: WebSession,
  frames: SearchFrames,
  typed: string,
  options: {
    stage?: 'lexicographic' | 'jev'
    ready?: (rows: T) => void | Promise<void>
    read?: (web: WebSession) => Promise<T>
    timeoutMs?: number
    settleMs?: number
  } = {}
): Promise<{ rows: T; seenAt: number }> {
  const read =
    options.read ?? (readRows as unknown as (web: WebSession) => Promise<T>)
  const settleMs = options.settleMs ?? SETTLE_MS
  return await within(options.timeoutMs ?? 10000, async () => {
    const sent = frames.lastSent()
    if (sent?.text !== typed)
      throw new Error(
        `not yet: the page last asked for ${JSON.stringify(sent?.text)}, not ${JSON.stringify(typed)}`
      )
    const stages = frames.answers(sent)
    if (
      options.stage == null
        ? stages.length === 0
        : !stages.includes(options.stage)
    )
      throw new Error(
        `not yet: no ${options.stage ?? 'results'} answer to ${JSON.stringify(typed)}`
      )
    const seenAt = Date.now()
    const first = await read(web)
    await new Promise(resolve => setTimeout(resolve, settleMs))
    const rows = await read(web)
    if (
      options.stage === 'lexicographic' &&
      frames.answers(sent).includes('jev')
    )
      throw new Overtaken(
        `Jev answered ${JSON.stringify(typed)} before its lexicographic rows were read`
      )
    if (JSON.stringify(rows) !== JSON.stringify(first))
      throw new Error('not yet: the rows are still changing')
    await options.ready?.(rows)
    return { rows, seenAt }
  })
}
