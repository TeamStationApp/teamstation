import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import puppeteer, { type Browser, type Page } from 'puppeteer'

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
  awayTeamName: 'Bandits',
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
      request
        .respond({
          status: 204,
          headers: {
            'access-control-allow-origin': WEB,
            'access-control-allow-credentials': 'true',
            'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
            'access-control-allow-headers': '*'
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
    const row = document.querySelector('[aria-label^="Bandits"]')
    if (row === null) return undefined
    const img = row.querySelector('img')
    if (img === null) return undefined
    if (img.parentElement === null) return undefined
    const frame = img.parentElement.parentElement
    if (frame === null) return undefined
    const name = Array.from(row.querySelectorAll('*')).find(function (node) {
      return node.children.length === 0 && node.textContent === 'Bandits'
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
          awayTeamName: 'Pueyers',
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
            if (img == null || img.parentElement == null) return undefined
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
          const plain = read('Pueyers')
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
          const row = document.querySelector('[aria-label^="Bandits"]')
          if (row === null) return undefined
          const textOf = function (value: string): Element | undefined {
            const found = Array.from(row.querySelectorAll('*')).find(
              function (node) {
                return node.children.length === 0 && node.textContent === value
              }
            )
            return found
          }
          const first = textOf('Bandits')
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
      const final = read.find(game => game.label.includes('Bandits'))
      const now = read.find(game => game.label.includes('Comets'))
      const next = read.find(game => game.label.includes('Rivals'))
      if (final == null || now == null || next == null) {
        throw new Error('a schedule row is missing')
      }
      expect(final.text).includes(dated.month)
      expect(final.text).includes(dated.day)
      expect(final.text).includes(dated.when)
      expect(final.text).includes('4–0')
      expect(final.video).equals(true)
      expect(now.text).includes('LIVE')
      expect(now.text).not.includes('2–1')
      expect(now.liveColor).equals('rgb(210, 43, 43)')
      expect(next.text).not.includes('LIVE')
      expect(next.video).equals(false)
      const place = await page.evaluate(() => {
        const row = document.querySelector('[aria-label^="Bandits"]')
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
  }
})
