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
 * links into the pane, rich HTML that loads nothing remote, a reply's
 * changes as one table and the 2-second hold, attachments, the microphone, the narrow layout and Back, the
 * screens that hide her, the divider that resizes her column, the title and
 * the composer's field, the players she names, and a reply streaming in with
 * her thinking and her steps. The model is `fakeAnthropic`, streaming a
 * piece at a time; nothing is paid for.
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
    const picture = '[role="button"][aria-label^="Account, "]'
    const mark = '[role="button"][aria-label="TeamStation menu"]'
    const closeTess = '[role="button"][aria-label="Close Tess"]'
    // She opens from the mark's menu, and only a tab root has the mark.
    const openTess = async (): Promise<void> => {
      await tap(mark)
      await tap('[role="button"][aria-label="Ask Tess"]')
    }
    // A screen reached inside the app, because a page load closes her.
    const goInApp = async (path: string): Promise<void> => {
      await page.evaluate(path => {
        const state = history.state
        const index = (state == null ? 0 : Number(state.tsRouteIndex)) + 1
        history.pushState({ tsRouteIndex: index }, '', path)
        window.dispatchEvent(
          new PopStateEvent('popstate', { state: history.state })
        )
      }, path)
    }
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

    const expectNoHeaderButtons = async (): Promise<void> => {
      for (const label of ['Tess', 'Notifications'])
        expect(
          await page.$(`[role="button"][aria-label="${label}"]`),
          label
        ).equals(null)
    }
    // W1: the header's mark and picture, as user 101 (an umpire) and user 102.
    await identity(t, 101)
    await open('/')
    await waitFor(page, picture)
    if (!before) await waitFor(page, mark)
    // Health is asked once a session is known; give the header that long.
    await pause(1500)
    if (!before) await expectNoHeaderButtons()
    await shot(`header-wide-${suffix}.png`)
    await identity(t, 102)
    await open('/')
    await waitFor(page, picture)
    if (!before) await waitFor(page, mark)
    await pause(1500)
    if (!before) await expectNoHeaderButtons()
    console.log('W1 header order passed', suffix)
    if (before) return
    // A width a run before this one dragged the column to is not this one's.
    await page.evaluate(() => {
      localStorage.removeItem('tess.columnWidth')
    })

    // W2: the split.
    await identity(t, 101)
    await open('/')
    await openTess()
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
    await tap(closeTess)
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
    await open('/')
    await openTess()
    await waitFor(page, column)
    await goInApp(`/teams/${f.teamA}`)
    await page.waitForFunction(
      () => {
        const nodes = Array.from(document.querySelectorAll('[data-breakpoint]'))
        const last = nodes[nodes.length - 1]
        return last != null && last.getAttribute('data-breakpoint') === 'tablet'
      },
      { timeout: 10000 }
    )
    console.log('W3 team screen: desktop closed, tablet beside Tess')
    await open('/')
    await openTess()
    await waitFor(page, column)
    await goInApp(
      `/games/${t.games.may3}?tab=watch&video=${t.videos.homePlate}`
    )
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
    // Closing her gives the pane the whole window, and the video stays itself.
    await tap(closeTess)
    await gone(page, column)
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
    await openTess()
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
    await openTess()
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
    await openTess()
    await waitFor(page, column)

    // W8–W10: a reply's changes as one table, and the 2-second hold.
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
      'Schedule three games against Demo Eagles on Saturdays at 10',
      'Hold Confirm under the table to schedule all three games.'
    )
    const batch = '[data-testid="Tess changes"]'
    await waitFor(page, batch)
    const tables = await page.$$eval(
      `${batch} [data-testid="Tess change table"]`,
      nodes =>
        nodes.map(node => ({
          head: node.firstElementChild
            ? node.firstElementChild.textContent
            : '',
          rows: Array.from(
            node.querySelectorAll('[data-testid="Tess change"]')
          ).map(row => row.textContent || '')
        }))
    )
    expect(tables).deep.equals([
      {
        head: 'OpponentDateTimeField',
        rows: [
          'Demo EaglesSat May 2210:00 AMDemo Field',
          'Demo EaglesSat May 2910:00 AMDemo Field',
          'Demo EaglesSat Jun 510:00 AMDemo Field'
        ]
      }
    ])
    // No request, and no JSON, until it is asked for.
    const batchText = async (): Promise<string> =>
      await page.$eval(batch, node => node.textContent || '')
    expect(await batchText()).not.includes(`/teams/${f.teamA}/games`)
    expect(await batchText()).not.includes('"opponent"')
    const hold = '[role="button"][aria-label="Hold to confirm"]'
    await waitFor(page, hold)
    expect(await page.$$eval(`${batch} ${hold}`, nodes => nodes.length)).equals(
      1
    )
    await page.$eval(batch, node => {
      node.scrollIntoView({ block: 'center' })
    })
    await pause(1000)
    await shot('web-change-after.png')
    const disclosure = `${batch} [role="button"][aria-expanded]`
    await page.click(disclosure)
    await page.waitForFunction(
      selector => document.querySelectorAll(selector).length === 3,
      { timeout: 5000 },
      '[data-testid="Tess change body"]'
    )
    const requests = await page.$$eval(
      '[data-testid="Tess change request"]',
      nodes => nodes.map(node => node.textContent || '')
    )
    expect(requests).deep.equals(
      Array.from({ length: 3 }, () => `POST /teams/${f.teamA}/games`)
    )
    expect(await batchText()).includes('"opponent"')
    await shot('wide-change-requests.png')
    await page.click(disclosure)
    await gone(page, '[data-testid="Tess change body"]')
    console.log('W8 one table of three games; the requests folded until asked')

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
    console.log('W9 released at 1 s: the trace reset; nothing ran')
    await pause(600)
    await page.mouse.down()
    await pause(1000)
    // The browser's own shot: maestro-d's waits for animation to end, and the
    // trace is an animation that ends by running the changes.
    await page.screenshot({ path: join(out, 'wide-confirm-holding.png') })
    console.log('Saved wide-confirm-holding.png')
    await pause(1400)
    await page.mouse.up()
    await contains(page, 'Done: the three games against Demo Eagles')
    await page.waitForFunction(
      () => document.querySelector('[data-testid="Tess thinking"]') == null,
      { timeout: 20000 }
    )
    await page.waitForFunction(
      () => {
        const statuses = Array.from(
          document.querySelectorAll('[data-testid="Tess change status"]')
        ).map(node => node.textContent)
        return statuses.length === 3 && statuses.every(text => text === 'Done')
      },
      { timeout: 20000 }
    )
    expect(await gamesOfTeam()).equals(gamesBefore + 3)
    // Tess was told of all three in one message, and reported once.
    const reports = t.model.calls.filter(call =>
      (call.request?.said ?? '').startsWith(
        'The user confirmed the change "Add a home game against Demo Eagles on Saturday 22 May'
      )
    )
    expect(reports).length(1)
    const told = (reports[0].request?.messages.at(-1)?.content ?? []) as Array<
      Record<string, unknown>
    >
    expect(
      told.filter(
        block =>
          typeof block.text === 'string' &&
          block.text.startsWith('The user confirmed the change')
      )
    ).length(3)
    expect(
      await page.$$eval(
        '[data-testid="Tess reply"]',
        nodes =>
          nodes.filter(node =>
            (node.textContent || '').includes('Done: the three games')
          ).length
      )
    ).equals(1)
    await pause(800)
    await shot('wide-confirm-done.png')
    await video.stop()

    // Expanded over the pane, the chat beside it.
    await tap('[role="button"][aria-label="Expand the changes over the page"]')
    await waitFor(
      page,
      '[data-testid="Tess overlay"] [data-testid="Tess rich viewer"]'
    )
    expect(await rectOf(page, '[data-testid="Tess overlay"]')).deep.equals(
      await paneRect(page)
    )
    expect(await rectOf(page, column)).deep.include({ x: 0, width: 400 })
    const expandedPage = await page.$eval(
      '[data-testid="Tess overlay"] iframe',
      node => node.getAttribute('srcdoc') || ''
    )
    expect(expandedPage).includes(
      '<th>Opponent</th><th>Date</th><th>Time</th><th>Field</th><th>Status</th>'
    )
    expect(expandedPage).includes('<td>Sat Jun 5</td>')
    await pause(1000)
    await shot('web-change-expanded.png')
    await tap(
      '[data-testid="Tess overlay"] [role="button"][aria-label="Close"]'
    )
    await gone(page, '[data-testid="Tess rich viewer"]')
    console.log(
      'W10 held 2 s: all three Done, the games exist, one report; expanded over the pane'
    )

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
    // to take: f.teamA, the Demo Hawks with a season. Wide, because the mark
    // is only on Home and her layer stops anything moving beneath it.
    const intoTheTeam = async (): Promise<void> => {
      await page.setViewport({ width: 1280, height: 900 })
      await openTess()
      await waitFor(page, column)
      await tap('[role="button"][aria-label^="Demo Hawks, Demo Regular"]')
      await page.waitForFunction(
        team => location.pathname === `/teams/${team}`,
        { timeout: 20000 },
        f.teamA
      )
    }
    await intoTheTeam()
    await page.setViewport({ width: 1024, height: 900 })
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

    // W15c: Space is Tess's only when held. On the team's Schedule tab, long
    // enough to scroll, Tab reaches the pane's Team pill: a quick Space
    // activates it and scrolls nothing; a quick Space in her field types a
    // space; and Space held 800 ms with the focus on the page listens from
    // 500 ms, and what was heard becomes her next message.
    await page.evaluate(() => {
      history.back()
    })
    await page.waitForFunction(() => location.pathname === '/', {
      timeout: 20000
    })
    await intoTheTeam()
    // The team's own pills: until they draw, Schedule is the app's tab.
    await waitFor(page, '[role="tab"][aria-label="Team"]')
    await tap('[role="tab"][aria-label="Schedule"]')
    await waitFor(page, column)
    await page.waitForFunction(
      () => {
        const status = document.querySelector('[aria-label="Dictation status"]')
        return status != null && status.textContent === 'Push to talk'
      },
      { timeout: 20000 }
    )
    await page.evaluate(() => {
      const seen = { prevented: [] as boolean[] }
      ;(window as any).__space = seen
      // Whether Space's default survived, read once the key has gone
      // through: the talk key stops it before it bubbles back up.
      window.addEventListener(
        'keydown',
        event => {
          if (event.code === 'Space')
            setTimeout(() => seen.prevented.push(event.defaultPrevented), 0)
        },
        true
      )
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
    const scroller = await page.evaluate(() => {
      let node = document.activeElement as HTMLElement | null
      while (node != null) {
        const style = getComputedStyle(node)
        if (
          ['auto', 'scroll'].includes(style.overflowY) &&
          node.scrollHeight > node.clientHeight
        ) {
          node.setAttribute('data-w15c-scroller', '')
          node.scrollTop = 0
          return true
        }
        node = node.parentElement
      }
      return false
    })
    expect(scroller, 'the pane can scroll').equals(true)
    const scrollTop = async (): Promise<number> =>
      await page.evaluate(() => {
        const node = document.querySelector('[data-w15c-scroller]')
        return node == null || !node.isConnected ? 0 : node.scrollTop
      })
    await page.keyboard.down('Space')
    await pause(120)
    await page.keyboard.up('Space')
    await page.waitForFunction(
      () => {
        const tab = Array.from(document.querySelectorAll('[role="tab"]')).find(
          node => node.getAttribute('aria-label') === 'Team'
        )
        return tab != null && tab.getAttribute('aria-selected') === 'true'
      },
      { timeout: 10000 }
    )
    await pause(800)
    expect(await scrollTop(), 'Space scrolled nothing').equals(0)
    expect(
      await page.evaluate(() => (window as any).__space.prevented)
    ).deep.equals([true])
    expect(t.dictation.begun, 'no utterance started').equals(begun)
    console.log('W15c a quick Space switched to Team and scrolled nothing')
    // A quick Space in the field types a space.
    await page.click(field)
    await page.type(field, 'a')
    await page.keyboard.down('Space')
    await pause(120)
    await page.keyboard.up('Space')
    await page.type(field, 'b')
    await page.waitForFunction(
      field =>
        document.querySelector<HTMLTextAreaElement>(field)!.value === 'a b',
      { timeout: 5000 },
      field
    )
    expect(t.dictation.begun, 'no utterance started').equals(begun)
    await page.$eval(field, node => {
      ;(node as HTMLTextAreaElement).select()
    })
    await page.keyboard.press('Backspace')
    await page.waitForFunction(
      field => document.querySelector<HTMLTextAreaElement>(field)!.value === '',
      { timeout: 5000 },
      field
    )
    console.log('W15c a quick Space in the field typed a space')
    // Held 800 ms with nothing focused, while the microphone hears a sentence.
    await page.evaluate(() => {
      const active = document.activeElement
      if (active instanceof HTMLElement) active.blur()
    })
    const heardBefore = await userBubbles(HEARD)
    const down = Date.now()
    await page.keyboard.down('Space')
    const saying = page.evaluate(async () => {
      await (window as any).__playClip()
    })
    await pause(300)
    expect(
      await page.$eval(
        '[aria-label="Dictation status"]',
        node => node.textContent
      ),
      'not listening at 300 ms'
    ).equals('Push to talk')
    await page.waitForFunction(
      () => {
        const status = document.querySelector('[aria-label="Dictation status"]')
        return status != null && status.textContent === 'Listening…'
      },
      { timeout: 2000 }
    )
    const listening = Date.now() - down
    expect(listening, 'listening from 500 ms').greaterThanOrEqual(500)
    await pause(Math.max(0, 800 - (Date.now() - down)))
    await page.keyboard.up('Space')
    await saying
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
    expect(t.dictation.begun).equals(begun + 1)
    console.log(
      `W15c Space held 800 ms: listening after ${listening} ms; the transcript became a message`
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
          cacheReadTokens: number
          cacheWriteTokens: number
          requests: number
        }>
      }
    ).weeks
    const totals = t.model.totals()
    expect(weeks).length(1)
    expect(weeks[0]).deep.include({
      inputTokens: totals.input,
      outputTokens: totals.output,
      cacheReadTokens: totals.cacheRead,
      cacheWriteTokens: totals.cacheWrite,
      requests: totals.requests
    })
    expect(totals.cacheRead).above(0)
    expect(totals.cacheWrite).above(0)
    expect(totals.cacheRead).not.equals(totals.cacheWrite)
    // The log has each call's cache reads and writes beside its input.
    const logged = t.tessRequests().filter(row => row.P.it != null)
    expect(logged).length(totals.requests)
    for (const row of logged) {
      expect(row.P.cr).equals(900)
      expect(row.P.cw).equals(300)
    }
    const hitRate = totals.cacheRead / totals.input
    await writeFile(
      join(out, 'usage-week.log'),
      [
        '# W16, after W1–W15c. The fake model answered every Messages call with',
        `# ${totals.requests} calls; their input and output tokens add up to ${totals.input} and ${totals.output},`,
        `# of the input ${totals.cacheRead} read from the cache and ${totals.cacheWrite} written to it: a hit rate of ${(hitRate * 100).toFixed(1)}%.`,
        '$ curl -s -b ts_session=… <origin>/api/v1/me/tess/usage',
        JSON.stringify({ weeks }, null, 2),
        '',
        '# The server log: each Messages call as tess_request, its input (it), output (ot),',
        '# cache reads (cr) and cache writes (cw). Never the text.',
        '$ grep tess_request <server log>',
        ...logged.map(row =>
          JSON.stringify({ E: 'tess_request', L: row.L, P: row.P })
        ),
        ''
      ].join('\n')
    )
    console.log('W16 usage week matches', JSON.stringify(totals))

    // W18: scoring takes the window; DJ on the web keeps Tess.
    await open('/')
    await waitFor(page, mark, 30000)
    await openTess()
    await waitFor(page, column)
    await goInApp(`/games/${t.games.scheduled}`)
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
    expect(await page.$(mark)).equals(null)
    await pause(2500)
    await shot('wide-immersive.png')
    await page.evaluate(() => {
      history.back()
    })
    await waitFor(page, column, 30000)
    console.log('W18 scoring hid the column; leaving brought it back')
    await open('/')
    await waitFor(page, mark, 30000)
    await openTess()
    await waitFor(page, column)
    await goInApp(`/games/${t.games.scheduled}/dj`)
    await contains(page, 'Demo Hawks')
    console.log('W18 the DJ address on the web shows the game with Tess')

    // W19: Stop. After W16, so its usage week adds up without the reply
    // stopped here. While she answers and the field is empty the button is
    // turn on the server, and the reply ends "Stopped" within 2 s. Her next
    // request carries the note that she was stopped.
    await open('/')
    await openTess()
    await waitFor(page, column)
    const stopButton = '[role="button"][aria-label="Stop Tess"]'
    const sendButton = '[role="button"][aria-label="Send"]'
    const stoppedMarks = async (): Promise<number> =>
      await page.$$eval('[data-testid="Tess stopped"]', nodes => nodes.length)
    const marksBefore = await stoppedMarks()
    await waitFor(page, field)
    expect(await page.$(stopButton)).equals(null)
    await page.click(field)
    await page.type(field, 'Plan the whole season')
    await page.keyboard.press('Enter')
    await waitFor(page, '[data-testid="Tess live text"]')
    await waitFor(page, stopButton)
    expect(await page.$(sendButton)).equals(null)
    await page.type(field, 'x')
    await waitFor(page, sendButton)
    expect(await page.$(stopButton)).equals(null)
    expect(
      await page.$eval(sendButton, node => node.getAttribute('aria-disabled'))
    ).equals('true')
    await page.keyboard.press('Backspace')
    await waitFor(page, stopButton)
    await shot('web-stop.png')
    const pressed = Date.now()
    await m.tapOn({ css: stopButton, timeout: 15000 })
    await page.waitForFunction(
      before =>
        document.querySelectorAll('[data-testid="Tess stopped"]').length >
        before,
      { timeout: 2000 },
      marksBefore
    )
    const stoppedMs = Date.now() - pressed
    expect(stoppedMs).lessThan(2000)
    await gone(page, '[data-testid="Tess thinking"]')
    expect(await stoppedMarks()).equals(marksBefore + 1)
    const lastReply = await page.$$eval(
      '[data-testid="Tess reply"]',
      nodes => nodes[nodes.length - 1].textContent || ''
    )
    expect(lastReply.endsWith('Stopped')).equals(true)
    // Send again once a letter is typed and she is done.
    await page.type(field, 'x')
    expect(
      await page.$eval(sendButton, node => node.getAttribute('aria-disabled'))
    ).not.equals('true')
    await page.keyboard.press('Backspace')
    await say('And the playoffs too', 'Both together')
    const playoffs = t.model.calls.filter(call =>
      (call.request?.said ?? '').includes('And the playoffs too')
    )
    expect(playoffs).length(1)
    const note = playoffs[0]
      .request!.messages.filter(message => message.role === 'assistant')
      .flatMap(message =>
        Array.isArray(message.content)
          ? message.content
          : [{ type: 'text', text: message.content }]
      )
      .find(block => String(block.text).startsWith('(Stopped by the person'))
    expect(note, 'the stopped note').not.equals(undefined)
    console.log(`W19 Stop ended the reply in ${stoppedMs} ms; the note went on`)

    // L1: a reply that needs two reads, as it streams in: the "Thinking"
    // row and her summary before any of her text, each step with a spinner
    // and then a check, and her text growing in place; then a closed
    // "Thought for Ns" that opens to the summary and the two steps.
    await open('/')
    await openTess()
    await waitFor(page, column)
    await page.evaluate(() => {
      // What the live reply showed, each time it changed.
      const seen: Array<{ thinking: string; text: string; steps: string }> = []
      ;(window as unknown as { tessSeen: unknown }).tessSeen = seen
      const record = (): void => {
        const live = document.querySelector('[data-testid="Tess live reply"]')
        if (live == null) return
        const summary = live.querySelector(
          '[data-testid="Tess thought summary"]'
        )
        const text = live.querySelector('[data-testid="Tess live text"]')
        const steps = Array.from(
          live.querySelectorAll('[data-testid="Tess step"]')
        ).map(step =>
          step.querySelector('[data-testid="Tess step done"]') != null
            ? 'done'
            : step.querySelector('[data-testid="Tess step failed"]') != null
              ? 'failed'
              : 'running'
        )
        const now = {
          thinking: summary == null ? '' : summary.textContent || '',
          text: text == null ? '' : text.textContent || '',
          steps: steps.join(',')
        }
        const last = seen[seen.length - 1]
        if (last == null || JSON.stringify(last) !== JSON.stringify(now))
          seen.push(now)
      }
      new MutationObserver(record).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true
      })
    })
    const liveVideo = await startVideo(s, out, 'live-thinking.mp4')
    await pause(600)
    await page.click(field)
    await page.type(field, 'How did our last two games go?')
    await page.keyboard.press('Enter')
    await waitFor(page, '[data-testid="Tess live reply"]')
    await page.waitForFunction(
      () => document.querySelector('[data-testid="Tess thinking"]') == null,
      { timeout: 40000 }
    )
    await pause(1000)
    await liveVideo.stop()
    const seen = await page.evaluate(
      () =>
        (
          window as unknown as {
            tessSeen: Array<{ thinking: string; text: string; steps: string }>
          }
        ).tessSeen
    )
    const firstThought = seen.findIndex(state => state.thinking !== '')
    const firstText = seen.findIndex(state => state.text !== '')
    expect(firstThought, 'her thinking shows').greaterThanOrEqual(0)
    expect(firstThought, 'before any of her text').lessThan(firstText)
    // Each step's spinner, then its check, the second after the first.
    const stepStates = seen
      .map(state => state.steps)
      .filter((steps, at, all) => at === 0 || all[at - 1] !== steps)
    const wanted = ['running', 'done', 'done,running', 'done,done']
    let found = 0
    for (const steps of stepStates) if (steps === wanted[found]) found += 1
    expect(found, JSON.stringify(stepStates)).equals(wanted.length)
    // The text grows in place, a few words at a time.
    const grown = seen
      .map(state => state.text)
      .filter((text, at, all) => text !== '' && all[at - 1] !== text)
    expect(grown.length, 'pieces of text').greaterThan(6)
    grown.forEach((text, at) => {
      if (at > 0)
        expect(text.length, `${grown[at - 1]} -> ${text}`).greaterThanOrEqual(
          grown[at - 1].length
        )
    })
    // Its last piece may come with the stored reply, which takes its place.
    expect(grown[grown.length - 1]).contains('Demo Hawks lost the latest')
    await contains(page, 'won the one before it 9 to 1.')
    const thoughtRow = async (): Promise<{
      label: string | null
      expanded: string | null
      body: string | null
      steps: Array<string | null>
    }> =>
      await page.evaluate(() => {
        const replies = document.querySelectorAll('[data-testid="Tess reply"]')
        const reply = replies[replies.length - 1]
        const row = reply.querySelector<HTMLElement>(
          '[data-testid="Tess thought"] [role="button"]'
        )!
        row.setAttribute('data-tess-thought', 'last')
        const body = reply.querySelector('[data-testid="Tess thought body"]')
        return {
          label: row.getAttribute('aria-label'),
          expanded: row.getAttribute('aria-expanded'),
          body:
            body == null
              ? null
              : (
                  body.querySelector('[data-testid="Tess thought summary"]') ||
                  body
                ).textContent,
          steps: Array.from(
            reply.querySelectorAll('[data-testid="Tess step"]')
          ).map(step => step.getAttribute('aria-label'))
        }
      })
    const collapsed = await thoughtRow()
    expect(collapsed.label).match(/^Thought for \d+s$/)
    expect(collapsed.expanded).equals('false')
    expect(collapsed.body).equals(null)
    await pause(500)
    await shot('thought-collapsed.png')
    await tap('[data-tess-thought="last"]')
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-tess-thought="last"]')!
          .getAttribute('aria-expanded') === 'true',
      { timeout: 10000 }
    )
    const expanded = await thoughtRow()
    expect(expanded.body).contains('They want their last two games.')
    expect(expanded.body).contains('I will give the scores, newest first.')
    expect(expanded.steps).deep.equals([
      'Reading: Public minimal group profile with optional current management capability, done',
      "Reading: A team's games, newest first, done"
    ])
    await page.evaluate(() => {
      document
        .querySelector('[data-tess-thought="last"]')!
        .scrollIntoView({ block: 'start' })
    })
    await pause(500)
    await shot('thought-expanded.png')
    console.log(
      `L1 thinking before text; steps ${stepStates.join(' | ')}; ${grown.length} pieces of text; ${collapsed.label}, opened to the summary and two steps`
    )

    // L5: the header and the +.
    await open('/')
    await openTess()
    await waitFor(page, column)
    const header = await page.evaluate(() => {
      const title = document.querySelector(
        '[data-testid="Tess chat"] [role="heading"]'
      )!
      const icon = title.previousElementSibling as HTMLElement
      const box = (node: Element): number[] => {
        const rect = node.getBoundingClientRect()
        return [rect.x, rect.y, rect.width, rect.height]
      }
      return {
        title: title.textContent,
        titleBox: box(title),
        icon: icon.textContent,
        iconBox: box(icon)
      }
    })
    expect(header.title).equals('Ask Tess')
    expect(header.icon).equals('auto_awesome')
    expect(header.iconBox[0], 'the icon at the left').lessThan(40)
    expect(header.iconBox[1], 'at the top').lessThan(40)
    expect(header.iconBox[0] + header.iconBox[2]).lessThan(header.titleBox[0])
    const plus = await page.$eval(
      '[role="button"][aria-label="Attach a file"]',
      node => {
        const style = getComputedStyle(node)
        const box = node.getBoundingClientRect()
        return {
          width: box.width,
          height: box.height,
          border: style.borderTopWidth,
          background: style.backgroundColor
        }
      }
    )
    expect(plus).deep.equals({
      width: 32,
      height: 32,
      border: '0px',
      background: 'rgba(0, 0, 0, 0)'
    })
    await shot('wide-header-composer-after.png')
    console.log(
      'L5 "Ask Tess" after the icon at the top left; + is 32 × 32 with no border or fill'
    )

    // L4: Shift+Enter is a new line, Enter sends both.
    const fieldHeight = async (): Promise<number> =>
      await page.$eval(field, node => node.getBoundingClientRect().height)
    const oneLine = await fieldHeight()
    await page.click(field)
    await page.type(field, 'a')
    await page.keyboard.down('Shift')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Shift')
    await page.type(field, 'b')
    const twoLines = await fieldHeight()
    expect(
      await page.$eval(field, node => (node as HTMLTextAreaElement).value)
    ).equals('a\nb')
    expect(oneLine).equals(48)
    expect(twoLines, 'two lines').equals(70)
    const callsBeforeLines = t.model.calls.length
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () => document.querySelector('[data-testid="Tess thinking"]') == null,
      { timeout: 20000 }
    )
    await page.waitForFunction(
      selector =>
        document.querySelector<HTMLTextAreaElement>(selector)!.value === '',
      { timeout: 20000 },
      field
    )
    const lines = t.model.calls
      .slice(callsBeforeLines)
      .find(call => call.request?.said.startsWith('a') === true)
    expect(lines?.request?.said).equals('a\nb')
    expect(await fieldHeight(), 'one line again').equals(48)
    console.log(
      'L4 the field showed two lines; "a\\nb" was sent',
      oneLine,
      twoLines
    )

    // L2: the divider drags the column wider and narrower, and the pane
    // beside it follows; a reload keeps the width.
    await open('/')
    await openTess()
    await waitFor(page, column)
    await goInApp(`/teams/${f.teamA}`)
    await waitFor(page, '[data-breakpoint]')
    const divider = '[data-testid="Tess divider"]'
    await waitFor(page, divider)
    const dividerLine = async (): Promise<Rect> =>
      (await rectOf(page, `${divider} > div`))!
    expect((await dividerLine()).width, 'a 3-point line').equals(3)
    expect(
      await page.$eval(divider, node => getComputedStyle(node).cursor)
    ).equals('col-resize')
    const breakpointIs = async (wanted: string): Promise<void> => {
      await page.waitForFunction(
        wanted => {
          const nodes = Array.from(
            document.querySelectorAll('[data-breakpoint]')
          )
          const last = nodes[nodes.length - 1]
          return last != null && last.getAttribute('data-breakpoint') === wanted
        },
        { timeout: 10000 },
        wanted
      )
    }
    await breakpointIs('tablet')
    const dragBy = async (dx: number): Promise<void> => {
      const grab = (await rectOf(page, divider))!
      const from = grab.x + grab.width / 2
      await page.mouse.move(from, 450)
      await page.mouse.down()
      for (let step = 1; step <= 12; step++) {
        await page.mouse.move(from + (dx * step) / 12, 450)
        await pause(40)
      }
      await page.mouse.up()
      await pause(300)
    }
    const drag = await startVideo(s, out, 'divider-drag.mp4')
    await pause(500)
    await dragBy(120)
    expect(await rectOf(page, column)).deep.include({ x: 0, width: 520 })
    expect(await paneRect(page)).deep.include({ x: 520, width: 760 })
    await breakpointIs('tablet')
    await dragBy(600)
    expect(await rectOf(page, column)).deep.include({ width: 720 })
    expect(await paneRect(page)).deep.include({ x: 720, width: 560 })
    await breakpointIs('phone')
    await dragBy(-1000)
    expect(await rectOf(page, column)).deep.include({ width: 320 })
    expect(await paneRect(page)).deep.include({ x: 320, width: 960 })
    await breakpointIs('tablet')
    await dragBy(200)
    await pause(500)
    await drag.stop()
    await open('/')
    await openTess()
    await waitFor(page, column, 30000)
    await goInApp(`/teams/${f.teamA}`)
    await page.waitForFunction(
      selector => {
        const node = document.querySelector(selector)
        return node != null && node.getBoundingClientRect().width === 520
      },
      { timeout: 10000 },
      column
    )
    expect(await paneRect(page)).deep.include({ x: 520, width: 760 })
    console.log(
      'L2 520/760, 720/560 (phone), 320/960 (tablet); the reload kept 520'
    )

    // L3: the keyboard moves it 16 points a press.
    await page.focus(divider)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction(
      selector => {
        const node = document.querySelector(selector)
        return node != null && node.getBoundingClientRect().width === 552
      },
      { timeout: 10000 },
      column
    )
    expect(
      await page.$eval(divider, node => node.getAttribute('aria-valuenow'))
    ).equals('552')
    console.log('L3 → twice: 520 to 552')
    // Back to the default, for what follows and the next run.
    await page.evaluate(() => {
      localStorage.removeItem('tess.columnWidth')
    })

    // L6: a player Tess names is a blue link to their profile.
    await open('/')
    await openTess()
    await waitFor(page, column)
    await say('Who plays shortstop for Demo Hawks?', 'plays shortstop')
    const playerLink = async (name: string, mark: string): Promise<string> =>
      await page.evaluate(
        (name, mark) => {
          const links = Array.from(
            document.querySelectorAll(
              '[data-testid="Tess reply"] [role="link"]'
            )
          ).filter(node => node.textContent === name)
          const link = links[links.length - 1] as HTMLElement | undefined
          if (link == null) throw new Error(`No link ${name}`)
          link.setAttribute('data-tess-player', mark)
          link.scrollIntoView({ block: 'center' })
          return getComputedStyle(link).color
        },
        name,
        mark
      )
    expect(await playerLink('Tony G', 'gwynn')).equals('rgb(21, 101, 192)')
    await pause(500)
    await shot('player-link.png')
    await tap('[data-tess-player="gwynn"]')
    await page.waitForFunction(
      path => location.pathname === path,
      { timeout: 15000 },
      `/players/${t.players.visible}`
    )
    await waitFor(page, column)
    await contains(page, 'Tony G')
    await waitFor(page, '[aria-label="Player sections"]', 20000)
    console.log('L6 the blue name opened his profile in the pane')

    // L7: a player the viewer may not see. A link from Tess opens a page on
    // its own, as an address does, so Back, like the header's, goes to the
    // tab's first page.
    await say('Show me Ozzie', 'who plays for Demo Visitors')
    await playerLink('Ozzie S', 'smith')
    await tap('[data-tess-player="smith"]')
    await page.waitForFunction(
      path => location.pathname === path,
      { timeout: 15000 },
      `/players/${t.players.hidden}`
    )
    await waitFor(page, '[data-testid="Player unavailable"]', 20000)
    await contains(page, 'Profile not available')
    await contains(
      page,
      'You don\u2019t have access to this player\u2019s profile, or it no longer exists.'
    )
    await pause(800)
    await shot('player-denied.png')
    await tap('[data-testid="Player unavailable"] [role="button"]')
    await page.waitForFunction(() => location.pathname === '/', {
      timeout: 15000
    })
    await gone(page, '[data-testid="Player unavailable"]')
    await contains(page, 'Your Home')
    await waitFor(page, column)
    console.log('L7 "Profile not available"; Back went to Your Home')

    if (process.env.TS_DIRECT_BROWSER_COVERAGE != null)
      await recordBrowserCoverage(
        [page],
        f.h.origin,
        resolve(process.env.TS_DIRECT_BROWSER_COVERAGE),
        webRoot
      )

    // W17: a server without Tess offers her in no menu.
    other = await tessFixture({ webRoot, tess: false, videos: false })
    await identity(other, 101)
    await open('/', other.f.h.origin)
    await waitFor(page, picture)
    await pause(2000)
    await tap(mark)
    await waitFor(page, '[role="button"][aria-label="About TeamStation"]')
    expect(await page.$('[role="button"][aria-label="Ask Tess"]')).equals(null)
    console.log('W17 no Ask Tess row where the server has none')
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
