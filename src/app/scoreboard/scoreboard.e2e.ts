import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import puppeteer, {
  type Browser,
  type BrowserContext,
  type Page
} from 'puppeteer'
import { WebSocket } from 'ws'

import { NO_OVERRIDES, SCOREBOARD_BOARD_SIZE } from '../../common/scoreboard'
import { makeDatabase } from '../../server/db/database'
import { override, scoreboardSocketUrl } from '../../test/scoreboardPublish.e2e'
import {
  OTHER_EMAIL,
  RUNNER_EMAIL,
  SEEDED,
  seedScoreboardGames,
  TEAM_NAME,
  VISITORS_NAME
} from '../../test/seedScoreboardGames.e2e'

/**
 * The scoreboard pages in a real browser, against a running API and web app:
 * E6 to E8 (M2), and E9 by pointing the same file at a seat. E9 is E6 and
 * E7 steps 1–3, the tests whose titles end in `[E9]`.
 *
 *   TS_SCOREBOARD_WEB_URL=http://127.0.0.1:8080 \
 *   TS_API_TEST_URL=http://127.0.0.1:9100/api/v1 \
 *   TS_E2E_DATABASE=AppDb_nativeScoreboard \
 *   TS_E2E_SERVER_LOG=server.log \
 *     node_modules/.bin/mocha -r sucrase/register --extension ts \
 *     --timeout 120000 src/app/scoreboard/scoreboard.e2e.ts
 *
 * Each group seeds its own games first (`seedScoreboardGames`) and signs the
 * two e2e accounts in with codes read from the server's log. On a seat, where
 * the server's log is not at hand, pass the tokens instead, and run
 * only the E9 tests, which need no local Redis and change nothing there:
 *
 *   TS_SCOREBOARD_WEB_URL=https://$SEAT_HOST \
 *   TS_API_TEST_URL=https://$SEAT_HOST/api/v1 \
 *   TS_E2E_DATABASE=<the seat's database URL> \
 *   TS_E2E_RUNNER_TOKEN=… TS_E2E_OTHER_TOKEN=… \
 *     node_modules/.bin/mocha … --fgrep '[E9]' \
 *     src/app/scoreboard/scoreboard.e2e.ts
 *
 * Other settings: TS_CHROME_PATH (the Chrome puppeteer drives),
 * TS_E2E_REDIS_KEY (the key prefix, gs:<database name>), TS_E2E_SHOTS (where
 * screenshots go, /tmp/nsbShots).
 */
const WEB = (
  process.env.TS_SCOREBOARD_WEB_URL ?? 'http://127.0.0.1:8080'
).replace(/\/+$/, '')
const API = (
  process.env.TS_API_TEST_URL ?? 'http://127.0.0.1:9100/api/v1'
).replace(/\/+$/, '')
const HOST = new URL(API).origin
const DATABASE = process.env.TS_E2E_DATABASE ?? 'AppDb_nativeScoreboard'
const DATABASE_URL = DATABASE.includes('://')
  ? DATABASE
  : `postgres://localhost:5433/${DATABASE}`
const SERVER_LOG = process.env.TS_E2E_SERVER_LOG ?? 'server.log'
const PREFIX =
  process.env.TS_E2E_REDIS_KEY ??
  `ts:${new URL(DATABASE_URL).pathname.slice(1)}`
const SHOTS = process.env.TS_E2E_SHOTS ?? '/tmp/nsbShots'
const FIXTURES = join(__dirname, 'fixtures')

/**
 * E7.5 and E8 change the game's row, its Redis key and its overrides
 * directly, so they run only against an API and web app on this machine,
 * never a seat. The database URL is no guide: a seat's can look local too.
 */
