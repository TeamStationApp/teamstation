import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import puppeteer, { type Browser, type Page } from 'puppeteer'
import { PerspectiveCamera, Vector3 } from 'three'

import { asGameDetail, asRosterEntry } from '../../common/api'
import type { ScoringAction } from '../../common/scoring/actions'
import { ScoringSession, type StoredGame } from '../../common/scoring/session'
import { applyFieldCamera } from '../field/cameraModel'
import { createPlayers } from '../field/fieldModel'
import {
  type DefaultLineups,
  startingSetup,
  teamsOf
} from './developmentSession'
import { type Position, POSITIONS } from './scoringTypes'

const base = process.env.TS_SCORING_TEST_URL ?? 'http://127.0.0.1:8088'
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
  videos: []
}
const roster = (
  side: string,
  count = 10
): Array<{
  userId: number
  shortName: string
  jersey: string
  positions: string[]
  isPlayer: boolean
  role: string
  bats: string
  throws: string
}> =>
  Array.from({ length: count }, (_, i) => ({
    userId: (side === 'away' ? 100 : 200) + i,
    shortName: names[i],
    jersey: String(i + 1),
    positions: [POSITIONS[i % 9]],
    isPlayer: true,
    role: 'member',
    bats: 'right',
    throws: 'right'
  }))
