// The functions the page runs are transpiled by sucrase, which turns ?. and
// ?? into helpers the page does not have: they use neither.
/* eslint-disable @typescript-eslint/prefer-optional-chain */
import { expect } from 'chai'

import {
  defineHarness,
  type HarnessContext,
  type WebSession
} from '../../../core/spec'

/**
 * Coach Game end to end on the web: a head coach's own team in a game, in
 * the runner's browser at an iPhone's 402×874, against the stack, each
 * scenario on its own lineup game (`coach-plan`). One browser; the coach,
 * the scorekeeper, the assistant and the member take turns in it, signed in
 * by their session cookie. The plays and the scorekeeper's lineup a
 * scenario needs while the coach's screen is open are scored through the
 * API, as the scorekeeper's own session would post them.
 *
 * Everything that acts goes through maestro-d; the page is read. Each API
 * response's method, path and status is kept by a stand-in installed before
 * the page's own script (`RESPONSES`). C5, the dictated lineup, is
 * `scoring/coach-game/dictated-lineup`: it needs the real dictation model.
 */

const WIDTH = 402
const HEIGHT = 874
const BANNER =
  'Another user has edited the roster. Your pending changes may overwrite theirs. Hit Cancel to revert to their changes.'

type Person =
  | 'scorekeeper'
  | 'headCoach'
  | 'assistant'
  | 'awayCoach'
  | 'member'
  | 'teamAdmin'

interface Player {
  userId: string
  gumboId: number
  name: string
  jersey: string
}

interface Lineup {
  gameId: string
  teams: Record<'home' | 'away', string>
  players: Record<'home' | 'away', Player[]>
  accounts: Record<string, { email: string; password: string }>
}

/** Each side's batting order as the world's game opens: its first nine. */
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

/** Every API response's method, path and status, from before the page runs. */
const RESPONSES = `
  window.__responses = [];
  const ownFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input);
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    return ownFetch(input, init).then(answer => {
      window.__responses.push({ method, url, status: answer.status });
      return answer;
    });
  };
`

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** `names` appear in `text` one after another, each once at least. */
function inOrder(text: string, names: readonly string[]): void {
  let last = -1
  for (const name of names) {
    const index = text.indexOf(name, last + 1)
    expect(index, name).greaterThan(last)
    last = index
  }
}

/** The world's lineup game, its people and its players. */
async function lineupWorld(ctx: HarnessContext): Promise<Lineup> {
  const world = await ctx.fixture('coach-plan')
  // Loaded here: a spec's import has no side effects.
  const { LINEUP_NAMES } =
    await import('../../../../src/server/dev/lineupFixture')
  const side = (name: 'home' | 'away'): Player[] =>
    LINEUP_NAMES[name].map((player, at) => ({
      userId: world.ids[`${name}${at + 1}User`],
      gumboId: Number(world.ids[`${name}${at + 1}Gumbo`]),
      name: player,
      jersey: String(at + 1)
    }))
  return {
    gameId: world.ids.game,
    teams: { home: world.ids.homeTeam, away: world.ids.awayTeam },
    players: { home: side('home'), away: side('away') },
    accounts: world.accounts
  }
}

function api(ctx: HarnessContext): string {
  return `${ctx.stack.origin}/api/v1`
}

/** Each person's API session, signed in once: sign-ins are rate limited. */
const tokens = new Map<string, string>()
async function tokenOf(
  ctx: HarnessContext,
  fixture: Lineup,
  who: Person
): Promise<string> {
  const account = fixture.accounts[who]
  let token = tokens.get(account.email)
  if (token == null) {
    const { signInTestAccount } =
      await import('../../../../src/test/passwordFixtures')
    token = await signInTestAccount(api(ctx), account)
    tokens.set(account.email, token)
  }
  return token
}

/** The API as one of the world's people, to read what the server holds. */
async function clientAs(
  ctx: HarnessContext,
  fixture: Lineup,
  who: Person
): Promise<any> {
  const { TeamStationClient } = await import('../../../../src/common/api')
  return new TeamStationClient({
    baseUrl: api(ctx),
    token: await tokenOf(ctx, fixture, who)
  })
}

/**
 * Scores into the game as the scorekeeper's session does, through the API:
 * the game opens on the teams' default lineups, as the scoring screen's.
 * `actions` may be read off the game as it stands.
 */
