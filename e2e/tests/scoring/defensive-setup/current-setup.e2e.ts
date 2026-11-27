import { writeFile } from 'node:fs/promises'

import { expect } from 'chai'
import { PerspectiveCamera, Vector3 } from 'three'

import { applyFieldCamera } from '../../../../src/app/field/cameraModel'
import { createPlayers } from '../../../../src/app/field/fieldModel'
import {
  type DefaultLineups,
  startingSetup,
  teamsOf
} from '../../../../src/app/scoring/developmentSession'
import {
  type Position,
  POSITIONS
} from '../../../../src/app/scoring/scoringTypes'
import { type RosterEntry, TeamStationClient } from '../../../../src/common/api'
import { shortName } from '../../../../src/common/names'
import type { ScoringAction } from '../../../../src/common/scoring/actions'
import { ScoringSession } from '../../../../src/common/scoring/session'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import type { HTTPResponse } from '../../../core/web'
import { clearSignInLimits, stackSql } from '../../../rigs/coach/coachApp'
import {
  maestroDriver,
  setTrajectory,
  tapFielder
} from '../../../rigs/fieldPointer'

/**
 * The current defensive scoring setup on the web scorer, in a phone-wide
 * window of the runner's browser, against the stack's API: a fresh
 * `defensive-setup` game (the Owls at the Hawks, ten players a side) whose
 * rosters and default lineups each scenario shapes in the stack's database
 * first. A second device ("the peer") scores into the same game through the
 * API, as another scorer's phone would.
 */

/** The scenario running, and its world's gumbo and user ids: one at a time in a run. */
let ctx: HarnessContext
const current = {
  away: [] as number[],
  home: [] as number[],
  awayUsers: [] as string[],
  homeUsers: [] as string[]
}

function begin(next: HarnessContext): void {
  ctx = next
}

const names = [
  'Mookie Betts',
  'Mike Trout',
  'Shohei Ohtani',
  'Aaron Judge',
  'Bryce Harper',
  'Freddie Freeman',
  'Francisco Lindor',
  'Juan Soto',
  'Bobby Witt',
  'Julio Rodriguez'
]
const roster = (
  side: string,
  count = current[side === 'away' ? 'away' : 'home'].length,
  collisionNames = false
): Array<{
  userId: string
  gumboId: number
  shortName: string
  jersey: string
  positions: string[]
  isPlayer: boolean
  role: string
  section: string
  staffRoles: string[]
  inheritedFrom: null
  bats: string
  throws: string
}> =>
  Array.from({ length: count }, (_, i) => ({
    userId: current[side === 'away' ? 'awayUsers' : 'homeUsers'][i],
    gumboId: current[side === 'away' ? 'away' : 'home'][i],
    shortName:
      collisionNames && side === 'home' && i < 2
        ? ['Luis G', 'Luis G'][i]
        : shortName({ id: i, displayName: names[i] }),
    jersey: collisionNames && side === 'home' && i < 2 ? '' : String(i + 1),
    positions: [POSITIONS[i % 9]],
    isPlayer: true,
    role: 'member',
    section: 'player',
    staffRoles: [],
    inheritedFrom: null,
    bats: 'right',
    throws: 'right'
  }))
const person = (
  row: ReturnType<typeof roster>[0]
): { gumboId: number; name: string; jersey: string } => ({
  gumboId: row.gumboId,
  name: row.shortName,
  jersey: row.jersey
})
interface Fixture {
  animationsOff?: boolean
  collisionNames?: boolean
  noDefault?: boolean
  awayRoster?: number
  missing?: Position[]
  homeRoster?: number
  awayCount?: number
  homeCount?: number
  nextMissing?: Position[]
  height?: number
}
function defaultLineups(fixture: Fixture): DefaultLineups {
  if (fixture.noDefault === true) return {}
  return Object.fromEntries(
    ['away', 'home'].map(side => {
      const rows = roster(
        side,
        side === 'home'
          ? (fixture.homeRoster ?? 10)
          : (fixture.awayRoster ?? 10),
        fixture.collisionNames
      )
      const count =
        side === 'away' ? (fixture.awayCount ?? 9) : (fixture.homeCount ?? 9)
      const missing =
        side === 'home' ? (fixture.missing ?? []) : (fixture.nextMissing ?? [])
      return [
        side,
        {
          batters: rows.slice(0, count).map(person),
          defense: Object.fromEntries(
            POSITIONS.map((slot, i) => [
              slot,
              missing.includes(slot) || rows[i] == null ? null : person(rows[i])
            ])
          )
        }
      ]
    })
  )
}
type Session = any
interface Rect {
  x: number
  y: number
  width: number
  height: number
}
// DOM probes read the page through maestro-d's evalBrowserScript, and every
// press goes through its browser driver; the stack's API holds the game.
class Page {
  constructor(
    readonly driver: Session,
    private readonly url: string,
    private readonly dispose: () => Promise<void>
  ) {}

  async evaluate<A extends unknown[], T>(
    fn: (...args: A) => T,
    ...args: A
  ): Promise<T> {
    await this.driver.evalBrowserScript({
      script: `return JSON.stringify(await (${fn.toString()})(...${JSON.stringify(args)}))`,
      output: 'probe'
    })
    return JSON.parse((await this.driver.vars()).probe) as T
  }

