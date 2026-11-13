import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* The functions puppeteer runs in the page are transpiled by sucrase, which
   turns ?. and ?? into helpers the page does not have. */
import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import type { HTTPRequest, Page } from 'puppeteer'

import {
  type BrowserSession,
  browserSession,
  maestro
} from '../../../e2e/rigs/refinementsMaestro'
import type { LineupFixture } from '../../server/dev/lineupFixture'
import { signInTestAccount } from '../../test/passwordFixtures'

/**
 * Two scorekeepers on one game, each in maestro-d's Chromium at an iPhone's
 * 402×874, against the real local stack: the API with its game socket
 * (`npm start`), the web app built against it (`npm run start.web`) and a
 * game from `npm run lineup-fixture`, made afresh for each scenario. Both
 * sign in as the fixture's scorekeeper, each in a browser profile of its
 * own. What one saves reaches the other over the game socket.
 *
 *   MAESTRO_D=<daemon> MAESTRO_D_BIN=… TS_MAESTRO_D_CLIENT=… \
 *   TS_SCORING_TEST_URL=http://127.0.0.1:8180 \
 *   TS_API_TEST_URL=http://127.0.0.1:9180/api/v1 \
 *   TS_LINEUP_PASSWORD=<the fixture's password> \
 *     node_modules/.bin/mocha -r sucrase/register --extension ts \
 *     --timeout 180000 src/app/scoring/rosterLive.e2e.ts
 *
 * `TS_LINEUP_ARTIFACTS=<dir>` saves L2's warning there as
 * `roster-conflict-banner.png`.
 *
 * L4 holds every API request open with request interception, then takes
 * Chromium offline: each roster, lineup and defense change shows at once.
 * L5 has both profiles change one side's lineup, the earlier change saved
 * last: the later creation time wins on both screens.
 */
const APP = process.env.TS_SCORING_TEST_URL ?? 'http://127.0.0.1:8180'
const API = process.env.TS_API_TEST_URL ?? 'http://127.0.0.1:9180/api/v1'
const PASSWORD = process.env.TS_LINEUP_PASSWORD ?? ''
const ARTIFACTS = process.env.TS_LINEUP_ARTIFACTS
const WIDTH = 402
const HEIGHT = 874
const BANNER =
  'Another user has edited the roster. Your pending changes may overwrite theirs. Hit Cancel to revert to their changes.'

/** A new game, its rosters and the people who use it. */
/** Each page's requests in flight, and when each was sent. */
const inFlight = new WeakMap<Page, Map<HTTPRequest, number>>()

/** Keeps the page's requests in flight, for `settled` to name. */
function track(page: Page): void {
  const open = new Map<HTTPRequest, number>()
  inFlight.set(page, open)
  page.on('request', request => {
    open.set(request, Date.now())
  })
  for (const event of ['requestfinished', 'requestfailed'] as const)
    page.on(event, request => {
      open.delete(request)
    })
}

/**
 * Waits until the page has had no request in flight for half a second; when
 * it never does, says which requests stayed open, so the run's log shows what
 * held the page busy. The requests are this file's own count, not
 * puppeteer's: a request held by interception and let go as its page was
 * left never finishes in puppeteer's, and would keep every later page busy.
 */
