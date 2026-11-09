import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// The functions puppeteer runs in the page are transpiled by sucrase, which
// turns ?. and ?? into helpers the page does not have: they use neither.
import { expect } from 'chai'
import { build } from 'esbuild'
import { after, before, describe, it } from 'mocha'
import type { Page } from 'puppeteer'

import type { Lineup, LineupPerson, SaveLineupsBody } from '../../common/api'
import type { GamePlan, PlanCell } from '../../common/gamePlan'
import {
  asPlayingTimeRules,
  type PlayingTimeRules
} from '../../common/playingTimeRules'
import { POSITIONS } from '../../common/scoring/state'
import { makeDatabase } from '../../server/db/database'
import type { LineupFixture } from '../../server/dev/lineupFixture'
import { serverConfig } from '../../server/serverConfig'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
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
 * `TS_CAPTURE_ONLY=1` runs only the capture blocks, which save
 * `coach-box-<phase>.png`, `defense-coach-<phase>.png`,
 * `defense-scorekeeper-<phase>.png`, `plan-tab-<phase>.png`,
 * `plan-picker-<phase>.png` and `dictation-overlay-<phase>.png` (and, once
 * the Defense tab has its Help, `defense-help-sheet.png`) into
 * `TS_LINEUP_ARTIFACTS`, where the phase is `TS_ARTIFACT_PHASE` (`after` by
 * default). They read only what both the old and the new screens have: the
 * `Coach` pill, a tab named `Box` or `Box Score`, the `Defense` and `Plan`
 * tabs, the scorekeeper's `Open scoring menu` → `Set Team Rosters` →
 * `Defense`, and the Plan tab's `Plan cell 1-1`. The Plan tab holds P8's
 * plan, and is captured at its whole content height. The dictation overlay
 * is `rosterChatOverlay.fixture.tsx`, the real roster editor with its chat
 * open, which the block bundles into `dist/` (after `npm run build.web`) and
 * serves from there with a harness of its own.
 *
 * Otherwise the scenarios run: D1 reads the Defense tab for the coach and
 * the scorekeeper: Help and Clear in the field's top corners and clear of
 * its cards, no instruction line or Roster header, the roster cards from
 * margin to margin and a row higher than the base drew them, the Help
 * sheet's words and its backdrop closing it, the coach's Box Score pill
 * seven points under his header, and a red Cancel as large as Save Rosters.
 * D2 opens the roster chat fixture and finds the chat over the roster,
 * which does not move when it closes, its question answered by an option,
 * and the chat closed by its X and by a tap on its words. P1 finds Box
 * Score a pill of its own above Roster, Lineup, Defense and Plan; P2 finds
 * Cancel, a red button as large as Save Rosters, left of the microphone on
 * Save Rosters' row; P3 reads the coach's Defense field, whose nine cards
 * sit on six rows with names at 13.75 points; P4 to P9 work the Plan tab:
 * its grid (P4), typing and pasting into a cell (P5), the field picker (P6),
 * moving a player's row (P7), the live playing-time warnings and the save's
 * summary (P8), and Clear (P9); P10 scores the game with the plan's toggle
 * on and then off, ending halves from the scoring menu, and reads the
 * defence the game stores after each inning's end, with a mid-game edit of
 * the plan made while the scoring screen is open; P11 finds the
 * scorekeeper's footer and field
 * as P2 and P3 do. P12 fits the footer on a 320-point screen; P13 has the
 * scorekeeper reorder the lineup over the API after the coach's plan is
 * saved, and finds the coach's screen opening clean, Back asking nothing.
 * P14 has the head coach turn his plan on and save before the first pitch,
 * and reads the defence the game's lineup starts in: the plan's inning 1.
 * P2 and P11 need a server that dictates, so the bar draws
 * its microphone; no scenario presses it. P4, P5 and P8 save
 * `coach-plan.png`, `coach-plan-picker-web.png` and
 * `coach-plan-clear-confirm.png` into `TS_LINEUP_ARTIFACTS` when it is set.
 *
 * P8 and P10 give the home team its Playing Time Rules in the fixture's database
 * (`serverConfig.json`'s, which `lineup-fixture` writes to): the fixture's
 * head coach coaches the team but does not administer it, and the rules'
 * own `PUT /groups/team/:id` is tested with the settings screen.
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
  /** The two buttons themselves, and Cancel's fill and word colours. */
  cancelButton: Box
  saveButton: Box
  cancelFill: string
  cancelText: string
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

/**
 * A plan for the home side's nine in batting order, every inning filled but
 * the sixth's RF: Marte (fifth) sits the fifth and sixth.
 */
const HOME_PLAN: PlanCell[][] = [
  ['P', 'P', 'P', '1B', '1B', 'DH'],
  ['SS', 'SS', 'SS', 'SS', '2B', '2B'],
  ['1B', '1B', '1B', 'P', 'P', 'P'],
  ['CF', 'CF', 'LF', 'LF', 'CF', 'CF'],
  ['RF', 'RF', 'RF', 'RF', '-', '-'],
  ['2B', '2B', '2B', '2B', 'SS', 'SS'],
  ['3B', '3B', '3B', '3B', '3B', '3B'],
  ['LF', 'LF', 'CF', 'CF', 'LF', 'LF'],
  ['C', 'C', 'C', 'C', 'C', 'C']
]

/** Saves the home side's game plan as its head coach does. */
async function savePlan(
  fixture: LineupFixture,
  cells: PlanCell[][],
  enabled = true
): Promise<void> {
  const plan: GamePlan = {
    enabled,
    innings: cells[0].length,
    rows: cells.map((row, at) => {
      const player = fixture.players.home[at]
      return {
        player: {
          gumboId: player.gumboId,
          fullName: player.name,
          jersey: player.jersey
        },
        cells: row
      }
    })
  }
  const answer = await fetch(
    `${API}/games/${fixture.gameId}/plans/${fixture.teams.home}`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${await tokenOf(fixture, 'headCoach')}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(plan)
    }
  )
  expect(answer.status, await answer.text()).equals(200)
}

/** The home team's own Playing Time Rules, written where the API keeps them. */
async function teamRules(
  fixture: LineupFixture,
  rules: Partial<PlayingTimeRules>
): Promise<void> {
  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    await db
      .updateTable('teams')
      .set({ playing_time_rules: asPlayingTimeRules(rules) })
      .where('id', '=', fixture.teams.home)
      .execute()
  } finally {
    await db.destroy()
  }
}