const person = (
  row: ReturnType<typeof roster>[0]
): { userId: number; name: string; jersey: string } => ({
  userId: row.userId,
  name: row.shortName,
  jersey: row.jersey
})
interface Fixture {
  animationsOff?: boolean
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
          : (fixture.awayRoster ?? 10)
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
let browser: Browser
async function open(fixture: Fixture = {}): Promise<{
  page: Page
  unexpected: string[]
  peer: (actions: ScoringAction[]) => Promise<ScoringSession['state']>
  savedPlays: () => number
}> {
  const page = await browser.newPage()
  const unexpected: string[] = []
  page.setDefaultTimeout(10000)
  page.setDefaultNavigationTimeout(30000)
  page.on('pageerror', error => unexpected.push(String(error)))
  // Desktop browser at a narrow CSS width: no device or mobile emulation.
  await page.setViewport({ width: 390, height: fixture.height ?? 844 })
  if (fixture.animationsOff === true)
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem(
        'teamstation:scoring:999:switch-hitter',
        JSON.stringify({ help: false, shown: 0, animations: false })
      )
    })
  const held: { plays: unknown[]; currentPlay: unknown } = {
    plays: [],
    currentPlay: null
  }
  const fixtureGame = asGameDetail(game)
  const context = {
    gamePk: 'g1',
    teams: teamsOf(fixtureGame),
    setup: startingSetup(
      fixtureGame,
      roster('away', fixture.awayRoster ?? 10).map(asRosterEntry),
      roster('home', fixture.homeRoster ?? 10).map(asRosterEntry),
      defaultLineups(fixture),
      false
    )
  }
  const peer = async (
    actions: ScoringAction[]
  ): Promise<ScoringSession['state']> => {
    const store = {
      load: async (): Promise<StoredGame> => held as StoredGame,
      save: async (
        _id: string,
        change: {
          plays: StoredGame['plays']
          remove: number[]
          currentPlay?: StoredGame['currentPlay']
        }
      ): Promise<StoredGame> => {
        const kept = new Map(
          (held.plays as StoredGame['plays']).map(play => [
            play.about.atBatIndex,
            play
          ])
        )
        for (const index of change.remove) kept.delete(index)
        for (const play of change.plays) kept.set(play.about.atBatIndex, play)
        held.plays = [...kept.values()]
        if (change.currentPlay !== undefined)
          held.currentPlay = change.currentPlay
        return held as StoredGame
      }
    }
    const other = await ScoringSession.open(store, 'g1', context, {
      requireCurrentSetup: true
    })
    for (const action of actions)
      expect(other.apply(action).problems).deep.equals([])
    await other.flush()
    return other.state
  }
  await page.setRequestInterception(true)
  page.on('request', request => {
    const u = new URL(request.url())
    // Test the app's documented font fallback without depending on remote font delivery.
    if (
      u.hostname === 'fonts.googleapis.com' ||
      u.hostname === 'fonts.gstatic.com'
    ) {
      request.abort().catch(() => undefined)
      return
    }
    if (!u.pathname.startsWith('/api/')) {
      request.continue().catch(() => undefined)
      return
    }
    const respond = async (): Promise<void> => {
      let body: unknown
      if (u.pathname.endsWith('/auth/me'))
        body = { id: 999, displayName: 'Scorer', isAdmin: false }
      else if (u.pathname === '/api/v1/me/roles')
        body = { teams: [], players: [] }
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
        if (request.method() === 'POST') {
          const posted = JSON.parse(
            (await request.fetchPostData()) ?? '{}'
          ) as {
            plays?: Array<{ about: { atBatIndex: number } }>
            currentPlay?: unknown
            remove?: number[]
          }
          const kept = new Map(
            (held.plays as Array<{ about: { atBatIndex: number } }>).map(
              play => [play.about.atBatIndex, play]
            )
          )
          for (const index of posted.remove ?? []) kept.delete(index)
          for (const play of posted.plays ?? [])
            kept.set(play.about.atBatIndex, play)
          held.plays = [...kept.values()]
          if (posted.currentPlay !== undefined)
            held.currentPlay = posted.currentPlay
        }
        body = {
          plays: (held.plays as Array<{ about: { atBatIndex: number } }>).map(
            play => ({
              id: `evt_${play.about.atBatIndex}`,
              gameId: 'g1',
              gumbo: play
            })
          ),
          currentPlay: held.currentPlay
        }
      } else if (u.pathname.endsWith('/roster'))
        body = roster(
          u.pathname.includes('/away/') ? 'away' : 'home',
          u.pathname.includes('/home/')
            ? (fixture.homeRoster ?? 10)
            : (fixture.awayRoster ?? 10)
        )
      else if (u.pathname.endsWith('/default-lineup')) {
        const side = u.pathname.includes('/away/') ? 'away' : 'home'
        const rows = roster(
          side,
          side === 'home' ? (fixture.homeRoster ?? 10) : 10
        )
        const count =
          side === 'away' ? (fixture.awayCount ?? 9) : (fixture.homeCount ?? 9)
        const missing =
          side === 'home'
            ? (fixture.missing ?? [])
            : (fixture.nextMissing ?? [])
        body =
          fixture.noDefault === true
            ? { lineup: null, fromGameId: null, setAt: null }
            : {
                lineup: {
                  batters: rows.slice(0, count).map(person),
                  defense: Object.fromEntries(
                    POSITIONS.map((p, i) => [
                      p,
                      missing.includes(p) || rows[i] == null
                        ? null
                        : person(rows[i])
                    ])
                  )
                },
                fromGameId: null,
                setAt: null
              }
      } else if (u.pathname === '/api/v1/teams') body = []
      else if (u.pathname.endsWith('/live-streams'))
        body = { gameId: 'g1', mine: [], others: [], canAdd: 0, maxCameras: 3 }
      else {
        unexpected.push(`${request.method()} ${u.pathname}`)
        body = []
      }
      await request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body)
      })
    }
    respond().catch((error: unknown) => unexpected.push(String(error)))
  })
  await page.goto(`${base}/games/g1/score`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('canvas[data-field-ready="true"]')
  return { page, unexpected, peer, savedPlays: () => held.plays.length }
}
async function click(page: Page, label: string): Promise<void> {
  await page.waitForSelector(`[aria-label="${label}"]`)
  await page.locator(`[aria-label="${label}"]`).click()
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
async function tapSlot(page: Page, slot: Position): Promise<void> {
  const rect = await page.$eval('canvas', canvas => {
    const r = canvas.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  const empty = await page.$(`[data-nameplate="empty-${slot}"]`)
  if (empty != null) {
    await page.locator(`[data-nameplate="empty-${slot}"]`).click()
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
    `Assign ${position} #${index + 1} ${parts[0][0]}${parts.at(-1)![0]}`
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
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.TS_CHROME_PATH,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader'
      ]
    })
  })
  after(async () => {
    await browser?.close()
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
        expect(box.width).equals(40)
        expect(box.height).equals(40)
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
      expect(await page.$$('[aria-label^="Assign P #"]')).has.length(10)
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
      await page.waitForFunction(() =>
        document.body.innerText.includes('Julio Rodriguez')
      )
      await tapSlot(page, 'C')
      await choose(page, 'C', 0)
      await click(page, 'Undo Set team roster')
      await page.waitForFunction(() =>
        document.body.innerText.includes('Julio Rodriguez')
      )
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  for (const height of [844, 520])
    it(`E3 creates quantity placeholders from only the empty roster, keeps two columns and field visible at ${height}px`, async () => {
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
        const layout = await page.$$eval('[aria-label^="Assign P #"]', nodes =>
          nodes.slice(0, 4).map(node => {
            const r = node.getBoundingClientRect()
            return { x: r.x, y: r.y, width: r.width, height: r.height }
          })
        )
        expect(layout[0].y).equals(layout[1].y)
        expect(layout[0].x).lessThan(layout[1].x)
        const list = (await page.$('[aria-label="Defensive roster"]'))!
        expect((await list.boundingBox())!.height).at.most(104)
        if (height < 650)
          expect(
            (await list.boundingBox())!.y + (await list.boundingBox())!.height
          ).lessThan(height * 0.35)
        else expect((await list.boundingBox())!.y).greaterThan(height / 2)
        await click(page, 'Create Placeholder Players')
        await page.waitForSelector(
          '[aria-label="Number of placeholder players"]'
        )
        if (height === 844) await picture(page, 'placeholder-picker')
        await click(page, 'Player count 2')
        await page.waitForSelector(
          '[aria-label="Player count 2"][aria-selected="true"]'
        )
        await click(page, 'Add')
        await page.waitForFunction(
          () =>
            document.querySelectorAll('[aria-label^="Assign P #"]').length ===
            10
        )
        expect(
          await page.$('[aria-label="Create Placeholder Players"]')
        ).equals(null)
        await list.evaluate(el => {
          el.scrollTop = el.scrollHeight
        })
        await click(page, 'Assign P #— HA')
        await page.waitForFunction(
          () => document.querySelector('[data-nameplate="empty-P"]') == null
        )
        await page.waitForSelector('[data-nameplate="empty-C"]')
        await tapSlot(page, 'P')
        expect(
          await page.$('[aria-label="Create Placeholder Players"]')
        ).equals(null)
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
            await page.$('[aria-label="Set Lineup"][aria-selected="true"]')
          ).not.equals(null)
          if (count === 0) {
            await click(page, 'Add Mookie Betts to Lineup')
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
        expect(await page.$$('[aria-label^="Assign RF #"]')).has.length(count)
        expect(
          await page.$('[aria-label="Create Placeholder Players"]')
        ).not.equals(null)
        await click(page, 'Create Placeholder Players')
        await click(page, 'Player count 2')
        await click(page, 'Add')
        await page.waitForFunction(
          n =>
            document.querySelectorAll('[aria-label^="Assign RF #"]').length ===
            n,
          {},
          count + 2
        )
        await click(page, 'Assign RF #— HA')
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
  it('E8 cancels an away-and-return setup drag and still accepts a subsequent tap', async () => {
    const { page, unexpected } = await open({ missing: [...POSITIONS] })
    try {
      await page.waitForSelector('[data-nameplate="empty-P"]')
      const square = (await page.$('[data-nameplate="empty-P"]'))!
      await new Promise(resolve => setTimeout(resolve, 300))
      const box = (await square.boundingBox())!
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 32, y)
      await page.mouse.move(x, y)
      await page.mouse.up()
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
      await click(page, 'Create Placeholder Players')
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
      await click(page, 'Add')
      await page.waitForSelector('[aria-label*="2 balls"]')
      expect(await page.$$('[aria-label^="Assign RF #"]')).has.length(9)
      expect(await page.$('[aria-label="Create Placeholder Players"]')).equals(
        null
      )
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
})
