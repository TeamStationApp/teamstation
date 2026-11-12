/* eslint-disable @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- Serialized browser callbacks cannot capture Sucrase's generated helper functions. */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import puppeteer, { type Browser, type Page } from 'puppeteer'

import { type TessFixture, tessFixture } from '../test/tessFixture'
import { recordBrowserCoverage } from './browserCoverage.e2e'

/**
 * The header's two menus in a real browser, against the Tess fixture, at a
 * phone's width and a desktop's.
 *
 *   npm run build.web
 *   TS_ARTIFACTS_DIR=<dir> [TS_DIRECT_BROWSER_COVERAGE=<json>] \
 *     node -r sucrase/register src/app/headerMenus.e2e.ts
 *
 * `TS_HEADER_BEFORE=1` only takes the header's screenshots and opens About
 * from the mark, for the build this work started from.
 */

const PHONE = { width: 390, height: 844 }
// The legacy header menu remains below the 1216px sidebar boundary.
const DESKTOP = { width: 1200, height: 900 }
const ZONE = 'America/New_York'
const SUMMARY = '/api/v1/me/notifications/summary'
const picture = '[role="button"][aria-label^="Account, "]'
const mark = '[role="button"][aria-label="TeamStation menu"]'
const panel = '[data-testid="header-menu-panel"]'
const pictureDot = '[data-testid="notification-pending-dot"]'
const rowDot = '[data-testid="notification-row-dot"]'

interface Edges {
  left: number
  right: number
  top: number
  bottom: number
}

const out = resolve(process.env.TS_ARTIFACTS_DIR ?? 'artifacts/headerMenus')
const before = process.env.TS_HEADER_BEFORE === '1'
const webRoot = resolve(process.env.TS_TESS_WEB_ROOT ?? 'dist')
const closingLog: string[] = [
  '$ node -r sucrase/register src/app/headerMenus.e2e.ts'
]

function logged(line: string): void {
  console.log(line)
  closingLog.push(line)
}

async function edgesOf(page: Page, selector: string): Promise<Edges> {
  await page.waitForSelector(selector)
  return await page.$eval(selector, node => {
    const box = node.getBoundingClientRect()
    return {
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom
    }
  })
}

async function pressLabel(page: Page, label: string): Promise<void> {
  const selector = `[role="button"][aria-label="${label}"]`
  await page.waitForSelector(selector)
  await page.$eval(selector, node => {
    ;(node as HTMLElement).click()
  })
}

async function waitGone(page: Page, selector: string): Promise<void> {
  await page.waitForFunction(
    selector => document.querySelector(selector) == null,
    { timeout: 15000 },
    selector
  )
}

async function bodyText(page: Page): Promise<string> {
  return await page.$eval('body', node => node.textContent || '')
}

async function waitText(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    text => (document.body.textContent || '').includes(text),
    { timeout: 20000 },
    text
  )
}

async function shot(page: Page, name: string): Promise<void> {
  // Wait for the fade and the blur to settle, so the picture is what stays.
  await new Promise(resolve => setTimeout(resolve, 400))
  await page.screenshot({ path: join(out, name) })
  console.log('Saved', name)
}

/** One page of one size, signed in as user 101 or not at all. */
async function openPage(
  browser: Browser,
  fixture: TessFixture,
  size: { width: number; height: number },
  signedIn: boolean,
  pending = false
): Promise<Page> {
  const page = await browser.newPage()
  await page.setViewport(size)
  await page.emulateTimezone(ZONE)
  await page.coverage.startJSCoverage({
    resetOnNavigation: false,
    includeRawScriptCoverage: true
  })
  await page.setRequestInterception(true)
  page.on('request', request => {
    if (new URL(request.url()).pathname === SUMMARY) {
      request
        .respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ hasPending: pending })
        })
        .catch(() => undefined)
      return
    }
    request.continue().catch(() => undefined)
  })
  page.on('pageerror', error => {
    console.error('Browser error:', String(error))
  })
  const { origin, tokens } = fixture.f.h
  const host = new URL(origin).hostname
  await browser.setCookie({
    name: 'ts_session',
    value: '',
    expires: 1,
    domain: host,
    path: '/'
  })
  if (signedIn)
    await browser.setCookie({
      name: 'ts_session',
      value: tokens.get(101)!,
      domain: host,
      path: '/',
      httpOnly: true
    })
  await page.goto(origin + '/', { waitUntil: 'networkidle2' })
  return page
}

