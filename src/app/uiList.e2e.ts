import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import puppeteer, { type Browser, type Page } from 'puppeteer'

import { userIdOfGumbo } from '../common/userId'
import { scheduleDate } from './screens/format'

/**
 * The list-screen checks, against the web app on :8080 with the API
 * intercepted. Chrome is `TS_CHROME_PATH` when that is set.
 *
 *   node_modules/.bin/mocha -r sucrase/register --extension ts \
 *     --timeout 180000 src/app/uiList.e2e.ts
 */
const WEB = 'http://127.0.0.1:8080'

interface Size {
  name: string
  width: number
  height: number
}

const SIZES: Size[] = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 393, height: 852 }
]

const USER = {
  id: 7,
  displayName: 'Pat',
  email: 'pat@example.com',
  isAdmin: false
}

const GAME = {
  id: 'gam_1',
  homeTeamId: 'tem_home',
  awayTeamId: 'tem_away',
  homeTeamName: 'Sox',
  awayTeamName: 'Badgers',
  homeTeamExternal: false,
  awayTeamExternal: false,
  seasonId: 'sea_1',
  startAt: '2026-10-04T23:45:00.000Z',
  venue: 'Field 2',
  status: 'final',
  homeScore: 0,
  awayScore: 4,
  ingestStatus: 'done',
  videoCount: 1,
  durationSec: 5400,
  posterUrl: `${WEB}/fixture-poster.svg`,
  homeLogoUrl: null,
  awayLogoUrl: null,
  isLive: false,
  externalIds: []
}

const RTMP_URL = 'rtmp://ingest.example/live/lst_own-key'

const OWN_CAMERA = {
  id: 'lst_own',
  gameId: 'gam_rtmp',
  userId: userIdOfGumbo(7),
  ownerName: 'Pat',
  slot: 1,
  label: 'Dugout',
  keyPrefix: 'lst_own',
  state: 'idle',
  opensAt: '2026-10-02T20:00:00.000Z',
  closesAt: null
}

const OTHER_CAMERA = {
  id: 'lst_other',
  gameId: 'gam_rtmp',
  userId: userIdOfGumbo(8),
  ownerName: 'Sam',
  slot: 1,
  label: 'Third base',
  keyPrefix: 'lst_other',
  state: 'idle',
  opensAt: '2026-10-02T20:00:00.000Z',
  closesAt: null
}

let listed: Array<
  Omit<typeof GAME, 'awayScore' | 'homeScore' | 'venue'> & {
    awayScore: number | null
    homeScore: number | null
    venue: string | null
  }
> = [GAME]

let browser: Browser | undefined

function cors(
  status: number,
  body: unknown
): {
  status: number
  contentType: string
  headers: Record<string, string>
  body: string
} {
  return {
    status,
    contentType: 'application/json',
    headers: {
      'access-control-allow-origin': WEB,
      'access-control-allow-credentials': 'true'
    },
    body: JSON.stringify(body)
  }
}

