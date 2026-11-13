import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { extname, join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { PerspectiveCamera, Vector3 } from 'three'

import {
  maestroDriver,
  setTrajectory,
  tapFielder
} from '../../../e2e/rigs/fieldPointer'
import { asGameDetail, asRosterEntry } from '../../common/api'
import { HttpError } from '../../common/errors'
import { shortName } from '../../common/names'
import type { ScoringAction } from '../../common/scoring/actions'
import { sameScoringMutation } from '../../common/scoring/scoringMutation'
import {
  type SaveChange,
  ScoringSession,
  type StoredGame
} from '../../common/scoring/session'
import { withNames } from '../../common/scoring/storedNames'
import { userIdOfGumbo } from '../../common/userId'
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
    userId: userIdOfGumbo((side === 'away' ? 100 : 200) + i),
    gumboId: (side === 'away' ? 100 : 200) + i,
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
  created: (
    side: 'away' | 'home',
    body: { firstName: string; lastName: string; jersey: string }
  ) => ReturnType<typeof rosterEntryFromBody>
  savedPlays: () => number
}> {
  const unexpected: string[] = []
  const held: StoredGame = { plays: [], currentPlay: null }
  // The players this page created, on its side's roster from then on, as
  // the API keeps them.
  const created: Record<
    'away' | 'home',
    Array<ReturnType<typeof rosterEntryFromBody>>
  > = {
    away: [],
    home: []
  }
  const sideRoster = (
    side: 'away' | 'home'
  ): Array<{ gumboId: number | null; shortName: string }> => [
    ...roster(
      side,
      side === 'home' ? (fixture.homeRoster ?? 10) : (fixture.awayRoster ?? 10),
      fixture.collisionNames
    ),
    ...created[side]
  ]
  /** The game as the API reads it back: every player named from his account. */
  const named = (): StoredGame => {
    const names = new Map<number, string>()
    for (const entry of [...sideRoster('away'), ...sideRoster('home')])
      if (entry.gumboId != null) names.set(entry.gumboId, entry.shortName)
    return {
      ...held,
      plays: held.plays.map(play => withNames(play, names)),
      currentPlay: withNames(held.currentPlay, names)
    }
  }
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
  // The server's arbitration (`postPlays.ts`): a save built on a scoring base
  // somebody else has moved on is refused as stale when it carries no scoring
  // of its own, and answered with what is held, superseded, when it does.
  const save = (
    change: Pick<
      SaveChange,
      'plays' | 'remove' | 'currentPlay' | 'scoringBase' | 'scoringMutation'
    >
  ): StoredGame => {
    const prior = held.scoringMutation
    if (
      change.scoringBase !== undefined &&
      !sameScoringMutation(change.scoringBase, prior)
    ) {
      if (change.scoringMutation == null)
        throw new HttpError(
          'conflict',
          'Somebody else changed the scoring since this lineup was read',
          { stale: true }
        )
      return {
        ...held,
        superseded: !sameScoringMutation(change.scoringMutation, prior)
      }
    }
    if (
      change.scoringMutation != null &&
      sameScoringMutation(change.scoringMutation, prior)
    )
      return { ...held, superseded: false }
    const kept = new Map(held.plays.map(play => [play.about.atBatIndex, play]))
    for (const index of change.remove ?? []) kept.delete(index)
    for (const play of change.plays ?? []) kept.set(play.about.atBatIndex, play)
    held.plays = [...kept.values()]
    if (change.currentPlay !== undefined) held.currentPlay = change.currentPlay
    if (change.scoringMutation != null)
      held.scoringMutation = change.scoringMutation
    return { ...held, superseded: false }
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
        const url = new URL(assetPath + u.search, base)
        if (url.origin !== new URL('/', base).origin) {
          response.statusCode = 404
          response.end()
          return
        }
        const upstream = await fetch(url)
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
        body = { id: userIdOfGumbo(999), displayName: 'Scorer', isAdmin: false }
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
      // A signed-in scorer's app asks for these on any screen; nothing in them.
      else if (u.pathname === '/api/v1/time') body = { now: Date.now() }
      else if (
        [
          '/api/v1/users',
          '/api/v1/live',
          '/api/v1/chat/conversations',
          '/api/v1/chat/blocks'
        ].includes(u.pathname)
      )
        body = []
      else if (u.pathname === '/api/v1/me/umpire-leagues')
        body = { leagues: [] }
      else if (u.pathname === '/api/v1/me/home')
        body = { teams: [], seasons: [], leagues: [] }
      else if (u.pathname === '/api/v1/me/account/chat-age')
        body = { confirmed: false, source: null, confirmedAt: null }
      else if (u.pathname === '/api/v1/games/g1') body = game
      // Nobody has planned the game, so no inning's end moves the defence.
      else if (u.pathname === '/api/v1/games/g1/plans')
        body = { away: null, home: null }
      else if (u.pathname.endsWith('/events')) {
        let superseded: boolean | undefined
        let refused: HttpError | undefined
        if (request.method === 'POST') {
          let bytes = ''
          for await (const chunk of request) bytes += String(chunk)
          try {
            superseded = save(
              JSON.parse(bytes === '' ? '{}' : bytes) as SaveChange
            ).superseded
          } catch (error) {
            if (!(error instanceof HttpError)) throw error
            refused = error
          }
        }
        const read = named()
        if (refused != null) {
          response.statusCode = refused.status
          body = refused.toApiError()
        } else
          body = {
            plays: read.plays.map(play => ({
              id: `evt_${play.about.atBatIndex}`,
              gameId: 'g1',
              gumbo: play
            })),
            currentPlay: read.currentPlay,
            ...(held.scoringMutation == null
              ? {}
              : { scoringMutation: held.scoringMutation }),
            ...(superseded == null ? {} : { superseded })
          }
      } else if (u.pathname.endsWith('/roster'))
        body = sideRoster(u.pathname.includes('/away/') ? 'away' : 'home')
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
        (u.pathname.endsWith('/roster-players') ||
          // Placeholders are made for this game only, as guests.
          u.pathname.endsWith('/guest-players'))
      ) {
        let bytes = ''
        for await (const chunk of request) bytes += String(chunk)
        const {
          side,
          teamId: _teamId,
          ...input
        } = JSON.parse(bytes === '' ? '{}' : bytes) as Record<string, unknown>
        const entry = rosterEntryFromBody(input)
        created[
          side === 'away' || u.pathname.includes('/teams/away/')
            ? 'away'
            : 'home'
        ].push(entry)
        body = entry
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
        extra: {
          browser: process.env.TS_CHROME_PATH ?? 'chrome',
          windowSize: `390x${fixture.height ?? 844}`
        }
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
      /** A player another device created on `side`, as the API keeps him. */
      created: (
        side: 'away' | 'home',
        body: { firstName: string; lastName: string; jersey: string }
      ) => {
        // As the app's Create Player sends him: no positions, bats right.
        const entry = rosterEntryFromBody({
          ...body,
          positions: [],
          bats: 'right',
          throws: 'right'
        })
        created[side].push(entry)
        return entry
      },
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
  })
  it('E2 replaces assigned P with C and saves the vacated position, bench fill and Undo', async () => {
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
  })
  it('E6 active-play defender picking keeps its scoring meaning', async () => {
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
    const { page, peer, unexpected, created } = await open({ homeRoster: 8 })
    try {
      await tapSlot(page, 'RF')
      await click(page, 'Create Player')
      await click(page, 'Create Placeholder Player')
      await click(page, 'Player count 2')
      // The peer creates his player first: a game adds only a player who
      // exists (develop b9f65cb37).
      const julio = created('home', {
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
      expect(await page.$$('[aria-label^="Assign RF "]')).has.length(11)
      expect(await page.$('[aria-label="Create Player"]')).not.equals(null)
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('E10 closes the third strikeout before the next missing pitcher blocks another pitch', async () => {
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
  })
  it('E12 repairs the current defense and lineup after reopening a saved third out', async () => {
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
        expect(savedPlays()).equals(3)
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
  })
  it('E13 draws two server roster players who share a short name and a blank jersey the same, and assigns each by his own row', async () => {
    const { page, peer, unexpected } = await open({
      collisionNames: true,
      missing: ['P', 'C']
    })
    try {
      await tapSlot(page, 'P')
      expect(await page.$$('[aria-label="Assign P Luis G"]')).length(2)
      expect(await text(page)).not.match(/Luis G[a-z]/)
      await clickPlayer(page, 200)
      await page.waitForFunction(
        () => document.querySelector('[data-nameplate="empty-P"]') == null
      )
      await tapSlot(page, 'C')
      await clickPlayer(page, 201)
      await page.waitForFunction(
        () => document.querySelector('[data-nameplate="empty-C"]') == null
      )
      await page.waitForFunction(
        () => document.querySelector('[aria-label="Save status"]') == null
      )
      const team = (await peer([])).liveData.boxscore.teams.home
      expect(team.defense.P).equals(200)
      expect(team.defense.C).equals(201)
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
})