function expectLinedUp(
  panelEdge: number,
  anchorEdge: number,
  what: string
): void {
  expect(Math.abs(panelEdge - anchorEdge), what).lessThan(1.5)
}

async function userMenuAndRows(
  browser: Browser,
  t: TessFixture,
  coverage: Page[]
): Promise<void> {
  // E1, phone: anchoring, the look, the rows, and each way of closing.
  const page = await openPage(browser, t, PHONE, true)
  coverage.push(page)
  await page.waitForSelector(picture)
  expect(await page.$('[role="button"][aria-label="Tess"]')).equals(null)
  expect(await page.$('[role="button"][aria-label="Notifications"]')).equals(
    null
  )
  await shot(page, 'web-phone-header-after.png')

  await page.click(picture)
  const anchor = await edgesOf(page, picture)
  const opened = await edgesOf(page, panel)
  expectLinedUp(opened.right, anchor.right, 'right edge on the picture')
  expect(opened.top).greaterThan(anchor.bottom - 1)
  const look = await page.$eval(panel, node => {
    const glass = node.querySelector('[data-testid="header-menu-glass"]')!
    const glassStyle = getComputedStyle(glass)
    return {
      shadow: getComputedStyle(node).boxShadow,
      behind: getComputedStyle(node).backgroundColor,
      blur:
        glassStyle.backdropFilter === ''
          ? glassStyle.getPropertyValue('-webkit-backdrop-filter')
          : glassStyle.backdropFilter
    }
  })
  expect(look.shadow).not.equals('none')
  expect(look.blur).contains('blur(')
  // Nothing solid behind the glass, or there is nothing for it to blur.
  expect(look.behind).equals('rgba(0, 0, 0, 0)')
  const rows = await page.$eval(panel, node =>
    Array.from(node.querySelectorAll('[role="button"]')).map(
      row => row.getAttribute('aria-label') || ''
    )
  )
  expect(rows).deep.equals(['Account', 'Notifications'])
  logged(`Rows: ${rows.join(', ')}; blur ${look.blur}; shadow ${look.shadow}`)
  await shot(page, 'web-user-menu-no-dot.png')

  await page.mouse.click(PHONE.width / 2, PHONE.height - 60)
  await waitGone(page, panel)
  logged('Outside tap closed the menu')

  await page.click(picture)
  await page.waitForSelector(panel)
  await page.keyboard.press('Escape')
  await waitGone(page, panel)
  const focused = await page.evaluate(() => {
    const active = document.activeElement
    return (active == null ? '' : active.getAttribute('aria-label')) || ''
  })
  expect(focused).contains('Account, ')
  logged(`Escape closed the menu; focus on "${focused}"`)

  await page.click(picture)
  await page.waitForSelector(panel)
  await page.setViewport({ width: PHONE.width + 60, height: PHONE.height })
  await waitGone(page, panel)
  await page.setViewport(PHONE)
  logged('A window resize closed the menu')

  await page.click(picture)
  await pressLabel(page, 'Notifications')
  await waitGone(page, panel)
  await page.waitForFunction(() => location.pathname === '/notifications')
  logged('The Notifications row closed the menu and opened Notifications')
  await shot(page, 'web-pushed-screen-no-menu.png')

  // A pushed screen draws no mark and no Tess control; the picture's menu works.
  expect(await page.$(mark)).equals(null)
  await page.click(picture)
  await page.waitForSelector(panel)
  await shot(page, 'web-pushed-screen-menu.png')
  logged('Pushed screen: no mark, and the picture menu opens')

  await pressLabel(page, 'Account')
  await waitGone(page, panel)
  await page.waitForFunction(() => location.pathname === '/account')
  logged('The Account row closed the menu and opened Account')

  // The picture stays on Account, and its Account row only closes the menu.
  await page.click(picture)
  await page.waitForSelector(panel)
  await shot(page, 'web-account-screen-menu.png')
  await pressLabel(page, 'Account')
  await waitGone(page, panel)
  expect(await page.evaluate(() => location.pathname)).equals('/account')
  logged('On Account, the Account row only closed the menu')

  // About is on the mark's menu, and only a tab root has the mark.
  for (let backs = 0; (await page.$(mark)) == null; backs++) {
    expect(backs, 'Back reaches a tab root').lessThan(4)
    await pressLabel(page, 'Back')
    await new Promise(resolve => setTimeout(resolve, 600))
  }
  await page.click(mark)
  await pressLabel(page, 'About TeamStation')
  await waitGone(page, panel)
  logged('The About row closed the menu and opened About')
  await about(page, 'about-after.png')
}