function requireLocal(step: string): void {
  const local = (url: string): boolean =>
    ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)
  if (!local(API) || !local(WEB)) {
    throw new Error(
      `${step} runs only against a local API and web app, not ${API} and ${WEB}`
    )
  }
}
const MEASURE_SCRIPT = join(
  __dirname,
  '../../../mobile/apps/tsDirector/Packages/DirectorUI/Sources/DirectorUI/WebOverlayController.swift'
)

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function until<T>(
  what: string,
  check: () => T | undefined | false | Promise<T | undefined | false>,
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
async function signIn(email: string, tokenEnv: string): Promise<string> {
  const given = process.env[tokenEnv]
  if (given != null && given !== '') return given
  const before = readFileSync(SERVER_LOG, 'utf8').length
  const asked = await fetch(`${API}/auth/email-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email })
  })
  expect(asked.status, 'email-code').equals(202)
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
  expect(verified.status, 'verify').equals(200)
  return ((await verified.json()) as { token: string }).token
}

interface Group {
  games: Record<string, string>
  runner: string
  other: string
}

/** Seeds this group's games and signs both accounts in. */
async function seedGroup(): Promise<Group> {
  const db = makeDatabase(DATABASE_URL)
  let ids: string[]
  try {
    ids = await seedScoreboardGames(db)
  } finally {
    await db.destroy()
  }
  const games = Object.fromEntries(SEEDED.map((slot, i) => [slot.name, ids[i]]))
  console.log(`      seeded ${JSON.stringify(games)}`)
  return {
    games,
    runner: await signIn(RUNNER_EMAIL, 'TS_E2E_RUNNER_TOKEN'),
    other: await signIn(OTHER_EMAIL, 'TS_E2E_OTHER_TOKEN')
  }
}

async function launch(): Promise<Browser> {
  mkdirSync(SHOTS, { recursive: true })
  return await puppeteer.launch({
    headless: true,
    executablePath: process.env.TS_CHROME_PATH,
    args: ['--use-gl=angle', '--use-angle=swiftshader']
  })
}

/** A fresh profile, signed in as `token` when there is one. */
async function contextAs(
  browser: Browser,
  token?: string
): Promise<BrowserContext> {
  const context = await browser.createBrowserContext()
  if (token != null) {
    await context.setCookie({
      name: 'ts_session',
      value: encodeURIComponent(token),
      domain: new URL(API).hostname,
      path: '/'
    })
  }
  return context
}

async function open(
  context: BrowserContext,
  path: string,
  viewport = { width: 1280, height: 720 }
): Promise<Page> {
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  await page.setViewport(viewport)
  await page.goto(`${WEB}${path}`, { waitUntil: 'load' })
  return page
}

/** What the board on a page shows, read off its data attributes. */
interface Drawn {
  drawn: boolean
  away: string
  home: string
  awayScore: string
  homeScore: string
  count: string
  outs: number
  bases: boolean[]
}
async function drawn(page: Page): Promise<Drawn | undefined> {
  return await page.evaluate(() => {
    // Written without `?.` and `??`: sucrase turns those into helpers that
    // exist in Node and not in the page this runs in.
    const part = (name: string): string => {
      const node = document.querySelector(`[data-scoreboard="${name}"]`)
      return node === null ? '' : String(node.textContent)
    }
    const board = document.querySelector<HTMLElement>(
      '[data-scoreboard="board"]'
    )
    if (board === null) return undefined
    const lit = (name: string): boolean[] =>
      Array.from(
        document.querySelectorAll<HTMLElement>(`[data-scoreboard="${name}"]`)
      ).map(node => node.dataset.lit === 'true')
    return {
      drawn: board.dataset.drawn === 'true',
      away: part('awayTeam'),
      home: part('homeTeam'),
      awayScore: part('awayScore'),
      homeScore: part('homeScore'),
      count: part('count'),
      outs: lit('out').filter(Boolean).length,
      bases: [lit('base1')[0], lit('base2')[0], lit('base3')[0]]
    }
  })
}

/** Waits for the board to satisfy `check`, and says how long it took. */
async function boardShows(
  page: Page,
  what: string,
  check: (board: Drawn) => boolean,
  timeoutMs = 10_000
): Promise<Drawn> {
  return await until(
    what,
    async () => {
      const board = await drawn(page)
      return board != null && check(board) ? board : undefined
    },
    timeoutMs
  )
}

/** The branded 404 is up: its message, its logo and its sign-up link. */
async function notFoundShown(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const text = String(document.body.textContent)
    const signUp = Array.from(document.querySelectorAll('a')).some(
      one =>
        one.textContent === 'Sign up for TeamStation' &&
        one.getAttribute('href') === '/sign-in'
    )
    return (
      text.includes("This scoreboard isn't live") &&
      document.querySelector('[aria-label="TeamStation"]') != null &&
      signUp
    )
  })
}

/** Decodes a PNG in the browser: the alpha at a point, and the highest. */
async function alphaOf(
  browser: Browser,
  png: Uint8Array,
  at?: { x: number; y: number }
): Promise<{ at: number; max: number; width: number; height: number }> {
  const page = await browser.newPage()
  try {
    return await page.evaluate(
      async (base64, point) => {
        const image = new Image()
        image.src = `data:image/png;base64,${base64}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        const context = canvas.getContext('2d')
        if (context == null) throw new Error('no 2d context')
        context.drawImage(image, 0, 0)
        const data = context.getImageData(0, 0, image.width, image.height).data
        let max = 0
        for (let i = 3; i < data.length; i += 4) max = Math.max(max, data[i])
        const atPoint =
          point == null ? -1 : data[(point.y * image.width + point.x) * 4 + 3]
        return { at: atPoint, max, width: image.width, height: image.height }
      },
      Buffer.from(png).toString('base64'),
      at
    )
  } finally {
    await page.close()
  }
}

