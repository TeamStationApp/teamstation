import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import puppeteer, { type Browser, type Page } from 'puppeteer'

export interface MaestroHandle {
  launchApp: (args?: Record<string, unknown>) => Promise<unknown>
  tapOn: (args: Record<string, unknown>) => Promise<unknown>
  inputText: (args: Record<string, unknown>) => Promise<unknown>
  eraseText: (args: Record<string, unknown>) => Promise<unknown>
  pressKey: (args: Record<string, unknown>) => Promise<unknown>
  assertVisible: (args: Record<string, unknown>) => Promise<unknown>
  assertNotVisible: (args: Record<string, unknown>) => Promise<unknown>
  openBrowser: (args: Record<string, unknown>) => Promise<unknown>
  openLink: (args: Record<string, unknown>) => Promise<unknown>
  scroll: (args: Record<string, unknown>) => Promise<unknown>
  evalBrowserScript: (args: Record<string, unknown>) => Promise<unknown>
  scrollUntilVisible: (args: Record<string, unknown>) => Promise<unknown>
  swipe: (args: Record<string, unknown>) => Promise<unknown>
  hideKeyboard: () => Promise<unknown>
  waitForAnimationToEnd: () => Promise<unknown>
  screenshot: () => Promise<Uint8Array>
  hierarchy: () => Promise<any>
  command: (name: string, args?: Record<string, unknown>) => Promise<unknown>
  detach: () => Promise<void>
}
interface MaestroDaemon {
  attach: (args: Record<string, unknown>) => Promise<MaestroHandle>
  shutdown: () => Promise<void>
}
export async function maestro(name: string): Promise<MaestroDaemon> {
  const entry = process.env.TS_MAESTRO_D_CLIENT
  if (entry == null) throw new Error('Supply TS_MAESTRO_D_CLIENT')
  if (process.env.MAESTRO_D_BIN == null)
    throw new Error('Supply MAESTRO_D_BIN from the locally built Maestro D')
  execFileSync(process.env.MAESTRO_D_BIN, ['ps'], { stdio: 'ignore' })
  const { MaestroD } = createRequire(resolve('package.json'))(entry)
  return await MaestroD.connect({
    name,
    bin: process.env.MAESTRO_D_BIN,
    idleTimeout: 0
  })
}
export interface BrowserSession {
  m: MaestroHandle
  browser: Browser
  page: Page
}
const browserPages = new WeakMap<MaestroHandle, Page>()
export async function browserSession(
  daemon: MaestroDaemon,
  device: string,
  width: number,
  height: number,
  artifacts: string,
  browserName: 'chromium' | 'chrome' = 'chromium'
): Promise<BrowserSession> {
  const profile = join(artifacts, 'support', 'browser-profiles', device)
  await mkdir(profile, { recursive: true })
  const m = await daemon.attach({
    device,
    platform: 'web',
    url: `about:blank#${device}`,
    appId: `about:blank#${device}`,
    artifacts: 'on-failure',
    extra: {
      // A named browser wins; otherwise Chrome by path. Without Google Chrome
      // in /Applications, Maestro D's `chrome` is a Chromium that plays no
      // H.264 or HEVC.
      browser:
        process.env.TS_REFINEMENTS_BROWSER ??
        (browserName === 'chrome'
          ? (process.env.TS_CHROME_PATH ?? 'chrome')
          : browserName),
      windowSize: `${width}x${height}`,
      headed: false,
      userDataDir: profile
    }
  })
  const [port, ws] = (
    await readFile(join(profile, 'DevToolsActivePort'), 'utf8')
  )
    .trim()
    .split('\n')
  const browser = await puppeteer.connect({
    browserWSEndpoint: `ws://127.0.0.1:${port}${ws}`,
    defaultViewport: null
  })
  const page = (await browser.pages()).find(
    p => p.url() === `about:blank#${device}`
  )
  if (page == null) throw new Error('Owned Maestro browser target missing')
  expect(
    await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  ).deep.equals({ width, height })
  browserPages.set(m, page)
  await page.coverage.startJSCoverage({
    resetOnNavigation: false,
    includeRawScriptCoverage: true
  })
  return { m, browser, page }
}
export async function fill(
  m: MaestroHandle,
  label: string,
  value: string
): Promise<void> {
  const page = browserPages.get(m)
  const bare = `[aria-label="${label}"]:is(input, textarea)`
  const top = `[data-scene-role="top"] ${bare}`
  // A covered screen keeps its fields in the DOM with pointer-events: none.
  // The top scene is the one the tap can reach; a screen still pushing in is
  // `incoming` until its transition ends.
  const onTop =
    page != null &&
    (await page
      .waitForSelector(top, { timeout: 10000 })
      .then(() => true)
      .catch(() => false))
  const selector = onTop ? top : bare
  await m.tapOn({
    css: selector,
    timeout: 10000
  })
  if (page != null) {
    const current = await page.$eval(
      selector,
      node => (node as HTMLInputElement).value
    )
    if (current !== '') {
      await m.tapOn({ text: `Clear ${label}`, role: 'button', timeout: 10000 })
      await page.waitForFunction(
        selector => {
          const input = document.querySelector<HTMLInputElement>(selector)
          return input !== null && input.value === ''
        },
        {},
        selector
      )
      await m.tapOn({ css: selector, timeout: 10000 })
    }
  }
  await m.inputText({ text: value, css: selector })
  if (page != null)
    await page.waitForFunction(
      (selector, value) => {
        const input = document.querySelector<HTMLInputElement>(selector)
        return input !== null && input.value === value
      },
      { timeout: 10000 },
      selector,
      value
    )
}
export async function tap(
  m: MaestroHandle,
  text: string,
  role = 'button'
): Promise<void> {
  try {
    await m.tapOn({ text, role, timeout: 15000 })
  } catch (error) {
    // Every element with this label, where it is, and what hides it: a match
    // in a hidden tab pane or a scene behind the top one is the usual cause.
    const page = browserPages.get(m)
    if (page != null) {
      const found = await page.evaluate(
        (label: string) =>
          [...document.querySelectorAll('[aria-label]')]
            .filter(n => n.getAttribute('aria-label') === label)
            .map(n => {
              let hidden = ''
              for (let e: Element | null = n; e != null; e = e.parentElement) {
                if (e.getAttribute('aria-hidden') === 'true')
                  hidden += ' aria-hidden@' + e.tagName
                const cs = getComputedStyle(e)
                if (cs.pointerEvents === 'none')
                  hidden +=
                    ' pe-none@' +
                    String(e.getAttribute('data-scene-role')) +
                    '/' +
                    e.tagName
                if (cs.display === 'none' || cs.visibility === 'hidden')
                  hidden += ' invisible'
                if (e.hasAttribute('inert')) hidden += ' inert'
              }
              const r = n.getBoundingClientRect()
              return `${n.getAttribute('role')} ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}${hidden}`
            }),
        text
      )
      console.error('Tap target', JSON.stringify(text), JSON.stringify(found))
    }
    throw error
  }
}
export async function show(m: MaestroHandle, text: string): Promise<void> {
  await m.assertVisible({ text, timeout: 15000 })
}
export async function capture(
  m: MaestroHandle,
  artifacts: string,
  name: string
): Promise<void> {
  await m.waitForAnimationToEnd()
  await writeFile(join(artifacts, name), await m.screenshot())
}
export async function diagnostic<T>(page: Page, read: () => T): Promise<T> {
  return await page.evaluate(read)
}
export async function log(
  artifacts: string,
  file: string,
  line: string
): Promise<void> {
  await appendFile(join(artifacts, file), line + '\n')
  console.log(line)
}
/**
 * Waits for `text` on the page as shown: `innerText`, so a hidden tab pane or
 * a scene behind the top one does not count.
 */
export async function contains(page: Page, text: string): Promise<void> {
  await page
    .waitForFunction(text => document.body.innerText.includes(text), {}, text)
    .catch(async (error: unknown) => {
      console.error(
        'Missing text',
        text,
        await page.evaluate(() => document.body.innerText)
      )
      throw error
    })
}
export async function absent(page: Page, text: string): Promise<void> {
  expect(await diagnostic(page, () => document.body.textContent)).not.includes(
    text
  )
}
