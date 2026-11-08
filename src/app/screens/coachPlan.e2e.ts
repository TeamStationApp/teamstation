import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The functions puppeteer runs in the page are transpiled by sucrase, which
// turns ?. and ?? into helpers the page does not have: they use neither.
import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import type { Page } from 'puppeteer'

import type { LineupFixture } from '../../server/dev/lineupFixture'
import { signInTestAccount } from '../../test/passwordFixtures'
import {
  type BrowserSession,
  browserSession,
  maestro
} from '../../test/refinementsMaestro.e2e'

/**
 * Coach Plan end to end: the coaching screen's tabs, footer and field, and
 * the scorekeeper's roster sheet, in maestro-d's Chromium at an iPhone's
 * 402×874, against the real local stack — the API (`npm start`), the web
 * app built against it (`npm run start.web`) and a game from `npm run
 * lineup-fixture`, made afresh for each scenario. One browser, one tab: the
 * head coach and the scorekeeper take turns in it.
 *
 *   MAESTRO_D=<daemon> MAESTRO_D_BIN=… TS_MAESTRO_D_CLIENT=… \
 *   TS_SCORING_TEST_URL=http://127.0.0.1:8180 \
 *   TS_API_TEST_URL=http://127.0.0.1:9180/api/v1 \
 *   TS_LINEUP_PASSWORD=<the fixture's password> \
 *   TS_LINEUP_ARTIFACTS=<dir> \
 *     node_modules/.bin/mocha -r sucrase/register --extension ts \
 *     --timeout 180000 src/app/screens/coachPlan.e2e.ts
 *
 * `TS_CAPTURE_ONLY=1` runs only the capture block, which saves
 * `coach-box-<phase>.png`, `coach-defense-<phase>.png` and
 * `scorekeeper-roster-<phase>.png` into `TS_LINEUP_ARTIFACTS`, where the
 * phase is `TS_ARTIFACT_PHASE` (`after` by default). It reads only what both
 * the old and the new screens have: the `Coach` pill, a tab named `Box` or
 * `Box Score`, the `Defense` tab, and the scorekeeper's `Open scoring menu`
 * → `Set Team Rosters` → `Defense`.
 *
 * Otherwise the scenarios run: P1 finds Box Score a pill of its own above
 * Roster, Lineup and Defense; P2 finds Cancel left of the microphone on Save
 * Rosters' row; P3 reads the coach's Defense field, whose nine cards sit on
 * six rows with names at 13.75 points; P11 finds the scorekeeper's footer
 * and field the same. P2 and P11 need a server that dictates, so the bar
 * draws its microphone; no scenario presses it.
 */
const APP = process.env.TS_SCORING_TEST_URL ?? 'http://127.0.0.1:8180'
const API = process.env.TS_API_TEST_URL ?? 'http://127.0.0.1:9180/api/v1'
const PASSWORD = process.env.TS_LINEUP_PASSWORD ?? ''
const ARTIFACTS = process.env.TS_LINEUP_ARTIFACTS
const PHASE = process.env.TS_ARTIFACT_PHASE ?? 'after'
const CAPTURING = process.env.TS_CAPTURE_ONLY === '1'
const WIDTH = 402
const HEIGHT = 874
/** Box Score, on either version: a tab named `Box`, or the `Box Score` pill. */
const BOX_SCORE = '[aria-label="Box"][role="tab"], [aria-label="Box Score"]'

type Person = keyof LineupFixture['users']
interface FieldCard {
  top: number
  bottom: number
  lines: number
  nameFont: number
}
interface Box {
  x: number
  y: number
  width: number
  height: number
}
interface Footer {
  bar: Box
  /** Cancel's word and Save Rosters' word, inside their buttons. */
  cancel: Box
  mic: Box
  save: Box
  cancelInBar: boolean
}

/** The positions whose cards share a vertical band, top to bottom. */
function cardRows(cards: Record<string, FieldCard>): string[][] {
  const rows: Array<{ bottom: number; positions: string[] }> = []
  for (const [position, card] of Object.entries(cards).sort(
    ([, a], [, b]) => a.top - b.top
  )) {
    const row = rows[rows.length - 1]
    if (row != null && card.top < row.bottom) {
      row.positions.push(position)
      row.bottom = Math.max(row.bottom, card.bottom)
    } else rows.push({ bottom: card.bottom, positions: [position] })
  }
  return rows.map(row => row.positions)
}

/** A new game, its rosters and the people who use it. */
function lineupFixture(): LineupFixture {
  const out = execFileSync(
    'npm',
    ['run', '--silent', 'lineup-fixture', '--', '--password', PASSWORD],
    { encoding: 'utf8' }
  )
  return JSON.parse(out) as LineupFixture
}