/** P8's Playing Time Rules, which the Plan tab's capture shows too. */
const P8_RULES: Partial<PlayingTimeRules> = {
  mandatoryPlay: true,
  enforceSittingLimits: true,
  rotateLeadoff: true
}

/**
 * D2's fixture page: `rosterChatOverlay.fixture.tsx` bundled into `dist/`
 * beside a fresh web build, whose page it borrows for its fonts and icons,
 * and served from there by a harness of its own at
 * `/roster-chat-overlay-fixture.html`.
 */
async function rosterChatHarness(): Promise<AccountHarness> {
  execFileSync('npm', ['run', '--silent', 'build.web'], { stdio: 'ignore' })
  const { webSettings } = await import(
    resolve('scripts/web-build-settings.mjs')
  )
  await build({
    ...webSettings,
    entryPoints: ['src/test/rosterChatOverlay.fixture.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    outfile: 'dist/roster-chat-overlay-fixture.js',
    define: {
      __DEV__: 'true',
      global: 'globalThis',
      'process.env': '{}',
      'process.env.NODE_ENV': '"development"'
    },
    loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
  })
  // The app's own page, its fonts and icons, with the fixture for the app.
  const page = (await readFile('dist/index.html', 'utf8')).replace(
    /<script src="\/app-[^"]*"[^>]*><\/script>/,
    '<script src="/roster-chat-overlay-fixture.js"></script>'
  )
  if (!page.includes('roster-chat-overlay-fixture.js'))
    throw new Error('dist/index.html loads no app script to replace')
  await writeFile('dist/roster-chat-overlay-fixture.html', page)
  return await accountHarness(resolve('dist'))
}

/**
 * P10's plan for the home side's nine, in batting order (Ohtani, Lindor,
 * Alonso, Nimmo, Marte, McNeil, Escobar, Canha, Senga), who open at P, C,
 * 1B, 2B, SS, 3B, LF, CF and RF: inning 2 swaps the corners and LF with CF
 * and sits Senga, leaving RF empty; inning 3 swaps them back and puts Senga
 * in RF. The mid-game edit sits Senga in inning 3 as well, a third sit.
 */
const SHIFT_PLAN: PlanCell[][] = [
  ['P', 'P', 'P', 'P', 'P', 'P'],
  ['C', 'C', 'C', 'C', 'C', 'C'],
  ['1B', '3B', '1B', '1B', '1B', '1B'],
  ['2B', '2B', '2B', '2B', '2B', '2B'],
  ['SS', 'SS', 'SS', 'SS', 'SS', 'SS'],
  ['3B', '1B', '3B', '3B', '3B', '3B'],
  ['LF', 'CF', 'LF', 'LF', 'LF', 'LF'],
  ['CF', 'LF', 'CF', 'CF', 'CF', 'CF'],
  ['-', '-', 'RF', 'RF', 'RF', 'RF']
]
const SHIFT_EDITED: PlanCell[][] = SHIFT_PLAN.map((row, at) =>
  at === 8 ? ['-', '-', '-', 'RF', 'RF', 'RF'] : row
)

/**
 * P14's plan: SHIFT_PLAN with its second inning first, so the lineup
 * starts with the corners and LF and CF swapped from the defaults, and
 * Senga sitting, RF empty.
 */
const OPENING_PLAN: PlanCell[][] = SHIFT_PLAN.map(row => [
  row[1],
  ...row.slice(1)
])

/** Who a plan's column puts at each position, by gumboId; null for none. */
function columnDefense(
  fixture: LineupFixture,
  cells: PlanCell[][],
  inning: number
): Record<string, number | null> {
  const defense: Record<string, number | null> = Object.fromEntries(
    POSITIONS.map(position => [position, null])
  )
  cells.forEach((row, at) => {
    const cell = row[inning - 1]
    if (cell in defense) defense[cell] = fixture.players.home[at].gumboId
  })
  return defense
}

/** The home side's defence as the game's lineups hold it, by gumboId. */
async function homeDefense(
  fixture: LineupFixture
): Promise<Record<string, number | null>> {
  const answer = await fetch(`${API}/games/${fixture.gameId}/lineups`, {
    headers: {
      authorization: `Bearer ${await tokenOf(fixture, 'scorekeeper')}`
    }
  })
  expect(answer.status).equals(200)
  const { home } = (await answer.json()) as {
    home: {
      current: {
        defense: Record<string, { gumboId: number | null } | null>
      } | null
    }
  }
  return Object.fromEntries(
    POSITIONS.map(position => [
      position,
      home.current?.defense[position]?.gumboId ?? null
    ])
  )
}

/** A defence by gumboId, as names, for the log. */
function named(
  fixture: LineupFixture,
  defense: Record<string, number | null>
): string {
  return POSITIONS.map(position => {
    const player = fixture.players.home.find(
      each => each.gumboId === defense[position]
    )
    return `${position} ${player?.name ?? '—'}`
  }).join(', ')
}

