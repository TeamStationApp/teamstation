import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import puppeteer, {
  type Browser,
  type BrowserContext,
  type Page
} from 'puppeteer'

/**
 * Home's five-row window, against the web app on :8080 with the API
 * intercepted. Chrome is `TS_CHROME_PATH` when that is set. Screenshots go
 * to `TS_HOME_LIST_ARTIFACTS` when that is set.
 *
 *   node_modules/.bin/mocha -r sucrase/register --extension ts --timeout 180000 \
 *     src/app/screens/homeListOrder.e2e.ts
 */
const WEB = 'http://127.0.0.1:8080'

const TEAM_NAMES = [
  'North',
  'East',
  'South',
  'West',
  'Harbor',
  'Island',
  'Valley'
]
const SEASON_NAMES = [
  'Spring One',
  'Spring Two',
  'Spring Three',
  'Spring Four',
  'Spring Five',
  'Spring Six'
]
const LEAGUE_NAMES = [
  'League One',
  'League Two',
  'League Three',
  'League Four',
  'League Five',
  'League Six'
]

function memberTeam(name: string, index: number): Record<string, unknown> {
  return {
    id: `tem_${index}`,
    name,
    shortName: null,
    logoPath: null,
    logoUrl: null,
    record: null,
    direct: index < 4,
    source: 'member'
  }
}

function memberSeason(name: string, index: number): Record<string, unknown> {
  return {
    id: `sea_${index}`,
    leagueId: null,
    name,
    year: 2026,
    term: null,
    ageGroup: null,
    teams: 1,
    games: 0,
    videos: 0,
    logoUrl: null,
    direct: true,
    source: 'member'
  }
}

function memberLeague(name: string, index: number): Record<string, unknown> {
  return {
    id: `lea_${index}`,
    kind: 'league',
    name,
    imageUrl: null,
    locality: null,
    direct: true,
    source: 'member'
  }
}

const fullHome = {
  teams: TEAM_NAMES.map(memberTeam),
  seasons: SEASON_NAMES.map(memberSeason),
  leagues: LEAGUE_NAMES.map(memberLeague)
}
const fiveHome = {
  teams: TEAM_NAMES.slice(0, 5).map(memberTeam),
  seasons: [],
  leagues: []
}

let home = fullHome
let browser: Browser | undefined

function cors(
  origin: string,
  body: unknown
): {
  status: number
  contentType: string
  headers: Record<string, string>
  body: string
} {
  return {
    status: 200,
    contentType: 'application/json',
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'x-teamstation-revision': '1'
    },
    body: JSON.stringify(body)
  }
}

async function open(): Promise<{ context: BrowserContext; page: Page }> {
  if (browser == null) throw new Error('no browser')
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  await page.setViewport({ width: 1440, height: 900 })
  await page.setRequestInterception(true)
  page.on('request', request => {
    const url = new URL(request.url())
    const origin = request.headers().origin ?? WEB
    if (request.method() === 'OPTIONS') {
      request
        .respond({
          status: 204,
          headers: {
            'access-control-allow-origin': origin,
            'access-control-allow-credentials': 'true',
            'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
            'access-control-allow-headers':
              request.headers()['access-control-request-headers'] ??
              'content-type'
          }
        })
        .catch(() => undefined)
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      request.continue().catch(() => undefined)
      return
    }
    if (request.method() !== 'GET') {
      request.respond(cors(origin, {})).catch(() => undefined)
      return
    }
    const path = url.pathname
    if (path === '/api/v1/auth/me') {
      request
        .respond(
          cors(origin, {
            id: 'usr_1111111111111111111118',
            displayName: 'Alex Lee',
            email: 'alex@example.com',
            isAdmin: false
          })
        )
        .catch(() => undefined)
      return
    }
    if (path === '/api/v1/me/home') {
      request.respond(cors(origin, home)).catch(() => undefined)
      return
    }
    if (path === '/api/v1/me/roles') {
      request
        .respond(cors(origin, { teams: {}, guardianOf: [] }))
        .catch(() => undefined)
      return
    }
    request.respond(cors(origin, [])).catch(() => undefined)
  })
  await page.goto(WEB, { waitUntil: 'domcontentloaded' })
  return { context, page }
}

async function textOf(page: Page): Promise<string> {
  const text = await page.evaluate(() => document.body.textContent)
  return text ?? ''
}

async function waitForText(page: Page, needle: string): Promise<void> {
  try {
    await page.waitForFunction(
      text => {
        const body = document.body.textContent
        // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- Sucrase would compile `?.` to a helper the browser does not have.
        return body != null && body.includes(text)
      },
      {},
      needle
    )
  } catch (error) {
    const body = await page.evaluate(() => {
      const text = document.body.innerText
      return text == null ? '' : text.slice(0, 1500)
    })
    throw new Error(`${needle} did not appear\n${body}`, { cause: error })
  }
}

