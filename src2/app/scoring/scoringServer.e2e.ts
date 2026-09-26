import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import puppeteer, {
  type Browser,
  type BrowserContext,
  type Page
} from 'puppeteer'

import type { GameDetail } from '../../common/api'
import { cleanAction, type ScoringAction } from '../../common/scoring/actions'
import { freshGame } from '../../common/scoring/rules'
import {
  applyAction,
  type EventStore,
  ScoringSession,
  type StoredGame
} from '../../common/scoring/session'
import type { GameSetup, GameState } from '../../common/scoring/state'
import { createDevelopmentSession, teamsOf } from './developmentSession'

/**
 * The scoring screen against the running API, with nothing intercepted: every
 * play it scores is posted to the server, read back, and checked in the
 * database.
 *
 *   GS_SCORER_PASSWORD=… GS_VIEWER_PASSWORD=… \
 *     node_modules/.bin/mocha -r sucrase/register --extension ts \
 *     --timeout 120000 src2/app/scoring/scoringServer.e2e.ts
 *
 * Needs the API (`npm start`), the web app built against it (`npm run
 * start.web`, `GS_API_BASE_URL` pointing at the API), a scorer made with
 * `npm run seed`, and `npm run scoring-game` for fresh games.
 */
const APP = process.env.GS_SCORING_TEST_URL ?? 'http://127.0.0.1:8080'
const API = process.env.GS_API_TEST_URL ?? 'http://127.0.0.1:9100/api/v1'
const DATABASE = process.env.GS_E2E_DATABASE ?? 'AppDb_scoringCore'
const SCORER = {
  email: process.env.GS_SCORER_EMAIL ?? 'scoring@gamestation.local',
  password: process.env.GS_SCORER_PASSWORD ?? ''
}
const VIEWER = {
  email: process.env.GS_VIEWER_EMAIL ?? 'viewer@gamestation.local',
  password: process.env.GS_VIEWER_PASSWORD ?? ''
}

