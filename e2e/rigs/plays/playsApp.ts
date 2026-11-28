import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import {
  type FixtureAccount,
  type FixtureManifest,
  signInWithPassword
} from '../../core/fixtures'
import type { E2eContext, WebSession } from '../../core/spec'
import { clearSignInLimits } from '../coach/coachApp'
import { maestroDriver, placeFielder, setTrajectory } from '../fieldPointer'

/**
 * The Plays tab's scenarios on the web: maestro-d's Chromium at a phone or a
 * wide window, signed in as one of the `plays-game` world's people or not at
 * all. Everything that acts goes through maestro-d; the page is only read,
 * and the requests it made only read back from its resource timings.
 */

/** The game's own pills, not the app's tab bar, which is tabs too. */
const GAME_PILLS = '[data-testid="gameSection"]'
const PILL = `${GAME_PILLS} [role="tab"]`
/** Every pill, Replay and Live included, which are buttons rather than tabs. */
const ANY_PILL = `${GAME_PILLS} [role="tablist"] [role="tab"], ${GAME_PILLS} [role="tablist"] [role="button"]`

export const PHONE = { width: 393, height: 852 }
export const WIDE = { width: 1440, height: 900 }

export interface PlaysApp {
  m: any
  web: WebSession
  origin: string
  /**
   * Every path the page asked the API for since it opened, from the
   * browser's own resource timings, kept across each address opened.
   */
  requests: () => Promise<string[]>
  /** Opens a page of the app by its path. */
  go: (path: string) => Promise<void>
  /** The game's pills, as they read, left to right. */
  pills: () => Promise<string[]>
  /** The selected pill's words. */
  selected: () => Promise<string | null>
  /** Taps a pill by its words. */
  choose: (label: string) => Promise<void>
  /** The page's address, path and query. */
  address: () => Promise<string>
  /** What the page reads, all of it. */
  text: () => Promise<string>
  /** Waits until `ready` holds of the page, or fails naming `what`. */
  until: <T>(
    what: string,
    ready: () => Promise<T | undefined>,
    ms?: number
  ) => Promise<T>
  /** Every drawn element whose test id matches, in page order. */
  testIds: (pattern: RegExp) => Promise<string[]>
  /** Taps an at-bat line by its index in the game. */
  tapLine: (atBatIndex: number) => Promise<void>
  /** The pitch rows an open line shows, as they read. */
  pitchRows: (atBatIndex: number) => Promise<string[]>
  /** Where an element is on the window, by its test id. */
  rect: (testId: string) => Promise<DOMRect | null>
  /** Saves the window as it looks now, into the run's directory. */
  screenshot: (name: string) => Promise<string>
}

/**
 * Opens the app at `size`, and signs `account` in through the password form,
 * or nobody when it is null.
 */