const tokens = new Map<string, string>()
async function tokenOf(fixture: LineupFixture, who: Person): Promise<string> {
  const email = fixture.users[who].email
  let token = tokens.get(email)
  if (token == null) {
    token = await signInTestAccount(API, { email, password: PASSWORD })
    tokens.set(email, token)
  }
  return token
}

/** One browser, and what the scenarios do in it. */
class Browser {
  readonly errors: string[] = []
  constructor(
    readonly session: BrowserSession,
    readonly page: Page
  ) {
    page.on('pageerror', (error: unknown) => {
      this.errors.push(
        error instanceof Error ? String(error.stack) : String(error)
      )
    })
  }

  /** Signs this browser in as one of the fixture's people. */
  async as(fixture: LineupFixture, who: Person): Promise<void> {
    await this.page.browserContext().setCookie({
      name: 'ts_session',
      value: encodeURIComponent(await tokenOf(fixture, who)),
      domain: new URL(APP).hostname,
      path: '/'
    })
  }

  async tapCss(css: string): Promise<void> {
    await this.page.waitForSelector(css, { visible: true })
    await this.session.m.tapOn({ css, timeout: 15000 })
  }

  async tap(label: string, role?: string): Promise<void> {
    await this.tapCss(
      role == null
        ? `[aria-label="${label}"]`
        : `[aria-label="${label}"][role="${role}"]`
    )
  }

