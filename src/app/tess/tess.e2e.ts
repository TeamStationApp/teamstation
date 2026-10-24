/* eslint-disable @typescript-eslint/prefer-optional-chain, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- Serialized browser callbacks cannot capture Sucrase's generated helper functions. */
import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import type { Page } from 'puppeteer'

import { fakeMicrophone } from '../../test/fakeMicrophone.e2e'
import {
  type BrowserSession,
  browserSession,
  capture,
  contains,
  maestro
} from '../../test/refinementsMaestro.e2e'
import { HEARD, type TessFixture, tessFixture } from '../../test/tessFixture'
import { recordBrowserCoverage } from '../browserCoverage.e2e'

/**
 * Tess on a wide browser window (Chromium, 1280 × 900), driven through
 * maestro-d with puppeteer beside it for what a test reads back: the split,
 * links into the pane, rich HTML that loads nothing remote, the 3-second
 * hold, attachments, the microphone, the narrow layout and Back, and the
 * screens that hide her. The model is `fakeAnthropic`; nothing is paid for.
 *
 * `TS_UI_BEFORE=1` runs W1 alone against the base build
 * (`TS_TESS_WEB_ROOT`), asserting the header without Tess, and saves its
 * shot with the `-before` suffix.
 */

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const HEADER_BUTTONS = ['Umpire schedule', 'Tess', 'Notifications']

/** One second of a 440 Hz tone, 16 kHz mono, as a base64 WAV. */
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

/** A 2 × 2 PNG, for the Choose files step. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64'
)

async function pause(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function rectOf(page: Page, selector: string): Promise<Rect | null> {
  return await page.evaluate(selector => {
    const node = document.querySelector(selector)
    if (node == null) return null
    const box = node.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height }
  }, selector)
}

/** The right pane: the element after Tess's column, or the whole root. */
async function paneRect(page: Page): Promise<Rect | null> {
  return await page.evaluate(() => {
    const column = document.querySelector('[data-testid="Tess column"]')
    const pane = column == null ? null : column.nextElementSibling
    if (pane == null) return null
    const box = pane.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height }
  })
}

async function headerButtons(page: Page): Promise<string[]> {
  return await page.evaluate(
    (wanted: string[]) =>
      Array.from(document.querySelectorAll('[role="button"][aria-label]'))
        .map(node => node.getAttribute('aria-label') || '')
        .filter(label => wanted.includes(label)),
    HEADER_BUTTONS
  )
}

async function waitFor(
  page: Page,
  selector: string,
  timeout = 20000
): Promise<void> {
  await page.waitForSelector(selector, { timeout })
}

async function gone(page: Page, selector: string): Promise<void> {
  await page.waitForFunction(
    selector => document.querySelector(selector) == null,
    { timeout: 20000 },
    selector
  )
}

