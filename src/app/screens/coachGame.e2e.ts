import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/* eslint-disable @typescript-eslint/prefer-optional-chain --
   The functions puppeteer runs in the page are transpiled by sucrase, which
   turns ?. and ?? into helpers the page does not have. */
import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import type { Page } from 'puppeteer'

import { DEFAULT_DICTATION_MODEL, TeamStationClient } from '../../common/api'
import type { ScoringAction } from '../../common/scoring/actions'
import { ScoringSession } from '../../common/scoring/session'
import { startingSetup, teamsOf } from '../../common/scoring/startingSetup'
import { type GameState, setupOf } from '../../common/scoring/state'
import type { LineupFixture } from '../../server/dev/lineupFixture'
import { fakeMicrophone } from '../../test/fakeMicrophone.e2e'
import { signInTestAccount } from '../../test/passwordFixtures'
import {
  type BrowserSession,
  browserSession,
  maestro
} from '../../test/refinementsMaestro.e2e'

/**
 * Coach Game end to end: a head coach's own team in a game, in maestro-d's
 * Chromium at an iPhone's 402×874, against the real local stack — the API
 * with its game socket (`npm start`), the web app built against it (`npm run
 * start.web`) and a game from `npm run lineup-fixture`, made afresh for each
 * scenario. One browser, one tab: the coach, the scorekeeper, the assistant
 * and the member take turns in it. The plays and the scorekeeper's lineup a
 * scenario needs while the coach's screen is open are scored from here,
 * through the API, as the scorekeeper's own session would post them.
 *
 *   MAESTRO_D=<daemon> MAESTRO_D_BIN=… TS_MAESTRO_D_CLIENT=… \
 *   TS_SCORING_TEST_URL=http://127.0.0.1:8180 \
 *   TS_API_TEST_URL=http://127.0.0.1:9180/api/v1 \
 *   TS_LINEUP_PASSWORD=<the fixture's password> \
 *     node_modules/.bin/mocha -r sucrase/register --extension ts \
 *     --timeout 180000 src/app/screens/coachGame.e2e.ts
 *
 * `TS_LINEUP_ARTIFACTS=<dir>` saves the pills (`game-pills-after.png`), the
 * box score (`coach-boxscore.png`, and `coach-boxscore-pregame.png` before
 * the first pitch) and the dictated lineup with its chat
 * (`coach-lineup-chat.png`) there. C5 plays `lineupJudgeFourth.wav` through
 * the page's microphone (`fakeMicrophone`) as the away team's head coach,
 * whose team Judge plays on; the recogniser and the model are the API's
 * real ones, and the sentence names the default model, Claude Haiku 5.5.
 */
const APP = process.env.TS_SCORING_TEST_URL ?? 'http://127.0.0.1:8180'
const API = process.env.TS_API_TEST_URL ?? 'http://127.0.0.1:9180/api/v1'
const PASSWORD = process.env.TS_LINEUP_PASSWORD ?? ''
const ARTIFACTS = process.env.TS_LINEUP_ARTIFACTS
const WIDTH = 402
const HEIGHT = 874
const CLIPS = resolve('src/app/scoring/fixtures/audio')
const BANNER =
  'Another user has edited the roster. Your pending changes may overwrite theirs. Hit Cancel to revert to their changes.'
const ROSTER_MIC = '[data-testid="Roster mic"] [aria-label="Dictation"]'
const MIC_STATUS = '[data-testid="Roster mic"] [aria-label="Dictation status"]'

type Person = keyof LineupFixture['users']

/** Each side's batting order as the fixture's game opens: its first nine. */
const HOSTS = [
  'Ohtani',
  'Lindor',
  'Alonso',
  'Nimmo',
  'Marte',
  'McNeil',
  'Escobar',
  'Canha',
  'Senga'
]
const VISITORS = [
  'Judge',
  'Altuve',
  'Bregman',
  'Alvarez',
  'Tucker',
  'Pena',
  'Diaz',
  'Maldonado',
  'Valdez'
]