export async function openPlaysApp(
  ctx: E2eContext,
  account: FixtureAccount | null,
  size: { width: number; height: number } = PHONE
): Promise<PlaysApp> {
  const origin = ctx.stack.origin
  if (account != null) await clearSignInLimits(ctx)
  const web = await ctx.browser(size)
  const { m, page } = web
  const earlier: string[] = []
  const current = async (): Promise<string[]> =>
    (
      await page.evaluate(() =>
        performance.getEntriesByType('resource').map(entry => entry.name)
      )
    )
      .map(name => new URL(name))
      .filter(url => url.origin === origin && url.pathname.startsWith('/api/'))
      .map(url => url.pathname)
  const requests = async (): Promise<string[]> => [
    ...earlier,
    ...(await current())
  ]
  await m.openLink({ link: `${origin}/` })
  // A wide window has no menu button: its sidebar names whoever is signed in.
  if (account != null)
    await signInWithPassword(
      m,
      account,
      size.width >= 1024 ? account.displayName : undefined
    )
  const until = async <T>(
    what: string,
    ready: () => Promise<T | undefined>,
    ms = 60000
  ): Promise<T> => {
    const end = Date.now() + ms
    for (;;) {
      const value = await ready().catch(() => undefined)
      if (value !== undefined) return value
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  const pills = async (): Promise<string[]> =>
    await page.evaluate(
      (pill: string) =>
        Array.from(document.querySelectorAll(pill)).map(tab =>
          String(tab.textContent)
        ),
      ANY_PILL
    )
  const app: PlaysApp = {
    m,
    web,
    origin,
    requests,
    go: async path => {
      // A new document starts its timings afresh: keep the old one's.
      earlier.push(...(await current()))
      await m.openLink({ link: `${origin}${path}` })
    },
    pills,
    selected: async () =>
      await page.evaluate((pill: string) => {
        // Selectors go in as arguments: the page has none of this module.
        const tab = document.querySelector(pill + '[aria-selected="true"]')
        return tab == null ? null : String(tab.textContent)
      }, PILL),
    choose: async label => {
      await m.tapOn({
        css: `${GAME_PILLS} [role="tab"][aria-label="${label}"]`
      })
      await until(`${label} selected`, async () =>
        (await app.selected()) === label ? true : undefined
      )
    },
    address: async () =>
      await page.evaluate(() => location.pathname + location.search),
    text: async () =>
      await page.evaluate(() => String(document.body.textContent)),
    until,
    testIds: async pattern =>
      await page.evaluate((source: string) => {
        const match = new RegExp(source)
        return Array.from(document.querySelectorAll('[data-testid]'))
          .map(node => String(node.getAttribute('data-testid')))
          .filter(id => match.test(id))
      }, pattern.source),
    tapLine: async atBatIndex => {
      await m.tapOn({
        css: `[data-testid="plays-line-${atBatIndex}"] [role="button"]`
      })
    },
    pitchRows: async atBatIndex =>
      await page.evaluate(
        (index: number) =>
          Array.from(
            document.querySelectorAll(
              `[data-testid="plays-line-${index}"] [data-testid="plays-pitch"]`
            )
          ).map(row => String(row.textContent)),
        atBatIndex
      ),
    rect: async testId =>
      await page.evaluate((id: string) => {
        const node = document.querySelector(`[data-testid="${id}"]`)
        return node == null ? null : node.getBoundingClientRect().toJSON()
      }, testId),
    screenshot: async name => {
      const path = ctx.artifact(name)
      await m.takeScreenshot({ path })
      return path
    }
  }
  return app
}

/** The game's page, waited for until its pills are drawn. */
export async function openGame(
  app: PlaysApp,
  gameId: string,
  query = ''
): Promise<void> {
  await app.go(`/games/${gameId}${query}`)
  await app.until('the game pills', async () =>
    (await app.pills()).length > 0 ? true : undefined
  )
}

/** Plays, from its pill, waited for until its stream or its notice shows. */
export async function openPlays(app: PlaysApp): Promise<void> {
  await app.choose('Plays')
  await app.until('the Plays tab', async () =>
    (await app.testIds(/^plays-(stream|members-only)$/)).length > 0
      ? true
      : undefined
  )
}

/** The `/games/<id>/events` reads among the page's requests. */
export async function eventsReads(
  app: PlaysApp,
  gameId: string
): Promise<string[]> {
  return (await app.requests()).filter(
    path => path === `/api/v1/games/${gameId}/events`
  )
}

/** The world's game ids, by name, failing for a world without them. */
export function gamesOf(world: FixtureManifest): {
  final: string
  inProgress: string
  mixed: string
  imported: string
  onePitch: string
  unplayed: string
} {
  const { final, inProgress, mixed, imported, onePitch, unplayed } = world.ids
  for (const [name, id] of Object.entries({
    final,
    inProgress,
    mixed,
    imported,
    onePitch,
    unplayed
  }))
    expect(id, `the world's ${name} game`).to.be.a('string')
  return { final, inProgress, mixed, imported, onePitch, unplayed }
}

/** Where the game's page is scrolled to, as the browser has it. */
export interface PagePosition {
  /** The offset, and the farthest it can go. */
  y: number
  end: number
  viewport: number
  /** The room the pinned head keeps after the content. */
  spacer: number
  /** The bottom of the stream's last line, on the window. */
  lastLineBottom: number | null
  /** The last line's at-bat index. */
  lastLine: number | null
}

/** The page under the game's pills: the scroller that holds the stream. */
export async function pagePosition(app: PlaysApp): Promise<PagePosition> {
  return await app.web.page.evaluate(() => {
    const content = document.querySelector('[data-testid="eventTabContent"]')
    let page: Element | null = content
    while (page != null) {
      const { overflowY } = getComputedStyle(page)
      if (overflowY === 'auto' || overflowY === 'scroll') break
      page = page.parentElement
    }
    const lines = document.querySelectorAll('[data-testid^="plays-line-"]')
    const last = lines.length === 0 ? null : lines[lines.length - 1]
    const spacer = document.querySelector('[data-testid="pinnedSpacer"]')
    return {
      y: page == null ? 0 : page.scrollTop,
      end: page == null ? 0 : page.scrollHeight - page.clientHeight,
      viewport: page == null ? 0 : page.clientHeight,
      spacer: spacer == null ? 0 : spacer.getBoundingClientRect().height,
      lastLineBottom: last == null ? null : last.getBoundingClientRect().bottom,
      lastLine:
        last == null
          ? null
          : Number(String(last.getAttribute('data-testid')).slice(11))
    }
  })
}

/** Whether the Latest play button is drawn and not faded out. */
export async function latestShown(app: PlaysApp): Promise<boolean> {
  return await app.web.page.evaluate(() => {
    const button = document.querySelector('[data-testid="plays-latest"]')
    if (button == null) return false
    let node: Element | null = button
    while (node != null) {
      if (Number(getComputedStyle(node).opacity) < 0.99) return false
      node = node.parentElement
    }
    return true
  })
}

/** Scrolls the page by the mouse wheel, a few hundred points a turn. */
export async function wheel(
  app: PlaysApp,
  direction: 'up' | 'down',
  turns: number
): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await app.m.scroll({ direction })
  await new Promise(resolve => setTimeout(resolve, 400))
}

/**
 * A video of the page from back-to-back screenshots, each shown for as long
 * as it was on screen, since maestro-d records no video on the web (as
 * `src/app/replay/replay.e2e.ts` records its own).
 */
export function screenRecorder(m: any): {
  stop: (path: string) => Promise<void>
} {
  const frames: Array<{ file: string; at: number }> = []
  const state = { running: true }
  const dir = mkdtemp(join(tmpdir(), 'plays-frames-'))
  const loop = (async (): Promise<void> => {
    const into = await dir
    while (state.running) {
      const file = join(
        into,
        `frame-${String(frames.length).padStart(5, '0')}.png`
      )
      await writeFile(file, await m.screenshot())
      frames.push({ file, at: Date.now() })
    }
  })().then(
    () => undefined,
    (error: unknown) => {
      state.running = false
      return error instanceof Error ? error : new Error(String(error))
    }
  )
  return {
    async stop(path) {
      state.running = false
      const failed = await loop
      if (failed != null) throw failed
      const into = await dir
      try {
        if (frames.length === 0) throw new Error('no frames were recorded')
        const end = Date.now()
        const list = frames
          .map(
            (frame, i) =>
              `file '${frame.file}'\nduration ${(((frames[i + 1]?.at ?? end) - frame.at) / 1000).toFixed(3)}`
          )
          .join('\n')
        const listFile = join(into, 'frames.txt')
        await writeFile(listFile, `${list}\nfile '${frames.at(-1)!.file}'\n`)
        const made = spawnSync(
          'ffmpeg',
          [
            '-nostdin',
            '-loglevel',
            'error',
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            listFile,
            '-vf',
            'pad=ceil(iw/2)*2:ceil(ih/2)*2',
            '-fps_mode',
            'vfr',
            '-pix_fmt',
            'yuv420p',
            '-y',
            path
          ],
          { encoding: 'utf8' }
        )
        if (made.status !== 0)
          throw new Error(`ffmpeg failed: ${made.stderr.slice(-400)}`)
      } finally {
        await rm(into, { recursive: true, force: true })
      }
    }
  }
}

/**
 * Taps the scorer's control by its accessible name, never text elsewhere
 * that matches; a name ending in `*` matches its start.
 */
export async function tapControl(app: PlaysApp, name: string): Promise<void> {
  const label = name.endsWith('*')
    ? `[aria-label^=${JSON.stringify(name.slice(0, -1))}]`
    : `[aria-label=${JSON.stringify(name)}]`
  const css = `:is(button, [role="button"])${label}`
  try {
    await app.m.tapOn({ css })
  } catch (error) {
    // The scorer redraws its controls as the game moves: a control replaced
    // as it was tapped is tapped again, once, as it is now.
    if (!String(error).includes('detached')) throw error
    await new Promise(resolve => setTimeout(resolve, 500))
    await app.m.tapOn({ css })
  }
}

/** The first Undo control's name: `Undo Ball`. */
export async function undoName(app: PlaysApp): Promise<string> {
  return await app.web.page.evaluate(() => {
    const undo = document.querySelector('[aria-label^="Undo "]')
    return undo == null ? '' : String(undo.getAttribute('aria-label'))
  })
}

/** Whether the scorer shows a control by that name, and it can be tapped. */
export async function hasControl(
  app: PlaysApp,
  name: string
): Promise<boolean> {
  return await app.web.page.evaluate(
    (wanted: string) =>
      Array.from(document.querySelectorAll('[aria-label]')).some(
        node =>
          node.getAttribute('aria-label') === wanted &&
          node.getAttribute('aria-disabled') !== 'true' &&
          !(node as HTMLButtonElement).disabled
      ),
    name
  )
}

/**
 * The scorer records a hit up the middle: swing in play, the outcome, the
 * center fielder placed and the offered trajectory, and the at-bat finished.
 */
export async function scoreHit(
  app: PlaysApp,
  outcome: 'Single' | 'Double'
): Promise<void> {
  await tapControl(app, 'Swing in Play')
  await tapControl(app, outcome)
  await app.until('the field', async () =>
    (await app.web.page.evaluate(() =>
      Array.from(document.querySelectorAll('[aria-label]')).some(node =>
        String(node.getAttribute('aria-label')).startsWith(
          'Tap or drag a player to where the ball was fielded'
        )
      )
    ))
      ? true
      : undefined
  )
  const field = maestroDriver(app.m)
  await placeFielder(field, 'CF')
  await setTrajectory(field)
  await app.until('Finish at-bat', async () =>
    (await hasControl(app, 'Finish at-bat')) ? true : undefined
  )
  await tapControl(app, 'Finish at-bat')
}