/**
 * Where the board's face and each of its texts sit, to 1/100 px: the face
 * is the largest box in the board's background colour.
 */
interface Layout {
  face: number[]
  parts: Record<string, number[]>
}
async function layoutOf(page: Page): Promise<Layout> {
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  await until(
    'the board drawn',
    async () =>
      await page.evaluate(() =>
        String(document.body.textContent).includes('VISITORS')
      )
  )
  await sleep(300)
  return await page.evaluate(() => {
    const round = (rect: DOMRect): number[] =>
      [rect.left, rect.top, rect.width, rect.height].map(
        value => Math.round(value * 100) / 100
      )
    const root = document.getElementById('root')
    if (root === null) return { face: [], parts: {} }
    const all = Array.from(root.querySelectorAll<HTMLElement>('*'))
    const faces = all
      .filter(
        node => getComputedStyle(node).backgroundColor === 'rgb(45, 45, 45)'
      )
      .map(node => node.getBoundingClientRect())
      .sort((a, b) => b.width * b.height - a.width * a.height)
    const parts: Record<string, number[]> = {}
    for (const node of all) {
      const text = String(node.textContent)
      if (node.children.length === 0 && text.trim() !== '') {
        const key = parts[text] === undefined ? text : `${text} (2)`
        parts[key] = round(node.getBoundingClientRect())
      }
    }
    return { face: faces.length === 0 ? [] : round(faces[0]), parts }
  })
}

/** How many pixels two same-sized PNGs differ in, decoded in the browser. */
async function pixelsDiffering(
  browser: Browser,
  a: Uint8Array,
  b: Uint8Array
): Promise<number> {
  const page = await browser.newPage()
  try {
    return await page.evaluate(
      async (first, second) => {
        const pixels = async (base64: string): Promise<Uint8ClampedArray> => {
          const image = new Image()
          image.src = `data:image/png;base64,${base64}`
          await image.decode()
          const canvas = document.createElement('canvas')
          canvas.width = image.width
          canvas.height = image.height
          const context = canvas.getContext('2d')
          if (context == null) throw new Error('no 2d context')
          context.drawImage(image, 0, 0)
          return context.getImageData(0, 0, image.width, image.height).data
        }
        const [one, two] = [await pixels(first), await pixels(second)]
        if (one.length !== two.length) return Infinity
        let count = 0
        for (let i = 0; i < one.length; i += 4) {
          if (
            one[i] !== two[i] ||
            one[i + 1] !== two[i + 1] ||
            one[i + 2] !== two[i + 2] ||
            one[i + 3] !== two[i + 3]
          )
            count++
        }
        return count
      },
      Buffer.from(a).toString('base64'),
      Buffer.from(b).toString('base64')
    )
  } finally {
    await page.close()
  }
}

/** Director's measuring script, as the Swift file has it. */
function contentSizeScript(): string {
  const swift = readFileSync(MEASURE_SCRIPT, 'utf8')
  const match = /contentSizeScript = """\n([\s\S]*?)\n\s*"""/.exec(swift)
  if (match == null) throw new Error('contentSizeScript not found')
  return match[1]
}

async function measure(
  page: Page,
  viewport: { width: number; height: number }
): Promise<number[]> {
  await page.setViewport(viewport)
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  await sleep(100)
  return (await page.evaluate(contentSizeScript())) as number[]
}

function redis(...args: string[]): string {
  return execFileSync('redis-cli', args, { encoding: 'utf8' }).trim()
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
  console.log(`      screenshot ${join(SHOTS, `${name}.png`)}`)
}

/** Publishes a partial from a publisher socket, and says when it was sent. */
async function publishAt(
  gameId: string,
  token: string,
  partial: Record<string, unknown>
): Promise<{ sentAt: number; done: () => void }> {
  const socket = new WebSocket(scoreboardSocketUrl(HOST, gameId, 'publish'), {
    headers: { authorization: `Bearer ${token}` }
  })
  socket.on('error', () => undefined)
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('close', code => {
      reject(new Error(`publish socket closed ${code}`))
    })
  })
  const sentAt = Date.now()
  socket.send(JSON.stringify(partial))
  return {
    sentAt,
    done: () => {
      socket.close()
    }
  }
}

