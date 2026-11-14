/* eslint-disable @typescript-eslint/prefer-optional-chain -- Puppeteer serializes browser callbacks without Sucrase helpers. */
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import puppeteer, { type Browser, type Page } from 'puppeteer'

import { TeamStationClient } from '../common/api'
import { findUserByEmail } from '../server/auth/emails'
import { createSession } from '../server/auth/sessions'
import { makeDatabase } from '../server/db/database'
import { serverConfig } from '../server/serverConfig'
import { recordBrowserCoverage } from './browserCoverage.e2e'
import { waitForCameraLimit } from './stream/webCameraLimit.e2e'

/**
 * Run on an isolated local API, ingest and web build from this checkout:
 * TS_E2E_WEB_URL=<web origin> npx mocha -r sucrase/register src/app/cameraName.e2e.ts
 * The API and ingest use serverConfig.json. The test seeds synthetic games and accounts.
 */
const web = process.env.TS_E2E_WEB_URL ?? 'http://127.0.0.1:8080'
const api = `http://127.0.0.1:${serverConfig.listenPort}/api/v1`
const artifacts = process.env.TS_E2E_ARTIFACT_DIR
const id = (name: string): string => `[data-testid="${name}"]`

async function open(
  browser: Browser,
  client: TeamStationClient,
  game: string,
  mobile = false
): Promise<Page> {
  const context = await browser.createBrowserContext()
  await context.setCookie({
    name: 'ts_session',
    value: client.token!,
    domain: new URL(web).hostname,
    path: '/'
  })
  const page = await context.newPage()
  if (process.env.TS_DIRECT_BROWSER_COVERAGE != null)
    await page.coverage.startJSCoverage({
      resetOnNavigation: false,
      includeRawScriptCoverage: true
    })
  await page.setViewport(
    mobile
      ? { width: 393, height: 852, isMobile: true, hasTouch: true }
      : { width: 1280, height: 900 }
  )
  await page.goto(`${web}/games/${game}?tab=watch`, {
    waitUntil: 'networkidle2'
  })
  return page
}
async function click(page: Page, name: string): Promise<void> {
  await page.locator(id(name)).click()
}
async function shot(page: Page, name: string): Promise<void> {
  if (artifacts == null) return
  // The modal exists before its entrance animation has put it on screen.
  await new Promise(resolve => setTimeout(resolve, 500))
  await page.screenshot({ path: join(artifacts, name + '.png') })
}
async function setup(page: Page, mobile = false): Promise<string> {
  await click(page, 'record-video')
  expect(await page.$(id('record-with-phone'))).equals(null)
  expect(
    await page.$eval(id('use-external-camera'), el =>
      el.getAttribute('aria-disabled')
    )
  ).equals('true')
  await click(page, 'angle-suggestion-Backstop')
  if (!mobile) await shot(page, 'setup')
  await click(page, 'use-external-camera')
  await page.waitForSelector(id('camera-source-sheet'))
  if (!mobile) await shot(page, 'sources')
  await click(page, 'camera-source-rtmp')
  const field = await page.waitForSelector(id('rtmp-url'))
  const url = await field!.evaluate(el => el.textContent!)
  await click(page, 'rtmp-copy')
  await page.waitForSelector(id('rtmp-copied'))
  if (!mobile && artifacts != null) {
    await field!.evaluate(el => {
      el.textContent = 'rtmp://example.test/live/••••••••'
    })
    await shot(page, 'rtmp')
  }
  await click(page, 'rtmp-done')
  return url
}