async function score(
  ctx: HarnessContext,
  fixture: Lineup,
  actions: unknown[] | ((game: any) => unknown[])
): Promise<void> {
  const { ScoringSession } =
    await import('../../../../src/common/scoring/session')
  const { startingSetup, teamsOf } =
    await import('../../../../src/common/scoring/startingSetup')
  const client = await clientAs(ctx, fixture, 'scorekeeper')
  const game = await client.game(fixture.gameId)
  const [away, home, awayDefault, homeDefault] = await Promise.all([
    client.roster(game.awayTeamId),
    client.roster(game.homeTeamId),
    client.defaultLineup(game.awayTeamId),
    client.defaultLineup(game.homeTeamId)
  ])
  const session = await ScoringSession.open(
    {
      load: async (id: string) => await client.gameEvents(id),
      save: async (id: string, change: unknown) =>
        await client.saveGameEvents(id, change)
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
    expect(
      session.apply(action as never).problems,
      JSON.stringify(action)
    ).deep.equals([])
  await session.flush()
  expect(session.problem).equals(null)
}

/** One browser, and what the scenarios do in it. */
class Web {
  constructor(
    readonly ctx: HarnessContext,
    readonly session: WebSession,
    readonly fixture: Lineup
  ) {}

  get m(): any {
    return this.session.m
  }

  get page(): WebSession['page'] {
    return this.session.page
  }

  /** Signs this browser in as one of the world's people, by his cookie. */
  async as(who: Person): Promise<void> {
    await this.m.setCookies({
      cookies: [
        {
          name: 'ts_session',
          value: encodeURIComponent(await tokenOf(this.ctx, this.fixture, who)),
          domain: new URL(this.ctx.stack.origin).hostname,
          path: '/'
        }
      ]
    })
  }

  async go(path: string): Promise<void> {
    await this.m.openLink({ link: `${this.ctx.stack.origin}${path}` })
  }

  async tap(label: string, role?: string): Promise<void> {
    const css =
      role == null
        ? `[aria-label="${label}"]`
        : `[aria-label="${label}"][role="${role}"]`
    await this.page.waitForSelector(css)
    await this.m.tapOn({ css, timeout: 15000 })
  }

  async tapEnabled(label: string): Promise<void> {
    await this.page.waitForFunction(
      (name: string) => {
        const node = document.querySelector(`[aria-label="${name}"]`)
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
  async pills(): Promise<string[]> {
    await this.go(`/games/${this.fixture.gameId}`)
    await this.page.waitForSelector('[aria-label="Game sections"]', {
      timeout: 60000
    })
    // The pills that depend on the game come with it, and its teams' names.
    await this.page.waitForFunction(
      () => String(document.body.textContent).includes('Hosts'),
      { timeout: 30000 }
    )
    await sleep(300)
    return await this.page.$$eval(
      '[aria-label="Game sections"] [role="tab"], [aria-label="Game sections"] [role="button"]',
      nodes => nodes.map(node => String(node.getAttribute('aria-label')))
    )
  }

  /** Coach Game, opened from the game's pill. */
  async coachGame(): Promise<void> {
    await this.pills()
    await this.tap('Coach')
    await this.page.waitForSelector('[aria-label="Save Rosters"]', {
      timeout: 60000
    })
  }

  /** The scoring screen for this game, its help dismissed. */
  async scoreGame(): Promise<void> {
    await this.go(`/games/${this.fixture.gameId}/score`)
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
      (wanted: string[]) => {
        const shown = [
          ...document.querySelectorAll(
            '[data-roster-target^="lineup-"][data-roster-player]'
          )
        ].map(node =>
          String(node.textContent)
            .replace(/^\D*\d+\. (#\S+ )?/, '')
            .replace(/\W+$/, '')
        )
        return JSON.stringify(shown) === JSON.stringify(wanted)
      },
      { timeout: 15000 },
      names
    )
  }

  /**
   * Back to the game's page in the app (a page load would empty the tab's
   * copy, and its queue with it): the banner says an edit is not sent, its
   * sheet gives the server's `message`, and Use Server's Copy clears it.
   */
  async heldThenServerCopy(message: string): Promise<void> {
    await this.m.back()
    await this.page.waitForFunction(
      `(document.querySelector('[data-testid="offlineBannerText"]') || {}).textContent === '1 edit not sent'`,
      { timeout: 30000 }
    )
    await this.tap('Edits not sent')
    await this.page.waitForSelector('[data-testid="heldEditsSheet"]')
    await this.page.waitForFunction(
      (text: string) => document.body.innerText.includes(text),
      { timeout: 15000 },
      message
    )
    await this.m.tapOn({
      css: '[aria-label^="Use Server\'s Copy"]',
      timeout: 15000
    })
    await this.page.waitForFunction(
      () => document.querySelector('[data-testid="offlineBannerText"]') == null,
      { timeout: 20000 }
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
      (off: boolean) =>
        document
          .querySelector('[aria-label="Save Rosters"]')!
          .getAttribute('aria-disabled') === (off ? 'true' : null),
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
   * A drag of the lineup row at `source` to the boundary after `target`:
   * the press is held until the row lifts.
   */
  async dragAfter(source: number, target: number): Promise<void> {
    const at = async (
      index: number,
      where: 'bottom' | 'middle'
    ): Promise<{ x: number; y: number }> => {
      const r = await this.box(`[data-roster-target="lineup-${index}"]`)
      return {
        x: Math.round(r.x + Math.min(40, r.width / 2)),
        y: Math.round(
          where === 'bottom' ? r.y + r.height - 8 : r.y + r.height / 2
        )
      }
    }
    const start = await at(source, 'middle')
    const bottom = await at(target, 'bottom')
    // The old run read the target once the row had lifted, when the rows
    // below it close up by one pitch; a drag of two points is aimed there
    // before the press, so the drop point is that pitch higher.
    const pitch =
      target > source
        ? (await this.box('[data-roster-target="lineup-1"]')).y -
          (await this.box('[data-roster-target="lineup-0"]')).y
        : 0
    const end = { x: bottom.x, y: Math.round(bottom.y - pitch) }
    await this.m.dragAndDrop({
      from: { point: `${start.x},${start.y}` },
      to: { point: `${end.x},${end.y}` },
      holdDuration: 750,
      duration: 400
    })
    await sleep(300)
  }

  /** The first response since `since` (an index) that `wanted` accepts. */
  async response(
    since: number,
    method: string,
    suffix: string
  ): Promise<{ status: number }> {
    const handle = await this.page.waitForFunction(
      (from: number, verb: string, end: string) => {
        const found = (
          (window as any).__responses as Array<{
            method: string
            url: string
            status: number
          }>
        )
          .slice(from)
          .find(row => row.method === verb && row.url.endsWith(end))
        // No `??` in the page: it has no sucrase helpers.
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
        return found == null ? false : found
      },
      { timeout: 30000 },
      since,
      method,
      suffix
    )
    return (await handle.jsonValue()) as { status: number }
  }

  async responses(): Promise<number> {
    return (await this.page.evaluate(
      () => (window as any).__responses.length
    )) as number
  }

  async shot(name: string): Promise<void> {
    await this.m.waitForAnimationToEnd()
    await this.m.takeScreenshot({ path: this.ctx.artifact(name) })
  }
}

async function setUp(
  ctx: HarnessContext
): Promise<{ fixture: Lineup; coach: Web }> {
  const fixture = await lineupWorld(ctx)
  const session = await ctx.browser(
    { width: WIDTH, height: HEIGHT },
    { beforeLoad: RESPONSES }
  )
  session.page.setDefaultTimeout(30000)
  return { fixture, coach: new Web(ctx, session, fixture) }
}

export default defineHarness({
  id: 'scoring/coach-game/coach-lineup',
  title:
    "A team's coach opens Coach Game from his game, reads its box score, and stages, saves and keeps his lineup against the scorekeeper's",
  kind: 'e2e',
  covers: [
    'src/app/screens/CoachGameScreen.tsx',
    'src/app/screens/gameTabs.ts',
    'src/app/scoring/RosterEditor.tsx',
    'src/server/routes/lineups.ts'
  ],
  stack: 'isolated',
  fixtures: ['coach-plan'],
  exclusive: false,
  surfaces: {
    // The roster editor is the scoring screens' own, which only a GPU
    // draws: the Mac's browser.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['gpu'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 20,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'c9-game-availability-and-refused-mid-play': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      const id = fixture.players.home[0].userId
      const selector = `[data-testid="Rostered ${id}"]`
      const checked = async (value: boolean): Promise<void> => {
        await coach.page.waitForFunction(
          (css: string, wanted: boolean) => {
            const input = document.querySelector<HTMLInputElement>(
              `${css} input`
            )
            return input != null && input.checked === wanted
          },
          { timeout: 15000 },
          selector,
          value
        )
      }
      await coach.as('headCoach')
      await coach.coachGame()
      let since = await coach.responses()
      await coach.tapEnabled('Save Rosters')
      expect((await coach.response(since, 'POST', '/lineups')).status).equals(
        200
      )
      await coach.coachGame()
      await coach.tap('Roster', 'tab')
      await checked(true)
      // The switch turns at once; the change is read back once it has landed.
      since = await coach.responses()
      await coach.m.tapOn({ css: selector })
      await checked(false)
      await coach.response(since, 'PUT', '/unroster')
      await coach.shot('roster-switch-off.png')
      const client = await clientAs(ctx, fixture, 'headCoach')
      const off = (await client.gameLineups(fixture.gameId)).home.current
      expect(
        off.batters.some(
          (player: { gumboId: number }) =>
            player.gumboId === fixture.players.home[0].gumboId
        )
      ).equals(false)
      expect(off.defense.P).equals(null)
      await coach.coachGame()
      await coach.tap('Roster', 'tab')
      await checked(false)
      since = await coach.responses()
      await coach.m.tapOn({ css: selector })
      await checked(true)
      await coach.response(since, 'PUT', '/unroster')
      const on = (await client.gameLineups(fixture.gameId)).home.current
      expect(
        on.batters.some(
          (player: { gumboId: number }) =>
            player.gumboId === fixture.players.home[0].gumboId
        )
      ).equals(false)
      expect(on.defense.P).equals(null)
      const scorer = await clientAs(ctx, fixture, 'scorekeeper')
      let refusal: unknown
      try {
        await scorer.setRostered(fixture.gameId, {
          side: 'home',
          userId: id,
          rostered: false
        })
      } catch (error) {
        refusal = error
      }
      expect(refusal).property('code', 'forbidden')
      await coach.as('scorekeeper')
      await coach.scoreGame()
      await coach.openRosters()
      await coach.tap('Roster', 'tab')
      expect(
        await coach.page.$('input[aria-label="Rostered for this game"]')
      ).equals(null)

      const pending = await lineupWorld(ctx)
      const second = new Web(ctx, coach.session, pending)
      await score(ctx, pending, [{ type: 'ballInPlay', contact: 'swing' }])
      await second.as('headCoach')
      await second.coachGame()
      await second.tap('Roster', 'tab')
      const pendingSelector = `[data-testid="Rostered ${pending.players.home[0].userId}"]`
      await second.m.tapOn({ css: pendingSelector })
      // Refused mid-play, the change is kept and held, as on the phone: the
      // web's queue sends it behind the screen (Intake 9 of #358).
      await second.page.waitForFunction(
        () =>
          String(document.body.textContent).includes(
            'Finish the current play first'
          ),
        { timeout: 30000 }
      )
      expect(
        await second.page.$eval(
          `${pendingSelector} input`,
          input => input.checked
        )
      ).equals(false)
      const pendingClient = await clientAs(ctx, pending, 'headCoach')
      expect(
        (await pendingClient.game(pending.gameId)).unrostered.home
      ).deep.equals([])
      await second.heldThenServerCopy('Finish the current play first')
      expect(
        (await pendingClient.game(pending.gameId)).unrostered.home
      ).deep.equals([])
    },

    'c10-red-clear-on-lineup-header': async ctx => {
      const { coach } = await setUp(ctx)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.tap('Lineup', 'tab')
      await coach.page.waitForSelector('[data-roster-target="lineup-0"]')
      await coach.shot('coach-lineup-header-after.png')
      const header = await coach.box('[data-testid="Lineup header"]')
      const clear = await coach.box('[aria-label="Clear Lineup"]')
      // On the header's line, right-justified.
      expect(clear.x + clear.width).closeTo(header.x + header.width, 2)
      expect(clear.y + clear.height / 2).within(
        header.y,
        header.y + header.height
      )
      expect(
        await coach.page.$$eval(
          '[data-roster-target^="lineup-"] [aria-label^="Remove "]',
          nodes => nodes.length
        )
      ).equals(HOSTS.length)
      await coach.tap('Clear Lineup')
      await coach.waitLineup([])
      await coach.tap('Cancel')
    },

    'c1-coach-pill-for-coaches-only': async ctx => {
      const { coach } = await setUp(ctx)
      await coach.as('headCoach')
      const pills = await coach.pills()
      expect(pills).to.include.members(['Box score', 'Videos'])
      expect(await coach.page.$('[aria-label="Coach"]')).not.equals(null)
      await coach.shot('game-pills-after.png')
      // The assistant coaches the team as its head coach does.
      await coach.as('assistant')
      const assisted = await coach.pills()
      expect(assisted).to.include.members(['Box score', 'Videos'])
      expect(await coach.page.$('[aria-label="Coach"]')).not.equals(null)
      await coach.as('member')
      const theirs = await coach.pills()
      expect(await coach.page.$('[aria-label="Coach"]')).equals(null)
      expect(theirs).to.include.members(['Box score', 'Videos'])
      // The scorekeeper scores, and coaches nothing.
      await coach.as('scorekeeper')
      await coach.pills()
      expect(await coach.page.$('[aria-label="Score"]')).not.equals(null)
      expect(await coach.page.$('[aria-label="Coach"]')).equals(null)
    },

    'c2-full-screen-header-tabs-and-bar': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await coach.as('headCoach')
      await coach.coachGame()
      expect(new URL(coach.page.url()).pathname).equals(
        `/games/${fixture.gameId}/coach/${fixture.teams.home}`
      )
      // No app header or navigation: its own header row.
      // On the scene on top: the game's screen stays mounted beneath it.
      expect(
        await coach.page.$('[data-scene-role="top"] [aria-label="Schedule"]')
      ).equals(null)
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
      // The coaching screen's own tabs: the game's are still behind it.
      const tabs = await coach.page.evaluate(() => {
        const pill = document.querySelector('[data-testid="Box Score pill"]')!
        const roster = document.querySelector(
          '[aria-label="Roster"][role="tab"]'
        )!
        return [
          pill,
          ...roster.parentElement!.querySelectorAll('[role="tab"]')
        ].map(node => String(node.getAttribute('aria-label')))
      })
      expect(tabs).deep.equals([
        'Box Score',
        'Roster',
        'Lineup',
        'Defense',
        'Plan'
      ])
      // Box Score is a pill on its own row, above the other four.
      const pill = await coach.box('[data-testid="Box Score pill"]')
      const roster = await coach.box('[aria-label="Roster"][role="tab"]')
      expect(pill.y + pill.height).lessThan(roster.y + 1)
      // The bar, as the scorekeeper's: the round mic in the middle and
      // taller than Save, and Cancel, a red button as large as Save, left of
      // it on Save's row.
      const bar = await coach.box('[data-testid="Roster footer bar"]')
      const add = await coach.box('[aria-label="Create Player"]')
      const mic = await coach.box('[data-testid="Roster mic"]')
      const save = await coach.box('[aria-label="Save Rosters"]')
      const cancel = await coach.box('[aria-label="Cancel"]')
      expect(await coach.text()).includes('Create Player')
      expect(add.x).lessThan(mic.x)
      expect(mic.x + mic.width).lessThan(save.x + 1)
      expect(mic.x + mic.width / 2).closeTo(bar.x + bar.width / 2, 1)
      expect(mic.height).closeTo(save.height + 12, 0.5)
      expect(cancel.x + cancel.width).lessThan(mic.x + 1)
      expect(cancel.y + cancel.height / 2).closeTo(save.y + save.height / 2, 4)
      expect(cancel.width).closeTo(save.width, 1)
      expect(cancel.height).closeTo(save.height, 1)
      expect(bar.y + bar.height).lessThan(HEIGHT + 1)
    },

    'c3-own-team-first-in-box-score': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      // Two half innings: three batters a side struck out looking.
      await score(ctx, fixture, [
        ...Array.from({ length: 18 }, () => ({ type: 'pitch', call: 'C' })),
        { type: 'gameFlow', kind: 'closePlay' }
      ])
      await coach.as('headCoach')
      await coach.coachGame()
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
      // A row reads across the names column and the figures beside it: the
      // empty lines of those yet to bat are noughts with no average, and
      // each side's batting and pitching end with their totals.
      const rows = (await coach.page.$eval(
        '[data-testid="Roster box score"]',
        root =>
          Array.prototype.map.call(
            root.querySelectorAll('[data-testid="frozen-names"]'),
            (column: Element) => {
              const figures =
                column.nextElementSibling!.firstElementChild!.firstElementChild!
              return Array.prototype.map.call(
                column.children,
                (name: Element, index: number) =>
                  String(name.textContent) +
                  String(figures.children[index].textContent)
              )
            }
          )
      )) as string[][]
      const lines = rows.flat()
      expect(lines).includes('Nimmo00000000–')
      expect(lines).includes('Alvarez00000000–')
      // The line score, then each side's batting and pitching.
      for (const table of rows.slice(1))
        expect(table.at(-1)!.startsWith('Totals'), table[1]).equals(true)
      for (const benched of ['Soto', 'Harper', 'Freeman'])
        expect(hosts, benched).not.includes(benched)
      await coach.shot('coach-boxscore.png')
    },

    'c3-whole-order-before-first-pitch': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.tabOn('Box Score')
      const boxText = async (has: string): Promise<string> => {
        await coach.page.waitForFunction(
          (words: string) =>
            String(
              document.querySelector('[data-testid="Roster box score"]')!
                .textContent
            ).includes(words),
          { timeout: 30000 },
          has
        )
        return await coach.page.$eval(
          '[data-testid="Roster box score"]',
          node => String(node.textContent)
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
      // Every batter's row, and the totals, all noughts and no average yet.
      // The names stand in a column of their own, beside the figures.
      expect(text.split('00000000–').length - 1).equals(HOSTS.length + 1)
      // Nobody has pitched, and the visitors' order is not the game's yet.
      expect(text).not.includes('Pitching')
      expect(text).not.includes('Batting — Visitors')
      await coach.shot('coach-boxscore-pregame.png')
      // The scorekeeper's session saves both lineups as they stand.
      const { setupOf } = await import('../../../../src/common/scoring/state')
      await score(ctx, fixture, game => [
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
    },

    'c4-saves-lineup-before-game-begins': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await coach.as('headCoach')
      await coach.coachGame()
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
      await coach.as('scorekeeper')
      await coach.scoreGame()
      await coach.openRosters()
      expect(await coach.lineup()).deep.equals(mine)
      await coach.tap('Cancel')
      // Not started by it: still scheduled, not live.
      const game = await (
        await clientAs(ctx, fixture, 'headCoach')
      ).game(fixture.gameId)
      expect(game.status).equals('scheduled')
    },

    'c6-asks-before-leaving-staged-changes': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await coach.as('headCoach')
      await coach.coachGame()
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
      // The browser's own Back.
      await coach.m.back()
      await asked()
      await coach.tap('Keep editing')
      await sleep(300)
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
      await coach.tap('Coach')
      await coach.page.waitForSelector('[aria-label="Save Rosters"]')
      await coach.tap('Lineup', 'tab')
      await coach.dragAfter(0, 2)
      await coach.m.back()
      await asked()
      await coach.tap('Discard')
      await coach.page.waitForSelector(
        '[aria-label="Box score"][aria-selected="true"]',
        { timeout: 30000 }
      )
    },

    'c7-warns-when-scorekeeper-saves-under-him': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.tap('Lineup', 'tab')
      await coach.page.waitForSelector('[data-roster-target="lineup-0"]')
      const before = await coach.lineup()
      await coach.tap('Remove Canha')
      const mine = await coach.lineup()
      expect(mine).not.includes('Canha')
      // The scorekeeper's session moves his leadoff to third and saves it.
      const theirs = [before[1], before[2], before[0], ...before.slice(3)]
      await score(ctx, fixture, game => {
        const order = [...game.liveData.boxscore.teams.home.battingOrder]
        order.splice(2, 0, order.shift())
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
    },

    'c8-keeps-staged-change-refused-mid-play': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      // The scorekeeper has a ball in play, waiting for its result.
      await score(ctx, fixture, [
        { type: 'pitch', call: 'B' },
        { type: 'ballInPlay', contact: 'swing' }
      ])
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.tap('Lineup', 'tab')
      await coach.page.waitForSelector('[data-roster-target="lineup-0"]')
      await coach.dragAfter(0, 2)
      const staged = await coach.lineup()
      const client = await clientAs(ctx, fixture, 'headCoach')
      const before = (await client.gameLineups(fixture.gameId)).home.current
      await coach.tapEnabled('Save Rosters')
      await coach.page.waitForFunction(
        () =>
          String(document.body.textContent).includes(
            'Finish the current play first'
          ),
        { timeout: 30000 }
      )
      // Kept as saved on the screen, and held for the coach to send again or
      // drop, as on the phone (Intake 9 of #358); the server's is unchanged.
      expect(await coach.lineup()).deep.equals(staged)
      expect(
        (await client.gameLineups(fixture.gameId)).home.current
      ).deep.equals(before)
      await coach.heldThenServerCopy('Finish the current play first')
      expect(
        (await client.gameLineups(fixture.gameId)).home.current
      ).deep.equals(before)
    }
  }
})