async function open(path: string, size: Size): Promise<Page> {
  if (browser == null) throw new Error('no browser')
  const page = await browser.newPage()
  page.setDefaultTimeout(8000)
  await page.setViewport({ width: size.width, height: size.height })
  await page.setRequestInterception(true)
  page.on('request', request => {
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') {
      const asked = request.headers()['access-control-request-headers']
      request
        .respond({
          status: 204,
          headers: {
            'access-control-allow-origin': WEB,
            'access-control-allow-credentials': 'true',
            'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
            'access-control-allow-headers':
              asked != null && asked !== '' ? asked : 'content-type'
          }
        })
        .catch(() => undefined)
      return
    }
    if (url.pathname === '/fixture-poster.svg') {
      request
        .respond({
          status: 200,
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#224466"/></svg>'
        })
        .catch(() => undefined)
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      request.continue().catch(() => undefined)
      return
    }
    const pathName = url.pathname
    if (
      request.method() === 'POST' &&
      pathName === '/api/v1/games/gam_rtmp/live-streams/lst_own/reveal'
    ) {
      request
        .respond(cors(200, { ...OWN_CAMERA, url: RTMP_URL }))
        .catch(() => undefined)
      return
    }
    if (request.method() !== 'GET') {
      request.respond(cors(404, { error: 'not found' })).catch(() => undefined)
      return
    }
    if (pathName === '/api/v1/auth/me') {
      request.respond(cors(200, USER)).catch(() => undefined)
      return
    }
    if (pathName === '/api/v1/me/roles') {
      request.respond(cors(200, { teams: {} })).catch(() => undefined)
      return
    }
    if (
      pathName === '/api/v1/events' ||
      pathName.startsWith('/api/v1/events?')
    ) {
      request.respond(cors(200, listed)).catch(() => undefined)
      return
    }
    if (pathName === '/api/v1/games/gam_box') {
      request
        .respond(
          cors(200, {
            id: 'gam_box',
            homeTeamId: 'home',
            awayTeamId: 'away',
            homeTeamName: 'Hawks',
            awayTeamName: 'Owls',
            seasonId: null,
            startAt: null,
            venue: null,
            status: 'final',
            homeScore: 0,
            awayScore: 1,
            ingestStatus: 'done',
            ingestMessage: null,
            nonMemberView: false,
            videos: [],
            linescore: {
              away: { runs: [1], r: 1, h: 2, e: 0 },
              home: { runs: [0], r: 0, h: 1, e: 0 }
            }
          })
        )
        .catch(() => undefined)
      return
    }
    if (pathName === '/api/v1/games/gam_box/box-score') {
      request
        .respond(
          cors(200, {
            batting: [
              {
                userId: userIdOfGumbo(1),
                gumboId: 1,
                shortName: 'Alex',
                teamId: 'away',
                pa: 2,
                ab: 2,
                h: 1,
                singles: 1,
                doubles: 0,
                triples: 0,
                hr: 0,
                bb: 0,
                k: 1,
                hbp: 0,
                rbi: 1,
                rates: { avg: 0.5, obp: 0.5, slg: 0.5, ops: 1 }
              }
            ],
            pitching: []
          })
        )
        .catch(() => undefined)
      return
    }
    if (pathName === '/api/v1/games/gam_rtmp') {
      request
        .respond(
          cors(200, {
            id: 'gam_rtmp',
            homeTeamId: 'tem_home',
            awayTeamId: 'tem_away',
            homeTeamName: 'Sox',
            awayTeamName: 'Badgers',
            seasonId: null,
            startAt: '2026-10-04T23:45:00.000Z',
            venue: null,
            status: 'final',
            homeScore: 0,
            awayScore: 4,
            ingestStatus: 'done',
            ingestMessage: null,
            nonMemberView: false,
            videos: []
          })
        )
        .catch(() => undefined)
      return
    }
    if (pathName === '/api/v1/games/gam_rtmp/live-streams') {
      request
        .respond(
          cors(200, {
            gameId: 'gam_rtmp',
            mine: [OWN_CAMERA],
            others: [OTHER_CAMERA],
            canAdd: 3,
            maxCameras: 4
          })
        )
        .catch(() => undefined)
      return
    }
    if (pathName === '/api/v1/seasons') {
      request
        .respond(
          cors(200, [
            {
              id: 'sea_1',
              leagueId: null,
              name: 'Spring 2026',
              year: 2026,
              term: null,
              ageGroup: null,
              teams: 2,
              games: 2,
              videos: 0,
              logoUrl: null
            }
          ])
        )
        .catch(() => undefined)
      return
    }
    request.respond(cors(200, [])).catch(() => undefined)
  })
  await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle0' })
  return page
}