function showsInOrder(text: string, names: string[]): void {
  let at = -1
  for (const name of names) {
    const next = text.indexOf(name, at + 1)
    expect(next, name).greaterThan(at)
    at = next
  }
}

async function press(page: Page, label: string): Promise<void> {
  const handle = await page.waitForSelector(`[aria-label="${label}"]`)
  await handle!.evaluate(node => {
    node.scrollIntoView({ block: 'center' })
  })
  await handle!.click()
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.TS_HOME_LIST_ARTIFACTS
  if (dir == null || dir === '') return
  await mkdir(dir, { recursive: true })
  await page.screenshot({ path: join(dir, name) })
}

describe('the home list window', function () {
  before(async function () {
    const chrome = process.env.TS_CHROME_PATH
    browser = await puppeteer.launch({
      headless: true,
      ...(chrome != null && chrome !== '' ? { executablePath: chrome } : {}),
      args: ['--use-gl=angle', '--use-angle=swiftshader']
    })
  })
  after(async function () {
    await browser?.close()
  })

  it('shows five rows, More and Less, and keeps an open section across a reload', async function () {
    home = fullHome
    const { context, page } = await open()
    try {
      await waitForText(page, 'Harbor')
      let text = await textOf(page)
      showsInOrder(text, TEAM_NAMES.slice(0, 5))
      expect(text).not.includes('Island')
      expect(text).not.includes('Valley')
      expect(await page.$('[aria-label="More teams"]')).not.equals(null)
      expect(await page.$('[aria-label="Less teams"]')).equals(null)
      await shot(page, 'home-teams-after.png')

      await press(page, 'More teams')
      await waitForText(page, 'Valley')
      text = await textOf(page)
      showsInOrder(text, TEAM_NAMES)
      expect(await page.$('[aria-label="Less teams"]')).not.equals(null)
      await page.evaluate(() => {
        const node = document.querySelector('[aria-label="Less teams"]')
        if (node != null) node.scrollIntoView({ block: 'end' })
      })
      await shot(page, 'home-teams-expanded-after.png')

      await press(page, 'Less teams')
      await page.waitForFunction(
        text => {
          const body = document.body.textContent
          // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- Sucrase would compile `?.` to a helper the browser does not have.
          return body == null || !body.includes(text)
        },
        {},
        'Valley'
      )
      text = await textOf(page)
      showsInOrder(text, TEAM_NAMES.slice(0, 5))
      expect(text).not.includes('Valley')

      await press(page, 'More teams')
      await page.waitForFunction(() => {
        const raw = window.localStorage.getItem('home.listExpanded')
        return raw != null && JSON.parse(raw).teams === true
      })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForText(page, 'Valley')
      expect(await page.$('[aria-label="Less teams"]')).not.equals(null)
      console.log('reload keeps the expanded team list')

      text = await textOf(page)
      showsInOrder(text, SEASON_NAMES.slice(0, 5))
      expect(text).not.includes('Spring Six')
      await page.evaluate(() => {
        const nodes = document.querySelectorAll('*')
        // eslint-disable-next-line @typescript-eslint/prefer-for-of -- Sucrase would compile for-of to a helper the browser does not have.
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i]
          if (node.childNodes.length === 1 && node.textContent === 'SEASONS') {
            node.scrollIntoView({ block: 'start' })
            return
          }
        }
      })
      await shot(page, 'home-seasons-after.png')

      await press(page, 'More seasons')
      await waitForText(page, 'Spring Six')
      text = await textOf(page)
      expect(text).includes('Valley')
      expect(await page.$('[aria-label="Less teams"]')).not.equals(null)
      showsInOrder(text, SEASON_NAMES)

      showsInOrder(text, LEAGUE_NAMES.slice(0, 5))
      expect(text).not.includes('League Six')
      await page.evaluate(() => {
        const nodes = document.querySelectorAll('*')
        // eslint-disable-next-line @typescript-eslint/prefer-for-of -- Sucrase would compile for-of to a helper the browser does not have.
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i]
          if (
            node.childNodes.length === 1 &&
            node.textContent === 'YOUR LEAGUES'
          ) {
            node.scrollIntoView({ block: 'start' })
            return
          }
        }
      })
      await shot(page, 'home-leagues-after.png')
      await press(page, 'More leagues')
      await waitForText(page, 'League Six')
    } finally {
      await context.close()
    }
  })

  it('shows five teams and no More when the list is not longer', async function () {
    home = fiveHome
    const { context, page } = await open()
    try {
      await waitForText(page, 'Harbor')
      const text = await textOf(page)
      showsInOrder(text, TEAM_NAMES.slice(0, 5))
      expect(text).not.includes('Island')
      expect(await page.$('[aria-label="More teams"]')).equals(null)
      console.log('five teams show no More')
    } finally {
      await context.close()
    }
  })
})
