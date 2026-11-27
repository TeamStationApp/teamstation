import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'

import { teamsOf } from '../../../../src/app/scoring/developmentSession'
import type { GameDetail, RosterEntry } from '../../../../src/common/api'
import {
  dictatedAction,
  type ScoringAction
} from '../../../../src/common/scoring/actions'
import { comparablePlay } from '../../../../src/common/scoring/comparable'
import { freshGame } from '../../../../src/common/scoring/rules'
import {
  applyAction,
  type EventStore,
  ScoringSession,
  type StoredGame
} from '../../../../src/common/scoring/session'
import {
  type FielderRef,
  type GameSetup,
  type GameState,
  type Position,
  POSITIONS
} from '../../../../src/common/scoring/state'
import {
  SCORING_FEATURE_HEADER,
  SCORING_FEATURES
} from '../../../../src/common/scoring/teamRecord'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import { clearSignInLimits, stackSql } from '../../../rigs/coach/coachApp'
import {
  dropRunner,
  placeFielder,
  setTrajectory
} from '../../../rigs/fieldPointer'
import {
  enabled,
  openWebScorer,
  pressControl,
  waitSaved as waitScorerSaved,
  type WebScorer
} from '../../../rigs/scoring/webScorer'

/**
 * The scoring screen against the stack's API, with nothing intercepted:
 * every play it scores is posted to the server, read back, and checked in
 * the stack's database. Each scenario scores a fresh `scoring-game` game
 * (two, for the one that compares) as its administrator scorer, who keeps
 * score for the season; the viewer is a member of the home team only. The
 * web scorer runs in the runner's browser through maestro-d; the page is
 * only read.
 */

interface Fixture {
  games: string[]
  away: number[]
  home: number[]
}

/** The scenario running: one at a time in a run. */
let ctx: HarnessContext
let API = ''
/** The world's scorer's and viewer's API sessions. */
let scorer = ''
let viewer = ''

/** Starts a scenario: what the helpers below read. */
function begin(next: HarnessContext): void {
  ctx = next
  API = `${next.stack.origin}/api/v1`
  scorer = ''
  viewer = ''
}

/** A fresh `scoring-game` world: its two games and the first nine of each side. */
async function scoringGame(_games = 1): Promise<Fixture> {
  const world = await ctx.fixture('scoring-game')
  await clearSignInLimits(ctx)
  const { signInTestAccount } =
    await import('../../../../src/test/passwordFixtures')
  scorer = await signInTestAccount(API, world.accounts.scorer)
  viewer = await signInTestAccount(API, world.accounts.viewer)
  return {
    games: world.ids.games.split(','),
    away: world.ids.away.split(',').map(Number),
    home: world.ids.home.split(',').map(Number)
  }
}

function text(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'boolean') return value ? 't' : 'f'
  if (typeof value === 'string') return value
  // Numbers as they print; JSON as psql prints it.
  return JSON.stringify(value)
}

/** A query on the stack's database, its rows as `psql -tA` prints them. */
async function sql(query: string): Promise<string> {
  const { rows } = await stackSql(ctx, query)
  return rows
    .map(row => Object.values(row).map(text).join('|'))
    .join('\n')
    .trim()
}

interface Stored {
  plays: Array<{ id: string; gumbo: Record<string, unknown> }>
  currentPlay: Record<string, unknown> | null
}
async function stored(token: string, gameId: string): Promise<Stored> {
  const response = await fetch(`${API}/games/${gameId}/events`, {
    headers: {
      cookie: `ts_session=${encodeURIComponent(token)}`,
      // The records this checkout's app reads; without it a newer record is refused.
      [SCORING_FEATURE_HEADER]: SCORING_FEATURES
    }
  })
  return (await response.json()) as Stored
}

/**
 * A tab of the web scorer: reads go to the page, and every press, drag, key,
 * load and network change is a maestro-d command on its browser.
 */
class Page {
  private readonly pointer: { at: [number, number]; from?: [number, number] } =
    {
      at: [0, 0]
    }

  constructor(readonly scorer: WebScorer) {}

  get m(): any {
    return this.scorer.m
  }

  private get real(): WebScorer['page'] {
    return this.scorer.page
  }

  field(): ReturnType<WebScorer['field']> {
    return this.scorer.field()
  }

  get waitForSelector(): WebScorer['page']['waitForSelector'] {
    return this.real.waitForSelector.bind(this.real)
  }

  get waitForFunction(): WebScorer['page']['waitForFunction'] {
    return this.real.waitForFunction.bind(this.real)
  }

  get evaluate(): WebScorer['page']['evaluate'] {
    return this.real.evaluate.bind(this.real)
  }