/** `names` appear in `text` one after another, each once at least. */
function inOrder(text: string, names: readonly string[]): void {
  let last = -1
  for (const name of names) {
    const index = text.indexOf(name, last + 1)
    expect(index, name).greaterThan(last)
    last = index
  }
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
 * Scores into the game as the scorekeeper's session does, through the API:
 * the game opens on the teams' default lineups, as the scoring screen's.
 * `actions` may be read off the game as it stands.
 */
async function score(
  fixture: LineupFixture,
  actions: ScoringAction[] | ((game: GameState) => ScoringAction[])
): Promise<void> {
  const client = new TeamStationClient({
    baseUrl: API,
    token: await tokenOf(fixture, 'scorekeeper')
  })
  const game = await client.game(fixture.gameId)
  const [away, home, awayDefault, homeDefault] = await Promise.all([
    client.roster(game.awayTeamId),
    client.roster(game.homeTeamId),
    client.defaultLineup(game.awayTeamId),
    client.defaultLineup(game.homeTeamId)
  ])
  const session = await ScoringSession.open(
    {
      load: async id => await client.gameEvents(id),
      save: async (id, change) => await client.saveGameEvents(id, change)
    },
    game.id,
    {
      gamePk: game.id,
      teams: teamsOf(game),
      setup: startingSetup(
        game,
        away,
        home,
        { away: awayDefault.lineup, home: homeDefault.lineup },
        false
      ),
      fenceDistanceFt: game.fenceDistanceFt
    },
    { requireCurrentSetup: true }
  )
  const list = typeof actions === 'function' ? actions(session.state) : actions
  for (const action of list)
    expect(session.apply(action).problems, JSON.stringify(action)).deep.equals(
      []
    )
  await session.flush()
  expect(session.problem).equals(null)
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
    page.on('console', message => {
      if (message.text().includes('Maximum update depth'))
        this.errors.push(message.text())
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

  async tap(label: string, role?: string): Promise<void> {
    const css =
      role == null
        ? `[aria-label="${label}"]`
        : `[aria-label="${label}"][role="${role}"]`
    await this.page.waitForSelector(css)
    await this.session.m.tapOn({ css, timeout: 15000 })
  }

  async tapEnabled(label: string): Promise<void> {
    await this.page.waitForFunction(
      label => {
        const node = document.querySelector(`[aria-label="${label}"]`)
        return node != null && node.getAttribute('aria-disabled') !== 'true'
      },
      { timeout: 30000 },
      label
    )
    await this.tap(label)
  }

  async box(
    selector: string
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    await this.page.waitForSelector(selector)
    return await this.page.$eval(selector, node => {
      const r = node.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
  }

  /** The game's page, its pills read left to right. */
  async pills(gameId: string): Promise<string[]> {
    await this.page.goto(`${APP}/games/${gameId}`, {
      waitUntil: 'domcontentloaded'
    })
    await this.page.waitForSelector('[aria-label="Game sections"]', {
      timeout: 60000
    })
    // The pills that depend on the game come with it, and its teams' names.
    await this.page.waitForFunction(
      () => String(document.body.textContent).includes('Hosts'),
      { timeout: 30000 }
    )
    await new Promise(resolve => setTimeout(resolve, 300))
    return await this.page.$$eval(
      '[aria-label="Game sections"] [role="tab"], [aria-label="Game sections"] [role="button"]',
      nodes => nodes.map(node => String(node.getAttribute('aria-label')))
    )
  }

  /** Coach Game, opened from the game's pill. */
  async coachGame(gameId: string): Promise<void> {
    await this.pills(gameId)
    await this.tap('Coach Game')
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

  /** The scorekeeper's roster sheet, on the home team's Lineup tab. */
  async openRosters(): Promise<void> {
    await this.tap('Open scoring menu')
    await this.tap('Set Team Rosters')
    await this.page.waitForSelector('[aria-label="Save Rosters"]', {
      timeout: 30000
    })
    await this.tap('Home Team', 'tab')
    await this.tap('Lineup', 'tab')
    await this.page.waitForSelector('[data-roster-target="lineup-0"]')
  }

  /** The batting order shown, by name. */
  async lineup(): Promise<string[]> {
    return await this.page.$$eval(
      '[data-roster-target^="lineup-"][data-roster-player]',
      nodes =>
        nodes.map(node =>
          String(node.textContent)
            .replace(/^\D*\d+\. (#\S+ )?/, '')
            .replace(/\W+$/, '')
        )
    )
  }

  async waitLineup(names: string[]): Promise<void> {
    await this.page.waitForFunction(
      names => {
        const shown = [
          ...document.querySelectorAll(
            '[data-roster-target^="lineup-"][data-roster-player]'
          )
        ].map(node =>
          String(node.textContent)
            .replace(/^\D*\d+\. (#\S+ )?/, '')
            .replace(/\W+$/, '')
        )
        return JSON.stringify(shown) === JSON.stringify(names)
      },
      { timeout: 15000 },
      names
    )
  }

  async saveDisabled(): Promise<boolean> {
    return await this.page.$eval(
      '[aria-label="Save Rosters"]',
      node => node.getAttribute('aria-disabled') === 'true'
    )
  }

  async waitSave(disabled: boolean): Promise<void> {
    await this.page.waitForFunction(
      disabled =>
        document
          .querySelector('[aria-label="Save Rosters"]')!
          .getAttribute('aria-disabled') === (disabled ? 'true' : null),
      { timeout: 15000 },
      disabled
    )
  }

  async tabOn(label: string): Promise<void> {
    await this.page.waitForSelector(
      `[aria-label="${label}"][role="tab"][aria-selected="true"]`,
      { timeout: 15000 }
    )
  }

  async text(): Promise<string> {
    return await this.page.evaluate(() => String(document.body.textContent))
  }

  /**
   * A mouse drag of the lineup row at `source` to the boundary after
   * `target`: the press is held until the row lifts.
   */
  async dragAfter(source: number, target: number): Promise<void> {
    const at = async (
      index: number,
      where: 'bottom' | 'middle'
    ): Promise<{ x: number; y: number }> => {
      const r = await this.box(`[data-roster-target="lineup-${index}"]`)
      return {
        x: r.x + Math.min(40, r.width / 2),
        y: where === 'bottom' ? r.y + r.height - 8 : r.y + r.height / 2
      }
    }
    const start = await at(source, 'middle')
    await this.page.mouse.move(start.x, start.y)
    await this.page.mouse.down()
    await new Promise(resolve => setTimeout(resolve, 750))
    const end = await at(target, 'bottom')
    await this.page.mouse.move(end.x, end.y, { steps: 12 })
    await new Promise(resolve => setTimeout(resolve, 200))
    await this.page.mouse.up()
    await new Promise(resolve => setTimeout(resolve, 300))
  }

  /** Every save has gone out and come back. */
  async waitSaved(): Promise<void> {
    await this.page.waitForNetworkIdle({ idleTime: 300, timeout: 30000 })
    await this.page.waitForFunction(
      () => document.querySelector('[aria-label="Save status"]') == null,
      { timeout: 30000 }
    )
  }

  async shot(name: string): Promise<void> {
    if (ARTIFACTS == null) return
    await this.session.m.waitForAnimationToEnd()
    await writeFile(join(ARTIFACTS, name), await this.session.m.screenshot())
  }
}

describe('Coach Game', function () {
  let daemon: Awaited<ReturnType<typeof maestro>>
  /** The one browser, whoever is signed in to it. */
  let coach: Browser
  const used: string[] = []

  before(async function () {
    if (PASSWORD === '')
      throw new Error('Supply TS_LINEUP_PASSWORD, the lineup fixture password')
    for (const url of [APP, API])
      if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
        throw new Error(`${url} must be a local server`)
    if (ARTIFACTS != null) await mkdir(ARTIFACTS, { recursive: true })
    daemon = await maestro(process.env.MAESTRO_D ?? 'lineupDictation')
    const support = join(tmpdir(), 'coach-game-e2e')
    const session = await browserSession(
      daemon,
      'coach-game-coach',
      WIDTH,
      HEIGHT,
      support
    )
    session.page.setDefaultTimeout(30000)
    coach = new Browser(session, session.page)
    // A silent microphone C5 plays its clip into, and every dictation frame
    // both ways, for what the API was asked and answered.
    await coach.page.evaluateOnNewDocument(fakeMicrophone, '')
    await coach.page.evaluateOnNewDocument(() => {
      const heard = { sent: [] as unknown[], received: [] as unknown[] }
      ;(window as any).__dictation = heard
      const Native = window.WebSocket
      const json = (data: unknown): unknown => {
        try {
          return JSON.parse(String(data))
        } catch {
          return null
        }
      }
      class Watched extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          if (!String(url).endsWith('/dictation')) return
          this.addEventListener('message', event => {
            heard.received.push(json(event.data))
          })
        }

        send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
          if (typeof data === 'string' && this.url.endsWith('/dictation'))
            heard.sent.push(json(data))
          super.send(data)
        }
      }
      window.WebSocket = Watched
    })
  })

  after(async function () {
    if (used.length > 0) console.log(`    models: ${used.join('; ')}`)
    if (coach != null && coach.errors.length > 0)
      console.log(`    browser errors: ${coach.errors.join('\n')}`)
    await coach?.session.m.detach()
    await daemon?.shutdown()
  })

  it('C1: puts Coach Game in the head coach’s pills after Videos, and in nobody else’s', async function () {
    const fixture = lineupFixture()
    await coach.as(fixture, 'headCoach')
    const pills = await coach.pills(fixture.gameId)
    expect(pills.slice(0, 3)).deep.equals(['Box score', 'Videos', 'Coach Game'])
    for (const later of pills.slice(3))
      expect(['DJ Game', 'Settings']).includes(later)
    await coach.shot('game-pills-after.png')
    for (const who of ['assistant', 'member'] as const) {
      await coach.as(fixture, who)
      const theirs = await coach.pills(fixture.gameId)
      expect(theirs, who).not.includes('Coach Game')
      expect(theirs.slice(0, 2), who).deep.equals(['Box score', 'Videos'])
    }
    // The scorekeeper scores, and coaches nothing.
    await coach.as(fixture, 'scorekeeper')
    const scorer = await coach.pills(fixture.gameId)
    expect(scorer).includes('Score Game')
    expect(scorer).not.includes('Coach Game')
  })

  it('C2: opens full screen with its own chevron, the team on the right, four tabs and the roster bar', async function () {
    const fixture = lineupFixture()
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    expect(new URL(coach.page.url()).pathname).equals(
      `/games/${fixture.gameId}/coach/${fixture.teams.home}`
    )
    // No app header or navigation: its own header row.
    expect(await coach.page.$('[aria-label="Schedule"]')).equals(null)
    const back = await coach.box('[aria-label="Back"]')
    expect(back.x).lessThan(40)
    const team = await coach.page.$eval(
      '[data-testid="Coach header"] [role="heading"]',
      node => {
        const r = node.getBoundingClientRect()
        return {
          text: node.textContent,
          align: getComputedStyle(node).textAlign,
          right: r.right
        }
      }
    )
    expect(team.text).equals('Hosts')
    expect(team.align).equals('right')
    expect(team.right).greaterThan(WIDTH - 40)
    expect(await coach.page.$('[aria-label="Away Team"]')).equals(null)
    expect(await coach.page.$('[aria-label="Home Team"]')).equals(null)
    const tabs = await coach.page.$$eval('[role="tab"]', nodes =>
      nodes.map(node => String(node.getAttribute('aria-label')))
    )
    expect(tabs).deep.equals(['Box Score', 'Roster', 'Lineup', 'Defense'])
    // The bar, as the scorekeeper's: green Add Player text, the round mic
    // in the middle and taller than Save, Cancel under them.
    const bar = await coach.box('[data-testid="Roster footer bar"]')
    const add = await coach.box('[aria-label="Create Player"]')
    const mic = await coach.box('[data-testid="Roster mic"]')
    const save = await coach.box('[aria-label="Save Rosters"]')
    const cancel = await coach.box('[aria-label="Cancel"]')
    expect(await coach.text()).includes('Add Player')
    expect(add.x).lessThan(mic.x)
    expect(mic.x + mic.width).lessThan(save.x + 1)
    expect(mic.x + mic.width / 2).closeTo(bar.x + bar.width / 2, 1)
    expect(mic.height).closeTo(save.height + 12, 0.5)
    expect(cancel.y).greaterThan(save.y + save.height - 1)
    expect(bar.y + bar.height).lessThan(HEIGHT + 1)
  })

  it('C3: lists his team’s batters and pitchers first, then the opponent’s, under the line score', async function () {
    const fixture = lineupFixture()
    // Two half innings: three batters a side struck out looking.
    await score(fixture, [
      ...Array.from(
        { length: 18 },
        () => ({ type: 'pitch', call: 'C' }) as const
      ),
      { type: 'gameFlow', kind: 'closePlay' }
    ])
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    await coach.tabOn('Box Score')
    await coach.page.waitForFunction(
      () => String(document.body.textContent).includes('Pitching — Visitors'),
      { timeout: 30000 }
    )
    // The box score's own text: the other tabs' lists are in the page too.
    const text = await coach.page.$eval(
      '[data-testid="Roster box score"]',
      node => String(node.textContent)
    )
    const at = (words: string): number => {
      const index = text.indexOf(words)
      expect(index, words).greaterThan(-1)
      return index
    }
    expect(at('Hosts')).lessThan(at('Batting — Hosts'))
    expect(at('Batting — Hosts')).lessThan(at('Pitching — Hosts'))
    expect(at('Pitching — Hosts')).lessThan(at('Batting — Visitors'))
    expect(at('Batting — Visitors')).lessThan(at('Pitching — Visitors'))
    // His whole order: those who came up (Ohtani, Lindor, Alonso), then
    // the six yet to bat, in his order, on empty lines; nobody off the
    // bench. The visitors' the same way.
    const hosts = text.slice(at('Batting — Hosts'), at('Pitching — Hosts'))
    const visitors = text.slice(
      at('Batting — Visitors'),
      at('Pitching — Visitors')
    )
    inOrder(hosts, HOSTS)
    inOrder(visitors, VISITORS)
    expect(hosts).includes('Nimmo00000000–')
    expect(visitors).includes('Alvarez00000000–')
    for (const benched of ['Soto', 'Harper', 'Freeman'])
      expect(hosts, benched).not.includes(benched)
    await coach.shot('coach-boxscore.png')
  })

  it('C3, before the first pitch: lists his whole order under an empty line score that says the game has not started, and the opponent’s once it is held', async function () {
    const fixture = lineupFixture()
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    await coach.tabOn('Box Score')
    const boxText = async (has: string): Promise<string> => {
      await coach.page.waitForFunction(
        has =>
          String(
            document.querySelector('[data-testid="Roster box score"]')!
              .textContent
          ).includes(has),
        { timeout: 30000 },
        has
      )
      return await coach.page.$eval('[data-testid="Roster box score"]', node =>
        String(node.textContent)
      )
    }
    const text = await boxText('Batting — Hosts')
    const at = (words: string): number => {
      const index = text.indexOf(words)
      expect(index, words).greaterThan(-1)
      return index
    }
    expect(at('Visitors')).lessThan(at('The game has not started'))
    expect(at('Hosts')).lessThan(at('The game has not started'))
    expect(at('The game has not started')).lessThan(at('Batting — Hosts'))
    inOrder(text.slice(at('Batting — Hosts')), HOSTS)
    expect(text).includes('Ohtani00000000–')
    // Nobody has pitched, and the visitors' order is not the game's yet.
    expect(text).not.includes('Pitching')
    expect(text).not.includes('Batting — Visitors')
    await coach.shot('coach-boxscore-pregame.png')
    // The scorekeeper's session saves both lineups as they stand.
    await score(fixture, game => [
      { type: 'lineup', kind: 'roster', setup: setupOf(game) }
    ])
    const held = await boxText('Batting — Visitors')
    const hosts = held.indexOf('Batting — Hosts')
    const visitors = held.indexOf('Batting — Visitors')
    expect(hosts).greaterThan(-1)
    expect(hosts).lessThan(visitors)
    inOrder(held.slice(hosts, visitors), HOSTS)
    inOrder(held.slice(visitors), VISITORS)
    expect(held).not.includes('Pitching')
  })

  it('C4: saves his lineup before the game begins, stays, and the game stays scheduled', async function () {
    const fixture = lineupFixture()
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    await coach.tap('Lineup', 'tab')
    await coach.page.waitForSelector('[data-roster-target="lineup-0"]')
    // The game holds no lineup for his side yet: Save is lit as it stands.
    expect(await coach.saveDisabled()).equals(false)
    await coach.dragAfter(0, 2)
    const mine = await coach.lineup()
    expect(mine.slice(0, 3)).deep.equals(['Lindor', 'Alonso', 'Ohtani'])
    expect(await coach.saveDisabled()).equals(false)
    await coach.tapEnabled('Save Rosters')
    await coach.waitSave(true)
    expect(new URL(coach.page.url()).pathname).includes('/coach/')
    await coach.tabOn('Lineup')
    expect(await coach.lineup()).deep.equals(mine)
    // The scorekeeper has it.
    await coach.as(fixture, 'scorekeeper')
    await coach.scoreGame(fixture.gameId)
    await coach.openRosters()
    expect(await coach.lineup()).deep.equals(mine)
    await coach.tap('Cancel')
    // Not started by it: still scheduled, not live.
    const game = (await (
      await fetch(`${API}/games/${fixture.gameId}`, {
        headers: {
          Authorization: `Bearer ${await tokenOf(fixture, 'headCoach')}`
        }
      })
    ).json()) as { status: string }
    expect(game.status).equals('scheduled')
  })

  it('C5: stages a dictated lineup change on the Box Score tab, and Cancel discards it', async function () {
    const fixture = lineupFixture()
    // The visitors' head coach: Judge bats first for them.
    await coach.as(fixture, 'awayCoach')
    await coach.coachGame(fixture.gameId)
    await coach.tabOn('Box Score')
    const mic = await coach.box(ROSTER_MIC)
    await coach.page.mouse.click(mic.x + mic.width / 2, mic.y + mic.height / 2)
    const status = async (text: string): Promise<void> => {
      await coach.page.waitForFunction(
        (text, selector) => {
          const node = document.querySelector(selector)
          return node != null && node.textContent === text
        },
        { timeout: 30000 },
        text,
        MIC_STATUS
      )
    }
    await status('Push to talk')
    await coach.page.mouse.move(mic.x + mic.width / 2, mic.y + mic.height / 2)
    await coach.page.mouse.down()
    await status('Listening…')
    await coach.page.evaluate(
      async wav => {
        await (window as any).__playClip(wav)
      },
      readFileSync(join(CLIPS, 'lineupJudgeFourth.wav')).toString('base64')
    )
    await new Promise(resolve => setTimeout(resolve, 600))
    await coach.page.mouse.up()
    const answer = (await (
      await coach.page.waitForFunction(
        () => {
          const heard = (window as any).__dictation
          const starts = heard.sent.filter(
            (frame: any) => frame != null && frame.kind === 'start'
          )
          const start = starts[starts.length - 1]
          if (start == null) return null
          const answers = heard.received.filter(
            (frame: any) =>
              frame != null &&
              frame.id === start.id &&
              ['actions', 'ask', 'error'].includes(frame.kind)
          )
          return answers.length === 0
            ? null
            : { start, answer: answers[answers.length - 1] }
        },
        { timeout: 90000 }
      )
    ).jsonValue()) as { start: any; answer: any }
    console.log(
      `      lineupJudgeFourth (${String(answer.start.model)}): ${JSON.stringify(answer.answer)}`
    )
    used.push(`lineupJudgeFourth: ${String(answer.start.model)}`)
    expect(answer.start.model).equals(DEFAULT_DICTATION_MODEL)
    expect(answer.start.scope).equals('roster')
    expect(answer.start.target).deep.equals({
      gameId: fixture.gameId,
      side: 'away'
    })
    expect(answer.answer.kind).equals('actions')
    await coach.tabOn('Lineup')
    expect((await coach.lineup())[3]).equals('Judge')
    const lines = await coach.page.$$eval(
      '[data-testid="Roster chat line"]',
      nodes => nodes.map(node => String(node.textContent))
    )
    expect(lines).deep.equals(['Judge to 4th in the lineup'])
    expect(
      await coach.page.$eval('[data-testid="Roster chat said"]', node =>
        String(node.textContent)
      )
    ).equals(answer.answer.transcript)
    expect(await coach.saveDisabled()).equals(false)
    await coach.shot('coach-lineup-chat.png')
    await coach.tap('Cancel')
    await coach.page.waitForFunction(
      () => String(document.body.textContent).includes('Changes discarded'),
      { timeout: 15000 }
    )
    expect((await coach.lineup())[0]).equals('Judge')
    expect(new URL(coach.page.url()).pathname).includes('/coach/')
  })

  it('C6: asks before the chevron or the browser’s Back leaves staged changes', async function () {
    const fixture = lineupFixture()
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    await coach.tap('Lineup', 'tab')
    await coach.dragAfter(0, 2)
    const staged = await coach.lineup()
    const asked = async (): Promise<void> => {
      await coach.page.waitForFunction(
        () =>
          String(document.body.textContent).includes(
            'Discard unsaved roster changes?'
          ),
        { timeout: 15000 }
      )
    }
    await coach.tap('Back')
    await asked()
    await coach.tap('Keep editing')
    expect(new URL(coach.page.url()).pathname).includes('/coach/')
    expect(await coach.lineup()).deep.equals(staged)
    await coach.page.evaluate(() => {
      history.back()
    })
    await asked()
    await coach.tap('Keep editing')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(new URL(coach.page.url()).pathname).includes('/coach/')
    expect(await coach.lineup()).deep.equals(staged)
    await coach.tap('Back')
    await asked()
    await coach.tap('Discard')
    await coach.page.waitForSelector(
      '[aria-label="Box score"][aria-selected="true"]',
      { timeout: 30000 }
    )
    const url = new URL(coach.page.url())
    expect(url.pathname).equals(`/games/${fixture.gameId}`)
    expect(url.searchParams.get('tab')).equals('boxScore')
    // And the browser's Back, with a change staged, leaves on Discard too.
    await coach.tap('Coach Game')
    await coach.page.waitForSelector('[aria-label="Save Rosters"]')
    await coach.tap('Lineup', 'tab')
    await coach.dragAfter(0, 2)
    await coach.page.evaluate(() => {
      history.back()
    })
    await asked()
    await coach.tap('Discard')
    await coach.page.waitForSelector(
      '[aria-label="Box score"][aria-selected="true"]',
      { timeout: 30000 }
    )
  })

  it('C7: warns when the scorekeeper saves under his staged change, and Cancel takes theirs', async function () {
    const fixture = lineupFixture()
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    await coach.tap('Lineup', 'tab')
    await coach.page.waitForSelector('[data-roster-target="lineup-0"]')
    const before = await coach.lineup()
    await coach.tap('Remove Canha')
    const mine = await coach.lineup()
    expect(mine).not.includes('Canha')
    // The scorekeeper's session moves his leadoff to third and saves it.
    const theirs = [before[1], before[2], before[0], ...before.slice(3)]
    await score(fixture, game => {
      const order = [...game.liveData.boxscore.teams.home.battingOrder]
      order.splice(2, 0, order.shift()!)
      return [{ type: 'lineup', kind: 'battingOrder', side: 'home', order }]
    })
    await coach.page.waitForSelector('[data-testid="Roster conflict"]', {
      timeout: 15000
    })
    expect(
      await coach.page.$eval('[data-testid="Roster conflict"]', node =>
        String(node.textContent)
      )
    ).equals(BANNER)
    expect(await coach.lineup()).deep.equals(mine)
    await coach.tap('Cancel')
    await coach.waitLineup(theirs)
    expect(await coach.page.$('[data-testid="Roster conflict"]')).equals(null)
    expect(await coach.saveDisabled()).equals(true)
  })

  it('C8: keeps his staged change when the game refuses it mid-play', async function () {
    const fixture = lineupFixture()
    // The scorekeeper has a ball in play, waiting for its result.
    await score(fixture, [
      { type: 'pitch', call: 'B' },
      { type: 'ballInPlay', contact: 'swing' }
    ])
    await coach.as(fixture, 'headCoach')
    await coach.coachGame(fixture.gameId)
    await coach.tap('Lineup', 'tab')
    await coach.page.waitForSelector('[data-roster-target="lineup-0"]')
    await coach.dragAfter(0, 2)
    const staged = await coach.lineup()
    await coach.tapEnabled('Save Rosters')
    await coach.page.waitForFunction(
      () =>
        String(document.body.textContent).includes(
          'Finish the current play first'
        ),
      { timeout: 15000 }
    )
    expect(await coach.lineup()).deep.equals(staged)
    expect(await coach.saveDisabled()).equals(false)
  })
})
