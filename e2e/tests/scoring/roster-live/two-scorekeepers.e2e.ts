import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { readJson } from '../../../core/readback'
import { BlockedError } from '../../../core/result'
import {
  defineHarness,
  type HarnessContext,
  type WebSession
} from '../../../core/spec'
import type { HTTPRequest, HTTPResponse } from '../../../core/web'
import { clearSignInLimits } from '../../../rigs/coach/coachApp'
import {
  type DocumentNetwork,
  watchDocumentNetwork
} from '../../../rigs/documentNetworkIdle'
import { dragLineupRow } from '../../../rigs/rosterDrag'

/* The functions puppeteer runs in the page are transpiled by sucrase, which
   turns ?. and ?? into helpers the page does not have. */

/**
 * Two scorekeepers on one game, each in the runner's Chrome at an iPhone's
 * 402×874, against the stack: its API with the game socket, its web build
 * and the `lineup-game` world, seeded afresh for each scenario. Both sign
 * in as the world's scorekeeper, each in a browser profile of its own.
 * What one saves reaches the other over the game socket.
 *
 * L4 holds every API request open at the stack (`api-hang`), then takes
 * A's browser offline: each roster, lineup and defense change shows at
 * once. L5 has both profiles change one side's lineup, the earlier change
 * saved last: the later creation time wins on both screens.
 */
const WIDTH = 402
const HEIGHT = 874
const BANNER =
  'Another user has edited the roster. Your pending changes may overwrite theirs. Hit Cancel to revert to their changes.'

/** The game, and the scorekeeper's API token for reading it back. */
interface Game {
  gameId: string
  token: () => Promise<string>
}

/** A new `lineup-game` world: its game, its rosters and its scorekeeper. */
async function lineupGame(ctx: HarnessContext): Promise<Game> {
  const world = await ctx.fixture('lineup-game')
  const account = world.accounts.scorekeeper
  let token: string | undefined
  return {
    gameId: world.ids.game,
    token: async () => {
      if (token == null) {
        const { signInTestAccount } =
          await import('../../../../src/test/passwordFixtures')
        token = await signInTestAccount(`${ctx.stack.origin}/api/v1`, account)
      }
      return token
    }
  }
}

let lines: string[] = []
function log(line: string): void {
  lines.push(line.trim())
}

/** Sets the stack's fault, or clears it. */
async function hold(ctx: HarnessContext, fault: string | null): Promise<void> {
  const setFault = ctx.stack.setFault
  if (setFault == null)
    throw new BlockedError('needs a stack whose fault server can be set')
  await setFault(fault)
}

/** One scorekeeper's browser, and what the scenarios do in it. */
class Scorer {
  readonly m: any
  readonly page: WebSession['page']

  constructor(
    readonly ctx: HarnessContext,
    readonly session: WebSession,
    readonly network: DocumentNetwork
  ) {
    this.m = session.m
    this.page = session.page
  }

  async settled(): Promise<void> {
    await this.network.wait(500, [new URL(this.ctx.stack.origin).origin])
  }

  async tap(label: string, role?: string): Promise<void> {
    const css =
      role == null
        ? `[aria-label="${label}"]`
        : `[aria-label="${label}"][role="${role}"]`
    await this.page.waitForSelector(css)
    await this.m.tapOn({ css, timeout: 15000 })
  }

  /** A control that takes a tap once it is enabled, tapped. */
  async tapEnabled(label: string): Promise<void> {
    await this.page.waitForFunction(
      (label: string) => {
        const node = document.querySelector(`[aria-label="${label}"]`)
        return node != null && node.getAttribute('aria-disabled') !== 'true'
      },
      { timeout: 30000 },
      label
    )
    await this.tap(label)
  }

  /** The scoring screen for this game, its help dismissed. */
  async scoreGame(gameId: string): Promise<void> {
    await this.m.openLink({
      link: `${this.ctx.stack.origin}/games/${gameId}/score`
    })
    await this.page.waitForSelector('[aria-label="Open scoring menu"]', {
      timeout: 60000
    })
    for (const label of ['OK', 'Close'])
      if ((await this.page.$(`[aria-label="${label}"]`)) != null)
        await this.tap(label)
  }