describe('the scoreboard pages', function () {
  let group: Group
  let browser: Browser
  let anonymous: BrowserContext
  /** E7 step 1's page, kept open for step 5. */
  let livePage: Page | undefined

  before(async function () {
    group = await seedGroup()
    browser = await launch()
    anonymous = await contextAs(browser)
  })
  after(async function () {
    await browser?.close()
  })

  it('E6: the sample page is transparent, B, laid out as 1.0 drew it, and asks for no session [E9]', async function () {
    const requests: string[] = []
    const page = await anonymous.newPage()
    page.on('request', request => requests.push(request.url()))
    await page.setViewport({ width: 1280, height: 720 })
    await page.goto(`${WEB}/scoreboard-sample`, { waitUntil: 'networkidle0' })
    const board = await boardShows(page, 'the sample', one => one.drawn)
    expect(board).deep.include({
      away: 'VISITORS',
      awayScore: '2',
      home: 'PIONEERS',
      homeScore: '3',
      count: '2-1',
      outs: 1
    })
    const backgrounds = await page.evaluate(() =>
      [
        document.documentElement,
        document.body,
        document.getElementById('root')
      ].map(node =>
        node == null ? '' : getComputedStyle(node).backgroundColor
      )
    )
    expect(backgrounds).deep.equals([
      'rgba(0, 0, 0, 0)',
      'rgba(0, 0, 0, 0)',
      'rgba(0, 0, 0, 0)'
    ])
    const png = await page.screenshot({ omitBackground: true })
    const alpha = await alphaOf(browser, png, { x: 1000, y: 600 })
    expect(alpha.at, 'alpha at (1000, 600)').equals(0)
    const box = await page.evaluate(() => {
      const board = document.querySelector('[data-scoreboard="board"]')
      if (board === null) return []
      const rect = board.getBoundingClientRect()
      return [rect.left, rect.top, rect.width, rect.height]
    })
    expect(box).deep.equals([
      0,
      0,
      SCOREBOARD_BOARD_SIZE.width,
      SCOREBOARD_BOARD_SIZE.height
    ])
    expect(requests.filter(url => url.includes('/auth/me'))).deep.equals([])
    await shot(page, 'sample')
    await page.close()

    // 1.0's component, recorded from 1.0's `Scoreboard.tsx` (at 25f9496e) with
    // the same state in the same browser, in the 1920 × 1080 window B was
    // measured in (1.0's sizes grow with the window; the port's do not).
    const window = { width: 1920, height: 1080 }
    const ported = await open(anonymous, '/scoreboard-sample', window)
    await boardShows(ported, 'the sample', one => one.drawn)
    const v1Layout: Layout = JSON.parse(
      readFileSync(join(FIXTURES, 'scoreboardV1Layout.json'), 'utf8')
    )
    const portedLayout = await layoutOf(ported)
    expect(portedLayout, 'every part where 1.0 put it').deep.equals(v1Layout)
    expect(Math.ceil(v1Layout.face[2])).equals(SCOREBOARD_BOARD_SIZE.width)
    expect(Math.ceil(v1Layout.face[3])).equals(SCOREBOARD_BOARD_SIZE.height)
    const clip = { x: 0, y: 0, ...SCOREBOARD_BOARD_SIZE }
    const v1Png = readFileSync(join(FIXTURES, 'scoreboardV1.png'))
    const portedPng = await ported.screenshot({ clip, omitBackground: true })
    await ported.screenshot({ clip, path: join(SHOTS, 'sample-ported.png') })
    const differing = await pixelsDiffering(browser, v1Png, portedPng)
    console.log(
      `      ${differing} of ${clip.width * clip.height} pixels differ from 1.0`
    )
    // Antialiasing on the turned bases and round dots differs from one
    // drawing of 1.0 to the next by about 200 pixels; layout does not.
    expect(differing).lessThan((clip.width * clip.height) / 100)
    await ported.close()
  })

  it('E7.1: a live board draws the seeded names and 0–0 before anything is published [E9]', async function () {
    livePage = await open(anonymous, `/scoreboard/${group.games['+1h']}`)
    const board = await boardShows(
      livePage,
      'the first state',
      one => one.drawn
    )
    expect(board).deep.include({
      away: VISITORS_NAME,
      home: TEAM_NAME,
      awayScore: '0',
      homeScore: '0',
      count: '0-0',
      outs: 0
    })
  })

  it('E7.2: a published partial reaches the page within 1 s [E9]', async function () {
    if (livePage == null) this.skip()
    const page = livePage
    const published = await publishAt(group.games['+1h'], group.runner, {
      balls: 3,
      strikes: 2,
      outs: 2,
      base1: true,
      base3: true
    })
    const board = await boardShows(
      page,
      '3-2, two outs, first and third',
      one =>
        one.count === '3-2' &&
        one.outs === 2 &&
        one.bases.join() === 'true,false,true',
      5000
    )
    const took = Date.now() - published.sentAt
    published.done()
    console.log(`      shown ${took} ms after the publish`)
    expect(took).lessThan(1000)
    expect(board.bases).deep.equals([true, false, true])
    await shot(page, 'live')
  })

  it('E7.3: a closed board shows the branded 404 [E9]', async function () {
    const page = await open(anonymous, `/scoreboard/${group.games['-4h']}`)
    await until('the branded 404', async () => await notFoundShown(page))
    await shot(page, 'notFound')
    await page.close()
  })

  it('E7.4: a quiet closed board paints nothing at all', async function () {
    const page = await open(
      anonymous,
      `/scoreboard/${group.games['-4h']}?quiet=1`
    )
    await sleep(1500)
    expect(await notFoundShown(page)).equals(false)
    const png = await page.screenshot({ omitBackground: true })
    const alpha = await alphaOf(browser, png)
    expect(alpha.max, 'the highest alpha on the page').equals(0)
    await page.close()
  })

  it('E7.5: a board that closes while open switches to the 404 at the 60 s check', async function () {
    this.timeout(120_000)
    requireLocal('E7.5')
    if (livePage == null) this.skip()
    const page = livePage
    const gameId = group.games['+1h']
    const db = makeDatabase(DATABASE_URL)
    try {
      redis('DEL', `${PREFIX}:scoreboard:${gameId}`)
      await db
        .updateTable('games')
        .set({ start_at: sql<Date>`start_at - interval '3 hours'` })
        .where('id', '=', gameId)
        .execute()
    } finally {
      await db.destroy()
    }
    const since = Date.now()
    await until(
      'the open page to switch to the 404',
      async () => await notFoundShown(page),
      75_000
    )
    console.log(
      `      switched ${Math.round((Date.now() - since) / 1000)} s later`
    )
    await page.close()
  })

  it('E8: Director measures B on the sample, a long-named live board and a quiet closed page', async function () {
    requireLocal('E8')
    const gameId = group.games['-10m']
    const long = 'L'.repeat(40)
    const set = await override(HOST, gameId, group.runner, {
      ...NO_OVERRIDES,
      overrideTeamEnabled: true,
      overrideTeam: { homeTeam: long, awayTeam: long }
    })
    expect(
      set.replies.some(reply => 'error' in (reply as object)),
      JSON.stringify(set)
    ).equals(false)
    const pages: Array<{
      name: string
      path: string
      ready: (p: Page) => Promise<unknown>
    }> = [
      {
        name: 'sample',
        path: '/scoreboard-sample',
        ready: async p => await boardShows(p, 'the sample', one => one.drawn)
      },
      {
        name: 'live, 40-character names',
        path: `/scoreboard/${gameId}`,
        ready: async p =>
          await boardShows(p, 'the long names', one => one.home === long)
      },
      {
        name: 'quiet closed',
        path: `/scoreboard/${group.games['-4h']}?quiet=1`,
        ready: async () => {
          await sleep(1500)
        }
      }
    ]
    const sizes: string[] = []
    for (const one of pages) {
      const page = await open(anonymous, one.path, {
        width: 1920,
        height: 2160
      })
      await one.ready(page)
      for (const viewport of [
        { width: 1920, height: 2160 },
        SCOREBOARD_BOARD_SIZE
      ]) {
        const size = await measure(page, viewport)
        sizes.push(
          `${one.name} @ ${viewport.width}×${viewport.height}: ${size.join('×')}`
        )
        if (one.name.startsWith('live, 40')) {
          // The longer team name carries the board past B. The height stays.
          expect(size[0], one.name).to.be.greaterThan(
            SCOREBOARD_BOARD_SIZE.width
          )
          expect(size[1], one.name).equals(SCOREBOARD_BOARD_SIZE.height)
          const boxes = await page.evaluate(() => {
            const box = (name: string): number[] => {
              const node = document.querySelector(`[data-scoreboard="${name}"]`)
              const team = node == null ? null : node.parentElement
              if (team == null) return []
              const rect = team.getBoundingClientRect()
              const text = node.getBoundingClientRect()
              return [rect.width, rect.x, text.width]
            }
            return { away: box('awayTeam'), home: box('homeTeam') }
          })
          expect(boxes.away[0], 'name boxes match').equals(boxes.home[0])
          expect(boxes.away[1], 'name boxes share a left edge').equals(
            boxes.home[1]
          )
          expect(
            boxes.home[2],
            'the long name is not clipped'
          ).to.be.greaterThan(400)
        } else {
          expect(
            size,
            `${one.name} at ${viewport.width} × ${viewport.height}`
          ).deep.equals([
            SCOREBOARD_BOARD_SIZE.width,
            SCOREBOARD_BOARD_SIZE.height
          ])
        }
      }
      await page.close()
    }
    for (const line of sizes) console.log(`      ${line}`)
    await override(HOST, gameId, group.runner, NO_OVERRIDES)
  })
})