interface Fixture {
  games: string[]
  away: number[]
  home: number[]
}
function scoringGame(games = 1): Fixture {
  const out = execFileSync(
    'npm',
    [
      'run',
      '--silent',
      'scoring-game',
      '--',
      VIEWER.email,
      VIEWER.password,
      '--games',
      String(games)
    ],
    { encoding: 'utf8' }
  )
  const value = (key: string): string[] =>
    out
      .split('\n')
      .filter(line => line.startsWith(`${key}=`))
      .map(line => line.slice(key.length + 1))
  return {
    games: value('GAME_ID'),
    away: value('AWAY')[0].split(',').map(Number),
    home: value('HOME')[0].split(',').map(Number)
  }
}
function sql(query: string): string {
  return execFileSync(
    'psql',
    ['-h', 'localhost', '-p', '5433', '-d', DATABASE, '-tAc', query],
    { encoding: 'utf8' }
  ).trim()
}
async function signIn(who: {
  email: string
  password: string
}): Promise<string> {
  const response = await fetch(`${API}/auth/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(who)
  })
  expect(response.status, `sign in ${who.email}`).equals(200)
  const cookie = response.headers.get('set-cookie') ?? ''
  const match = /gs_session=([^;]+)/.exec(cookie)
  if (match == null) throw new Error('No session cookie')
  return decodeURIComponent(match[1])
}
interface Stored {
  plays: Array<{ id: string; gumbo: Record<string, unknown> }>
  currentPlay: Record<string, unknown> | null
}
async function stored(token: string, gameId: string): Promise<Stored> {
  const response = await fetch(`${API}/games/${gameId}/events`, {
    headers: { cookie: `gs_session=${encodeURIComponent(token)}` }
  })
  return (await response.json()) as Stored
}

let browser: Browser
let scorer = ''
let viewer = ''

async function openAs(
  token: string,
  path: string,
  context?: BrowserContext
): Promise<Page> {
  const page = await (context ?? browser).newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => {
    console.error('Browser error:', error)
  })
  await page.setViewport({ width: 1200, height: 900 })
  await (context ?? browser.defaultBrowserContext()).setCookie({
    name: 'gs_session',
    value: encodeURIComponent(token),
    domain: '127.0.0.1',
    path: '/'
  })
  await page.goto(`${APP}${path}`)
  return page
}
async function click(page: Page, label: string): Promise<void> {
  const selector = `[aria-label="${label}"]`
  await page.waitForFunction(
    selector => {
      const node = document.querySelector(selector)
      return node != null && node.getAttribute('aria-disabled') !== 'true'
    },
    {},
    selector
  )
  await page.locator(selector).click()
}
async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const ball = document.querySelector('[aria-label="Ball"]')
      return ball != null && ball.getAttribute('aria-disabled') !== 'true'
    },
    { timeout: 30000 }
  )
}
/**
 * Every save has gone out and come back. The screen hands its log to the
 * session after it paints, so a quiet network comes first: until then the
 * status line can read saved for a play not yet sent.
 */
async function waitSaved(page: Page): Promise<void> {
  await page.waitForNetworkIdle({ idleTime: 300, timeout: 30000 })
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Save status"]') == null,
    { timeout: 30000 }
  )
}
async function summary(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const board = document.querySelector('[aria-label*=" balls "]')
    return board == null ? '' : String(board.getAttribute('aria-label'))
  })
}
async function pitch(page: Page, label: string): Promise<void> {
  await waitReady(page)
  await click(page, label)
}
/** A ball in play through the outcome picker, placed and angled by keyboard. */
async function chooseHit(page: Page, outcome: string): Promise<void> {
  await waitReady(page)
  await click(page, 'Swing in Play')
  if (['Throw Out', 'Ball Caught', 'Batter Interference'].includes(outcome))
    await click(page, 'Batter Out')
  await click(page, outcome)
  await page.waitForSelector('canvas[data-field-ready="true"]')
  await page.waitForSelector(
    '[aria-label^="Tap or drag a player to where the ball was fielded"]'
  )
  await page.focus('[role="application"]')
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await page.waitForSelector(
    '[aria-label^="Drag up and down for ball trajectory."]'
  )
  await page.keyboard.press('Enter')
}
/** One frame, so the screen has taken the key before the next one. */
async function frame(page: Page): Promise<void> {
  await page.evaluate(
    async () =>
      await new Promise(resolve => {
        requestAnimationFrame(resolve)
      })
  )
}
/**
 * A ball in play fielded by the player at `slot` among those the field lets
 * the scorer choose (P to RF, in that order), hit at `angle` degrees.
 */
async function hitTo(
  page: Page,
  outcome: string,
  slot: number,
  angle: number
): Promise<void> {
  await waitReady(page)
  await click(page, 'Swing in Play')
  if (['Throw Out', 'Ball Caught'].includes(outcome))
    await click(page, 'Batter Out')
  await click(page, outcome)
  await page.waitForSelector('canvas[data-field-ready="true"]')
  await page.waitForSelector(
    '[aria-label^="Tap or drag a player to where the ball was fielded"]'
  )
  await page.focus('[role="application"]')
  for (let i = 0; i <= slot; i++) await page.keyboard.press(']')
  await frame(page)
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await page.waitForSelector(
    '[aria-label^="Drag up and down for ball trajectory."]'
  )
  for (let value = 45; value > angle; value--)
    await page.keyboard.press('ArrowDown')
  await frame(page)
  await page.keyboard.press('Enter')
}
/** Finishes a decided play when the screen leaves it open for correction. */
async function finishAtBat(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const ball = document.querySelector('[aria-label="Ball"]')
      return (
        document.querySelector('[aria-label="Finish at-bat"]') != null ||
        (ball != null && ball.getAttribute('aria-disabled') !== 'true')
      )
    },
    { timeout: 30000 }
  )
  if ((await page.$('[aria-label="Finish at-bat"]')) != null)
    await click(page, 'Finish at-bat')
}
/** Places the player `presses` steps along the field's choosable list. */
async function placeWithKeyboard(page: Page, presses: number): Promise<void> {
  // A relay asks for the next defender in the same words each time, so the
  // prompt alone does not show the screen has taken the last one.
  await frame(page)
  await frame(page)
  await page.focus('[role="application"]')
  for (let i = 0; i < presses; i++) await page.keyboard.press(']')
  await frame(page)
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
}
async function dropRunnerWithKeyboard(
  page: Page,
  decision: 'Safe' | 'Out',
  advance = false
): Promise<void> {
  await page.waitForSelector('canvas[data-field-ready="true"]')
  await page.focus('[role="application"]')
  await page.keyboard.press('Space')
  if (advance) for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp')
  await page.keyboard.press(decision === 'Safe' ? 's' : 'o')
  await page.keyboard.press('Enter')
}
/** The runner headed home is safe, when the screen asks. */
async function decideHome(page: Page): Promise<void> {
  await page.waitForSelector('[aria-label^="Home plate decision"]', {
    timeout: 30000
  })
  await click(page, 'Safe')
}
/** A ground ball the shortstop boots, charged to him. */
async function reachOnError(page: Page): Promise<void> {
  await waitReady(page)
  await click(page, 'Swing in Play')
  await click(page, 'Error')
  await page.waitForSelector('canvas[data-field-ready="true"]')
  await page.waitForSelector(
    '[aria-label^="Tap or drag a player to where the ball was fielded"]'
  )
  await page.focus('[role="application"]')
  for (let i = 0; i <= 4; i++) await page.keyboard.press(']')
  await frame(page)
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await page.waitForSelector(
    '[aria-label^="Drag up and down for ball trajectory."]'
  )
  for (let value = 45; value > -10; value--)
    await page.keyboard.press('ArrowDown')
  await frame(page)
  await page.keyboard.press('Enter')
  await page.waitForSelector('[aria-label^="Tap or drag another defender"]', {
    timeout: 30000
  })
  await click(page, 'Finish defensive play')
  await page.waitForSelector('[aria-label^="Error by "]')
  const credits = await page.$$eval('[aria-label^="Error by "]', nodes =>
    nodes.map(node => String(node.getAttribute('aria-label')))
  )
  await click(page, credits.at(-1)!)
}
async function openScoring(
  page: Page,
  entry: 'Score Game' | 'Continue Scoring'
): Promise<void> {
  await click(page, entry)
  await page.waitForFunction(() => location.pathname.endsWith('/score'))
  await page.waitForSelector('canvas[data-field-ready="true"]', {
    timeout: 30000
  })
  if ((await page.$('[aria-label="OK"]')) != null) await click(page, 'OK')
}

/** A play as two scorings of the same game can be compared. */
function comparable(play: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(play)) as Record<string, unknown>
  delete copy.source
  const about = copy.about as Record<string, unknown> | undefined
  if (about != null) {
    delete about.startTime
    delete about.endTime
    delete about.halfOuts
  }
  if (Array.isArray(copy.credits))
    for (const credit of copy.credits as Array<Record<string, unknown>>)
      delete credit.teamId
  return copy
}

describe('scoring into the server', function () {
  this.timeout(180000)
  before(async function () {
    if (SCORER.password === '' || VIEWER.password === '')
      throw new Error('Set GS_SCORER_PASSWORD and GS_VIEWER_PASSWORD')
    scorer = await signIn(SCORER)
    scoringGame()
    viewer = await signIn(VIEWER)
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.GS_CHROME_PATH,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader'
      ]
    })
  })
  after(async function () {
    await browser?.close()
  })

  it('scenario 1: scores a double play in the browser and saves it with user ids', async function () {
    const fixture = scoringGame()
    const gameId = fixture.games[0]
    const page = await openAs(scorer, `/games/${gameId}`)
    try {
      await openScoring(page, 'Score Game')
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Save Rosters')
      for (let i = 0; i < 4; i++) await pitch(page, 'Ball')
      await waitReady(page)
      await pitch(page, 'Ball')
      await pitch(page, 'Called Strike')
      await pitch(page, 'Swing and Miss')
      // A ground ball to the shortstop: 6 to 4, forcing the runner at
      // second, then 4 to 3 for the batter.
      await hitTo(page, 'Throw Out', 4, -10)
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender, drag a forced runner"]'
      )
      // The shortstop holds the ball, so the second baseman is fourth.
      await placeWithKeyboard(page, 4)
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender, drag a forced runner"]'
      )
      // The forced runner is the last player the field offers: [ from
      // nothing selected goes to him. The throw beat him to second.
      await frame(page)
      await frame(page)
      await page.focus('[role="application"]')
      await page.keyboard.press('[')
      await frame(page)
      await page.keyboard.press('Space')
      for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp')
      await page.keyboard.press('o')
      await page.keyboard.press('Enter')
      // The second baseman still holds it, so the first baseman is third.
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender, or hit Done"]'
      )
      await placeWithKeyboard(page, 3)
      await click(page, 'Finish defensive play')
      await waitReady(page)
      await waitSaved(page)
      expect(await summary(page)).includes('2 outs')
      const game = await stored(scorer, gameId)
      const [walk, dp] = game.plays.map(row => row.gumbo) as Array<{
        result: { eventType: string }
        matchup: { batter: { id?: number }; pitcher: { id?: number } }
        runners: Array<{
          movement: { isOut: boolean; outNumber?: number; outBase: string }
          details: { runner: { id: number }; movementReason: string | null }
          credits: Array<{ player: { id: number }; credit: string }>
        }>
      }>
      const credits = (runner: number): string[] =>
        dp.runners
          .filter(entry => entry.details.runner.id === runner)
          .flatMap(entry => entry.credits)
          .map(credit => `${credit.credit} ${credit.player.id}`)
      const [, , first, second, short] = fixture.home
      expect(credits(fixture.away[0])).deep.equals([
        `f_assist ${short}`,
        `f_putout ${second}`
      ])
      expect(credits(fixture.away[1])).deep.equals([
        `f_assist ${second}`,
        `f_putout ${first}`
      ])
      // The lead runner is out first, and forced.
      expect(
        dp.runners
          .filter(runner => runner.movement.isOut)
          .map(runner => [
            runner.details.runner.id,
            runner.movement.outNumber,
            runner.movement.outBase,
            runner.details.movementReason
          ])
      ).deep.equals([
        [fixture.away[0], 1, '2B', 'r_force_out'],
        [fixture.away[1], 2, '1B', null]
      ])
      expect(walk.result.eventType).equals('walk')
      expect(dp.result.eventType).equals('grounded_into_double_play')
      expect(dp.runners.filter(runner => runner.movement.isOut)).length(2)
      expect(walk.matchup.batter.id).equals(fixture.away[0])
      expect(dp.matchup.batter.id).equals(fixture.away[1])
      expect(dp.matchup.pitcher.id).equals(fixture.home[0])
      expect(sql(`select status from games where id='${gameId}'`)).equals(
        'inProgress'
      )
    } finally {
      await page.close()
    }
  })

  it('scenario 2: the same play with and without animation makes the same game', async function () {
    const fixture = scoringGame(2)
    const reads: Stored[] = []
    for (const [index, gameId] of fixture.games.entries()) {
      const context = await browser.createBrowserContext()
      const page = await openAs(scorer, `/games/${gameId}`, context)
      try {
        await openScoring(page, 'Score Game')
        if (index === 1) {
          await click(page, 'Open scoring menu')
          await click(page, 'Settings')
          await click(page, 'Toggle play animations')
          await page.waitForFunction(() =>
            String(document.body.textContent).includes('Animate plays: Off')
          )
          await page.keyboard.press('Escape')
          await page.waitForSelector('[aria-label="Toggle play animations"]', {
            hidden: true
          })
        }
        await chooseHit(page, 'Single')
        await page.waitForSelector('[aria-label="Time to edit play"]', {
          timeout: 30000
        })
        await click(page, 'Finish at-bat')
        await pitch(page, 'Ball')
        await waitReady(page)
        await waitSaved(page)
        reads.push(await stored(scorer, gameId))
      } finally {
        await page.close()
        await context.close()
      }
    }
    expect(reads[0].plays).length(1)
    expect(reads[0].plays.map(row => comparable(row.gumbo))).deep.equals(
      reads[1].plays.map(row => comparable(row.gumbo))
    )
    expect(comparable(reads[0].currentPlay)).deep.equals(
      comparable(reads[1].currentPlay)
    )
    // Opened again, both screens stand at the same place.
    const reopened: string[] = []
    for (const gameId of fixture.games) {
      const page = await openAs(scorer, `/games/${gameId}`)
      try {
        await openScoring(page, 'Continue Scoring')
        await waitReady(page)
        reopened.push(await summary(page))
      } finally {
        await page.close()
      }
    }
    expect(reopened[0]).not.equals('')
    expect(reopened[0]).equals(reopened[1])
  })

  it('scenario 3: a dictated half inning and the same one tapped make the same game', async function () {
    const fixture = scoringGame()
    const gameId = fixture.games[0]
    const page = await openAs(scorer, `/games/${gameId}`)
    try {
      await openScoring(page, 'Score Game')
      // A single to centre.
      await pitch(page, 'Ball')
      await pitch(page, 'Called Strike')
      await hitTo(page, 'Single', 7, 15)
      await finishAtBat(page)
      // A strikeout.
      await pitch(page, 'Called Strike')
      await pitch(page, 'Swing and Miss')
      await pitch(page, 'Swing and Miss')
      await finishAtBat(page)
      // Short to first for the batter, the runner taking second.
      await hitTo(page, 'Throw Out', 4, -10)
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]'
      )
      await page.focus('[role="application"]')
      for (let i = 0; i < 3; i++) await page.keyboard.press(']')
      await frame(page)
      await page.keyboard.press('Space')
      await page.keyboard.press('ArrowUp')
      await page.keyboard.press('Enter')
      await click(page, 'Finish defensive play')
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      await dropRunnerWithKeyboard(page, 'Safe', true)
      await finishAtBat(page)
      // A fly to left for the third out.
      await hitTo(page, 'Ball Caught', 6, 40)
      await waitReady(page)
      await waitSaved(page)
    } finally {
      await page.close()
    }

    const read = await stored(scorer, gameId)
    const detail = (await (
      await fetch(`${API}/games/${gameId}`, {
        headers: { cookie: `gs_session=${encodeURIComponent(scorer)}` }
      })
    ).json()) as GameDetail
    const first = read.plays[0].gumbo as {
      gameStation: { setupBefore: GameSetup }
    }
    const setup = first.gameStation.setupBefore
    const teams = teamsOf(detail)

    // The fixture names the players of a game built from empty rosters; the
    // same batting slot or position here is the same player.
    const authored = createDevelopmentSession(detail, [], []).liveData.boxscore
    const idOf = new Map<number, number>()
    for (const side of ['away', 'home'] as const) {
      authored.teams[side].battingOrder.forEach((id, slot) => {
        idOf.set(id, setup.sides[side].battingOrder[slot])
      })
      for (const [position, id] of Object.entries(authored.teams[side].defense))
        if (id != null)
          idOf.set(
            id,
            setup.sides[side].defense[
              position as keyof typeof setup.sides.home.defense
            ]!
          )
    }
    const mapped = (id: number): number => {
      const found = idOf.get(id)
      if (found == null) throw new Error(`No player for fixture id ${id}`)
      return found
    }
    // Where the scorer's fingers put the ball and the throws: the browser's
    // own actions say; everything else is the fixture's.
    const tappedActions = [
      ...read.plays,
      ...(read.currentPlay == null ? [] : [{ gumbo: read.currentPlay }])
    ].flatMap(
      row =>
        (row.gumbo as { gameStation?: { actions: ScoringAction[] } })
          .gameStation?.actions ?? []
    )
    const placed = tappedActions.filter(
      action =>
        (action.type === 'ballInPlay' && action.location != null) ||
        (action.type === 'runnerMovement' && action.locations != null)
    )
    const script = (
      JSON.parse(
        readFileSync(
          'src2/common/scoring/fixtures/halfInning.actions.json',
          'utf8'
        )
      ) as unknown[]
    ).map(entry => {
      const cleaned = cleanAction(entry)
      if ('problem' in cleaned) throw new Error(cleaned.problem.message)
      const action = cleaned.action
      if (action.type === 'ballInPlay' && action.location != null) {
        const from = placed.shift()
        if (from?.type !== 'ballInPlay') throw new Error('No tapped hit')
        return {
          ...action,
          fielder: mapped(action.fielder!),
          location: from.location
        }
      }
      if (action.type === 'runnerMovement') {
        const from = action.locations == null ? undefined : placed.shift()
        return {
          ...action,
          runner: mapped(action.runner),
          ...(action.fielders == null
            ? {}
            : { fielders: action.fielders.map(mapped) }),
          ...(from?.type === 'runnerMovement'
            ? { locations: from.locations, runnerLocation: from.runnerLocation }
            : {})
        }
      }
      return action
    })
    expect(placed).deep.equals([])

    let dictated: GameState = freshGame(gameId, teams, setup)
    for (const action of script) {
      const applied = applyAction(dictated, action)
      expect(applied.problems, JSON.stringify(action)).deep.equals([])
      dictated = applied.state
    }
    const store: EventStore = {
      load: async () =>
        ({
          plays: read.plays.map(row => row.gumbo),
          currentPlay: read.currentPlay
        }) as unknown as StoredGame,
      save: async () => {
        throw new Error('read only')
      }
    }
    const tapped = (
      await ScoringSession.open(store, gameId, { gamePk: gameId, teams, setup })
    ).state
    expect(
      tapped.liveData.plays.allPlays.map(play => play.result.eventType)
    ).deep.equals(['single', 'strikeout', 'field_out', 'field_out'])
    expect(tapped.liveData.plays.allPlays.map(comparable)).deep.equals(
      dictated.liveData.plays.allPlays.map(comparable)
    )
    expect(tapped.liveData.linescore).deep.equals(dictated.liveData.linescore)
    expect(tapped.liveData.boxscore).deep.equals(dictated.liveData.boxscore)
  })

  it('scenario 4: the game survives a reload in the middle of an at-bat', async function () {
    const fixture = scoringGame()
    const gameId = fixture.games[0]
    let page = await openAs(scorer, `/games/${gameId}`)
    try {
      await openScoring(page, 'Score Game')
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Save Rosters')
      await pitch(page, 'Ball')
      await pitch(page, 'Ball')
      await waitReady(page)
      await waitSaved(page)
      const middle = await stored(scorer, gameId)
      expect(middle.plays).deep.equals([])
      const current = middle.currentPlay as {
        about: { isComplete: boolean; atBatIndex: number }
        playEvents: unknown[]
        gameStation: { actions: Array<{ type: string }> }
      }
      expect(current.about).deep.include({ isComplete: false, atBatIndex: 0 })
      expect(current.playEvents).length(2)
      expect(
        current.gameStation.actions.map(action => action.type)
      ).deep.equals(['lineup', 'pitch', 'pitch'])
      expect(
        sql(`select count(*) from events where "gameId"='${gameId}'`)
      ).equals('0')
      expect(sql(`select status from games where id='${gameId}'`)).equals(
        'inProgress'
      )
      const before = await summary(page)
      await page.close()
      page = await openAs(scorer, `/games/${gameId}`)
      await page.waitForSelector('[aria-label="Continue Scoring"]')
      expect(await page.$('[aria-label="Score Game"]')).equals(null)
      await page.reload()
      await openScoring(page, 'Continue Scoring')
      await page.waitForFunction(
        text => document.querySelector(`[aria-label*="${text}"]`) != null,
        {},
        '2 balls 0 strikes 0 outs'
      )
      expect(await summary(page)).equals(before)
      await pitch(page, 'Ball')
      await pitch(page, 'Ball')
      await waitReady(page)
      await waitSaved(page)
      const after = await stored(scorer, gameId)
      expect(after.plays).length(1)
      expect(
        (after.plays[0].gumbo.about as { atBatIndex: number }).atBatIndex
      ).equals(0)
      expect(
        (after.plays[0].gumbo.result as { eventType: string }).eventType
      ).equals('walk')
      expect(
        (after.currentPlay?.about as { atBatIndex: number }).atBatIndex
      ).equals(1)
    } finally {
      await page.close()
    }
  })

  it('scenario 5: offline scoring, a refused scorer, and ending and correcting the game', async function () {
    const fixture = scoringGame()
    const gameId = fixture.games[0]
    let page = await openAs(scorer, `/games/${gameId}`)
    const context = await browser.createBrowserContext()
    try {
      await openScoring(page, 'Score Game')
      await pitch(page, 'Ball')
      await waitReady(page)
      await waitSaved(page)
      await page.setOfflineMode(true)
      await pitch(page, 'Ball')
      await pitch(page, 'Called Strike')
      await pitch(page, 'Swing and Miss')
      await chooseHit(page, 'Single')
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      await click(page, 'Finish at-bat')
      await waitReady(page)
      await page.waitForFunction(
        () => {
          const status = document.querySelector('[aria-label="Save status"]')
          return (
            status != null && String(status.textContent).startsWith('Offline')
          )
        },
        { timeout: 30000 }
      )
      await page.setOfflineMode(false)
      await pitch(page, 'Ball')
      await waitReady(page)
      await waitSaved(page)
      const back = await stored(scorer, gameId)
      expect(
        back.plays.map(
          row => (row.gumbo.result as { eventType: string }).eventType
        )
      ).deep.equals(['single'])
      expect(
        sql(`select count(*) from events where "gameId"='${gameId}'`)
      ).equals('1')

      // Somebody who can see the game and scores for neither team.
      const refused = await openAs(viewer, `/games/${gameId}`, context)
      await openScoring(refused, 'Continue Scoring')
      await waitReady(refused)
      const unrefused = await summary(refused)
      await click(refused, 'Ball')
      await refused.waitForSelector('[aria-label="Scoring is read-only"]', {
        timeout: 30000
      })
      expect(
        await refused.$eval(
          '[aria-label="Scoring is read-only"]',
          node => node.textContent
        )
      ).includes('Only someone who can score this game may change its plays')
      // The refused pitch is not shown as scored.
      await refused.waitForFunction(
        before => {
          const board = document.querySelector('[aria-label*=" balls "]')
          // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- Browser evaluation cannot reference generated Sucrase helpers.
          return board != null && board.getAttribute('aria-label') === before
        },
        {},
        unrefused
      )
      // …and read-only takes no more, from the keyboard either.
      expect(
        await refused.$eval('[aria-label="Ball"]', node =>
          node.getAttribute('aria-disabled')
        )
      ).equals('true')
      expect(
        sql(`select count(*) from events where "gameId"='${gameId}'`)
      ).equals('1')

      // Finish the at-bat and end the game.
      await click(page, 'Undo Ball')
      await waitReady(page)
      await click(page, 'Open scoring menu')
      await click(page, 'End Game')
      await click(page, 'Confirm End Game')
      await page.waitForSelector('[aria-label="Game over"]')
      await waitSaved(page)
      expect(sql(`select status from games where id='${gameId}'`)).equals(
        'final'
      )
      expect(
        sql(
          `select "eventType" from events where "gameId"='${gameId}' and "atBatIndex"=9999`
        )
      ).equals('final_score')
      expect(
        sql(`select "currentPlay" is null from games where id='${gameId}'`)
      ).equals('t')
      const final = await summary(page)
      await click(page, 'Ball')
      expect(await summary(page)).equals(final)
      const singleId = sql(
        `select id from events where "gameId"='${gameId}' and "atBatIndex"=0`
      )
      await page.close()

      // Taken up again: undo the end, open the single again, and correct it.
      page = await openAs(scorer, `/games/${gameId}`)
      await openScoring(page, 'Continue Scoring')
      await click(page, 'Undo Last play')
      await page.waitForSelector('[aria-label="Game over"]', { hidden: true })
      await waitSaved(page)
      expect(sql(`select status from games where id='${gameId}'`)).equals(
        'inProgress'
      )
      expect(
        sql(
          `select count(*) from events where "gameId"='${gameId}' and "atBatIndex"=9999`
        )
      ).equals('0')
      await click(page, 'Undo Last play')
      // The reopened play waits for the scorer, with no countdown to close it.
      await page.waitForSelector('[aria-label="Finish at-bat"]', {
        timeout: 30000
      })
      expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
      await waitSaved(page)
      expect(
        sql(
          `select "currentPlay"->'about'->>'atBatIndex' from games where id='${gameId}'`
        )
      ).equals('0')
      expect(
        sql(
          `select id from events where "gameId"='${gameId}' and "atBatIndex"=0`
        )
      ).equals(singleId)
      await dropRunnerWithKeyboard(page, 'Safe', true)
      await click(page, 'Finish at-bat')
      await waitReady(page)
      await click(page, 'Open scoring menu')
      await click(page, 'End Game')
      await click(page, 'Confirm End Game')
      await page.waitForSelector('[aria-label="Game over"]')
      await waitSaved(page)
      expect(
        sql(`select status||' '||ingest_status from games where id='${gameId}'`)
      ).equals('final ok')
      expect(
        sql(
          `select id from events where "gameId"='${gameId}' and "atBatIndex"=0`
        )
      ).equals(singleId)
      const corrected = sql(
        `select gumbo->'runners'->-1->'movement'->>'end' from events where id='${singleId}'`
      )
      expect(['2B', '3B', 'score']).includes(corrected)
      expect(
        sql(
          `select count(*) from events where "gameId"='${gameId}' and "atBatIndex"=9999`
        )
      ).equals('1')
    } finally {
      await page.close()
      await context.close()
    }
  })

  it('scenario 6: a half scored in the browser builds stat lines from Gumbo runners', async function () {
    const fixture = scoringGame()
    const gameId = fixture.games[0]
    const [b1, b2, b3, b4, b5] = fixture.away
    const pitcher = fixture.home[0]
    const page = await openAs(scorer, `/games/${gameId}`)
    try {
      await openScoring(page, 'Score Game')
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Save Rosters')
      // A single.
      await pitch(page, 'Ball')
      await hitTo(page, 'Single', 7, 15)
      await finishAtBat(page)
      // A steal of second, then a double that scores him.
      await pitch(page, 'Ball')
      await waitReady(page)
      await dropRunnerWithKeyboard(page, 'Safe', true)
      await click(page, 'Steal')
      await waitReady(page)
      await hitTo(page, 'Double', 8, 20)
      await decideHome(page)
      await finishAtBat(page)
      // A wild pitch takes the runner to third, and a strikeout.
      await pitch(page, 'Ball')
      await waitReady(page)
      await dropRunnerWithKeyboard(page, 'Safe', true)
      await click(page, 'Wild Pitch')
      await waitReady(page)
      await pitch(page, 'Called Strike')
      await pitch(page, 'Swing and Miss')
      await pitch(page, 'Swing and Miss')
      await finishAtBat(page)
      // The shortstop's error, and the runner from third scores on it.
      await reachOnError(page)
      await decideHome(page)
      await finishAtBat(page)
      // A ground-out, and the half ends there.
      await hitTo(page, 'Throw Out', 4, -10)
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]'
      )
      await placeWithKeyboard(page, 3)
      await click(page, 'Finish defensive play')
      await finishAtBat(page)
      await waitReady(page)
      await click(page, 'Open scoring menu')
      await click(page, 'End Half Inning')
      await click(page, 'Confirm End Half Inning')
      await waitReady(page)
      await waitSaved(page)
      expect(await summary(page)).includes('Bottom')
    } finally {
      await page.close()
    }

    // The stored runners are Gumbo's: named bases and MLB's reasons.
    const runners = JSON.parse(
      sql(
        `select json_agg(r order by e."atBatIndex") from events e, jsonb_array_elements(e.gumbo->'runners') r where e."gameId"='${gameId}'`
      )
    ) as Array<{
      movement: { start: string | null; end: string | null }
      details: {
        runner: { id: number }
        eventType: string
        movementReason: string | null
        earned: boolean
        rbi: boolean
      }
    }>
    const line = (runner: (typeof runners)[number]): string =>
      [
        runner.details.runner.id,
        runner.movement.start,
        runner.movement.end,
        runner.details.eventType,
        runner.details.movementReason
      ].join(' ')
    expect(runners.map(line)).includes.members([
      `${b1} 1B 2B stolen_base_2b r_stolen_base_2b`,
      `${b1} 2B score double r_adv_play`,
      `${b2} 2B 3B wild_pitch r_adv_play`,
      `${b2} 3B score field_error r_adv_play`
    ])
    for (const runner of runners) {
      expect([null, '1B', '2B', '3B']).includes(runner.movement.start)
      expect([null, '1B', '2B', '3B', 'score']).includes(runner.movement.end)
    }

    // The stats builder builds the game, and every figure is the scorer's.
    let status = ''
    for (let i = 0; i < 60 && status !== 'built'; i++) {
      status = sql(
        `select status from game_stats_state where game_id='${gameId}'`
      )
      if (status !== 'built')
        await new Promise(resolve => setTimeout(resolve, 1000))
    }
    expect(status).equals('built')
    const figures = (userId: number): string =>
      sql(
        `select concat_ws(' ', pa, ab, h, doubles, r, rbi, sb, k, pitch_bf, pitch_outs, pitch_k, pitch_r, pitch_er) from game_player_stats where game_id='${gameId}' and user_id=${userId}`
      )
    // pa ab h 2b r rbi sb k | bf outs k r er
    expect(figures(b1)).equals('1 1 1 0 1 0 1 0 0 0 0 0 0')
    expect(figures(b2)).equals('1 1 1 1 1 1 0 0 0 0 0 0 0')
    expect(figures(b3)).equals('1 1 0 0 0 0 0 1 0 0 0 0 0')
    expect(figures(b4)).equals('1 1 0 0 0 0 0 0 0 0 0 0 0')
    expect(figures(b5)).equals('1 1 0 0 0 0 0 0 0 0 0 0 0')
    // Two runs off the starter: the error's unearned.
    expect(figures(pitcher)).equals('0 0 0 0 0 0 0 0 5 2 1 2 1')
  })

  it('scenario 7: pitches and actions are stored in Gumbo shape, and undone to what was stored', async function () {
    const fixture = scoringGame()
    const gameId = fixture.games[0]
    const page = await openAs(scorer, `/games/${gameId}`)
    let before: Stored | null = null
    let scored: Stored | null = null
    let undone: Stored | null = null
    try {
      await openScoring(page, 'Score Game')
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Save Rosters')
      // A dropped third strike, and the batter makes first.
      await pitch(page, 'Called Strike')
      await pitch(page, 'Swing and Miss')
      await waitReady(page)
      await click(page, 'More')
      await click(page, 'Dropped Third Strike')
      await page.waitForSelector('[aria-label^="Runner decision for "]', {
        timeout: 30000
      })
      await click(page, 'Safe')
      await finishAtBat(page)
      // Ball, called strike, foul, then the batter is hit.
      await pitch(page, 'Ball')
      await pitch(page, 'Called Strike')
      await pitch(page, 'Foul Ball')
      await waitReady(page)
      await click(page, 'More')
      await click(page, 'Hit by Pitch')
      await waitReady(page)
      await waitSaved(page)
      before = await stored(scorer, gameId)
      // A balk, then an intentional walk.
      await click(page, 'More')
      await click(page, 'Balk')
      await waitReady(page)
      await click(page, 'More')
      await click(page, 'Intentional Walk')
      await waitReady(page)
      await waitSaved(page)
      scored = await stored(scorer, gameId)
      expect(
        sql(
          `select string_agg("eventType", ',' order by "atBatIndex") from events where "gameId"='${gameId}'`
        )
      ).equals('strikeout,hit_by_pitch,intent_walk')
      // Both undone.
      for (let i = 0; i < 2; i++) {
        await page.locator('[aria-label^="Undo "]').click()
        await waitReady(page)
      }
      await waitSaved(page)
      undone = await stored(scorer, gameId)
    } finally {
      await page.close()
    }

    interface Event {
      index: number
      isPitch: boolean
      isBaseRunningPlay?: boolean
      pitchNumber?: number
      details: Record<string, unknown>
      count: { balls: number; strikes: number; outs: number }
    }
    interface Play {
      about: { atBatIndex: number }
      result: { eventType: string }
      playEvents: Event[]
      runners: Array<{
        movement: { start: string | null; end: string | null }
      }>
      pitchIndex: number[]
      actionIndex: number[]
      runnerIndex: number[]
    }
    const plays = (from: Stored): Play[] =>
      from.plays
        .map(row => row.gumbo as unknown as Play)
        .sort((a, b) => a.about.atBatIndex - b.about.atBatIndex)
    const pitches = (play: Play): string[] =>
      play.playEvents
        .filter(event => event.isPitch)
        .map(
          event =>
            `${String(event.details.code)} ${event.count.balls}-${event.count.strikes} ${event.count.outs}`
        )
    const [dropped, hit, balked] = plays(scored)
    expect(dropped.result.eventType).equals('strikeout')
    expect(pitches(dropped)).deep.equals(['C 0-1 0', 'S 0-2 0', 'S 0-3 0'])
    expect(dropped.playEvents[2].details).deep.include({
      call: { code: 'S', description: 'Swinging Strike' },
      isInPlay: false,
      isStrike: true,
      isOut: false
    })
    expect(dropped.runners[0].movement).deep.include({ start: null, end: '1B' })
    expect(hit.result.eventType).equals('hit_by_pitch')
    expect(pitches(hit)).deep.equals([
      'B 1-0 0',
      'C 1-1 0',
      'F 1-2 0',
      'H 1-2 0'
    ])
    expect(hit.playEvents.map(event => event.pitchNumber)).deep.equals([
      1, 2, 3, 4
    ])
    expect(hit).deep.include({ pitchIndex: [0, 1, 2, 3], actionIndex: [] })
    expect(balked.result.eventType).equals('intent_walk')
    expect(balked.pitchIndex).deep.equals([])
    const [balk, walk] = balked.playEvents
    expect(balk.isBaseRunningPlay).equals(true)
    expect(balk.details).deep.include({
      event: 'Balk',
      eventType: 'balk',
      isScoringPlay: false,
      isOut: false,
      hasReview: false
    })
    expect(String(balk.details.description)).matches(
      /^Balk by [^.]+\. [^.]+ to 2nd\. [^.]+ to 3rd\.$/
    )
    expect(walk.isBaseRunningPlay).equals(undefined)
    expect(walk.details).deep.include({ eventType: 'intent_walk' })
    // Nobody on first, so nobody is forced along.
    expect(String(walk.details.description)).matches(
      /^[^.]+ is walked intentionally\.$/
    )
    console.log(`      balk: ${String(balk.details.description)}`)
    console.log(`      walk: ${String(walk.details.description)}`)

    // Undoing the walk and the balk leaves what was stored before them.
    expect(plays(undone).map(comparable)).deep.equals(
      plays(before).map(comparable)
    )
    expect(comparable(undone.currentPlay)).deep.equals(
      comparable(before.currentPlay)
    )
    expect(
      sql(`select count(*) from events where "gameId"='${gameId}'`)
    ).equals('2')
  })
})
