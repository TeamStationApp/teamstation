import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  type BrowserSession,
  browserSession,
  maestro
} from '../test/refinementsMaestro.e2e'
import { tessFixture } from '../test/tessFixture'
import { recordBrowserCoverage } from './browserCoverage.e2e'

/**
 * Build with npm run build.web, then run with node -r sucrase/register.
 * TS_SIDEBAR_ARTIFACTS holds the final screenshots and navigation.log.
 * TS_MAESTRO_D_CLIENT and MAESTRO_D_BIN select the local Maestro D install.
 */
async function main(): Promise<void> {
  const out = process.env.TS_SIDEBAR_ARTIFACTS
  assert(out != null, 'Supply TS_SIDEBAR_ARTIFACTS')
  await mkdir(out, { recursive: true })
  const fixture = await tessFixture({ webRoot: resolve('dist'), videos: false })
  const daemonName = process.env.MAESTRO_D ?? 'wideSidebarE2e'
  const daemon = await maestro(daemonName)
  let session: BrowserSession | undefined
  const lines = [
    '$ node -r sucrase/register src/app/wideNavigationSidebar.e2e.ts'
  ]
  const note = (text: string): void => {
    lines.push(text)
    console.log(text)
  }
  try {
    session = await browserSession(
      daemon,
      `${daemonName}-browser`,
      1440,
      900,
      process.env.TS_BROWSER_SCRATCH ?? '/tmp/wideSidebarE2e',
      'chrome'
    )
    const { m, page, browser } = session
    const origin = fixture.f.h.origin
    const host = new URL(origin).hostname
    await browser.setCookie({
      name: 'ts_session',
      value: fixture.f.h.tokens.get(101)!,
      domain: host,
      path: '/',
      httpOnly: true
    })
    const sidebar = '[data-testid="navigation-sidebar"]'
    const mark = '[aria-label="TeamStation menu"]'
    const tap = async (css: string): Promise<void> => {
      await page.waitForSelector(css)
      await m.tapOn({ css, timeout: 15000 })
    }
    const waitGone = async (css: string): Promise<void> => {
      await page.waitForSelector(css, { hidden: true })
    }
    const shot = async (name: string): Promise<void> => {
      await new Promise(resolve => setTimeout(resolve, 400))
      await page.screenshot({ path: join(out, name + '-after.png') })
    }
    const resize = async (width: number, height = 900): Promise<void> => {
      await page.setViewport({ width, height })
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    const pathIs = async (path: string): Promise<void> => {
      await page.waitForFunction(path => location.pathname === path, {}, path)
    }
    await m.openBrowser({ url: origin + '/' })
    await page.waitForSelector('[aria-label^="Account, "]')
    for (const [name, width, height] of [
      ['home-phone', 390, 844],
      ['home-below', 1215, 900]
    ] as const) {
      await resize(width, height)
      assert.equal(await page.$(sidebar), null)
      await page.waitForSelector('[role="tab"][aria-label="Home"]')
      await tap(mark)
      await page.waitForSelector('[data-testid="header-menu-panel"]')
      await tap('[aria-label="Close menu"]')
      await shot(name)
      note(`${width}: existing bar and mark menu remain`)
    }
    // An open mark menu must disappear when the sidebar takes over.
    await tap(mark)
    await resize(1216)
    await page.waitForSelector(sidebar)
    await waitGone('[data-testid="header-menu-panel"]')
    for (const [name, width] of [
      ['home-boundary', 1216],
      ['home-wide', 1440]
    ] as const) {
      await resize(width)
      const result = await page.$eval(sidebar, node => ({
        width: node.getBoundingClientRect().width,
        rows: [...node.querySelectorAll('[role="button"], [role="tab"]')].map(
          row => row.getAttribute('aria-label')
        ),
        bottom: node.getBoundingClientRect().bottom,
        tessBottom: node
          .querySelector('[aria-label="Ask Tess"]')!
          .getBoundingClientRect().bottom
      }))
      assert.equal(result.width, 256)
      assert.deepEqual(result.rows, [
        'About TeamStation',
        'Home',
        'Videos',
        'Schedule',
        'Search',
        'Messages',
        'Ask Tess'
      ])
      assert(result.bottom - result.tessBottom <= 10)
      assert.equal(await page.$(mark), null)
      assert.equal(await page.$$eval('[role="tab"]', nodes => nodes.length), 5)
      await tap('[data-testid="sidebar-header-mark"]')
      assert.equal(await page.$('[data-testid="header-menu-panel"]'), null)
      assert.equal(await page.$('[aria-label="Close build information"]'), null)
      await shot(name)
      note(`${width}: ordered sidebar, no bar/menu, Tess pinned at bottom`)
    }
    await tap(`${sidebar} [aria-label="About TeamStation"]`)
    await tap('[aria-label="Close build information"]')
    for (const [label, path] of [
      ['Videos', '/videos'],
      ['Schedule', '/schedule'],
      ['Search', '/discover'],
      ['Messages', '/chat'],
      ['Home', '/']
    ] as const) {
      await tap(`${sidebar} [aria-label="${label}"]`)
      await pathIs(path)
      note(`${label} opened ${path}`)
    }
    await tap(`${sidebar} [aria-label="Videos"]`)
    await resize(1215)
    await pathIs('/videos')
    await resize(1216)
    await pathIs('/videos')
    await tap(`${sidebar} [aria-label="Home"]`)
    await tap(`${sidebar} [aria-label="Ask Tess"]`)
    await page.waitForSelector('[data-testid="Tess column"]')
    const column = '[data-testid="Tess column"]'
    const frame = async (): Promise<{
      x: number
      width: number
      paneX: number
      paneWidth: number
    }> =>
      await page.$eval(column, node => {
        const rect = node.getBoundingClientRect()
        const pane = node.nextElementSibling!.getBoundingClientRect()
        return {
          x: rect.x,
          width: rect.width,
          paneX: pane.x,
          paneWidth: pane.width
        }
      })
    assert.deepEqual(await frame(), {
      x: 256,
      width: 400,
      paneX: 656,
      paneWidth: 560
    })
    await resize(1440)
    await shot('tess-wide')
    await tap('textarea[aria-label="Ask Tess"]')
    await m.inputText({
      text: 'Keep this draft',
      css: 'textarea[aria-label="Ask Tess"]'
    })
    await resize(1215)
    await resize(1216)
    assert.equal(
      await page.$eval('textarea[aria-label="Ask Tess"]', node => node.value),
      'Keep this draft'
    )
    await tap('[data-testid="Tess divider"]')
    await page.keyboard.press('End')
    assert((await frame()).paneWidth >= 520)
    await tap('[aria-label="Close Tess"]')
    await waitGone(column)
    note('Tess and page fit at the boundary; resizing retained draft and route')
    await resize(1440)
    await tap('[aria-label^="Account, "]')
    await tap('[aria-label="Account"]')
    await pathIs('/account')
    note('Account menu still opens Account')
    await browser.setCookie({
      name: 'ts_session',
      value: '',
      expires: 1,
      domain: host,
      path: '/'
    })
    await m.openBrowser({ url: origin + '/sign-in' })
    await page.waitForSelector(sidebar)
    await waitGone(`${sidebar} [aria-label="Ask Tess"]`)
    await shot('signed-out')
    await tap(`${sidebar} [aria-label="About TeamStation"]`)
    await tap('[aria-label="Close build information"]')
    note(
      'Signed-out sidebar retains About and destination actions; no unavailable Tess'
    )
    if (process.env.TS_DIRECT_BROWSER_COVERAGE != null)
      await recordBrowserCoverage(
        [page],
        origin,
        resolve(process.env.TS_DIRECT_BROWSER_COVERAGE)
      )
  } finally {
    await writeFile(join(out, 'navigation.log'), lines.join('\n') + '\n')
    await session?.browser.close()
    await daemon.shutdown()
    await fixture.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