describe('web camera management on Videos', function () {
  this.timeout(300000)
  let browser: Browser
  let owner: TeamStationClient
  let second: TeamStationClient
  let viewer: TeamStationClient
  let games: string[]
  const pages: Page[] = []
  before(async function () {
    for (const origin of [web, api, serverConfig.databaseUrl]) {
      if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
        throw new Error('Camera fixtures require a local server and database')
    }
    const stamp = randomBytes(8).toString('hex')
    const password = randomBytes(24).toString('hex')
    const emails = ['owner', 'second', 'member'].map(
      role => `camera-${role}-${stamp}@example.test`
    )
    const seed = (script: string, ...args: string[]): string =>
      execFileSync('npm', ['run', '--silent', script, '--', ...args], {
        encoding: 'utf8'
      })
    seed('seed', emails[0], password)
    seed('seed', emails[1], password)
    games = [
      ...seed('scoring-game', emails[2], password, '--games', '3').matchAll(
        /^GAME_ID=(.+)$/gm
      )
    ].map(match => match[1])
    const clients: TeamStationClient[] = []
    const db = makeDatabase(serverConfig.databaseUrl)
    try {
      for (const email of emails) {
        const user = await findUserByEmail(db, email)
        if (user == null) throw new Error('Missing seeded camera operator')
        const session = await createSession(
          db,
          user.id,
          'camera browser fixture'
        )
        clients.push(
          new TeamStationClient({ baseUrl: api, token: session.token })
        )
      }
    } finally {
      await db.destroy()
    }
    ;[owner, second, viewer] = clients
    browser = await puppeteer.launch({
      headless: true,
      args: ['--window-size=1440,1060']
    })
  })
  after(async function () {
    try {
      if (process.env.TS_DIRECT_BROWSER_COVERAGE != null && pages.length > 0)
        await recordBrowserCoverage(
          pages,
          web,
          process.env.TS_DIRECT_BROWSER_COVERAGE
        )
    } finally {
      await browser?.close()
    }
  })
  it('shows a member Request access and records the request', async function () {
    const page = await open(browser, viewer, games[0])
    pages.push(page)
    await page.waitForSelector(id('request-access'))
    await shot(page, 'member-after')
    await click(page, 'request-access')
    await page.waitForFunction(() =>
      document.body.innerText.includes('Request sent')
    )
    expect((await viewer.streamAccess(games[0])).requested).equals(true)
  })
  it('sets up, publishes, ends and deletes an external camera', async function () {
    const game = games[0]
    const page = await open(browser, owner, game)
    pages.push(page)
    await page.waitForSelector(id('record-video'))
    await shot(page, 'videos-after')
    const first = await setup(page)
    const camera = (await owner.liveStreams(game)).mine.find(
      row => row.label === 'Backstop'
    )!
    await page.waitForSelector(id('angle-row-' + camera.id))
    await shot(page, 'camera-after')
    await click(page, 'angle-more-' + camera.id)
    await click(page, 'stream-action-rotate')
    await page.waitForSelector(id('stream-action-rotate'), { hidden: true })
    await click(page, 'angle-row-' + camera.id)
    const field = await page.waitForSelector(id('rtmp-url'))
    const url = await field!.evaluate(el => el.textContent!)
    expect(url !== first, 'rotation changed the address').equals(true)
    await click(page, 'rtmp-done')
    const recording =
      artifacts == null
        ? undefined
        : await page.record({
            maxWidth: 1280,
            maxHeight: 900,
            path: `${artifacts}/camera-lifecycle.mp4`
          })
    const pattern = spawn(
      process.execPath,
      [
        'tools/streamTestPattern.js',
        '--url',
        url,
        '--codec',
        'hevc',
        '--size',
        '640x360',
        '--duration',
        '100'
      ],
      { stdio: 'ignore' }
    )
    try {
      const state = id('angle-state-' + camera.id)
      await page.waitForFunction(
        (s: string) =>
          document.querySelector(s) != null &&
          document.querySelector(s)!.textContent === 'Live',
        { timeout: 30000 },
        state
      )
      await page.$eval(state, el => {
        el.scrollIntoView({ block: 'center' })
      })
      const duration = id('angle-duration-' + camera.id)
      await page.waitForFunction(
        (selector: string) => {
          const clock = document.querySelector(selector)
          return clock != null && clock.textContent !== '0:00'
        },
        { timeout: 75000 },
        duration
      )
      await shot(page, 'live')
      await shot(page, 'broadcast-after')
      await click(page, 'angle-more-' + camera.id)
      await click(page, 'stream-action-end')
      await click(page, 'stream-action-end')
      await page.waitForFunction(
        (s: string) =>
          document.querySelector(s) != null &&
          document.querySelector(s)!.textContent === 'Ended',
        { timeout: 30000 },
        state
      )
      await shot(page, 'ended-after')
      await click(page, 'angle-row-' + camera.id)
      await page.waitForSelector(id('video-details-sheet'))
      expect(await page.$(id('video-details-upload'))).equals(null)
      expect(await page.$(id('video-details-delete-copy'))).equals(null)
      await shot(page, 'details')
      await click(page, 'video-details-delete')
      await click(page, 'delete-video-confirm')
      await page.waitForSelector(id('angle-row-' + camera.id), { hidden: true })
      expect(
        (await owner.liveStreams(game)).mine.some(row => row.id === camera.id)
      ).equals(false)
    } finally {
      pattern.kill()
      await recording?.stop()
    }
  })
  it('names an external camera and revokes it on a touch viewport', async function () {
    const page = await open(browser, owner, games[1], true)
    pages.push(page)
    await setup(page, true)
    const camera = (await owner.liveStreams(games[1])).mine[0]
    expect(camera.label).equals('Backstop')
    await click(page, 'angle-row-' + camera.id)
    await click(page, 'rtmp-revoke')
    await click(page, 'revoke-confirm')
    await page.waitForSelector(id('angle-row-' + camera.id), { hidden: true })
  })
  it('follows each maker’s HTTPS link from a mobile browser', async function () {
    const page = await open(browser, owner, games[1], true)
    pages.push(page)
    const makers = {
      gopro: 'gopro.com',
      mevo: 'app.mevo.com',
      mevoStudio: 'multicam.mevo.com'
    }
    await page.setRequestInterception(true)
    page.on('request', request => {
      const host = new URL(request.url()).hostname
      if (Object.values(makers).includes(host))
        request
          .respond({ status: 200, body: 'Camera maker' })
          .catch(() => undefined)
      else request.continue().catch(() => undefined)
    })
    for (const [source, host] of Object.entries(makers)) {
      await click(page, 'record-video')
      await click(page, 'angle-suggestion-Backstop')
      await click(page, 'use-external-camera')
      await Promise.all([
        page.waitForNavigation(),
        click(page, 'camera-source-' + source)
      ])
      expect(new URL(page.url()).origin).equals('https://' + host)
      const camera = (await owner.liveStreams(games[1])).mine.find(
        row => row.source === source
      )!
      expect(camera.label).equals('Backstop')
      await owner.removeLiveStream(games[1], camera.id)
      await page.goto(`${web}/games/${games[1]}?tab=watch`, {
        waitUntil: 'networkidle2'
      })
    }
  })
  it('E11 reads the server game limit and frees a slot after End', async function () {
    const game = games[2]
    const { maxGameCameras, mine, others } = await owner.liveStreams(game)
    expect(maxGameCameras).to.be.a('number')
    expect([...mine, ...others], 'an empty game').deep.equals([])
    // Both people add cameras in turn up to the game's limit.
    for (let n = 0; n < maxGameCameras!; n++) {
      const client = n % 2 === 0 ? owner : second
      await client.addLiveStream(
        game,
        `${client === owner ? 'Home' : 'Third'} ${Math.floor(n / 2)}`,
        { source: 'rtmp' }
      )
    }
    const listed = await owner.liveStreams(game)
    expect(listed.gameCanAdd).equals(0)
    expect(listed.others, 'cameras of more than one person').not.deep.equals([])
    const page = await open(browser, owner, game)
    pages.push(page)
    await waitForCameraLimit(page, maxGameCameras)
    await shot(page, 'full-after')
    const camera = (await owner.liveStreams(game)).mine[0]
    await owner.endLiveStream(game, camera.id)
    await waitForCameraLimit(page, undefined)
    await click(page, 'record-video')
    await page.waitForSelector(id('angle-name-prompt'))
  })
})
