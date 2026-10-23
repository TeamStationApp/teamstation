// The Auto-Scheduler fixes' web scenarios, F1 to F10, against the web app in
// a maestro-d web device (headless Chromium at a phone's size). Each
// scenario starts from a fresh fixture seeded to its own start state, so
// none depends on another's leftovers.
//
//   socket npm run build.web
//   TS_MAESTRO_D_CLIENT=$HOME/git/maestro-d/npm/maestro-d \
//   MAESTRO_D_BIN=$HOME/.maestro-d/bin/maestro-d \
//   TS_AUTO_SCHEDULER_ARTIFACTS=<artifacts directory> \
//   MAESTRO_D=autoSchedulerFixes \
//     node -r sucrase/register src/app/autoSchedulerFixes.e2e.ts --only F1
//
// With no `--only`, or `--only F10`, it is the full pass: every scenario in
// order. Set TS_AUTO_SCHEDULER_BROWSER_COVERAGE to record the app's browser
// coverage, and NODE_V8_COVERAGE for the fixture server's.
// Browser callbacks avoid `?.`: Sucrase's helper is not in the page.
import { execFile, execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'

import { eventLocalFields } from '../common/eventTime'
import type { SchedulePreview } from '../common/schedulePreviews'
import { googlePlaces } from '../server/location/googlePlaces'
import {
  api,
  type AutoSchedulerFixture,
  autoSchedulerFixture,
  forceSeasonZone,
  seedThrough
} from '../test/autoSchedulerFixture'
import { googlePlacesStub } from '../test/googlePlacesStub'
import {
  type BrowserSession,
  browserSession,
  contains,
  fill,
  log,
  maestro,
  show,
  tap
} from '../test/refinementsMaestro.e2e'
import { recordBrowserCoverage } from './browserCoverage.e2e'

const WIDTH = 402
const HEIGHT = 874
const DEVICE = 'autoSchedulerFixes-web'
const ADMIN = 101
const EMAILS: Record<number, string> = { 101: 'alex@example.com' }

type Start = 'E2' | 'E3' | 'E5' | 'E7'

interface Run {
  fx: AutoSchedulerFixture
  b: BrowserSession
  /** What the start state made: the venue, its first field. */
  state: { venueId?: string; fieldId?: string; previewId?: string }
  artifacts: string
  support: string
  visit: (path: string) => Promise<void>
  /** A screenshot into the artifacts directory, or to an absolute path. */
  capture: (name: string) => Promise<void>
  pass: (description: string) => Promise<void>
}

interface Scenario {
  start: Start
  /** Seeding after the start state, for this scenario alone. */
  then?: (fx: AutoSchedulerFixture) => Promise<void>
  run: (run: Run) => Promise<void>
}

/** One line per step, to find a stall. */
function trace(step: string): void {
  console.log(`  · ${new Date().toISOString().slice(11, 19)} ${step}`)
}

/** Clicks an element by its accessible label, through maestro-d. */
async function tapLabel(b: BrowserSession, label: string): Promise<void> {
  trace(`tap label ${label}`)
  await b.m.tapOn({ css: `[aria-label="${label}"]`, timeout: 15000 })
}

/** Presses a key in the focused element, through maestro-d. */
async function press(b: BrowserSession, key: string): Promise<void> {
  trace(`press ${key}`)
  await b.m.pressKey({ key })
}

/** Types into the focused element, through maestro-d. */
async function type(b: BrowserSession, text: string): Promise<void> {
  trace(`type ${text}`)
  await b.m.inputText({ text })
}

/** Waits until an element with this accessible label is, or isn't, there. */
async function labelled(
  b: BrowserSession,
  label: string,
  present = true
): Promise<void> {
  await b.page.waitForFunction(
    (wanted: string, there: boolean) =>
      (document.querySelector(`[aria-label="${wanted}"]`) !== null) === there,
    { timeout: 15000 },
    label,
    present
  )
}

/**
 * Waits for the grid's open cell: this one, focused, holding this text with
 * all of it selected, so typing replaces it.
 */
async function selected(
  b: BrowserSession,
  label: string,
  value: string
): Promise<void> {
  trace(`selected ${label}: ${value}`)
  await b.page
    .waitForFunction(
      (wanted: string, text: string) => {
        const input = document.activeElement as HTMLInputElement | null
        return (
          input !== null &&
          input.tagName === 'INPUT' &&
          input.getAttribute('aria-label') === `Edit ${wanted}` &&
          input.value === text &&
          input.selectionStart === 0 &&
          input.selectionEnd === text.length
        )
      },
      { timeout: 15000 },
      label,
      value
    )
    .catch(async (error: unknown) => {
      console.error(
        'Open cell',
        await b.page.evaluate(() => {
          const input = document.activeElement as HTMLInputElement | null
          return input === null
            ? null
            : {
                label: input.getAttribute('aria-label'),
                value: input.value,
                start: input.selectionStart,
                end: input.selectionEnd
              }
        })
      )
      throw error
    })
}

/** Waits for the open cell to hold what was typed over its number. */
async function typed(
  b: BrowserSession,
  label: string,
  value: string
): Promise<void> {
  await b.page.waitForFunction(
    (wanted: string, text: string) => {
      const input = document.querySelector<HTMLInputElement>(
        `input[aria-label="Edit ${wanted}"]`
      )
      return input !== null && input.value === text
    },
    { timeout: 15000 },
    label,
    value
  )
}

/** Scrolls the season grid sideways until this cell is at its left edge. */
async function gridTo(b: BrowserSession, label: string): Promise<void> {
  await b.page.evaluate((wanted: string) => {
    const table = document.querySelector('[data-testid="season-schedule-grid"]')
    const cell = document.querySelector(`[aria-label="${wanted}"]`)
    if (table === null || cell === null) return
    for (const node of [table, ...table.querySelectorAll('div')])
      if (node.scrollWidth > node.clientWidth + 1) {
        node.scrollLeft = 0
        node.scrollLeft =
          cell.getBoundingClientRect().left - node.getBoundingClientRect().left
      }
  }, label)
  await new Promise(resolve => setTimeout(resolve, 600))
}

/**
 * Scrolls the element whose own text is this to the top of the screen,
 * below the app's header, and lets the scroll settle.
 */
async function scrollToText(
  b: BrowserSession,
  text: string,
  offset = 72
): Promise<void> {
  await b.page.evaluate(
    (wanted: string, by: number) => {
      const found = [...document.querySelectorAll('div, span')].find(
        node => node.childElementCount === 0 && node.textContent === wanted
      )
      if (found === undefined) return
      found.scrollIntoView({ block: 'start' })
      let scroller = found.parentElement
      while (
        scroller !== null &&
        scroller.scrollHeight <= scroller.clientHeight
      )
        scroller = scroller.parentElement
      if (scroller !== null) scroller.scrollTop -= by
      else window.scrollBy(0, -by)
    },
    text,
    offset
  )
  await new Promise(resolve => setTimeout(resolve, 600))
}

const AUTO_SCHEDULER = 'Auto-Scheduler, Fields, season settings and schedules'

/**
 * F1: the Auto-Scheduler row ends the Seasons tab, and the grid's four
 * number columns are spreadsheet cells.
 */
async function f1(run: Run): Promise<void> {
  const { fx, b } = run
  await run.visit(`/groups/league/${fx.f.leagueA}`)
  await contains(b.page, 'Demo Playoffs')
  await labelled(b, AUTO_SCHEDULER)
  await run.capture('league-seasons-after.png')
  // Scrolled to the end, the row is the last card, under the seasons with a
  // gap above it, and the hero card above holds none.
  await b.page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight)
    for (const node of document.querySelectorAll('div'))
      if (node.scrollHeight > node.clientHeight + 1)
        node.scrollTop = node.scrollHeight
  })
  await new Promise(resolve => setTimeout(resolve, 600))
  const placement = await b.page.evaluate((label: string) => {
    const row = document.querySelector(`[aria-label="${label}"]`)!
    const seasons = [
      ...document.querySelectorAll('[aria-label^="Open Demo "]')
    ] as HTMLElement[]
    const last = seasons[seasons.length - 1]
    let hero = document.querySelector('[aria-label="League settings"]')!
    while (
      hero.parentElement !== null &&
      !String(hero.parentElement.textContent).includes('Demo Playoffs')
    )
      hero = hero.parentElement
    let card = row
    while (card.parentElement !== null && !card.parentElement.contains(last))
      card = card.parentElement
    let list = last as Element
    while (list.parentElement !== null && !list.parentElement.contains(row))
      list = list.parentElement
    return {
      after: Boolean(
        last.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING
      ),
      inHero: hero.contains(row),
      lastChild: card.parentElement!.lastElementChild === card,
      gap:
        row.getBoundingClientRect().top - list.getBoundingClientRect().bottom,
      bottom: row.getBoundingClientRect().bottom,
      height: innerHeight
    }
  }, AUTO_SCHEDULER)
  trace(`placement ${JSON.stringify(placement)}`)
  expect(placement).deep.include({
    after: true,
    inHero: false,
    lastChild: true
  })
  // The section's gap and the larger one added to it.
  expect(placement.gap).greaterThan(24)
  expect(placement.bottom).lessThan(placement.height)
  await tapLabel(b, AUTO_SCHEDULER)
  await b.page.waitForFunction(() => location.pathname.endsWith('/scheduler'), {
    timeout: 15000
  })
  await contains(b.page, 'SCHEDULE SETTINGS')
  await scrollToText(b, 'SCHEDULE SETTINGS')
  // Each tap selects the whole number; typing replaces it; Tab saves and
  // opens the next cell.
  await tapLabel(b, 'Demo Regular Game MINS: 90')
  await selected(b, 'Demo Regular Game MINS', '90')
  await run.capture('season-grid-editing.png')
  await type(b, '100')
  await typed(b, 'Demo Regular Game MINS', '100')
  await press(b, 'Tab')
  await selected(b, 'Demo Regular Between MINS', '10')
  await type(b, '5')
  await press(b, 'Tab')
  await selected(b, 'Demo Regular # Regular', '4')
  await type(b, '6')
  await press(b, 'Tab')
  await selected(b, 'Demo Regular # Exhibition', '1')
  await type(b, '2')
  await press(b, 'Enter')
  await labelled(b, 'Demo Regular # Exhibition: 2')
  // A number off the 5-minute step is refused, and the cell stays open with
  // it selected; Escape restores the saved number.
  await tapLabel(b, 'Demo Regular Game MINS: 100')
  await selected(b, 'Demo Regular Game MINS', '100')
  await type(b, '47')
  await press(b, 'Enter')
  await contains(b.page, 'Game MINS: choose 30 to 600, in 5-minute steps.')
  await selected(b, 'Demo Regular Game MINS', '47')
  await press(b, 'Escape')
  await labelled(b, 'Edit Demo Regular Game MINS', false)
  await labelled(b, 'Demo Regular Game MINS: 100')
  const read = async (): Promise<Record<string, unknown>> =>
    await fx.f.h.db
      .selectFrom('season_schedule_settings')
      .select([
        'game_minutes',
        'buffer_minutes',
        'regular_games',
        'exhibition_games'
      ])
      .where('season_id', '=', fx.f.seasonA)
      .executeTakeFirstOrThrow()
  expect(await read()).deep.equals({
    game_minutes: 100,
    buffer_minutes: 5,
    regular_games: 6,
    exhibition_games: 2
  })
  // After a reload: bare numbers under the new headers, Teams beside Size,
  // and no dialog anywhere.
  await run.visit(`/groups/league/${fx.f.leagueA}/scheduler`)
  await contains(b.page, 'SCHEDULE SETTINGS')
  await labelled(b, 'Demo Regular Game MINS: 100')
  const grid = await b.page.evaluate((seasonId: string) => {
    const table = document.querySelector<HTMLElement>(
      '[data-testid="season-schedule-grid"]'
    )!
    const cell = (column: string): string =>
      String(
        document.querySelector(
          `[data-testid="grid-cell-${seasonId}-${column}"]`
        )!.textContent
      )
    const box = (label: string): DOMRect =>
      document
        .querySelector(`[aria-label^="${label}"]`)!
        .getBoundingClientRect()
    const textBox = (label: string): DOMRect => {
      const node = document.querySelector(`[aria-label^="${label}"]`)!
      const range = document.createRange()
      range.selectNodeContents(node)
      return range.getBoundingClientRect()
    }
    return {
      headers: table.innerText,
      values: [
        cell('gameMinutes'),
        cell('bufferMinutes'),
        cell('regularGames'),
        cell('exhibitionGames')
      ],
      teams: document.querySelector('[aria-label^="Demo Regular Teams: "]')!
        .textContent,
      teamsLabel: document
        .querySelector('[aria-label^="Demo Regular Teams: "]')!
        .getAttribute('aria-label'),
      teamsWidth: box('Demo Regular Teams: ').width,
      sizeWidth: box('Demo Regular Size: ').width,
      adjacent:
        Math.abs(
          box('Demo Regular Size: ').left - box('Demo Regular Teams: ').right
        ) < 1,
      textGap:
        textBox('Demo Regular Size: ').left -
        textBox('Demo Regular Teams: ').right,
      // Every header on one line, as tall as the one-word Teams header.
      headerHeights: [
        'Teams',
        'Game MINS',
        'Between MINS',
        '# Regular',
        '# Exhibition'
      ].map(title => {
        const node = [...table.querySelectorAll('div')].find(
          item => item.childElementCount === 0 && item.textContent === title
        )
        return node === undefined ? 0 : node.getBoundingClientRect().height
      }),
      dialog: String(document.body.textContent).includes(
        'Game length, in minutes'
      )
    }
  }, fx.f.seasonA)
  trace(`grid ${JSON.stringify({ ...grid, headers: undefined })}`)
  for (const header of [
    'GAME MINS',
    'BETWEEN MINS',
    '# REGULAR',
    '# EXHIBITION'
  ])
    expect(grid.headers).includes(header)
  expect(grid.values).deep.equals(['100', '5', '6', '2'])
  expect(grid.teams).equals('7 + 2')
  expect(grid.teamsLabel).equals(
    'Demo Regular Teams: 7 teams and 2 exhibition teams'
  )
  expect(grid.adjacent).equals(true)
  // 4.5 rem each, where Teams was 7 and Size 5.
  expect(grid.teamsWidth).equals(grid.sizeWidth)
  expect(grid.textGap).lessThan(40)
  expect(new Set(grid.headerHeights).size).equals(1)
  expect(grid.headerHeights[0]).greaterThan(0)
  expect(grid.dialog).equals(false)
  // The grid takes two frames, like the before shot: from its start
  // (Season, Teams, Size), then sideways to the four number columns.
  await scrollToText(b, 'SCHEDULE SETTINGS')
  const start = join(run.support, 'season-grid-after-grid.png')
  const numbers = join(run.support, 'season-grid-after-numbers.png')
  await run.capture(start)
  await gridTo(b, 'Demo Regular Game MINS: 100')
  await run.capture(numbers)
  execFileSync('magick', [
    start,
    numbers,
    '-background',
    'white',
    '-splice',
    '16x0',
    '+append',
    '-chop',
    '16x0',
    join(run.artifacts, 'season-grid-after.png')
  ])
  await run.pass(
    'the Auto-Scheduler row is the last card on the Seasons tab, below the seasons and out of the hero; Game MINS, Between MINS, # Regular and # Exhibition edit in place with the whole number selected, Tab and Enter save 100, 5, 6 and 2, 47 is refused with the 5-minute message and Escape restores 100; after a reload the cells read bare numbers under GAME MINS, BETWEEN MINS, # REGULAR and # EXHIBITION, Teams reads 7 + 2 beside Size, and no dialog opens'
  )
}

