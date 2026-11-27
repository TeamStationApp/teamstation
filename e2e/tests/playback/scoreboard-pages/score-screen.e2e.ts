import { expect } from 'chai'

import { defineHarness, type HarnessContext } from '../../../core/spec'
import type { Page } from '../../../core/web'
import { type EventWeb, openEventWeb } from '../../../rigs/eventWeb'
import {
  apiOf,
  type Boards,
  seedBoards,
  sleep,
  until
} from '../scoreboard-server/boardSockets'
import {
  anonymousSession,
  boardShows,
  longPress,
  notFoundShown,
  openPath,
  pressTimed,
  shot,
  tap
} from './boardPage'

/**
 * The Score screen and the override dashboard (the old E10 and E11), in
 * this machine's Chrome: the scoring screen they open draws its field in 3D.
 * The game's runner presses through them, a viewer's board in another
 * browser follows, and a plain member of the team is refused. Every press is
 * a maestro-d tap; the pages are only read.
 */

const DESKTOP = { width: 1200, height: 900 }

/** The game page has loaded: its Box score pill, or its not-found message. */
async function gameLoaded(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Box score"]') != null ||
      String(document.body.textContent).includes('That game is not here'),
    { timeout: 30_000 }
  )
  // The pill depends on the same answer as the tabs, but give a late render
  // a moment before saying it is absent.
  await sleep(500)
}

async function tileOverridden(page: Page, group: string): Promise<boolean> {
  return await page.evaluate(group => {
    const tile = document.querySelector(
      `[data-testid="override-tile-${group}"]`
    )
    return (
      tile !== null &&
      // 1.0's override colour, tsMediumOlive #6B8E4E.
      getComputedStyle(tile).backgroundColor === 'rgb(107, 142, 78)'
    )
  }, group)
}

/** Where the Score screen's parts sit, top to bottom, and its link. */
async function scoreGameScreen(page: Page): Promise<{
  inOrder: boolean
  link: string
  monospace: boolean
  copyIcon: boolean
}> {
  await page.waitForSelector('[aria-label="Copy scoreboard link"]')
  return await page.evaluate(() => {
    const text = String(document.body.textContent)
    // Each part after the one before it: the game's page stays under the
    // screen, and its teams may have "Scoreboard" in their names.
    let from = 0
    const order = [
      'Score game with full stats (ie. pitches, hits, walks, errors)',
      'Full game scoring',
      'Operate simplified scoreboard with only bases, balls, strikes, outs, and inning',
      'Scoreboard',
      'Web Widget Scoreboard Link'
    ].map(part => {
      const at = text.indexOf(part, from)
      if (at >= 0) from = at + part.length
      return at
    })
    const link = document.querySelector('[data-testid="scoreboardLink"]')
    // No optional chaining in here: it runs in the page, where Sucrase's
    // helper for it does not exist.
    const copy = document.querySelector('[aria-label="Copy scoreboard link"]')
    return {
      inOrder:
        !order.includes(-1) &&
        order.every((at, i) => i === 0 || at > order[i - 1]),
      link: link == null ? '' : String(link.textContent),
      monospace:
        link != null && getComputedStyle(link).fontFamily.includes('monospace'),
      copyIcon:
        copy != null && String(copy.textContent).includes('content_copy')
    }
  })
}

/** Whether a button is there and disabled, and the reason under it. */
async function disabledWith(
  page: Page,
  label: string,
  reason: string
): Promise<boolean> {
  return await page.evaluate(
    (label, reason) => {
      const button = document.querySelector(`[aria-label="${label}"]`)
      return (
        // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- Browser evaluation cannot reference generated Sucrase helpers.
        button != null &&
        button.getAttribute('aria-disabled') === 'true' &&
        String(document.body.textContent).includes(reason)
      )
    },
    label,
    reason
  )
}

const pathIs = async (page: Page, end: string): Promise<void> => {
  await page.waitForFunction(
    (end: string) => location.pathname.endsWith(end),
    {},
    end
  )
}

async function runnerWeb(
  ctx: HarnessContext,
  boards: Boards,
  observeNetwork = false
): Promise<EventWeb> {
  const web = await openEventWeb(ctx, boards.world.accounts.runner, DESKTOP, {
    observeNetwork
  })
  web.page.setDefaultTimeout(30_000)
  return web
}

/**
 * E10: one Score pill opens the Score screen, whose Scoreboard taps reach the
 * board, and a non-runner gets no pill.
 */