async function press(page: Page, label: string): Promise<number> {
  const selector = `[aria-label="${label}"]`
  await page.waitForSelector(selector, { visible: true })
  const at = Date.now()
  await page.locator(selector).click()
  return at
}

/** Holds the mouse down on `label` long enough to be a long press. */
async function longPress(page: Page, label: string): Promise<void> {
  const target = await page.waitForSelector(`[aria-label="${label}"]`, {
    visible: true
  })
  const box = await target?.boundingBox()
  if (box == null) throw new Error(`${label} has no box`)
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2)
  await page.mouse.down()
  await sleep(800)
  await page.mouse.up()
}

/** The game page has loaded: its Box score pill, or its not-found message. */
async function gameLoaded(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Box score"]') != null ||
      String(document.body.textContent).includes('That game is not here'),
    { timeout: 30_000 }
  )
  // The pill depends on the same answer as the tabs, but give a late render
  // a moment before saying it is absent.
  await sleep(500)
}

async function tileOverridden(page: Page, group: string): Promise<boolean> {
  return await page.evaluate(group => {
    const tile = document.querySelector(
      `[data-testid="override-tile-${group}"]`
    )
    return (
      tile !== null &&
      // 1.0's override colour, tsMediumOlive #6B8E4E.
      getComputedStyle(tile).backgroundColor === 'rgb(107, 142, 78)'
    )
  }, group)
}

