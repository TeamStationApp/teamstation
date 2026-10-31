import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import puppeteer, { type Browser, type Page } from 'puppeteer'

export type BrowserPage = Page

/** The CDP calls emulation needs, so a unit test can stand in for a browser. */
export interface CdpPage {
  evaluateOnNewDocument: (script: string) => Promise<unknown>
  emulateTimezone: (zone: string) => Promise<unknown>
  emulateMediaFeatures: (
    features: Array<{ name: string; value: string }>
  ) => Promise<unknown>
  setViewport: (viewport: {
    width: number
    height: number
    hasTouch: boolean
    isMobile: boolean
  }) => Promise<unknown>
}

export interface Emulation {
  /** Pins `Date` to this instant before any page script runs. */
  clock?: string
  timeZone?: string
  reducedMotion?: boolean
  touch?: { width: number; height: number }
}

export function clockScript(instant: string): string {
  const at = JSON.stringify(new Date(instant).getTime())
  return `(() => {
    const real = Date
    const fixed = ${at}
    class Pinned extends real {
      constructor(...args) { args.length === 0 ? super(fixed) : super(...args) }
      static now() { return fixed }
    }
    window.Date = Pinned
  })()`
}

/** What maestro-d cannot do. Tests still drive the UI through maestro-d. */
export async function applyEmulation(
  page: CdpPage,
  emulation: Emulation
): Promise<void> {
  if (emulation.clock != null) {
    await page.evaluateOnNewDocument(clockScript(emulation.clock))
  }
  if (emulation.timeZone != null) await page.emulateTimezone(emulation.timeZone)
  if (emulation.reducedMotion === true) {
    await page.emulateMediaFeatures([
      { name: 'prefers-reduced-motion', value: 'reduce' }
    ])
  }
  if (emulation.touch != null) {
    await page.setViewport({
      width: emulation.touch.width,
      height: emulation.touch.height,
      hasTouch: true,
      isMobile: true
    })
  }
}

/** Connects to the Chromium maestro-d started, read from its profile directory. */
export async function connectToMaestroChromium(
  profile: string,
  targetUrl: string
): Promise<{ browser: Browser; page: Page }> {
  const [port, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8')
    .trim()
    .split('\n')
  const browser = await puppeteer.connect({
    browserWSEndpoint: `ws://127.0.0.1:${port}${path}`,
    defaultViewport: null
  })
  const page = (await browser.pages()).find(p => p.url() === targetUrl)
  if (page == null) throw new Error(`No browser target at ${targetUrl}`)
  return { browser, page }
}
