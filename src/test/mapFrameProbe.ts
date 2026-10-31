import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import puppeteer, { type Browser, type Frame, type Page } from 'puppeteer'

/**
 * A map draws in a sandboxed frame the page cannot reach into, so a test reads
 * it from inside: `evalBrowserScript` runs in the page, and `contentWindow` and
 * `contentDocument` are refused there.
 */
export const isMapFrame = (frame: Frame | undefined | null): boolean =>
  frame?.url().endsWith('/mapFrame.html') === true

/** Puppeteer's connection to a browser started with this profile. */
export async function connectToProfile(profile: string): Promise<Browser> {
  const [port, socket] = readFileSync(
    join(profile, 'DevToolsActivePort'),
    'utf8'
  )
    .trim()
    .split('\n')
  return await puppeteer.connect({
    defaultViewport: null,
    browserWSEndpoint: `ws://127.0.0.1:${port}${socket}`
  })
}

/** The page's map frame, once there is one. */
export async function mapFrameOf(page: Page, timeout = 25000): Promise<Frame> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const frame = page.frames().find(isMapFrame)
    if (frame != null) return frame
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The map frame never appeared')
}

/** An expression's value inside the map frame, by way of JSON. */
export async function inMapFrame<T>(
  page: Page,
  expression: string
): Promise<T> {
  const frame = await mapFrameOf(page)
  const json = await frame.evaluate(`JSON.stringify((${expression})??null)`)
  return JSON.parse(json as string) as T
}

/**
 * Waits up to `timeout` for an expression to hold inside the map frame. A frame
 * between documents refuses the read, or answers from the old one, so a failed
 * read is tried again, and the last one's error is in what this throws.
 */
export async function waitInMapFrame(
  page: Page,
  expression: string,
  timeout = 30000
): Promise<void> {
  const deadline = Date.now() + timeout
  let last: Error | undefined
  while (Date.now() < deadline) {
    try {
      const frame = await mapFrameOf(page, deadline - Date.now())
      const json = await frame.evaluate(`JSON.stringify((${expression})??null)`)
      if (JSON.parse(json as string) as boolean) return
      last = undefined
    } catch (error) {
      last = error as Error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(
    `Never held in the map frame: ${expression}${last == null ? '' : ` (${last.message})`}`
  )
}

/** The middle of an element in the map frame, in the page's coordinates. */
export async function pointInMapFrame(
  page: Page,
  selector: string
): Promise<{ x: number; y: number }> {
  const map = await mapFrameOf(page)
  const box = await (await map.frameElement())!.boundingBox()
  const inner = await map.evaluate((wanted: string) => {
    const r = document.querySelector(wanted)!.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, selector)
  return { x: box!.x + inner.x, y: box!.y + inner.y }
}
