import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { PNG } from 'pngjs'

import {
  NO_OVERRIDES,
  SCOREBOARD_BOARD_SIZE
} from '../../../../src/common/scoreboard'
import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import type { Page } from '../../../core/web'
import { override } from '../../../rigs/scoreboardPublish'
import {
  publishAt,
  seedBoards,
  sleep,
  until
} from '../scoreboard-server/boardSockets'
import {
  anonymousSession,
  boardShows,
  notFoundShown,
  openPath,
  shot
} from './boardPage'

/**
 * The scoreboard pages in this machine's browser against the stack (the old
 * E6 to E8): the transparent sample, a live board drawing what is published
 * within a second, a closed board's branded 404 and its quiet form, and the
 * sizes TS Director measures. Nothing here plays video or draws 3D, so the
 * browser is headless Chromium on a browser droplet. Each page is opened by
 * maestro-d; the page is only read.
 */

const FIXTURES = join(__dirname, '../../../../src/app/scoreboard/fixtures')
const MEASURE_SCRIPT = join(
  __dirname,
  '../../../../mobile/apps/tsDirector/Packages/DirectorUI/Sources/DirectorUI/WebOverlayController.swift'
)

/** A PNG's alpha at a point (−1 with none asked), its highest, and its size. */
function alphaOf(
  png: Uint8Array,
  at?: { x: number; y: number }
): { at: number; max: number; width: number; height: number } {
  const image = PNG.sync.read(Buffer.from(png))
  let max = 0
  for (let i = 3; i < image.data.length; i += 4)
    max = Math.max(max, image.data[i])
  const atPoint =
    at == null ? -1 : image.data[(at.y * image.width + at.x) * 4 + 3]
  return { at: atPoint, max, width: image.width, height: image.height }
}