  get $eval(): WebScorer['page']['$eval'] {
    return this.real.$eval.bind(this.real)
  }

  get $$eval(): WebScorer['page']['$$eval'] {
    return this.real.$$eval.bind(this.real)
  }

  get $(): WebScorer['page']['$'] {
    return this.real.$.bind(this.real)
  }

  get $$(): WebScorer['page']['$$'] {
    return this.real.$$.bind(this.real)
  }

  get waitForResponse(): WebScorer['page']['waitForResponse'] {
    return this.real.waitForResponse.bind(this.real)
  }

  /** Loads the page again, as the browser's reload does. */
  async reload(_options?: unknown): Promise<void> {
    await this.m.openLink({ link: this.real.url() })
  }

  async setOfflineMode(offline: boolean): Promise<void> {
    await this.m.setNetworkConditions({ offline })
  }

  /** Each tab is a window of its own, which maestro-d drives directly. */
  async bringToFront(): Promise<void> {}

  readonly keyboard = {
    press: async (key: string): Promise<void> => {
      await this.m.pressKey({ key })
    }
  }

  /** A press and its moves, sent as one maestro-d tap or drag on release. */
  readonly mouse = {
    move: async (x: number, y: number, _options?: unknown): Promise<void> => {
      this.pointer.at = [x, y]
    },
    down: async (): Promise<void> => {
      this.pointer.from = this.pointer.at
    },
    up: async (): Promise<void> => {
      const { from, at } = this.pointer
      this.pointer.from = undefined
      if (from == null) return
      if (from[0] === at[0] && from[1] === at[1]) {
        await this.m.tapOnPoint({ x: Math.round(at[0]), y: Math.round(at[1]) })
        return
      }
      await this.m.dragAndDrop({
        from: { point: `${Math.round(from[0])},${Math.round(from[1])}` },
        to: { point: `${Math.round(at[0])},${Math.round(at[1])}` },
        duration: 600
      })
    }
  }

  locator(css: string): {
    click: () => Promise<void>
    fill: (value: string) => Promise<void>
    setWaitForEnabled: (wait: boolean) => { click: () => Promise<void> }
  } {
    const click = async (): Promise<void> => {
      await this.m.tapOn({ css, timeout: 15000 })
    }
    return {
      click,
      fill: async value => {
        await click()
        await this.m.inputText({ text: value })
      },
      setWaitForEnabled: () => ({ click })
    }
  }

  async close(): Promise<void> {
    await this.scorer.session.close()
  }
}

/** A tab signed in as the holder of `token` (the scorer's or the viewer's), on `path`. */
async function openAs(token: string, path: string): Promise<Page> {
  const scorerPage = await openWebScorer(
    ctx,
    token === viewer ? 'viewer' : 'scorer'
  )
  scorerPage.page.on('pageerror', error => {
    console.error('Browser error:', error)
  })
  // A page holding its game's connection open may never fire load.
  await scorerPage.go(path)
  return new Page(scorerPage)
}