async function main(): Promise<void> {
  const out = resolve(
    process.env.TS_ARTIFACTS_DIR ?? 'artifacts/202610231030-tessAiHelper'
  )
  const before = process.env.TS_UI_BEFORE === '1'
  const suffix = before ? 'before' : 'after'
  const webRoot = resolve(process.env.TS_TESS_WEB_ROOT ?? 'dist')
  await mkdir(join(out, 'support'), { recursive: true })
  const t = await tessFixture({ webRoot })
  const { f } = t
  let other: TessFixture | undefined
  const daemon = await maestro(process.env.MAESTRO_D ?? 'tess-wide')
  let s: BrowserSession | undefined
  try {
    s = await browserSession(
      daemon,
      'tess-wide-chromium',
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
    const identity = async (
      fixture: TessFixture,
      id: number
    ): Promise<void> => {
      await browser.setCookie({
        name: 'ts_session',
        value: '',
        expires: 1,
        domain: host,
        path: '/'
      })
      await browser.setCookie({
        name: 'ts_session',
        value: fixture.f.h.tokens.get(id)!,
        domain: host,
        path: '/',
        httpOnly: true
      })
    }
    const open = async (path: string, origin = f.h.origin): Promise<void> => {
      console.log('Open', path)
      await m.openBrowser({ url: origin + path })
    }
    const shot = async (name: string): Promise<void> => {
      await capture(m, out, name)
      console.log('Saved', name)
    }
    const tap = async (selector: string): Promise<void> => {
      await waitFor(page, selector)
      await m.tapOn({ css: selector, timeout: 15000 })
    }
    const tessButton = '[role="button"][aria-label="Tess"]'
    const column = '[data-testid="Tess column"]'
    const layer = '[data-testid="Tess layer"]'
    const chat = '[data-testid="Tess chat"]'
    const field = '[aria-label="Ask Tess"]'
    const say = async (words: string, answered: string): Promise<void> => {
      await waitFor(page, field)
      await page.click(field)
      await page.type(field, words)
      await page.keyboard.press('Enter')
      await contains(page, answered)
      await page.waitForFunction(
        () => document.querySelector('[data-testid="Tess thinking"]') == null,
        { timeout: 20000 }
      )
    }
    const userBubbles = async (words: string): Promise<number> =>
      await page.evaluate(
        words =>
          Array.from(
            document.querySelectorAll('[data-testid="Tess user message"]')
          ).filter(node => (node.textContent || '').includes(words)).length,
        words
      )

    // W1: the header's buttons, as user 101 (an umpire) and user 102.
    await identity(t, 101)
    await open('/')
    await waitFor(page, '[role="button"][aria-label="Notifications"]')
    await waitFor(page, '[role="button"][aria-label="Umpire schedule"]')
    if (!before) await waitFor(page, tessButton)
    // Health is asked once a session is known; give the header that long.
    await pause(1500)
    expect(await headerButtons(page)).deep.equals(
      before
        ? ['Umpire schedule', 'Notifications']
        : ['Umpire schedule', 'Tess', 'Notifications']
    )
    await shot(`header-wide-${suffix}.png`)
    await identity(t, 102)
    await open('/')
    await waitFor(page, '[role="button"][aria-label="Notifications"]')
    if (!before) await waitFor(page, tessButton)
    await pause(1500)
    expect(await headerButtons(page)).deep.equals(
      before ? ['Notifications'] : ['Tess', 'Notifications']
    )
    console.log('W1 header order passed', suffix)
    if (before) return

    // W2: the split.
    await identity(t, 101)
    await open('/')
    await tap(tessButton)
    await waitFor(page, column)
    const split = {
      column: await rectOf(page, column),
      pane: await paneRect(page)
    }
    expect(split.column).deep.include({ x: 0, width: 400 })
    expect(split.pane).deep.include({ x: 400, width: 880 })
    await contains(page, 'Your Home')
    await contains(page, 'Ask Tess')
    await shot('wide-split.png')
    console.log('W2 split passed', JSON.stringify(split))

    // W3: the team screen's breakpoint, and the video kept playing.
    await tap(tessButton)
    await gone(page, column)
    await open(`/teams/${f.teamA}`)
    await waitFor(page, '[data-breakpoint]')
    const breakpointNow = async (): Promise<string | null> =>
      await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('[data-breakpoint]'))
        const last = nodes[nodes.length - 1]
        return last == null ? null : last.getAttribute('data-breakpoint')
      })
    expect(await breakpointNow()).equals('desktop')
    await tap(tessButton)
    await waitFor(page, column)
    await page.waitForFunction(
      () => {
        const nodes = Array.from(document.querySelectorAll('[data-breakpoint]'))
        const last = nodes[nodes.length - 1]
        return last != null && last.getAttribute('data-breakpoint') === 'tablet'
      },
      { timeout: 10000 }
    )
    console.log('W3 team screen: desktop closed, tablet beside Tess')
    await open(`/games/${t.games.may3}?tab=watch&video=${t.videos.homePlate}`)
    await waitFor(page, '[aria-label="Home plate"]', 30000)
    await tap('[aria-label="Home plate"]')
    await waitFor(page, 'video', 30000)
    await tap('video')
    await page.evaluate(async () => {
      const video = document.querySelector('video')!
      if (video.paused) await video.play()
    })
    await page.waitForFunction(
      () => {
        const video = document.querySelector('video')
        return video != null && !video.paused && video.currentTime > 2
      },
      { timeout: 30000 }
    )
    const playing = await page.evaluate(() => {
      const video = document.querySelector('video') as any
      video.__tessMarker = 'kept'
      return video.currentTime as number
    })
    await tap(tessButton)
    await waitFor(page, column)
    await pause(2000)
    const after = await page.evaluate(() => {
      const video = document.querySelector('video') as any
      return {
        marker: video == null ? null : video.__tessMarker,
        time: video == null ? 0 : (video.currentTime as number),
        paused: video == null ? true : (video.paused as boolean)
      }
    })
    expect(after.marker, 'the same video element').equals('kept')
    expect(after.time).greaterThan(playing)
    expect(after.paused).equals(false)
    await shot('wide-video-kept.png')
    console.log('W3 video kept', playing, '->', after.time)

    // W4: the way bubble.
    await open('/')
    await tap(tessButton)
    await waitFor(page, column)
    await say('Where are my team settings?', "Your team's settings are here")
    const bubble =
      '[role="link"][aria-label="Go to Home, Demo Hawks, Settings"]'
    await waitFor(page, bubble)
    await shot('wide-way-bubble.png')
    console.log('W4 way bubble passed')

    // W5: the bubble opens team settings in the pane; the chat stays.
    await tap(bubble)
    await page.waitForFunction(
      path => location.pathname === path,
      { timeout: 15000 },
      t.links.teamSettings
    )
    await waitFor(page, column)
    await pause(1000)
    await shot('wide-deep-link-navigated.png')
    console.log('W5 deep link passed', t.links.teamSettings)

    // W6: an angle link opens the multi-angle view over the pane only.
    await say(
      'Give me the first-base angle from the May 3 game',
      'Here is the May 3 game from first base'
    )
    await page.evaluate(() => {
      const link = Array.from(document.querySelectorAll('[role="link"]')).find(
        node => node.textContent === 'First base, May 3'
      ) as HTMLElement | undefined
      if (link == null) throw new Error('No angle link')
      link.setAttribute('data-tess-angle-link', '1')
    })
    await tap('[data-tess-angle-link="1"]')
    await page.waitForFunction(
      () =>
        location.search.includes('video=') &&
        location.search.includes('angles='),
      { timeout: 15000 }
    )
    const overlay = await page.waitForFunction(
      () => {
        const fixed = Array.from(document.body.children).find(node => {
          const style = getComputedStyle(node)
          return (
            style.position === 'fixed' && node.querySelector('video') != null
          )
        })
        if (fixed == null) return null
        const box = fixed.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height }
      },
      { timeout: 30000 }
    )
    const angleBox = (await overlay.jsonValue()) as Rect
    const paneNow = await paneRect(page)
    expect(angleBox).deep.equals(paneNow)
    expect(await rectOf(page, column)).deep.include({ x: 0, width: 400 })
    await pause(1500)
    await shot('wide-angle-link.png')
    console.log('W6 angle overlay equals pane', JSON.stringify(angleBox))
    await page.keyboard.press('Escape')
    await open('/')
    await tap(tessButton)
    await waitFor(page, column)

    // W7: a chart, opened over the pane; nothing remote loads.
    await say('Chart our runs per game', "Demo Hawks' runs per game")
    await waitFor(page, '[data-testid="Tess rich block"]')
    await pause(1000)
    await tap('[role="button"][aria-label="Open full screen"]')
    await waitFor(
      page,
      '[data-testid="Tess overlay"] [data-testid="Tess rich viewer"]'
    )
    const viewer = await rectOf(page, '[data-testid="Tess overlay"]')
    expect(viewer).deep.equals(await paneRect(page))
    // The chat stays usable beside it.
    await page.click(field)
    await page.type(field, 'still here')
    expect(
      await page.$eval(field, node => (node as HTMLTextAreaElement).value)
    ).equals('still here')
    await page.evaluate(selector => {
      document.querySelector<HTMLTextAreaElement>(selector)!.select()
    }, field)
    await page.keyboard.press('Backspace')
    await pause(1000)
    await shot('wide-chart-overlay.png')
    await tap(
      '[data-testid="Tess overlay"] [role="button"][aria-label="Close"]'
    )
    await gone(page, '[data-testid="Tess rich viewer"]')
    const beaconCount = async (): Promise<number> =>
      (
        (await (await fetch(`${f.h.origin}/__tess/beacon-count`)).json()) as {
          count: number
        }
      ).count
    expect(await beaconCount()).equals(0)
    await writeFile(
      join(out, 'remote-load-blocked.log'),
      [
        '# W7 (Chromium, wide): after the chart card and its viewer rendered',
        '$ curl -s <origin>/__tess/beacon-count',
        JSON.stringify({ count: await beaconCount() }),
        ''
      ].join('\n')
    )
    console.log('W7 chart over the pane; beacon 0')

    // W7b: with the chart open over the pane, the way bubble from W4 closes
    // it and the pane shows team settings.
    await tap('[role="button"][aria-label="Open full screen"]')
    await waitFor(
      page,
      '[data-testid="Tess overlay"] [data-testid="Tess rich viewer"]'
    )
    await page.$eval(bubble, node => {
      node.scrollIntoView({ block: 'center' })
    })
    await pause(500)
    await tap(bubble)
    await page.waitForFunction(
      path => location.pathname === path,
      { timeout: 15000 },
      t.links.teamSettings
    )
    await gone(page, '[data-testid="Tess overlay"]')
    await contains(page, 'Team Settings')
    expect(await rectOf(page, column)).deep.include({ x: 0, width: 400 })
    console.log('W7b the bubble closed the chart; the pane shows team settings')

    // W7c: with the multi-angle view filling the pane, the chart still opens
    // over it, and its X is what a tap at the X reaches.
    await page.evaluate(() => {
      const link = Array.from(document.querySelectorAll('[role="link"]')).find(
        node => node.textContent === 'First base, May 3'
      ) as HTMLElement | undefined
      if (link == null) throw new Error('No angle link')
      link.scrollIntoView({ block: 'center' })
      link.setAttribute('data-tess-angle-link', '2')
    })
    await tap('[data-tess-angle-link="2"]')
    await page.waitForFunction(
      () =>
        Array.from(document.body.children).some(
          node =>
            getComputedStyle(node).position === 'fixed' &&
            node.querySelector('video') != null
        ),
      { timeout: 30000 }
    )
    await page.$eval('[role="button"][aria-label="Open full screen"]', node => {
      node.scrollIntoView({ block: 'center' })
    })
    await tap('[role="button"][aria-label="Open full screen"]')
    await waitFor(
      page,
      '[data-testid="Tess overlay"] [data-testid="Tess rich viewer"]'
    )
    const closeOnTop = await page.$eval(
      '[data-testid="Tess overlay"] [role="button"][aria-label="Close"]',
      node => {
        const box = node.getBoundingClientRect()
        const hit = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2
        )
        return hit != null && node.contains(hit)
      }
    )
    expect(closeOnTop, 'the X over the angle view').equals(true)
    await tap(
      '[data-testid="Tess overlay"] [role="button"][aria-label="Close"]'
    )
    await gone(page, '[data-testid="Tess rich viewer"]')
    await page.keyboard.press('Escape')
    console.log('W7c the chart opens over the angle view; its X is on top')
    await open('/')
    await tap(tessButton)
    await waitFor(page, column)

    // W8–W10: the change card and the 3-second hold.
    const gamesOfTeam = async (): Promise<number> => {
      const answer = await f.h.request('GET', `/teams/${f.teamA}/games`)
      expect(answer.status).equals(200)
      const body = (await answer.json()) as unknown
      return Array.isArray(body)
        ? body.length
        : ((body as { games: unknown[] }).games ?? []).length
    }
    const gamesBefore = await gamesOfTeam()
    await say(
      'Add a game against Demo Eagles Saturday at 10',
      'Hold Confirm on the card to add the game.'
    )
    await waitFor(page, '[data-testid="Tess change"]')
    const card = await page.$eval(
      '[data-testid="Tess change"]',
      node => node.textContent || ''
    )
    expect(card).includes('Add a home game against Demo Eagles')
    expect(card).includes(`POST /teams/${f.teamA}/games`)
    expect(card).includes('"opponent"')
    const hold = '[role="button"][aria-label="Hold to confirm"]'
    await waitFor(page, hold)
    await shot('wide-change-card.png')
    console.log('W8 change card passed')

    const video = await startVideo(s, out, 'wide-confirm-trace.mp4')
    const holdBox = (await rectOf(page, hold))!
    const center = {
      x: holdBox.x + holdBox.width / 2,
      y: holdBox.y + holdBox.height / 2
    }
    const traceOffset = async (): Promise<number> =>
      await page.evaluate(() => {
        const trace = document.querySelector('[data-testid="Tess hold trace"]')
        return trace == null
          ? -1
          : Number.parseFloat(trace.getAttribute('stroke-dashoffset') || '-1')
      })
    const fullOffset = await traceOffset()
    await page.mouse.move(center.x, center.y)
    await page.mouse.down()
    await pause(1000)
    const midway = await traceOffset()
    await page.mouse.up()
    await pause(400)
    expect(midway).lessThan(fullOffset)
    expect(await traceOffset()).equals(fullOffset)
    expect(await gamesOfTeam()).equals(gamesBefore)
    console.log('W9 early release reset the trace; nothing ran')
    await pause(600)
    await page.mouse.down()
    await pause(1500)
    // The browser's own shot: maestro-d's waits for animation to end, and the
    // trace is an animation that ends by running the change.
    await page.screenshot({ path: join(out, 'wide-confirm-holding.png') })
    console.log('Saved wide-confirm-holding.png')
    await pause(1900)
    await page.mouse.up()
    await contains(page, 'Done: the game against Demo Eagles')
    await page.waitForFunction(
      () => {
        const status = document.querySelector(
          '[data-testid="Tess change status"]'
        )
        return status != null && status.textContent === 'Done'
      },
      { timeout: 20000 }
    )
    expect(await gamesOfTeam()).equals(gamesBefore + 1)
    await pause(800)
    await shot('wide-confirm-done.png')
    await video.stop()
    console.log('W10 held 3 s: Done, and the game exists')

    // W11: drop a CSV, choose a PNG, send both.
    await tap('[role="button"][aria-label="Attach a file"]')
    await waitFor(page, '[data-testid="Tess drop zone"]')
    await shot('wide-attach-panel.png')
    await page.evaluate(() => {
      const zone = document.querySelector('[data-testid="Tess drop zone"]')!
      const data = new DataTransfer()
      data.items.add(
        new File(['game,runs\n1,5\n2,2\n'], 'stats.csv', { type: 'text/csv' })
      )
      zone.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: data,
          bubbles: true,
          cancelable: true
        })
      )
    })
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="Tess attachment"]').length >=
        1,
      { timeout: 15000 }
    )
    const pngPath = join(out, 'support', 'tess-logo.png')
    await writeFile(pngPath, PNG)
    if ((await page.$('[data-testid="Tess drop zone"]')) == null)
      await tap('[role="button"][aria-label="Attach a file"]')
    const [chooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 15000 }),
      m.tapOn({ text: 'Choose files', role: 'button', timeout: 15000 })
    ])
    await chooser.accept([pngPath])
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="Tess attachment"]').length >=
        2,
      { timeout: 15000 }
    )
    const callsBefore = t.model.calls.length
    await say('Here are our stats', 'I have your CSV and your picture')
    const sentWith = t.model.calls
      .slice(callsBefore)
      .find(call => call.request?.said === 'Here are our stats')
    expect(sentWith, 'the model was asked').not.equals(undefined)
    const last = sentWith!.request!.messages.at(-1)!
    const blocks = Array.isArray(last.content) ? last.content : []
    expect(blocks.map(block => block.type)).deep.equals([
      'text',
      'text',
      'image',
      'text'
    ])
    expect(String(blocks[1].text)).includes('stats.csv')
    // The message ends with when it was sent and the page beside the chat.
    expect(String(blocks[3].text)).match(/^\(Sent .*Beside this chat/)
    console.log('W11 both attachments reached the model')

    // W12: the microphone, twice.
    const mic = '[role="button"][aria-label="Dictation"]'
    await waitFor(page, mic)
    await page.waitForFunction(
      () => {
        const status = document.querySelector('[aria-label="Dictation status"]')
        return status != null && status.textContent === 'Push to talk'
      },
      { timeout: 20000 }
    )
    const voice = await startVideo(s, out, 'wide-voice.mp4')
    for (let time = 1; time <= 2; time++) {
      const heardBefore = await userBubbles(HEARD)
      const micBox = (await rectOf(page, mic))!
      await page.mouse.move(
        micBox.x + micBox.width / 2,
        micBox.y + micBox.height / 2
      )
      await page.mouse.down()
      await page.waitForFunction(
        () => {
          const status = document.querySelector(
            '[aria-label="Dictation status"]'
          )
          return status != null && status.textContent === 'Listening…'
        },
        { timeout: 10000 }
      )
      await page.evaluate(async () => {
        await (window as any).__playClip()
      })
      await pause(400)
      await page.mouse.up()
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
      await pause(800)
      console.log(`W12 hold ${time}: the transcript became a message`)
    }
    await voice.stop()
    expect(t.dictation.heard.filter(heard => heard === HEARD)).length(2)

    // W13: off topic, declined with no tool.
    await say('Write me a poem about cats', 'I can only help with finding')
    const poem = t.model.calls.filter(call =>
      (call.request?.said ?? '').includes('poem about cats')
    )
    expect(poem).length(1)
    expect(poem[0].stopReason).equals('end_turn')
    await shot('wide-off-topic.png')
    console.log('W13 off-topic declined without a tool')

    // W14: a scoring write is refused before any card.
    const cardsBefore = await page.$$eval(
      '[data-testid="Tess change"]',
      nodes => nodes.length
    )
    await say('Record a strike for the batter', 'I cannot record plays')
    const strike = t.model.calls.filter(call =>
      (call.request?.said ?? '').includes('Record a strike')
    )
    const refusal = strike
      .flatMap(call => call.request?.messages.slice(-1) ?? [])
      .flatMap(message =>
        Array.isArray(message.content) ? message.content : []
      )
      .find(block => block.type === 'tool_result')
    expect(refusal, 'the tool result').not.equals(undefined)
    expect(refusal!.is_error).equals(true)
    expect(String(refusal!.content)).includes('may not change live scoring')
    expect(
      await page.$$eval('[data-testid="Tess change"]', nodes => nodes.length)
    ).equals(cardsBefore)
    await writeFile(
      join(out, 'scoring-refused.log'),
      [
        '# W14: "Record a strike for the batter"; the fake model proposed',
        `# confirmChange POST /games/${t.games.may3}/events. The tool result sent back:`,
        '$ curl -s -b ts_session=… <origin>/__tess/requests',
        JSON.stringify(
          strike.map(call => ({
            said: call.request?.said,
            round: call.request?.round,
            ...(call.request?.round === 1
              ? { proposed: call.request.messages.at(-2) }
              : {}),
            lastMessage: call.request?.messages.at(-1)
          })),
          null,
          2
        ),
        `# change cards before: ${cardsBefore}, after: ${cardsBefore}`,
        ''
      ].join('\n')
    )
    console.log('W14 scoring write refused, no card')

    // W15, W15b: narrow and back, and Back at 1024.
    const messageCount = async (): Promise<number> =>
      await page.$$eval(
        '[data-testid="Tess user message"], [data-testid="Tess reply"]',
        nodes => nodes.length
      )
    const shown = await messageCount()
    await page.setViewport({ width: 1024, height: 900 })
    await waitFor(page, layer)
    expect(await rectOf(page, layer)).deep.equals({
      x: 0,
      y: 0,
      width: 1024,
      height: 900
    })
    await page.setViewport({ width: 1280, height: 900 })
    await waitFor(page, column)
    await page.waitForFunction(
      count =>
        document.querySelectorAll(
          '[data-testid="Tess user message"], [data-testid="Tess reply"]'
        ).length >= count,
      { timeout: 20000 },
      shown
    )
    await page.setViewport({ width: 1024, height: 900 })
    await waitFor(page, layer)
    await tap('[role="button"][aria-label="Close Tess"]')
    await gone(page, chat)
    await contains(page, 'Your Home')
    console.log('W15 1024 full screen, 1280 split, closed at 1024')
    // Into a team from Home, inside the app, so Back has a step of its own
    // to take: f.teamA, the Demo Hawks with a season.
    await tap('[role="button"][aria-label^="Demo Hawks, Demo Regular"]')
    await page.waitForFunction(
      team => location.pathname === `/teams/${team}`,
      { timeout: 20000 },
      f.teamA
    )
    await tap(tessButton)
    await waitFor(page, layer)
    const address = await page.evaluate(() => location.href)
    await page.evaluate(() => {
      history.back()
    })
    await gone(page, chat)
    await pause(800)
    expect(await page.evaluate(() => location.href)).equals(address)
    await contains(page, 'Demo Hawks')
    console.log('W15b Back closed the chat; the address stayed', address)

    // W15c: Space in the pane is the page's, not the microphone's. On the
    // team's Schedule tab, long enough to scroll, Tab reaches the Team pill;
    // Space scrolls the pane (react-native-web activates a tab with Enter,
    // and Space only on buttons), and Enter switches the tab. Tess takes
    // neither: no utterance starts, and Space's default is not prevented.
    await page.setViewport({ width: 1280, height: 900 })
    await tap('[role="tab"][aria-label="Schedule"]')
    await tap(tessButton)
    await waitFor(page, column)
    await page.evaluate(() => {
      const seen = { prevented: [] as boolean[] }
      ;(window as any).__space = seen
      window.addEventListener('keydown', event => {
        if (event.code === 'Space') seen.prevented.push(event.defaultPrevented)
      })
    })
    const begun = t.dictation.begun
    let focused = false
    for (let press = 0; press < 80 && !focused; press++) {
      await page.keyboard.press('Tab')
      focused = await page.evaluate(() => {
        const active = document.activeElement
        return (
          active != null &&
          active.getAttribute('role') === 'tab' &&
          active.getAttribute('aria-label') === 'Team' &&
          active.getBoundingClientRect().x >= 400
        )
      })
    }
    expect(focused, "Tab reached the pane's Team pill").equals(true)
    const scrollTop = async (reset = false): Promise<number> =>
      await page.evaluate(reset => {
        let node = document.activeElement as HTMLElement | null
        while (node != null) {
          const style = getComputedStyle(node)
          if (
            ['auto', 'scroll'].includes(style.overflowY) &&
            node.scrollHeight > node.clientHeight
          ) {
            // From the top, so there is room for Space to move it.
            if (reset) node.scrollTop = 0
            return node.scrollTop
          }
          node = node.parentElement
        }
        return -1
      }, reset)
    const topBefore = await scrollTop(true)
    await page.keyboard.press('Space')
    await pause(800)
    const topAfter = await scrollTop()
    expect(topBefore, 'the pane can scroll').greaterThan(-1)
    expect(topAfter, 'Space scrolled the pane').greaterThan(topBefore)
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () => {
        const tab = Array.from(document.querySelectorAll('[role="tab"]')).find(
          node => node.getAttribute('aria-label') === 'Team'
        )
        return tab != null && tab.getAttribute('aria-selected') === 'true'
      },
      { timeout: 10000 }
    )
    expect(
      await page.evaluate(() => (window as any).__space.prevented)
    ).deep.equals([false])
    expect(t.dictation.begun, 'no utterance started').equals(begun)
    expect(
      await page.$eval(
        '[aria-label="Dictation status"]',
        node => node.textContent
      )
    ).equals('Push to talk')
    console.log(
      'W15c Space scrolled the pane',
      topBefore,
      '->',
      topAfter,
      'and Enter switched to Team; no utterance started'
    )

    // W16: the week's usage.
    const usage = await f.h.request('GET', '/me/tess/usage')
    expect(usage.status).equals(200)
    const weeks = (
      (await usage.json()) as {
        weeks: Array<{
          weekStart: string
          inputTokens: number
          outputTokens: number
          requests: number
        }>
      }
    ).weeks
    const totals = t.model.totals()
    expect(weeks).length(1)
    expect(weeks[0]).deep.include({
      inputTokens: totals.input,
      outputTokens: totals.output,
      requests: totals.requests
    })
    await writeFile(
      join(out, 'usage-week.log'),
      [
        '# W16, after W1–W15c. The fake model answered every Messages call with',
        `# ${totals.requests} calls; their input and output tokens add up to ${totals.input} and ${totals.output}.`,
        '$ curl -s -b ts_session=… <origin>/api/v1/me/tess/usage',
        JSON.stringify({ weeks }, null, 2),
        ''
      ].join('\n')
    )
    console.log('W16 usage week matches', JSON.stringify(totals))

    // W18: scoring takes the window; DJ on the web keeps Tess.
    await open(`/games/${t.games.scheduled}`)
    await waitFor(page, tessButton, 30000)
    await tap(tessButton)
    await waitFor(page, column)
    await say('Take me to score the next game', 'Here is the scoring screen')
    await page.evaluate(() => {
      const link = Array.from(document.querySelectorAll('[role="link"]')).find(
        node => node.textContent === 'Score Demo Hawks vs Demo Eagles'
      )
      if (link == null) throw new Error('No scoring link')
      link.setAttribute('data-tess-score-link', '1')
    })
    await tap('[data-tess-score-link="1"]')
    await page.waitForFunction(
      gameId => location.pathname === `/games/${gameId}/score`,
      { timeout: 20000 },
      t.games.scheduled
    )
    await gone(page, column)
    expect(await page.$(tessButton)).equals(null)
    await pause(2500)
    await shot('wide-immersive.png')
    await page.evaluate(() => {
      history.back()
    })
    await waitFor(page, column, 30000)
    console.log('W18 scoring hid the column; leaving brought it back')
    await open(`/games/${t.games.scheduled}/dj`)
    await waitFor(page, tessButton, 30000)
    await tap(tessButton)
    await waitFor(page, column)
    await contains(page, 'Demo Hawks')
    console.log('W18 the DJ address on the web shows the game with Tess')

    if (process.env.TS_DIRECT_BROWSER_COVERAGE != null)
      await recordBrowserCoverage(
        [page],
        f.h.origin,
        resolve(process.env.TS_DIRECT_BROWSER_COVERAGE),
        webRoot
      )

    // W17: a server without Tess offers no button.
    other = await tessFixture({ webRoot, tess: false, videos: false })
    await identity(other, 101)
    await open('/', other.f.h.origin)
    await waitFor(page, '[role="button"][aria-label="Notifications"]')
    await pause(2000)
    expect(await page.$(tessButton)).equals(null)
    console.log('W17 no Tess button where the server has none')
    console.log('Tess wide browser scenarios passed')
  } catch (error) {
    // What the page showed when a step failed, kept beside the artifacts.
    if (s != null) {
      await s.page
        .screenshot({ path: join(out, 'support', 'tess-wide-failure.png') })
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
    await other?.close().catch(() => undefined)
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
