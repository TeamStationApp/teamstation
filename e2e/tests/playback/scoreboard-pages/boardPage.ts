import { expect } from 'chai'

import type { HarnessContext, WebSession } from '../../../core/spec'
import type { Page } from '../../../core/web'
import { pressControl } from '../../../rigs/scoring/webScorer'
import { until } from '../scoreboard-server/boardSockets'

/**
 * Reads of the scoreboard pages, and the presses the dashboard and the
 * Score screen take: every press is a maestro-d tap on the control a person
 * touches; the page is only read.
 */

/** What the board on a page shows, read off its data attributes. */
export interface Drawn {
  drawn: boolean
  away: string
  home: string
  awayScore: string
  homeScore: string
  count: string
  outs: number
  bases: boolean[]
}

export async function drawn(page: Page): Promise<Drawn | undefined> {
  return await page.evaluate(() => {
    // Written without `?.` and `??`: sucrase turns those into helpers that
    // exist in Node and not in the page this runs in.
    const part = (name: string): string => {
      const node = document.querySelector(`[data-scoreboard="${name}"]`)
      return node === null ? '' : String(node.textContent)
    }
    const board = document.querySelector<HTMLElement>(
      '[data-scoreboard="board"]'
    )
    if (board === null) return undefined
    const lit = (name: string): boolean[] =>
      Array.from(
        document.querySelectorAll<HTMLElement>(`[data-scoreboard="${name}"]`)
      ).map(node => node.dataset.lit === 'true')
    return {
      drawn: board.dataset.drawn === 'true',
      away: part('awayTeam'),
      home: part('homeTeam'),
      awayScore: part('awayScore'),
      homeScore: part('homeScore'),
      count: part('count'),
      outs: lit('out').filter(Boolean).length,
      bases: [lit('base1')[0], lit('base2')[0], lit('base3')[0]]
    }
  })
}

/** Waits for the board to satisfy `check`. */
export async function boardShows(
  page: Page,
  what: string,
  check: (board: Drawn) => boolean,
  timeoutMs = 10_000
): Promise<Drawn> {
  return await until(
    what,
    async () => {
      const board = await drawn(page)
      return board != null && check(board) ? board : undefined
    },
    timeoutMs
  )
}

/** The branded 404 is up: its message, its logo and its sign-up link. */
export async function notFoundShown(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const text = String(document.body.textContent)
    const signUp = Array.from(document.querySelectorAll('a')).some(
      one =>
        one.textContent === 'Sign up for TeamStation' &&
        one.getAttribute('href') === '/sign-in'
    )
    return (
      text.includes("This scoreboard isn't live") &&
      document.querySelector('[aria-label="TeamStation"]') != null &&
      signUp
    )
  })
}

/** A browser of this machine's, signed in as nobody, at `size`. */
export async function anonymousSession(
  ctx: HarnessContext,
  size = { width: 1280, height: 720 },
  observeNetwork = false
): Promise<WebSession> {
  const session = await ctx.browser(size, { observeNetwork })
  session.page.setDefaultTimeout(30_000)
  return session
}

/** Opens `path` on the stack's web build in `session`. */
export async function openPath(
  ctx: HarnessContext,
  session: WebSession,
  path: string
): Promise<Page> {
  await session.m.openBrowser({ url: `${ctx.stack.origin}${path}` })
  return session.page
}

/** The screen of `session`, kept in the run directory as `<name>.png`. */
export async function shot(
  ctx: HarnessContext,
  session: WebSession,
  name: string
): Promise<void> {
  await session.m.takeScreenshot({ path: ctx.artifact(`${name}.png`) })
}

/** Presses the visible control labelled `label`. */
export async function tap(session: WebSession, label: string): Promise<void> {
  const selector = `[aria-label="${label}"]`
  await session.page.waitForSelector(selector, { visible: true })
  await pressControl(session.m, session.page, selector, label)
}

/** Presses the control labelled `label`, and says when the press reached the page. */
export async function pressTimed(
  session: WebSession,
  label: string
): Promise<number> {
  const { page } = session
  await page.evaluate(
    `window.__pressedAt = new Promise((resolve, reject) => { document.addEventListener('click', () => resolve(Date.now()), { capture: true, once: true }); setTimeout(() => reject(new Error('no click reached the page')), 20000) })`
  )
  await tap(session, label)
  const at = await page.evaluate('window.__pressedAt')
  expect(at, `the press on ${label} reached the page`).a('number')
  return at as number
}

/** Holds a finger on `label` long enough to be a long press. */
export async function longPress(
  session: WebSession,
  label: string
): Promise<void> {
  const target = await session.page.waitForSelector(`[aria-label="${label}"]`, {
    visible: true
  })
  const box = await target?.boundingBox()
  if (box == null) throw new Error(`${label} has no box`)
  await session.m.tapOnPoint({
    x: Math.round(box.x + box.width / 3),
    y: Math.round(box.y + box.height / 2),
    longPress: true,
    duration: 800
  })
}