  async $eval<T>(selector: string, fn: (node: HTMLElement) => T): Promise<T> {
    await this.driver.evalBrowserScript({
      script: `const node=document.querySelector(${JSON.stringify(selector)});if(node==null)throw Error('Missing probe element');return JSON.stringify(await (${fn.toString()})(node))`,
      output: 'probe'
    })
    return JSON.parse((await this.driver.vars()).probe) as T
  }

  async $$eval<T>(
    selector: string,
    fn: (nodes: HTMLElement[]) => T
  ): Promise<T> {
    await this.driver.evalBrowserScript({
      script: `return JSON.stringify(await (${fn.toString()})([...document.querySelectorAll(${JSON.stringify(selector)})]))`,
      output: 'probe'
    })
    return JSON.parse((await this.driver.vars()).probe) as T
  }

  async $(selector: string): Promise<ElementProbe | null> {
    return (await this.evaluate(
      s => document.querySelector(s) != null,
      selector
    ))
      ? new ElementProbe(this, selector)
      : null
  }

  async $$(selector: string): Promise<ElementProbe[]> {
    const count = await this.evaluate(
      s => document.querySelectorAll(s).length,
      selector
    )
    return Array.from({ length: count }, () => new ElementProbe(this, selector))
  }

  async waitForSelector(
    css: string,
    options: { timeout?: number } = {}
  ): Promise<void> {
    await this.driver.assertVisible({ css, timeout: options.timeout ?? 10000 })
  }

  async waitForFunction<A extends unknown[]>(
    fn: (...args: A) => boolean,
    options: { timeout?: number } = {},
    ...args: A
  ): Promise<void> {
    const until = Date.now() + (options.timeout ?? 10000)
    do {
      if (await this.evaluate(fn, ...args)) return
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < until)
    throw new Error(`Browser condition timed out: ${fn.toString()}`)
  }

  locator(css: string): { click: () => Promise<void> } {
    return {
      click: async () => {
        await this.driver.tapOn({ css, timeout: 10000 })
      }
    }
  }

  readonly mouse = {
    click: async (x: number, y: number): Promise<void> => {
      await this.driver.tapOnPoint({ x, y })
    }
  }

  async screenshot(options: { path: string }): Promise<void> {
    await this.driver.waitForAnimationToEnd({ timeout: 3000 })
    await writeFile(options.path, await this.driver.screenshot())
  }

  async reload(_options?: { waitUntil: string }): Promise<void> {
    await this.driver.openBrowser({ url: this.url })
  }

  async close(): Promise<void> {
    try {
      await this.driver.evalBrowserScript({
        script: 'return JSON.stringify(window.__defensiveErrors ?? [])',
        output: 'pageErrors'
      })
      expect(JSON.parse((await this.driver.vars()).pageErrors)).deep.equals([])
    } finally {
      await this.dispose()
    }
  }
}
class ElementProbe {
  constructor(
    private readonly page: Page,
    private readonly selector: string
  ) {}