/** Waits for the game as stored to have reached `inning`'s first pitch. */
async function storedInning(
  fixture: LineupFixture,
  inning: number
): Promise<void> {
  const deadline = Date.now() + 30000
  for (;;) {
    const answer = await fetch(`${API}/games/${fixture.gameId}/events`, {
      headers: {
        authorization: `Bearer ${await tokenOf(fixture, 'scorekeeper')}`
      }
    })
    const read = (await answer.json()) as {
      currentPlay: { about: { inning: number } } | null
    }
    if ((read.currentPlay?.about.inning ?? 0) >= inning) return
    if (Date.now() > deadline)
      throw new Error(`The game was never saved into inning ${inning}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
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

  /** The scoring menu's End Half Inning, confirmed. */
  async endHalf(): Promise<void> {
    const half = await this.page.$eval('[aria-label="Open scoring menu"]', () =>
      String(document.body.textContent)
    )
    await this.tap('Open scoring menu')
    await this.tap('End Half Inning')
    await this.tap('Confirm End Half Inning')
    await this.page.waitForFunction(
      before => String(document.body.textContent) !== before,
      { timeout: 15000 },
      half
    )
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  /** One ball to the batter up, once the screen takes it. */
  async ball(): Promise<void> {
    await this.tap('Ball')
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  /** What the scoring screen says the last inning shift did, if anything. */
  async planNotice(): Promise<string | null> {
    return await this.page.evaluate(() => {
      const node = document.querySelector('[data-testid="scoringPlanNotice"]')
      return node == null ? null : String(node.textContent)
    })
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

  /** Defense's Help pressed, and its sheet up. */
  async helpSheet(): Promise<string> {
    await this.tap('Defense help')
    const text = await this.page.waitForSelector(
      '[data-testid="Help sheet text"]',
      { visible: true, timeout: 15000 }
    )
    await this.session.m.waitForAnimationToEnd()
    return await text!.evaluate(node => String(node.textContent))
  }

  /** The help sheet closed by a tap on the backdrop above it. */
  async closeHelpSheet(): Promise<void> {
    const sheet = await this.box('[data-testid="Scoring sheet"]')
    await this.page.mouse.click(WIDTH / 2, sheet.y / 2)
    await this.page.waitForSelector('[data-testid="Help sheet text"]', {
      hidden: true,
      timeout: 15000
    })
  }

  /** An element's box, as the page lays it out. */
  async box(css: string): Promise<Box> {
    return await this.page.$eval(css, node => {
      const r = node.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
  }

  /**
   * The Defense tab's layout: Help and Clear, the position cards, the
   * roster cards, the footer bar's edges, and whether the old instruction
   * line and Roster header are drawn.
   */
  async defenseLayout(): Promise<{
    field: Box
    help: Box
    clear: Box
    cards: Box[]
    roster: Box[]
    bar: Box
    instruction: boolean
    header: boolean
  }> {
    return await this.page.evaluate(() => {
      const box = (node: Element): Box => {
        const r = node.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }
      const field = document.querySelector('[data-testid="Defensive field"]')!
      return {
        field: box(field),
        help: box(document.querySelector('[aria-label="Defense help"]')!),
        clear: box(document.querySelector('[aria-label="Clear Defense"]')!),
        cards: Array.from(
          field.querySelectorAll(
            '[data-testid^="Defense "][data-testid$=" card"]'
          )
        ).map(box),
        roster: Array.from(
          document.querySelectorAll(
            '[data-testid="Defense roster grid"] [data-roster-player]'
          )
        ).map(box),
        bar: box(document.querySelector('[data-testid="Roster footer bar"]')!),
        instruction: String(document.body.textContent).includes(
          'Drag a player into position'
        ),
        header:
          document.querySelector('[data-testid="Defense roster header"]') !=
          null
      }
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
      const save = bar.querySelector('[aria-label="Save Rosters"]')!
      const label = cancel.querySelector('[dir="auto"]')
      return {
        bar: box(bar),
        cancel: word(cancel),
        mic: box(bar.querySelector('[data-testid="Roster mic"]')!),
        save: word(save),
        cancelInBar: bar.contains(cancel),
        cancelButton: box(cancel),
        saveButton: box(save),
        cancelFill: getComputedStyle(cancel).backgroundColor,
        // No `?.` here: the page has no sucrase helpers.
        cancelText: label == null ? '' : getComputedStyle(label).color
      }
    })
  }

  /** The Plan tab chosen and its sheet drawn. */
  async plan(): Promise<void> {
    await this.tap('Plan', 'tab')
    await this.page.waitForSelector(
      '[aria-label="Plan"][role="tab"][aria-selected="true"]',
      { timeout: 15000 }
    )
    await this.page.waitForSelector('[data-testid="Plan cell 1-1"]', {
      visible: true,
      timeout: 15000
    })
  }

  /** A cell's text as the sheet shows it. */
  async cell(row: number, inning: number): Promise<string> {
    return await this.page.$eval(
      `[data-testid="Plan cell ${row}-${inning}"]`,
      node => (node as HTMLInputElement).value
    )
  }

  /** Every row's cells, top to bottom, as the sheet shows them. */
  async cells(): Promise<string[][]> {
    return await this.page.evaluate(() => {
      const rows: string[][] = []
      for (const node of document.querySelectorAll(
        '[data-testid^="Plan cell "]'
      )) {
        const match = /^Plan cell (\d+)-(\d+)$/.exec(
          String(node.getAttribute('data-testid'))
        )
        if (match == null) continue
        const row = Number(match[1]) - 1
        while (rows.length <= row) rows.push([])
        rows[row][Number(match[2]) - 1] = (node as HTMLInputElement).value
      }
      return rows
    })
  }

  /** The players down the sheet's left column. */
  async planPlayers(): Promise<string[]> {
    return await this.page.$$eval('[data-testid^="Plan player "]', nodes =>
      nodes.map(node => String(node.textContent))
    )
  }

  /** A click into a cell, which takes the focus there. */
  async click(css: string): Promise<void> {
    await this.page.waitForSelector(css, { visible: true })
    await this.page.click(css)
    await new Promise(resolve => setTimeout(resolve, 150))
  }

  /** The warnings shown, as `<level> <rule>: <text>`, reds first. */
  async warnings(): Promise<string[]> {
    return await this.page.$$eval('[data-testid^="Plan warning "]', nodes =>
      nodes.map(node => {
        const id = String(node.getAttribute('data-testid'))
        return `${id.slice('Plan warning '.length)}: ${String(node.textContent)}`
      })
    )
  }

  /** The whole phone frame, once it has settled. */
  async shot(name: string): Promise<void> {
    if (ARTIFACTS == null) return
    await this.session.m.waitForAnimationToEnd()
    await writeFile(join(ARTIFACTS, name), await this.session.m.screenshot())
  }

  /**
   * The whole of a screen that scrolls, in one frame: the window, as wide as
   * ever, is made as tall as `scroller`'s content needs for the shot, then
   * put back.
   */
  async tallShot(name: string, scroller: string): Promise<void> {
    if (ARTIFACTS == null) return
    const cdp = await this.page.createCDPSession()
    const scale = await this.page.evaluate(() => devicePixelRatio)
    try {
      let height = HEIGHT
      for (let pass = 0; pass < 3; pass++) {
        const extra = await this.page.$eval(scroller, node => {
          node.scrollTop = 0
          return node.scrollHeight - node.clientHeight
        })
        if (extra <= 0) break
        height += extra
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: WIDTH,
          height,
          deviceScaleFactor: scale,
          mobile: false
        })
        await new Promise(resolve => setTimeout(resolve, 600))
      }
      await this.session.m.waitForAnimationToEnd()
      await writeFile(join(ARTIFACTS, name), await this.page.screenshot())
    } finally {
      // Back to the phone's frame. Clearing the override instead would drop
      // maestro-d's too, leaving the headless window's own, wider size for
      // whatever comes next.
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: WIDTH,
        height: HEIGHT,
        deviceScaleFactor: scale,
        mobile: false
      })
      await cdp.detach()
      await new Promise(resolve => setTimeout(resolve, 600))
    }
  }
}

/** Cancel in the bar, left of the microphone, level with Save Rosters. */
function expectFooterRow(footer: Footer, height = HEIGHT): void {
  const { bar, cancel, mic, save } = footer
  expect(footer.cancelInBar).equals(true)
  // Cancel is a red button with a white word, Save Rosters' size.
  expect(footer.cancelFill).equals('rgb(168, 53, 53)')
  expect(footer.cancelText).equals('rgb(255, 255, 255)')
  expect(footer.cancelButton.width).closeTo(footer.saveButton.width, 1)
  expect(footer.cancelButton.height).closeTo(footer.saveButton.height, 1)
  expect(footer.cancelButton.x + footer.cancelButton.width).lessThan(mic.x)
  expect(cancel.x + cancel.width).lessThan(mic.x)
  expect(mic.x + mic.width).lessThan(save.x + 1)
  expect(Math.abs(cancel.y - save.y)).lessThan(4)
  for (const each of [cancel, mic, save]) {
    expect(each.y).at.least(bar.y - 0.5)
    expect(each.y + each.height).at.most(bar.y + bar.height + 0.5)
  }
  expect(bar.y + bar.height).at.most(height)
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
    await coach.shot(`defense-coach-${PHASE}.png`)
    // The Defense help sheet, which the base has not got.
    if ((await coach.page.$('[aria-label="Defense help"]')) != null) {
      await coach.helpSheet()
      await coach.shot('defense-help-sheet.png')
      await coach.closeHelpSheet()
    }

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
    await coach.shot(`defense-scorekeeper-${PHASE}.png`)
  })

  it('captures the coach Plan tab, holding P8’s plan, and its picker', async function () {
    if (!CAPTURING && ARTIFACTS == null) this.skip()
    const fixture = lineupFixture()
    await teamRules(fixture, P8_RULES)
    await savePlan(fixture, HOME_PLAN)
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    await coach.plan()
    await coach.tallShot(`plan-tab-${PHASE}.png`, '[data-testid="Plan scroll"]')
    await coach.click('[data-testid="Plan cell 1-1"]')
    await coach.page.waitForSelector('[data-testid="Plan field picker"]', {
      visible: true
    })
    await coach.shot(`plan-picker-${PHASE}.png`)
  })

  it('captures the roster chat on the Defense tab, on its fixture page', async function () {
    if (!CAPTURING && ARTIFACTS == null) this.skip()
    const harness = await rosterChatHarness()
    try {
      await coach.page.goto(
        `${harness.origin}/roster-chat-overlay-fixture.html`,
        { waitUntil: 'domcontentloaded' }
      )
      await coach.page.waitForSelector('[data-testid="Roster chat"]', {
        visible: true,
        timeout: 60000
      })
      await coach.page.waitForSelector('[aria-label="Hawks #3"]', {
        visible: true
      })
      await coach.page.waitForSelector('[data-roster-target="defense-CF"]', {
        visible: true
      })
      await coach.shot(`dictation-overlay-${PHASE}.png`)
    } finally {
      // The browser keeps its connections open, which would hold the close.
      harness.server.closeAllConnections()
      await harness.close()
    }
  })

  it('D1 puts Help and Clear in the field’s top corners, drops the instruction and Roster header, runs the roster cards edge to edge, and halves the Box Score gap', async function () {
    if (CAPTURING) this.skip()
    const fixture = lineupFixture()
    /** The Defense tab as D1 reads it, for the coach or the scorekeeper. */
    const check = async (who: string, baseRosterTop: number): Promise<void> => {
      const layout = await coach.defenseLayout()
      console.log(`    D1 ${who}: ${JSON.stringify(layout)}`)
      const { field, help, clear, cards, roster, bar } = layout
      expect(layout.instruction, who).equals(false)
      expect(layout.header, who).equals(false)
      expect(help.x - field.x, who).closeTo(4, 1)
      expect(help.y - field.y, who).closeTo(4, 1)
      expect(field.x + field.width - (clear.x + clear.width), who).closeTo(4, 1)
      expect(clear.y - field.y, who).closeTo(4, 1)
      expect(cards).has.length(9)
      for (const control of [help, clear])
        for (const card of cards)
          expect(
            control.x + control.width <= card.x ||
              control.x >= card.x + card.width ||
              control.y + control.height <= card.y ||
              control.y >= card.y + card.height,
            `${who}: a control over a card`
          ).equals(true)
      // The four bench players, two to a row, from margin to margin: the
      // footer bar spans the same content.
      expect(roster).has.length(4)
      const left = Math.min(...roster.map(card => card.x))
      const right = Math.max(...roster.map(card => card.x + card.width))
      expect(left, who).closeTo(bar.x, 1)
      expect(right, who).closeTo(bar.x + bar.width, 1)
      // The list starts at least a row higher than at the base's capture.
      const top = Math.min(...roster.map(card => card.y))
      expect(top, who).lessThan(baseRosterTop - 28)
      expect(await coach.helpSheet()).equals(
        'Tap and drag players into positions.'
      )
      await coach.closeHelpSheet()
      expectFooterRow(await coach.footer())
    }
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    await coach.defense()
    // The base's coach Defense capture drew the first roster card's top at
    // 586 points, the scorekeeper's at 577; its Box Score pill 14 points
    // under the header.
    await check('coach', 586)
    const header = await coach.box('[data-testid="Coach header"]')
    const pill = await coach.box('[data-testid="Box Score pill"]')
    const gap = pill.y - (header.y + header.height)
    console.log(`    D1 Box Score gap: ${gap}`)
    expect(gap).closeTo(7, 1)

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
    await check('scorekeeper', 577)
  })

  it('D2 overlays the roster chat, which its X or a tap closes, and whose question still answers', async function () {
    if (CAPTURING) this.skip()
    const harness = await rosterChatHarness()
    /** The fixture opened afresh, its chat and question up. */
    const open = async (): Promise<void> => {
      await coach.page.goto(
        `${harness.origin}/roster-chat-overlay-fixture.html`,
        { waitUntil: 'domcontentloaded' }
      )
      await coach.page.waitForSelector('[data-testid="Roster chat"]', {
        visible: true,
        timeout: 60000
      })
      await coach.page.waitForSelector('[aria-label="Hawks #3"]', {
        visible: true
      })
      await coach.session.m.waitForAnimationToEnd()
    }
    const firstCard = async (): Promise<number> =>
      await coach.page.$eval(
        '[data-testid="Defense roster grid"] [data-roster-player]',
        node => node.getBoundingClientRect().y
      )
    const closed = async (): Promise<void> => {
      await coach.page.waitForSelector('[data-testid="Roster chat"]', {
        hidden: true,
        timeout: 15000
      })
    }
    try {
      // (1) The question's option answers it, and the chat stays.
      await open()
      const shown = await firstCard()
      const overlay = await coach.page.$eval(
        '[data-testid="Roster chat overlay"]',
        node => getComputedStyle(node).position
      )
      expect(overlay).equals('absolute')
      await coach.tap('Hawks #3')
      await coach.page.waitForSelector('[aria-label="Dictation question"]', {
        hidden: true,
        timeout: 15000
      })
      expect(await coach.page.$('[data-testid="Roster chat"]')).not.equals(null)
      // (2) The X closes it, and the roster has not moved.
      await open()
      await coach.tap('Close dictation')
      await closed()
      const hidden = await firstCard()
      console.log(`    D2 first roster card: ${shown} shown, ${hidden} hidden`)
      expect(hidden).closeTo(shown, 0.5)
      // (3) A tap on a turn's words closes it.
      await open()
      await coach.tapCss('[data-testid="Roster chat said"]')
      await closed()
    } finally {
      harness.server.closeAllConnections()
      await harness.close()
    }
  })

  it('P1 puts Box Score in a pill of its own above Roster, Lineup, Defense and Plan, none of them chosen', async function () {
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
      'Defense',
      'Plan'
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

  it('P4 lists the lineup in order, jersey first, in two-character inning columns that scroll sideways', async function () {
    if (CAPTURING) this.skip()
    const fixture = lineupFixture()
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    await coach.tap('Lineup', 'tab')
    const lineup = await coach.page.$$eval(
      '[data-roster-target^="lineup-"][data-roster-player]',
      nodes => nodes.map(node => String(node.textContent))
    )
    await coach.plan()
    const players = await coach.planPlayers()
    expect(players).has.length(9)
    // "≡ 1. #1 Ohtani ×" on the Lineup tab is "#1 Ohtani" here, in order.
    expect(players).deep.equals(
      lineup.map(text =>
        text
          .replace(/^≡?\s*\d+\.\s*/, '')
          .replace(/×$/, '')
          .trim()
      )
    )
    for (const player of players) expect(player).match(/^#\d+ \S/)
    const columns = await coach.page.evaluate(() => {
      const cell = document.querySelector('[data-testid="Plan cell 1-1"]')!
      // Two characters of the cell's own font.
      const probe = document.createElement('span')
      probe.style.font = getComputedStyle(cell).font
      probe.style.position = 'absolute'
      probe.style.width = '2ch'
      document.body.appendChild(probe)
      const twoCh = probe.getBoundingClientRect().width
      probe.remove()
      const headers = [
        ...document.querySelectorAll('[data-testid^="Plan inning "]')
      ]
      return {
        twoCh,
        headers: headers.map(node => String(node.textContent)),
        widths: [
          ...headers,
          ...[1, 2, 3, 4, 5, 6].map(
            inning =>
              document.querySelector(`[data-testid="Plan cell 1-${inning}"]`)!
                .parentElement!
          )
        ].map(node => node.getBoundingClientRect().width)
      }
    })
    expect(columns.headers).deep.equals(['1', '2', '3', '4', '5', '6'])
    expect(columns.twoCh).greaterThan(15)
    for (const width of columns.widths) expect(width).at.most(columns.twoCh + 9)
    await coach.tapCss('[data-testid="Plan add inning"]')
    await coach.page.waitForSelector('[data-testid="Plan inning 7"]')
    expect(await coach.cell(9, 7)).equals('')
    const sheet = await coach.page.$eval(
      '[data-testid="Plan innings"]',
      node => {
        const before = node.scrollWidth > node.clientWidth
        node.scrollLeft = 60
        return {
          before,
          scrolled: node.scrollLeft,
          // A drawn scrollbar track takes its height from the content box.
          track: (node as HTMLElement).offsetHeight - node.clientHeight,
          scrollbar: getComputedStyle(node).scrollbarWidth
        }
      }
    )
    expect(sheet.before).equals(true)
    expect(sheet.scrolled).greaterThan(0)
    expect(sheet.scrollbar).equals('none')
    expect(sheet.track).equals(0)
  })

  it('P5 selects a clicked cell’s text, opens the picker, takes values a key at a time and refuses X and a pasted SSS', async function () {
    if (CAPTURING) this.skip()
    const fixture = lineupFixture()
    await coach.as(fixture, 'headCoach')
    await coach.page.browserContext().setPermission(
      new URL(APP).origin,
      ...['clipboard-read', 'clipboard-write'].map(name => ({
        permission: { name },
        state: 'granted' as const
      }))
    )
    await coach.coachGame(fixture.gameId)
    await coach.plan()
    const first = '[data-testid="Plan cell 1-1"]'
    await coach.click(first)
    await coach.page.keyboard.type('c')
    expect(await coach.cell(1, 1)).equals('C')
    // Clicked again, the cell's text is selected and the picker opens.
    await coach.click('[data-testid="Plan toggle row"]')
    await coach.page.waitForFunction(
      () => document.querySelector('[data-testid="Plan field picker"]') == null
    )
    await coach.click(first)
    const selected = await coach.page.$eval(first, node => {
      const input = node as HTMLInputElement
      return [input.selectionStart, input.selectionEnd, input.value.length]
    })
    expect(selected).deep.equals([0, 1, 1])
    await coach.page.waitForSelector('[data-testid="Plan field picker"]', {
      visible: true
    })
    await coach.shot('coach-plan-picker-web.png')
    // S then S is SS; the S alone waits.
    await coach.page.keyboard.type('s')
    expect(await coach.cell(1, 1)).equals('S')
    await coach.page.keyboard.type('s')
    expect(await coach.cell(1, 1)).equals('SS')
    await coach.click('[data-testid="Plan cell 2-1"]')
    await coach.page.keyboard.type('1')
    await coach.page.keyboard.type('b')
    expect(await coach.cell(2, 1)).equals('1B')
    // X is no value: refused, the cell outlined in red, its value kept.
    await coach.click('[data-testid="Plan cell 3-1"]')
    await coach.page.keyboard.type('p')
    await coach.click('[data-testid="Plan cell 3-1"]')
    await coach.page.keyboard.type('X')
    const refused = await coach.page.$eval(
      '[data-testid="Plan cell 3-1"]',
      node => getComputedStyle(node).borderTopColor
    )
    expect(refused).equals('rgb(248, 113, 113)')
    expect(await coach.cell(3, 1)).equals('P')
    // A real paste of SSS, read whole and refused, not cut to SS.
    await coach.click('[data-testid="Plan cell 2-1"]')
    await coach.page.evaluate(async () => {
      await navigator.clipboard.writeText('SSS')
    })
    await coach.page.keyboard.down('Meta')
    await coach.page.keyboard.press('KeyV', { commands: ['paste'] })
    await coach.page.keyboard.up('Meta')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(await coach.cell(2, 1)).equals('1B')
    expect(
      await coach.page.$eval(
        '[data-testid="Plan refusal"]',
        node => node.textContent
      )
    ).includes('SSS is not a position')
    // The picker, open over the rows below, closes on Escape.
    await coach.page.keyboard.press('Escape')
    await coach.page.waitForFunction(
      () => document.querySelector('[data-testid="Plan field picker"]') == null
    )
    await coach.click('[data-testid="Plan cell 4-1"]')
    await coach.page.keyboard.type('-')
    expect(await coach.cell(4, 1)).equals('-')
  })

  it('P6 writes the position clicked on the picker, and does nothing on hover', async function () {
    if (CAPTURING) this.skip()
    const fixture = lineupFixture()
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    await coach.plan()
    await coach.click('[data-testid="Plan cell 5-3"]')
    await coach.page.waitForSelector('[data-testid="Plan field picker"]', {
      visible: true
    })
    await coach.click('[data-testid="Plan pick CF"]')
    expect(await coach.cell(5, 3)).equals('CF')
    await coach.page.waitForFunction(
      () => document.querySelector('[data-testid="Plan field picker"]') == null
    )
    const style = async (): Promise<string[]> =>
      await coach.page.$eval('[data-testid="Plan cell 2-4"]', node => {
        const computed = getComputedStyle(node)
        return [
          computed.backgroundColor,
          computed.borderTopColor,
          computed.color,
          computed.cursor
        ]
      })
    const before = await style()
    await coach.page.hover('[data-testid="Plan cell 2-4"]')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(await style()).deep.equals(before)
    expect(await coach.page.$('[data-testid="Plan field picker"]')).equals(null)
  })

  it('P7 moves a player’s row, every inning with it, by dragging him above the first', async function () {
    if (CAPTURING) this.skip()
    const fixture = lineupFixture()
    await savePlan(fixture, HOME_PLAN)
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    await coach.plan()
    const players = await coach.planPlayers()
    const cells = await coach.cells()
    const box = async (css: string): Promise<Box> =>
      await coach.page.$eval(css, node => {
        const r = node.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      })
    const from = await box('[data-testid="Plan player 3"]')
    const to = await box('[data-testid="Plan player 1"]')
    const mouse = coach.page.mouse
    await mouse.move(from.x + 40, from.y + from.height / 2)
    await mouse.down()
    for (let step = 1; step <= 10; step++)
      await mouse.move(
        from.x + 40,
        from.y +
          from.height / 2 +
          ((to.y + 6 - from.y - from.height / 2) * step) / 10
      )
    await new Promise(resolve => setTimeout(resolve, 200))
    await mouse.up()
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(await coach.planPlayers()).deep.equals([
      players[2],
      players[0],
      players[1],
      ...players.slice(3)
    ])
    expect(await coach.cells()).deep.equals([
      cells[2],
      cells[0],
      cells[1],
      ...cells.slice(3)
    ])
    // The Lineup tab bats him first too.
    await coach.tap('Lineup', 'tab')
    const lineup = await coach.page.$$eval(
      '[data-roster-target^="lineup-"][data-roster-player]',
      nodes => nodes.map(node => String(node.textContent))
    )
    expect(lineup[0]).includes(players[2])
    expect(lineup[1]).includes(players[0])
    // Saved with the lineup alone changed: the stored plan's rows follow it,
    // so the next game's Rotate Leadoff reads the new leadoff.
    await coach.tap('Save Rosters')
    const moved = players[2].replace(/^#\d+ /, '')
    const deadline = Date.now() + 30000
    let stored: GamePlan | null = null
    while (stored?.rows[0]?.player.fullName !== moved) {
      if (Date.now() > deadline)
        throw new Error(
          `The stored plan never led off with ${moved}: ${JSON.stringify(stored?.rows.map(row => row.player.fullName))}`
        )
      await new Promise(resolve => setTimeout(resolve, 500))
      stored = (
        (await (
          await fetch(`${API}/games/${fixture.gameId}/plans`, {
            headers: {
              authorization: `Bearer ${await tokenOf(fixture, 'headCoach')}`
            }
          })
        ).json()) as { home: { plan: GamePlan | null } }
      ).home.plan
    }
    expect(stored.rows[0].cells).deep.equals(HOME_PLAN[2])
    expect(stored.rows.map(row => row.cells)).deep.equals([
      HOME_PLAN[2],
      HOME_PLAN[0],
      HOME_PLAN[1],
      ...HOME_PLAN.slice(3)
    ])
  })

  it('P8 warns as the plan breaks the rules, before Save, follows a moved row, and summarises the save', async function () {
    if (CAPTURING) this.skip()
    const fixture = lineupFixture()
    await teamRules(fixture, P8_RULES)
    await savePlan(fixture, HOME_PLAN)
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    await coach.plan()
    const players = await coach.planPlayers()
    // Marte sits the fifth and sixth: two in a row, and more than one.
    const marte = players[4].replace(/^#\d+ /, '')
    const senga = players[8].replace(/^#\d+ /, '')
    const opened = await coach.warnings()
    expect(
      opened.some(line => line.startsWith('red ') && line.includes(marte))
    ).equals(true)
    expect(opened.some(line => line.includes(senga))).equals(false)
    // Senga benched in the first three innings: red at once, before Save.
    for (const inning of [1, 2, 3]) {
      await coach.click(`[data-testid="Plan cell 9-${inning}"]`)
      await coach.page.keyboard.type('-')
    }
    const benched = await coach.warnings()
    const consecutive = benched.find(line =>
      line.startsWith('red noConsecutiveSits')
    )!
    expect(consecutive).includes(`${marte}, ${senga}`)
    // Above Clear.
    const order = await coach.page.evaluate(() => {
      const warnings = document.querySelector('[data-testid="Plan warnings"]')!
      const clear = document.querySelector('[data-testid="Plan clear"]')!
      return (
        warnings.getBoundingClientRect().bottom <=
        clear.getBoundingClientRect().top
      )
    })
    expect(order).equals(true)
    // Season tracking never warns in red.
    for (const line of benched)
      expect(line).not.match(
        /^red (trackSeasonInfieldBalance|rotateLeadoff|mustPlayNextSuggestions)/
      )
    // Senga dragged to the top: the warnings name him first.
    const box = async (css: string): Promise<Box> =>
      await coach.page.$eval(css, node => {
        const r = node.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      })
    await coach.page.$eval('[data-testid="Plan scroll"]', node => {
      node.scrollTop = 0
    })
    const from = await box('[data-testid="Plan player 9"]')
    const to = await box('[data-testid="Plan player 1"]')
    const mouse = coach.page.mouse
    await mouse.move(from.x + 40, from.y + from.height / 2)
    await mouse.down()
    for (let step = 1; step <= 12; step++)
      await mouse.move(
        from.x + 40,
        from.y +
          from.height / 2 +
          ((to.y + 6 - from.y - from.height / 2) * step) / 12
      )
    await new Promise(resolve => setTimeout(resolve, 200))
    await mouse.up()
    await new Promise(resolve => setTimeout(resolve, 400))
    expect((await coach.planPlayers())[0]).equals(players[8])
    const moved = await coach.warnings()
    expect(
      moved.find(line => line.startsWith('red noConsecutiveSits'))
    ).includes(`${senga}, ${marte}`)
    // The toggle, the grid and the warnings above Clear, in one frame.
    await coach.tallShot('coach-plan.png', '[data-testid="Plan scroll"]')
    // Saved anyway, and summarised. Before the first pitch the plan he
    // follows sets the defence from its inning 1, and the notice says so.
    await coach.tap('Save Rosters')
    const notice = await coach.page.waitForFunction(
      () => {
        const text = String(document.body.textContent)
        const at = text.indexOf('Saved. ')
        return at < 0 || !text.includes('Plan has ', at)
          ? false
          : text.slice(at, at + 120)
      },
      { timeout: 30000 }
    )
    expect(String(await notice.jsonValue())).match(
      /^Saved\. Defense set from the plan’s inning 1\. Plan has \d+ (red and \d+ yellow )?playing-time warnings?\./
    )
    const saved = (await (
      await fetch(`${API}/games/${fixture.gameId}/plans`, {
        headers: {
          authorization: `Bearer ${await tokenOf(fixture, 'headCoach')}`
        }
      })
    ).json()) as { home: { plan: GamePlan } }
    expect(saved.home.plan.rows[0].cells.slice(0, 3)).deep.equals([
      '-',
      '-',
      '-'
    ])
    expect(saved.home.plan.rows[0].player.fullName).equals(senga)
  })

  it('P9 asks before clearing: Cancel keeps every cell, Clear empties them', async function () {
    if (CAPTURING) this.skip()
    const fixture = lineupFixture()
    await savePlan(fixture, HOME_PLAN)
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    await coach.plan()
    const cells = await coach.cells()
    expect(cells[0][0]).equals('P')
    await coach.page.$eval('[data-testid="Plan scroll"]', node => {
      node.scrollTop = node.scrollHeight
    })
    await coach.tapCss('[data-testid="Plan clear"]')
    const sheet = '[aria-label="Clear the whole plan?"]'
    await coach.page.waitForSelector(sheet, { visible: true })
    await coach.shot('coach-plan-clear-confirm.png')
    const actions = await coach.page.$$eval(`${sheet} [role="button"]`, nodes =>
      nodes.map(node => ({
        text: String(node.textContent),
        color: getComputedStyle(node).backgroundColor
      }))
    )
    expect(actions.map(action => action.text)).deep.equals(['Clear', 'Cancel'])
    // Cancel: nothing changes.
    await coach.page.evaluate(selector => {
      const cancel = [
        ...document.querySelectorAll(`${selector} [role="button"]`)
      ].find(node => node.textContent === 'Cancel') as HTMLElement
      cancel.click()
    }, sheet)
    await coach.page.waitForFunction(
      selector => document.querySelector(selector) == null,
      {},
      sheet
    )
    expect(await coach.cells()).deep.equals(cells)
    // Clear: every cell empty.
    await coach.tapCss('[data-testid="Plan clear"]')
    await coach.tapCss('[data-testid="Plan clear confirm"]')
    await coach.page.waitForFunction(
      selector => document.querySelector(selector) == null,
      {},
      sheet
    )
    const cleared = await coach.cells()
    expect(cleared.flat().every(cell => cell === '')).equals(true)
    expect(cleared).has.length(9)
  })

  it('P10 moves the scorekeeper’s defence to the plan’s next column at each inning’s end, and not with the toggle off', async function () {
    if (CAPTURING) this.skip()
    for (const enabled of [true, false]) {
      const toggle = enabled ? 'on' : 'off'
      const fixture = lineupFixture()
      await savePlan(fixture, SHIFT_PLAN, enabled)
      await coach.as(fixture, 'scorekeeper')
      await coach.scoreGame(fixture.gameId)
      await coach.ball()
      await storedInning(fixture, 1)
      const opening = await homeDefense(fixture)
      // The defaults: the nine at P to RF in batting order.
      expect(opening).deep.equals(columnDefense(fixture, SHIFT_PLAN, 3))
      console.log(`    toggle ${toggle}, inning 1: ${named(fixture, opening)}`)
      await coach.endHalf()
      expect(await coach.planNotice()).equals(null)
      await coach.ball()
      await coach.endHalf()
      const second = await coach.planNotice()
      await coach.ball()
      await storedInning(fixture, 2)
      const afterFirst = await homeDefense(fixture)
      console.log(
        `    toggle ${toggle}, after the 1st (notice ${JSON.stringify(second)}): ${named(fixture, afterFirst)}`
      )
      if (enabled) {
        expect(second).equals('Inning 2 plan applied')
        expect(afterFirst).deep.equals(columnDefense(fixture, SHIFT_PLAN, 2))
      } else {
        expect(second).equals(null)
        expect(afterFirst).deep.equals(opening)
      }
      // The coach sits Senga a third time in inning 3, against his team's
      // Max Sits of one (sitting limits on, with only that rule of them),
      // while the scoring screen stays open: it hears the save.
      await teamRules(fixture, {
        enforceSittingLimits: true,
        noConsecutiveSits: false,
        equalSittingOrder: 'off'
      })
      await savePlan(fixture, SHIFT_EDITED, enabled)
      await new Promise(resolve => setTimeout(resolve, 3000))
      await coach.endHalf()
      await coach.ball()
      await coach.endHalf()
      const third = await coach.planNotice()
      await coach.ball()
      await storedInning(fixture, 3)
      const afterSecond = await homeDefense(fixture)
      console.log(
        `    toggle ${toggle}, after the 2nd (notice ${JSON.stringify(third)}): ${named(fixture, afterSecond)}`
      )
      if (enabled) {
        expect(third).equals('Inning 3 plan applied — 1 playing-time warning')
        expect(afterSecond).deep.equals(columnDefense(fixture, SHIFT_EDITED, 3))
      } else {
        expect(third).equals(null)
        expect(afterSecond).deep.equals(opening)
      }
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

  it('P12 fits Save Rosters’ whole label, and Cancel at the same size, on a 320-point screen, for the coach’s Plan tab and the scorekeeper’s Defense tab', async function () {
    if (CAPTURING) this.skip()
    const [width, height] = [320, 568]
    const session = await browserSession(
      daemon,
      'coach-plan-narrow',
      width,
      height,
      join(tmpdir(), 'coach-plan-e2e-narrow')
    )
    session.page.setDefaultTimeout(30000)
    const narrow = new Browser(session, session.page)
    /** The footer on one row, inside the screen, its labels uncut. */
    const fits = async (where: string): Promise<void> => {
      const footer = await narrow.footer()
      expectFooterRow(footer, height)
      for (const each of [footer.bar, footer.cancel, footer.mic, footer.save]) {
        expect(each.x, where).at.least(0)
        expect(each.x + each.width, where).at.most(width)
      }
      const labels = await narrow.page.evaluate(() =>
        ['[data-testid="Roster cancel"]', '[aria-label="Save Rosters"]'].map(
          css => {
            const label = document
              .querySelector(css)!
              .querySelector<HTMLElement>('[dir="auto"]')!
            return {
              text: String(label.textContent),
              scroll: label.scrollWidth,
              client: label.clientWidth,
              size: getComputedStyle(label).fontSize
            }
          }
        )
      )
      console.log(`    ${where} at ${width} wide: ${JSON.stringify(labels)}`)
      for (const label of labels)
        expect(label.scroll, `${where}: ${label.text}`).at.most(label.client)
      // Cancel is drawn at Save Rosters' size, not left larger.
      expect(labels[0].size, `${where}: Cancel's size`).equals(labels[1].size)
    }
    try {
      const fixture = lineupFixture()
      await narrow.as(fixture, 'headCoach')
      await narrow.coachGame(fixture.gameId)
      await narrow.plan()
      await fits('coach Plan')
      await narrow.as(fixture, 'scorekeeper')
      await narrow.scoreGame(fixture.gameId)
      await narrow.tap('Open scoring menu')
      await narrow.tap('Set Team Rosters')
      await narrow.page.waitForSelector('[aria-label="Save Rosters"]', {
        timeout: 30000
      })
      await narrow.defense()
      await fits('scorekeeper Defense')
    } finally {
      await session.browser.close()
    }
  })

  it('P13 opens clean for the coach after the scorekeeper reorders the lineup his saved plan follows', async function () {
    if (CAPTURING) this.skip()
    const fixture = lineupFixture()
    await savePlan(fixture, HOME_PLAN)
    const saveDisabled = async (): Promise<string | null> =>
      await coach.page.$eval('[aria-label="Save Rosters"]', node =>
        node.getAttribute('aria-disabled')
      )
    // The head coach saves his lineup, so the game holds it.
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    await coach.tap('Save Rosters')
    await coach.page.waitForSelector(
      '[aria-label="Save Rosters"][aria-disabled="true"]',
      { timeout: 30000 }
    )
    // The scorekeeper swaps the first and third batters.
    const auth = {
      authorization: `Bearer ${await tokenOf(fixture, 'scorekeeper')}`
    }
    const read = (await (
      await fetch(`${API}/games/${fixture.gameId}/lineups`, { headers: auth })
    ).json()) as {
      digest: string
      home: { current: Lineup | null }
    }
    const held = read.home.current!
    // Every player on the roster, the bench too, as the lineup names them.
    const players = fixture.players.home.map(player => ({
      gumboId: player.gumboId,
      fullName: player.name,
      jersey: player.jersey
    }))
    const at = (person: LineupPerson): number =>
      players.findIndex(player => player.gumboId === person.gumboId)
    const order = held.batters.map(at)
    ;[order[0], order[2]] = [order[2], order[0]]
    const body: SaveLineupsBody = {
      side: 'home',
      base: read.digest,
      players,
      battingOrder: order,
      defense: Object.fromEntries(
        Object.entries(held.defense).flatMap(([position, person]) =>
          person == null ? [] : [[position, at(person)]]
        )
      )
    }
    const posted = await fetch(`${API}/games/${fixture.gameId}/lineups`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    expect(posted.status, await posted.text()).equals(200)
    // The coach opens the game again: his plan's rows follow the new order,
    // and nothing is his to save.
    await coach.coachGame(fixture.gameId)
    await coach.plan()
    const names = players.map(player => player.fullName)
    expect(
      (await coach.planPlayers())
        .slice(0, 3)
        .map(row => row.replace(/^#\d+ /, ''))
    ).deep.equals([names[2], names[1], names[0]])
    expect(await coach.cells()).deep.include.ordered.members([
      HOME_PLAN[2],
      HOME_PLAN[1],
      HOME_PLAN[0]
    ])
    expect(await saveDisabled()).equals('true')
    await coach.tap('Back')
    await coach.page.waitForFunction(
      () => document.querySelector('[aria-label="Save Rosters"]') == null,
      { timeout: 15000 }
    )
    expect(
      await coach.page.evaluate(() => String(document.body.textContent))
    ).not.includes('Discard unsaved roster changes?')
  })

  it('P14 starts the lineup the head coach saves before the first pitch in his plan’s inning 1, once he turns the plan on', async function () {
    if (CAPTURING) this.skip()
    const fixture = lineupFixture()
    await savePlan(fixture, OPENING_PLAN, false)
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    await coach.plan()
    await coach.tap('Enable per-inning game plan')
    await coach.tap('Save Rosters')
    await coach.page.waitForSelector(
      '[aria-label="Save Rosters"][aria-disabled="true"]',
      { timeout: 30000 }
    )
    const expected = columnDefense(fixture, OPENING_PLAN, 1)
    // The save is sent behind the screen: read until the game holds it.
    const deadline = Date.now() + 30000
    let held = await homeDefense(fixture)
    while (
      JSON.stringify(held) !== JSON.stringify(expected) &&
      Date.now() < deadline
    ) {
      await new Promise(resolve => setTimeout(resolve, 500))
      held = await homeDefense(fixture)
    }
    console.log(`    toggle on, saved before the 1st: ${named(fixture, held)}`)
    expect(held).deep.equals(expected)
    expect(held).not.deep.equals(columnDefense(fixture, SHIFT_PLAN, 3))
  })
})