/** Clicks the last element of this role and exact text, once enabled. */
async function tapText(
  b: BrowserSession,
  text: string,
  roles = '[role="button"], [role="radio"], [role="tab"]'
): Promise<void> {
  trace(`tap text ${text}`)
  await b.page.waitForFunction(
    (wanted: string, selector: string) =>
      [...document.querySelectorAll(selector)].some(
        node =>
          node.textContent === wanted &&
          node.getAttribute('aria-disabled') !== 'true'
      ),
    { timeout: 15000 },
    text,
    roles
  )
  await b.page.evaluate(
    (wanted: string, selector: string) => {
      const matches = [...document.querySelectorAll(selector)].filter(
        node => node.textContent === wanted
      )
      ;(matches[matches.length - 1] as HTMLElement).click()
    },
    text,
    roles
  )
}

/**
 * Clicks the element with exactly this accessible label in the page itself,
 * waiting for it first: for a sheet's rows, which hold a label and a detail.
 */
async function clickLabel(b: BrowserSession, label: string): Promise<void> {
  trace(`click label ${label}`)
  const selector = `[aria-label="${label}"]`
  await b.page.waitForSelector(selector, { timeout: 15000 })
  await b.page.evaluate((wanted: string) => {
    const node = document.querySelector(wanted)
    if (node !== null) (node as HTMLElement).click()
  }, selector)
}

