import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import puppeteer, { type Browser, type Page } from 'puppeteer'
import { PerspectiveCamera, Vector3 } from 'three'

import { asGameDetail } from '../../common/api'
import { applyFieldCamera } from '../field/cameraModel'

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
    else if (url.pathname.endsWith('/roster'))
      body = url.pathname.includes('/away/')
        ? [
            {
              userId: 'usr_jordan',
              shortName: 'Jordan K.',
              jersey: '00',
              positions: ['P'],
              isPlayer: true,
              role: 'member',
              bats: 'switch',
              throws: 'right'
            }
          ]
        : []
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
  await page.locator(selector).click()
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
      await page.evaluate(() => {
        history.back()
      })
      await click(page, 'Cancel')
      await page.waitForFunction(() => location.pathname === '/games/g1/score')
      expect(await page.evaluate(() => history.length)).equals(length)
      await page.evaluate(() => {
        history.back()
      })
      await click(page, 'Discard and Exit')
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
      await click(direct.page, 'Open scoring menu')
      await click(direct.page, 'Exit Current Game')
      await direct.page.waitForSelector('[aria-label="Score Game"]')
      expect(new URL(direct.page.url()).pathname).equals('/games/g1')
      expect(direct.unexpected).deep.equals([])
    } finally {
      await direct.page.close()
    }
  })
  it('shows real identities, switches the hitter before a pitch, and repeatedly undoes pitches', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await page.waitForSelector(
        '[aria-label*="Batter Jordan K. right handed"]'
      )
      await page.waitForSelector('[aria-label="OK"]')
      await page.waitForSelector('canvas[data-field-ready="true"]')
      const box = await page.$eval('canvas', canvas => {
        const rect = canvas.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })
      const camera = new PerspectiveCamera(
        43,
        box.width / box.height,
        0.1,
        1000
      )
      applyFieldCamera(camera, {
        width: box.width,
        height: box.height,
        view: 'home',
        zoom: 1.25,
        tilt: (-11 * Math.PI) / 180,
        heightOffset: 33
      })
      camera.updateMatrixWorld()
      const project = (x: number, y: number, z: number): [number, number] => {
        const point = new Vector3(x, y, z).project(camera)
        return [
          box.x + ((point.x + 1) * box.width) / 2,
          box.y + ((1 - point.y) * box.height) / 2
        ]
      }
      const start = project(-4, 6, 0)
      const end = project(7, 6, 0)
      await page.mouse.move(...start)
      await page.mouse.down()
      await page.mouse.move(...end, { steps: 12 })
      await page.mouse.up()
      if (process.env.GS_SCORING_ARTIFACT_DIR != null)
        await page.screenshot({
          path: `${process.env.GS_SCORING_ARTIFACT_DIR}/field.png`
        })
      await page.waitForSelector('[aria-label*="Batter Jordan K. left handed"]')
      expect(await page.$('[aria-label="OK"]')).equals(null)
      await click(page, 'Ball')
      await click(page, 'Called Strike')
      await click(page, 'Foul Ball')
      await page.waitForSelector(
        '[aria-label*="1 balls 2 strikes 0 outs · Pitches 3"]'
      )
      await page.mouse.move(...end)
      await page.mouse.down()
      await page.mouse.move(...start, { steps: 12 })
      await page.mouse.up()
      expect(
        await page.$('[aria-label*="Batter Jordan K. left handed"]')
      ).not.equals(null)
      await click(page, 'Undo Foul Ball')
      await click(page, 'Undo Called Strike')
      await click(page, 'Undo Ball')
      await page.waitForSelector(
        '[aria-label*="0 balls 0 strikes 0 outs · Pitches 0"]'
      )
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('edits rosters with a captured drag, validates overrides, and uses slide-up settings', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Remove Player 2')
      const source = '[data-roster-target="roster"] [data-roster-player="2"]'
      const target = '[data-roster-target="lineup-0"]'
      await page.$eval(source, node => {
        node.scrollIntoView({ block: 'center' })
      })
      const from = await page.$eval(source, node => {
        const rect = node.getBoundingClientRect()
        return { x: rect.x + 20, y: rect.y + 15 }
      })
      const to = await page.$eval(target, node => {
        const rect = node.getBoundingClientRect()
        return { x: rect.x + 20, y: rect.y + 15 }
      })
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 12 })
      await page.mouse.up()
      await page.waitForFunction(() =>
        document
          .querySelector('[data-roster-target="lineup-0"]')!
          .textContent!.includes('Player 2')
      )
      await click(page, 'Save Rosters')
      await page.waitForSelector('[aria-label="Undo Set team roster"]')
      await click(page, 'Open scoring menu')
      await click(page, 'Overrides')
      await page.locator('[aria-label="balls"]').fill('4')
      expect(
        await page.$eval('[aria-label="Apply Override"]', node =>
          node.getAttribute('aria-disabled')
        )
      ).equals('true')
      await page.locator('[aria-label="balls"]').fill('2')
      await click(page, 'Apply Override')
      await page.waitForSelector('[aria-label*="2 balls 0 strikes"]')
      await click(page, 'Open scoring menu')
      await click(page, 'Settings')
      await click(page, 'Toggle switch-hitter help')
      await click(page, 'Reset shown count')
      await click(page, 'Cancel')
      await click(page, 'Undo Override game state')
      await click(page, 'Undo Set team roster')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('assigns a defender with a touch drag on a phone-sized sheet', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await page.setViewport({
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true
      })
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Set Defense')
      await click(page, 'Clear P')
      const source = '[data-roster-target="roster"] [data-roster-player="1"]'
      const target = '[data-roster-target="defense-P"]'
      const from = await page.$eval(source, node => {
        const rect = node.getBoundingClientRect()
        return { x: rect.x + 20, y: rect.y + 15 }
      })
      const to = await page.$eval(target, node => {
        const rect = node.getBoundingClientRect()
        return { x: rect.x + 20, y: rect.y + 15 }
      })
      await page.touchscreen.touchStart(from.x, from.y)
      await page.touchscreen.touchMove(to.x, to.y)
      await page.touchscreen.touchEnd()
      await page.waitForFunction(() =>
        document
          .querySelector('[data-roster-target="defense-P"]')!
          .textContent!.includes('Jordan K.')
      )
      if (process.env.GS_SCORING_ARTIFACT_DIR != null)
        await page.screenshot({
          path: `${process.env.GS_SCORING_ARTIFACT_DIR}/rosters-phone.png`
        })
      await click(page, 'Save Rosters')
      await page.waitForSelector('[aria-label="Undo Set team roster"]')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('opens the out submenu under one drag and returns to the right without a Back button', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      const center = async (label: string): Promise<{ x: number; y: number }> =>
        await page.$eval(`[aria-label="${label}"]`, node => {
          const r = node.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        })
      await page.waitForSelector('[aria-label="Ball in Play"]')
      const button = await center('Ball in Play')
      await page.mouse.move(button.x, button.y)
      await page.mouse.down()
      await page.mouse.move(button.x, button.y - 20, { steps: 3 })
      await page.waitForSelector('[aria-label="Batter Out"]')
      const parent = await center('Batter Out')
      await page.mouse.move(parent.x, parent.y, { steps: 3 })
      await page.waitForSelector('[aria-label="Throw Out"]')
      const right = await center('Single')
      await page.mouse.move(right.x, right.y, { steps: 3 })
      await page.waitForSelector('[aria-label="Throw Out"]', { hidden: true })
      await page.mouse.move(parent.x, parent.y, { steps: 3 })
      await page.waitForSelector('[aria-label="Ball Caught"]')
      const leaf = await center('Ball Caught')
      await page.mouse.move(leaf.x, leaf.y, { steps: 8 })
      await page.mouse.up()
      await page.waitForSelector('[aria-label^="Drag fielder to location"]')
      expect(await page.$('[aria-label="Back"]')).equals(null)
      await page.waitForSelector('canvas[data-field-ready="true"]')
      const field = '[role="application"]'
      await page.focus(field)
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Enter')
      await page.waitForSelector(
        '[aria-label^="Drag up and down for ball trajectory."]'
      )
      for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowDown')
      await page.waitForSelector('[aria-label*="10° Line Drive"]')
      await page.keyboard.press('Enter')
      await page.waitForSelector('[aria-label="Undo 10° Line Drive"]')
      await click(page, 'Undo 10° Line Drive')
      await page.waitForSelector(
        '[aria-label^="Drag up and down for ball trajectory."]'
      )
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('places a fielder on the rendered field and cancels then accepts a trajectory drag', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await click(page, 'Ball in Play')
      await click(page, 'Single')
      await page.waitForSelector('canvas[data-field-ready="true"]')
      const box = await page.$eval('canvas', canvas => {
        const r = canvas.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      })
      const camera = new PerspectiveCamera(43, box.width / box.height, 2, 1100)
      applyFieldCamera(camera, {
        width: box.width,
        height: box.height,
        view: 'home',
        zoom: 1.25,
        tilt: (-11 * Math.PI) / 180,
        heightOffset: 33
      })
      const point = (x: number, z: number): [number, number] => {
        const p = new Vector3(x, 6, z).project(camera)
        return [
          box.x + ((p.x + 1) * box.width) / 2,
          box.y + ((1 - p.y) * box.height) / 2
        ]
      }
      await page.mouse.move(...point(0, -18.44))
      await page.mouse.down()
      await page.mouse.move(...point(12, -40), { steps: 12 })
      await page.mouse.up()
      await page.waitForSelector(
        '[aria-label^="Drag up and down for ball trajectory."]'
      )
      if (process.env.GS_SCORING_ARTIFACT_DIR != null)
        await page.screenshot({
          path: `${process.env.GS_SCORING_ARTIFACT_DIR}/fielder-trajectory.png`
        })
      await page.mouse.move(500, 500)
      await page.mouse.down()
      await page.mouse.move(500, 620, { steps: 12 })
      await page.$eval('[role="application"]', node =>
        node.dispatchEvent(
          new PointerEvent('pointercancel', {
            bubbles: true,
            pointerId: 1,
            pointerType: 'mouse',
            clientX: 500,
            clientY: 620
          })
        )
      )
      await page.mouse.up()
      await page.waitForSelector('[aria-label*="45° Fly Ball"]')
      await page.mouse.move(500, 500)
      await page.mouse.down()
      await page.mouse.move(500, 620, { steps: 12 })
      await page.mouse.up()
      await page.waitForSelector('[aria-label="Undo -15° Ground Ball"]')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
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