  async boundingBox(): Promise<Rect> {
    return await this.page.$eval(this.selector, node => {
      const r = node.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
  }
}
interface Opened {
  page: Page
  /** The API's answers of 500 and above to this page: none is expected. */
  unexpected: string[]
  peer: (actions: ScoringAction[]) => Promise<ScoringSession['state']>
  /** A player another device created on `side`, as the API keeps him. */
  created: (
    side: 'away' | 'home',
    body: { firstName: string; lastName: string; jersey: string }
  ) => Promise<RosterEntry>
  savedPlays: () => Promise<number>
  saves: string[]
}

/**
 * A fresh game shaped as `fixture` says, open on the scoring screen of the
 * world's scorer.
 */
async function open(fixture: Fixture = {}): Promise<Opened> {
  const world = await ctx.fixture('defensive-setup')
  const ids = world.ids
  current.away = ids.away.split(',').map(Number)
  current.home = ids.home.split(',').map(Number)
  current.awayUsers = ids.awayUsers.split(',')
  current.homeUsers = ids.homeUsers.split(',')
  const teamOf = { away: ids.awayTeam, home: ids.homeTeam }
  // The rosters: fewer players where the fixture asks, by taking the last
  // ones off.
  for (const side of ['away', 'home'] as const) {
    const count = side === 'home' ? fixture.homeRoster : fixture.awayRoster
    if (count == null || count >= 10) continue
    const users = current[side === 'away' ? 'awayUsers' : 'homeUsers']
    await stackSql(
      ctx,
      'delete from memberships where team_id = $1 and user_id = any($2)',
      [teamOf[side], users.slice(count)]
    )
    current[side] = current[side].slice(0, count)
    current[side === 'away' ? 'awayUsers' : 'homeUsers'] = users.slice(0, count)
  }
  // Two home players the server names alike, with no jersey.
  if (fixture.collisionNames === true) {
    for (const [i, last] of ['Garcia', 'Gonzalez'].entries()) {
      await stackSql(
        ctx,
        "update users set display_name = $2, first_name = 'Luis', last_name = $3 where id = $1",
        [current.homeUsers[i], `Luis ${last}`, last]
      )
      await stackSql(
        ctx,
        'update memberships set jersey = null where team_id = $1 and user_id = $2',
        [teamOf.home, current.homeUsers[i]]
      )
    }
  }
  // Each team's default lineup, as the server keeps it: who bats and who
  // fields where, by gumbo id.
  const defaults = defaultLineups(fixture)
  for (const side of ['away', 'home'] as const) {
    const lineup = defaults[side]
    const value =
      lineup == null
        ? null
        : {
            lineup: {
              batters: lineup.batters.map(({ gumboId, jersey }) => ({
                gumboId,
                jersey
              })),
              defense: Object.fromEntries(
                Object.entries(lineup.defense).map(([slot, held]) => [
                  slot,
                  held == null
                    ? null
                    : { gumboId: held.gumboId, jersey: held.jersey }
                ])
              )
            },
            fromGameId: null,
            setAt: new Date().toISOString()
          }
    await stackSql(
      ctx,
      'update teams set default_lineup = $2::jsonb where id = $1',
      [teamOf[side], value == null ? null : JSON.stringify(value)]
    )
  }
  await clearSignInLimits(ctx)
  const { signInTestAccount } =
    await import('../../../../src/test/passwordFixtures')
  const baseUrl = `${ctx.stack.origin}/api/v1`
  const api = new TeamStationClient({
    baseUrl,
    token: await signInTestAccount(baseUrl, world.accounts.scorer)
  })
  const saves: string[] = []
  const unexpected: string[] = []
  const gameId = ids.game
  const peer = async (
    actions: ScoringAction[]
  ): Promise<ScoringSession['state']> => {
    const detail = await api.game(gameId)
    const [away, home] = await Promise.all([
      api.roster(detail.awayTeamId),
      api.roster(detail.homeTeamId)
    ])
    const other = await ScoringSession.open(
      {
        load: async id => await api.gameEvents(id),
        save: async (id, change, handoff) => {
          const kept = await api.saveGameEvents(id, change, handoff)
          saves.push(`peer: ${actions.map(action => action.type).join(',')}`)
          return kept
        }
      },
      gameId,
      {
        gamePk: gameId,
        teams: teamsOf(detail),
        setup: startingSetup(detail, away, home, defaults, false)
      },
      { requireCurrentSetup: true }
    )
    for (const action of actions)
      expect(other.apply(action).problems).deep.equals([])
    await other.flush()
    return other.state
  }
  // Before any page script: the scorer's preferences, and every page error
  // kept for `close` to check.
  const preferences =
    fixture.animationsOff === true
      ? `localStorage.setItem(${JSON.stringify(`teamstation:scoring:${ids.scorerGumbo}:switch-hitter`)},${JSON.stringify(JSON.stringify({ help: false, shown: 0, animations: false }))});`
      : ''
  const session = await ctx.browser(
    { width: 390, height: fixture.height ?? 844 },
    {
      observeNetwork: true,
      beforeLoad: `${preferences}window.__defensiveErrors=[];addEventListener('error',e=>{if(e.message)__defensiveErrors.push(e.message)});addEventListener('unhandledrejection',e=>__defensiveErrors.push(String(e.reason)));`
    }
  )
  session.page.on('response', (response: HTTPResponse) => {
    const url = new URL(response.url())
    if (!url.pathname.startsWith('/api/')) return
    if (response.status() >= 500)
      unexpected.push(`${response.request().method()} ${url.pathname}`)
    if (
      response.request().method() === 'POST' &&
      url.pathname.endsWith('/events')
    )
      saves.push(`page: ${response.status()}`)
  })
  const url = `${ctx.stack.origin}/games/${gameId}/score`
  const page = new Page(session.m, url, async () => {
    await session.close()
  })
  try {
    await page.driver.openLink({ link: `${ctx.stack.origin}/` })
    await ctx.signIn('scorer', page.driver)
    await page.driver.openLink({ link: url })
    await page.waitForSelector('canvas[data-field-ready="true"]', {
      timeout: 30000
    })
    return {
      page,
      unexpected,
      peer,
      created: async (side, body) =>
        // As the app's Create Player sends him: no positions, bats right.
        await api.createRosterPlayer(teamOf[side], {
          ...body,
          positions: [],
          bats: 'right',
          throws: 'right'
        }),
      savedPlays: async () => (await api.gameEvents(gameId)).plays.length,
      saves
    }
  } catch (error) {
    await page.close().catch(() => undefined)
    throw error
  }
}

async function click(page: Page, label: string): Promise<void> {
  const selector = `[aria-label="${label}"]:not([aria-disabled="true"]):not(:disabled)`
  const opening =
    label === 'Create Player' &&
    (await page.$('[aria-label="First Name"]')) == null
  await page.waitForSelector(selector)
  // Where it comes to rest: a sheet slides up into place, and a tap at its
  // first position lands below the screen.
  const centre = async (): Promise<{ x: number; y: number }> =>
    await page.evaluate(s => {
      const nodes = document.querySelectorAll(s)
      const box = nodes[nodes.length - 1].getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }, selector)
  let point = await centre()
  for (let tries = 0; tries < 30; tries++) {
    await new Promise(resolve => setTimeout(resolve, 100))
    const next = await centre()
    const settled = next.x === point.x && next.y === point.y
    point = next
    if (settled) break
  }
  // Then into view, as a scorer scrolls a short sheet to it; and of the
  // copies a sheet kept mounted under another may hold, the one a tap there
  // reaches.
  point = await page.evaluate(s => {
    const nodes = [...document.querySelectorAll(s)]
    nodes[nodes.length - 1].scrollIntoView({
      block: 'nearest',
      behavior: 'instant'
    })
    const centre = (node: Element): { x: number; y: number } => {
      const box = node.getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    const reached = nodes.filter(node => {
      const { x, y } = centre(node)
      const hit = document.elementFromPoint(x, y)
      return hit !== null && (hit === node || node.contains(hit))
    })
    return centre(
      reached.length > 0 ? reached[reached.length - 1] : nodes[nodes.length - 1]
    )
  }, selector)
  await page.mouse.click(point.x, point.y)
  if (opening) await page.waitForSelector('[aria-label="First Name"]')
}

/** Clicks the defensive roster card of this player, whatever it reads. */
async function clickPlayer(page: Page, id: number): Promise<void> {
  const selector = `[data-testid="Defensive player ${id}"]:not([aria-disabled="true"])`
  await page.waitForSelector(selector)
  const point = await page.evaluate(s => {
    const box = document.querySelector(s)!.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }, selector)
  await page.mouse.click(point.x, point.y)
}

async function text(page: Page): Promise<string> {
  return await page.evaluate(() => document.body.innerText)
}
async function picture(page: Page, name: string): Promise<void> {
  // React Native Web slides its modal after layout; capture the painted state.
  await new Promise(resolve => setTimeout(resolve, 650))
  await page.screenshot({ path: ctx.artifact(`${name}-after.png`) })
}
async function tapField(page: Page, slot: Position): Promise<void> {
  const rect = await page.$eval('canvas', canvas => {
    const r = canvas.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  const empty = await page.$(`[data-nameplate="empty-${slot}"]`)
  if (empty != null) {
    // Nameplate overlays pass pointers through to the actual canvas.
    const box = await empty.boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  } else {
    const player = createPlayers().find(p => p.id === slot)!
    const camera = new PerspectiveCamera()
    applyFieldCamera(camera, {
      width: rect.width,
      height: rect.height,
      view: 'home',
      zoom: 1.25,
      tilt: (-11 * Math.PI) / 180,
      heightOffset: 33,
      bottomExtension: 112
    })
    const v = new Vector3(player.position.x, 5, player.position.z).project(
      camera
    )
    await page.mouse.click(
      rect.x + ((v.x + 1) * rect.width) / 2,
      rect.y + ((1 - v.y) * rect.height) / 2
    )
  }
}
async function tapSlot(page: Page, slot: Position): Promise<void> {
  await tapField(page, slot)
  await page.waitForSelector('[role="dialog"] [aria-label="Defensive roster"]')
  await page.waitForFunction(() => {
    const node = document.querySelector('[aria-label="Defensive roster"]')
    if (node == null) return false
    const box = node.getBoundingClientRect()
    return box.y >= 0 && box.bottom <= window.innerHeight
  })
}
async function choose(
  page: Page,
  position: Position,
  index: number
): Promise<void> {
  const parts = names[index].split(' ')
  await click(
    page,
    `Assign ${position} #${index + 1} ${parts[0]} ${parts.at(-1)![0]}`
  )
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Defensive roster"]') == null
  )
  await page.waitForFunction(
    slot => document.querySelector(`[data-nameplate="empty-${slot}"]`) == null,
    {},
    position
  )
}

export default defineHarness({
  id: 'scoring/defensive-setup/current-setup',
  title:
    'The scoring screen sets up the current defence and lineup before a pitch',
  kind: 'e2e',
  covers: [
    'src/app/scoring/**',
    'src/app/field/**',
    'src/common/scoring/session.ts'
  ],
  stack: 'isolated',
  fixtures: ['defensive-setup'],
  exclusive: false,
  surfaces: {
    // The scoring screen draws in 3D: the Mac's Chrome, with its GPU.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['gpu'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 40,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    // E1 assigns all nine visible squares and updates then dismisses the missing defense warning.
    'missing-defense-squares': async scenario => {
      begin(scenario)
      const { page, unexpected } = await open({ missing: [...POSITIONS] })
      try {
        await page.waitForSelector('[data-nameplate="empty-P"]')
        await picture(page, 'missing-defense')
        expect(
          await page.$eval('[aria-label="Ball"]', el =>
            el.getAttribute('aria-disabled')
          )
        ).equals('true')
        const boxes = await page.$$eval('[data-nameplate^="empty-"]', nodes =>
          nodes.map(node => {
            const r = node.getBoundingClientRect()
            const css = getComputedStyle(node)
            return {
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              border: css.borderStyle,
              text: node.textContent
            }
          })
        )
        expect(boxes).has.length(9)
        for (const box of boxes) {
          expect(box.width).equals(48)
          expect(box.height).equals(48)
          expect(box.x).at.least(0)
          expect(box.x + box.width).at.most(390)
          expect(box.y).at.least(0)
          expect(box.border).equals('dashed')
        }
        for (const [index, slot] of POSITIONS.entries()) {
          await tapSlot(page, slot)
          await choose(page, slot, index)
          await page.waitForFunction(
            s =>
              document.querySelector(`[data-nameplate="empty-${s}"]`) == null,
            {},
            slot
          )
          // Only a pitcher is waited for: the rest may stay empty.
          expect(await text(page)).not.includes('Assign a pitcher')
        }
        expect(await text(page)).not.includes('Assign a pitcher')
        await picture(page, 'complete-defense')
        await click(page, 'Ball')
        await page.waitForSelector('[aria-label*="1 balls"]')
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    },
    // E2 replaces assigned P with C and saves the vacated position, bench fill and Undo.
    'replace-pitcher': async scenario => {
      begin(scenario)
      const { page, unexpected } = await open()
      try {
        await tapSlot(page, 'P')
        await picture(page, 'defensive-roster')
        expect(await page.$$('[aria-label^="Assign P "]')).has.length(10)
        await choose(page, 'P', 1)
        await page.waitForSelector('[data-nameplate="empty-C"]')
        // A stand-in plays the vacated catcher's spot: scoring goes on.
        expect(await text(page)).not.includes('Assign a pitcher')
        await picture(page, 'remaining-defense')
        await tapSlot(page, 'C')
        await choose(page, 'C', 9)
        await new Promise(resolve => setTimeout(resolve, 150))
        await page.reload()
        await page.waitForSelector('canvas[data-field-ready="true"]')
        expect(await page.$('[data-nameplate="empty-C"]')).equals(null)
        await page.waitForFunction(
          name => document.body.innerText.includes(name),
          {},
          roster('home')[9].shortName
        )
        await tapSlot(page, 'C')
        await choose(page, 'C', 0)
        await click(page, 'Undo Set team roster')
        await page.waitForFunction(
          name => document.body.innerText.includes(name),
          {},
          roster('home')[9].shortName
        )
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    },
    // E3 creates quantity placeholders from the roster, keeps two columns and the footer visible at 844px.
    'placeholders-844': async scenario => {
      begin(scenario)
      const height: number = 844
      const { page, unexpected } = await open({
        missing: [...POSITIONS],
        homeRoster: 8,
        height
      })
      try {
        await tapSlot(page, 'P')
        await picture(
          page,
          height === 844
            ? 'empty-position-roster'
            : 'empty-position-roster-short'
        )
        const layout = await page.$$eval('[aria-label^="Assign P "]', nodes =>
          nodes.slice(0, 4).map(node => {
            const r = node.getBoundingClientRect()
            return { x: r.x, y: r.y, width: r.width, height: r.height }
          })
        )
        expect(layout[0].y).equals(layout[1].y)
        expect(layout[0].x).lessThan(layout[1].x)
        const sheet = (await page.$('[data-testid="Scoring sheet"]'))!
        expect((await sheet.boundingBox()).height).closeTo((height * 2) / 3, 2)
        await click(page, 'Create Player')
        await click(page, 'Create Placeholder Player')
        await page.waitForSelector(
          '[aria-label="Number of placeholder players"]'
        )
        if (height === 844) await picture(page, 'placeholder-picker')
        await click(page, 'Player count 2')
        await page.waitForSelector(
          '[aria-label="Player count 2"][aria-selected="true"]'
        )
        await click(page, 'Create')
        await page.waitForFunction(
          () =>
            document.querySelectorAll('[aria-label^="Assign P "]').length === 10
        )
        expect(await page.$('[aria-label="Create Player"]')).not.equals(null)
        await page.driver.scrollUntilVisible({
          element: { css: '[aria-label="Assign P HAWKS A"]' },
          direction: 'DOWN'
        })
        await click(page, 'Assign P HAWKS A')
        await page.waitForFunction(
          () => document.querySelector('[data-nameplate="empty-P"]') == null
        )
        await page.waitForSelector('[data-nameplate="empty-C"]')
        await tapSlot(page, 'P')
        expect(await page.$('[aria-label="Create Player"]')).not.equals(null)
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    },
    // E3 creates quantity placeholders from the roster, keeps two columns and the footer visible at 520px.
    'placeholders-520': async scenario => {
      begin(scenario)
      const height: number = 520
      const { page, unexpected } = await open({
        missing: [...POSITIONS],
        homeRoster: 8,
        height
      })
      try {
        await tapSlot(page, 'P')
        await picture(
          page,
          height === 844
            ? 'empty-position-roster'
            : 'empty-position-roster-short'
        )
        const layout = await page.$$eval('[aria-label^="Assign P "]', nodes =>
          nodes.slice(0, 4).map(node => {
            const r = node.getBoundingClientRect()
            return { x: r.x, y: r.y, width: r.width, height: r.height }
          })
        )
        expect(layout[0].y).equals(layout[1].y)
        expect(layout[0].x).lessThan(layout[1].x)
        const sheet = (await page.$('[data-testid="Scoring sheet"]'))!
        expect((await sheet.boundingBox()).height).closeTo((height * 2) / 3, 2)
        await click(page, 'Create Player')
        await click(page, 'Create Placeholder Player')
        await page.waitForSelector(
          '[aria-label="Number of placeholder players"]'
        )
        if (height === 844) await picture(page, 'placeholder-picker')
        await click(page, 'Player count 2')
        await page.waitForSelector(
          '[aria-label="Player count 2"][aria-selected="true"]'
        )
        await click(page, 'Create')
        await page.waitForFunction(
          () =>
            document.querySelectorAll('[aria-label^="Assign P "]').length === 10
        )
        expect(await page.$('[aria-label="Create Player"]')).not.equals(null)
        await page.driver.scrollUntilVisible({
          element: { css: '[aria-label="Assign P HAWKS A"]' },
          direction: 'DOWN'
        })
        await click(page, 'Assign P HAWKS A')
        await page.waitForFunction(
          () => document.querySelector('[data-nameplate="empty-P"]') == null
        )
        await page.waitForSelector('[data-nameplate="empty-C"]')
        await tapSlot(page, 'P')
        expect(await page.$('[aria-label="Create Player"]')).not.equals(null)
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    },
    // E4 shows exact zero/eight warnings, targets the current batting lineup and accepts partial only.
    'lineup-warnings': async scenario => {
      begin(scenario)
      for (const count of [0, 1, 8, 9]) {
        const { page, unexpected } = await open({ awayCount: count })
        try {
          if (count === 9)
            expect(await text(page)).not.includes(
              'Insufficient batting lineup.'
            )
          else {
            expect(
              await page.$eval('[aria-label="Ball"]', el =>
                el.getAttribute('aria-disabled')
              )
            ).equals('true')
            expect(await text(page)).includes('Insufficient batting lineup.')
            expect(await text(page)).includes(
              count === 0
                ? 'No players in lineup'
                : count === 1
                  ? 'Only one player in lineup'
                  : 'Only eight players in lineup'
            )
            if (count === 0 || count === 8)
              await picture(
                page,
                count === 0 ? 'empty-lineup' : 'partial-lineup'
              )
            expect(await page.$('[aria-label="Accept Lineup"]')).to.satisfy(
              (node: unknown) => (count === 0 ? node === null : node != null)
            )
            await click(page, 'Set Lineup')
            await page.waitForSelector(
              '[aria-label="Away Team"][aria-selected="true"]'
            )
            expect(
              await page.$('[aria-label="Away Team"][aria-selected="true"]')
            ).not.equals(null)
            expect(
              await page.$('[aria-label="Lineup"][aria-selected="true"]')
            ).not.equals(null)
            if (count === 0) {
              await click(page, `Add ${roster('away')[0].shortName} to Lineup`)
              await click(page, 'Save Rosters')
              expect(await text(page)).includes('Only one player in lineup')
            } else await click(page, 'Cancel')
            await click(page, 'Accept Lineup')
            expect(await text(page)).not.includes(
              'Insufficient batting lineup.'
            )
            await click(page, 'Ball')
            await page.waitForSelector('[aria-label*="1 balls"]')
          }
          expect(unexpected).deep.equals([])
        } finally {
          await page.close()
        }
      }
    },
    // E5 evaluates only current half and routes newly current home lineup correctly.
    'current-half-only': async scenario => {
      begin(scenario)
      const { page, unexpected } = await open({
        homeCount: 8,
        nextMissing: ['P']
      })
      try {
        expect(await text(page)).not.includes('Assign a pitcher')
        expect(await text(page)).not.includes('Insufficient batting lineup.')
        await click(page, 'Open scoring menu')
        await click(page, 'End Half Inning')
        await click(page, 'Confirm End Half Inning')
        await page.waitForSelector('[data-nameplate="empty-P"]')
        expect(await text(page)).includes('Assign a pitcher')
        await tapSlot(page, 'P')
        await choose(page, 'P', 1)
        await page.waitForSelector('[aria-label="Set Lineup"]')
        expect(await text(page)).includes('Only eight players in lineup')
        await click(page, 'Set Lineup')
        await page.waitForSelector(
          '[aria-label="Home Team"][aria-selected="true"]'
        )
        expect(
          await page.$('[aria-label="Home Team"][aria-selected="true"]')
        ).not.equals(null)
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    },
    // E6 active-play defender picking keeps its scoring meaning.
    'active-play-defender': async scenario => {
      begin(scenario)
      const { page, unexpected } = await open()
      try {
        await click(page, 'Swing in Play')
        await click(page, 'Single')
        // In a play, a tapped defender takes the ball where he stands.
        const field = maestroDriver(page.driver)
        await tapFielder(field, 'SS')
        expect(await page.$('[aria-label="Defensive roster"]')).equals(null)
        await setTrajectory(field)
        await page.waitForSelector('[aria-label="Time to edit play"]', {
          timeout: 30000
        })
        await click(page, 'Finish at-bat')
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    },
    // E7 normal scoring entry keeps actual empty/eight-player rosters and offers placeholder creation.
    'empty-rosters': async scenario => {
      begin(scenario)
      for (const count of [0, 8]) {
        const { page, unexpected } = await open({
          noDefault: true,
          homeRoster: count
        })
        try {
          await page.waitForSelector('[data-nameplate="empty-RF"]')
          await tapSlot(page, 'RF')
          expect(await page.$$('[aria-label^="Assign RF "]')).has.length(count)
          expect(await page.$('[aria-label="Create Player"]')).not.equals(null)
          await click(page, 'Create Player')
          await click(page, 'Create Placeholder Player')
          await click(page, 'Player count 2')
          await click(page, 'Create')
          await page.waitForFunction(
            n =>
              document.querySelectorAll('[aria-label^="Assign RF "]').length ===
              n,
            {},
            count + 2
          )
          await click(page, 'Assign RF HAWKS A')
          await page.waitForFunction(
            () => document.querySelector('[data-nameplate="empty-RF"]') == null
          )
          await new Promise(resolve => setTimeout(resolve, 150))
          await page.reload()
          await page.waitForSelector('canvas[data-field-ready="true"]')
          await tapSlot(page, count === 0 ? 'P' : 'RF')
          expect(await page.$$('[aria-label^="Assign "]')).has.length.at.least(
            count + 2
          )
          expect(unexpected).deep.equals([])
        } finally {
          await page.close()
        }
      }
      const { page, unexpected } = await open({
        noDefault: true,
        awayRoster: 0,
        homeRoster: 9
      })
      try {
        expect(await text(page)).includes('No players in lineup')
        expect(await page.$('[aria-label="Accept Lineup"]')).equals(null)
        expect(
          await page.$eval('[aria-label="Ball"]', el =>
            el.getAttribute('aria-disabled')
          )
        ).equals('true')
        await click(page, 'Set Lineup')
        await page.waitForSelector(
          '[aria-label="Away Team"][aria-selected="true"]'
        )
        expect(
          await page.$('[aria-label="Away Team"][aria-selected="true"]')
        ).not.equals(null)
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    },
    // E8 cancels a scoring setup drag and still accepts a subsequent tap.
    'cancelled-drag': async scenario => {
      begin(scenario)
      const { page, unexpected } = await open({ missing: [...POSITIONS] })
      try {
        await page.waitForSelector('[data-nameplate="empty-P"]')
        const square = (await page.$('[data-nameplate="empty-P"]'))!
        await new Promise(resolve => setTimeout(resolve, 300))
        const box = await square.boundingBox()
        const x = box.x + box.width / 2
        const y = box.y + box.height / 2
        await page.driver.swipe({
          startX: x,
          startY: y,
          endX: x + 32,
          endY: y,
          duration: 500
        })
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(await page.$('[aria-label="Defensive roster"]')).equals(null)
        await tapSlot(page, 'P')
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    },
    // E9 preserves peer-saved pitches through warning and field roster mutations.
    'peer-pitches-kept': async scenario => {
      begin(scenario)
      for (const route of ['lineup', 'defender'] as const) {
        const { page, peer, unexpected, saves } = await open({ awayCount: 8 })
        try {
          if (route === 'defender') await tapSlot(page, 'P')
          await peer([
            { type: 'pitch', call: 'B' },
            { type: 'pitch', call: 'B' }
          ])
          if (route === 'lineup') {
            await click(page, 'Set Lineup')
            // Save Rosters lights for a change: the ninth batter.
            const add = `Add ${roster('away')[8].shortName} to Lineup`
            await click(page, add)
            // A clean editor is drawn again as the peer's pitches come in: a
            // tap as it is replaced lands on the one going, and the scorer taps
            // again.
            const nine = async (): Promise<boolean> =>
              await page
                .waitForFunction(
                  () =>
                    document.querySelectorAll(
                      '[data-roster-target^="lineup-"][data-roster-player]'
                    ).length === 9,
                  { timeout: 1500 }
                )
                .then(
                  () => true,
                  () => false
                )
            if (
              !(await nine()) &&
              (await page.$(`[aria-label="${add}"]`)) != null
            )
              await click(page, add)
            try {
              await click(page, 'Save Rosters')
            } catch (error) {
              // What the sheet showed, and every save, when it did not light.
              const sheet = await page.evaluate(() => ({
                save: [
                  ...document.querySelectorAll('[aria-label="Save Rosters"]')
                ].map(n => ({
                  disabled: n.getAttribute('aria-disabled'),
                  rect: (({ x, y, width, height }) => [x, y, width, height])(
                    n.getBoundingClientRect()
                  )
                })),
                lineup: [
                  ...document.querySelectorAll(
                    '[data-roster-target^="lineup-"]'
                  )
                ].map(n => n.textContent),
                alerts: [...document.querySelectorAll('[role="alert"]')].map(
                  n => n.textContent
                ),
                viewport: [innerWidth, innerHeight]
              }))
              throw new Error(
                `Save Rosters: ${JSON.stringify({ sheet, saves }, undefined, 1)}`,
                { cause: error }
              )
            }
          } else await choose(page, 'P', 1)
          await page.waitForSelector('[aria-label*="2 balls"]')
          await new Promise(resolve => setTimeout(resolve, 150))
          await page.reload({ waitUntil: 'domcontentloaded' })
          await page.waitForSelector('[aria-label*="2 balls"]')
          expect(unexpected).deep.equals([])
        } finally {
          await page.close()
        }
      }
      const { page, peer, unexpected, created, saves } = await open({
        homeRoster: 8
      })
      try {
        await tapSlot(page, 'RF')
        await click(page, 'Create Player')
        await click(page, 'Create Placeholder Player')
        await click(page, 'Player count 2')
        // The peer creates his player first: a game adds only a player who
        // exists (develop b9f65cb37).
        const julio = await created('home', {
          firstName: 'Julio',
          lastName: 'Rodriguez',
          jersey: '10'
        })
        const added = await peer([
          {
            type: 'lineup',
            kind: 'addPlayer',
            side: 'home',
            player: julio.gumboId!,
            name: 'Julio Rodriguez',
            jersey: '10'
          }
        ])
        await peer([
          {
            type: 'lineup',
            kind: 'position',
            side: 'home',
            position: 'RF',
            player: added.liveData.boxscore.teams.home.players.at(-1)!
          },
          { type: 'pitch', call: 'B' },
          { type: 'pitch', call: 'B' }
        ])
        await click(page, 'Create')
        await page.waitForSelector('[aria-label*="2 balls"]')
        // The eight on the roster, the two placeholders made here and the
        // peer's Julio Rodriguez.
        const choices = await page.$$eval('[aria-label^="Assign RF "]', nodes =>
          nodes.map(node => node.getAttribute('aria-label'))
        )
        expect(
          choices,
          JSON.stringify({ choices, saves }, undefined, 1)
        ).has.length(11)
        expect(await page.$('[aria-label="Create Player"]')).not.equals(null)
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    },
    // E10 closes the third strikeout before the next missing pitcher blocks another pitch.
    'third-strikeout-closes': async scenario => {
      begin(scenario)
      const { page, unexpected, savedPlays } = await open({
        nextMissing: ['P'],
        animationsOff: true
      })
      try {
        for (let i = 0; i < 9; i++) await click(page, 'Called Strike')
        await page.waitForSelector('[aria-label*="Bottom 1st"]')
        await page.waitForSelector('[data-nameplate="empty-P"]')
        expect(await text(page)).includes('Assign a pitcher')
        expect(
          await page.$eval('[aria-label="Ball"]', el =>
            el.getAttribute('aria-disabled')
          )
        ).equals('true')
        await page.waitForFunction(
          () => document.querySelector('[aria-label="Save status"]') == null
        )
        await new Promise(resolve => setTimeout(resolve, 150))
        expect(await savedPlays()).equals(3)
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.waitForSelector('[aria-label*="Bottom 1st"]')
        expect(await savedPlays()).equals(3)
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    },
    // E11 blocks completed-game entry and peer completion during player creation.
    'completed-game-blocks': async scenario => {
      begin(scenario)
      for (const opening of ['completed', 'peer completion']) {
        const { page, peer, unexpected } = await open()
        try {
          if (opening === 'peer completion') {
            await tapSlot(page, 'P')
            await click(page, 'Create Player')
            await page.driver.inputText({
              css: 'input[aria-label="First Name"]',
              text: 'Mookie'
            })
          }
          await peer([{ type: 'gameFlow', kind: 'endGame' }])
          if (opening === 'completed') await page.reload()
          else await click(page, 'Create Player')
          await page.waitForSelector('[aria-label="Game over"]')
          await tapField(page, 'P')
          expect(
            await page.$('[aria-label="Defensive roster"]'),
            `${opening}: the defensive roster after Game over`
          ).equals(null)
          expect(
            await page.$('[aria-label="First Name"]'),
            `${opening}: player entry after Game over`
          ).equals(null)
          expect(
            (await peer([])).liveData.boxscore.teams.home.players
          ).has.length(10)
          expect(unexpected).deep.equals([])
        } finally {
          await page.close()
        }
      }
    },
    // E12 repairs the current defense and lineup after reopening a saved third out.
    'reopened-third-out': async scenario => {
      begin(scenario)
      for (const problem of ['defense', 'empty lineup', 'partial lineup']) {
        const count = problem === 'empty lineup' ? 0 : 8
        const { page, peer, unexpected, savedPlays } = await open({
          animationsOff: true,
          ...(problem === 'defense'
            ? { nextMissing: ['P'] }
            : { homeCount: count })
        })
        try {
          // The peer saves the deciding pitch without a screen to close it.
          await peer(
            Array.from({ length: 9 }, () => ({ type: 'pitch', call: 'C' }))
          )
          await page.reload()
          await page.waitForSelector('[aria-label*="Bottom 1st"]')
          if (problem === 'defense') {
            await page.waitForSelector('[data-nameplate="empty-P"]')
            await tapSlot(page, 'P')
            await page.waitForSelector('[aria-label="Defensive roster"]')
            await click(page, 'Create Player')
            await click(page, 'Create Placeholder Player')
            await click(page, 'Create')
            await page.waitForSelector('[aria-label="Defensive roster"]')
            await choose(page, 'P', 1)
          } else {
            await page.waitForSelector('[aria-label="Set Lineup"]')
            await click(page, 'Set Lineup')
            await page.waitForSelector(
              '[aria-label="Home Team"][aria-selected="true"]'
            )
            for (const row of roster('home').slice(count, 9))
              await click(page, `Add ${row.shortName} to Lineup`)
            await click(page, 'Save Rosters')
          }
          await page.waitForFunction(() => {
            const button = document.querySelector('[aria-label="Ball"]')
            return (
              button != null && button.getAttribute('aria-disabled') !== 'true'
            )
          })
          await page.waitForFunction(
            () => document.querySelector('[aria-label="Save status"]') == null
          )
          const persisted = await peer([])
          expect(persisted.pending).equals(null)
          expect(persisted.liveData.linescore.isTopInning).equals(false)
          expect(await savedPlays()).equals(3)
          await page.reload()
          await page.waitForSelector('[aria-label*="Bottom 1st"]')
          expect(await text(page)).not.includes('Assign a pitcher')
          expect(await text(page)).not.includes('Insufficient batting lineup.')
          await click(page, 'Ball')
          await page.waitForSelector('[aria-label*="1 balls"]')
          expect(unexpected).deep.equals([])
        } finally {
          await page.close()
        }
      }
    },
    // E13 draws two server roster players who share a short name and a blank jersey the same, and assigns each by his own row.
    'shared-short-names': async scenario => {
      begin(scenario)
      const { page, peer, unexpected } = await open({
        collisionNames: true,
        missing: ['P', 'C']
      })
      try {
        await tapSlot(page, 'P')
        expect(await page.$$('[aria-label="Assign P Luis G"]')).length(2)
        expect(await text(page)).not.match(/Luis G[a-z]/)
        await clickPlayer(page, current.home[0])
        await page.waitForFunction(
          () => document.querySelector('[data-nameplate="empty-P"]') == null
        )
        await tapSlot(page, 'C')
        await clickPlayer(page, current.home[1])
        await page.waitForFunction(
          () => document.querySelector('[data-nameplate="empty-C"]') == null
        )
        await page.waitForFunction(
          () => document.querySelector('[aria-label="Save status"]') == null
        )
        const team = (await peer([])).liveData.boxscore.teams.home
        expect(team.defense.P).equals(current.home[0])
        expect(team.defense.C).equals(current.home[1])
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    }
  }
})