/** Where the Score Game screen's parts sit, top to bottom, and its link. */
async function scoreGameScreen(page: Page): Promise<{
  inOrder: boolean
  link: string
  monospace: boolean
  copyIcon: boolean
}> {
  await page.waitForSelector('[aria-label="Copy scoreboard link"]')
  return await page.evaluate(() => {
    const text = String(document.body.textContent)
    const order = [
      'Score game with full stats (ie. pitches, hits, walks, errors)',
      'Full game scoring',
      'Operate simplified scoreboard with only bases, balls, strikes, outs, and inning',
      'Scoreboard',
      'Web Widget Scoreboard Link'
    ].map(part => text.indexOf(part))
    const link = document.querySelector('[data-testid="scoreboardLink"]')
    // No optional chaining in here: it runs in the page, where Sucrase's
    // helper for it does not exist.
    const copy = document.querySelector('[aria-label="Copy scoreboard link"]')
    return {
      inOrder:
        !order.includes(-1) &&
        order.every((at, i) => i === 0 || at > order[i - 1]),
      link: link == null ? '' : String(link.textContent),
      monospace:
        link != null && getComputedStyle(link).fontFamily.includes('monospace'),
      copyIcon:
        copy != null && String(copy.textContent).includes('content_copy')
    }
  })
}

/** Whether a button is there and disabled, and the reason under it. */
async function disabledWith(
  page: Page,
  label: string,
  reason: string
): Promise<boolean> {
  return await page.evaluate(
    (label, reason) => {
      const button = document.querySelector(`[aria-label="${label}"]`)
      return (
        // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- Browser evaluation cannot reference generated Sucrase helpers.
        button != null &&
        button.getAttribute('aria-disabled') === 'true' &&
        String(document.body.textContent).includes(reason)
      )
    },
    label,
    reason
  )
}