async function until<T>(
  what: string,
  read: () => T | undefined | Promise<T | undefined>
): Promise<T> {
  const end = Date.now() + 20000
  for (;;) {
    const value = await read()
    if (value != null && value !== false) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

interface Thumb {
  width: number
  height: number
  textHeight: number
  rowHeight: number
  objectFit: string
  objectPosition: string
}

async function thumb(page: Page): Promise<Thumb | undefined> {
  return await page.evaluate(() => {
    const row = document.querySelector('[aria-label^="Badgers"]')
    if (row === null) return undefined
    const img = row.querySelector('img')
    if (img === null) return undefined
    if (img.parentElement === null) return undefined
    const frame = img.parentElement.parentElement
    if (frame === null) return undefined
    const name = Array.from(row.querySelectorAll('*')).find(function (node) {
      return node.children.length === 0 && node.textContent === 'Badgers'
    })
    if (name == null) return undefined
    if (name.parentElement === null) return undefined
    if (name.parentElement.parentElement === null) return undefined
    const frameBox = frame.getBoundingClientRect()
    const textBox = name.parentElement.parentElement.getBoundingClientRect()
    const rowBox = row.getBoundingClientRect()
    const style = getComputedStyle(img)
    return {
      width: frameBox.width,
      height: frameBox.height,
      textHeight: textBox.height,
      rowHeight: rowBox.height,
      objectFit: style.objectFit,
      objectPosition: style.objectPosition
    }
  })
}

describe('list screens', function () {
  before(async function () {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.TS_CHROME_PATH,
      args: ['--use-gl=angle', '--use-angle=swiftshader']
    })
  })

  after(async function () {
    await browser?.close()
  })

  for (const size of SIZES) {
    it(`Thumbnails at ${size.width}×${size.height}`, async function () {
      listed = [GAME]
      const page = await open('/videos', size)
      const box = await until('the thumbnail', async () => {
        const read = await thumb(page)
        if (read == null || read.width < 1) return undefined
        return read
      })
      expect(box.height / box.width).closeTo(3 / 4, 0.02)
      expect(box.width / box.textHeight).closeTo(16 / 9, 0.02)
      expect(box.height).greaterThan(box.textHeight)
      expect(box.objectFit).equals('cover')
      expect(
        box.objectPosition.includes('center') ||
          box.objectPosition.includes('50%')
      ).equals(true)
      expect(Math.abs(box.rowHeight - box.height)).lessThan(2)
      await page.close()
    })

    it(`A location does not grow the row at ${size.width}×${size.height}`, async function () {
      listed = [
        {
          ...GAME,
          id: 'gam_venue',
          awayTeamName: 'Natives',
          venue: 'Poway National Little League'
        },
        {
          ...GAME,
          id: 'gam_plain',
          awayTeamName: 'Otters',
          venue: null
        }
      ]
      const page = await open('/videos', size)
      const boxes = await until('both thumbnails', async () => {
        return await page.evaluate(() => {
          function read(name: string):
            | {
                width: number
                height: number
                row: number
                venueBottom: number | null
                venueHeight: number | null
                rowBottom: number
              }
            | undefined {
            const row = document.querySelector(`[aria-label^="${name}"]`)
            if (row == null) return undefined
            const img = row.querySelector('img')
            if (img?.parentElement == null) return undefined
            const frame = img.parentElement.parentElement
            if (frame == null) return undefined
            const frameBox = frame.getBoundingClientRect()
            const rowBox = row.getBoundingClientRect()
            if (frameBox.width < 1) return undefined
            const venueNode = Array.from(row.querySelectorAll('*')).find(
              function (node) {
                return (
                  node.children.length === 0 &&
                  node.textContent === 'Poway National Little League'
                )
              }
            )
            const venueBox =
              venueNode == null ? null : venueNode.getBoundingClientRect()
            return {
              width: frameBox.width,
              height: frameBox.height,
              row: rowBox.height,
              rowBottom: rowBox.bottom,
              venueBottom: venueBox == null ? null : venueBox.bottom,
              venueHeight: venueBox == null ? null : venueBox.height
            }
          }
          const placed = read('Natives')
          const plain = read('Otters')
          if (placed == null || plain == null) return undefined
          return { placed, plain }
        })
      })
      expect(boxes.placed.width).closeTo(boxes.plain.width, 1)
      expect(boxes.placed.height).closeTo(boxes.plain.height, 1)
      expect(boxes.placed.row).closeTo(boxes.plain.row, 2)
      expect(boxes.placed.venueHeight ?? 0).greaterThan(0)
      expect(boxes.placed.venueBottom ?? 0).lessThanOrEqual(
        boxes.placed.rowBottom + 1
      )
      await page.close()
    })

    it(`Result pill at ${size.width}×${size.height}`, async function () {
      listed = [GAME]
      const page = await open('/videos', size)
      const pill = await until('the result pill', async () => {
        const read = await page.evaluate(() => {
          const row = document.querySelector('[aria-label^="Badgers"]')
          if (row === null) return undefined
          const textOf = function (value: string): Element | undefined {
            const found = Array.from(row.querySelectorAll('*')).find(
              function (node) {
                return node.children.length === 0 && node.textContent === value
              }
            )
            return found
          }
          const first = textOf('Badgers')
          const second = textOf('@ Sox')
          const detail = Array.from(row.querySelectorAll('*')).find(
            function (node) {
              const label = node.textContent
              if (label === null) return false
              return node.children.length === 0 && label.includes('·')
            }
          )
          const score = textOf('4–0')
          const chevron = textOf('chevron_right')
          if (
            first === undefined ||
            second === undefined ||
            detail === undefined ||
            score === undefined ||
            first.parentElement === null ||
            score.parentElement === null ||
            row.parentElement === null
          ) {
            return undefined
          }
          const line = first.parentElement.getBoundingClientRect()
          const pillBox = score.parentElement.getBoundingClientRect()
          const secondBox = second.getBoundingClientRect()
          const detailBox = detail.getBoundingClientRect()
          const card = row.parentElement.getBoundingClientRect()
          const cardStyle = getComputedStyle(row.parentElement)
          const contentRight =
            card.right -
            Number.parseFloat(cardStyle.paddingRight) -
            Number.parseFloat(cardStyle.borderRightWidth)
          const hits = function (box: DOMRect): boolean {
            return !(
              pillBox.right <= box.left ||
              pillBox.left >= box.right ||
              pillBox.bottom <= box.top ||
              pillBox.top >= box.bottom
            )
          }
          let chevronOnFirst = false
          if (chevron !== undefined) {
            chevronOnFirst = chevron.parentElement === first.parentElement
          }
          return {
            hitsFirst: hits(line),
            hitsSecond: hits(secondBox),
            hitsDetail: hits(detailBox),
            secondPastPill: secondBox.right > pillBox.right,
            secondRight: secondBox.right,
            pillRight: pillBox.right,
            secondFromCard: contentRight - secondBox.right,
            chevronOnFirst,
            hasChevron: chevron !== undefined
          }
        })
        if (read == null) return undefined
        return read
      })
      expect(pill.hitsFirst).equals(true)
      expect(pill.hitsSecond).equals(false)
      expect(pill.hitsDetail).equals(false)
      // The second line runs to the card. On a phone the pill is that same
      // edge; on a desktop the chevron sits after the pill, so the line runs
      // past it.
      expect(pill.secondFromCard).lessThan(8)
      expect(pill.secondFromCard).greaterThan(-1)
      if (size.width < 600) {
        expect(pill.hasChevron).equals(false)
        expect(Math.abs(pill.secondRight - pill.pillRight)).lessThan(2)
      } else {
        expect(pill.chevronOnFirst).equals(true)
        expect(pill.secondPastPill).equals(true)
      }
      await page.close()
    })

    it(`Schedule row at ${size.width}×${size.height}`, async function () {
      const finalStart = '2026-10-04T23:45:00.000Z'
      const dated = scheduleDate(finalStart)
      listed = [
        {
          ...GAME,
          id: 'gam_final',
          startAt: finalStart,
          status: 'final',
          awayScore: 4,
          homeScore: 0,
          videoCount: 1,
          isLive: false
        },
        {
          ...GAME,
          id: 'gam_now',
          awayTeamName: 'Comets',
          homeTeamName: 'Hawks',
          startAt: '2026-10-04T20:00:00.000Z',
          status: 'inProgress',
          awayScore: 2,
          homeScore: 1,
          videoCount: 0,
          isLive: false
        },
        {
          ...GAME,
          id: 'gam_next',
          awayTeamName: 'Rivals',
          homeTeamName: 'Oaks',
          startAt: '2026-10-20T23:00:00.000Z',
          status: 'scheduled',
          awayScore: null,
          homeScore: null,
          videoCount: 0,
          isLive: true,
          venue: null
        }
      ]
      const page = await open('/schedule?when=all', size)
      const read = await until('the schedule rows', async () => {
        const rows = await page.evaluate(() => {
          const buttons = Array.from(
            document.querySelectorAll('[role="button"]')
          )
          const games = buttons.filter(function (node) {
            const label = node.getAttribute('aria-label')
            if (label === null) return false
            return label.includes(' @ ')
          })
          if (games.length < 3) return undefined
          return games.map(function (node) {
            const label = node.getAttribute('aria-label')
            const live = Array.from(node.querySelectorAll('*')).find(
              function (child) {
                return (
                  child.children.length === 0 && child.textContent === 'LIVE'
                )
              }
            )
            let badge: Element | null = null
            if (live !== undefined) badge = live.parentElement
            let spoken = ''
            if (label !== null) spoken = label
            let body = ''
            if (node.textContent !== null) body = node.textContent
            let liveColor = ''
            if (badge !== null) {
              liveColor = getComputedStyle(badge).backgroundColor
            }
            return {
              label: spoken,
              text: body,
              images: node.querySelectorAll('img').length,
              video: node.querySelector('[aria-label="Video"]') !== null,
              liveColor
            }
          })
        })
        return rows
      })
      for (const game of read) expect(game.images).equals(0)
      const final = read.find(game => game.label.includes('Badgers'))
      const now = read.find(game => game.label.includes('Comets'))
      const next = read.find(game => game.label.includes('Rivals'))
      if (final == null || now == null || next == null) {
        throw new Error('a schedule row is missing')
      }
      expect(final.text).includes(dated.month)
      expect(final.text).includes(dated.day)
      expect(final.text).includes(dated.time)
      expect(final.text).includes('4–0')
      expect(final.video).equals(true)
      expect(now.text).includes('LIVE')
      expect(now.text).not.includes('2–1')
      expect(now.liveColor).equals('rgb(210, 43, 43)')
      expect(next.text).not.includes('LIVE')
      expect(next.video).equals(false)
      const place = await page.evaluate(() => {
        const row = document.querySelector('[aria-label^="Badgers"]')
        if (row === null) return undefined
        const camera = row.querySelector('[aria-label="Video"]')
        if (camera === null) return undefined
        const rowBox = row.getBoundingClientRect()
        const cameraBox = camera.getBoundingClientRect()
        return {
          fromRight: rowBox.right - cameraBox.right,
          fromBottom: rowBox.bottom - cameraBox.bottom,
          belowMiddle: cameraBox.top > rowBox.top + rowBox.height / 2
        }
      })
      if (place == null) throw new Error('no camera')
      expect(place.fromRight).lessThan(16)
      expect(place.fromBottom).lessThan(16)
      expect(place.belowMiddle).equals(true)
      await page.close()
    })

    it(`Schedule filter at ${size.width}×${size.height}`, async function () {
      listed = [
        {
          ...GAME,
          id: 'gam_final',
          status: 'final',
          awayScore: 4,
          homeScore: 0,
          videoCount: 1,
          isLive: false
        },
        {
          ...GAME,
          id: 'gam_now',
          awayTeamName: 'Comets',
          homeTeamName: 'Hawks',
          status: 'inProgress',
          awayScore: 2,
          homeScore: 1,
          videoCount: 0,
          isLive: false
        },
        {
          ...GAME,
          id: 'gam_next',
          awayTeamName: 'Rivals',
          homeTeamName: 'Oaks',
          startAt: '2026-10-20T23:00:00.000Z',
          status: 'scheduled',
          awayScore: null,
          homeScore: null,
          videoCount: 0,
          isLive: false,
          venue: null
        }
      ]
      const page = await open('/schedule', size)
      const strip = await until(
        'the schedule filter',
        async () => await whenStrip(page)
      )
      expect(strip.selected).equals('Upcoming')
      expect(strip.upcoming).lessThan(strip.past)
      expect(strip.past).lessThan(strip.all)
      const upcomingRows = await until('the upcoming row', async () => {
        const labels = await rowLabels(page)
        if (!labels.some(label => label.includes('Rivals'))) return undefined
        return labels
      })
      expect(upcomingRows.some(label => label.includes('Badgers'))).equals(
        false
      )
      await pressLabel(page, 'Past')
      const pastRows = await until('the past rows', async () => {
        const labels = await rowLabels(page)
        if (!labels.some(label => label.includes('Badgers'))) return undefined
        if (labels.some(label => label.includes('Rivals'))) return undefined
        return labels
      })
      expect(pastRows.some(label => label.includes('Comets'))).equals(true)
      await page.close()

      const round = await open('/videos', size)
      await until('the videos list', async () => {
        const ready = await round.evaluate(() => {
          const text = document.body.textContent
          if (text === null) return false
          if (!text.includes('GAME VIDEOS')) return false
          return document.querySelector('[aria-label="Upcoming"]') === null
        })
        if (!ready) return undefined
        return true
      })
      await pressLabel(round, 'Schedule')
      await until('schedule upcoming', async () => {
        const read = await whenStrip(round)
        if (read == null) return undefined
        if (read.selected !== 'Upcoming') return undefined
        return read
      })
      await pressLabel(round, 'Past')
      await until('past selected', async () => {
        const read = await whenStrip(round)
        if (read == null) return undefined
        if (read.selected !== 'Past') return undefined
        return read
      })
      await pressLabel(round, 'Videos')
      const videosAddress = await until('videos address', async () => {
        const url = new URL(round.url())
        if (url.pathname !== '/videos') return undefined
        return url.pathname + url.search
      })
      expect(videosAddress).equals('/videos')
      await pressLabel(round, 'Schedule')
      const back = await until('schedule still past', async () => {
        const read = await whenStrip(round)
        if (read == null) return undefined
        if (read.selected !== 'Past') return undefined
        return read
      })
      expect(back.selected).equals('Past')
      await round.close()

      const season = await open('/seasons/sea_1', size)
      const seasonStrip = await until('the season filter', async () => {
        const read = await whenStrip(season)
        if (read == null) return undefined
        if (read.selected !== 'Past') return undefined
        return read
      })
      expect(seasonStrip.past).lessThan(seasonStrip.upcoming)
      await season.close()
    })

    it(`Box score at ${size.width}×${size.height}`, async function () {
      const page = await open('/games/gam_box?tab=boxScore', size)
      const text = await until('the box score', async () => {
        const body = await page.evaluate(() => document.body.textContent)
        if (body == null) return undefined
        if (!body.includes('Alex')) return undefined
        return body
      })
      expect(text).includes('Batting')
      expect(text).not.includes('Pitching')
      expect(text).not.includes('No individual lines')
      expect(text).includes('Owls')
      expect(text).includes('Hawks')
      await page.close()
    })

    it(`RTMP at ${size.width}×${size.height}`, async function () {
      const page = await open('/games/gam_rtmp', size)
      await page.evaluate(() => {
        const recorded: string[] = []
        const view = window as { __copied?: string[] }
        view.__copied = recorded
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            async writeText(text: string): Promise<void> {
              recorded.push(text)
            }
          }
        })
      })
      const before = await until('the stream address', async () => {
        const read = await page.evaluate(address => {
          const text = document.body.textContent
          if (text == null) return undefined
          if (!text.includes(address)) return undefined
          if (!text.includes('Tap to copy')) return undefined
          if (!text.includes('Sam')) return undefined
          if (!text.includes('Third base')) return undefined
          return { count: text.split('rtmp://').length - 1 }
        }, RTMP_URL)
        if (read == null) return undefined
        if (read.count !== 1) return undefined
        return read
      })
      expect(before.count).equals(1)
      await page.evaluate(() => {
        const found = document.querySelector(
          '[aria-label="Copy the URL for Dugout"]'
        )
        if (found instanceof HTMLElement) found.click()
      })
      const copied = await until('copied', async () => {
        const read = await page.evaluate(() => {
          const text = document.body.textContent
          const held = (window as { __copied?: string[] }).__copied
          if (text == null) return undefined
          if (held == null) return undefined
          if (!text.includes('Copied')) return undefined
          if (held.length === 0) return undefined
          return held[0]
        })
        return read
      })
      expect(copied).equals(RTMP_URL)
      await page.close()
    })
  }
})

