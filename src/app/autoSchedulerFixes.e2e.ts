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
import type { Frame } from 'puppeteer'

import {
  eventLocalFields,
  eventLocalRange,
  zoneName
} from '../common/eventTime'
import type { SchedulePreview } from '../common/schedulePreviews'
import type { ScheduleSetup } from '../common/seasonScheduling'
import type { VenueDetail } from '../common/venues'
import { googlePlaces } from '../server/location/googlePlaces'
import {
  api,
  type AutoSchedulerFixture,
  autoSchedulerFixture,
  forceSeasonZone,
  HARBOR_DIAMOND,
  seedHarborField,
  seedThrough
} from '../test/autoSchedulerFixture'
import {
  GOOGLE_MAPS_SCRIPT,
  interceptGoogleMaps
} from '../test/googleMapsIntercept'
import {
  EXAMPLE_PARK,
  googlePlacesStub,
  MORE_PARKS
} from '../test/googlePlacesStub'
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
  /** The Google stub, with every request the server sent it. */
  places: Awaited<ReturnType<typeof googlePlacesStub>>
  /** Every request the browser has made this run, and whether a map made it. */
  requests: Array<{ url: string; fromMap: boolean }>
  /** The command line this run was started with, for a log's first line. */
  command: string
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
  await tapLabel(b, 'Demo Regular Game length in minutes: 90')
  await selected(b, 'Demo Regular Game length in minutes', '90')
  await run.capture('season-grid-editing.png')
  await type(b, '100')
  await typed(b, 'Demo Regular Game length in minutes', '100')
  await press(b, 'Tab')
  await selected(b, 'Demo Regular Time between games in minutes', '10')
  await type(b, '5')
  await press(b, 'Tab')
  await selected(b, 'Demo Regular Regular-season games', '4')
  await type(b, '6')
  await press(b, 'Tab')
  await selected(b, 'Demo Regular Exhibition games', '1')
  await type(b, '2')
  await press(b, 'Enter')
  await labelled(b, 'Demo Regular Exhibition games: 2')
  // A number off the 5-minute step is refused, and the cell stays open with
  // it selected; Escape restores the saved number.
  await tapLabel(b, 'Demo Regular Game length in minutes: 100')
  await selected(b, 'Demo Regular Game length in minutes', '100')
  await type(b, '47')
  await press(b, 'Enter')
  await contains(b.page, 'Game MINS: choose 30 to 600, in 5-minute steps.')
  await selected(b, 'Demo Regular Game length in minutes', '47')
  await press(b, 'Escape')
  await labelled(b, 'Edit Demo Regular Game length in minutes', false)
  await labelled(b, 'Demo Regular Game length in minutes: 100')
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
  await labelled(b, 'Demo Regular Game length in minutes: 100')
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
  // Teams is 4.5 rem, where it was 7; Size is a little wider, for 46/60 MP.
  expect(grid.teamsWidth).equals(72)
  expect(grid.sizeWidth).greaterThan(grid.teamsWidth)
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
  await gridTo(b, 'Demo Regular Game length in minutes: 100')
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
  // The longest size, 46/60 MP, keeps the Size cell on one line, as tall as
  // the Teams cell beside it.
  await fx.f.h.db
    .updateTable('season_schedule_settings')
    .set({ field_size: '46/60 MP' })
    .where('season_id', '=', fx.f.seasonA)
    .execute()
  await run.visit(`/groups/league/${fx.f.leagueA}/scheduler`)
  await labelled(b, 'Demo Regular Size: 46/60 MP')
  const size = await b.page.evaluate(() => {
    const line = (label: string): { lines: number; width: number } => {
      const node = document.querySelector(`[aria-label="${label}"]`)!
      const range = document.createRange()
      range.selectNodeContents(node)
      const tops = new Set(
        [...range.getClientRects()].map(rect => Math.round(rect.top))
      )
      // Its unwrapped width, measured in the cell's own font.
      const context = document.createElement('canvas').getContext('2d')!
      context.font = getComputedStyle(node.firstElementChild!).font
      return {
        lines: tops.size,
        width: context.measureText(String(node.textContent)).width
      }
    }
    const height = (label: string): number =>
      document
        .querySelector(`[aria-label^="${label}"]`)!
        .getBoundingClientRect().height
    return {
      ...line('Demo Regular Size: 46/60 MP'),
      cell: height('Demo Regular Size: '),
      teams: height('Demo Regular Teams: '),
      teamsWidth: document
        .querySelector('[aria-label^="Demo Regular Teams: "]')!
        .getBoundingClientRect().width,
      sizeWidth: document
        .querySelector('[aria-label^="Demo Regular Size: "]')!
        .getBoundingClientRect().width
    }
  })
  trace(`size ${JSON.stringify(size)}`)
  await scrollToText(b, 'SCHEDULE SETTINGS')
  await run.capture(join(run.support, 'season-grid-after-mp.png'))
  expect(size.lines).equals(1)
  expect(size.cell).equals(size.teams)
  // Teams stays 4.5 rem; Size is wider by what 46/60 MP needs.
  expect(size.teamsWidth).equals(72)
  expect(size.sizeWidth).greaterThan(size.width)
  await run.pass(
    'the Auto-Scheduler row is the last card on the Seasons tab, below the seasons and out of the hero; Game MINS, Between MINS, # Regular and # Exhibition edit in place with the whole number selected, Tab and Enter save 100, 5, 6 and 2, 47 is refused with the 5-minute message and Escape restores 100; after a reload the cells read bare numbers under GAME MINS, BETWEEN MINS, # REGULAR and # EXHIBITION, Teams reads 7 + 2 beside Size, and no dialog opens; set to 46/60 MP, the Size cell stays one line, as tall as Teams'
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

/**
 * A season's stored zone, as the league's schedule setup lists it, through
 * curl.
 */
async function curlZone(
  run: Run,
  lines: string[],
  seasonId: string
): Promise<string> {
  const setup = JSON.parse(
    await curl(run, lines, 'GET', `/leagues/${run.fx.f.leagueA}/schedule-setup`)
  ) as ScheduleSetup
  const zone = setup.seasons.find(season => season.id === seasonId)!.timezone
  lines.push(`Stored zone of ${seasonId}: ${zone}`, '')
  return zone
}

/** A time as the preview's rows show it: the viewer's, then the field's. */
function rowTime(
  game: { startAt: string; endAt: string | null },
  field: string,
  viewer: string
): string {
  const there = new Intl.DateTimeFormat('en', {
    timeZone: field,
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(game.startAt))
  return `${eventLocalRange(game.startAt, game.endAt, viewer)} · ${there} ${zoneName(game.startAt, field)} at the field`
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
 * F2: a season is dates. Every season's setup says its times are local to
 * each field, whatever zone it holds, and a settings save writes no zone.
 */
async function f2(run: Run): Promise<void> {
  const { fx, b } = run
  const lines = [
    '$ node -r sucrase/register src/app/autoSchedulerFixes.e2e.ts --only F2',
    ''
  ]
  const setupOf = (seasonId: string): string =>
    `/groups/league/${fx.f.leagueA}/scheduler/seasons/${seasonId}`
  const named = [
    'UTC',
    'Coordinated Universal Time',
    'Eastern Time',
    'Pacific Time',
    'America/',
    'time zone'
  ]
  await inZone(b, 'America/Los_Angeles', async () => {
    expect(await curlZone(run, lines, fx.f.playoffs)).equals('UTC')
    // seasonA holds America/New_York; playoffs, the UTC default.
    await run.visit(setupOf(fx.f.seasonA))
    await contains(b.page, 'Demo Regular')
    await contains(b.page, 'Times are local to each field.')
    for (const other of named) expect(await pageText(b)).not.includes(other)
    await run.visit(setupOf(fx.f.playoffs))
    await contains(b.page, 'Demo Playoffs')
    await contains(b.page, 'Times are local to each field.')
    for (const other of named) expect(await pageText(b)).not.includes(other)
    await run.capture('season-zone-after.png')
    // In the Auto-Scheduler, playoffs joins the run and saves a number.
    await run.visit(`/groups/league/${fx.f.leagueA}/scheduler`)
    await contains(b.page, 'SCHEDULE SETTINGS')
    await clickLabel(b, 'Demo Playoffs')
    await labelled(b, 'Demo Playoffs Regular-season games: 0')
    await scrollToText(b, 'SCHEDULE SETTINGS')
    await gridTo(b, 'Demo Playoffs Regular-season games: 0')
    await tapLabel(b, 'Demo Playoffs Regular-season games: 0')
    await selected(b, 'Demo Playoffs Regular-season games', '0')
    await type(b, '2')
    await press(b, 'Enter')
    await labelled(b, 'Demo Playoffs Regular-season games: 2')
    // The save stored the number and no zone.
    expect(await curlZone(run, lines, fx.f.playoffs)).equals('UTC')
    await run.visit(setupOf(fx.f.playoffs))
    await contains(b.page, 'Times are local to each field.')
    expect(await pageText(b)).not.includes('UTC')
  })
  await writeFile(join(run.artifacts, 'season-zone.log'), lines.join('\n'))
  await run.pass(
    'seasonA (America/New_York) and playoffs (UTC) both read "Times are local to each field." in a Los Angeles browser, naming no zone and no UTC; after playoffs\' # Regular is saved as 2 from the grid, its stored zone still reads UTC (season-zone.log)'
  )
}

/**
 * F2b: a season stored as UTC is built in its field's local time: its
 * windows meet Field 1's hours in New York. The preview shows each time in
 * the viewer's zone and names the field's, and Add game reads its date and
 * start at the chosen field.
 */
async function f2b(run: Run): Promise<void> {
  const { fx, b } = run
  const lines = [
    '$ node -r sucrase/register src/app/autoSchedulerFixes.e2e.ts --only F2b',
    ''
  ]
  const FIELD_ZONE = 'America/New_York'
  const VIEWER = 'America/Los_Angeles'
  await inZone(b, VIEWER, async () => {
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
    // Weekday games meet seasonA's windows and Field 1's 17:00–21:00 hours
    // in New York: 17:30–21:00 until June, 18:00–21:00 from June 1, for
    // 90-minute games with 10 between. Read in UTC, the 17:30 window would
    // start at 13:30 in New York, before Field 1 opens, and there would be
    // no 17:30 game.
    const preview = JSON.parse(
      await curl(run, lines, 'GET', `/schedule-previews/${previewId}`)
    ) as SchedulePreview
    expect(
      preview.fields.map(field => [field.name, field.timezone])
    ).deep.equals([['Field 1', FIELD_ZONE]])
    const weekday = preview.options[0].games
      .map(game => ({
        game,
        local: eventLocalFields(game.startAt, FIELD_ZONE)
      }))
      .filter(({ local }) => {
        const day = new Date(`${local.date}T12:00:00Z`).getUTCDay()
        return day >= 1 && day <= 5
      })
    trace(`weekday starts ${JSON.stringify(weekday.map(each => each.local))}`)
    expect(weekday.length).greaterThan(0)
    for (const { local } of weekday)
      expect(
        local.date < '2027-06-01' ? ['17:30', '19:10'] : ['18:00', '19:40'],
        JSON.stringify(local)
      ).includes(local.time)
    lines.push(
      `Option 1's ${weekday.length} weekday games, as UTC instants and in ${FIELD_ZONE}, Field 1's zone:`,
      ...weekday.map(
        ({ game, local }) => `  ${game.startAt}  ${local.date} ${local.time}`
      ),
      ''
    )
    // The rows show Los Angeles times and name Field 1's zone.
    const shown = await pageText(b)
    for (const { game } of weekday)
      expect(shown, game.startAt).includes(rowTime(game, FIELD_ZONE, VIEWER))
    expect(shown).not.includes('UTC')
    // Add game reads its date and start at the chosen field.
    await tapText(b, 'Add game')
    await contains(
      b.page,
      'The date and start are local to the field you choose.'
    )
    await clickLabel(b, 'Field: Choose')
    await tapText(b, 'Field 1, Example Park')
    await contains(
      b.page,
      'The date and start are local to Field 1 at Example Park.'
    )
    for (const other of ['UTC', 'America/', 'time zone'])
      expect(await pageText(b)).not.includes(other)
    await scrollToText(b, 'Add game', 24)
    await run.capture('preview-zone-after.png')
    expect(await curlZone(run, lines, fx.f.seasonA)).equals('UTC')
    await run.pass(
      `seasonA's stored zone, forced to UTC, read UTC before the build and after it (build-zone.log); Option 1's ${weekday.length} weekday games each start at 5:30 PM or 7:10 PM New York time (6:00 PM or 7:40 PM from June 1), Field 1's local time; each row shows its Los Angeles time and names Field 1's zone; the Add-game note reads "The date and start are local to Field 1 at Example Park.", with no UTC anywhere`
    )
  })
  await writeFile(join(run.artifacts, 'build-zone.log'), lines.join('\n'))
}

/**
 * F3: a window period ends on a chosen date, the days after it have no
 * windows and no games, and another season copies the periods.
 */
async function f3(run: Run): Promise<void> {
  const { fx, b } = run
  const lines = [
    '$ node -r sucrase/register src/app/autoSchedulerFixes.e2e.ts --only F3',
    ''
  ]
  const setupOf = (seasonId: string): string =>
    `/groups/league/${fx.f.leagueA}/scheduler/seasons/${seasonId}`
  // seasonA's first period, from Mar 1, ends on May 20.
  await run.visit(setupOf(fx.f.seasonA))
  await contains(b.page, 'From Mar 1')
  await contains(b.page, 'From Jun 1')
  await clickLabel(
    b,
    'Change the end of the windows from Monday, March 1, 2027'
  )
  await labelled(b, 'Choose 2027-05-31')
  await tapLabel(b, 'Choose 2027-05-20')
  await tapText(b, 'Use date')
  await contains(b.page, 'End date saved.')
  await run.visit(setupOf(fx.f.seasonA))
  await contains(b.page, 'Mar 1 – May 20')
  await contains(b.page, 'From Jun 1')
  expect(await pageText(b)).not.includes('From Mar 1')
  // Each period now has its Starts and Ends card, so the section is taller
  // than the before shot's: the section's title goes under the header to
  // keep both periods' headings clear of the floating nav bar.
  await scrollToText(b, 'GAME WINDOWS', 22)
  const frame = await b.page.evaluate(() => {
    const box = (text: string): DOMRect =>
      [...document.querySelectorAll('div, span')]
        .find(
          node => node.childElementCount === 0 && node.textContent === text
        )!
        .getBoundingClientRect()
    const nav = document.querySelector('[role="tablist"]')
    return {
      first: box('Mar 1 – May 20').top,
      second: box('From Jun 1').bottom,
      nav: nav === null ? innerHeight : nav.getBoundingClientRect().top
    }
  })
  trace(`frame ${JSON.stringify(frame)}`)
  expect(frame.first).greaterThan(56)
  expect(frame.second).lessThan(frame.nav)
  await run.capture('window-periods-after.png')
  // The Auto-Scheduler warns of the days no period covers.
  await run.visit(`/groups/league/${fx.f.leagueA}/scheduler`)
  const gap = 'Demo Regular has no game windows May 21 – May 31.'
  await contains(b.page, gap)
  const warning = await b.page.evaluate((text: string) => {
    const list = document.querySelector('[data-testid="early-warnings"]')
    return list !== null && String(list.textContent).includes(text)
  }, gap)
  expect(warning).equals(true)
  await scrollToText(b, 'EARLY WARNINGS')
  await run.capture('window-gap-warning.png')
  // A build places no game on those days.
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
  const preview = JSON.parse(
    await curl(run, lines, 'GET', `/schedule-previews/${previewId}`)
  ) as SchedulePreview
  const days = preview.options[0].games.map(
    game => eventLocalFields(game.startAt, 'America/New_York').date
  )
  expect(days.length).greaterThan(0)
  const uncovered = days.filter(
    day => day >= '2027-05-21' && day <= '2027-05-31'
  )
  lines.push(
    `Option 1's ${days.length} games, by date in America/New_York: ${days.join(', ')}`,
    `Dated May 21 – May 31: ${uncovered.length === 0 ? 'none' : uncovered.join(', ')}`,
    ''
  )
  expect(uncovered).deep.equals([])
  // The playoffs, with no windows, copy seasonA's: the seasons start
  // together, and the June period starts after the playoffs end.
  await run.visit(setupOf(fx.f.playoffs))
  await contains(b.page, 'No game windows yet.')
  await scrollToText(b, 'GAME WINDOWS')
  await tapText(b, 'Copy from another season')
  await contains(b.page, 'Copy game windows from')
  await labelled(b, 'Demo Regular')
  await contains(b.page, '2027 · 2 periods')
  await run.capture('copy-windows-after.png')
  await clickLabel(b, 'Demo Regular')
  await contains(b.page, 'Game windows copied from Demo Regular.')
  await contains(b.page, 'Mar 1 – May 20')
  const stored = async (): Promise<unknown> =>
    (
      JSON.parse(
        await curl(
          run,
          lines,
          'GET',
          `/seasons/${fx.f.playoffs}/schedule-settings`
        )
      ) as { settings: { windows: Array<{ from: string; until?: string }> } }
    ).settings.windows.map(({ from, until }) => ({ from, until }))
  const copied = [{ from: '2027-03-01', until: '2027-05-20' }]
  expect(await stored()).deep.equals(copied)
  // A second copy asks before it replaces them.
  await tapText(b, 'Copy from another season')
  await clickLabel(b, 'Demo Regular')
  await contains(b.page, 'Replace this season’s game windows?')
  await clickLabel(b, 'Replace game windows')
  await b.page.waitForFunction(
    () =>
      !String(document.body.textContent).includes(
        'Replace this season’s game windows?'
      ),
    { timeout: 15000 }
  )
  await contains(b.page, 'Game windows copied from Demo Regular.')
  expect(await stored()).deep.equals(copied)
  await writeFile(join(run.artifacts, 'window-gap-build.log'), lines.join('\n'))
  await run.pass(
    `seasonA's first period ends May 20: after a reload its headings read "Mar 1 – May 20" and "From Jun 1"; the Early warnings say "${gap}"; a build with Work around places none of Option 1's ${days.length} games on May 21 – May 31 (window-gap-build.log); the playoffs copy Demo Regular's windows as one period, Mar 1 – May 20 (shifted 0 days, the June period dropped after the playoffs' end), and a second copy asks "Replace this season’s game windows?" before replacing them`
  )
}

/**
 * Picks a range in the open two-tap range calendar, moving month by month to
 * each end, and uses it. The same day twice is one day.
 */
async function chooseRange(
  b: BrowserSession,
  from: string,
  to: string
): Promise<void> {
  for (const day of [from, to]) {
    for (let month = 0; month < 36; month++) {
      const shown = await b.page.evaluate(() =>
        [...document.querySelectorAll('[aria-label^="20"]')]
          .map(node => String(node.getAttribute('aria-label')))
          .filter(label => /^\d{4}-\d{2}-\d{2}$/.test(label))
      )
      if (shown.includes(day)) break
      await tapLabel(
        b,
        shown.length > 0 && shown[0] > day ? 'Previous month' : 'Next month'
      )
    }
    await tapLabel(b, day)
  }
  await tapText(b, 'Use this range')
}

/** The ranges' rows on the screen, title and year, in order. */
async function rangeRows(b: BrowserSession): Promise<string[]> {
  return await b.page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="relationship-action-row"]')]
      .map(row =>
        [...row.querySelectorAll('div')]
          .filter(node => node.childElementCount === 0)
          .map(node => String(node.textContent))
          .filter(text => text !== 'Remove')
      )
      // A range's row: its dates, then its year or years.
      .filter(texts => /^\d{4}( – \d{4})?$/.test(texts[texts.length - 1]))
      .map(texts => texts.join(' / '))
  )
}

/**
 * F4: blackouts are entered as ranges, as many as needed, for a season, a
 * venue and a field; each list reads ranges with day counts and a single day
 * alone, and a range is removed whole.
 */
async function f4(run: Run): Promise<void> {
  const { fx, b, state } = run
  const setup = `/groups/league/${fx.f.leagueA}/scheduler/seasons/${fx.f.seasonA}`
  const seasonBlackouts = async (): Promise<string[]> =>
    (
      await api<{ settings: { blackouts: string[] } }>(
        fx,
        ADMIN,
        'GET',
        `/seasons/${fx.f.seasonA}/schedule-settings`
      )
    ).settings.blackouts
  // seasonA: Apr 2 – Apr 5, then May 29 alone.
  await run.visit(setup)
  await contains(b.page, 'BLACKOUT DAYS')
  await scrollToText(b, 'BLACKOUT DAYS', 160)
  await tapText(b, 'Add blackout dates')
  await chooseRange(b, '2027-04-02', '2027-04-05')
  await contains(b.page, 'Apr 2 – Apr 5 · 4 days')
  await tapText(b, 'Add blackout dates')
  await chooseRange(b, '2027-05-29', '2027-05-29')
  await labelled(b, 'Remove blackout Saturday, May 29, 2027')
  await contains(b.page, 'Blackout days saved.')
  const season = await rangeRows(b)
  trace(`season rows ${JSON.stringify(season)}`)
  expect(season).deep.equals(['Apr 2 – Apr 5 · 4 days / 2027', 'May 29 / 2027'])
  expect(await seasonBlackouts()).deep.equals([
    '2027-04-02',
    '2027-04-03',
    '2027-04-04',
    '2027-04-05',
    '2027-05-29'
  ])
  await scrollToText(b, 'BLACKOUT DAYS', 160)
  await run.capture('blackouts-after.png')
  // Example Park: Dec 20 – Jan 2, across the year end.
  await run.visit(`/venues/${state.venueId!}`)
  await contains(b.page, 'Default blackout days')
  await scrollToText(b, 'Default blackout days', 160)
  await tapText(b, 'Add blackout dates')
  await chooseRange(b, '2026-12-20', '2027-01-02')
  await contains(b.page, 'Dec 20 – Jan 2 · 14 days')
  expect(await rangeRows(b)).deep.equals([
    'Dec 20 – Jan 2 · 14 days / 2026 – 2027'
  ])
  const venue = await api<{ defaultBlackouts: string[] }>(
    fx,
    ADMIN,
    'GET',
    `/venues/${state.venueId!}`
  )
  expect(venue.defaultBlackouts).length(14)
  expect([venue.defaultBlackouts[0], venue.defaultBlackouts[13]]).deep.equals([
    '2026-12-20',
    '2027-01-02'
  ])
  await scrollToText(b, 'Default blackout days', 160)
  await run.capture(join(run.support, 'F4-venue-blackouts.png'))
  // Field 1: Mar 10 – Mar 11 of its own, under the venue's inherited range.
  await run.visit(`/venues/${state.venueId!}/fields/${state.fieldId!}`)
  await contains(b.page, 'The venue is also closed on these days:')
  await scrollToText(b, 'The venue is also closed on these days:', 160)
  await tapText(b, 'Add blackout dates')
  await chooseRange(b, '2027-03-10', '2027-03-11')
  await labelled(
    b,
    'Remove blackout Wednesday, March 10, 2027 – Thursday, March 11, 2027'
  )
  expect(await rangeRows(b)).deep.equals([
    'Dec 20 – Jan 2 · 14 days / 2026 – 2027',
    'Mar 10 – Mar 11 · 2 days / 2027'
  ])
  // The venue's range is read only on the field.
  await labelled(
    b,
    'Remove blackout Sunday, December 20, 2026 – Saturday, January 2, 2027',
    false
  )
  await scrollToText(b, 'The venue is also closed on these days:', 160)
  await run.capture(join(run.support, 'F4-field-blackouts.png'))
  // Back on seasonA, the April range is removed whole.
  await run.visit(setup)
  await contains(b.page, 'Apr 2 – Apr 5 · 4 days')
  await scrollToText(b, 'BLACKOUT DAYS', 160)
  await tapLabel(
    b,
    'Remove blackout Friday, April 2, 2027 – Monday, April 5, 2027'
  )
  // While it saves the Remove actions hide, so wait for the save.
  await contains(b.page, 'Blackout days saved.')
  await labelled(b, 'Remove blackout Saturday, May 29, 2027')
  expect(await rangeRows(b)).deep.equals(['May 29 / 2027'])
  expect(await seasonBlackouts()).deep.equals(['2027-05-29'])
  await run.pass(
    'seasonA lists "Apr 2 – Apr 5 · 4 days" and "May 29" alone, stored as the five dates; Example Park lists "Dec 20 – Jan 2 · 14 days" across the year end, stored as 14 dates; Field 1 lists the venue\'s range, with no Remove, above its own "Mar 10 – Mar 11 · 2 days"; removing the April range on seasonA leaves only May 29'
  )
}

/** Scrolls the element matching this selector to the middle of the screen. */
async function centerOn(b: BrowserSession, selector: string): Promise<void> {
  await b.page.waitForSelector(selector, { timeout: 15000 })
  await b.page.evaluate((wanted: string) => {
    const node = document.querySelector(wanted)
    if (node !== null) node.scrollIntoView({ block: 'center' })
  }, selector)
  await new Promise(resolve => setTimeout(resolve, 600))
}

/** What each control labelled "Add field" reads, in page order. */
async function addFieldControls(b: BrowserSession): Promise<string[]> {
  return await b.page.evaluate(() =>
    [...document.querySelectorAll('[aria-label="Add field"]')].map(node =>
      String(node.textContent)
    )
  )
}

/**
 * F5: an empty venue offers a whole "Add field" row in place of the header's
 * Add; T-ball and 46/60 are two sizes; a day turned open fills 9 to 5.
 */
async function f5(run: Run): Promise<void> {
  const { fx, b, state } = run
  const venuePath = `/venues/${state.venueId!}`
  await run.visit(venuePath)
  await contains(b.page, 'Default hours')
  // The row: its plus tile (the web draws the icon from its name), its title
  // and its chevron; and no header Add beside it.
  await b.page.waitForFunction(
    () => document.querySelector('[aria-label="Add field"]') !== null,
    { timeout: 15000 }
  )
  expect(await addFieldControls(b)).deep.equals(['addAdd fieldchevron_right'])
  expect(await b.page.evaluate(() => document.body.innerText)).not.includes(
    'No fields yet'
  )
  await b.page.evaluate(() => {
    const found = [...document.querySelectorAll('div, span')].find(
      node => node.childElementCount === 0 && node.textContent === 'FIELDS'
    )
    if (found !== undefined) found.scrollIntoView({ block: 'center' })
  })
  await new Promise(resolve => setTimeout(resolve, 600))
  await run.capture('venue-empty-after.png')
  // Add field's sizes: T-ball and 46/60 apart.
  await tapLabel(b, 'Add field')
  await contains(b.page, 'The sizes it can be set up in.')
  await labelled(b, 'T-ball')
  await labelled(b, '46/60')
  expect(
    await b.page.evaluate(() =>
      [...document.querySelectorAll('[role="checkbox"]')].map(node =>
        node.getAttribute('aria-label')
      )
    )
  ).deep.equals(['T-ball', '46/60 MP', '46/60', '50/70', '55/80', '60/90'])
  await run.capture('field-sizes-after.png')
  await fill(b.m, 'Field name', 'Tee Field')
  await tapLabel(b, 'T-ball')
  await tapText(b, 'Add field')
  await contains(b.page, 'Tee Field added.')
  // With a field, the row is gone and the header's Add is back.
  await b.page.waitForFunction(
    () =>
      [...document.querySelectorAll('[aria-label="Add field"]')].map(
        node => node.textContent
      )[0] === 'Add',
    { timeout: 15000 }
  )
  expect(await addFieldControls(b)).deep.equals(['Add'])
  const teeRow = await b.page.evaluate(() => {
    const row = document.querySelector('[aria-label="Open Tee Field"]')
    return row === null ? null : row.textContent
  })
  expect(teeRow).equals('Tee FieldT-ball')
  const venue = await api<{ fields: Array<{ name: string; sizes: string[] }> }>(
    fx,
    ADMIN,
    'GET',
    venuePath
  )
  expect(venue.fields.map(field => [field.name, field.sizes])).deep.equals([
    ['Tee Field', ['T-ball']]
  ])
  // Monday, opened from Closed, fills 9:00 AM to 5:00 PM.
  await centerOn(b, '[aria-label="Default hours: Monday, Closed"]')
  await tapLabel(b, 'Default hours: Monday, Closed')
  await contains(b.page, 'Done')
  await tapText(b, 'Open')
  await labelled(b, 'Opens 9:00 AM')
  await labelled(b, 'Closes 5:00 PM')
  await run.capture('hours-default-after.png')
  await tapText(b, 'Done')
  await contains(b.page, 'Hours saved.')
  const hours = await api<{ defaultHours: unknown[] }>(
    fx,
    ADMIN,
    'GET',
    venuePath
  )
  expect(hours.defaultHours).deep.equals([
    { weekday: 1, start: '09:00', end: '17:00' }
  ])
  await run.pass(
    'Example Park with no fields shows a full-width "Add field" row with the plus in its icon tile and no header Add; Add field lists T-ball, 46/60 MP, 46/60, 50/70, 55/80 and 60/90 as six choices; after adding Tee Field with T-ball only the row is gone, the header Add is back and Tee Field reads T-ball; Monday opened from Closed fills 9:00 AM – 5:00 PM and saves 09:00–17:00'
  )
}

/**
 * Runs a shell pipeline that starts with a curl against the fixture server
 * as the league admin, the token in `$TOKEN`, and adds it and its output to
 * a log. The server runs in this process, so the command must not block its
 * event loop.
 */
async function curlPipe(
  run: Run,
  lines: string[],
  path: string,
  filter: string
): Promise<string> {
  const command = `curl -sS -H "Authorization: Bearer $TOKEN" '${run.fx.f.h.origin}/api/v1${path}' | jq -c '${filter}'`
  const { stdout } = await promisify(execFile)('sh', ['-c', command], {
    encoding: 'utf8',
    env: { ...process.env, TOKEN: run.fx.f.h.tokens.get(ADMIN)! }
  })
  const answer = stdout.trim()
  lines.push(`$ ${command}`, answer, '')
  return answer
}

/** The run field row's own text: its check mark, label and detail. */
async function runFieldRow(
  b: BrowserSession,
  label: string
): Promise<string | null> {
  return await b.page.evaluate((wanted: string) => {
    const row = document.querySelector(`[aria-label="${wanted}"]`)
    return row === null ? null : String(row.textContent)
  }, label)
}

/**
 * F6: Fields for this run adds a field of a venue nobody has claimed, the
 * run builds and publishes on it, and, unchecked, it stays listed when the
 * admin comes back.
 */
async function f6(run: Run): Promise<void> {
  const { fx, b } = run
  const lines = [
    '$ node -r sucrase/register src/app/autoSchedulerFixes.e2e.ts --only F6',
    ''
  ]
  const harbor = 'Harbor Diamond, Harbor Field'
  await run.visit(`/groups/league/${fx.f.leagueA}/scheduler`)
  await contains(b.page, 'FIELDS FOR THIS RUN')
  await contains(b.page, 'Field 1, Example Park')
  expect(await runFieldRow(b, harbor)).equals(null)
  // Add field opens the picker in field mode: a venue, then its field.
  await clickLabel(b, 'Add a field to this run')
  await contains(b.page, 'Choose field')
  await fill(b.m, 'Search venues', 'Harbor')
  await clickLabel(b, 'Harbor Field, 1 Demo Way, Demo City')
  await contains(b.page, 'Harbor Diamond')
  await clickLabel(b, 'Harbor Diamond, 50/70')
  await b.page.waitForFunction(
    () => document.querySelector('[data-testid="field-picker"]') === null,
    { timeout: 15000 }
  )
  await contains(b.page, 'Harbor Field · unclaimed')
  expect(await runFieldRow(b, harbor)).equals(
    '✓Harbor Diamond, Harbor Field50/70 · Harbor Field · unclaimed'
  )
  // Field 1 leaves the run, so every game goes to Harbor Diamond.
  await clickLabel(b, 'Field 1, Example Park')
  await b.page.waitForFunction(
    (label: string) => {
      const row = document.querySelector(`[aria-label="${label}"]`)
      return row !== null && !String(row.textContent).startsWith('✓')
    },
    { timeout: 15000 },
    'Field 1, Example Park'
  )
  const setup = await api<{ fieldIds: string[] }>(
    fx,
    ADMIN,
    'GET',
    `/leagues/${fx.f.leagueA}/schedule-setup`
  )
  expect(setup.fieldIds).deep.equals([HARBOR_DIAMOND])
  await scrollToText(b, 'FIELDS FOR THIS RUN')
  await run.capture('run-fields-after.png')
  // Build seasonA's schedule, working around its two games on Field 1.
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
  const preview = await api<SchedulePreview>(
    fx,
    ADMIN,
    'GET',
    `/schedule-previews/${previewId}`
  )
  expect(preview.options.length).greaterThan(0)
  const planned = preview.options[0].games
  expect(planned.length).greaterThan(0)
  expect(planned.every(game => game.fieldId === HARBOR_DIAMOND)).equals(true)
  await tapText(b, 'Publish this option')
  await contains(b.page, `${planned.length} games scheduled`)
  // seasonA's games over the API: the two it had on Field 1, and every new
  // one on Harbor Diamond.
  const listed = JSON.parse(
    await curlPipe(
      run,
      lines,
      `/seasons/${fx.f.seasonA}`,
      '[.games[] | {id, startAt, venue}]'
    )
  ) as Array<{ id: string; startAt: string; venue: string | null }>
  const published = await fx.f.h.db
    .selectFrom('games')
    .select('id')
    .where('schedule_preview_id', '=', previewId)
    .execute()
  const fresh = new Set(published.map(game => game.id))
  expect(fresh.size).equals(planned.length)
  const newGames = listed.filter(game => fresh.has(game.id))
  expect(newGames.length).equals(planned.length)
  expect(listed.length).equals(planned.length + 2)
  const fields: string[] = []
  for (const game of newGames) {
    const field = JSON.parse(
      await curlPipe(
        run,
        lines,
        `/games/${game.id}/scheduling`,
        '.game | {fieldId, fieldSize, venue}'
      )
    ) as { fieldId: string; fieldSize: string; venue: string }
    expect(field, game.id).deep.equals({
      fieldId: HARBOR_DIAMOND,
      fieldSize: '50/70',
      venue: 'Harbor Field'
    })
    fields.push(field.fieldId)
  }
  lines.push(
    `seasonA has ${listed.length} games: the 2 it had on Field 1, and the ${newGames.length} Option 1 published, each on ${HARBOR_DIAMOND} (Harbor Diamond, Harbor Field, 50/70): ${fields.every(id => id === HARBOR_DIAMOND) ? 'yes' : 'no'}`,
    ''
  )
  await writeFile(
    join(run.artifacts, 'run-fields-publish.log'),
    lines.join('\n')
  )
  // Unchecked, the added field stays listed after the admin leaves the
  // screen and comes back, with its Remove action.
  await run.visit(`/groups/league/${fx.f.leagueA}/scheduler`)
  await contains(b.page, 'FIELDS FOR THIS RUN')
  await clickLabel(b, harbor)
  await b.page.waitForFunction(
    (label: string) => {
      const row = document.querySelector(`[aria-label="${label}"]`)
      return row !== null && !String(row.textContent).startsWith('✓')
    },
    { timeout: 15000 },
    harbor
  )
  await run.visit(`/groups/league/${fx.f.leagueA}`)
  await labelled(b, AUTO_SCHEDULER)
  await run.visit(`/groups/league/${fx.f.leagueA}/scheduler`)
  await contains(b.page, 'FIELDS FOR THIS RUN')
  await contains(b.page, 'Harbor Field · unclaimed')
  expect(await runFieldRow(b, harbor)).equals(
    'Harbor Diamond, Harbor Field50/70 · Harbor Field · unclaimed'
  )
  await labelled(b, `Remove ${harbor} from the list`)
  const kept = await api<{ fieldIds: string[]; addedFieldIds: string[] }>(
    fx,
    ADMIN,
    'GET',
    `/leagues/${fx.f.leagueA}/schedule-setup`
  )
  expect(kept.fieldIds).deep.equals([])
  expect(kept.addedFieldIds).deep.equals([HARBOR_DIAMOND])
  await scrollToText(b, 'FIELDS FOR THIS RUN')
  await run.capture('run-fields-kept.png')
  await run.pass(
    `Fields for this run's Add field opened the picker in field mode: searching "Harbor", Harbor Field, then Harbor Diamond added it at once with no size step, listed checked as "Harbor Diamond, Harbor Field" with "50/70 · Harbor Field · unclaimed"; with Field 1 unchecked the run's only field is Harbor Diamond; the build gave ${preview.options.length === 1 ? '1 option' : `${preview.options.length} options`}, Option 1's ${planned.length} games all on Harbor Diamond; publishing scheduled them, and over the API every one of seasonA's ${newGames.length} new games is on Harbor Diamond (run-fields-publish.log); unchecked, Harbor Diamond was still listed, unchecked with its Remove action, after leaving the Auto-Scheduler and coming back, and the setup keeps it in addedFieldIds`
  )
}

/** The point F7 grants the page, near Example Park. */
const NEAR = { latitude: 40.0, longitude: -75.2 }

/**
 * F7: a Field Manager search lists at least ten places, the person's own
 * venue first, from a Google search for twenty near their position.
 */
async function f7(run: Run): Promise<void> {
  const { fx, b, places } = run
  await b.browser.defaultBrowserContext().setPermission(fx.f.h.origin, {
    permission: { name: 'geolocation' },
    state: 'granted'
  })
  await b.page.setGeolocation(NEAR)
  await run.visit(`/groups/league/${fx.f.leagueA}/scheduler/fields`)
  await contains(b.page, 'Field Manager')
  // The position, once read, sorts the list: wait for it before searching.
  await b.page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Loading venues"]') === null &&
      !document.body.innerText.includes('Allow location access'),
    { timeout: 15000 }
  )
  const before = places.calls.length
  await fill(b.m, 'Search venues', 'Example Park')
  await b.page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Loading venues"]') === null &&
      document.querySelector('[aria-label="Open Linden Park"]') !== null,
    { timeout: 15000 }
  )
  await new Promise(resolve => setTimeout(resolve, 1000))
  const rows = await b.page.evaluate(() =>
    [...document.querySelectorAll('[aria-label^="Open "]')].map(node =>
      String(node.getAttribute('aria-label')).slice('Open '.length)
    )
  )
  expect(rows).deep.equals([EXAMPLE_PARK.name, ...MORE_PARKS])
  expect(rows.length).greaterThanOrEqual(10)
  const headers = await b.page.evaluate(() =>
    [...document.querySelectorAll('[role="heading"]')].map(node =>
      String(node.textContent)
    )
  )
  expect(headers).includes('Your leagues’ venues')
  expect(headers).includes('Unclaimed venues')
  // The registry's Example Park leads, under the person's own venues.
  const own = await b.page.evaluate(() => {
    const row = document.querySelector('[aria-label="Open Example Park"]')
    return row === null ? '' : String(row.textContent)
  })
  expect(own).includes('Demo League A')
  // What the server asked Google: twenty places, near the granted point.
  const searches = places.calls
    .slice(before)
    .filter(call => call.path === '/v1/places:searchText')
    .map(call => call.body)
  expect(searches.length).greaterThan(0)
  for (const body of searches) expect(body).property('pageSize', 20)
  const asked = searches[searches.length - 1]
  expect(asked).deep.equals({
    textQuery: 'Example Park',
    languageCode: 'en',
    pageSize: 20,
    locationBias: { circle: { center: NEAR, radius: 50000 } }
  })
  await b.page.evaluate(() => {
    const root = document.scrollingElement
    if (root !== null) root.scrollTop = 0
  })
  await run.capture('field-search-after.png')
  // The end of the list, as support: the last of the twelve, above the tab
  // bar once the page is scrolled all the way down.
  await b.page.evaluate(() => {
    let node = document.querySelector('[aria-label="Open Linden Park"]')
    while (node !== null && node.scrollHeight <= node.clientHeight + 1)
      node = node.parentElement
    if (node !== null) node.scrollTop = node.scrollHeight
  })
  await new Promise(resolve => setTimeout(resolve, 600))
  await run.capture(join(run.support, 'F7-field-search-end.png'))
  await run.pass(
    `Searching "Example Park" lists ${rows.length} venues: Example Park under "Your leagues’ venues", then ${MORE_PARKS.length} unclaimed places from Google, ${MORE_PARKS[0]} to ${MORE_PARKS[MORE_PARKS.length - 1]}; the server asked Google for ${JSON.stringify(asked)}`
  )
}