describe('the Score Game screen and the override dashboard (E10–E11)', function () {
  let group: Group
  let browser: Browser
  let runner: BrowserContext
  let anonymous: BrowserContext

  before(async function () {
    group = await seedGroup()
    browser = await launch()
    runner = await contextAs(browser, group.runner)
    // Tapping copy writes the clipboard, and the test reads it back.
    await runner.setPermission(
      WEB,
      { permission: { name: 'clipboard-read' }, state: 'granted' },
      { permission: { name: 'clipboard-write' }, state: 'granted' }
    )
    anonymous = await contextAs(browser)
  })
  after(async function () {
    await browser?.close()
  })

  it('E10: one Score Game pill opens the Score Game screen, whose Scoreboard taps reach the board, and a non-runner gets no pill', async function () {
    const gameId = group.games['-10m']
    // 1. Exactly one Score Game pill, and no Override Scoreboard pill.
    const page = await open(runner, `/games/${gameId}`, {
      width: 1200,
      height: 900
    })
    await page.waitForSelector('[aria-label="Score Game"]')
    expect(await page.$$('[aria-label="Score Game"]')).length(1)
    expect(await page.$('[aria-label="Override Scoreboard"]')).equals(null)
    expect(await page.$('[aria-label="Continue Scoring"]')).equals(null)
    await shot(page, 'gamePill')

    // 2. The Score Game screen, top to bottom, and its link copied.
    await press(page, 'Score Game')
    await page.waitForFunction(() => location.pathname.endsWith('/score-game'))
    expect(new URL(page.url()).pathname).equals(`/games/${gameId}/score-game`)
    const screen = await scoreGameScreen(page)
    expect(screen).deep.equals({
      inOrder: true,
      link: `${WEB}/scoreboard/${gameId}`,
      monospace: true,
      copyIcon: true
    })
    await shot(page, 'scoreGameRunner')
    await press(page, 'Copy scoreboard link')
    await page.waitForFunction(() =>
      String(document.body.textContent).includes('Copied')
    )
    expect(
      await page.evaluate(async () => await navigator.clipboard.readText())
    ).equals(`${WEB}/scoreboard/${gameId}`)
    await shot(page, 'scoreGameCopied')
    await until(
      '"Copied" gone after 2 s',
      async () =>
        !(await page.evaluate(() =>
          String(document.body.textContent).includes('Copied')
        )),
      4000
    )

    // 2a. Full game scoring opens the scorer, and Back returns here.
    await press(page, 'Full game scoring')
    await page.waitForFunction(() => location.pathname.endsWith('/score'))
    expect(new URL(page.url()).pathname).equals(`/games/${gameId}/score`)
    await page.waitForSelector('canvas[data-field-ready="true"]')
    await page.goBack()
    await page.waitForSelector('[aria-label="Copy scoreboard link"]')
    expect(new URL(page.url()).pathname).equals(`/games/${gameId}/score-game`)

    // 2b. Scoreboard opens the dashboard at its own address.
    await press(page, 'Scoreboard')
    await page.waitForFunction(() =>
      location.pathname.endsWith('/scoreboard-override')
    )
    expect(new URL(page.url()).pathname).equals(
      `/games/${gameId}/scoreboard-override`
    )

    // 3. B twice reaches a viewer in another tab.
    const viewer = await open(anonymous, `/scoreboard/${gameId}`)
    await boardShows(viewer, 'the first state', one => one.count === '0-0')
    await press(page, 'Add a ball')
    await boardShows(viewer, '1-0', one => one.count === '1-0')
    const tapped = await press(page, 'Add a ball')
    await boardShows(viewer, '2-0', one => one.count === '2-0', 5000)
    const took = Date.now() - tapped
    console.log(`      2-0 on the viewer ${took} ms after the tap`)
    expect(took).lessThan(1000)
    expect(await tileOverridden(page, 'count')).equals(true)

    // 4. The count tile's ✕ puts the automated count back.
    await press(page, 'Revert count')
    await boardShows(viewer, 'the automated 0-0', one => one.count === '0-0')
    expect(await tileOverridden(page, 'count')).equals(false)

    // 5. A base, the home score tapped twice, then long-pressed and picked,
    // then Reset.
    await press(page, 'Second base')
    await boardShows(viewer, 'second base', one => one.bases[1])
    await press(page, 'Home score')
    await boardShows(viewer, 'home 1', one => one.homeScore === '1')
    await press(page, 'Home score')
    await boardShows(viewer, 'home 2', one => one.homeScore === '2')
    await longPress(page, 'Home score')
    await press(page, 'Pick 9')
    await boardShows(viewer, 'home 9', one => one.homeScore === '9')
    expect(await tileOverridden(page, 'bases')).equals(true)
    expect(await tileOverridden(page, 'score-home')).equals(true)
    await shot(page, 'dashboard')
    await press(page, 'Reset Game State')
    await boardShows(
      viewer,
      'everything automated again',
      one => !one.bases[1] && one.homeScore === '0' && one.count === '0-0'
    )
    await until(
      'every tile back to automated',
      async () =>
        !(await tileOverridden(page, 'bases')) &&
        !(await tileOverridden(page, 'score-home'))
    )
    await viewer.close()
    await page.close()

    // 6. A plain member of the team, who sees the game but may not score it.
    const answer = await fetch(`${API}/games/${gameId}`, {
      headers: { authorization: `Bearer ${group.other}` }
    })
    expect(answer.status, 'the game is visible to a plain member').equals(200)
    const theirGame = (await answer.json()) as {
      canScore: boolean
      scoreboard: unknown
      homeScore: unknown
      awayScore: unknown
    }
    expect(theirGame.canScore).equals(false)
    expect(theirGame.scoreboard).deep.equals({ open: true, mayOverride: false })
    expect(
      [theirGame.homeScore, theirGame.awayScore],
      'the game is unscored'
    ).deep.equals([null, null])
    const other = await contextAs(browser, group.other)
    const theirs = await open(other, `/games/${gameId}`)
    await gameLoaded(theirs)
    expect(
      await theirs.$('[aria-label="Box score"]'),
      'the game page loaded'
    ).not.equals(null)
    expect(
      await theirs.$('[aria-label="Score Game"]'),
      'no Score Game pill for somebody who may not score'
    ).equals(null)
    expect(await theirs.$('[aria-label="Override Scoreboard"]')).equals(null)
    await shot(theirs, 'gameMember')
    const menu = await open(other, `/games/${gameId}/score-game`)
    await scoreGameScreen(menu)
    expect(
      await disabledWith(
        menu,
        'Scoreboard',
        'Only people who run a team in this game can operate the scoreboard'
      )
    ).equals(true)
    await shot(menu, 'scoreGameMember')
    const direct = await open(other, `/games/${gameId}/scoreboard-override`)
    await until('the branded 404', async () => await notFoundShown(direct))
    await shot(direct, 'dashboardRefused')
    await other.close()
  })

  it('E10: the scorer path, pill to Score Game screen to one pitch and Back', async function () {
    const gameId = group.games['+1h']
    const page = await open(runner, `/games/${gameId}`, {
      width: 1200,
      height: 900
    })
    await press(page, 'Score Game')
    await page.waitForFunction(() => location.pathname.endsWith('/score-game'))
    await press(page, 'Full game scoring')
    await page.waitForFunction(() => location.pathname.endsWith('/score'))
    await page.waitForSelector('canvas[data-field-ready="true"]')
    if ((await page.$('[aria-label="OK"]')) != null) await press(page, 'OK')
    await press(page, 'Open scoring menu')
    await press(page, 'Set Team Rosters')
    await press(page, 'Save Rosters')
    const saved = page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/games/${gameId}/events`) &&
        response.status() === 200
    )
    await press(page, 'Ball')
    await page.waitForSelector('[aria-label="Undo Ball"]')
    await saved
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Save status"]') == null
    )
    // Back returns to the Score Game screen, where the scorer was opened.
    await page.goBack()
    await page.waitForSelector('[aria-label="Copy scoreboard link"]')
    expect(new URL(page.url()).pathname).equals(`/games/${gameId}/score-game`)
    const events = await fetch(`${API}/games/${gameId}/events`, {
      headers: { authorization: `Bearer ${group.runner}` }
    })
    const stored = (await events.json()) as {
      currentPlay: { playEvents?: unknown[] } | null
      plays: unknown[]
    }
    expect(
      (stored.currentPlay?.playEvents ?? []).length + stored.plays.length,
      'the pitch was stored'
    ).greaterThan(0)
    await page.close()
  })

  it('E11: an expired game’s dashboard is the branded 404, and its Score Game screen says the board has closed', async function () {
    const gameId = group.games['-4h']
    const page = await open(runner, `/games/${gameId}/scoreboard-override`)
    await until('the branded 404', async () => await notFoundShown(page))
    const menu = await open(runner, `/games/${gameId}/score-game`)
    const screen = await scoreGameScreen(menu)
    expect(screen.link).equals(`${WEB}/scoreboard/${gameId}`)
    expect(
      await disabledWith(
        menu,
        'Scoreboard',
        "This game's scoreboard has closed"
      )
    ).equals(true)
    await shot(menu, 'scoreGameClosed')
  })
})
