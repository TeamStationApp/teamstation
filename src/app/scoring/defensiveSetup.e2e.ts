import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { extname, join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { PerspectiveCamera, Vector3 } from 'three'

import { asGameDetail, asRosterEntry } from '../../common/api'
import { shortName } from '../../common/names'
import type { ScoringAction } from '../../common/scoring/actions'
import { ScoringSession, type StoredGame } from '../../common/scoring/session'
import { rosterEntryFromBody } from '../../test/mintedRosterEntry'
import { applyFieldCamera } from '../field/cameraModel'
import { createPlayers } from '../field/fieldModel'
import {
  type DefaultLineups,
  startingSetup,
  teamsOf
} from './developmentSession'
import { type Position, POSITIONS } from './scoringTypes'

const base = process.env.TS_SCORING_TEST_URL
if (
  base == null ||
  !['127.0.0.1', 'localhost'].includes(new URL(base).hostname)
)
  throw new Error('TS_SCORING_TEST_URL must name a local app asset server.')
const artifacts = process.env.TS_SCORING_ARTIFACT_DIR
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
const game = {
  id: 'g1',
  awayTeamId: 'away',
  homeTeamId: 'home',
  awayTeamName: 'Owls',
  homeTeamName: 'Hawks',
  seasonId: null,
  startAt: null,
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'pending',
  ingestMessage: null,
  canScore: true,
  nonMemberView: false,
  videos: []
}
const roster = (
  side: string,
  count = 10,
  collisionNames = false
): Array<{
  userId: number
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
    userId: (side === 'away' ? 100 : 200) + i,
    gumboId: (side === 'away' ? 100 : 200) + i,
    shortName:
      collisionNames && side === 'home' && i < 2
        ? ['Luis Ga', 'Luis Gi'][i]
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
  gumboId: row.userId,
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
const requireClient =
  process.env.MAESTRO_D_CLIENT_ROOT == null
    ? createRequire(__filename)
    : createRequire(join(process.env.MAESTRO_D_CLIENT_ROOT, 'package.json'))
const { MaestroD } = requireClient('maestro-d')
let daemon: Awaited<ReturnType<typeof MaestroD.connect>>
let browserNumber = 0

type Session = Awaited<ReturnType<typeof daemon.attach>>
interface Rect {
  x: number
  y: number
  width: number
  height: number
}
// DOM probes read the page through Maestro. Input uses its browser driver,
// and the test server owns the synthetic API state and persistence fixtures.
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

  async focus(selector: string): Promise<void> {
    await this.driver.evalBrowserScript({
      script: `document.querySelector(${JSON.stringify(selector)}).focus();return true`
    })
  }

  readonly keyboard = {
    press: async (key: string): Promise<void> => {
      await this.driver.pressKey({ key: key.toUpperCase() })
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
      try {
        await this.driver.detach()
      } finally {
        await this.dispose()
      }
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
async function open(fixture: Fixture = {}): Promise<{
  page: Page
  unexpected: string[]
  peer: (actions: ScoringAction[]) => Promise<ScoringSession['state']>
  savedPlays: () => number
}> {
  const unexpected: string[] = []
  const held: StoredGame = { plays: [], currentPlay: null }
  const fixtureGame = asGameDetail(game)
  const context = {
    gamePk: 'g1',
    teams: teamsOf(fixtureGame),
    setup: startingSetup(
      fixtureGame,
      roster('away', fixture.awayRoster ?? 10, fixture.collisionNames).map(
        asRosterEntry
      ),
      roster('home', fixture.homeRoster ?? 10, fixture.collisionNames).map(
        asRosterEntry
      ),
      defaultLineups(fixture),
      false
    )
  }
  const save = (change: {
    plays?: StoredGame['plays']
    remove?: number[]
    currentPlay?: StoredGame['currentPlay']
  }): StoredGame => {
    const kept = new Map(held.plays.map(play => [play.about.atBatIndex, play]))
    for (const index of change.remove ?? []) kept.delete(index)
    for (const play of change.plays ?? []) kept.set(play.about.atBatIndex, play)
    held.plays = [...kept.values()]
    if (change.currentPlay !== undefined) held.currentPlay = change.currentPlay
    return held
  }
  const peer = async (
    actions: ScoringAction[]
  ): Promise<ScoringSession['state']> => {
    const other = await ScoringSession.open(
      {
        load: async () => held,
        save: async (_id, change) => save(change)
      },
      'g1',
      context,
      { requireCurrentSetup: true }
    )
    for (const action of actions)
      expect(other.apply(action).problems).deep.equals([])
    await other.flush()
    return other.state
  }
  const server = createServer((request, response) => {
    const respond = async (): Promise<void> => {
      const u = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (!u.pathname.startsWith('/api/')) {
        const assetPath = extname(u.pathname) === '' ? '/' : u.pathname
        const upstream = await fetch(new URL(assetPath + u.search, base))
        response.statusCode = upstream.status
        response.setHeader(
          'Content-Type',
          upstream.headers.get('content-type') ?? 'application/octet-stream'
        )
        if (
          upstream.headers.get('content-type')?.includes('text/html') === true
        ) {
          // Set browser preferences before the app starts and collect page errors.
          const preferences =
            fixture.animationsOff === true
              ? `localStorage.setItem('teamstation:scoring:999:switch-hitter',${JSON.stringify(JSON.stringify({ help: false, shown: 0, animations: false }))});`
              : ''
          response.end(
            (await upstream.text()).replace(
              '<head>',
              `<head><script>${preferences}window.__defensiveErrors=[];addEventListener('error',e=>{if(e.message)__defensiveErrors.push(e.message)});addEventListener('unhandledrejection',e=>__defensiveErrors.push(String(e.reason)));</script>`
            )
          )
        } else response.end(Buffer.from(await upstream.arrayBuffer()))
        return
      }
      let body: unknown
      if (u.pathname.endsWith('/auth/me'))
        body = { id: 999, displayName: 'Scorer', isAdmin: false }
      else if (u.pathname === '/api/v1/me/roles')
        body = { teams: [], players: [] }
      else if (u.pathname === '/api/v1/me/notifications/summary')
        body = { hasPending: false }
      else if (u.pathname === '/api/v1/health')
        body = {
          status: 'ok',
          version: '',
          database: 'ok',
          dictation: false,
          dictationModels: []
        }
      else if (u.pathname === '/api/v1/games/g1') body = game
      else if (u.pathname.endsWith('/events')) {
        if (request.method === 'POST') {
          let bytes = ''
          for await (const chunk of request) bytes += String(chunk)
          save(JSON.parse(bytes === '' ? '{}' : bytes))
        }
        body = {
          plays: held.plays.map(play => ({
            id: `evt_${play.about.atBatIndex}`,
            gameId: 'g1',
            gumbo: play
          })),
          currentPlay: held.currentPlay
        }
      } else if (u.pathname.endsWith('/roster'))
        body = roster(
          u.pathname.includes('/away/') ? 'away' : 'home',
          u.pathname.includes('/home/')
            ? (fixture.homeRoster ?? 10)
            : (fixture.awayRoster ?? 10),
          fixture.collisionNames
        )
      else if (u.pathname.endsWith('/default-lineup')) {
        const side = u.pathname.includes('/away/') ? 'away' : 'home'
        body =
          fixture.noDefault === true
            ? { lineup: null, fromGameId: null, setAt: null }
            : {
                lineup: defaultLineups(fixture)[side],
                fromGameId: null,
                setAt: null
              }
      } else if (u.pathname === '/api/v1/games/g1/lineups') {
        // Read as the roster sheet opens, for the digest it follows.
        const side = (teamId: string, teamName: string): unknown => ({
          teamId,
          teamName,
          start: null,
          changes: [],
          current: null
        })
        body = {
          away: side('away', game.awayTeamName),
          home: side('home', game.homeTeamName),
          digest: `d${held.plays.length}`
        }
      } else if (u.pathname === '/api/v1/teams') body = []
      else if (u.pathname.endsWith('/live-streams'))
        body = { gameId: 'g1', mine: [], others: [], canAdd: 0, maxCameras: 3 }
      else if (
        request.method === 'POST' &&
        u.pathname.endsWith('/roster-players')
      ) {
        let bytes = ''
        for await (const chunk of request) bytes += String(chunk)
        body = rosterEntryFromBody(JSON.parse(bytes === '' ? '{}' : bytes))
        response.statusCode = 201
      } else {
        unexpected.push(`${request.method} ${u.pathname}`)
        body = []
      }
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(body))
    }
    respond().catch((error: unknown) => {
      unexpected.push(String(error))
      response.statusCode = 500
      response.end('{}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address == null || typeof address === 'string')
    throw new Error('Fixture server did not start')
  const url = `http://127.0.0.1:${address.port}/games/g1/score`
  const dispose = async (): Promise<void> => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close(error => {
        error == null ? resolve() : reject(error)
      })
    )
  }
  let page: Page | undefined
  try {
    page = new Page(
      await daemon.attach({
        device: `defensive-setup-${++browserNumber}`,
        platform: 'web',
        appId: url,
        stepDelay: 300,
        artifacts: 'on-failure',
        extra: { browser: 'chrome', windowSize: `390x${fixture.height ?? 844}` }
      }),
      url,
      dispose
    )
    await page.driver.blockNetwork({
      patterns: ['*fonts.googleapis.com*', '*fonts.gstatic.com*']
    })
    await page.driver.openBrowser({ url })
    await page.waitForSelector('canvas[data-field-ready="true"]', {
      timeout: 30000
    })
    return {
      page,
      get unexpected() {
        return unexpected
      },
      peer,
      savedPlays: () => held.plays.length
    }
  } catch (error) {
    if (page != null) await page.close()
    else await dispose()
    throw error
  }
}
async function click(page: Page, label: string): Promise<void> {
  const selector = `[aria-label="${label}"]:not([aria-disabled="true"]):not(:disabled)`
  const opening =
    label === 'Create Player' &&
    (await page.$('[aria-label="First Name"]')) == null
  await page.waitForSelector(selector)
  const point = await page.evaluate(s => {
    const nodes = document.querySelectorAll(s)
    const box = nodes[nodes.length - 1].getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }, selector)
  await page.mouse.click(point.x, point.y)
  if (opening) await page.waitForSelector('[aria-label="First Name"]')
}

async function text(page: Page): Promise<string> {
  return await page.evaluate(() => document.body.innerText)
}
async function picture(page: Page, name: string): Promise<void> {
  if (artifacts != null) {
    // React Native Web slides its modal after layout; capture the painted state.
    await new Promise(resolve => setTimeout(resolve, 650))
    await page.screenshot({ path: join(artifacts, `${name}-after.png`) })
  }
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
describe('current defensive scoring setup browser', function () {
  this.timeout(120000)
  before(async () => {
    const name = process.env.MAESTRO_D
    if (name == null || name === '') throw new Error('MAESTRO_D is required')
    daemon = await MaestroD.connect({ name })
    if (artifacts != null) await mkdir(artifacts, { recursive: true })
  })
  after(() => {
    daemon?.close()
  })
  it('E1 assigns all nine visible squares and updates then dismisses the missing defense warning', async () => {
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
          s => document.querySelector(`[data-nameplate="empty-${s}"]`) == null,
          {},
          slot
        )
        if (index === 7) {
          expect(await text(page)).includes('Missing defensive positions\nRF')
        }
      }
      expect(await text(page)).not.includes('Missing defensive positions')
      await picture(page, 'complete-defense')
      await click(page, 'Ball')
      await page.waitForSelector('[aria-label*="1 balls"]')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('E2 replaces assigned P with C and saves the vacated position, bench fill and Undo', async () => {
    const { page, unexpected } = await open()
    try {
      await tapSlot(page, 'P')
      await picture(page, 'defensive-roster')
      expect(await page.$$('[aria-label^="Assign P "]')).has.length(10)
      await choose(page, 'P', 1)
      await page.waitForSelector('[data-nameplate="empty-C"]')
      expect(await text(page)).includes('Missing defensive positions\nC')
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
  })
  for (const height of [844, 520])
    it(`E3 creates quantity placeholders from the roster, keeps two columns and the footer visible at ${height}px`, async () => {
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
          element: { css: '[aria-label="Assign P Hawks A"]' },
          direction: 'DOWN'
        })
        await click(page, 'Assign P Hawks A')
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
    })
  it('E4 shows exact zero/eight warnings, targets the current batting lineup and accepts partial only', async () => {
    for (const count of [0, 1, 8, 9]) {
      const { page, unexpected } = await open({ awayCount: count })
      try {
        if (count === 9)
          expect(await text(page)).not.includes('Insufficient batting lineup.')
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
            await picture(page, count === 0 ? 'empty-lineup' : 'partial-lineup')
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
          expect(await text(page)).not.includes('Insufficient batting lineup.')
          await click(page, 'Ball')
          await page.waitForSelector('[aria-label*="1 balls"]')
        }
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    }
  })
  it('E5 evaluates only current half and routes newly current home lineup correctly', async () => {
    const { page, unexpected } = await open({
      homeCount: 8,
      nextMissing: ['C']
    })
    try {
      expect(await text(page)).not.includes('Missing defensive positions')
      expect(await text(page)).not.includes('Insufficient batting lineup.')
      await click(page, 'Open scoring menu')
      await click(page, 'End Half Inning')
      await click(page, 'Confirm End Half Inning')
      await page.waitForSelector('[data-nameplate="empty-C"]')
      expect(await text(page)).includes('Missing defensive positions\nC')
      await tapSlot(page, 'C')
      await choose(page, 'C', 1)
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
  })
  it('E6 active-play defender picking keeps its scoring meaning', async () => {
    const { page, unexpected } = await open()
    try {
      await click(page, 'Swing in Play')
      await click(page, 'Single')
      await page.focus('[role="application"]')
      await page.keyboard.press('Space')
      await page.keyboard.press('Enter')
      expect(await page.$('[aria-label="Defensive roster"]')).equals(null)
      await page.waitForSelector(
        '[aria-label^="Drag up and down for ball trajectory."]'
      )
      await page.keyboard.press('Enter')
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      await click(page, 'Finish at-bat')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('E7 normal scoring entry keeps actual empty/eight-player rosters and offers placeholder creation', async () => {
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
        await click(page, 'Assign RF Hawks A')
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
  })
  it('E8 cancels a scoring setup drag and still accepts a subsequent tap', async () => {
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
  })
  it('E9 preserves peer-saved pitches through warning and field roster mutations', async () => {
    for (const route of ['lineup', 'defender'] as const) {
      const { page, peer, unexpected } = await open({ awayCount: 8 })
      try {
        if (route === 'defender') await tapSlot(page, 'P')
        await peer([
          { type: 'pitch', call: 'B' },
          { type: 'pitch', call: 'B' }
        ])
        if (route === 'lineup') {
          await click(page, 'Set Lineup')
          // Save Rosters lights for a change: the ninth batter.
          await click(page, `Add ${roster('away')[8].shortName} to Lineup`)
          await click(page, 'Save Rosters')
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
    const { page, peer, unexpected } = await open({ homeRoster: 8 })
    try {
      await tapSlot(page, 'RF')
      await click(page, 'Create Player')
      await click(page, 'Create Placeholder Player')
      await click(page, 'Player count 2')
      const added = await peer([
        {
          type: 'lineup',
          kind: 'addPlayer',
          side: 'home',
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
      expect(await page.$$('[aria-label^="Assign RF "]')).has.length(11)
      expect(await page.$('[aria-label="Create Player"]')).not.equals(null)
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('E10 closes the third strikeout before the next incomplete defense blocks another pitch', async () => {
    const { page, unexpected, savedPlays } = await open({
      nextMissing: ['C'],
      animationsOff: true
    })
    try {
      for (let i = 0; i < 9; i++) await click(page, 'Called Strike')
      await page.waitForSelector('[aria-label*="Bottom 1st"]')
      await page.waitForSelector('[data-nameplate="empty-C"]')
      expect(await text(page)).includes('Missing defensive positions\nC')
      expect(
        await page.$eval('[aria-label="Ball"]', el =>
          el.getAttribute('aria-disabled')
        )
      ).equals('true')
      await page.waitForFunction(
        () => document.querySelector('[aria-label="Save status"]') == null
      )
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(savedPlays()).equals(3)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('[aria-label*="Bottom 1st"]')
      expect(savedPlays()).equals(3)
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('E11 blocks completed-game entry and peer completion during player creation', async () => {
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
        expect(await page.$('[aria-label="Defensive roster"]')).equals(null)
        expect(await page.$('[aria-label="First Name"]')).equals(null)
        expect(
          (await peer([])).liveData.boxscore.teams.home.players
        ).has.length(10)
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    }
  })
  it('E12 repairs the current defense and lineup after reopening a saved third out', async () => {
    for (const problem of ['defense', 'empty lineup', 'partial lineup']) {
      const count = problem === 'empty lineup' ? 0 : 8
      const { page, peer, unexpected, savedPlays } = await open({
        animationsOff: true,
        ...(problem === 'defense'
          ? { nextMissing: ['C'] }
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
          await page.waitForSelector('[data-nameplate="empty-C"]')
          await tapSlot(page, 'C')
          await page.waitForSelector('[aria-label="Defensive roster"]')
          await click(page, 'Create Player')
          await click(page, 'Create Placeholder Player')
          await click(page, 'Create')
          await page.waitForSelector('[aria-label="Defensive roster"]')
          await choose(page, 'C', 1)
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
        expect(savedPlays()).equals(3)
        await page.reload()
        await page.waitForSelector('[aria-label*="Bottom 1st"]')
        expect(await text(page)).not.includes('Missing defensive positions')
        expect(await text(page)).not.includes('Insufficient batting lineup.')
        await click(page, 'Ball')
        await page.waitForSelector('[aria-label*="1 balls"]')
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    }
  })
  it('E13 distinguishes server roster abbreviations with matching initials and blank jerseys', async () => {
    const { page, peer, unexpected } = await open({
      collisionNames: true,
      missing: ['P', 'C']
    })
    try {
      await tapSlot(page, 'P')
      expect(await page.$('[aria-label="Assign P Luis G"]')).equals(null)
      expect(await text(page)).includes('Luis Ga')
      expect(await text(page)).includes('Luis Gi')
      await click(page, 'Assign P Luis Ga')
      await page.waitForFunction(
        () => document.querySelector('[data-nameplate="empty-P"]') == null
      )
      await tapSlot(page, 'C')
      await click(page, 'Assign C Luis Gi')
      await page.waitForFunction(
        () => document.querySelector('[data-nameplate="empty-C"]') == null
      )
      await page.waitForFunction(
        () => document.querySelector('[aria-label="Save status"]') == null
      )
      const team = (await peer([])).liveData.boxscore.teams.home
      expect(team.defense.P).equals(team.players[0])
      expect(team.defense.C).equals(team.players[1])
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
})