async function about(page: Page, name: string): Promise<void> {
  await page.waitForSelector(
    '[role="button"][aria-label="Close build information"]'
  )
  const text = await bodyText(page)
  for (const row of ['Version', 'Build number', 'Branch', 'App server URL'])
    expect(text).contains(row)
  expect(text, 'six characters of the commit').matches(/Commit[0-9a-f]{6}Built/)
  expect(text, "the build time in the browser's zone").matches(
    /Built[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s[AP]M E[SD]T/
  )
  expect(text).contains(new URL(page.url()).origin)
  await shot(page, name)
  await pressLabel(page, 'Close build information')
  await waitGone(page, '[role="button"][aria-label="Close build information"]')
}

async function teamStationMenu(
  browser: Browser,
  t: TessFixture,
  coverage: Page[]
): Promise<void> {
  // E1, desktop: the mark's menu on the left, and Tess in her column.
  const page = await openPage(browser, t, DESKTOP, true)
  coverage.push(page)
  await page.waitForSelector(mark)
  await shot(page, 'web-desktop-header-after.png')
  // A press shows, as the picture's does.
  const pressedAt = await edgesOf(page, mark)
  await page.mouse.move(pressedAt.left + 10, pressedAt.top + 20)
  await page.mouse.down()
  await page.waitForFunction(
    selector => {
      const node = document.querySelector(selector)
      return node != null && getComputedStyle(node).opacity === '0.6'
    },
    { timeout: 5000 },
    mark
  )
  await page.mouse.move(pressedAt.left + 400, pressedAt.top + 400)
  await page.mouse.up()
  logged('The mark dims while pressed')
  await page.click(mark)
  const anchor = await edgesOf(page, mark)
  const opened = await edgesOf(page, panel)
  expectLinedUp(opened.left, anchor.left, 'left edge on the mark')
  expect(opened.top).greaterThan(anchor.bottom - 1)
  // The two menus drop to one height, and the mark is as easy to hit.
  const pictureBox = await edgesOf(page, picture)
  expect(anchor.bottom).equals(pictureBox.bottom)
  expect(anchor.bottom - anchor.top).greaterThanOrEqual(44)
  await waitText(page, 'Your AI chatbot')
  const markRows = await page.$eval(panel, node =>
    Array.from(node.querySelectorAll('[role="button"]')).map(
      row => row.getAttribute('aria-label') || ''
    )
  )
  expect(markRows).deep.equals(['About TeamStation', 'Ask Tess'])
  logged(`Mark's rows: ${markRows.join(', ')}`)
  await shot(page, 'web-teamstation-menu.png')
  await pressLabel(page, 'Ask Tess')
  await waitGone(page, panel)
  const column = '[data-testid="Tess column"]'
  await page.waitForSelector(column)
  const box = await edgesOf(page, column)
  expect(box.right).equals(DESKTOP.width)
  expect(box.left).equals(DESKTOP.width - 400)
  await shot(page, 'web-tess-desktop.png')

  // With her column open the mark stays at the left, and its menu holds
  // only About, which opens beside her.
  const moved = await edgesOf(page, mark)
  await page.click(mark)
  const besideHer = await edgesOf(page, panel)
  expectLinedUp(besideHer.left, moved.left, 'left edge on the moved mark')
  const onlyAbout = await page.$eval(panel, node =>
    Array.from(node.querySelectorAll('[role="button"]')).map(
      row => row.getAttribute('aria-label') || ''
    )
  )
  expect(onlyAbout).deep.equals(['About TeamStation'])
  await pressLabel(page, 'About TeamStation')
  await page.waitForSelector(
    '[role="button"][aria-label="Close build information"]'
  )
  await pressLabel(page, 'Close build information')
  await waitGone(page, '[role="button"][aria-label="Close build information"]')
  await page.waitForSelector(column)
  logged(
    "With her column open, the mark's menu holds only About, and she stays"
  )

  await pressLabel(page, 'Close Tess')
  await waitGone(page, column)
  logged('Ask Tess opened her right column, and Close Tess closed it')
}

async function dots(
  browser: Browser,
  t: TessFixture,
  coverage: Page[]
): Promise<void> {
  // E2: both dots with a notification waiting, and neither without one.
  const page = await openPage(browser, t, PHONE, true, true)
  coverage.push(page)
  await page.waitForSelector(pictureDot)
  await page.waitForSelector('[aria-label$=", notifications waiting"]')
  await page.click(picture)
  await page.waitForSelector(rowDot)
  const pictureBox = await edgesOf(page, picture)
  const dot = await edgesOf(page, pictureDot)
  expect(dot.left).greaterThan((pictureBox.left + pictureBox.right) / 2)
  expect(dot.bottom).lessThan((pictureBox.top + pictureBox.bottom) / 2)
  await shot(page, 'web-user-menu-dot.png')
  const quiet = await openPage(browser, t, PHONE, true, false)
  coverage.push(quiet)
  await quiet.waitForSelector(picture)
  expect(await quiet.$(pictureDot)).equals(null)
  await quiet.click(picture)
  await quiet.waitForSelector(panel)
  expect(await quiet.$(rowDot)).equals(null)
  logged('Dots: on the picture and bell when pending, on neither otherwise')
}

async function states(
  browser: Browser,
  t: TessFixture,
  coverage: Page[]
): Promise<void> {
  // E3: signed out, the mark is About; without Tess, its menu holds only About.
  const signedOut = await openPage(browser, t, PHONE, false)
  coverage.push(signedOut)
  await pressLabel(signedOut, 'About TeamStation')
  await signedOut.waitForSelector(
    '[role="button"][aria-label="Close build information"]'
  )
  await shot(signedOut, 'web-signed-out-about.png')
  logged('Signed out: the mark opened About directly')

  const without = await tessFixture({ webRoot, tess: false, videos: false })
  try {
    const page = await openPage(browser, without, PHONE, true)
    await page.waitForSelector(picture)
    await new Promise(resolve => setTimeout(resolve, 2000))
    await page.click(mark)
    await page.waitForSelector(panel)
    expect(await page.$('[role="button"][aria-label="Ask Tess"]')).equals(null)
    await shot(page, 'web-tess-unavailable.png')
    await pressLabel(page, 'About TeamStation')
    await about(page, 'web-tess-unavailable-about.png')
    logged("Without Tess: the mark's menu has only About")
    await page.close()
  } finally {
    await without.close()
  }
}

async function capturedBefore(browser: Browser, t: TessFixture): Promise<void> {
  const phone = await openPage(browser, t, PHONE, true)
  await phone.waitForSelector(picture)
  await phone.waitForSelector('[role="button"][aria-label="Tess"]')
  await shot(phone, 'web-phone-header-before.png')
  await pressLabel(phone, 'About TeamStation')
  await phone.waitForSelector(
    '[role="button"][aria-label="Close build information"]'
  )
  await shot(phone, 'about-before.png')
  await phone.close()
  const desktop = await openPage(browser, t, DESKTOP, true)
  await desktop.waitForSelector('[role="button"][aria-label="Tess"]')
  await shot(desktop, 'web-desktop-header-before.png')
  await desktop.close()
}

async function main(): Promise<void> {
  await mkdir(out, { recursive: true })
  const t = await tessFixture({ webRoot, videos: false })
  const browser = await puppeteer.launch({ headless: true })
  try {
    if (before) {
      await capturedBefore(browser, t)
    } else {
      const coverage: Page[] = []
      await userMenuAndRows(browser, t, coverage)
      await teamStationMenu(browser, t, coverage)
      await dots(browser, t, coverage)
      await states(browser, t, coverage)
      if (process.env.TS_DIRECT_BROWSER_COVERAGE != null)
        await recordBrowserCoverage(
          coverage,
          t.f.h.origin,
          resolve(process.env.TS_DIRECT_BROWSER_COVERAGE),
          webRoot
        )
      await writeFile(
        join(out, 'web-menu-closing.log'),
        closingLog.join('\n') + '\n'
      )
    }
    console.log('Header menu browser scenarios passed')
  } catch (error) {
    const pages = await browser.pages()
    await pages[pages.length - 1]
      ?.screenshot({ path: join(out, 'headerMenus-failure.png') })
      .catch(() => undefined)
    await appendFile(join(out, 'headerMenus-failure.log'), String(error) + '\n')
    throw error
  } finally {
    await browser.close()
    await t.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