/** How many pixels two same-sized PNGs differ in, outside `skip`'s boxes. */
function pixelsDiffering(
  a: Uint8Array,
  b: Uint8Array,
  /** Boxes, [x, y, width, height], whose pixels are not compared. */
  skip: number[][] = []
): number {
  const one = PNG.sync.read(Buffer.from(a))
  const two = PNG.sync.read(Buffer.from(b))
  if (one.data.length !== two.data.length) return Infinity
  const skipped = (i: number): boolean => {
    const x = (i / 4) % one.width
    const y = Math.floor(i / 4 / one.width)
    return skip.some(
      ([left, top, width, height]) =>
        x >= left && x < left + width && y >= top && y < top + height
    )
  }
  let count = 0
  for (let i = 0; i < one.data.length; i += 4) {
    if (
      !skipped(i) &&
      // A few pixels of team-bar width change the gradient's rounded colour
      // channels by one or two levels. Its alpha must agree.
      (Math.abs(one.data[i] - two.data[i]) > 2 ||
        Math.abs(one.data[i + 1] - two.data[i + 1]) > 2 ||
        Math.abs(one.data[i + 2] - two.data[i + 2]) > 2 ||
        one.data[i + 3] !== two.data[i + 3])
    )
      count++
  }
  return count
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

/** Director's measuring script, as the Swift file has it. */
function contentSizeScript(): string {
  const swift = readFileSync(MEASURE_SCRIPT, 'utf8')
  const match = /contentSizeScript = """\n([\s\S]*?)\n\s*"""/.exec(swift)
  if (match == null) throw new Error('contentSizeScript not found')
  return match[1]
}

/** E6: the sample is transparent, reserves its numeric columns, and asks for no session. */
async function sampleBoard(ctx: HarnessContext): Promise<void> {
  const session = await anonymousSession(
    ctx,
    { width: 1280, height: 720 },
    true
  )
  const { page } = session
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  await openPath(ctx, session, '/scoreboard-sample')
  await page.waitForNetworkIdle({ idleTime: 500 })
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
    ].map(node => (node == null ? '' : getComputedStyle(node).backgroundColor))
  )
  expect(backgrounds).deep.equals([
    'rgba(0, 0, 0, 0)',
    'rgba(0, 0, 0, 0)',
    'rgba(0, 0, 0, 0)'
  ])
  const png = await page.screenshot({ omitBackground: true })
  const alpha = alphaOf(png, { x: 1000, y: 600 })
  expect(alpha.at, 'alpha at (1000, 600)').equals(0)
  const box = await page.evaluate(() => {
    const board = document.querySelector('[data-scoreboard="board"]')
    if (board === null) return []
    const rect = board.getBoundingClientRect()
    return [rect.left, rect.top, rect.width, rect.height]
  })
  expect(box.slice(0, 2)).deep.equals([0, 0])
  expect(box[2]).closeTo(701, 2)
  expect(box[3]).equals(SCOREBOARD_BOARD_SIZE.height)
  expect(requests.filter(url => url.includes('/auth/me'))).deep.equals([])
  await shot(ctx, session, 'sample')

  // 1.0's component, recorded from 1.0's `Scoreboard.tsx` (at 25f9496e) with
  // the same state in the same browser, in the 1920 × 1080 window B was
  // measured in (1.0's sizes grow with the window; the port's do not).
  await session.resize({ width: 1920, height: 1080 })
  const ported = await openPath(ctx, session, '/scoreboard-sample')
  await boardShows(ported, 'the sample', one => one.drawn)
  const v1Layout: Layout = JSON.parse(
    readFileSync(join(FIXTURES, 'scoreboardV1Layout.json'), 'utf8')
  )
  const portedLayout = await layoutOf(ported)
  // The board draws in Inter, which the app ships, where 1.0 drew in a
  // Helvetica Neue that fell back to Arial (2770e3861): each part is where
  // 1.0 put it, give or take its letters' widths across, and a pixel down.
  expect(Object.keys(portedLayout.parts), 'the parts 1.0 drew').deep.equals(
    Object.keys(v1Layout.parts)
  )
  for (const [name, drawnBox, v1] of [
    ['face', portedLayout.face, v1Layout.face],
    ...Object.keys(v1Layout.parts).map(key => [
      key,
      portedLayout.parts[key],
      v1Layout.parts[key]
    ])
  ] as Array<[string, number[], number[]]>) {
    const [x, y, width, height] = drawnBox
    const [x1, y1, width1, height1] = v1
    if (['A. RIVERA', 'J. WILSON', 'VISITORS', 'PIONEERS'].includes(name))
      expect(Math.abs(x - x1), `${name} across`).lessThan(7)
    if (['VISITORS', 'PIONEERS'].includes(name))
      expect(Math.abs(width - width1), `${name} wide`).lessThan(7)
    expect(Math.abs(y - y1), `${name} down`).lessThan(1.5)
    expect(Math.abs(height - height1), `${name} high`).lessThan(1.5)
  }
  expect(Math.ceil(v1Layout.face[2])).equals(SCOREBOARD_BOARD_SIZE.width)
  expect(Math.ceil(v1Layout.face[3])).equals(SCOREBOARD_BOARD_SIZE.height)
  const clip = { x: 0, y: 0, ...SCOREBOARD_BOARD_SIZE }
  const v1Png = readFileSync(join(FIXTURES, 'scoreboardV1.png'))
  const portedPng = await ported.screenshot({ clip, omitBackground: true })
  await ported.screenshot({ clip, path: ctx.artifact('sample-ported.png') })
  // Every pixel but the letters: each part's box, where 1.0 put it and where
  // it is now, and a pixel round.
  const letters = Object.keys(v1Layout.parts).map(key => {
    const [x, y, width, height] = portedLayout.parts[key]
    const [x1, y1, width1, height1] = v1Layout.parts[key]
    const left = Math.floor(Math.min(x, x1)) - 1
    const top = Math.floor(Math.min(y, y1)) - 1
    return [
      left,
      top,
      Math.ceil(Math.max(x + width, x1 + width1)) + 1 - left,
      Math.ceil(Math.max(y + height, y1 + height1)) + 1 - top
    ]
  })
  // The wider numeric columns move the right-hand artwork. Keep comparing
  // the original team bars and the left edge of the board pixel by pixel.
  letters.push([185, 0, clip.width - 185, clip.height])
  const differing = pixelsDiffering(v1Png, portedPng, letters)
  // Antialiasing on the turned bases and round dots differs from one drawing
  // of 1.0 to the next by about 200 pixels; layout does not.
  expect(differing, 'pixels differing in the original team-bar area').lessThan(
    (185 * clip.height) / 100
  )
}