  /** Coach Game, opened from the game's `Coach` pill. */
  async coachGame(gameId: string): Promise<void> {
    await this.page.goto(`${APP}/games/${gameId}`, {
      waitUntil: 'domcontentloaded'
    })
    await this.page.waitForSelector('[aria-label="Game sections"]', {
      timeout: 60000
    })
    await this.tap('Coach')
    await this.page.waitForSelector('[aria-label="Save Rosters"]', {
      timeout: 60000
    })
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

  /** The Defense tab chosen and its field drawn, every card in place. */
  async defense(): Promise<void> {
    await this.tap('Defense', 'tab')
    await this.page.waitForSelector(
      '[aria-label="Defense"][role="tab"][aria-selected="true"]',
      { timeout: 15000 }
    )
    await this.page.waitForSelector('[data-testid="Defensive field"]', {
      visible: true,
      timeout: 15000
    })
    await this.page.waitForSelector('[data-roster-target="defense-CF"]', {
      visible: true,
      timeout: 15000
    })
  }

  /** Each position card's vertical extent and its name's font size. */
  async fieldCards(): Promise<Record<string, FieldCard>> {
    return await this.page.$$eval('[data-testid^="Defense "]', nodes => {
      const cards: Record<string, FieldCard> = {}
      for (const node of nodes) {
        const match = /^Defense (\S+) card$/.exec(
          String(node.getAttribute('data-testid'))
        )
        if (match == null) continue
        const box = node.getBoundingClientRect()
        const lines = node.querySelectorAll('[dir="auto"]')
        const name = lines[lines.length - 1]
        cards[match[1]] = {
          top: box.top,
          bottom: box.bottom,
          lines: lines.length,
          nameFont: parseFloat(window.getComputedStyle(name).fontSize)
        }
      }
      return cards
    })
  }

  /** Where the roster footer bar draws Cancel, the microphone and Save. */
  async footer(): Promise<Footer> {
    await this.page.waitForSelector('[data-testid="Roster mic"]', {
      visible: true,
      timeout: 15000
    })
    // The scorekeeper's sheet slides up as it opens: read once it is still.
    let last = ''
    for (let read = 0; read < 20; read++) {
      const now = await this.page.$eval(
        '[data-testid="Roster footer bar"]',
        node => String(node.getBoundingClientRect().bottom)
      )
      if (now === last) break
      last = now
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return await this.page.evaluate(() => {
      const box = (node: Element): Box => {
        const r = node.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }
      const word = (node: Element): Box => {
        const label = node.querySelector('[dir="auto"]')
        // No `??` here: the page has no sucrase helpers.
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
        return box(label == null ? node : label)
      }
      const bar = document.querySelector('[data-testid="Roster footer bar"]')!
      const cancel = document.querySelector('[data-testid="Roster cancel"]')!
      return {
        bar: box(bar),
        cancel: word(cancel),
        mic: box(bar.querySelector('[data-testid="Roster mic"]')!),
        save: word(bar.querySelector('[aria-label="Save Rosters"]')!),
        cancelInBar: bar.contains(cancel)
      }
    })
  }

  /** The whole phone frame, once it has settled. */
  async shot(name: string): Promise<void> {
    if (ARTIFACTS == null) return
    await this.session.m.waitForAnimationToEnd()
    await writeFile(join(ARTIFACTS, name), await this.session.m.screenshot())
  }
}

/** Cancel in the bar, left of the microphone, level with Save Rosters. */
function expectFooterRow(footer: Footer): void {
  const { bar, cancel, mic, save } = footer
  expect(footer.cancelInBar).equals(true)
  expect(cancel.x + cancel.width).lessThan(mic.x)
  expect(mic.x + mic.width).lessThan(save.x + 1)
  expect(Math.abs(cancel.y - save.y)).lessThan(4)
  for (const each of [cancel, mic, save]) {
    expect(each.y).at.least(bar.y - 0.5)
    expect(each.y + each.height).at.most(bar.y + bar.height + 0.5)
  }
  expect(bar.y + bar.height).at.most(HEIGHT)
}

describe('Coach Plan', function () {
  let daemon: Awaited<ReturnType<typeof maestro>>
  let coach: Browser

  before(async function () {
    if (PASSWORD === '')
      throw new Error('Supply TS_LINEUP_PASSWORD, the lineup fixture password')
    for (const url of [APP, API])
      if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
        throw new Error(`${url} must be a local server`)
    if (ARTIFACTS != null) await mkdir(ARTIFACTS, { recursive: true })
    daemon = await maestro(process.env.MAESTRO_D ?? 'coachPlan')
    const session = await browserSession(
      daemon,
      'coach-plan-coach',
      WIDTH,
      HEIGHT,
      join(tmpdir(), 'coach-plan-e2e')
    )
    session.page.setDefaultTimeout(30000)
    coach = new Browser(session, session.page)
  })

  after(async function () {
    if (coach != null && coach.errors.length > 0)
      console.log(`    browser errors: ${coach.errors.join('\n')}`)
    try {
      await coach?.session.browser.close()
    } finally {
      await daemon?.shutdown()
    }
  })

  it('captures the coach Box Score and Defense tabs and the scorekeeper roster sheet', async function () {
    if (!CAPTURING && ARTIFACTS == null) this.skip()
    const fixture = lineupFixture()
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    await coach.tapCss(BOX_SCORE)
    await coach.page.waitForFunction(
      () => {
        const box = document.querySelector('[data-testid="Roster box score"]')
        return (
          box != null &&
          String(box.textContent).includes('The game has not started')
        )
      },
      { timeout: 30000 }
    )
    await coach.page.waitForSelector('[data-testid="Roster footer bar"]', {
      visible: true
    })
    await coach.shot(`coach-box-${PHASE}.png`)

    await coach.defense()
    await coach.shot(`coach-defense-${PHASE}.png`)

    await coach.as(fixture, 'scorekeeper')
    await coach.scoreGame(fixture.gameId)
    await coach.tap('Open scoring menu')
    await coach.tap('Set Team Rosters')
    await coach.page.waitForSelector('[aria-label="Save Rosters"]', {
      timeout: 30000
    })
    if ((await coach.page.$('[aria-label="Home Team"][role="tab"]')) != null)
      await coach.tap('Home Team', 'tab')
    await coach.defense()
    await coach.shot(`scorekeeper-roster-${PHASE}.png`)
  })

  it('P1 puts Box Score in a pill of its own above Roster, Lineup and Defense, none of them chosen', async function () {
    if (CAPTURING) this.skip()
    const fixture = lineupFixture()
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    const read = async (): Promise<{
      pill: Box & { selected: string | null }
      tabs: Array<Box & { label: string; selected: string | null }>
    }> =>
      await coach.page.evaluate(() => {
        const box = (node: Element): Box => {
          const r = node.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        }
        const pill = document.querySelector('[data-testid="Box Score pill"]')!
        return {
          pill: { ...box(pill), selected: pill.getAttribute('aria-selected') },
          // The roster screen's own tabs: the game's are behind it.
          tabs: [
            ...document
              .querySelector('[aria-label="Roster"][role="tab"]')!
              .parentElement!.querySelectorAll('[role="tab"]')
          ].map(tab => ({
            ...box(tab),
            label: String(tab.getAttribute('aria-label')),
            selected: tab.getAttribute('aria-selected')
          }))
        }
      })
    const opened = await read()
    expect(opened.tabs.map(tab => tab.label)).deep.equals([
      'Roster',
      'Lineup',
      'Defense'
    ])
    expect(opened.pill.selected).equals('true')
    for (const tab of opened.tabs)
      expect(tab.selected, tab.label).not.equals('true')
    // Its own row: wholly above the three, which share one.
    for (const tab of opened.tabs) {
      expect(opened.pill.y + opened.pill.height).at.most(tab.y + 0.5)
      expect(tab.y).closeTo(opened.tabs[0].y, 0.5)
    }
    await coach.tap('Lineup', 'tab')
    await coach.page.waitForSelector(
      '[aria-label="Lineup"][role="tab"][aria-selected="true"]',
      { timeout: 15000 }
    )
    const lineup = await read()
    expect(lineup.pill.selected).equals('false')
    expect(
      lineup.tabs.filter(tab => tab.selected === 'true').map(tab => tab.label)
    ).deep.equals(['Lineup'])
  })

  it('P2 puts the coach’s Cancel left of the microphone, on Save Rosters’ row', async function () {
    if (CAPTURING) this.skip()
    const fixture = lineupFixture()
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    await coach.tap('Lineup', 'tab')
    await coach.page.waitForSelector(
      '[aria-label="Lineup"][role="tab"][aria-selected="true"]',
      { timeout: 15000 }
    )
    expectFooterRow(await coach.footer())
  })

  it('P3 lays the coach’s Defense field out on six rows with larger names', async function () {
    if (CAPTURING) this.skip()
    const fixture = lineupFixture()
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    await coach.defense()
    const cards = await coach.fieldCards()
    expect(Object.keys(cards).sort()).deep.equals(
      ['1B', '2B', '3B', 'C', 'CF', 'LF', 'P', 'RF', 'SS'].sort()
    )
    const rows = cardRows(cards)
    expect(Math.max(...rows.map(row => row.length))).lessThan(3)
    expect(rows.map(row => [...row].sort())).deep.equals([
      ['CF'],
      ['LF', 'RF'],
      ['2B', 'SS'],
      ['1B', '3B'],
      ['P'],
      ['C']
    ])
    expect(cards.CF.bottom).lessThan(Math.min(cards.LF.top, cards.RF.top))
    expect(cards.P.top).greaterThan(
      Math.max(cards['3B'].bottom, cards['1B'].bottom)
    )
    // Two lines on a phone-sized Coach screen, the name at 11 × 1.25.
    for (const card of Object.values(cards)) {
      expect(card.lines).equals(2)
      expect(card.nameFont).closeTo(13.75, 0.01)
    }

    // A 320 × 568 screen draws "P · Name" on one line, shrunk to fit the
    // card whole, never below three quarters of its 12.5 points.
    const [width, height] = [320, 568]
    const session = await browserSession(
      daemon,
      'coach-plan-narrow-field',
      width,
      height,
      join(tmpdir(), 'coach-plan-e2e-narrow-field')
    )
    session.page.setDefaultTimeout(30000)
    const narrow = new Browser(session, session.page)
    try {
      await narrow.as(fixture, 'headCoach')
      await narrow.coachGame(fixture.gameId)
      await narrow.defense()
      await session.m.waitForAnimationToEnd()
      const texts = await narrow.page.$$eval(
        '[data-testid^="Defense "][data-testid$=" card"] [dir="auto"]',
        nodes =>
          nodes.map(node => ({
            text: String(node.textContent),
            scroll: node.scrollWidth,
            client: node.clientWidth,
            size: parseFloat(getComputedStyle(node).fontSize)
          }))
      )
      console.log(`    field at ${width} wide: ${JSON.stringify(texts)}`)
      expect(texts).has.length(9)
      for (const each of texts) {
        expect(each.text).match(/^(P|C|1B|2B|3B|SS|LF|CF|RF) · #\d+ \S/)
        expect(each.scroll, each.text).at.most(each.client)
        expect(each.size, each.text).within(12.5 * 0.75 - 0.01, 12.5)
      }
      await narrow.shot(`defense-320-${PHASE}.png`)
    } finally {
      await session.browser.close()
    }
  })

  it('P11 puts the scorekeeper’s Cancel beside the microphone and Save Rosters, over a field with no row of three', async function () {
    if (CAPTURING) this.skip()
    const fixture = lineupFixture()
    await coach.as(fixture, 'scorekeeper')
    await coach.scoreGame(fixture.gameId)
    await coach.tap('Open scoring menu')
    await coach.tap('Set Team Rosters')
    await coach.page.waitForSelector('[aria-label="Save Rosters"]', {
      timeout: 30000
    })
    expectFooterRow(await coach.footer())
    await coach.defense()
    expectFooterRow(await coach.footer())
    const cards = await coach.fieldCards()
    expect(Object.keys(cards)).has.length(9)
    expect(Math.max(...cardRows(cards).map(row => row.length))).lessThan(3)
  })
})