async function settled(page: Page): Promise<void> {
  const open = inFlight.get(page) ?? new Map<HTTPRequest, number>()
  const deadline = Date.now() + 30000
  let quietSince = Date.now()
  for (;;) {
    const now = Date.now()
    if (open.size > 0) quietSince = now
    else if (now - quietSince >= 500) return
    if (now > deadline) {
      const busy = [...open].map(
        ([request, at]) =>
          `${request.method()} ${new URL(request.url()).pathname} (${now - at} ms)`
      )
      throw new Error(`The page never settled; still open: ${busy.join(', ')}`)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

function lineupFixture(): LineupFixture {
  const out = execFileSync(
    'npm',
    ['run', '--silent', 'lineup-fixture', '--', '--password', PASSWORD],
    { encoding: 'utf8' }
  )
  return JSON.parse(out) as LineupFixture
}

/** One scorekeeper's browser, and what the scenarios do in it. */
class Scorer {
  constructor(
    readonly session: BrowserSession,
    readonly page: Page
  ) {
    track(page)
  }

  async tap(label: string, role?: string): Promise<void> {
    const css =
      role == null
        ? `[aria-label="${label}"]`
        : `[aria-label="${label}"][role="${role}"]`
    await this.page.waitForSelector(css)
    await this.session.m.tapOn({ css, timeout: 15000 })
  }

  /** A control that takes a tap once it is enabled, tapped. */
  async tapEnabled(label: string): Promise<void> {
    await this.page.waitForFunction(
      label => {
        const node = document.querySelector(`[aria-label="${label}"]`)
        return node != null && node.getAttribute('aria-disabled') !== 'true'
      },
      { timeout: 30000 },
      label
    )
    await this.tap(label)
  }

  /** The scoring screen for this game, its help dismissed. */
  async scoreGame(gameId: string): Promise<void> {
    await this.page.goto(`${APP}/games/${gameId}/score`, {
      waitUntil: 'domcontentloaded'
    })
    await this.page.waitForSelector('[aria-label="Open scoring menu"]', {
      timeout: 60000
    })
    for (const label of ['OK', 'Close'])
      if ((await this.page.$(`[aria-label="${label}"]`)) != null)
        await this.tap(label)
  }

  /** The roster sheet, on the away team's Lineup tab. */
  async openRosters(): Promise<void> {
    await this.tap('Open scoring menu')
    await this.tap('Set Team Rosters')
    await this.page.waitForSelector('[aria-label="Save Rosters"]', {
      timeout: 30000
    })
    await this.tap('Away Team', 'tab')
    await this.tap('Lineup', 'tab')
    await this.page.waitForSelector('[data-roster-target="lineup-0"]')
  }

  /** The batting order shown, by name. */
  async lineup(): Promise<string[]> {
    return await this.page.$$eval(
      '[data-roster-target^="lineup-"][data-roster-player]',
      nodes =>
        nodes.map(node =>
          String(node.textContent)
            .replace(/^\D*\d+\. (#\S+ )?/, '')
            .replace(/\W+$/, '')
        )
    )
  }

  async waitLineup(names: string[]): Promise<void> {
    await this.page.waitForFunction(
      names => {
        const shown = [
          ...document.querySelectorAll(
            '[data-roster-target^="lineup-"][data-roster-player]'
          )
        ].map(node =>
          String(node.textContent)
            .replace(/^\D*\d+\. (#\S+ )?/, '')
            .replace(/\W+$/, '')
        )
        return JSON.stringify(shown) === JSON.stringify(names)
      },
      { timeout: 15000 },
      names
    )
  }

  async saveDisabled(): Promise<boolean> {
    return await this.page.$eval(
      '[aria-label="Save Rosters"]',
      node => node.getAttribute('aria-disabled') === 'true'
    )
  }

  async banner(): Promise<string | null> {
    return await this.page.evaluate(() => {
      const node = document.querySelector('[data-testid="Roster conflict"]')
      return node == null ? null : String(node.textContent)
    })
  }

  /**
   * A mouse drag of the lineup row at `source` to the boundary after
   * `target`: the press is held until the row lifts.
   */
  async dragAfter(source: number, target: number): Promise<void> {
    const at = async (
      index: number,
      where: 'bottom' | 'middle'
    ): Promise<{ x: number; y: number }> => {
      const selector = `[data-roster-target="lineup-${index}"]`
      await this.page.waitForSelector(selector)
      const r = await this.page.$eval(selector, node => {
        const box = node.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height }
      })
      return {
        x: r.x + Math.min(40, r.width / 2),
        y: where === 'bottom' ? r.y + r.height - 8 : r.y + r.height / 2
      }
    }
    const start = await at(source, 'middle')
    await this.page.mouse.move(start.x, start.y)
    await this.page.mouse.down()
    await new Promise(resolve => setTimeout(resolve, 750))
    const end = await at(target, 'bottom')
    await this.page.mouse.move(end.x, end.y, { steps: 12 })
    await new Promise(resolve => setTimeout(resolve, 200))
    await this.page.mouse.up()
    await new Promise(resolve => setTimeout(resolve, 300))
  }

  /** The roster sheet's editor is up, with no spinner in its place. */
  async editorShownWithin(ms: number): Promise<number> {
    const started = Date.now()
    await this.tap('Open scoring menu')
    await this.tap('Set Team Rosters')
    await this.page.waitForSelector('[aria-label="Save Rosters"]', {
      timeout: ms
    })
    expect(await this.page.$('[aria-label="Refreshing game"]')).equals(null)
    return Date.now() - started
  }

  /** Taps Save Rosters and answers how long the sheet took to close. */
  async saveShownWithin(ms: number): Promise<number> {
    const started = Date.now()
    await this.tapEnabled('Save Rosters')
    await this.page.waitForSelector('[aria-label="Save Rosters"]', {
      hidden: true,
      timeout: ms
    })
    return Date.now() - started
  }

  /** Every save has gone out and come back. */
  async waitSaved(): Promise<void> {
    await settled(this.page)
    await this.page.waitForFunction(
      () => document.querySelector('[aria-label="Save status"]') == null,
      { timeout: 30000 }
    )
  }

  /** The scoreboard's summary: score, half inning, count, outs and batter. */
  async scoreboard(): Promise<string> {
    return await this.page.$eval('[aria-label*=" balls "]', node =>
      String(node.getAttribute('aria-label'))
    )
  }

  async waitScoreboard(text: string, timeout = 15000): Promise<void> {
    await this.page.waitForFunction(
      text =>
        String(
          document
            .querySelector('[aria-label*=" balls "]')!
            .getAttribute('aria-label')
        ).includes(text),
      { timeout },
      text
    )
  }

  async shot(name: string): Promise<void> {
    if (ARTIFACTS == null) return
    await this.session.m.waitForAnimationToEnd()
    await writeFile(join(ARTIFACTS, name), await this.session.m.screenshot())
  }
}

describe('two scorekeepers on one game', function () {
  let daemon: Awaited<ReturnType<typeof maestro>>
  let a: Scorer
  let b: Scorer
  let token: string

  before(async function () {
    if (PASSWORD === '')
      throw new Error('Supply TS_LINEUP_PASSWORD, the lineup fixture password')
    for (const url of [APP, API])
      if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
        throw new Error(`${url} must be a local server`)
    if (ARTIFACTS != null) await mkdir(ARTIFACTS, { recursive: true })
    const fixture = lineupFixture()
    daemon = await maestro(process.env.MAESTRO_D ?? 'lineupDictation')
    const support = join(tmpdir(), 'roster-live-e2e')
    const scorers: Scorer[] = []
    for (const device of ['roster-live-a', 'roster-live-b']) {
      const session = await browserSession(
        daemon,
        device,
        WIDTH,
        HEIGHT,
        support
      )
      session.page.setDefaultTimeout(30000)
      // Each its own sign-in, as two phones would have.
      token = await signInTestAccount(API, {
        email: fixture.users.scorekeeper.email,
        password: PASSWORD
      })
      await session.page.browserContext().setCookie({
        name: 'ts_session',
        value: encodeURIComponent(token),
        domain: new URL(APP).hostname,
        path: '/'
      })
      scorers.push(new Scorer(session, session.page))
    }
    ;[a, b] = scorers
  })

  after(async function () {
    await a?.session.m.detach()
    await b?.session.m.detach()
    await daemon?.shutdown()
  })

  it('L1: shows the other scorekeeper’s saved order on a sheet with no changes, with no warning', async function () {
    const fixture = lineupFixture()
    await a.scoreGame(fixture.gameId)
    await b.scoreGame(fixture.gameId)
    await a.openRosters()
    const before = await a.lineup()
    expect(before.slice(0, 3)).deep.equals(['Judge', 'Altuve', 'Bregman'])
    await b.openRosters()
    await b.dragAfter(0, 2)
    const theirs = await b.lineup()
    expect(theirs.slice(0, 3)).deep.equals(['Altuve', 'Bregman', 'Judge'])
    await b.tapEnabled('Save Rosters')
    await b.page.waitForSelector('[aria-label="Save Rosters"]', {
      hidden: true
    })
    await b.waitSaved()
    await a.waitLineup(theirs)
    expect(await a.banner()).equals(null)
    expect(await a.saveDisabled()).equals(true)
    await a.tap('Cancel')
  })

  it('L2: warns over staged changes and keeps them; Cancel takes the other scorekeeper’s order', async function () {
    const fixture = lineupFixture()
    await a.scoreGame(fixture.gameId)
    await b.scoreGame(fixture.gameId)
    expect(await a.page.$('[aria-label="Undo Last play"]')).equals(null)
    await a.openRosters()
    // A stages a change of his own: Maldonado out of the lineup.
    await a.tap('Remove Maldonado')
    const mine = await a.lineup()
    expect(mine).not.includes('Maldonado')
    expect(await a.saveDisabled()).equals(false)
    await b.openRosters()
    await b.dragAfter(0, 2)
    const theirs = await b.lineup()
    await b.tapEnabled('Save Rosters')
    await b.page.waitForSelector('[aria-label="Save Rosters"]', {
      hidden: true
    })
    await b.waitSaved()
    await a.page.waitForSelector('[data-testid="Roster conflict"]', {
      timeout: 15000
    })
    expect(await a.banner()).equals(BANNER)
    expect(await a.lineup()).deep.equals(mine)
    expect(await a.saveDisabled()).equals(false)
    // The warning sits at the top of the screen, in the yellow outline.
    const style = await a.page.$eval(
      '[data-testid="Roster conflict"]',
      node => {
        const box = node.getBoundingClientRect()
        const css = getComputedStyle(node)
        return {
          top: box.top,
          width: box.width,
          border: css.borderTopColor,
          borderWidth: css.borderTopWidth
        }
      }
    )
    expect(style.top).lessThan(120)
    expect(style.width).greaterThan(WIDTH - 80)
    expect(style.borderWidth).equals('2px')
    expect(style.border).equals('rgb(197, 161, 60)')
    await a.shot('roster-conflict-banner.png')
    await a.tap('Cancel')
    await a.page.waitForSelector('[aria-label="Save Rosters"]', {
      hidden: true
    })
    // The scoring screen behind took theirs up, with no page reload: their
    // change is the one step it can take back.
    await a.page.waitForSelector('[aria-label="Undo Last play"]', {
      timeout: 15000
    })
    await a.openRosters()
    expect(await a.lineup()).deep.equals(theirs)
    expect(await a.banner()).equals(null)
    await a.tap('Cancel')
  })

  it('L3: shows the other scorekeeper’s pitch within 3 s, and puts the next pitch after it', async function () {
    const fixture = lineupFixture()
    await a.scoreGame(fixture.gameId)
    await b.scoreGame(fixture.gameId)
    expect(await a.scoreboard()).includes('0 balls 0 strikes')
    await settled(a.page)
    await b.tapEnabled('Ball')
    const tapped = Date.now()
    await a.waitScoreboard('1 balls 0 strikes', 3000)
    const took = Date.now() - tapped
    console.log(`      A showed B's ball ${took} ms after B's tap`)
    expect(took).lessThan(3000)
    await a.tapEnabled('Called Strike')
    await a.waitScoreboard('1 balls 1 strikes')
    await a.waitSaved()
    // Stored in that order: B's ball, then A's strike.
    const events = (await (
      await fetch(`${API}/games/${fixture.gameId}/events`, {
        headers: { Authorization: `Bearer ${token}` }
      })
    ).json()) as {
      currentPlay: { playEvents: Array<{ details: { code: string } }> } | null
    }
    expect(
      events.currentPlay!.playEvents.map(event => event.details.code)
    ).deep.equals(['B', 'C'])
    // And B, reading the game again, sees both.
    await b.waitScoreboard('1 balls 1 strikes')
  })

  it('L4: shows lineup, roster and defense changes at once with every request held, then offline', async function () {
    const fixture = lineupFixture()
    await a.scoreGame(fixture.gameId)
    await settled(a.page)
    // Every API request from here is held open: none is answered.
    const held: Array<{ url: string; request: HTTPRequest }> = []
    await a.page.setRequestInterception(true)
    const hold = (request: HTTPRequest): void => {
      if (request.url().includes('/api/')) {
        held.push({ url: request.url(), request })
        return
      }
      request.continue().catch(() => undefined)
    }
    a.page.on('request', hold)
    try {
      const opened = await a.editorShownWithin(3000)
      console.log(
        `      held: the roster editor showed ${opened} ms after the menu tap, no spinner`
      )
      await a.tap('Away Team', 'tab')
      await a.tap('Lineup', 'tab')
      await a.page.waitForSelector('[data-roster-target="lineup-0"]')
      // Lineup and roster: Maldonado out of the order, onto the roster.
      await a.tap('Remove Maldonado')
      expect(await a.lineup()).not.includes('Maldonado')
      await a.page.waitForSelector('[aria-label="Add Maldonado to Lineup"]')
      const saved = await a.saveShownWithin(3000)
      console.log(
        `      held: Save Rosters closed the sheet ${saved} ms after the tap`
      )
      const reopened = await a.editorShownWithin(3000)
      console.log(
        `      held: the editor showed again ${reopened} ms after the menu tap`
      )
      await a.tap('Away Team', 'tab')
      await a.tap('Lineup', 'tab')
      expect(await a.lineup()).not.includes('Maldonado')
      // Defense: the fielding side cleared, and the field waits for a pitcher.
      await a.tap('Home Team', 'tab')
      await a.tap('Defense', 'tab')
      await a.tap('Clear Defense')
      const cleared = await a.saveShownWithin(3000)
      console.log(
        `      held: the cleared defense saved on screen ${cleared} ms after the tap`
      )
      await a.page.waitForFunction(
        () => String(document.body.textContent).includes('Assign a pitcher'),
        { timeout: 3000 }
      )
      console.log(`      held: ${held.length} API requests still unanswered`)
      expect(held.length).greaterThan(0)
    } finally {
      // A held request stays open after interception ends, and the next
      // page's wait for quiet sees it: each held one goes on to the server
      // now, and so does any that comes while interception is switched off.
      a.page.off('request', hold)
      const pass = (request: HTTPRequest): void => {
        request.continue().catch(() => undefined)
      }
      a.page.on('request', pass)
      for (const { request } of held)
        await request.continue().catch(() => undefined)
      await a.page.setRequestInterception(false)
      a.page.off('request', pass)
      // The held phase's page goes: whatever it was still waiting on ends
      // with it, and the offline phase, and L5, start from a fresh load.
      await a.page.goto('about:blank')
      inFlight.get(a.page)?.clear()
    }
    // Offline: the same, with nothing to reach.
    await a.scoreGame(fixture.gameId)
    await settled(a.page)
    await a.page.setOfflineMode(true)
    try {
      const opened = await a.editorShownWithin(3000)
      console.log(
        `      offline: the roster editor showed ${opened} ms after the menu tap, no spinner`
      )
      await a.tap('Away Team', 'tab')
      await a.tap('Lineup', 'tab')
      await a.page.waitForSelector('[data-roster-target="lineup-0"]')
      const before = await a.lineup()
      await a.tap(`Add Maldonado to Lineup`)
      expect(await a.lineup()).deep.equals([...before, 'Maldonado'])
      const saved = await a.saveShownWithin(3000)
      console.log(
        `      offline: Save Rosters closed the sheet ${saved} ms after the tap`
      )
      await a.editorShownWithin(3000)
      await a.tap('Away Team', 'tab')
      await a.tap('Lineup', 'tab')
      expect(await a.lineup()).deep.equals([...before, 'Maldonado'])
      await a.tap('Cancel')
    } finally {
      await a.page.setOfflineMode(false)
    }
  })

  it('L5: keeps the later lineup change of a side on both screens, the earlier one saved last', async function () {
    const fixture = lineupFixture()
    await a.scoreGame(fixture.gameId)
    await b.scoreGame(fixture.gameId)
    await settled(a.page)
    // A makes his change first, with no signal: it waits on his phone.
    await a.page.setOfflineMode(true)
    await a.openRosters()
    await a.tap('Remove Maldonado')
    const earlier = await a.lineup()
    await a.saveShownWithin(3000)
    const madeA = Date.now()
    await new Promise(resolve => setTimeout(resolve, 1500))
    // B makes his later, online, and it lands first.
    await b.openRosters()
    await b.dragAfter(0, 2)
    const later = await b.lineup()
    expect(later).not.deep.equals(earlier)
    await b.saveShownWithin(3000)
    const madeB = Date.now()
    await b.waitSaved()
    console.log(
      `      A's change made ${madeB - madeA} ms before B's; B's saved first`
    )
    // A's signal comes back: his older change is the one dropped.
    await a.page.setOfflineMode(false)
    // His queued save goes, is refused as stale, and is put on top of B's
    // without his older change.
    let status: string | null = null
    for (let i = 0; i < 120; i++) {
      status = await a.page.evaluate(() => {
        const node = document.querySelector('[aria-label="Save status"]')
        return node == null ? null : String(node.textContent)
      })
      if (status == null || status.includes('another device')) break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    console.log(`      A's save status once back online: ${String(status)}`)
    await a.openRosters()
    await a.waitLineup(later)
    await a.tap('Cancel')
    const stored = (await (
      await fetch(`${API}/games/${fixture.gameId}/lineups`, {
        headers: { Authorization: `Bearer ${token}` }
      })
    ).json()) as {
      away: { current: { batters: Array<{ name: string } | null> } | null }
    }
    const names = stored.away.current!.batters.map(batter =>
      String(batter?.name ?? '')
    )
    console.log(`      stored away order: ${names.join(', ')}`)
    expect(names.some(name => name.includes('Maldonado'))).equals(true)
    await b.openRosters()
    await b.waitLineup(later)
    await b.tap('Cancel')
    // Made later and saved later: A's change stands over B's.
    await a.openRosters()
    await a.tap('Remove Maldonado')
    const latest = await a.lineup()
    await a.saveShownWithin(3000)
    await a.waitSaved()
    await b.openRosters()
    await b.waitLineup(latest)
    await b.tap('Cancel')
    console.log(
      '      the later change stood on both screens, whichever saved first'
    )
  })
})
