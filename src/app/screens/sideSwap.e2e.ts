import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import pg from 'pg'
import type { Page } from 'puppeteer'

import {
  type Lineup,
  type RosterEntry,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import type { ScoringAction } from '../../common/scoring/actions'
import { ScoringSession } from '../../common/scoring/session'
import { startingSetup, teamsOf } from '../../common/scoring/startingSetup'
import { type GameState, setupOf } from '../../common/scoring/state'
import type { LineupFixture } from '../../server/dev/lineupFixture'
import { signInTestAccount } from '../../test/passwordFixtures'
import {
  type BrowserSession,
  browserSession,
  maestro
} from '../../test/refinementsMaestro.e2e'
import { gameProposalFields, loadedGameDraft, swapSides } from './gameDraft'

/**
 * Home and away swapped before the first pitch, end to end, against the real
 * local stack — the API with its game socket (`npm start`), the web app built
 * against it (`npm run start.web`) and a game from `npm run lineup-fixture`,
 * made afresh for each scenario — in maestro-d's Chromium.
 *
 *   MAESTRO_D=side-swap-browser MAESTRO_D_BIN=… TS_MAESTRO_D_CLIENT=… \
 *   TS_SCORING_TEST_URL=http://127.0.0.1:8190 \
 *   TS_API_TEST_URL=http://127.0.0.1:9190/api/v1 \
 *   TS_LINEUP_PASSWORD=<the fixture's password> \
 *   SIDE_SWAP_ARTIFACTS=<dir> \
 *     node_modules/.bin/mocha -r sucrase/register --extension ts \
 *     --timeout 180000 src/app/screens/sideSwap.e2e.ts
 *
 * `SIDE_SWAP_MODE=before`, run in a checkout of the code before this change,
 * records what that code does with the same steps: the swap refused, Game
 * Settings showing it, and the scoring screen of a game whose team ids and
 * lineups are exchanged straight in the database.
 */
const APP = process.env.TS_SCORING_TEST_URL ?? 'http://127.0.0.1:8190'
const API = process.env.TS_API_TEST_URL ?? 'http://127.0.0.1:9190/api/v1'
const PASSWORD = process.env.TS_LINEUP_PASSWORD ?? ''
const ARTIFACTS = process.env.SIDE_SWAP_ARTIFACTS
const BEFORE = process.env.SIDE_SWAP_MODE === 'before'
const WIDTH = 1280
const HEIGHT = 900
/** A phone held sideways. */
const PHONE_WIDTH = 915
const PHONE_HEIGHT = 412
const REFUSED = 'Home and away can be swapped only before the first pitch'
const UNLOADED = 'Unable to load scoring.'
const UNREAD = 'could not be read back'

type Person = keyof LineupFixture['users']

/** The local stack's database, from the API's own config. */
function databaseUrl(): string {
  const config = JSON.parse(
    execFileSync('cat', [resolve('serverConfig.json')], { encoding: 'utf8' })
  ) as { databaseUrl: string }
  return config.databaseUrl
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
async function clientOf(
  fixture: LineupFixture,
  who: Person
): Promise<TeamStationClient> {
  return new TeamStationClient({
    baseUrl: API,
    token: await tokenOf(fixture, who)
  })
}

/** One line of a scenario's log, its request first, as `$` lines. */
async function note(file: string | null, line: string): Promise<void> {
  console.log(`    ${line.split('\n')[0]}`)
  if (ARTIFACTS != null && file != null)
    await appendFile(join(ARTIFACTS, file), line + '\n')
}

/** A database read for a log: the query on its `$` line, then its rows. */
async function query(
  file: string | null,
  sql: string,
  values: unknown[] = []
): Promise<Array<Record<string, unknown>>> {
  const client = new pg.Client({ connectionString: databaseUrl() })
  await client.connect()
  try {
    const rows = (await client.query(sql, values)).rows as Array<
      Record<string, unknown>
    >
    await note(
      file,
      `$ psql "$TS_DATABASE" -c "${sql.replace(/\s+/g, ' ')}"${values.length > 0 ? `  -- ${JSON.stringify(values)}` : ''}\n${JSON.stringify(rows, null, 2)}\n`
    )
    return rows
  } finally {
    await client.end()
  }
}

/**
 * Scores into the game as the scorekeeper's session does, through the API:
 * the game opens on the teams' default lineups, as the scoring screen's.
 */
async function score(
  fixture: LineupFixture,
  actions: ScoringAction[] | ((game: GameState) => ScoringAction[])
): Promise<ScoringSession> {
  const client = await clientOf(fixture, 'scorekeeper')
  const game = await client.game(fixture.gameId)
  // An outside opponent has no roster or default to read: none, as the
  // scoring screen takes it.
  const roster = async (teamId: string): Promise<RosterEntry[]> =>
    await client.roster(teamId).catch(() => [])
  const lineup = async (teamId: string): Promise<Lineup | null> =>
    await client
      .defaultLineup(teamId)
      .then(found => found.lineup)
      .catch(() => null)
  const [away, home, awayDefault, homeDefault] = await Promise.all([
    roster(game.awayTeamId),
    roster(game.homeTeamId),
    lineup(game.awayTeamId),
    lineup(game.homeTeamId)
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
        { away: awayDefault, home: homeDefault },
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
  return session
}

/** Three roster saves: the defaults confirmed, two batters exchanged, and back. */
function rosterSaves(state: GameState): ScoringAction[] {
  const setup = setupOf(state)
  const order = setup.sides.away.battingOrder
  const exchanged = {
    ...setup,
    sides: {
      ...setup.sides,
      away: {
        ...setup.sides.away,
        battingOrder: [order[1], order[0], ...order.slice(2)]
      }
    }
  }
  const roster = (s: typeof setup): ScoringAction => ({
    type: 'lineup',
    kind: 'roster',
    setup: s,
    confirmed: ['away', 'home']
  })
  return [roster(setup), roster(exchanged), roster(setup)]
}

/** Game Settings' own swap, sent as the home head coach's team. */
async function proposeSwap(
  fixture: LineupFixture,
  who: Person
): Promise<{ id: string; status: string }> {
  const client = await clientOf(fixture, who)
  const state = await client.gameScheduling(fixture.gameId)
  const [home, away] = await Promise.all([
    client.group({ kind: 'team', id: state.game.homeTeamId }),
    client.group({ kind: 'team', id: state.game.awayTeamId })
  ])
  const draft = swapSides(
    loadedGameDraft(
      state,
      {
        group: home.group,
        canManage: home.canManage || home.canManagePeople === true
      },
      {
        group: away.group,
        canManage: away.canManage || away.canManagePeople === true
      }
    )
  )
  const fields = gameProposalFields(
    draft,
    { kind: 'edit', gameId: fixture.gameId },
    draft.home!,
    draft.away!,
    state
  )
  return await client.proposeGame({
    ...fields,
    idempotencyKey: `side-swap-${Date.now()}-${Math.random()}`
  })
}

/** The swap, proposed by the home head coach and accepted by the away one. */
async function swapGame(fixture: LineupFixture, file: string): Promise<void> {
  const proposal = await proposeSwap(fixture, 'headCoach')
  await note(
    file,
    `$ POST ${API}/game-requests  (home head coach: Swap home and away)\n${JSON.stringify(proposal)}\n`
  )
  if (proposal.status === 'accepted') return
  const accepted = await (
    await clientOf(fixture, 'awayCoach')
  ).decideGameRequest(proposal.id, 'accept')
  await note(
    file,
    `$ POST ${API}/game-requests/${proposal.id}/accept  (away head coach)\n${JSON.stringify(accepted)}\n`
  )
  expect(accepted.status).equals('accepted')
}

/** The sides, guests, unrostered players and digest the game holds. */
async function sides(
  file: string | null,
  gameId: string
): Promise<Record<string, unknown>> {
  const [row] = await query(
    file,
    `select (select name from teams where id = home_team_id) as home,
            (select name from teams where id = away_team_id) as away,
            home_score, away_score, guests, unrostered, lineups_digest,
            "currentPlay"->'matchup'->'batter'->>'fullName' as due_up
       from games where id = $1`,
    [gameId]
  )
  return row
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

  async as(fixture: LineupFixture, who: Person): Promise<void> {
    await this.page.browserContext().setCookie({
      name: 'ts_session',
      value: encodeURIComponent(await tokenOf(fixture, who)),
      domain: new URL(APP).hostname,
      path: '/'
    })
  }

  /** The enabled button or switch named `label`, by its label or text, tapped. */
  async tap(label: string): Promise<void> {
    const find = async (): Promise<{ x: number; y: number }> => {
      const handle = await this.page.waitForFunction(
        (label: string) => {
          const node = Array.from(
            document.querySelectorAll('[role="button"],[role="switch"],button')
          ).find(node => {
            // No ?? here: sucrase turns it into a helper the page lacks.
            const named = node.getAttribute('aria-label')
            const name =
              named != null && named !== '' ? named : String(node.textContent)
            return name === label || name.startsWith(label + ', ')
          })
          if (node == null || node.getAttribute('aria-disabled') === 'true')
            return null
          node.scrollIntoView({ block: 'center' })
          const box = node.getBoundingClientRect()
          return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
        },
        { timeout: 30000 },
        label
      )
      return (await handle.jsonValue()) as { x: number; y: number }
    }
    // A sheet sliding in moves its buttons: tap once the target holds still.
    let point = await find()
    for (let tries = 0; tries < 20; tries++) {
      await new Promise(resolve => setTimeout(resolve, 150))
      const next = await find()
      const still =
        Math.abs(next.x - point.x) < 1 && Math.abs(next.y - point.y) < 1
      point = next
      if (still) break
    }
    await this.session.m.command('tapOnPoint', {
      x: Math.round(point.x),
      y: Math.round(point.y)
    })
  }

  /** What the page says: its text, and its labels, the field's among them. */
  async text(): Promise<string> {
    return await this.page.evaluate(
      () =>
        String(document.body.textContent) +
        Array.from(document.querySelectorAll('[aria-label]'))
          .map(node => node.getAttribute('aria-label'))
          .join('\n')
    )
  }

  async waitText(text: string, timeout = 30000): Promise<void> {
    await this.page.waitForFunction(
      text =>
        String(document.body.textContent).includes(text) ||
        Array.from(document.querySelectorAll('[aria-label]')).some(node =>
          String(node.getAttribute('aria-label')).includes(text)
        ),
      { timeout },
      text
    )
  }

  async capture(name: string): Promise<void> {
    if (ARTIFACTS == null) return
    await this.session.m.waitForAnimationToEnd()
    await writeFile(join(ARTIFACTS, name), await this.session.m.screenshot())
  }

  /** The enabled button named `label` scrolled to the middle, as a tap leaves it. */
  async showButton(label: string): Promise<void> {
    await this.page.waitForFunction(
      (label: string) => {
        const node = Array.from(
          document.querySelectorAll('[role="button"]')
        ).find(node => {
          const named = node.getAttribute('aria-label')
          const name =
            named != null && named !== '' ? named : String(node.textContent)
          return name === label
        })
        if (node == null) return false
        node.scrollIntoView({ block: 'center' })
        return true
      },
      { timeout: 30000 },
      label
    )
  }

  /** The scoring menu's rows, top to bottom. */
  async menuOrder(): Promise<string[]> {
    return await this.page.evaluate(() => {
      const rows = [
        'Exit Current Game',
        'Settings',
        'Overrides',
        'End Half Inning',
        'Set Team Rosters',
        'Swap Home and Away',
        'End Game'
      ]
      return Array.from(document.querySelectorAll('[aria-label]'))
        .map(node => String(node.getAttribute('aria-label')))
        .filter(label => rows.includes(label))
    })
  }

  async isDisabled(label: string): Promise<boolean> {
    return await this.page.evaluate((label: string) => {
      const node = document.querySelector(`[aria-label="${label}"]`)
      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- sucrase turns ?. into a helper the page lacks
      return node != null && node.getAttribute('aria-disabled') === 'true'
    }, label)
  }

  /** Whether the labelled element lies wholly inside the window. */
  async onScreen(label: string): Promise<boolean> {
    return await this.page.evaluate((label: string) => {
      const node = document.querySelector(`[aria-label="${label}"]`)
      if (node == null) return false
      const box = node.getBoundingClientRect()
      return box.top >= 0 && box.bottom <= window.innerHeight
    }, label)
  }

  /** Game Settings: Swap home and away, then Save. */
  async swapInSettings(gameId: string): Promise<void> {
    await this.page.goto(`${APP}/games/${gameId}/settings`, {
      waitUntil: 'domcontentloaded'
    })
    await this.page.waitForSelector('[aria-label="Swap home and away"]', {
      timeout: 60000
    })
    await this.tap('Swap home and away')
    await this.tap('Save')
  }

  /** The scoring screen for this game, its help dismissed. */
  async scoreGame(gameId: string): Promise<void> {
    await this.page.goto(`${APP}/games/${gameId}/score`, {
      waitUntil: 'domcontentloaded'
    })
    await this.page.waitForFunction(
      unloaded =>
        document.querySelector('[aria-label="Open scoring menu"]') != null ||
        String(document.body.textContent).includes(unloaded),
      { timeout: 60000 },
      UNLOADED
    )
    for (const label of ['OK', 'Close'])
      if ((await this.page.$(`[aria-label="${label}"]`)) != null)
        await this.tap(label)
  }
}

describe('home and away swapped before the first pitch', function () {
  let daemon: Awaited<ReturnType<typeof maestro>> | undefined
  let browser: Browser

  before(async function () {
    if (PASSWORD === '')
      throw new Error('Supply TS_LINEUP_PASSWORD, the lineup fixture password')
    for (const url of [APP, API])
      if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
        throw new Error(`${url} must be a local server`)
    if (ARTIFACTS != null) await mkdir(ARTIFACTS, { recursive: true })
    // A local database starts before the organization cutover a deployed
    // node has made; game requests and Game Settings wait for it.
    const client = new pg.Client({ connectionString: databaseUrl() })
    await client.connect()
    try {
      await client.query(
        `insert into system_settings (key, value) values ('creation.hierarchyReady', 'true')
           on conflict (key) do update set value = 'true'`
      )
    } finally {
      await client.end()
    }
    daemon = await maestro(process.env.MAESTRO_D ?? 'side-swap-browser')
    const session = await browserSession(
      daemon,
      'side-swap-chromium',
      WIDTH,
      HEIGHT,
      join(tmpdir(), 'side-swap-e2e')
    )
    session.page.setDefaultTimeout(30000)
    browser = new Browser(session, session.page)
  })

  after(async function () {
    if (browser != null && browser.errors.length > 0)
      console.log(`    browser errors: ${browser.errors.join('\n')}`)
    try {
      await browser?.session.browser.close()
    } finally {
      await daemon?.shutdown()
    }
  })

  /** A second browser at a phone's size, for what is captured there. */
  async function phone<T>(run: (phone: Browser) => Promise<T>): Promise<T> {
    const session = await browserSession(
      daemon!,
      'side-swap-phone',
      PHONE_WIDTH,
      PHONE_HEIGHT,
      join(tmpdir(), 'side-swap-e2e')
    )
    session.page.setDefaultTimeout(30000)
    try {
      return await run(new Browser(session, session.page))
    } finally {
      await session.m.detach()
      await session.browser.close()
    }
  }

  /** A fresh game with lineups saved, a home guest and an away player out. */
  async function preparedGame(file: string | null): Promise<LineupFixture> {
    const fixture = lineupFixture()
    await note(
      file,
      `$ npm run lineup-fixture -- --password <the fixture password>\ngame ${fixture.gameId}: Hosts (home) vs Visitors (away)\n`
    )
    await score(fixture, rosterSaves)
    await note(
      file,
      `$ POST ${API}/games/${fixture.gameId}/events  (scorekeeper: three roster saves, no pitch)\nsaved\n`
    )
    const coach = await clientOf(fixture, 'headCoach')
    const guest = await coach.createGuestPlayer(fixture.gameId, 'home', {
      firstName: 'Gus',
      lastName: 'Guest',
      jersey: '77',
      positions: [],
      bats: null,
      throws: null
    })
    await note(
      file,
      `$ POST ${API}/games/${fixture.gameId}/guest-players  {"side":"home","firstName":"Gus","lastName":"Guest"}\n${JSON.stringify({ userId: guest.userId })}\n`
    )
    const bench = fixture.players.away[12]
    await (
      await clientOf(fixture, 'awayCoach')
    ).setRostered(fixture.gameId, {
      side: 'away',
      userId: bench.userId,
      rostered: false
    })
    await note(
      file,
      `$ PUT ${API}/games/${fixture.gameId}/unroster  {"side":"away","userId":"<${bench.name}>","rostered":false}\nunrostered\n`
    )
    return fixture
  }

  if (BEFORE) {
    it('before: the swap is refused once lineups are saved, and a game swapped under the scoring screen does not load', async function () {
      const file = 'swap-refused-before.log'
      const fixture = await preparedGame(file)
      await sides(file, fixture.gameId)
      try {
        await swapGame(fixture, file)
        await note(file, 'the swap was accepted')
      } catch (error) {
        await note(
          file,
          `$ POST ${API}/game-requests  (home head coach: Swap home and away)\nrefused: ${error instanceof HttpError ? `${error.code} ${error.message}` : String(error)}\n`
        )
      }
      await sides(file, fixture.gameId)

      await browser.as(fixture, 'headCoach')
      await browser.swapInSettings(fixture.gameId)
      await browser.waitText('original teams', 30000).catch(() => undefined)
      await browser.capture('game-settings-swap-before.png')

      // Tonight's first repair: the team ids and the record's lineups
      // exchanged straight in the database, the guests left where they were.
      const client = new pg.Client({ connectionString: databaseUrl() })
      await client.connect()
      try {
        await client.query(
          `update games set home_team_id = away_team_id, away_team_id = home_team_id,
             "currentPlay" = jsonb_set("currentPlay", '{teamStation}',
               ("currentPlay"->'teamStation') || jsonb_build_object(
                 'actions', (select jsonb_agg(a || jsonb_build_object('setup',
                     (a->'setup') || jsonb_build_object('sides', jsonb_build_object(
                       'home', a->'setup'->'sides'->'away', 'away', a->'setup'->'sides'->'home'))))
                   from jsonb_array_elements("currentPlay"->'teamStation'->'actions') a),
                 'setupBefore', ("currentPlay"->'teamStation'->'setupBefore') || jsonb_build_object('sides', jsonb_build_object(
                   'home', "currentPlay"->'teamStation'->'setupBefore'->'sides'->'away',
                   'away', "currentPlay"->'teamStation'->'setupBefore'->'sides'->'home'))))
           where id = $1`,
          [fixture.gameId]
        )
      } finally {
        await client.end()
      }
      await browser.as(fixture, 'scorekeeper')
      await browser.scoreGame(fixture.gameId)
      await new Promise(resolve => setTimeout(resolve, 2000))
      await browser.capture('scoring-after-swap-before.png')
      const shown = await browser.text()
      await note(
        file,
        `scoring screen after the database swap: ${shown.includes(UNLOADED) ? UNLOADED : shown.includes(UNREAD) ? 'read-only: saved plays could not be read back' : 'opened'}\n`
      )
    })

    it('before: the scoring menu offers no swap, and the upper left no speaker', async function () {
      const fixture = await preparedGame(null)
      const batter = `Batter ${fixture.players.away[0].name}`
      await browser.as(fixture, 'scorekeeper')
      await browser.scoreGame(fixture.gameId)
      await browser.waitText(batter, 60000)
      await browser.capture('scoring-sound-before.png')
      await browser.tap('Open scoring menu')
      await browser.waitText('End Game')
      await browser.capture('scoring-menu-before.png')
      expect(await browser.text()).not.includes('Swap Home and Away')
      await phone(async phone => {
        await phone.as(fixture, 'scorekeeper')
        await phone.scoreGame(fixture.gameId)
        await phone.waitText(batter, 60000)
        await phone.capture('scoring-sound-phone-before.png')
      })
    })
    return
  }

  it('E1, E2: a game with lineups, a guest and an absence swaps, and a stale device is refused', async function () {
    const file = 'swap-with-lineups-after.log'
    const fixture = await preparedGame(file)
    const before = await sides(file, fixture.gameId)
    // What the scorekeeper's device holds: the game as it read it.
    const scorer = await clientOf(fixture, 'scorekeeper')
    const held = await scorer.gameEvents(fixture.gameId)
    expect(held.lineupsDigest).a('string')
    await swapGame(fixture, file)
    const after = await sides(file, fixture.gameId)
    expect(after.home).equals(before.away)
    expect(after.away).equals(before.home)
    expect((after.guests as { away: number[] }).away).deep.equals(
      (before.guests as { home: number[] }).home
    )
    expect((after.unrostered as { home: unknown[] }).home).deep.equals(
      (before.unrostered as { away: unknown[] }).away
    )
    expect(after.lineups_digest).not.equals(before.lineups_digest)
    expect(after.due_up).equals(fixture.players.home[0].name)
    const lineups = await (
      await clientOf(fixture, 'scorekeeper')
    ).gameLineups(fixture.gameId)
    await note(
      file,
      `$ GET ${API}/games/${fixture.gameId}/lineups\n${JSON.stringify(lineups, null, 2).slice(0, 4000)}\n`
    )

    const stale = 'stale-after-swap.log'
    let refusal: unknown
    try {
      await scorer.saveGameEvents(fixture.gameId, {
        plays: [],
        remove: [],
        currentPlay: held.currentPlay,
        lineupsBase: held.lineupsDigest
      })
    } catch (error) {
      refusal = error
    }
    await note(
      stale,
      `$ POST ${API}/games/${fixture.gameId}/events  (scorekeeper's device: its lineups from before the swap, lineupsBase ${String(held.lineupsDigest).slice(0, 12)}…)\n${refusal instanceof HttpError ? `${refusal.status} ${refusal.code} ${refusal.message} ${JSON.stringify(refusal.details)}` : `accepted: ${String(refusal)}`}\n`
    )
    expect(refusal).instanceOf(HttpError)
    expect((refusal as HttpError).details).deep.equals({ stale: true })
    await sides(stale, fixture.gameId)
  })

  it('E3: Game Settings swaps a game with saved lineups', async function () {
    const file = 'game-settings-swap-after.log'
    const fixture = await preparedGame(file)
    await browser.as(fixture, 'headCoach')
    await browser.swapInSettings(fixture.gameId)
    await browser.waitText('Game proposal sent', 30000).catch(async () => {
      await browser.waitText('Game changes saved', 5000)
    })
    const pending = await (
      await clientOf(fixture, 'awayCoach')
    ).gameProposals({ kind: 'team', id: fixture.teams.away })
    const request = pending.find(
      r => r.gameId === fixture.gameId && r.status === 'pending'
    )
    if (request != null)
      await (
        await clientOf(fixture, 'awayCoach')
      ).decideGameRequest(request.requestId, 'accept')
    await browser.page.goto(`${APP}/games/${fixture.gameId}`, {
      waitUntil: 'domcontentloaded'
    })
    await browser.waitText('Visitors', 60000)
    await browser.capture('game-after-swap.png')
    const row = await sides(file, fixture.gameId)
    expect(row.home).equals('Visitors')
    // Game Settings again, framed as the refusal was: at Save, with no error.
    await browser.page.goto(`${APP}/games/${fixture.gameId}/settings`, {
      waitUntil: 'domcontentloaded'
    })
    await browser.page.waitForSelector('[aria-label="Swap home and away"]', {
      timeout: 60000
    })
    await browser.showButton('Save')
    const shown = await browser.text()
    expect(shown).not.includes(REFUSED)
    expect(shown).not.includes('original teams')
    await browser.capture('game-settings-swap-after.png')
    await note(
      file,
      `Game Settings after the swap: Save offered, no refusal shown\n`
    )
  })

  it('E4: an open scoring screen reopens on the swapped sides', async function () {
    const file = 'scoring-after-swap-after.log'
    const fixture = await preparedGame(file)
    await browser.as(fixture, 'scorekeeper')
    await browser.scoreGame(fixture.gameId)
    await browser.waitText(`Batter ${fixture.players.away[0].name}`, 60000)
    await swapGame(fixture, file)
    await browser.waitText(`Batter ${fixture.players.home[0].name}`, 60000)
    await new Promise(resolve => setTimeout(resolve, 1500))
    const shown = await browser.text()
    expect(shown).not.includes(UNLOADED)
    expect(shown).not.includes(UNREAD)
    await browser.capture('scoring-after-swap-after.png')
    await note(
      file,
      `scoring screen after the swap: reopened, ${fixture.players.home[0].name} due up\n`
    )
  })

  it('E5, E6: after a pitch the swap is refused, through the API and in Game Settings', async function () {
    const file = 'swap-after-pitch-refused.log'
    const fixture = await preparedGame(file)
    await score(fixture, [{ type: 'pitch', call: 'B' }])
    await note(
      file,
      `$ POST ${API}/games/${fixture.gameId}/events  (scorekeeper: one pitch, a ball)\nsaved\n`
    )
    const before = await sides(file, fixture.gameId)
    try {
      await proposeSwap(fixture, 'headCoach')
      expect.fail('the swap was accepted after a pitch')
    } catch (error) {
      await note(
        file,
        `$ POST ${API}/game-requests  (home head coach: Swap home and away)\n${error instanceof HttpError ? `${error.code} ${error.message}` : String(error)}\n`
      )
      expect(error instanceof HttpError ? error.message : '').equals(REFUSED)
    }
    expect((await sides(file, fixture.gameId)).home).equals(before.home)

    await browser.as(fixture, 'headCoach')
    await browser.swapInSettings(fixture.gameId)
    await browser.waitText(REFUSED, 30000)
    await browser.capture('game-settings-after-pitch.png')
  })

  it('E7: the schedule import flips a game holding lineups', async function () {
    const file = 'schedule-import-swap.log'
    const fixture = lineupFixture()
    await query(
      file,
      `insert into scope_roles (id, user_id, scope_type, scope_id, role)
         values ('sr_' || md5(random()::text), $1, 'team', $2, 'admin'),
                ('sr_' || md5(random()::text), $1, 'season', $3, 'admin')
         on conflict do nothing returning scope_type, role`,
      [fixture.users.headCoach.userId, fixture.teams.home, fixture.seasonId]
    )
    const token = await tokenOf(fixture, 'headCoach')
    const startAt = new Date(Date.now() + 3 * 86400_000).toISOString()
    const row = (side: 'home' | 'away'): Record<string, unknown> => ({
      opponent: { name: 'Riverside Otters' },
      side,
      startAt,
      externalId: { system: 'sideSwapE2e', id: `otters-${fixture.gameId}` }
    })
    const post = async (side: 'home' | 'away'): Promise<unknown> => {
      const response = await fetch(`${API}/teams/${fixture.teams.home}/games`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ games: [row(side)] })
      })
      const body = (await response.json()) as unknown
      await note(
        file,
        `$ POST ${API}/teams/${fixture.teams.home}/games  ${JSON.stringify({ games: [row(side)] })}\n${response.status} ${JSON.stringify(body)}\n`
      )
      return body
    }
    const created = (await post('home')) as {
      results: Array<{ gameId: string }>
    }
    const gameId = created.results[0].gameId
    const imported = { ...fixture, gameId }
    // The opponent is outside TeamStation: only the home lineup is saved.
    await score(imported, state => [
      {
        type: 'lineup',
        kind: 'roster',
        setup: setupOf(state),
        confirmed: ['home']
      }
    ])
    await note(
      file,
      `$ POST ${API}/games/${gameId}/events  (scorekeeper: the home lineup saved, no pitch)\nsaved\n`
    )
    await (
      await clientOf(fixture, 'headCoach')
    ).createGuestPlayer(gameId, 'home', {
      firstName: 'Gus',
      lastName: 'Guest',
      jersey: '77',
      positions: [],
      bats: null,
      throws: null
    })
    const before = await sides(file, gameId)
    const flipped = (await post('away')) as {
      results: Array<{ result: string }>
    }
    expect(flipped.results[0].result).equals('updated')
    const after = await sides(file, gameId)
    expect(after.home).equals(before.away)
    expect((after.guests as { away: number[] }).away).deep.equals(
      (before.guests as { home: number[] }).home
    )
    // The Hosts' lineup is now the away one, in its order.
    const lineups = await (
      await clientOf(fixture, 'headCoach')
    ).gameLineups(gameId)
    await note(
      file,
      `$ GET ${API}/games/${gameId}/lineups\n${JSON.stringify(
        {
          away: {
            teamName: lineups.away.teamName,
            batters: lineups.away.current?.batters.map(batter => batter.name)
          },
          home: {
            teamName: lineups.home.teamName,
            batters: lineups.home.current?.batters.map(batter => batter.name)
          }
        },
        null,
        2
      )}\n`
    )
    expect(lineups.away.teamId).equals(fixture.teams.home)
    expect(
      lineups.away.current?.batters.map(batter => batter.name)
    ).deep.equals(fixture.players.home.slice(0, 9).map(player => player.name))
    // No matchup is written either way: the Otters, outside TeamStation,
    // have no lineup and no pitcher.
  })

  it('E8: the scoring menu swaps home and away, from right above End Game', async function () {
    const file = 'scoring-menu-swap.log'
    const fixture = await preparedGame(file)
    const before = await sides(file, fixture.gameId)
    await browser.as(fixture, 'scorekeeper')
    await browser.scoreGame(fixture.gameId)
    await browser.waitText(`Batter ${fixture.players.away[0].name}`, 60000)
    await browser.tap('Open scoring menu')
    await browser.waitText('Swap Home and Away')
    expect(await browser.menuOrder()).deep.equals([
      'Exit Current Game',
      'Settings',
      'Overrides',
      'End Half Inning',
      'Set Team Rosters',
      'Swap Home and Away',
      'End Game'
    ])
    await browser.capture('scoring-menu-after.png')
    await browser.tap('Swap Home and Away')
    await browser.tap('Confirm Swap')
    await browser.waitText(`Batter ${fixture.players.home[0].name}`, 60000)
    await browser.waitText('Home and away were swapped')
    await browser.capture('scoring-menu-swapped.png')
    const after = await sides(file, fixture.gameId)
    expect(after.home).equals(before.away)
    expect(after.away).equals(before.home)
    await note(
      file,
      `scoring menu: Swap Home and Away, then Confirm Swap; the screen opened again with ${fixture.players.home[0].name} due up\n`
    )

    // After a pitch the item is off.
    const pitched = await preparedGame(null)
    await score(pitched, [{ type: 'pitch', call: 'B' }])
    await browser.as(pitched, 'scorekeeper')
    await browser.scoreGame(pitched.gameId)
    await browser.tap('Open scoring menu')
    await browser.waitText('Swap Home and Away')
    expect(await browser.isDisabled('Swap Home and Away')).equals(true)
    await note(
      file,
      `$ POST ${API}/games/${pitched.gameId}/events  (scorekeeper: one pitch, a ball)\nsaved\nscoring menu after the pitch: Swap Home and Away is disabled\n`
    )

    // At a phone's size every row shows, End Game included.
    const small = await preparedGame(null)
    await phone(async phone => {
      await phone.as(small, 'scorekeeper')
      await phone.scoreGame(small.gameId)
      await phone.waitText(`Batter ${small.players.away[0].name}`, 60000)
      await phone.tap('Open scoring menu')
      await phone.waitText('End Game')
      expect(await phone.onScreen('End Game')).equals(true)
      await phone.capture('scoring-menu-phone-after.png')
    })
  })
})
