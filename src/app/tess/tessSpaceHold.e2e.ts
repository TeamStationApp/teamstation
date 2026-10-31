/* eslint-disable @typescript-eslint/prefer-optional-chain, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- Serialized browser callbacks cannot capture Sucrase's generated helper functions. */
import { execFileSync } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import type { Page } from 'puppeteer'

import { recordBrowserCoverage } from '../../../e2e/rigs/browserCoverage'
import { fakeMicrophone } from '../../../e2e/rigs/fakeMicrophone'
import {
  type BrowserSession,
  browserSession,
  contains,
  maestro
} from '../../../e2e/rigs/refinementsMaestro'
import { HEARD, tessFixture } from '../../test/tessFixture'

/**
 * Space held to talk to Tess, on a wide browser window (Chromium,
 * 1280 × 900), driven through maestro-d with puppeteer beside it:
 *
 *   L8   a quick Space in her field types a space, and nobody listens;
 *        "hello world" typed with Space rolled into the w comes out in
 *        order; held 800 ms there, it listens from 500 ms;
 *   L9   a quick Space on a focused tab in the pane activates it, and
 *        scrolls nothing;
 *   L10  Space held 800 ms on the pane's page listens from 500 ms, and what
 *        was heard becomes her next message; with push-to-talk switched
 *        off, the same hold is the page's and scrolls it.
 *
 * The whole run is recorded as `space-hold.mp4`. The model is
 * `fakeAnthropic` and the recogniser the fixture's; nothing is paid for.
 */

/** A 440 Hz tone, 16 kHz mono, as a base64 WAV. */
function toneWav(seconds = 1.2): string {
  const rate = 16000
  const samples = Math.round(rate * seconds)
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++)
    buffer.writeInt16LE(
      Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)),
      44 + i * 2
    )
  return buffer.toString('base64')
}

async function pause(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(
  page: Page,
  selector: string,
  timeout = 20000
): Promise<void> {
  await page.waitForSelector(selector, { timeout })
}

/** The dictation status line's words, or null while push-to-talk is off. */
async function status(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const node = document.querySelector('[aria-label="Dictation status"]')
    return node == null ? null : node.textContent
  })
}

async function waitForStatus(
  page: Page,
  words: string | null,
  timeout = 20000
): Promise<void> {
  await page.waitForFunction(
    words => {
      const node = document.querySelector('[aria-label="Dictation status"]')
      return (node == null ? null : node.textContent) === words
    },
    { timeout },
    words
  )
}

/**
 * The scroll position of the pane's scroller: the tallest one right of Tess's
 * column with room to scroll, found once and tagged for the reads after.
 * `top` sets it first.
 */
async function paneScroll(page: Page, top?: number): Promise<number> {
  return await page.evaluate(top => {
    let node = document.querySelector<HTMLElement>('[data-space-scroller]')
    if (node == null) {
      const found = Array.from(document.querySelectorAll<HTMLElement>('*'))
        .filter(candidate => {
          const style = getComputedStyle(candidate)
          return (
            ['auto', 'scroll'].includes(style.overflowY) &&
            candidate.scrollHeight > candidate.clientHeight + 200 &&
            candidate.getBoundingClientRect().x >= 400
          )
        })
        .sort((a, b) => b.clientHeight - a.clientHeight)
      node = found.length === 0 ? null : found[0]
      if (node == null) return -1
      node.setAttribute('data-space-scroller', '')
    }
    if (top !== undefined) node.scrollTop = top
    return node.scrollTop
  }, top)
}

/**
 * A caption for the recording, over the bottom right of the page: the step,
 * and the Space key as the window first hears it, with how long it has been
 * down. It ticks every 50 ms, so the screencast keeps getting frames.
 */
function spaceCaption(): void {
  const caption = document.createElement('div')
  caption.setAttribute('data-testid', 'Space caption')
  caption.style.cssText =
    'position:fixed;right:16px;bottom:16px;z-index:99999;pointer-events:none;' +
    'padding:8px 12px;border-radius:8px;background:rgba(0,0,0,0.75);' +
    'color:#fff;font:600 15px/1.4 monospace;white-space:pre'
  document.body.appendChild(caption)
  let step = ''
  let down: number | null = null
  let last = ''
  ;(window as any).__step = (text: string) => {
    step = text
  }
  window.addEventListener(
    'keydown',
    event => {
      if (event.key === ' ' && !event.repeat && down === null)
        down = performance.now()
    },
    true
  )
  window.addEventListener(
    'keyup',
    event => {
      if (event.key !== ' ' || down === null) return
      last = `Space up after ${((performance.now() - down) / 1000).toFixed(2)} s`
      down = null
    },
    true
  )
  setInterval(() => {
    const key =
      down === null
        ? last || 'Space up'
        : `Space down ${((performance.now() - down) / 1000).toFixed(2)} s`
    caption.textContent = `${step}\n${key}`
  }, 50)
}

