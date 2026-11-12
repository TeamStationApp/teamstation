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
    // A device name is the machine's, across daemons: another run of the same
    // script elsewhere on it holds the bare name.
    device: `${device}-${process.pid}`,
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
/**
 * Waits for the row `field` to show `value`, then for the picker's dialog to
 * finish animating out: a tap sent while it closes can hang Maestro D past
 * its own timeout.
 */
async function rowShows(
  m: MaestroHandle,
  field: string,
  value: string
): Promise<void> {
  const page = browserPages.get(m)
  if (page == null) return
  await page.waitForSelector(
    `[data-scene-role="top"] [role="button"][aria-label="${field}: ${value}"]`,
    { timeout: 15000 }
  )
  await m.waitForAnimationToEnd()
}

/** The value an event schedule row shows, from its label `<field>: <value>`. */
async function scheduleValue(m: MaestroHandle, field: string): Promise<string> {
  const page = browserPages.get(m)
  if (page == null)
    throw new Error('chooseDate and chooseTime need a browser session')
  const css = `[data-scene-role="top"] [role="button"][aria-label^="${field}: "]`
  await page.waitForSelector(css, { timeout: 15000 })
  const label = await page.$eval(css, node => node.getAttribute('aria-label'))
  return String(label).slice(field.length + 2)
}

/**
 * Picks `date` (YYYY-MM-DD) for the event schedule row `field` ("Date",
 * "End date"): opens its calendar, steps from the month it shows to the
 * date's, chooses the day and uses it.
 */
export async function chooseDate(
  m: MaestroHandle,
  field: string,
  date: string
): Promise<void> {
  const shown = await scheduleValue(m, field)
  const months = (value: string): number =>
    Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7))
  await m.tapOn({ text: `${field}: ${shown}`, role: 'button', timeout: 15000 })
  // The dialog slides in; a tap computed mid-slide misses its target.
  await m.waitForAnimationToEnd()
  const delta = months(date) - months(shown)
  for (let i = 0; i < Math.abs(delta); i++) {
    await m.tapOn({
      text: delta > 0 ? 'Next month' : 'Previous month',
      role: 'button',
      timeout: 10000
    })
    await m.waitForAnimationToEnd()
  }
  await m.tapOn({ text: `Choose ${date}`, role: 'button', timeout: 10000 })
  await m.tapOn({ text: 'Use date', role: 'button', timeout: 10000 })
  await rowShows(m, field, date)
}

/**
 * Picks `time` (HH:MM, 24-hour, minutes in fives) for the event schedule row
 * `field` ("Start time", "End time") on its hour, minute and period wheels.
 */
export async function chooseTime(
  m: MaestroHandle,
  field: string,
  time: string
): Promise<void> {
  const shown = await scheduleValue(m, field)
  const [hour, minute] = time.split(':').map(Number)
  await m.tapOn({ text: `${field}: ${shown}`, role: 'button', timeout: 15000 })
  await m.waitForAnimationToEnd()
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  for (const option of [
    `Hour ${String(twelve).padStart(2, '0')}`,
    `Minute ${String(minute).padStart(2, '0')}`,
    `Period ${hour < 12 ? 'AM' : 'PM'}`
  ]) {
    await m.tapOn({ text: option, role: 'button', timeout: 10000 })
  }
  await m.tapOn({ text: 'Use time', role: 'button', timeout: 10000 })
  await rowShows(
    m,
    field,
    `${twelve}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
  )
}

/**
 * Picks the IANA `zone` for the event schedule's Time zone row: searches for
 * it in the picker and uses it. The row shows the zone with spaces.
 */
export async function chooseTimezone(
  m: MaestroHandle,
  zone: string
): Promise<void> {
  const shown = await scheduleValue(m, 'Time zone')
  await m.tapOn({ text: `Time zone: ${shown}`, role: 'button', timeout: 15000 })
  await m.waitForAnimationToEnd()
  await fill(m, 'Find time zone', zone)
  await m.tapOn({
    text: `Use time zone ${zone}`,
    role: 'button',
    timeout: 10000
  })
  await rowShows(m, 'Time zone', zone.replace(/_/g, ' '))
}

/**
 * Taps the match of `css` that a tap at its centre reaches. A tab pane or a
 * scene not on top keeps its controls in the DOM with pointer-events: none,
 * and Maestro D takes the first match, which can be one of those.
 */
export async function tapReachable(
  m: MaestroHandle,
  css: string
): Promise<void> {
  const page = browserPages.get(m)
  if (page == null) {
    await m.tapOn({ css, timeout: 15000 })
    return
  }
  await page.waitForSelector(css, { timeout: 15000 })
  const marked = await page.evaluate(selector => {
    for (const node of document.querySelectorAll(selector)) {
      node.scrollIntoView({ block: 'center' })
      const rect = node.getBoundingClientRect()
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2
      )
      if (hit !== null && node.contains(hit)) {
        node.setAttribute('data-e2e-tap', 'here')
        return true
      }
    }
    return false
  }, css)
  await m.tapOn({
    css: marked ? '[data-e2e-tap="here"]' : css,
    timeout: 15000
  })
  if (marked) {
    await page.evaluate(() => {
      for (const node of document.querySelectorAll('[data-e2e-tap]'))
        node.removeAttribute('data-e2e-tap')
    })
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
  // A playing video never lets the page settle; the picture is taken anyway.
  await m.waitForAnimationToEnd().catch(() => undefined)
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