/**
 * The field screen's map frame once it has drawn: Google's map with its pin,
 * or the "couldn't load" panel.
 */
async function mapFrame(
  b: BrowserSession,
  drawn: 'map' | 'failed'
): Promise<Frame> {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    for (const candidate of b.page.frames())
      if (
        candidate.url() === 'about:srcdoc' &&
        (await candidate
          .evaluate(
            (wanted: string) =>
              wanted === 'map'
                ? document.querySelector(
                    '[data-google-maps-stub] [data-lat]'
                  ) !== null
                : document.querySelector('#failed:not([hidden])') !== null,
            drawn
          )
          .catch(() => false))
      )
        return candidate
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`The pin map never showed its ${drawn}`)
}

/** The stub's pin: where it is, and whether it drags. */
async function stubPin(
  frame: Frame
): Promise<{ lat: number; lng: number; draggable: boolean }> {
  return await frame.evaluate(() => {
    const pin = document.querySelector<HTMLElement>('[data-lat]')
    if (pin === null) throw new Error('No pin')
    return {
      lat: Number(pin.dataset.lat),
      lng: Number(pin.dataset.lng),
      draggable: pin.dataset.draggable === 'true'
    }
  })
}

/** Where Field 1 sits, by the venue API. */
async function fieldPoint(
  run: Run
): Promise<{ latitude: number; longitude: number }> {
  const venue = await api<VenueDetail>(
    run.fx,
    ADMIN,
    'GET',
    `/venues/${run.state.venueId!}`
  )
  const field = venue.fields.find(item => item.id === run.state.fieldId)!
  return (
    field.pin ?? {
      latitude: venue.map.latitude,
      longitude: venue.map.longitude
    }
  )
}

