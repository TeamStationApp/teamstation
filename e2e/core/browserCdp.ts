import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import puppeteer, { type Browser, type Page } from 'puppeteer'

import { BlockedError } from './result'

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
  /** A script that stands in for hardware the browser lacks, before any page script. */
  beforeLoad?: string
  /** Opens a browser that plays H.264, which maestro-d's own Chromium cannot. */
  h264?: boolean
}

/** The browser maestro-d starts: its own Chromium, or Chrome for real video. */
export async function browserFor(
  emulation: Emulation,
  chrome: () => string | Promise<string> = async () =>
    await puppeteer.executablePath()
): Promise<string> {
  if (emulation.h264 !== true) return 'chromium'
  const path = await chrome()
  if (!existsSync(path)) {
    throw new BlockedError(
      `no browser with H.264 at ${path}: run \`npx puppeteer browsers install chrome\``
    )
  }
  return path
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
  if (emulation.beforeLoad != null) {
    await page.evaluateOnNewDocument(emulation.beforeLoad)
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