/** E7.1: a live board draws the seeded names and 0–0 before anything is published. */
async function liveFirstState(ctx: HarnessContext): Promise<void> {
  const boards = await seedBoards(ctx)
  const session = await anonymousSession(ctx)
  const page = await openPath(
    ctx,
    session,
    `/scoreboard/${boards.games['+1h']}`
  )
  const board = await boardShows(page, 'the first state', one => one.drawn)
  expect(board).deep.include({
    away: boards.awayTeam,
    home: boards.homeTeam,
    awayScore: '0',
    homeScore: '0',
    count: '0-0',
    outs: 0
  })
}

/** E7.2: a published partial reaches the page within 1 s. */
async function publishReachesPage(ctx: HarnessContext): Promise<void> {
  const boards = await seedBoards(ctx)
  const gameId = boards.games['+1h']
  const session = await anonymousSession(ctx)
  const page = await openPath(ctx, session, `/scoreboard/${gameId}`)
  await boardShows(page, 'the first state', one => one.drawn)
  const published = await publishAt(ctx, gameId, boards.runner, {
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
  expect(took, `shown ${took} ms after the publish`).lessThan(1000)
  expect(board.bases).deep.equals([true, false, true])
  await shot(ctx, session, 'live')
}

/** The board keeps its width through radar packets, score changes and both wipes. */
async function keepsWidth(ctx: HarnessContext): Promise<void> {
  const boards = await seedBoards(ctx)
  const id = boards.games['-10m']
  const session = await anonymousSession(ctx)
  const page = await openPath(ctx, session, `/scoreboard/${id}`)
  const send = async (fields: Record<string, unknown>): Promise<void> => {
    const packet = await publishAt(ctx, id, boards.runner, fields)
    packet.done()
  }
  const part = (name: string): string => `[data-scoreboard="${name}"]`
  const width = async (): Promise<number> =>
    await page.$eval(
      part('board'),
      element => element.getBoundingClientRect().width
    )
  await boardShows(page, 'live board', board => board.drawn)
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  const baseline = await width()
  for (const [n, speed] of [9, 44, 88, 100, 0].entries()) {
    await send({
      pitchSpeed: speed,
      inning: n === 0 ? 9 : 10,
      homeScore: n === 0 ? 9 : 10,
      batterName: n === 4 ? '' : 'B'.repeat(128),
      pitcherName: n === 4 ? '' : 'P'.repeat(128)
    })
    await until(
      `pitch ${speed}`,
      async () =>
        (await page.$eval(part('pitchSpeed'), e => e.textContent)) ===
        `${speed}MPH`
    )
    expect(await width(), `pitch ${speed}`).equals(baseline)
  }
  await send({
    batterName: 'Batter',
    batterNumHits: 1,
    batterAtBats: 2,
    exitVelocity: 55
  })
  await page.waitForSelector(part('exitSpeed'))
  expect(await page.$eval(part('exitSpeed'), e => e.textContent)).equals(
    'Exit: 55 MPH'
  )
  expect(await width()).equals(baseline)
  await send({ batterNumHits: 2, batterAtBats: 3 })
  await page.waitForSelector(part('exitSpeed'), {
    hidden: true,
    timeout: 8000
  })
  expect(await page.$eval(part('batterLine'), e => e.textContent)).equals('2-3')
  expect(await width()).equals(baseline)
}

/** E7.3: a closed board shows the branded 404. */
async function closedBoard(ctx: HarnessContext): Promise<void> {
  const boards = await seedBoards(ctx)
  const session = await anonymousSession(ctx)
  const page = await openPath(
    ctx,
    session,
    `/scoreboard/${boards.games['-4h']}`
  )
  await until('the branded 404', async () => await notFoundShown(page))
  await shot(ctx, session, 'notFound')
}

/** E7.4: a quiet closed board paints nothing at all. */
async function quietClosedBoard(ctx: HarnessContext): Promise<void> {
  const boards = await seedBoards(ctx)
  const session = await anonymousSession(ctx)
  const page = await openPath(
    ctx,
    session,
    `/scoreboard/${boards.games['-4h']}?quiet=1`
  )
  await sleep(1500)
  expect(await notFoundShown(page)).equals(false)
  const png = await page.screenshot({ omitBackground: true })
  expect(alphaOf(png).max, 'the highest alpha on the page').equals(0)
}

/** E8: Director measures the sample, a long-named live board and a quiet closed page. */
async function directorMeasures(ctx: HarnessContext): Promise<void> {
  const boards = await seedBoards(ctx)
  const gameId = boards.games['-10m']
  const long = 'L'.repeat(40)
  const set = await override(ctx.stack.origin, gameId, boards.runner, {
    ...NO_OVERRIDES,
    overrideTeamEnabled: true,
    overrideTeam: { homeTeam: long, awayTeam: long }
  })
  expect(
    set.replies.some(reply => 'error' in (reply as object)),
    JSON.stringify(set)
  ).equals(false)
  // A batter and a pitcher, as the sample has, so the board draws all its
  // rows whatever has been scored on this game before.
  const named = await publishAt(ctx, gameId, boards.runner, {
    batterName: 'A. RIVERA',
    pitcherName: 'J. WILSON'
  })
  named.done()
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
      path: `/scoreboard/${boards.games['-4h']}?quiet=1`,
      ready: async () => {
        await sleep(1500)
      }
    }
  ]
  // Where Director lays a page out to measure it: Output's width, at least
  // 2160 high (`measureContent`, WebOverlayController.swift).
  const viewport = { width: 1920, height: 2160 }
  for (const one of pages) {
    const session = await anonymousSession(ctx, viewport)
    const page = await openPath(ctx, session, one.path)
    await one.ready(page)
    await session.resize(viewport)
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    await sleep(100)
    const size = (await page.evaluate(contentSizeScript())) as number[]
    if (one.name.startsWith('live, 40')) {
      // The longer team name carries the board past B. The height stays.
      expect(size[0], one.name).to.be.greaterThan(SCOREBOARD_BOARD_SIZE.width)
      expect(size[1], one.name).equals(SCOREBOARD_BOARD_SIZE.height)
      const boxes = await page.evaluate(() => {
        const box = (name: string): number[] => {
          const node = document.querySelector(`[data-scoreboard="${name}"]`)
          // Page code: Sucrase's helpers are not there, so no `?.`.
          const team = node == null ? null : node.parentElement
          if (node == null || team == null) return []
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
      expect(boxes.home[2], 'the long name is not clipped').to.be.greaterThan(
        400
      )
    } else if (one.name === 'sample') {
      expect(size[0]).closeTo(701, 2)
      expect(size[1]).equals(SCOREBOARD_BOARD_SIZE.height)
    } else {
      expect(
        size,
        `${one.name} at ${viewport.width} × ${viewport.height}`
      ).deep.equals([SCOREBOARD_BOARD_SIZE.width, SCOREBOARD_BOARD_SIZE.height])
    }
    await session.close()
  }
  await override(ctx.stack.origin, gameId, boards.runner, NO_OVERRIDES)
}

export default defineHarness({
  id: 'playback/scoreboard-pages/board-pages',
  title:
    'The scoreboard pages draw the sample, a live board within a second, and a closed board’s 404',
  kind: 'e2e',
  covers: [
    'src/app/scoreboard/ScoreboardBoard.tsx',
    'src/app/scoreboard/ScoreboardPage.tsx',
    'src/app/scoreboard/ScoreboardNotFound.tsx',
    'src/app/scoreboard/scoreboardSocket.ts',
    'src/app/scoreboard/scoreboardRoute.ts'
  ],
  stack: 'isolated',
  fixtures: ['scoreboard-games'],
  exclusive: false,
  surfaces: {
    // The board draws no 3D and plays no video: headless Chromium on a
    // browser droplet.
    'web-chromium': { devices: [], browser: { role: 'browser', needs: [] } }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 6,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'sample-board': sampleBoard,
    'live-first-state': liveFirstState,
    'publish-reaches-page': publishReachesPage,
    'keeps-width': keepsWidth,
    'closed-board-404': closedBoard,
    'quiet-closed-board': quietClosedBoard,
    'closes-while-open': async () => {
      throw new BlockedError(
        "an open board switching to the 404 at its 60 s check once its game's start moves 3 h back: the board stays open while the game's key is in the stack's Valkey, and no control route deletes it"
      )
    },
    'director-measures': directorMeasures
  }
})