/** The page's whole text. */
async function pageText(b: BrowserSession): Promise<string> {
  return await b.page.evaluate(() => String(document.body.innerText))
}

/**
 * Runs a curl against the fixture server as the league admin and adds it to
 * a log, token hidden, returning the answer's body. The server runs in this
 * process, so curl must not block its event loop.
 */
async function curl(
  run: Run,
  lines: string[],
  method: string,
  path: string,
  body?: unknown
): Promise<string> {
  const token = run.fx.f.h.tokens.get(ADMIN)!
  const args = [
    '-sS',
    '-X',
    method,
    '-H',
    'Content-Type: application/json',
    '-H',
    `Authorization: Bearer ${token}`,
    ...(body === undefined ? [] : ['-d', JSON.stringify(body)]),
    '-w',
    '\nHTTP %{http_code}\n',
    `${run.fx.f.h.origin}/api/v1${path}`
  ]
  const shown = args
    .map(arg =>
      arg.startsWith('Authorization:')
        ? "'Authorization: Bearer $TOKEN'"
        : arg.includes('\n')
          ? `$'${arg.replace(/\n/g, '\\n')}'`
          : /[\s{}"*$]/.test(arg)
            ? `'${arg}'`
            : arg
    )
    .join(' ')
  const { stdout } = await promisify(execFile)('curl', args, {
    encoding: 'utf8'
  })
  const answer = stdout.trim()
  lines.push(`$ curl ${shown}`, answer, '')
  return answer.slice(0, answer.lastIndexOf('\nHTTP '))
}

/** A season's zone, as its settings answer reads it, through curl. */
async function curlZone(
  run: Run,
  lines: string[],
  seasonId: string
): Promise<string> {
  const answer = JSON.parse(
    await curl(run, lines, 'GET', `/seasons/${seasonId}/schedule-settings`)
  ) as { timezone: string }
  return answer.timezone
}

/** Runs a scenario's steps with the browser in this zone, then resets it. */
async function inZone(
  b: BrowserSession,
  timezone: string,
  steps: () => Promise<void>
): Promise<void> {
  trace(`time zone ${timezone}`)
  await b.page.emulateTimezone(timezone)
  try {
    await steps()
  } finally {
    await b.page.emulateTimezone(undefined)
  }
}

/**
 * F2: season setup names one zone: a season's own, or the viewer's while it
 * holds the UTC default, which its first settings save stores on it.
 */
async function f2(run: Run): Promise<void> {
  const { fx, b } = run
  const lines = [
    '$ node -r sucrase/register src/app/autoSchedulerFixes.e2e.ts --only F2',
    ''
  ]
  const setupOf = (seasonId: string): string =>
    `/groups/league/${fx.f.leagueA}/scheduler/seasons/${seasonId}`
  await inZone(b, 'America/Los_Angeles', async () => {
    expect(await curlZone(run, lines, fx.f.playoffs)).equals('UTC')
    await run.visit(setupOf(fx.f.seasonA))
    await contains(b.page, 'Demo Regular')
    await contains(b.page, 'Times are in Eastern Time.')
    await run.visit(setupOf(fx.f.playoffs))
    await contains(b.page, 'Demo Playoffs')
    await contains(b.page, 'Times are in Pacific Time.')
    for (const other of ['UTC', 'Coordinated Universal Time', 'time zone,'])
      expect(await pageText(b)).not.includes(other)
    await run.capture('season-zone-after.png')
    // In the Auto-Scheduler, playoffs joins the run and saves a number.
    await run.visit(`/groups/league/${fx.f.leagueA}/scheduler`)
    await contains(b.page, 'SCHEDULE SETTINGS')
    await clickLabel(b, 'Demo Playoffs')
    await labelled(b, 'Demo Playoffs # Regular: 0')
    await scrollToText(b, 'SCHEDULE SETTINGS')
    await gridTo(b, 'Demo Playoffs # Regular: 0')
    await tapLabel(b, 'Demo Playoffs # Regular: 0')
    await selected(b, 'Demo Playoffs # Regular', '0')
    await type(b, '2')
    await press(b, 'Enter')
    await labelled(b, 'Demo Playoffs # Regular: 2')
    expect(await curlZone(run, lines, fx.f.playoffs)).equals(
      'America/Los_Angeles'
    )
    // seasonA kept its own zone.
    expect(await curlZone(run, lines, fx.f.seasonA)).equals('America/New_York')
    await run.visit(setupOf(fx.f.playoffs))
    await contains(b.page, 'Times are in Pacific Time.')
    expect(await pageText(b)).not.includes('UTC')
  })
  await writeFile(join(run.artifacts, 'season-zone.log'), lines.join('\n'))
  await run.pass(
    'seasonA reads "Times are in Eastern Time."; playoffs, at the UTC default, reads "Times are in Pacific Time." in a Los Angeles browser, with no UTC anywhere; after its # Regular is saved as 2 from the grid, its stored zone reads America/Los_Angeles where it read UTC (season-zone.log), seasonA keeps America/New_York, and playoffs still reads Pacific Time'
  )
}

/**
 * F2b: a build stores the viewer's zone on a chosen season still at the UTC
 * default before it is built, so its windows are met in that zone, and the
 * preview names it.
 */
async function f2b(run: Run): Promise<void> {
  const { fx, b } = run
  const lines = [
    '$ node -r sucrase/register src/app/autoSchedulerFixes.e2e.ts --only F2b',
    ''
  ]
  await inZone(b, 'America/New_York', async () => {
    expect(await curlZone(run, lines, fx.f.seasonA)).equals('UTC')
    await run.visit(`/groups/league/${fx.f.leagueA}/scheduler`)
    await contains(b.page, 'SCHEDULE SETTINGS')
    await tapText(b, 'Build schedule')
    await contains(b.page, 'These seasons already have 2 upcoming games')
    await clickLabel(b, 'Work around them')
    await b.page.waitForFunction(
      () => /\/scheduler\/previews\/[^/]+$/.test(location.pathname),
      { timeout: 120000 }
    )
    await contains(b.page, 'Publish this option')
    const previewId = decodeURIComponent(
      await b.page.evaluate(() =>
        location.pathname.slice(location.pathname.lastIndexOf('/') + 1)
      )
    )
    expect(await curlZone(run, lines, fx.f.seasonA)).equals('America/New_York')
    // Weekday games meet seasonA's windows and Field 1's 17:00–21:00 hours
    // in New York: 17:30–21:00 until June, 18:00–21:00 from June 1, for
    // 90-minute games with 10 between. Built in UTC, the windows would end
    // by 5:00 PM in New York and never meet the field on a weekday.
    const preview = await api<SchedulePreview>(
      fx,
      ADMIN,
      'GET',
      `/schedule-previews/${previewId}`
    )
    expect(preview.seasons.map(season => season.timezone)).deep.equals([
      'America/New_York'
    ])
    const weekday = preview.options[0].games
      .map(game => eventLocalFields(game.startAt, 'America/New_York'))
      .filter(local => {
        const day = new Date(`${local.date}T12:00:00Z`).getUTCDay()
        return day >= 1 && day <= 5
      })
    trace(`weekday starts ${JSON.stringify(weekday)}`)
    expect(weekday.length).greaterThan(0)
    for (const local of weekday)
      expect(
        local.date < '2027-06-01' ? ['17:30', '19:10'] : ['18:00', '19:40'],
        JSON.stringify(local)
      ).includes(local.time)
    lines.push(
      `Option 1's weekday games, in America/New_York: ${weekday.map(local => `${local.date} ${local.time}`).join(', ')}`,
      ''
    )
    // The season's zone is the viewer's, so the rows add none.
    const shown = await pageText(b)
    for (const zone of [' EDT', ' EST', 'UTC']) expect(shown).not.includes(zone)
    await tapText(b, 'Add game')
    await contains(b.page, 'The date and start are in Eastern Time.')
    expect(await pageText(b)).not.includes('UTC')
    expect(await pageText(b)).not.includes('America/New_York')
    await scrollToText(b, 'Add game', 24)
    await run.capture('preview-zone-after.png')
    await run.pass(
      `seasonA's stored zone, forced to UTC, read UTC before the build and America/New_York after it (build-zone.log); the preview's ${weekday.length} weekday games of Option 1 each start at 5:30 PM or 7:10 PM New York time (6:00 PM or 7:40 PM from June 1, the second window period), inside the window and Field 1's hours; no row names a zone, and the Add-game note reads "The date and start are in Eastern Time.", with no UTC anywhere`
    )
  })
  await writeFile(join(run.artifacts, 'build-zone.log'), lines.join('\n'))
}

const SCENARIOS: Record<string, Scenario> = {
  F1: { start: 'E7', run: f1 },
  F2: { start: 'E7', run: f2 },
  F2b: {
    start: 'E7',
    then: async fx => {
      await forceSeasonZone(fx, fx.f.seasonA, 'UTC')
    },
    run: f2b
  }
}

/** Merges the scenarios' browser coverage into one istanbul file. */
async function mergeCoverage(parts: string[], output: string): Promise<void> {
  const require = createRequire(resolve('package.json'))
  const { createCoverageMap } = require('istanbul-lib-coverage') as {
    createCoverageMap: (value: unknown) => {
      merge: (value: unknown) => void
      toJSON: () => unknown
    }
  }
  const map = createCoverageMap({})
  for (const part of parts) map.merge(JSON.parse(await readFile(part, 'utf8')))
  await writeFile(output, JSON.stringify(map.toJSON()))
}

async function main(): Promise<void> {
  const artifacts = process.env.TS_AUTO_SCHEDULER_ARTIFACTS
  if (artifacts == null) throw new Error('Supply TS_AUTO_SCHEDULER_ARTIFACTS')
  const only = process.argv.includes('--only')
    ? process.argv[process.argv.indexOf('--only') + 1]
    : undefined
  if (only != null && only !== 'F10' && SCENARIOS[only] == null)
    throw new Error(`No scenario ${only}`)
  const fullPass = only == null || only === 'F10'
  const chosen = Object.entries(SCENARIOS).filter(
    ([id]) => fullPass || id === only
  )
  const support = join(artifacts, 'support')
  // Browser profiles and the served copy of the app are working files, kept
  // out of the artifacts directory.
  const work = resolve('coverage/autoSchedulerFixes/support')
  const web = join(work, 'web')
  await mkdir(support, { recursive: true })
  await rm(web, { recursive: true, force: true })
  await mkdir(web, { recursive: true })
  await cp(resolve('dist'), web, { recursive: true })
  // The full pass's log is a proving artifact; a single scenario's is support.
  const lines = fullPass ? 'scenarios.log' : join('support', `${only}.log`)
  await writeFile(
    join(artifacts, lines),
    `$ node -r sucrase/register src/app/autoSchedulerFixes.e2e.ts${only == null ? '' : ` --only ${only}`}\n`
  )
  const coverage = process.env.TS_AUTO_SCHEDULER_BROWSER_COVERAGE
  const parts: string[] = []
  const places = await googlePlacesStub()
  const daemon = await maestro(process.env.MAESTRO_D ?? 'autoSchedulerFixes')
  let b: BrowserSession | undefined
  try {
    b = await browserSession(daemon, DEVICE, WIDTH, HEIGHT, work)
    const session = b
    const cdp = await session.page.createCDPSession()
    for (const [id, scenario] of chosen) {
      console.log(`${id} (start ${scenario.start})`)
      const fx = await autoSchedulerFixture(web, {
        cityLookup: googlePlaces({
          apiKey: 'placeholder-key',
          baseUrl: places.baseUrl
        })
      })
      try {
        const state = await seedThrough(fx, scenario.start)
        await scenario.then?.(fx)
        const visit = async (path: string): Promise<void> => {
          trace(`visit ${path}`)
          await session.m.openBrowser({ url: fx.f.h.origin + path })
        }
        // A fresh fixture is a fresh database: sign in again, without the
        // last fixture's cookie (cookies ignore the port).
        await cdp.send('Network.clearBrowserCookies')
        const email = EMAILS[ADMIN]
        await visit('/sign-in')
        await fill(session.m, 'E-mail address', email)
        await tap(session.m, 'Send me a sign-in code')
        await show(session.m, '.*six-digit code is on its way.*')
        await fill(session.m, 'Sign-in code', fx.f.h.mail.get(email)!)
        await tap(session.m, 'Sign in')
        await session.page.waitForFunction(
          () => location.pathname !== '/sign-in',
          { timeout: 15000 }
        )
        await contains(session.page, 'Your Home')
        await scenario.run({
          fx,
          b: session,
          state,
          artifacts,
          support,
          visit,
          capture: async name => {
            await session.m.waitForAnimationToEnd()
            const file = name.startsWith('/') ? name : join(artifacts, name)
            await writeFile(file, await session.m.screenshot())
            trace(`captured ${file}`)
          },
          pass: async description => {
            await log(artifacts, lines, `${id} PASS: ${description}`)
          }
        })
        if (coverage != null) {
          // Each fixture serves the app from its own origin: record this
          // one's, then start counting again for the next.
          const part = join(work, `browser-${id}.json`)
          await recordBrowserCoverage([session.page], fx.f.h.origin, part, web)
          parts.push(part)
          await session.page.coverage.startJSCoverage({
            resetOnNavigation: false,
            includeRawScriptCoverage: true
          })
        }
      } finally {
        // Leave the fixture's origin so its server closes without waiting
        // on the browser's open connections.
        await session.m.openBrowser({ url: `about:blank#${DEVICE}` })
        await fx.f.h.close()
      }
    }
    if (coverage != null) {
      await mkdir(resolve(coverage, '..'), { recursive: true })
      await mergeCoverage(parts, resolve(coverage))
    }
  } finally {
    if (b != null) {
      await b.browser.disconnect()
      await b.m.detach()
    }
    await daemon.shutdown()
    await places.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
