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

import {
  NO_OVERRIDES,
  SAMPLE_SCOREBOARD,
  SCOREBOARD_BOARD_SIZE
} from '../../common/scoreboard'
import { makeDatabase } from '../../server/db/database'
import { override, scoreboardSocketUrl } from '../../test/scoreboardPublish.e2e'
import { scoreboardV1Html } from '../../test/scoreboardV1Page.e2e'
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
 * E6 to E8 (M2), and E9 by pointing the same file at a seat.
 *
 *   GS_SCOREBOARD_WEB_URL=http://127.0.0.1:8080 \
 *   GS_API_TEST_URL=http://127.0.0.1:9100/api/v1 \
 *   GS_E2E_DATABASE=AppDb_nativeScoreboard \
 *   GS_E2E_SERVER_LOG=server.log \
 *     node_modules/.bin/mocha -r sucrase/register --extension ts \
 *     --timeout 120000 src2/app/scoreboard/scoreboard.e2e.ts
 *
 * Each group seeds its own games first (`seedScoreboardGames`) and signs the
 * two e2e accounts in with codes read from the server's log. On a seat, where
 * the server's log is not at hand, pass the tokens instead, and run
 * only the steps that need no local Redis:
 *
 *   GS_SCOREBOARD_WEB_URL=https://$SEAT_HOST \
 *   GS_API_TEST_URL=https://$SEAT_HOST/api/v1 \
 *   GS_E2E_DATABASE=<the seat's database URL> \
 *   GS_E2E_RUNNER_TOKEN=… GS_E2E_OTHER_TOKEN=… \
 *     node_modules/.bin/mocha … --grep 'E6|E7\.[123]' \
 *     src2/app/scoreboard/scoreboard.e2e.ts
 *
 * Other settings: GS_CHROME_PATH (the Chrome puppeteer drives),
 * GS_E2E_REDIS_KEY (the key prefix, gs:<database name>), GS_E2E_SHOTS (where
 * screenshots go, /tmp/nsbShots).
 */
const WEB = (
  process.env.GS_SCOREBOARD_WEB_URL ?? 'http://127.0.0.1:8080'
).replace(/\/+$/, '')
const API = (
  process.env.GS_API_TEST_URL ?? 'http://127.0.0.1:9100/api/v1'
).replace(/\/+$/, '')
const HOST = new URL(API).origin
const DATABASE = process.env.GS_E2E_DATABASE ?? 'AppDb_nativeScoreboard'
const DATABASE_URL = DATABASE.includes('://')
  ? DATABASE
  : `postgres://localhost:5433/${DATABASE}`
const SERVER_LOG = process.env.GS_E2E_SERVER_LOG ?? 'server.log'
const PREFIX =
  process.env.GS_E2E_REDIS_KEY ??
  `gs:${new URL(DATABASE_URL).pathname.slice(1)}`
const SHOTS = process.env.GS_E2E_SHOTS ?? '/tmp/nsbShots'
const MEASURE_SCRIPT = join(
  __dirname,
  '../../../mobile/apps/gsDirector/Packages/DirectorUI/Sources/DirectorUI/WebOverlayController.swift'
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
    runner: await signIn(RUNNER_EMAIL, 'GS_E2E_RUNNER_TOKEN'),
    other: await signIn(OTHER_EMAIL, 'GS_E2E_OTHER_TOKEN')
  }
}

async function launch(): Promise<Browser> {
  mkdirSync(SHOTS, { recursive: true })
  return await puppeteer.launch({
    headless: true,
    executablePath: process.env.GS_CHROME_PATH,
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
      name: 'gs_session',
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
        one.textContent === 'Sign up for GameStation' &&
        one.getAttribute('href') === '/sign-in'
    )
    return (
      text.includes("This scoreboard isn't live") &&
      document.querySelector('[aria-label="GameStation"]') != null &&
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

describe('scoreboard pages (E6–E9)', function () {
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

  it('E6: the sample page is transparent, B, laid out as 1.0 drew it, and asks for no session', async function () {
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

    // 1.0's component, drawn from `src/client/Scoreboard.tsx` with the same
    // state in the same browser, in the 1920 × 1080 window B was measured in
    // (1.0's sizes grow with the window; the port's do not).
    const window = { width: 1920, height: 1080 }
    const v1 = await anonymous.newPage()
    await v1.setViewport(window)
    await v1.setContent(await scoreboardV1Html(SAMPLE_SCOREBOARD), {
      waitUntil: 'load'
    })
    const ported = await open(anonymous, '/scoreboard-sample', window)
    await boardShows(ported, 'the sample', one => one.drawn)
    const v1Layout = await layoutOf(v1)
    const portedLayout = await layoutOf(ported)
    console.log(`      1.0: ${JSON.stringify(v1Layout)}`)
    expect(portedLayout, 'every part where 1.0 put it').deep.equals(v1Layout)
    expect(Math.ceil(v1Layout.face[2])).equals(SCOREBOARD_BOARD_SIZE.width)
    expect(Math.ceil(v1Layout.face[3])).equals(SCOREBOARD_BOARD_SIZE.height)
    const clip = { x: 0, y: 0, ...SCOREBOARD_BOARD_SIZE }
    const v1Png = await v1.screenshot({ clip, omitBackground: true })
    const portedPng = await ported.screenshot({ clip, omitBackground: true })
    await v1.screenshot({ clip, path: join(SHOTS, 'sample-v1.png') })
    await ported.screenshot({ clip, path: join(SHOTS, 'sample-ported.png') })
    const differing = await pixelsDiffering(browser, v1Png, portedPng)
    console.log(
      `      ${differing} of ${clip.width * clip.height} pixels differ from 1.0`
    )
    // Antialiasing on the turned bases and round dots differs from one
    // drawing of 1.0 to the next by about 200 pixels; layout does not.
    expect(differing).lessThan((clip.width * clip.height) / 100)
    await v1.close()
    await ported.close()
  })

  it('E7.1: a live board draws the seeded names and 0–0 before anything is published', async function () {
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

  it('E7.2: a published partial reaches the page within 1 s', async function () {
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

  it('E7.3: a closed board shows the branded 404', async function () {
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
        expect(
          size,
          `${one.name} at ${viewport.width} × ${viewport.height}`
        ).deep.equals([
          SCOREBOARD_BOARD_SIZE.width,
          SCOREBOARD_BOARD_SIZE.height
        ])
      }
      await page.close()
    }
    for (const line of sizes) console.log(`      ${line}`)
    await override(HOST, gameId, group.runner, NO_OVERRIDES)
  })
})