/** The pane's Team or Schedule tab. */
function paneTab(name: string): string {
  return `[role="tab"][aria-label="${name}"]`
}

async function main(): Promise<void> {
  const out = resolve(
    process.env.TS_ARTIFACTS_DIR ?? 'artifacts/202610242334-tessLiveAndPolish'
  )
  const webRoot = resolve(process.env.TS_TESS_WEB_ROOT ?? 'dist')
  await mkdir(join(out, 'support'), { recursive: true })
  const t = await tessFixture({ webRoot })
  const { f } = t
  const daemon = await maestro(process.env.MAESTRO_D ?? 'tess-space-hold')
  let s: BrowserSession | undefined
  try {
    s = await browserSession(
      daemon,
      'tess-space-hold-chromium',
      1280,
      900,
      out,
      'chrome'
    )
    const { m, page, browser } = s
    page.on('pageerror', error => {
      console.error(
        'Browser error:',
        error instanceof Error ? error.message : String(error)
      )
    })
    await page.evaluateOnNewDocument(fakeMicrophone, toneWav())
    const host = new URL(f.h.origin).hostname
    await browser.setCookie({
      name: 'ts_session',
      value: f.h.tokens.get(101)!,
      domain: host,
      path: '/',
      httpOnly: true
    })
    const tap = async (selector: string): Promise<void> => {
      await waitFor(page, selector)
      await m.tapOn({ css: selector, timeout: 15000 })
    }
    const tessButton = '[role="button"][aria-label="Tess"]'
    const column = '[data-testid="Tess column"]'
    const field = '[aria-label="Ask Tess"]'
    const mic = '[role="button"][aria-label="Dictation"]'
    const heardCount = async (): Promise<number> =>
      await page.evaluate(
        words =>
          Array.from(
            document.querySelectorAll('[data-testid="Tess user message"]')
          ).filter(node => (node.textContent || '').includes(words)).length,
        HEARD
      )
    /** Space down for `ms`, then up. */
    const press = async (ms: number): Promise<void> => {
      await page.keyboard.down('Space')
      await pause(ms)
      await page.keyboard.up('Space')
    }
    /**
     * Space held 800 ms while the microphone hears a sentence: not listening
     * at 300 ms, listening from 500, and what was heard sent as a message.
     * Returns when it began listening.
     */
    const holdAndHear = async (): Promise<number> => {
      const heardBefore = await heardCount()
      const down = Date.now()
      await page.keyboard.down('Space')
      const playing = page.evaluate(async () => {
        await (window as any).__playClip()
      })
      await pause(300)
      expect(await status(page), 'not yet at 300 ms').equals('Push to talk')
      await waitForStatus(page, 'Listening…', 2000)
      const listening = Date.now() - down
      expect(listening, 'listening from 500 ms').greaterThanOrEqual(500)
      await pause(Math.max(0, 800 - (Date.now() - down)))
      await page.keyboard.up('Space')
      await playing
      await page.waitForFunction(
        (words, count) =>
          Array.from(
            document.querySelectorAll('[data-testid="Tess user message"]')
          ).filter(node => (node.textContent || '').includes(words)).length >
          count,
        { timeout: 30000 },
        HEARD,
        heardBefore
      )
      await page.waitForFunction(
        () => document.querySelector('[data-testid="Tess thinking"]') == null,
        { timeout: 20000 }
      )
      return listening
    }
    /**
     * The focus on the pane's page itself: a press on text in the pane's
     * scroller that nothing focusable holds, then nothing focused.
     */
    const focusPage = async (): Promise<void> => {
      const point = await page.evaluate(() => {
        const scroller = document.querySelector('[data-space-scroller]')
        if (scroller == null) return null
        const focusable =
          'a, button, input, textarea, select, [tabindex], [role="button"], [role="tab"], [role="link"]'
        const text = Array.from(scroller.querySelectorAll('div, span')).find(
          node => {
            const box = node.getBoundingClientRect()
            return (
              node.children.length === 0 &&
              (node.textContent || '').trim() !== '' &&
              node.closest(focusable) == null &&
              box.width > 0 &&
              box.y > 120 &&
              box.y < 600
            )
          }
        )
        if (text == null) return null
        const box = text.getBoundingClientRect()
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      })
      expect(point, 'text on the pane to press').not.equals(null)
      await page.mouse.click(point!.x, point!.y)
      await page.evaluate(() => {
        const active = document.activeElement
        if (active instanceof HTMLElement && active !== document.body)
          active.blur()
      })
      expect(
        await page.evaluate(() => document.activeElement === document.body)
      ).equals(true)
    }

    // The team's Schedule tab, long enough to scroll, beside Tess.
    await page.goto(`${f.h.origin}/`)
    await page.evaluate(() => {
      localStorage.removeItem('tess.columnWidth')
    })
    await m.openBrowser({ url: `${f.h.origin}/teams/${f.teamA}` })
    await tap(paneTab('Schedule'))
    await tap(tessButton)
    await waitFor(page, column)
    await waitFor(page, mic)
    await waitForStatus(page, 'Push to talk')
    expect(await paneScroll(page, 0), 'the pane can scroll').equals(0)
    await page.evaluate(spaceCaption)
    const step = async (text: string): Promise<void> => {
      await page.evaluate(text => {
        ;(window as any).__step(text)
      }, text)
    }
    await step('L8: a quick Space in the field')
    const video = await startVideo(s, out, 'space-hold.mp4')
    await pause(600)

    // L8: a quick Space in the field types a space; nobody listens.
    const begun = t.dictation.begun
    await page.click(field)
    await page.type(field, 'a')
    await press(120)
    await page.type(field, 'b')
    await page.waitForFunction(
      field => {
        const node = document.querySelector<HTMLTextAreaElement>(field)
        return node != null && node.value === 'a b'
      },
      { timeout: 5000 },
      field
    )
    await pause(600)
    expect(await status(page)).equals('Push to talk')
    expect(t.dictation.begun, 'no utterance started').equals(begun)
    console.log('L8 a quick Space in the field typed a space; nothing heard')
    await pause(600)
    const clearField = async (): Promise<void> => {
      await page.$eval(field, node => {
        ;(node as HTMLTextAreaElement).select()
      })
      await page.keyboard.press('Backspace')
      await page.waitForFunction(
        field =>
          document.querySelector<HTMLTextAreaElement>(field)!.value === '',
        { timeout: 5000 },
        field
      )
    }
    // Typed fast, Space rolled into the next letter: Space down, w down,
    // Space up, w up.
    await step('L8: "hello world" with Space rolled into the w')
    await clearField()
    await page.type(field, 'hello')
    await page.keyboard.down('Space')
    await pause(40)
    await page.keyboard.down('w')
    await pause(30)
    await page.keyboard.up('Space')
    await pause(20)
    await page.keyboard.up('w')
    await page.type(field, 'orld')
    await page.waitForFunction(
      field => {
        const node = document.querySelector<HTMLTextAreaElement>(field)
        return node != null && node.value === 'hello world'
      },
      { timeout: 5000 },
      field
    )
    await pause(600)
    expect(await status(page)).equals('Push to talk')
    expect(t.dictation.begun, 'no utterance started').equals(begun)
    console.log('L8 "hello world" with Space rolled into the w typed in order')
    await pause(600)
    // Cleared, so what is heard next is sent as a message of its own.
    await clearField()
    // Held there, it listens instead.
    await step('L8: Space held 800 ms in the field')
    await pause(600)
    const inField = await holdAndHear()
    expect(t.dictation.begun).equals(begun + 1)
    expect(
      await page.$eval(field, node => (node as HTMLTextAreaElement).value)
    ).equals('')
    console.log(
      `L8 held 800 ms in the field: listening after ${inField} ms; "${HEARD}" was sent`
    )
    await pause(800)

    // L9: a quick Space on the pane's focused Team tab activates it.
    await step('L9: a quick Space on the focused Team tab')
    await page.evaluate(selector => {
      const tab = Array.from(
        document.querySelectorAll<HTMLElement>(selector)
      ).find(node => node.getBoundingClientRect().x >= 400)
      if (tab == null) throw new Error('No Team tab in the pane')
      tab.focus()
    }, paneTab('Team'))
    const topBefore = await paneScroll(page)
    await press(120)
    await page.waitForFunction(
      selector => {
        const tab = document.querySelector(selector)
        return tab != null && tab.getAttribute('aria-selected') === 'true'
      },
      { timeout: 10000 },
      paneTab('Team')
    )
    await pause(600)
    const scrolled = await page.evaluate(() => {
      const node = document.querySelector('[data-space-scroller]')
      return node == null || !node.isConnected ? null : node.scrollTop
    })
    // The Schedule list may have gone with its tab; if it stayed, it did not move.
    if (scrolled != null) expect(scrolled).equals(topBefore)
    expect(await status(page)).equals('Push to talk')
    expect(t.dictation.begun, 'no utterance started').equals(begun + 1)
    console.log(
      'L9 a quick Space on the Team tab switched to it; nothing heard'
    )
    await pause(600)

    // L10: held 800 ms on the pane's page, while the microphone hears a
    // sentence, Space listens from 500 ms.
    await tap(paneTab('Schedule'))
    await page.evaluate(() => {
      const node = document.querySelector('[data-space-scroller]')
      if (node != null) node.removeAttribute('data-space-scroller')
    })
    await pause(600)
    expect(await paneScroll(page, 0), 'the pane can scroll').equals(0)
    await focusPage()
    await step('L10: Space held 800 ms on the page')
    await pause(600)
    const listening = await holdAndHear()
    expect(t.dictation.begun).equals(begun + 2)
    expect(t.dictation.heard.at(-1)).equals(HEARD)
    expect(await paneScroll(page), 'the hold scrolled nothing').equals(0)
    console.log(
      `L10 held 800 ms: listening after ${listening} ms; "${HEARD}" was sent`
    )
    await pause(800)

    // Push-to-talk switched off: the same hold is the page's.
    await waitForStatus(page, 'Push to talk')
    const micBox = await page.$eval(mic, node => {
      const box = node.getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    })
    await step('L10: push-to-talk off')
    await page.mouse.click(micBox.x, micBox.y)
    await waitForStatus(page, null)
    await focusPage()
    await step('L10: push-to-talk off, Space held 800 ms')
    await pause(600)
    await press(800)
    await pause(800)
    const topOff = await paneScroll(page)
    expect(topOff, 'Space scrolled the pane').greaterThan(0)
    expect(t.dictation.begun, 'no utterance started').equals(begun + 2)
    expect(await status(page)).equals(null)
    console.log(
      `L10 push-to-talk off: the hold scrolled the pane to ${topOff}; nothing heard`
    )
    await pause(1500)
    await video.stop()
    await contains(page, HEARD)

    if (process.env.TS_DIRECT_BROWSER_COVERAGE != null)
      await recordBrowserCoverage(
        [page],
        f.h.origin,
        resolve(process.env.TS_DIRECT_BROWSER_COVERAGE),
        webRoot
      )
    console.log('Tess Space hold scenarios passed')
  } catch (error) {
    if (s != null) {
      await s.page
        .screenshot({
          path: join(out, 'support', 'tess-space-hold-failure.png')
        })
        .catch(() => undefined)
      console.error(
        'Labels on the page:',
        await s.page
          .evaluate(() =>
            Array.from(document.querySelectorAll('[aria-label]'))
              .map(node => node.getAttribute('aria-label'))
              .join(' | ')
          )
          .catch(() => '')
      )
    }
    throw error
  } finally {
    await s?.browser.disconnect().catch(() => undefined)
    await s?.m.detach().catch(() => undefined)
    await daemon.shutdown().catch(() => undefined)
    await t.close()
  }
}

/**
 * A recording of the window: maestro-d's, or, where maestro-d cannot record
 * a web page, the browser's own screencast, made into an H.264 MP4.
 */
async function startVideo(
  s: BrowserSession,
  out: string,
  name: string
): Promise<{ stop: () => Promise<void> }> {
  const path = join(out, name)
  const mm = s.m as unknown as {
    startRecording: (args: { path: string }) => Promise<unknown>
    stopRecording: (args: { path: string }) => Promise<unknown>
  }
  try {
    await mm.startRecording({ path })
    console.log('Recording with maestro-d', name)
    return {
      stop: async () => {
        await mm.stopRecording({ path })
      }
    }
  } catch (error) {
    console.log(
      'maestro-d does not record a web page; recording the browser screencast',
      String(error).slice(0, 160)
    )
    const raw = join(out, 'support', name.replace(/\.mp4$/, '.webm'))
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- `record` needs a newer browser than the one maestro-d starts
    const recorder = await s.page.screencast({
      path: raw as `${string}.webm`
    })
    return {
      stop: async () => {
        await recorder.stop()
        execFileSync(process.env.TS_FFMPEG ?? 'ffmpeg', [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          raw,
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          path
        ])
        await rm(raw, { force: true })
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
