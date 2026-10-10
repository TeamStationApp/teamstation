/* eslint-disable @typescript-eslint/prefer-optional-chain -- Serialized browser callbacks cannot capture Sucrase's generated helper functions. */
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
  artifacts: string
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
  await m.tapOn({ css: `input[aria-label="${label}"]`, timeout: 10000 })
  const selector = `input[aria-label="${label}"]`
  const page = browserPages.get(m)
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
  await m.tapOn({ text, role, timeout: 15000 })
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
export async function contains(page: Page, text: string): Promise<void> {
  await page
    .waitForFunction(
      text => {
        const body = document.body.textContent
        return body !== null && body.includes(text)
      },
      {},
      text
    )
    .catch(async (error: unknown) => {
      console.error(
        'Missing text',
        text,
        await page.evaluate(() => document.body.textContent)
      )
      throw error
    })
}
export async function absent(page: Page, text: string): Promise<void> {
  expect(await diagnostic(page, () => document.body.textContent)).not.includes(
    text
  )
}