  /** The roster sheet, on the away team's Lineup tab. */
  async openRosters(): Promise<void> {
    await this.tap('Open scoring menu')
    await this.tap('Set Team Rosters')
    await this.page.waitForSelector('[aria-label="Save Rosters"]', {
      timeout: 30000
    })
    await this.tap('Away Team', 'tab')
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
      (names: string[]) => {
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

  async banner(): Promise<string | null> {
    return await this.page.evaluate(() => {
      const node = document.querySelector('[data-testid="Roster conflict"]')
      return node == null ? null : String(node.textContent)
    })
  }

  /** A mouse drag of the lineup row at `source` to the boundary after `target`. */
  async dragAfter(source: number, target: number): Promise<void> {
    await dragLineupRow(
      this.m,
      this.page,
      `[data-roster-target="lineup-${source}"]`,
      `[data-roster-target="lineup-${target}"]`,
      'after'
    )
  }

  /** The roster sheet's editor is up, with no spinner in its place. */
  async editorShownWithin(ms: number): Promise<number> {
    const started = Date.now()
    await this.tap('Open scoring menu')
    await this.tap('Set Team Rosters')
    await this.page.waitForSelector('[aria-label="Save Rosters"]', {
      timeout: ms
    })
    expect(await this.page.$('[aria-label="Refreshing game"]')).equals(null)
    return Date.now() - started
  }

  /** Taps Save Rosters and answers how long the sheet took to close. */
  async saveShownWithin(ms: number): Promise<number> {
    const started = Date.now()
    await this.tapEnabled('Save Rosters')
    await this.page.waitForSelector('[aria-label="Save Rosters"]', {
      hidden: true,
      timeout: ms
    })
    return Date.now() - started
  }

  /** This browser with no network, or with it back. */
  async offline(on: boolean): Promise<void> {
    await this.m.setNetworkConditions({ offline: on })
  }

  /** Counts this browser's API requests from now on that have no answer yet. */
  unanswered(): { count: () => number; stop: () => void } {
    const open = new Set<HTTPRequest>()
    const started = (request: HTTPRequest): void => {
      if (request.url().includes('/api/')) open.add(request)
    }
    const ended = (request: HTTPRequest): void => {
      open.delete(request)
    }
    this.page.on('request', started)
    this.page.on('requestfinished', ended)
    this.page.on('requestfailed', ended)
    return {
      count: () => open.size,
      stop: () => {
        this.page.off('request', started)
        this.page.off('requestfinished', ended)
        this.page.off('requestfailed', ended)
      }
    }
  }

  /**
   * The next server answer to this scorer's save of this game, or with
   * `status` the next one of that status; failing, it names the others seen.
   */
  async scoringResponse(
    gameId: string,
    status?: number
  ): Promise<HTTPResponse> {
    const path = `/api/v1/games/${gameId}/events`
    const seen: number[] = []
    try {
      return await this.page.waitForResponse(
        response => {
          if (
            response.request().method() !== 'POST' ||
            new URL(response.url()).pathname !== path
          )
            return false
          if (status == null || response.status() === status) return true
          seen.push(response.status())
          return false
        },
        { timeout: 60000 }
      )
    } catch (error) {
      throw new Error(
        `No ${status == null ? '' : status + ' '}answer to POST ${path}; saw [${seen.join(', ')}]`,
        { cause: error }
      )
    }
  }

  /** Every save has gone out and come back. */
  async waitSaved(): Promise<void> {
    await this.settled()
    await this.page.waitForFunction(
      () => document.querySelector('[aria-label="Save status"]') == null,
      { timeout: 30000 }
    )
  }

  /** The scoreboard's summary: score, half inning, count, outs and batter. */
  async scoreboard(): Promise<string> {
    return await this.page.$eval('[aria-label*=" balls "]', node =>
      String(node.getAttribute('aria-label'))
    )
  }

  async waitScoreboard(text: string, timeout = 15000): Promise<void> {
    await this.page.waitForFunction(
      (text: string) =>
        String(
          document
            .querySelector('[aria-label*=" balls "]')!
            .getAttribute('aria-label')
        ).includes(text),
      { timeout },
      text
    )
  }

  async shot(name: string): Promise<void> {
    await this.m.waitForAnimationToEnd()
    await this.m.takeScreenshot({ path: this.ctx.artifact(name) })
  }
}

/** Two scorekeepers' browsers, each signed in on a profile of its own, as two phones would be. */
async function scorers(ctx: HarnessContext): Promise<[Scorer, Scorer]> {
  await clearSignInLimits(ctx)
  const made: Scorer[] = []
  for (let i = 0; i < 2; i++) {
    const session = await ctx.browser(
      { width: WIDTH, height: HEIGHT },
      { observeNetwork: true }
    )
    session.page.setDefaultTimeout(30000)
    await session.m.openLink({ link: `${ctx.stack.origin}/` })
    await ctx.signIn('scorekeeper', session.m)
    const network = await watchDocumentNetwork(session.page)
    made.push(new Scorer(ctx, session, network))
  }
  return [made[0], made[1]]
}

/** Runs a scenario with its log kept in the run directory. */
function logged(
  name: string,
  scenario: (ctx: HarnessContext) => Promise<void>
): (ctx: HarnessContext) => Promise<void> {
  return async ctx => {
    lines = []
    try {
      await scenario(ctx)
    } finally {
      writeFileSync(ctx.artifact(`${name}.log`), lines.join('\n') + '\n')
    }
  }
}

export default defineHarness({
  id: 'scoring/roster-live/two-scorekeepers',
  title:
    'Two scorekeepers on one game see each other’s rosters and pitches live',
  kind: 'e2e',
  covers: [
    'src/app/scoring/rosterLive.tsx',
    'src/app/scoring/RosterEditor.tsx',
    'src/app/scoring/RosterSelector.tsx',
    'src/app/scoring/RosterDrag.tsx',
    'src/server/scoring/rosterWrites.ts',
    'src/server/scoring/mergeConflicts.ts'
  ],
  stack: 'isolated',
  fixtures: ['lineup-game'],
  // L4 holds every API request at the stack's fault server.
  exclusive: true,
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
  minutes: 25,
  guards: [],
  // L4 sets and clears `api-hang` itself, as setup.
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'saved-order-no-warning': logged('saved-order-no-warning', async ctx => {
      const fixture = await lineupGame(ctx)
      const [a, b] = await scorers(ctx)
      await a.scoreGame(fixture.gameId)
      await b.scoreGame(fixture.gameId)
      await a.openRosters()
      const before = await a.lineup()
      expect(before.slice(0, 3)).deep.equals(['Judge', 'Altuve', 'Bregman'])
      await b.openRosters()
      await b.dragAfter(0, 2)
      const theirs = await b.lineup()
      expect(theirs.slice(0, 3)).deep.equals(['Altuve', 'Bregman', 'Judge'])
      await b.tapEnabled('Save Rosters')
      await b.page.waitForSelector('[aria-label="Save Rosters"]', {
        hidden: true
      })
      await b.waitSaved()
      await a.waitLineup(theirs)
      expect(await a.banner()).equals(null)
      expect(await a.saveDisabled()).equals(true)
      await a.tap('Cancel')
    }),
    'warns-over-staged-changes': logged(
      'warns-over-staged-changes',
      async ctx => {
        const fixture = await lineupGame(ctx)
        const [a, b] = await scorers(ctx)
        await a.scoreGame(fixture.gameId)
        await b.scoreGame(fixture.gameId)
        expect(await a.page.$('[aria-label="Undo Last play"]')).equals(null)
        await a.openRosters()
        // A stages a change of his own: Maldonado out of the lineup.
        await a.tap('Remove Maldonado')
        const mine = await a.lineup()
        expect(mine).not.includes('Maldonado')
        expect(await a.saveDisabled()).equals(false)
        await b.openRosters()
        await b.dragAfter(0, 2)
        const theirs = await b.lineup()
        await b.tapEnabled('Save Rosters')
        await b.page.waitForSelector('[aria-label="Save Rosters"]', {
          hidden: true
        })
        await b.waitSaved()
        await a.page.waitForSelector('[data-testid="Roster conflict"]', {
          timeout: 15000
        })
        expect(await a.banner()).equals(BANNER)
        expect(await a.lineup()).deep.equals(mine)
        expect(await a.saveDisabled()).equals(false)
        // The warning sits at the top of the screen, in the yellow outline.
        const style = await a.page.$eval(
          '[data-testid="Roster conflict"]',
          node => {
            const box = node.getBoundingClientRect()
            const css = getComputedStyle(node)
            return {
              top: box.top,
              width: box.width,
              border: css.borderTopColor,
              borderWidth: css.borderTopWidth
            }
          }
        )
        expect(style.top).lessThan(120)
        expect(style.width).greaterThan(WIDTH - 80)
        expect(style.borderWidth).equals('2px')
        expect(style.border).equals('rgb(197, 161, 60)')
        await a.shot('roster-conflict-banner.png')
        await a.tap('Cancel')
        await a.page.waitForSelector('[aria-label="Save Rosters"]', {
          hidden: true
        })
        // The scoring screen behind took theirs up, with no page reload: their
        // change is the one step it can take back.
        await a.page.waitForSelector('[aria-label="Undo Last play"]', {
          timeout: 15000
        })
        await a.openRosters()
        expect(await a.lineup()).deep.equals(theirs)
        expect(await a.banner()).equals(null)
        await a.tap('Cancel')
      }
    ),
    'other-pitch-within-3s': logged('other-pitch-within-3s', async ctx => {
      const fixture = await lineupGame(ctx)
      const [a, b] = await scorers(ctx)
      await a.scoreGame(fixture.gameId)
      await b.scoreGame(fixture.gameId)
      expect(await a.scoreboard()).includes('0 balls 0 strikes')
      await a.settled()
      await b.tapEnabled('Ball')
      const tapped = Date.now()
      await a.waitScoreboard('1 balls 0 strikes', 3000)
      const took = Date.now() - tapped
      log(`      A showed B's ball ${took} ms after B's tap`)
      expect(took).lessThan(3000)
      await a.tapEnabled('Called Strike')
      await a.waitScoreboard('1 balls 1 strikes')
      await a.waitSaved()
      // Stored in that order: B's ball, then A's strike.
      const events = (await readJson(
        ctx.stack.origin,
        `/api/v1/games/${fixture.gameId}/events`,
        { headers: { Authorization: `Bearer ${await fixture.token()}` } }
      )) as {
        currentPlay: { playEvents: Array<{ details: { code: string } }> } | null
      }
      expect(
        events.currentPlay!.playEvents.map(event => event.details.code)
      ).deep.equals(['B', 'C'])
      // And B, reading the game again, sees both.
      await b.waitScoreboard('1 balls 1 strikes')
    }),
    'held-then-offline': logged('held-then-offline', async ctx => {
      const fixture = await lineupGame(ctx)
      const [a, b] = await scorers(ctx)
      await a.scoreGame(fixture.gameId)
      await a.settled()
      // Every API request from here is held open at the stack: none is
      // answered. Only A acts while they are held.
      let removed: string[]
      const held = a.unanswered()
      await hold(ctx, 'api-hang')
      try {
        const opened = await a.editorShownWithin(3000)
        log(
          `      held: the roster editor showed ${opened} ms after the menu tap, no spinner`
        )
        await a.tap('Away Team', 'tab')
        await a.tap('Lineup', 'tab')
        await a.page.waitForSelector('[data-roster-target="lineup-0"]')
        // Lineup and roster: Maldonado out of the order, onto the roster.
        await a.tap('Remove Maldonado')
        removed = await a.lineup()
        expect(removed).not.includes('Maldonado')
        await a.page.waitForSelector('[aria-label="Add Maldonado to Lineup"]')
        const saved = await a.saveShownWithin(3000)
        log(
          `      held: Save Rosters closed the sheet ${saved} ms after the tap`
        )
        const reopened = await a.editorShownWithin(3000)
        log(
          `      held: the editor showed again ${reopened} ms after the menu tap`
        )
        await a.tap('Away Team', 'tab')
        await a.tap('Lineup', 'tab')
        expect(await a.lineup()).not.includes('Maldonado')
        // Defense: the fielding side cleared, and the field waits for a pitcher.
        await a.tap('Home Team', 'tab')
        await a.tap('Defense', 'tab')
        await a.tap('Clear Defense')
        const cleared = await a.saveShownWithin(3000)
        log(
          `      held: the cleared defense saved on screen ${cleared} ms after the tap`
        )
        await a.page.waitForFunction(
          () => String(document.body.textContent).includes('Assign a pitcher'),
          { timeout: 3000 }
        )
        log(`      held: ${held.count()} API requests still unanswered`)
        expect(held.count()).greaterThan(0)
      } finally {
        // The held requests are let go; the app sends what they carried again.
        held.stop()
        await hold(ctx, null)
      }
      // B reads this game for the first time. Keep A alive until the saved
      // removal reaches B, even if releasing the held requests took time.
      try {
        await b.scoreGame(fixture.gameId)
        await b.openRosters()
        await b.waitLineup(removed)
        await b.tap('Cancel')
      } finally {
        await a.m.openLink({ link: 'about:blank' })
      }
      // Offline: the same, with nothing to reach.
      await a.scoreGame(fixture.gameId)
      await a.settled()
      await a.offline(true)
      try {
        const opened = await a.editorShownWithin(3000)
        log(
          `      offline: the roster editor showed ${opened} ms after the menu tap, no spinner`
        )
        await a.tap('Away Team', 'tab')
        await a.tap('Lineup', 'tab')
        await a.page.waitForSelector('[data-roster-target="lineup-0"]')
        const before = await a.lineup()
        await a.tap(`Add Maldonado to Lineup`)
        expect(await a.lineup()).deep.equals([...before, 'Maldonado'])
        const saved = await a.saveShownWithin(3000)
        log(
          `      offline: Save Rosters closed the sheet ${saved} ms after the tap`
        )
        await a.editorShownWithin(3000)
        await a.tap('Away Team', 'tab')
        await a.tap('Lineup', 'tab')
        expect(await a.lineup()).deep.equals([...before, 'Maldonado'])
        await a.tap('Cancel')
      } finally {
        await a.offline(false)
        // A request made offline can hang there rather than fail: the offline
        // phase's page goes too, as the held phase's does, so L5 starts from a
        // fresh load.
        await a.m.openLink({ link: 'about:blank' })
      }
    }),
    'later-change-wins': logged('later-change-wins', async ctx => {
      const fixture = await lineupGame(ctx)
      const [a, b] = await scorers(ctx)
      await a.scoreGame(fixture.gameId)
      await b.scoreGame(fixture.gameId)
      await a.settled()
      // A makes his change first, with no signal: it waits on his phone.
      await a.offline(true)
      await a.openRosters()
      await a.tap('Remove Maldonado')
      const earlier = await a.lineup()
      await a.saveShownWithin(3000)
      const madeA = Date.now()
      await new Promise(resolve => setTimeout(resolve, 1500))
      // B makes his later, online, and it lands first.
      await b.openRosters()
      await b.dragAfter(0, 2)
      const later = await b.lineup()
      expect(later).not.deep.equals(earlier)
      const [accepted] = await Promise.all([
        b.scoringResponse(fixture.gameId),
        b.saveShownWithin(3000)
      ])
      expect(accepted.status()).equals(200)
      const madeB = Date.now()
      await b.waitSaved()
      log(
        `      A's change made ${madeB - madeA} ms before B's; B's saved first`
      )
      // A submitted only the offline removal. Its refusal proves that it
      // reached the server after B's write, before either winner check.
      const [refused] = await Promise.all([
        a.scoringResponse(fixture.gameId, 409),
        a.offline(false)
      ])
      expect(refused.status()).equals(409)
      expect(await refused.json()).deep.include({
        code: 'conflict',
        details: { stale: true }
      })
      await a.openRosters()
      await a.waitLineup(later)
      await a.tap('Cancel')
      const stored = (await readJson(
        ctx.stack.origin,
        `/api/v1/games/${fixture.gameId}/lineups`,
        {
          headers: { Authorization: `Bearer ${await fixture.token()}` }
        }
      )) as {
        away: { current: { batters: Array<{ name: string } | null> } | null }
      }
      const names = stored.away.current!.batters.map(batter =>
        String(batter?.name ?? '')
      )
      log(`      stored away order: ${names.join(', ')}`)
      expect(names.some(name => name.includes('Maldonado'))).equals(true)
      await b.openRosters()
      await b.waitLineup(later)
      await b.tap('Cancel')
      // Made later and saved later: A's change stands over B's.
      await a.openRosters()
      await a.tap('Remove Maldonado')
      const latest = await a.lineup()
      await a.saveShownWithin(3000)
      await a.waitSaved()
      await b.openRosters()
      await b.waitLineup(latest)
      await b.tap('Cancel')
      log('      the later change stood on both screens, whichever saved first')
    })
  }
})