const DRAGGED = { latitude: 40.0213, longitude: -75.2214 }

/**
 * F8: Field 1's map is Google's, through the stub, with no OpenStreetMap or
 * Leaflet request; a dragged pin persists; an auth failure shows the
 * "couldn't load" panel, whose Retry brings the map back.
 */
async function f8(run: Run): Promise<void> {
  const { b } = run
  const first = run.requests.length
  const path = `/venues/${run.state.venueId!}/fields/${run.state.fieldId!}`
  const start = await fieldPoint(run)
  await run.visit(path)
  await contains(b.page, 'WHERE IT IS')
  await scrollToText(b, 'WHERE IT IS', 120)
  let frame = await mapFrame(b, 'map')
  expect(await stubPin(frame)).deep.equals({
    lat: start.latitude,
    lng: start.longitude,
    draggable: true
  })
  await new Promise(resolve => setTimeout(resolve, 600))
  await run.capture('field-map-web-after.png')
  // Drag the pin, as letting go of Google's marker does.
  await frame.evaluate(
    (lat: number, lng: number) => {
      ;(window as any).__dragPin(lat, lng)
    },
    DRAGGED.latitude,
    DRAGGED.longitude
  )
  await contains(b.page, 'Pin saved.')
  expect(await fieldPoint(run)).deep.equals(DRAGGED)
  // Reloaded, the map opens on the dragged pin.
  await b.page.reload()
  await contains(b.page, 'WHERE IT IS')
  frame = await mapFrame(b, 'map')
  expect(await stubPin(frame)).deep.equals({
    lat: DRAGGED.latitude,
    lng: DRAGGED.longitude,
    draggable: true
  })
  // Google refuses the key: the stub, loaded with authFailure=1, calls
  // gm_authFailure, and the panel takes the map's place.
  await frame.evaluate((script: string) => {
    const element = document.createElement('script')
    element.src = `${script}key=test-key&authFailure=1`
    document.head.appendChild(element)
  }, GOOGLE_MAPS_SCRIPT)
  frame = await mapFrame(b, 'failed')
  const panel = await frame.evaluate(() => {
    const failed = document.querySelector('#failed')
    const retry = document.querySelector('#retry')
    const map = document.querySelector<HTMLElement>('#map')
    return {
      text: failed === null ? '' : String(failed.textContent),
      retry: retry === null ? '' : String(retry.textContent),
      mapHidden: map === null ? false : map.hidden
    }
  })
  expect(panel.text).includes('The map couldn’t load')
  expect(panel.text).includes(
    `${DRAGGED.latitude.toFixed(5)}, ${DRAGGED.longitude.toFixed(5)}`
  )
  expect(panel.retry).equals('Retry')
  expect(panel.mapHidden).equals(true)
  await scrollToText(b, 'WHERE IT IS', 120)
  await run.capture(join(run.support, 'F8-map-auth-failure.png'))
  // Retry loads the map again, and it draws.
  await frame.click('#retry')
  frame = await mapFrame(b, 'map')
  expect((await stubPin(frame)).lat).equals(DRAGGED.latitude)
  const requests = run.requests.slice(first)
  const foreign = requests.filter(request =>
    /openstreetmap|leaflet|unpkg|tile\./i.test(request.url)
  )
  expect(foreign, 'requests for OpenStreetMap or Leaflet').deep.equals([])
  const mapRequests = requests
    .filter(
      request =>
        request.fromMap ||
        /maps\.googleapis|maps\.gstatic|openstreetmap|leaflet/i.test(
          request.url
        )
    )
    .map(request => request.url)
  expect(mapRequests.length).greaterThanOrEqual(4)
  for (const url of mapRequests)
    expect(url).matches(/^https:\/\/maps\.googleapis\.com\//)
  await writeFile(
    join(run.artifacts, 'field-map-requests.log'),
    `${run.command}\n${mapRequests.join('\n')}\n`
  )
  await run.pass(
    `Field 1's map is the Google stub (${mapRequests.length} map requests, all maps.googleapis.com, none to OpenStreetMap or Leaflet); the pin dragged to ${DRAGGED.latitude}, ${DRAGGED.longitude} was saved and reopens there after a reload; on gm_authFailure "The map couldn’t load" shows the coordinates and Retry, which draws the map again`
  )
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
  },
  F3: { start: 'E7', run: f3 },
  F4: { start: 'E3', run: f4 },
  F5: { start: 'E2', run: f5 },
  F6: {
    start: 'E7',
    then: async fx => {
      await seedHarborField(fx)
    },
    run: f6
  },
  F7: { start: 'E2', run: f7 },
  F8: { start: 'E3', run: f8 }
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
  const command = `$ node -r sucrase/register src/app/autoSchedulerFixes.e2e.ts${only == null ? '' : ` --only ${only}`}`
  await writeFile(join(artifacts, lines), `${command}\n`)
  const coverage = process.env.TS_AUTO_SCHEDULER_BROWSER_COVERAGE
  const parts: string[] = []
  const places = await googlePlacesStub()
  const daemon = await maestro(process.env.MAESTRO_D ?? 'autoSchedulerFixes')
  let b: BrowserSession | undefined
  try {
    b = await browserSession(daemon, DEVICE, WIDTH, HEIGHT, work)
    const session = b
    // Google's Maps script is answered by its stub; everything is logged.
    const requests: Run['requests'] = []
    await interceptGoogleMaps(session.page, request => {
      requests.push(request)
    })
    const cdp = await session.page.createCDPSession()
    for (const [id, scenario] of chosen) {
      console.log(`${id} (start ${scenario.start})`)
      const fx = await autoSchedulerFixture(web, {
        cityLookup: googlePlaces({
          apiKey: 'placeholder-key',
          baseUrl: places.baseUrl
        }),
        googleMapsApiKey: 'test-key'
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
          places,
          requests,
          command,
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
