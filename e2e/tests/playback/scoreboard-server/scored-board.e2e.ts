import { expect } from 'chai'

import { NO_OVERRIDES } from '../../../../src/common/scoreboard'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import { openEventWeb } from '../../../rigs/eventWeb'
import { override, publish } from '../../../rigs/scoreboardPublish'
import { type WebScorer, webScorer } from '../../../rigs/scoring/webScorer'
import { getJson, latest, seedBoards, sleep, until, view } from './boardSockets'

/**
 * The old M1 E3: what the scorer scores in the browser, what TS Watcher
 * publishes, and the override dashboard all reach a viewer's socket, each
 * where it belongs. The web scorer runs in this machine's Chrome (the
 * scoring screen draws its field in 3D); its presses are maestro-d's, and
 * the page is only read.
 */

/** Presses a pitch button, and says when the press reached the page. */
async function pitch(scorer: WebScorer, label: string): Promise<number> {
  await scorer.page.waitForFunction(
    () => {
      const ball = document.querySelector('[aria-label="Ball"]')
      return ball != null && ball.getAttribute('aria-disabled') !== 'true'
    },
    { timeout: 30_000 }
  )
  // Measured from the input the scorekeeper delivers, as the page sees it.
  await scorer.page.evaluate(
    `window.__pressedAt = new Promise(resolve => document.addEventListener('click', () => resolve(Date.now()), { capture: true, once: true }))`
  )
  await scorer.click(label)
  return (await scorer.page.evaluate('window.__pressedAt')) as number
}

async function scoredBoard(ctx: HarnessContext): Promise<void> {
  const boards = await seedBoards(ctx)
  const { games, runner } = boards
  const gameId = games['-10m']
  const origin = ctx.stack.origin
  const viewer = view(ctx, gameId)
  await viewer.open
  await until('the first state', () => viewer.states.length > 0)
  const shown = (): string => {
    const state = latest(viewer)
    return state == null
      ? ''
      : `${state.balls}-${state.strikes} pitchSpeed ${state.pitchSpeed} home ${state.homeTeam}`
  }
  try {
    const web = await openEventWeb(ctx, boards.world.accounts.runner, {
      width: 1200,
      height: 900
    })
    web.page.setDefaultTimeout(30_000)
    const scorer = webScorer(web.session, origin)
    await scorer.go(`/games/${gameId}`)
    await scorer.click('Score')
    await web.page.waitForFunction(() =>
      location.pathname.endsWith('/score-game')
    )
    await scorer.click('Full game scoring')
    await web.page.waitForFunction(() => location.pathname.endsWith('/score'))
    await web.page.waitForSelector('canvas[data-field-ready="true"]')
    if ((await web.page.$('[aria-label="OK"]')) != null)
      await scorer.click('OK')
    await scorer.click('Open scoring menu')
    await scorer.click('Set Team Rosters')
    await scorer.click('Save Rosters')

    // 1. A ball, scored in the browser.
    const ballAt = await pitch(scorer, 'Ball')
    await until('balls 1', () => latest(viewer)?.balls === 1, 5000)
    const ballMs = viewer.times.at(-1)! - ballAt
    expect(
      ballMs,
      `a scored ball reaches the viewer within 1 s (${shown()})`
    ).lessThanOrEqual(1000)

    // 2. Watcher publishes, team name and all.
    const published = await publish(origin, gameId, runner, {
      balls: 3,
      pitchSpeed: 62,
      homeTeam: 'WRONG'
    })
    await until('balls 3', () => latest(viewer)?.balls === 3)
    const two = latest(viewer)!
    expect(published.delivered, JSON.stringify(published)).equals(true)
    expect(
      { balls: two.balls, pitchSpeed: two.pitchSpeed, homeTeam: two.homeTeam },
      'Watcher’s balls 3 and pitchSpeed 62 show, with the seeded home team'
    ).deep.equals({ balls: 3, pitchSpeed: 62, homeTeam: boards.homeTeam })

    // 3. A strike in the browser: the game is newer, and TagOne's speed stays.
    let count = viewer.states.length
    await pitch(scorer, 'Called Strike')
    await until('1-1', () => {
      const state = latest(viewer)
      return (
        viewer.states.length > count &&
        state?.balls === 1 &&
        state.strikes === 1
      )
    })
    expect(
      latest(viewer)?.pitchSpeed,
      `the game’s 1-1 shows with pitchSpeed 62 still (${shown()})`
    ).equals(62)

    // 4. The count overridden at 0-2.
    const countOverride = {
      ...NO_OVERRIDES,
      overrideCountEnabled: true,
      overrideCount: { balls: 0, strikes: 2, outs: 0 }
    }
    const on = await override(origin, gameId, runner, countOverride)
    await until(
      '0-2',
      () => latest(viewer)?.strikes === 2 && latest(viewer)?.balls === 0
    )
    expect(
      on.delivered,
      `the override is stored: ${JSON.stringify(on)}`
    ).equals(true)

    // 5. Another ball: the override holds over the game's own 2-1.
    count = viewer.states.length
    await pitch(scorer, 'Ball')
    await until('the scored ball to arrive', () => viewer.states.length > count)
    await sleep(500)
    // The game's own board, before the overrides: the dashboard's
    // `automated`, which the stack's store holds for the game.
    const stored = await getJson(ctx, `/scoreboard/${gameId}/dashboard`, runner)
    expect(stored.status).equals(200)
    expect(
      {
        shownBalls: latest(viewer)?.balls,
        shownStrikes: latest(viewer)?.strikes,
        gameBalls: stored.body.automated.balls
      },
      'with the game at 2-1, the override still shows 0-2'
    ).deep.equals({ shownBalls: 0, shownStrikes: 2, gameBalls: 2 })

    // 6. The override off: the game's 2-1.
    const off = await override(origin, gameId, runner, {
      ...countOverride,
      overrideCountEnabled: false
    })
    expect(
      off.delivered,
      `the override off is stored: ${JSON.stringify(off)}`
    ).equals(true)
    await until(
      '2-1',
      () => latest(viewer)?.balls === 2 && latest(viewer)?.strikes === 1
    )
  } finally {
    viewer.socket.close()
  }
}

export default defineHarness({
  id: 'playback/scoreboard-server/scored-board',
  title:
    'Scoring, TS Watcher and the override dashboard each reach a viewer’s board where they belong',
  kind: 'e2e',
  covers: [
    'src/server/scoreboard/**',
    'src/common/scoreboard.ts',
    'src/app/scoring/**'
  ],
  stack: 'isolated',
  fixtures: ['scoreboard-games'],
  exclusive: false,
  surfaces: {
    // The scoring screen draws its field in 3D: the Mac's Chrome.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['gpu'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 4,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'scored-published-and-overridden': scoredBoard
  }
})