async function dashboardReachesBoard(ctx: HarnessContext): Promise<void> {
  const boards = await seedBoards(ctx)
  const gameId = boards.games['-10m']
  const origin = ctx.stack.origin
  const web = await runnerWeb(ctx, boards)
  // Tapping copy writes the clipboard, and the scenario reads it back.
  await web.m.grantPermissions({
    permissions: ['clipboard-read', 'clipboard-write'],
    origin
  })
  const runner = web.session
  const page = web.page

  // 1. Exactly one Score pill, and no Override Scoreboard pill.
  await web.go(`/games/${gameId}`)
  await page.waitForSelector('[aria-label="Score"]')
  expect(await page.$$('[aria-label="Score"]')).length(1)
  expect(await page.$('[aria-label="Override Scoreboard"]')).equals(null)
  expect(await page.$('[aria-label="Continue Scoring"]')).equals(null)
  await shot(ctx, runner, 'gamePill')

  // 2. The Score screen, top to bottom, and its link copied.
  await tap(runner, 'Score')
  await pathIs(page, '/score-game')
  expect(new URL(page.url()).pathname).equals(`/games/${gameId}/score-game`)
  expect(await scoreGameScreen(page)).deep.equals({
    inOrder: true,
    link: `${origin}/scoreboard/${gameId}`,
    monospace: true,
    copyIcon: true
  })
  await shot(ctx, runner, 'scoreGameRunner')
  await tap(runner, 'Copy scoreboard link')
  await page.waitForFunction(() =>
    String(document.body.textContent).includes('Copied')
  )
  expect(
    await page.evaluate(async () => await navigator.clipboard.readText())
  ).equals(`${origin}/scoreboard/${gameId}`)
  await shot(ctx, runner, 'scoreGameCopied')
  await until(
    '"Copied" gone after 2 s',
    async () =>
      !(await page.evaluate(() =>
        String(document.body.textContent).includes('Copied')
      )),
    4000
  )

  // 2a. Full game scoring opens the scorer, and Back returns here.
  await tap(runner, 'Full game scoring')
  await pathIs(page, '/score')
  expect(new URL(page.url()).pathname).equals(`/games/${gameId}/score`)
  await page.waitForSelector('canvas[data-field-ready="true"]')
  await web.m.back()
  await page.waitForSelector('[aria-label="Copy scoreboard link"]')
  expect(new URL(page.url()).pathname).equals(`/games/${gameId}/score-game`)

  // 2b. Scoreboard opens the dashboard at its own address.
  await tap(runner, 'Scoreboard')
  await pathIs(page, '/scoreboard-override')
  expect(new URL(page.url()).pathname).equals(
    `/games/${gameId}/scoreboard-override`
  )

  // 3. B twice reaches a viewer in another browser.
  const viewerSession = await anonymousSession(ctx)
  const viewer = await openPath(ctx, viewerSession, `/scoreboard/${gameId}`)
  await boardShows(viewer, 'the first state', one => one.count === '0-0')
  await tap(runner, 'Add a ball')
  await boardShows(viewer, '1-0', one => one.count === '1-0')
  const tapped = await pressTimed(runner, 'Add a ball')
  await boardShows(viewer, '2-0', one => one.count === '2-0', 5000)
  const took = Date.now() - tapped
  expect(took, `2-0 on the viewer ${took} ms after the tap`).lessThan(1000)
  expect(await tileOverridden(page, 'count')).equals(true)

  // 4. The count tile's ✕ puts the automated count back.
  await tap(runner, 'Revert count')
  await boardShows(viewer, 'the automated 0-0', one => one.count === '0-0')
  expect(await tileOverridden(page, 'count')).equals(false)

  // 5. A base, the home score tapped twice, then long-pressed and picked,
  // then Reset.
  await tap(runner, 'Second base')
  await boardShows(viewer, 'second base', one => one.bases[1])
  await tap(runner, 'Home score')
  await boardShows(viewer, 'home 1', one => one.homeScore === '1')
  await tap(runner, 'Home score')
  await boardShows(viewer, 'home 2', one => one.homeScore === '2')
  await longPress(runner, 'Home score')
  await tap(runner, 'Pick 9')
  await boardShows(viewer, 'home 9', one => one.homeScore === '9')
  expect(await tileOverridden(page, 'bases')).equals(true)
  expect(await tileOverridden(page, 'score-home')).equals(true)
  await shot(ctx, runner, 'dashboard')
  await tap(runner, 'Reset Game State')
  await boardShows(
    viewer,
    'everything automated again',
    one => !one.bases[1] && one.homeScore === '0' && one.count === '0-0'
  )
  await until(
    'every tile back to automated',
    async () =>
      !(await tileOverridden(page, 'bases')) &&
      !(await tileOverridden(page, 'score-home'))
  )
  await viewerSession.close()

  // 6. A plain member of the team, who sees the game but may not score it.
  const answer = await fetch(`${apiOf(ctx)}/games/${gameId}`, {
    headers: { authorization: `Bearer ${boards.other}` }
  })
  expect(answer.status, 'the game is visible to a plain member').equals(200)
  const theirGame = (await answer.json()) as {
    canScore: boolean
    scoreboard: unknown
    homeScore: unknown
    awayScore: unknown
  }
  expect(theirGame.canScore).equals(false)
  expect(theirGame.scoreboard).deep.equals({ open: true, mayOverride: false })
  expect(
    [theirGame.homeScore, theirGame.awayScore],
    'the game is unscored'
  ).deep.equals([null, null])
  const other = await openEventWeb(ctx, boards.world.accounts.other, {
    width: 1280,
    height: 720
  })
  other.page.setDefaultTimeout(30_000)
  await other.go(`/games/${gameId}`)
  await gameLoaded(other.page)
  expect(
    await other.page.$('[aria-label="Box score"]'),
    'the game page loaded'
  ).not.equals(null)
  expect(
    await other.page.$('[aria-label="Score"]'),
    'no Score pill for somebody who may not score'
  ).equals(null)
  expect(await other.page.$('[aria-label="Override Scoreboard"]')).equals(null)
  await shot(ctx, other.session, 'gameMember')
  await other.go(`/games/${gameId}/score-game`)
  await scoreGameScreen(other.page)
  expect(
    await disabledWith(
      other.page,
      'Scoreboard',
      'Only people who run a team in this game can operate the scoreboard'
    )
  ).equals(true)
  await shot(ctx, other.session, 'scoreGameMember')
  await other.go(`/games/${gameId}/scoreboard-override`)
  await until('the branded 404', async () => await notFoundShown(other.page))
  await shot(ctx, other.session, 'dashboardRefused')
}

