import { execFileSync, spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'

import puppeteer, { type Page } from 'puppeteer'
import { WebSocket } from 'ws'

import { NO_OVERRIDES, type ScoreboardState } from '../common/scoreboard'
import { makeDatabase } from '../server/db/database'
import { override, publish, scoreboardSocketUrl } from './scoreboardPublish.e2e'
import {
  OTHER_EMAIL,
  RUNNER_EMAIL,
  SEEDED,
  seedScoreboardGames
} from './seedScoreboardGames.e2e'

/**
 * The M1 end-to-end scenarios, E1 to E5, against a running server.
 *
 *   node -r sucrase/register src/test/scoreboardServer.e2e.ts --step <step>
 *
 * Steps, in the order a group runs them: `seed` (seeds and signs both
 * accounts in, reading the codes from the server's log), `e1` … `e5`.
 * Each step prints what it observed and exits non-zero when an observation
 * fails. State between steps is kept in `TS_E2E_STATE`.
 *
 *   TS_E2E_HOST          the API origin, http://127.0.0.1:9100
 *   TS_E2E_WEB           the app from `npm run start.web`, for E3
 *   TS_E2E_DATABASE_URL  the development database the server uses
 *   TS_E2E_SERVER_LOG    the server's log, for sign-in codes and E4
 *   TS_E2E_STATE         where the seeded ids and tokens are kept
 *   TS_E2E_REDIS_KEY     the key prefix, gs:<database name>
 *   TS_CHROME_PATH       the Chrome puppeteer drives, for E3
 *   TS_E2E_SERVER_PID    the server's primary, which E4 restarts
 */

const HOST = process.env.TS_E2E_HOST ?? 'http://127.0.0.1:9100'
const WEB = process.env.TS_E2E_WEB ?? 'http://127.0.0.1:8080'
const DATABASE_URL =
  process.env.TS_E2E_DATABASE_URL ??
  'postgres://localhost:5433/AppDb_nativeScoreboard'
const SERVER_LOG = process.env.TS_E2E_SERVER_LOG ?? 'server.log'
const STATE = process.env.TS_E2E_STATE ?? 'scoreboardE2E.json'
const PREFIX =
  process.env.TS_E2E_REDIS_KEY ??
  `ts:${new URL(DATABASE_URL).pathname.slice(1)}`
const API = `${HOST}/api/v1`

interface State {
  games: Record<string, string>
  runner: string
  other: string
  seededAt: number
}

function readState(): State {
  return JSON.parse(readFileSync(STATE, 'utf8')) as State
}

let failures = 0
function observe(what: string, ok: boolean, detail: unknown = ''): void {
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${what}${detail === '' ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`
  )
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function until<T>(
  what: string,
  check: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== undefined && value !== false) return value
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await sleep(25)
  }
}

/** Signs in with an e-mail code read from the server's log. */
async function signIn(email: string): Promise<string> {
  const before = readFileSync(SERVER_LOG, 'utf8').length
  const asked = await fetch(`${API}/auth/email-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email })
  })
  if (asked.status !== 202) throw new Error(`email-code: ${asked.status}`)
  const pattern = new RegExp(`sign-in code for ${email}: (\\d{6})`)
  const code = await until('the sign-in code in the log', () => {
    const match = pattern.exec(readFileSync(SERVER_LOG, 'utf8').slice(before))
    return match?.[1]
  })
  const verified = await fetch(`${API}/auth/email-code/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code })
  })
  if (verified.status !== 200) throw new Error(`verify: ${verified.status}`)
  return ((await verified.json()) as { token: string }).token
}

/** A viewer socket and everything it has been sent. */
interface Viewer {
  socket: WebSocket
  states: ScoreboardState[]
  times: number[]
  close?: number
  open: Promise<void>
}

function view(gameId: string): Viewer {
  const socket = new WebSocket(scoreboardSocketUrl(HOST, gameId, 'socket'))
  const viewer: Viewer = {
    socket,
    states: [],
    times: [],
    open: new Promise(resolve =>
      socket.once('open', () => {
        resolve()
      })
    )
  }
  socket.on('message', data => {
    viewer.states.push(JSON.parse((data as Buffer).toString('utf8')))
    viewer.times.push(Date.now())
  })
  socket.on('close', code => {
    viewer.close = code
  })
  socket.on('error', () => undefined)
  return viewer
}
const latest = (viewer: Viewer): ScoreboardState | undefined =>
  viewer.states.at(-1)

async function getJson(
  path: string,
  token?: string
): Promise<{ status: number; body: any }> {
  const answer = await fetch(`${API}${path}`, {
    headers: token == null ? {} : { authorization: `Bearer ${token}` }
  })
  const text = await answer.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: answer.status, body }
}

function redis(...args: string[]): string {
  return execFileSync('redis-cli', args, { encoding: 'utf8' }).trim()
}

async function seed(): Promise<void> {
  const db = makeDatabase(DATABASE_URL)
  let ids: string[]
  try {
    ids = await seedScoreboardGames(db)
  } finally {
    await db.destroy()
  }
  const games = Object.fromEntries(SEEDED.map((slot, i) => [slot.name, ids[i]]))
  for (const slot of SEEDED) console.log(`${slot.name}\t${games[slot.name]}`)
  const state: State = {
    games,
    runner: await signIn(RUNNER_EMAIL),
    other: await signIn(OTHER_EMAIL),
    seededAt: Date.now()
  }
  writeFileSync(STATE, JSON.stringify(state, null, 2))
  console.log(`signed in ${RUNNER_EMAIL} and ${OTHER_EMAIL}; state in ${STATE}`)
}

/** Which process holds each of the server's established sockets. */
function socketsByWorker(): Record<string, number> {
  const port = new URL(HOST).port
  const out = execFileSync(
    '/usr/sbin/lsof',
    ['-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:ESTABLISHED'],
    { encoding: 'utf8' }
  )
  const counts: Record<string, number> = {}
  for (const line of out.split('\n').slice(1)) {
    const [command, pid, , , , , , , name] = line.split(/\s+/)
    if (command !== 'node' || !(name ?? '').startsWith(`127.0.0.1:${port}->`))
      continue
    counts[pid] = (counts[pid] ?? 0) + 1
  }
  return counts
}

async function e1(): Promise<void> {
  const { games, runner } = readState()
  const gameId = games['-10m']
  const viewers = Array.from({ length: 12 }, () => view(gameId))
  await Promise.all(
    viewers.map(async one => {
      await one.open
    })
  )
  await until('every viewer’s first state', () =>
    viewers.every(one => one.states.length > 0)
  )
  const spread = socketsByWorker()
  observe(
    'the 12 viewers are spread across workers',
    Object.keys(spread).length > 1,
    spread
  )
  const socket = new WebSocket(scoreboardSocketUrl(HOST, gameId, 'publish'), {
    headers: { authorization: `Bearer ${runner}` }
  })
  await new Promise(resolve => socket.once('open', resolve))
  const partials = Array.from({ length: 20 }, (_, i) => ({
    balls: i % 4,
    outs: Math.floor(i / 4) % 3,
    numPitches: 100 + i
  }))
  for (const partial of partials) socket.send(JSON.stringify(partial))
  await until(
    'all 20 on every viewer',
    () => viewers.every(one => latest(one)?.numPitches === 119),
    15_000
  )
  await sleep(300)
  socket.close()
  let inOrder = true
  for (const one of viewers) {
    const got = one.states
      .filter(state => state.numPitches >= 100)
      .map(state => [state.numPitches, state.balls, state.outs])
    const wanted = partials.map(p => [p.numPitches, p.balls, p.outs])
    if (JSON.stringify(got) !== JSON.stringify(wanted)) inOrder = false
  }
  observe(
    'all 12 viewers received all 20 states, in order, and nothing else new',
    inOrder,
    viewers.map(one => one.states.length)
  )
  const board = await getJson(`/scoreboard/${gameId}`)
  observe(
    'the last state equals GET /scoreboard/<id>',
    viewers.every(
      one => JSON.stringify(latest(one)) === JSON.stringify(board.body.state)
    ),
    board.body.state
  )
  for (const one of viewers) one.socket.close()
}

async function e2(): Promise<void> {
  const { games, other } = readState()
  const gameId = games['-10m']
  const anonymous = await publish(HOST, gameId, '', { balls: 1 })
  observe(
    'publish with no token closes 4401',
    anonymous.closeCode === 4401,
    anonymous
  )
  // scoreboard-e2e-other is a plain member: the game is visible to them, but
  // they may not override it, so 4403 is refused for running, not for sight.
  const seen = await getJson(`/games/${gameId}`, other)
  observe(
    'scoreboard-e2e-other sees the game with mayOverride false',
    seen.status === 200 &&
      seen.body?.scoreboard?.open === true &&
      seen.body?.scoreboard?.mayOverride === false,
    { status: seen.status, scoreboard: seen.body?.scoreboard }
  )
  const outsider = await publish(HOST, gameId, other, { balls: 1 })
  observe(
    "publish with scoreboard-e2e-other's token closes 4403",
    outsider.closeCode === 4403,
    outsider
  )
  for (const name of ['-4h', 'cancelled']) {
    const viewer = view(games[name])
    await until(`the ${name} viewer to close`, () => viewer.close)
    observe(`a viewer on the ${name} game closes 4404`, viewer.close === 4404, {
      close: viewer.close,
      states: viewer.states.length
    })
  }
  const closed = await getJson(`/scoreboard/${games['-4h']}`)
  observe('GET /scoreboard/<-4h> is 404', closed.status === 404, closed)
}

async function click(page: Page, label: string): Promise<void> {
  const selector = `[aria-label="${label}"]`
  await page.waitForFunction(
    selector => {
      const node = document.querySelector(selector)
      return node != null && node.getAttribute('aria-disabled') !== 'true'
    },
    { timeout: 30_000 },
    selector
  )
  await page.locator(selector).click()
}

/** Presses a pitch button, and says when the press happened. */
async function pitch(page: Page, label: string): Promise<number> {
  await page.waitForFunction(
    () => {
      const ball = document.querySelector('[aria-label="Ball"]')
      return ball != null && ball.getAttribute('aria-disabled') !== 'true'
    },
    { timeout: 30_000 }
  )
  const at = Date.now()
  await click(page, label)
  return at
}

async function e3(): Promise<void> {
  const { games, runner } = readState()
  const gameId = games['-10m']
  const viewer = view(gameId)
  await viewer.open
  await until('the first state', () => viewer.states.length > 0)
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.TS_CHROME_PATH,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader'
    ]
  })
  const shown = (): string => {
    const state = latest(viewer)
    return state == null
      ? ''
      : `${state.balls}-${state.strikes} pitchSpeed ${state.pitchSpeed} home ${state.homeTeam}`
  }
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(30_000)
    await page.setViewport({ width: 1200, height: 900 })
    await browser.defaultBrowserContext().setCookie({
      name: 'ts_session',
      value: encodeURIComponent(runner),
      domain: '127.0.0.1',
      path: '/'
    })
    await page.goto(`${WEB}/games/${gameId}`)
    await click(page, 'Score')
    await page.waitForFunction(() => location.pathname.endsWith('/score-game'))
    await click(page, 'Full game scoring')
    await page.waitForFunction(() => location.pathname.endsWith('/score'))
    await page.waitForSelector('canvas[data-field-ready="true"]')
    if ((await page.$('[aria-label="OK"]')) != null) await click(page, 'OK')
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Save Rosters')

    // 1. A ball, scored in the browser.
    let count = viewer.states.length
    const ballAt = await pitch(page, 'Ball')
    await until('balls 1', () => latest(viewer)?.balls === 1, 5000)
    const ballMs = viewer.times.at(-1)! - ballAt
    observe(
      'a scored ball reaches the viewer within 1 s',
      ballMs <= 1000,
      `${ballMs} ms, ${shown()}`
    )

    // 2. Watcher publishes, team name and all.
    const published = await publish(HOST, gameId, runner, {
      balls: 3,
      pitchSpeed: 62,
      homeTeam: 'WRONG'
    })
    await until('balls 3', () => latest(viewer)?.balls === 3)
    const two = latest(viewer)!
    observe(
      'Watcher’s balls 3 and pitchSpeed 62 show, with the seeded home team',
      published.delivered &&
        two.balls === 3 &&
        two.pitchSpeed === 62 &&
        two.homeTeam === 'Scoreboard E2E',
      { shown: shown(), published }
    )

    // 3. A strike in the browser: the game is newer, and TagOne's speed stays.
    count = viewer.states.length
    await pitch(page, 'Called Strike')
    await until('1-1', () => {
      const state = latest(viewer)
      return (
        viewer.states.length > count &&
        state?.balls === 1 &&
        state.strikes === 1
      )
    })
    observe(
      'the game’s 1-1 shows with pitchSpeed 62 still',
      latest(viewer)?.pitchSpeed === 62,
      shown()
    )

    // 4. The count overridden at 0-2.
    const countOverride = {
      ...NO_OVERRIDES,
      overrideCountEnabled: true,
      overrideCount: { balls: 0, strikes: 2, outs: 0 }
    }
    const on = await override(HOST, gameId, runner, countOverride)
    await until(
      '0-2',
      () => latest(viewer)?.strikes === 2 && latest(viewer)?.balls === 0
    )
    observe('the override is stored and shows 0-2', on.delivered, {
      shown: shown(),
      on
    })

    // 5. Another ball: the override holds.
    count = viewer.states.length
    await pitch(page, 'Ball')
    await until('the scored ball to arrive', () => viewer.states.length > count)
    await sleep(500)
    const stored = JSON.parse(
      redis('HGET', `${PREFIX}:scoreboard:${gameId}`, 'game')
    ) as { state: { balls: number; strikes: number } }
    observe(
      'with the game at 2-1, the override still shows 0-2',
      latest(viewer)?.balls === 0 &&
        latest(viewer)?.strikes === 2 &&
        stored.state.balls === 2,
      { shown: shown(), game: stored.state }
    )

    // 6. The override off: the game's 2-1.
    const off = await override(HOST, gameId, runner, {
      ...countOverride,
      overrideCountEnabled: false
    })
    observe('the override off is stored', off.delivered, off)
    await until(
      '2-1',
      () => latest(viewer)?.balls === 2 && latest(viewer)?.strikes === 1
    )
    observe('with the override off, the game’s 2-1 shows', true, shown())
  } finally {
    await browser.close()
    viewer.socket.close()
  }
}

/** Starts the server again the way it was started, logging to the same file. */
function startServer(): number {
  const log = openSync(SERVER_LOG, 'a')
  const child = spawn(
    'node',
    ['-r', 'sucrase/register', 'src/server/index.ts'],
    {
      detached: true,
      stdio: ['ignore', log, log]
    }
  )
  child.unref()
  return child.pid ?? 0
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function e4(): Promise<void> {
  const { games, runner } = readState()
  const gameId = games['-10m']
  const pid = Number(process.env.TS_E2E_SERVER_PID)
  if (!Number.isInteger(pid) || !alive(pid))
    throw new Error('Set TS_E2E_SERVER_PID')

  // 1. A viewer, and homeScore 7.
  const first = view(gameId)
  await first.open
  await publish(HOST, gameId, runner, { homeScore: 7 })
  await until('homeScore 7', () => latest(first)?.homeScore === 7)

  // 2. SIGTERM and start again.
  process.kill(pid, 'SIGTERM')
  await until('the viewer to be closed', () => first.close)
  observe(
    'the viewer is closed with 1001 on SIGTERM',
    first.close === 1001,
    first.close
  )
  await until('the old server to exit', () => !alive(pid), 20_000)
  const restarted = startServer()
  console.log(`NOTE restarted server primary pid ${restarted}`)
  writeFileSync(`${STATE}.pid`, String(restarted))
  await until(
    'the API',
    async () =>
      (await getJson('/health').catch(() => ({ status: 0 }))).status === 200,
    60_000
  )
  const second = view(gameId)
  await until('a state', () => latest(second))
  observe(
    'a new viewer receives homeScore 7',
    latest(second)?.homeScore === 7,
    latest(second)?.homeScore
  )
  second.socket.close()
  const pttl = Number(redis('PTTL', `${PREFIX}:scoreboard:${gameId}`))
  observe(
    'PTTL is at most 2 h',
    pttl > 0 && pttl <= 2 * 3_600_000,
    `${pttl} ms`
  )

  // 3. Redis stopped.
  const logBefore = readFileSync(SERVER_LOG, 'utf8').length
  execFileSync('brew', ['services', 'stop', 'redis'], { stdio: 'inherit' })
  await sleep(1500)
  const board = await getJson(`/scoreboard/${gameId}`)
  observe('GET /scoreboard/<id> answers 503', board.status === 503, board)
  const detail = await getJson(`/games/${gameId}`, runner)
  observe(
    'GET /games/<id> answers 200 with scoreboard: null',
    detail.status === 200 && detail.body.scoreboard === null,
    { status: detail.status, scoreboard: detail.body.scoreboard }
  )
  const health = await getJson('/health')
  const list = await getJson('/games', runner)
  observe(
    'GET /health and GET /games answer 200',
    health.status === 200 && list.status === 200,
    [health.status, list.status]
  )
  const refused = view(gameId)
  await until('the refused viewer to close', () => refused.close)
  observe(
    'a viewer is refused with 1011',
    refused.close === 1011,
    refused.close
  )
  await sleep(3000)
  const during = readFileSync(SERVER_LOG, 'utf8').slice(logBefore)
  observe(
    'no worker exits: the primary logs no re-fork',
    !/exited .*replacing it/.test(during),
    during
      .split('\n')
      .filter(line => /redis|exited/.test(line))
      .slice(0, 6)
  )

  // 4. Redis back, and homeScore 8.
  execFileSync('brew', ['services', 'start', 'redis'], { stdio: 'inherit' })
  const startedAt = Date.now()
  await until(
    'Redis',
    () => {
      try {
        return redis('PING') === 'PONG'
      } catch {
        return undefined
      }
    },
    30_000
  )
  const evalsBefore = redis('INFO', 'commandstats')
    .split('\n')
    .find(line => line.startsWith('cmdstat_eval:'))
  // Viewers and publishers are refused with 1011 for a second or two after
  // Redis is back, until the worker's client has reconnected. A publish
  // counts only once its socket stayed open through the send and the settle
  // after it, and the stored board says homeScore 8.
  const refusals: Array<number | undefined> = []
  await until(
    'a publish that lands',
    async () => {
      const outcome = await publish(HOST, gameId, runner, { homeScore: 8 })
      if (!outcome.delivered) {
        refusals.push(outcome.closeCode)
        return undefined
      }
      const stored = await getJson(`/scoreboard/${gameId}`)
      return stored.status === 200 && stored.body?.state?.homeScore === 8
        ? true
        : undefined
    },
    20_000
  )
  console.log(
    `NOTE publishes refused before one landed: ${refusals.length}` +
      (refusals.length > 0
        ? ` (close ${[...new Set(refusals)].join(', ')})`
        : '')
  )
  // A new viewer, which reconnects after 1011 as the board page does: each
  // worker's client comes back on its own schedule, so the worker this one
  // lands on may still be refusing.
  let third = view(gameId)
  let openedAt = Date.now()
  const viewerRefusals: Array<number | undefined> = []
  await until(
    'homeScore 8',
    () => {
      if (latest(third)?.homeScore === 8) return true
      // A quarter-second apart, so a refusing worker is not hammered.
      if (third.close != null && Date.now() - openedAt >= 250) {
        viewerRefusals.push(third.close)
        third = view(gameId)
        openedAt = Date.now()
      }
      return undefined
    },
    10_000
  )
  const seconds = (Date.now() - startedAt) / 1000
  console.log(
    `NOTE viewers refused before one was served: ${viewerRefusals.length}` +
      (viewerRefusals.length > 0
        ? ` (close ${[...new Set(viewerRefusals)].join(', ')})`
        : '')
  )
  observe(
    'within 10 s a new viewer receives homeScore 8',
    seconds <= 10,
    `${seconds.toFixed(1)} s`
  )
  third.socket.close()
  const stats = redis('INFO', 'commandstats')
    .split('\n')
    .filter(line => /^cmdstat_eval(sha)?:/.test(line))
  observe(
    'the script was reloaded after NOSCRIPT (EVALSHA failed, EVAL ran)',
    stats.some(line => line.startsWith('cmdstat_eval:')) &&
      stats.some(line => /cmdstat_evalsha:.*failed_calls=[1-9]/.test(line)),
    { before: evalsBefore ?? 'none', after: stats }
  )
}

async function e5(): Promise<void> {
  const { games, runner } = readState()
  const answer = await getJson(
    '/events?scope=run&lookbackHours=2&limit=20',
    runner
  )
  const ids = (answer.body as Array<{ gameId: string }>).map(e => e.gameId)
  const wanted = ['-10m', '+1h', '+2h', '+3h', '+4h', '+5h', '+6h'].map(
    name => games[name]
  )
  observe(
    'GET /events is the -10m game through +6h, soonest first',
    JSON.stringify(ids) === JSON.stringify(wanted),
    ids
  )
  observe(
    'the -4h game and the cancelled game are absent',
    !ids.includes(games['-4h']) && !ids.includes(games.cancelled)
  )
}

const STEPS: Record<string, () => Promise<void>> = { seed, e1, e2, e3, e4, e5 }

async function main(): Promise<void> {
  const at = process.argv.indexOf('--step')
  const step = STEPS[process.argv[at + 1] ?? '']
  if (at < 0 || step == null) {
    throw new Error(`Usage: --step ${Object.keys(STEPS).join('|')}`)
  }
  if (!existsSync(SERVER_LOG)) throw new Error(`No server log at ${SERVER_LOG}`)
  const started = Date.now()
  await step()
  console.log(
    `${failures === 0 ? 'OK' : `${failures} FAILED`} in ${((Date.now() - started) / 1000).toFixed(1)} s`
  )
  process.exitCode = failures === 0 ? 0 : 1
}

if ((process.argv[1] ?? '').endsWith('/scoreboardServer.e2e.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exit(1)
  })
}