/** Presses the visible, enabled control labelled `label`, once it is still. */
async function click(page: Page, label: string): Promise<void> {
  await pressControl(page.m, page, enabled(label), label)
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
 * Every save has been answered: no write to the API has been outstanding for
 * half a second. Network idle is no measure, since a worker keeps a request
 * open, and the screen shows no status for a save that goes through.
 */
async function waitSaved(page: Page): Promise<void> {
  await waitScorerSaved(page.scorer)
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
/** A ball in play through the outcome picker, fielded by the pitcher at the angle shown. */
async function chooseHit(page: Page, outcome: string): Promise<void> {
  await waitReady(page)
  await click(page, 'Swing in Play')
  if (['Ground Out', 'Ball Caught', 'Batter Interference'].includes(outcome))
    await click(page, 'Batter Out')
  await click(page, outcome)
  await page.waitForSelector('canvas[data-field-ready="true"]')
  await page.waitForSelector(
    '[aria-label^="Tap or drag a player to where the ball was fielded"]'
  )
  await placeFielder(page.field(), 'P')
  await setTrajectory(page.field())
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
  position: Position,
  angle: number
): Promise<void> {
  await waitReady(page)
  await click(page, 'Swing in Play')
  if (['Ground Out', 'Ball Caught'].includes(outcome))
    await click(page, 'Batter Out')
  await click(page, outcome)
  await page.waitForSelector('canvas[data-field-ready="true"]')
  await page.waitForSelector(
    '[aria-label^="Tap or drag a player to where the ball was fielded"]'
  )
  await placeFielder(page.field(), position)
  await setTrajectory(page.field(), angle)
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
/** The next defender in a relay takes the ball, dragged where he fields it. */
async function placeDefender(page: Page, position: Position): Promise<void> {
  // A relay asks for the next defender in the same words each time, so the
  // prompt alone does not show the screen has taken the last one.
  await frame(page)
  await frame(page)
  await placeFielder(page.field(), position)
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
  await placeFielder(page.field(), 'SS')
  await setTrajectory(page.field(), -10)
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
/**
 * The game page's one Score pill, whether the game is new or being
 * continued, then the Score screen's Full game scoring.
 */
async function openScoring(page: Page): Promise<void> {
  await click(page, 'Score')
  await page.waitForFunction(() => location.pathname.endsWith('/score-game'))
  await click(page, 'Full game scoring')
  await page.waitForFunction(() => location.pathname.endsWith('/score'))
  await page.waitForSelector('canvas[data-field-ready="true"]', {
    timeout: 30000
  })
  if ((await page.$('[aria-label="OK"]')) != null) await click(page, 'OK')
}

export default defineHarness({
  id: 'scoring/server-sync/scored-into-server',
  title: 'The scoring screen saves to the server what it scores',
  kind: 'e2e',
  covers: [
    'src/app/scoring/**',
    'src/common/scoring/**',
    'src/server/scoring/**',
    'src/server/routes/events.ts'
  ],
  stack: 'isolated',
  fixtures: ['scoring-game'],
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
  minutes: 30,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    // Scenario 1: scores a double play in the browser and saves it with user ids.
    'double-play-user-ids': async ctx => {
      begin(ctx)
      const fixture = await scoringGame()
      const gameId = fixture.games[0]
      const page = await openAs(scorer, `/games/${gameId}`)
      try {
        await openScoring(page)
        await click(page, 'Open scoring menu')
        await click(page, 'Set Team Rosters')
        await click(page, 'Save Rosters')
        for (let i = 0; i < 4; i++) await pitch(page, 'Ball')
        await waitReady(page)
        await pitch(page, 'Ball')
        await pitch(page, 'Called Strike')
        await pitch(page, 'Swing and Miss')
        // A ground ball to the shortstop: 6 to 4, the runner from first
        // already standing on second, then 4 to 3 for the batter.
        await hitTo(page, 'Ground Out', 'SS', -10)
        await page.waitForSelector(
          '[aria-label^="Tap or drag the next defender, hold a runner"]'
        )
        await placeDefender(page, '2B')
        await page.waitForSelector(
          '[aria-label^="Tap or drag the next defender, hold a runner"]'
        )
        // The throw beat the runner to second, where he stands.
        await frame(page)
        await frame(page)
        await dropRunner(page.field(), 2, 'Out', 'stay')
        await page.waitForSelector(
          '[aria-label^="Tap or drag the next defender, or hit Done"]'
        )
        await placeDefender(page, '1B')
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
        expect(
          await sql(`select status from games where id='${gameId}'`)
        ).equals('inProgress')
      } finally {
        await page.close()
      }
    },
    // Scenario 2: the same play with and without animation makes the same game.
    'animation-same-game': async ctx => {
      begin(ctx)
      const fixture = await scoringGame(2)
      const reads: Stored[] = []
      for (const [index, gameId] of fixture.games.entries()) {
        const page = await openAs(scorer, `/games/${gameId}`)
        try {
          await openScoring(page)
          if (index === 1) {
            await click(page, 'Open scoring menu')
            await click(page, 'Settings')
            await click(page, 'Toggle play animations')
            await page.waitForSelector(
              '[aria-label="Toggle play animations"]:not(:checked)'
            )
            await page.keyboard.press('Escape')
            await page.waitForSelector(
              '[aria-label="Toggle play animations"]',
              {
                hidden: true
              }
            )
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
        }
      }
      expect(reads[0].plays).length(1)
      expect(reads[0].plays.map(row => comparablePlay(row.gumbo))).deep.equals(
        reads[1].plays.map(row => comparablePlay(row.gumbo))
      )
      expect(comparablePlay(reads[0].currentPlay)).deep.equals(
        comparablePlay(reads[1].currentPlay)
      )
      // Opened again, both screens stand at the same place.
      const reopened: string[] = []
      for (const gameId of fixture.games) {
        const page = await openAs(scorer, `/games/${gameId}`)
        try {
          await openScoring(page)
          await waitReady(page)
          reopened.push(await summary(page))
        } finally {
          await page.close()
        }
      }
      expect(reopened[0]).not.equals('')
      expect(reopened[0]).equals(reopened[1])
    },
    // Scenario 3: a dictated half inning and the same one tapped make the same game.
    'dictated-equals-tapped': async ctx => {
      begin(ctx)
      const fixture = await scoringGame()
      const gameId = fixture.games[0]
      const page = await openAs(scorer, `/games/${gameId}`)
      try {
        await openScoring(page)
        // A single to centre.
        await pitch(page, 'Ball')
        await pitch(page, 'Called Strike')
        await hitTo(page, 'Single', 'CF', 15)
        await finishAtBat(page)
        // A strikeout.
        await pitch(page, 'Called Strike')
        await pitch(page, 'Swing and Miss')
        await pitch(page, 'Swing and Miss')
        await finishAtBat(page)
        // Short to first for the batter; the ground out takes the runner to
        // second.
        await hitTo(page, 'Ground Out', 'SS', -10)
        await page.waitForSelector(
          '[aria-label^="Tap or drag the next defender"]'
        )
        await placeDefender(page, '1B')
        await click(page, 'Finish defensive play')
        await finishAtBat(page)
        // A fly to left for the third out.
        await hitTo(page, 'Ball Caught', 'LF', 40)
        await waitReady(page)
        await waitSaved(page)
      } finally {
        await page.close()
      }

      const read = await stored(scorer, gameId)
      const detail = (await (
        await fetch(`${API}/games/${gameId}`, {
          headers: { cookie: `ts_session=${encodeURIComponent(scorer)}` }
        })
      ).json()) as GameDetail
      const first = read.plays[0].gumbo as {
        teamStation: { setupBefore: GameSetup }
      }
      const setup = first.teamStation.setupBefore
      const teams = teamsOf(detail)

      // The fixture numbers the visitors' batters 1–9 by slot and the hosts'
      // fielders 10–18 by position: the same slot or position here is the
      // same player.
      const idOf = new Map<number, number>()
      setup.sides.away.battingOrder.forEach((id, slot) => {
        idOf.set(slot + 1, id)
      })
      POSITIONS.forEach((position, index) => {
        const id = setup.sides.home.defense[position]
        if (id != null) idOf.set(10 + index, id)
      })
      const mapped = <T extends FielderRef>(id: T): T => {
        // A stand-in's position is no fixture id.
        if (typeof id !== 'number') return id
        const found = idOf.get(id) as T | undefined
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
          (row.gumbo as { teamStation?: { actions: ScoringAction[] } })
            .teamStation?.actions ?? []
      )
      const placed = tappedActions.filter(
        action =>
          (action.type === 'ballInPlay' && action.location != null) ||
          (action.type === 'runnerMovement' && action.locations != null)
      )
      const script = (
        JSON.parse(
          readFileSync(
            join(
              __dirname,
              '../../../../src/common/scoring/fixtures/halfInning.actions.json'
            ),
            'utf8'
          )
        ) as unknown[]
      ).flatMap((entry): ScoringAction[] => {
        const cleaned = dictatedAction(
          String((entry as { type?: unknown }).type),
          entry
        )
        if ('problem' in cleaned) throw new Error(cleaned.problem.message)
        const action = cleaned.action
        // A tapped ground out sends the runner on first to second itself: the
        // script's ground out carries that advance in place of its own.
        if (
          action.type === 'result' &&
          action.eventType === 'field_out' &&
          action.outBy === 'throw'
        )
          return [{ ...action, advance: 'ground' }]
        if (action.type === 'runnerMovement' && action.reason === 'Advance')
          return []
        if (action.type === 'ballInPlay' && action.location != null) {
          const from = placed.shift()
          if (from?.type !== 'ballInPlay') throw new Error('No tapped hit')
          return [
            {
              ...action,
              fielder: mapped(action.fielder!),
              location: from.location
            }
          ]
        }
        if (action.type === 'runnerMovement') {
          const from = action.locations == null ? undefined : placed.shift()
          return [
            {
              ...action,
              runner: mapped(action.runner),
              ...(action.fielders == null
                ? {}
                : { fielders: action.fielders.map(mapped) }),
              ...(from?.type === 'runnerMovement'
                ? {
                    locations: from.locations,
                    runnerLocation: from.runnerLocation
                  }
                : {})
            }
          ]
        }
        return [action]
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
        await ScoringSession.open(store, gameId, {
          gamePk: gameId,
          teams,
          setup
        })
      ).state
      expect(
        tapped.liveData.plays.allPlays.map(play => play.result.eventType)
      ).deep.equals(['single', 'strikeout', 'field_out', 'field_out'])
      expect(
        tapped.liveData.plays.allPlays.map(play => comparablePlay(play))
      ).deep.equals(
        dictated.liveData.plays.allPlays.map(play => comparablePlay(play))
      )
      expect(tapped.liveData.linescore).deep.equals(dictated.liveData.linescore)
      expect(tapped.liveData.boxscore).deep.equals(dictated.liveData.boxscore)
    },
    // Scenario 4: the game survives a reload in the middle of an at-bat.
    'reload-mid-at-bat': async ctx => {
      begin(ctx)
      const fixture = await scoringGame()
      const gameId = fixture.games[0]
      let page = await openAs(scorer, `/games/${gameId}`)
      try {
        await openScoring(page)
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
          teamStation: { actions: Array<{ type: string }> }
        }
        expect(current.about).deep.include({ isComplete: false, atBatIndex: 0 })
        expect(current.playEvents).length(2)
        expect(
          current.teamStation.actions.map(action => action.type)
        ).deep.equals(['lineup', 'pitch', 'pitch'])
        expect(
          await sql(`select count(*) from events where "gameId"='${gameId}'`)
        ).equals('0')
        expect(
          await sql(`select status from games where id='${gameId}'`)
        ).equals('inProgress')
        const before = await summary(page)
        await page.close()
        page = await openAs(scorer, `/games/${gameId}`)
        await page.waitForSelector('[aria-label="Score"]')
        expect(await page.$('[aria-label="Continue Scoring"]')).equals(null)
        // The game page keeps a connection open, so its load event can wait
        // for ever: the reload is done once the document is.
        await page.reload({ waitUntil: 'domcontentloaded' })
        await openScoring(page)
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
    },
    // Scenario 5: offline scoring, a refused scorer, and ending and correcting the game.
    'offline-refused-end-correct': async ctx => {
      begin(ctx)
      const fixture = await scoringGame()
      const gameId = fixture.games[0]
      let page = await openAs(scorer, `/games/${gameId}`)
      try {
        await openScoring(page)
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
          await sql(`select count(*) from events where "gameId"='${gameId}'`)
        ).equals('1')

        // Somebody who can see the game and scores for neither team: the game
        // page offers them no Score pill, and the scorer's own address
        // opens read-only.
        const viewing = await openAs(viewer, `/games/${gameId}`)
        await viewing.waitForSelector('[aria-label="Box score"]')
        expect(await viewing.$('[aria-label="Score"]')).equals(null)
        await viewing.close()
        const refused = await openAs(viewer, `/games/${gameId}/score`)
        await refused.waitForSelector('canvas[data-field-ready="true"]', {
          timeout: 30000
        })
        if ((await refused.$('[aria-label="OK"]')) != null) {
          await click(refused, 'OK')
        }
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
          await sql(`select count(*) from events where "gameId"='${gameId}'`)
        ).equals('1')

        // Return to the scorer's tab to finish the at-bat and end the game.
        await page.bringToFront()
        await click(page, 'Undo Ball')
        await waitReady(page)
        await click(page, 'Open scoring menu')
        await click(page, 'End Game')
        await click(page, 'Confirm End Game')
        await page.waitForSelector('[aria-label="Game over"]')
        await waitSaved(page)
        expect(
          await sql(`select status from games where id='${gameId}'`)
        ).equals('final')
        expect(
          await sql(
            `select "eventType" from events where "gameId"='${gameId}' and "atBatIndex"=9999`
          )
        ).equals('final_score')
        expect(
          await sql(
            `select "currentPlay" is null from games where id='${gameId}'`
          )
        ).equals('t')
        const final = await summary(page)
        const ball = '[aria-label="Ball"]'
        expect(
          await page.$eval(ball, node =>
            node.matches(':disabled, [aria-disabled="true"]')
          )
        ).equals(true)
        await page.locator(ball).setWaitForEnabled(false).click()
        expect(await summary(page)).equals(final)
        const singleId = await sql(
          `select id from events where "gameId"='${gameId}' and "atBatIndex"=0`
        )
        await page.close()

        // Taken up again: undo the end, open the single again, and correct it.
        page = await openAs(scorer, `/games/${gameId}`)
        await openScoring(page)
        await click(page, 'Undo Last play')
        await page.waitForSelector('[aria-label="Game over"]', { hidden: true })
        await waitSaved(page)
        expect(
          await sql(`select status from games where id='${gameId}'`)
        ).equals('inProgress')
        expect(
          await sql(
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
          await sql(
            `select "currentPlay"->'about'->>'atBatIndex' from games where id='${gameId}'`
          )
        ).equals('0')
        expect(
          await sql(
            `select id from events where "gameId"='${gameId}' and "atBatIndex"=0`
          )
        ).equals(singleId)
        await dropRunner(page.field(), 1, 'Safe')
        await click(page, 'Finish at-bat')
        await waitReady(page)
        await click(page, 'Open scoring menu')
        await click(page, 'End Game')
        await click(page, 'Confirm End Game')
        await page.waitForSelector('[aria-label="Game over"]')
        await waitSaved(page)
        expect(
          await sql(
            `select status||' '||ingest_status from games where id='${gameId}'`
          )
        ).equals('final ok')
        expect(
          await sql(
            `select id from events where "gameId"='${gameId}' and "atBatIndex"=0`
          )
        ).equals(singleId)
        const corrected = await sql(
          `select gumbo->'runners'->-1->'movement'->>'end' from events where id='${singleId}'`
        )
        expect(['2B', '3B', 'score']).includes(corrected)
        expect(
          await sql(
            `select count(*) from events where "gameId"='${gameId}' and "atBatIndex"=9999`
          )
        ).equals('1')
      } finally {
        await page.close()
      }
    },
    // Scenario 6: a half scored in the browser builds stat lines from Gumbo runners.
    'gumbo-stat-lines': async ctx => {
      begin(ctx)
      const fixture = await scoringGame()
      const gameId = fixture.games[0]
      const [b1, b2, b3, b4, b5] = fixture.away
      const pitcher = fixture.home[0]
      const page = await openAs(scorer, `/games/${gameId}`)
      try {
        await openScoring(page)
        await click(page, 'Open scoring menu')
        await click(page, 'Set Team Rosters')
        await click(page, 'Save Rosters')
        // A single.
        await pitch(page, 'Ball')
        await hitTo(page, 'Single', 'CF', 15)
        await finishAtBat(page)
        // A steal of second, then a double that scores him.
        await pitch(page, 'Ball')
        await waitReady(page)
        await dropRunner(page.field(), 1, 'Safe')
        await click(page, 'Steal')
        await waitReady(page)
        await hitTo(page, 'Double', 'RF', 20)
        await decideHome(page)
        await finishAtBat(page)
        // A wild pitch takes the runner to third, and a strikeout.
        await pitch(page, 'Ball')
        await waitReady(page)
        await dropRunner(page.field(), 2, 'Safe')
        await click(page, 'Wild Pitch')
        // The ball just pitched was the wild pitch.
        await click(page, 'Use previous pitch as wild pitch')
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
        await hitTo(page, 'Ground Out', 'SS', -10)
        await page.waitForSelector(
          '[aria-label^="Tap or drag the next defender"]'
        )
        await placeDefender(page, '1B')
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
        await sql(
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
        status = await sql(
          `select status from game_stats_state where game_id='${gameId}'`
        )
        if (status !== 'built')
          await new Promise(resolve => setTimeout(resolve, 1000))
      }
      expect(status).equals('built')
      const figures = async (gumboId: number): Promise<string> =>
        await sql(
          `select concat_ws(' ', pa, ab, h, doubles, r, rbi, sb, k, pitch_bf, pitch_outs, pitch_k, pitch_r, pitch_er) from game_player_stats where game_id='${gameId}' and gumbo_id=${gumboId}`
        )
      // pa ab h 2b r rbi sb k | bf outs k r er
      expect(await figures(b1)).equals('1 1 1 0 1 0 1 0 0 0 0 0 0')
      expect(await figures(b2)).equals('1 1 1 1 1 1 0 0 0 0 0 0 0')
      expect(await figures(b3)).equals('1 1 0 0 0 0 0 1 0 0 0 0 0')
      expect(await figures(b4)).equals('1 1 0 0 0 0 0 0 0 0 0 0 0')
      expect(await figures(b5)).equals('1 1 0 0 0 0 0 0 0 0 0 0 0')
      // Two runs off the starter: the error's unearned.
      expect(await figures(pitcher)).equals('0 0 0 0 0 0 0 0 5 2 1 2 1')
    },
    // Scenario 7: pitches and actions are stored in Gumbo shape, and undone to what was stored.
    'gumbo-shape-undo': async ctx => {
      begin(ctx)
      const fixture = await scoringGame()
      const gameId = fixture.games[0]
      const page = await openAs(scorer, `/games/${gameId}`)
      let before: Stored | null = null
      let scored: Stored | null = null
      let undone: Stored | null = null
      try {
        await openScoring(page)
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
          await sql(
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
      expect(dropped.runners[0].movement).deep.include({
        start: null,
        end: '1B'
      })
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
      expect(plays(undone).map(play => comparablePlay(play))).deep.equals(
        plays(before).map(play => comparablePlay(play))
      )
      expect(comparablePlay(undone.currentPlay)).deep.equals(
        comparablePlay(before.currentPlay)
      )
      expect(
        await sql(`select count(*) from events where "gameId"='${gameId}'`)
      ).equals('2')
    },
    // Scenario 8: substitutions are stored as feed actions, and do not hold the game open.
    'substitutions-feed-actions': async ctx => {
      begin(ctx)
      const fixture = await scoringGame()
      const gameId = fixture.games[0]
      const page = await openAs(scorer, `/games/${gameId}`)
      /** A persisted team player created on the side the roster sheet shows. */
      const createPlayer = async (
        first: string,
        last: string
      ): Promise<RosterEntry> => {
        await click(page, 'Create Player')
        await page.locator('[aria-label="First Name"]').fill(first)
        await page.locator('[aria-label="Last Name"]').fill(last)
        const response = page.waitForResponse(
          response =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname.endsWith('/roster-players')
        )
        await click(page, 'Create Player')
        await page.waitForSelector('[aria-label="First Name"]', {
          hidden: true
        })
        const created = await response
        expect(created.status()).equals(201)
        return (await created.json()) as RosterEntry
      }
      const menuItemDisabled = async (label: string): Promise<boolean> =>
        await page.$eval(
          `[aria-label="${label}"]`,
          node => node.getAttribute('aria-disabled') === 'true'
        )
      const publicLabel = (entry: RosterEntry): string =>
        entry.compactName ?? entry.shortName
      let starter = ''
      let dueBatter = ''
      let pinchPlayer!: RosterEntry
      let reliefPlayer!: RosterEntry
      try {
        await openScoring(page)
        await click(page, 'Open scoring menu')
        await click(page, 'Set Team Rosters')
        await click(page, 'Save Rosters')
        // One pitch to the leadoff man.
        await pitch(page, 'Ball')
        await waitReady(page)
        const board = await summary(page)
        dueBatter = /Batter (.+?) (left|right) handed/.exec(board)![1]
        starter = / · Pitcher (.+?)(?: · |$)/.exec(board)![1]
        // A pinch hitter for him, and a new pitcher, saved together.
        await click(page, 'Open scoring menu')
        await click(page, 'Set Team Rosters')
        pinchPlayer = await createPlayer('Mookie', 'Betts')
        // After the first pitch a bench player dropped on a lineup row
        // replaces the man there: held, then dropped on the batter due.
        await click(page, 'Lineup')
        const bench = (await (await page.waitForSelector(
          `[aria-label="Add ${publicLabel(pinchPlayer)} to Lineup"]`
        ))!.boundingBox())!
        const due = (await (await page.waitForSelector(
          `[aria-label="Reorder ${dueBatter}"]`
        ))!.boundingBox())!
        await page.mouse.move(
          bench.x + bench.width / 2,
          bench.y + bench.height / 2
        )
        await page.mouse.down()
        await new Promise(resolve => setTimeout(resolve, 700))
        await page.mouse.move(due.x + due.width / 2, due.y + due.height / 2, {
          steps: 20
        })
        await new Promise(resolve => setTimeout(resolve, 200))
        await page.mouse.up()
        // In the browser, so no optional chaining: the test's compiler would
        // call a helper the page does not have.
        await page.waitForFunction(
          label => {
            const first = document.querySelector('[aria-label^="Reorder "]')
            return first === null
              ? false
              : first.getAttribute('aria-label') === `Reorder ${label}`
          },
          {},
          publicLabel(pinchPlayer)
        )
        await click(page, 'Home Team')
        // Players are made on the roster, and pitch from the defense.
        await click(page, 'Roster')
        reliefPlayer = await createPlayer('Mariano', 'Rivera')
        await click(page, 'Defense')
        // Held, then dragged onto the mound.
        const from = await page.waitForSelector(
          `[aria-label="${publicLabel(reliefPlayer)}"]`
        )
        await from!.scrollIntoView()
        const start = (await from!.boundingBox())!
        const mound = (await (await page.$(
          '[data-roster-target="defense-P"]'
        ))!.boundingBox())!
        await page.mouse.move(
          start.x + start.width / 2,
          start.y + start.height / 2
        )
        await page.mouse.down()
        await new Promise(resolve => setTimeout(resolve, 700))
        await page.mouse.move(
          mound.x + mound.width / 2,
          mound.y + mound.height / 2,
          { steps: 12 }
        )
        await page.mouse.up()
        await page.waitForFunction(() => {
          const mound = document.querySelector(
            '[data-roster-target="defense-P"]'
          )
          return mound === null
            ? false
            : String(mound.textContent).includes('Mariano')
        })
        await click(page, 'Save Rosters')
        await waitReady(page)
        const changed = await summary(page)
        expect(changed).includes(`Batter ${publicLabel(pinchPlayer)}`)
        expect(changed).includes(`Pitcher ${publicLabel(reliefPlayer)}`)
        // He walks, in the count his man left.
        for (let i = 0; i < 3; i++) await pitch(page, 'Ball')
        await finishAtBat(page)
        await waitReady(page)
        // End Game is available with a pitch in the next appearance.
        await pitch(page, 'Ball')
        await waitReady(page)
        await click(page, 'Open scoring menu')
        expect(await menuItemDisabled('End Game')).equals(false)
        await click(page, 'Dismiss scoring menu')
        // Undo the pitch so the stored book ends with the walk.
        await page.locator('[aria-label^="Undo "]').click()
        await waitReady(page)
        await waitSaved(page)
        await click(page, 'Open scoring menu')
        expect(await menuItemDisabled('End Game')).equals(false)
        await click(page, 'End Game')
        await click(page, 'Confirm End Game')
        await page.waitForSelector('[aria-label="Game over"]')
        await waitSaved(page)
      } finally {
        await page.close()
      }

      expect(await sql(`select status from games where id='${gameId}'`)).equals(
        'final'
      )
      expect(
        await sql(
          `select string_agg("eventType", ',' order by "atBatIndex") from events where "gameId"='${gameId}'`
        )
      ).equals('walk,final_score')
      interface Event {
        isPitch: boolean
        isSubstitution?: boolean
        details: Record<string, unknown>
        count: { balls: number; strikes: number }
        player: { id?: number; fullName: string }
        position?: Record<string, unknown>
        battingOrder?: string
        replacedPlayer?: { id?: number; fullName: string }
      }
      // As a reader is served it: kept without names, named from the
      // accounts by their public labels.
      const play = (await stored(scorer, gameId)).plays.find(
        row =>
          (row.gumbo as { about: { atBatIndex: number } }).about.atBatIndex ===
          0
      )!.gumbo as {
        playEvents: Event[]
        matchup: Record<string, unknown>
        actionIndex: number[]
      }
      const events = play.playEvents.map(event =>
        event.isPitch
          ? `pitch ${String(event.details.code)} ${event.count.balls}-${event.count.strikes}`
          : `${String(event.details.eventType)} ${event.count.balls}-${event.count.strikes}`
      )
      expect(events).deep.equals([
        'pitch B 1-0',
        'pitching_substitution 1-0',
        'offensive_substitution 1-0',
        'pitch B 2-0',
        'pitch B 3-0',
        'pitch B 4-0'
      ])
      expect(play.actionIndex).deep.equals([1, 2])
      const [pitching, pinch] = play.playEvents.slice(1, 3)
      // A served play names its players by gumbo id and public label: the
      // roster entry reads the scorer their full name, and that label beside it.
      expect(pitching).deep.include({
        isSubstitution: true,
        player: {
          id: reliefPlayer.gumboId,
          fullName: publicLabel(reliefPlayer)
        },
        position: {
          code: '1',
          name: 'Pitcher',
          type: 'Pitcher',
          abbreviation: 'P'
        }
      })
      expect(pitching).not.have.property('battingOrder')
      expect(pitching).not.have.property('replacedPlayer')
      // The starter is a fixture player with no account (`Host 01`). The
      // board draws him as its reader may read him, in full or short; the feed
      // names him as it does on his own first pitch, and so must the change.
      expect(play.playEvents[0].player.id).equals(fixture.home[0])
      const starterLabel = play.playEvents[0].player.fullName
      expect(starterLabel, 'the starter on the first pitch').match(/^Host /)
      expect(starter, "the board's starter").match(/^Host /)
      expect(pitching.details).deep.include({
        event: 'Pitching Substitution',
        description: `Pitching Change: ${publicLabel(reliefPlayer)} replaces ${starterLabel}.`
      })
      expect(pinch).deep.include({
        isSubstitution: true,
        player: { id: pinchPlayer.gumboId, fullName: publicLabel(pinchPlayer) },
        battingOrder: '101'
      })
      expect(pinch.position).deep.include({ code: '11', abbreviation: 'PH' })
      // The batter he replaces is a fixture player too (`Visitor 01`), named as
      // the feed names him, whatever form the board drew him in.
      expect(pinch.replacedPlayer!.id).equals(fixture.away[0])
      const replaced = pinch.replacedPlayer!.fullName
      expect(replaced, 'the replaced batter').match(/^Visitor /)
      expect(dueBatter, "the board's batter").match(/^Visitor /)
      expect(pinch.details).deep.include({
        event: 'Offensive Substitution',
        description: `Offensive Substitution: Pinch-hitter ${publicLabel(pinchPlayer)} replaces ${replaced}.`
      })
      // The reliever was created with a right arm, so the hand is known.
      expect(play.matchup).deep.include({
        batter: { id: pinchPlayer.gumboId, fullName: publicLabel(pinchPlayer) },
        pitcher: {
          id: reliefPlayer.gumboId,
          fullName: publicLabel(reliefPlayer)
        },
        pitchHand: { code: 'R', description: 'Right' }
      })
      console.log(`      pitching: ${String(pitching.details.description)}`)
      console.log(`      pinch: ${String(pinch.details.description)}`)
    }
  }
})