/** E10: the scorer path, pill to Score screen to one pitch and Back. */
async function scorerPath(ctx: HarnessContext): Promise<void> {
  const boards = await seedBoards(ctx)
  const gameId = boards.games['+1h']
  const web = await runnerWeb(ctx, boards, true)
  const runner = web.session
  const page = web.page
  await web.go(`/games/${gameId}`)
  await tap(runner, 'Score')
  await pathIs(page, '/score-game')
  await tap(runner, 'Full game scoring')
  await pathIs(page, '/score')
  await page.waitForSelector('canvas[data-field-ready="true"]')
  if ((await page.$('[aria-label="OK"]')) != null) await tap(runner, 'OK')
  await tap(runner, 'Open scoring menu')
  await tap(runner, 'Set Team Rosters')
  await tap(runner, 'Save Rosters')
  const saved = page.waitForResponse(
    response =>
      response.request().method() === 'POST' &&
      // The save asks for its edits back: `…/events?answer=edits`.
      new URL(response.url()).pathname.endsWith(`/games/${gameId}/events`) &&
      response.status() === 200
  )
  await tap(runner, 'Ball')
  await page.waitForSelector('[aria-label="Undo Ball"]')
  await saved
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Save status"]') == null
  )
  // Back returns to the Score screen, where the scorer was opened.
  await web.m.back()
  // The Score screen stays mounted under the scorer: wait for the address.
  await pathIs(page, '/score-game')
  expect(new URL(page.url()).pathname).equals(`/games/${gameId}/score-game`)
  // Saving rosters and scoring the pitch both post to this route. Observe
  // the committed pitch even if the first successful POST saved the roster.
  await until('the pitch was stored', async () => {
    const events = await fetch(`${apiOf(ctx)}/games/${gameId}/events`, {
      headers: { authorization: `Bearer ${boards.runner}` }
    })
    expect(events.status).equals(200)
    const stored = (await events.json()) as {
      currentPlay: { playEvents?: unknown[] } | null
      plays: unknown[]
    }
    return (
      (stored.currentPlay?.playEvents ?? []).length + stored.plays.length > 0
    )
  })
}

/**
 * E11: an expired game's dashboard is the branded 404, and its Score screen
 * says the board has closed.
 */
async function expiredGame(ctx: HarnessContext): Promise<void> {
  const boards = await seedBoards(ctx)
  const gameId = boards.games['-4h']
  const web = await runnerWeb(ctx, boards)
  await web.go(`/games/${gameId}/scoreboard-override`)
  await until('the branded 404', async () => await notFoundShown(web.page))
  await web.go(`/games/${gameId}/score-game`)
  const screen = await scoreGameScreen(web.page)
  expect(screen.link).equals(`${ctx.stack.origin}/scoreboard/${gameId}`)
  expect(
    await disabledWith(
      web.page,
      'Scoreboard',
      "This game's scoreboard has closed"
    )
  ).equals(true)
  await shot(ctx, web.session, 'scoreGameClosed')
}

export default defineHarness({
  id: 'playback/scoreboard-pages/score-screen',
  title:
    'The Score screen and the override dashboard reach the board for the game’s runner, and nobody else',
  kind: 'e2e',
  covers: [
    'src/app/scoreboard/ScoreGameScreen.tsx',
    'src/app/scoreboard/ScoreboardOverrideScreen.tsx',
    'src/app/scoreboard/scoreboardDashboardClient.ts',
    'src/app/scoreboard/overrideModel.ts',
    'src/app/scoring/**'
  ],
  stack: 'isolated',
  fixtures: ['scoreboard-games'],
  exclusive: false,
  surfaces: {
    // The scorer the Score screen opens draws its field in 3D: the Mac's
    // Chrome.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['gpu'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 5,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'dashboard-reaches-board': dashboardReachesBoard,
    'scorer-path': scorerPath,
    'expired-game': expiredGame
  }
})