interface WhenStrip {
  upcoming: number
  past: number
  all: number
  selected: string
}

async function whenStrip(page: Page): Promise<WhenStrip | undefined> {
  return await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'))
    const leftOf = function (label: string): number | undefined {
      const nodes = tabs.filter(function (item) {
        return item.getAttribute('aria-label') === label
      })
      for (const node of nodes) {
        const rect = node.getBoundingClientRect()
        if (rect.width > 0) return rect.left
      }
      return undefined
    }
    const upcoming = leftOf('Upcoming')
    const past = leftOf('Past')
    const all = leftOf('All')
    if (upcoming == null || past == null || all == null) return undefined
    let selected = ''
    for (const tab of tabs) {
      if (tab.getAttribute('aria-selected') !== 'true') continue
      const label = tab.getAttribute('aria-label')
      if (label === 'Upcoming' || label === 'Past' || label === 'All') {
        selected = label
        break
      }
    }
    if (selected === '') return undefined
    return { upcoming, past, all, selected }
  })
}

async function rowLabels(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[role="button"]'))
      .map(function (node) {
        const label = node.getAttribute('aria-label')
        if (label === null) return ''
        return label
      })
      .filter(function (label) {
        return label.includes(' @ ')
      })
  })
}

async function pressLabel(page: Page, label: string): Promise<void> {
  const clicked = await page.evaluate(name => {
    const found = Array.from(document.querySelectorAll('[role="tab"]')).find(
      function (node) {
        return node.getAttribute('aria-label') === name
      }
    )
    if (found instanceof HTMLElement) {
      found.click()
      return true
    }
    return false
  }, label)
  expect(clicked, label).equals(true)
}
