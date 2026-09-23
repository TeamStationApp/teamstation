import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import puppeteer, { type Browser, type Page } from 'puppeteer'

import { asGameDetail } from '../../common/api'

const game = asGameDetail({
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
  videos: []
})
const base = process.env.GS_SCORING_TEST_URL ?? 'http://127.0.0.1:8080'
let browser: Browser
async function open(
  path: string,
  scored = false,
  failed = false
): Promise<{ page: Page; unexpected: string[] }> {
  const page = await browser.newPage()
  const unexpected: string[] = []
  page.on('pageerror', error => {
    console.error('Browser error:', error)
  })
  page.setDefaultTimeout(8000)
  await page.setViewport({ width: 1200, height: 900 })
  await page.setRequestInterception(true)
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) {
      request.continue().catch(() => undefined)
      return
    }
    let body: unknown
    let status = 200
    if (request.method() !== 'GET')
      unexpected.push(`${request.method()} ${url.pathname}`)
    if (url.pathname === '/api/v1/auth/me')
      body = { id: 'scorer', displayName: 'Scorer', isAdmin: false }
    else if (url.pathname === '/api/v1/games/g1') {
      body = scored ? { ...game, awayScore: 0, homeScore: 0 } : game
      if (failed) {
        status = 404
        body = { error: 'Not found' }
      }
    } else if (url.pathname === '/api/v1/teams') body = []
    else if (url.pathname.endsWith('/live-streams')) body = { streams: [] }
    else {
      unexpected.push(url.pathname)
      status = 500
      body = {}
    }
    request
      .respond({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body)
      })
      .catch(() => undefined)
  })
  await page.goto(`${base}${path}`)
  return { page, unexpected }
}
async function click(page: Page, label: string): Promise<void> {
  const selector = `[aria-label="${label}"]`
  await page.waitForSelector(selector)
  await page.click(selector)
}
describe('scoring browser', function () {
  this.timeout(60000)
  before(async function () {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.GS_CHROME_PATH,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader'
      ]
    })
  })
  after(async function () {
    await browser?.close()
  })
  it('opens an unscored game full screen and protects dirty browser Back', async function () {
    const { page, unexpected } = await open('/games/g1')
    try {
      await click(page, 'Score Game')
      await page.waitForFunction(() => location.pathname === '/games/g1/score')
      await page.waitForSelector('canvas')
      expect(await page.$('[aria-label="Schedule"]')).equals(null)
      await click(page, 'Ball')
      await page.waitForSelector('[aria-label="Undo Ball"]')
      const length = await page.evaluate(() => history.length)
      const dismissed = new Promise<void>(resolve => {
        page.once('dialog', dialog => {
          dialog
            .dismiss()
            .then(() => {
              resolve()
            })
            .catch(() => undefined)
        })
      })
      await page.evaluate(() => {
        history.back()
      })
      await dismissed
      await page.waitForFunction(() => location.pathname === '/games/g1/score')
      expect(await page.evaluate(() => history.length)).equals(length)
      page.once('dialog', dialog => {
        dialog.accept().catch(() => undefined)
      })
      await page.evaluate(() => {
        history.back()
      })
      await page.waitForSelector('[aria-label="Score Game"]')
      expect(new URL(page.url()).pathname).equals('/games/g1')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('excludes recorded zero scores and resolves direct scoring links', async function () {
    const scored = await open('/games/g1', true)
    try {
      await scored.page.waitForSelector('[aria-label="Box score"]')
      expect(await scored.page.$('[aria-label="Score Game"]')).equals(null)
      expect(scored.unexpected).deep.equals([])
    } finally {
      await scored.page.close()
    }
    const direct = await open('/games/g1/score')
    try {
      await click(direct.page, 'Open field menu')
      await click(direct.page, 'Exit field')
      await direct.page.waitForSelector('[aria-label="Score Game"]')
      expect(new URL(direct.page.url()).pathname).equals('/games/g1')
      expect(direct.unexpected).deep.equals([])
    } finally {
      await direct.page.close()
    }
  })
  it('allows exit when the game cannot be read', async function () {
    const { page, unexpected } = await open('/games/g1/score', false, true)
    try {
      await page.waitForFunction(() =>
        String(document.body.textContent).includes('Game not found.')
      )
      await click(page, 'Exit Current Game')
      await page.waitForFunction(() => location.pathname === '/games/g1')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
})
