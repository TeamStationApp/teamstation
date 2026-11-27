import { expect } from 'chai'
import { WebSocket } from 'ws'

import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import { publish, scoreboardSocketUrl } from '../../../rigs/scoreboardPublish'
import { getJson, latest, seedBoards, sleep, until, view } from './boardSockets'

/**
 * A game's live board over the stack's own sockets (the old M1 E1, E2, E4
 * and E5): every viewer gets every published state in order, a publisher
 * who may not run the game and a closed game are refused, the board
 * survives the API restarting, and the run list holds the games whose boards
 * are open. Nothing here draws: the browser is not opened.
 */

/** E1: twelve viewers on one game, twenty partials from one publisher. */
async function twelveViewersInOrder(ctx: HarnessContext): Promise<void> {
  const boards = await seedBoards(ctx)
  const gameId = boards.games['-10m']
  const viewers = Array.from({ length: 12 }, () => view(ctx, gameId))
  try {
    await Promise.all(
      viewers.map(async one => {
        await one.open
      })
    )
    await until('every viewer’s first state', () =>
      viewers.every(one => one.states.length > 0)
    )
    const socket = new WebSocket(
      scoreboardSocketUrl(ctx.stack.origin, gameId, 'publish'),
      { headers: { authorization: `Bearer ${boards.runner}` } }
    )
    await new Promise(resolve => socket.once('open', resolve))
    const partials = Array.from({ length: 20 }, (_, i) => ({
      balls: i % 4,
      outs: Math.floor(i / 4) % 3,
      numPitches: 100 + i
    }))
    for (const partial of partials) socket.send(JSON.stringify(partial))
    await until(
      'all 20 on every viewer',
      () => viewers.every(one => latest(one)?.numPitches === 119),
      15_000
    )
    await sleep(300)
    socket.close()
    const wanted = partials.map(p => [p.numPitches, p.balls, p.outs])
    for (const [i, one] of viewers.entries()) {
      const got = one.states
        .filter(state => state.numPitches >= 100)
        .map(state => [state.numPitches, state.balls, state.outs])
      expect(
        got,
        `viewer ${i} received all 20 states, in order, and nothing else new`
      ).deep.equals(wanted)
    }
    const board = await getJson(ctx, `/scoreboard/${gameId}`)
    for (const [i, one] of viewers.entries()) {
      expect(
        JSON.stringify(latest(one)),
        `viewer ${i}'s last state equals GET /scoreboard/<id>`
      ).equals(JSON.stringify(board.body.state))
    }
  } finally {
    for (const one of viewers) one.socket.close()
  }
}

/** E2: no token, a member who runs nothing, and closed games are refused. */
async function refusals(ctx: HarnessContext): Promise<void> {
  const boards = await seedBoards(ctx)
  const { games, other } = boards
  const gameId = games['-10m']
  const anonymous = await publish(ctx.stack.origin, gameId, '', { balls: 1 })
  expect(
    anonymous.closeCode,
    `publish with no token closes 4401: ${JSON.stringify(anonymous)}`
  ).equals(4401)
  // The other person is a plain member: the game is visible to them, but
  // they may not override it, so 4403 is refused for running, not for sight.
  const seen = await getJson(ctx, `/games/${gameId}`, other)
  expect(seen.status, 'the other person sees the game').equals(200)
  expect(seen.body?.scoreboard, 'with mayOverride false').deep.include({
    open: true,
    mayOverride: false
  })
  const outsider = await publish(ctx.stack.origin, gameId, other, {
    balls: 1
  })
  expect(
    outsider.closeCode,
    `publish with the other person's token closes 4403: ${JSON.stringify(outsider)}`
  ).equals(4403)
  for (const name of ['-4h', 'cancelled'] as const) {
    const viewer = view(ctx, games[name])
    try {
      await until(`the ${name} viewer to close`, () => viewer.close)
      expect(viewer.close, `a viewer on the ${name} game closes 4404`).equals(
        4404
      )
    } finally {
      viewer.socket.close()
    }
  }
  const closed = await getJson(ctx, `/scoreboard/${games['-4h']}`)
  expect(closed.status, 'GET /scoreboard/<-4h> is 404').equals(404)
}

/** Restarts the stack's API, or blocks naming the missing control route. */
async function restartApi(ctx: HarnessContext): Promise<void> {
  const control = ctx.stack.control
  if (control == null) {
    throw new BlockedError('this stack has no control routes to restart it')
  }
  try {
    await control.restartApi()
  } catch (error) {
    if (/ with 404\b/.test(String(error))) {
      throw new BlockedError(
        "the stack's fault server has no restart-api route, which this scenario restarts the API (SIGTERM, then a fresh start) with"
      )
    }
    throw error
  }
}

/** E4 steps 1–2: a viewer is closed 1001 on SIGTERM, and the board outlives it. */
async function restartKeepsBoard(ctx: HarnessContext): Promise<void> {
  const boards = await seedBoards(ctx)
  const gameId = boards.games['-10m']
  const first = view(ctx, gameId)
  await first.open
  await publish(ctx.stack.origin, gameId, boards.runner, { homeScore: 7 })
  await until('homeScore 7', () => latest(first)?.homeScore === 7)
  await restartApi(ctx)
  await until('the viewer to be closed', () => first.close)
  expect(first.close, 'the viewer is closed with 1001 on SIGTERM').equals(1001)
  await until(
    'the API',
    async () =>
      (await getJson(ctx, '/health').catch(() => ({ status: 0 }))).status ===
      200,
    60_000
  )
  const second = view(ctx, gameId)
  try {
    await until('a state', () => latest(second))
    expect(
      latest(second)?.homeScore,
      'a new viewer receives homeScore 7'
    ).equals(7)
  } finally {
    second.socket.close()
  }
}

/** E5: the run list is the open games, soonest first. */
async function runList(ctx: HarnessContext): Promise<void> {
  const { games, runner } = await seedBoards(ctx)
  const answer = await getJson(
    ctx,
    '/events?scope=run&lookbackHours=2&limit=20',
    runner
  )
  expect(answer.status).equals(200)
  const ids = (answer.body as Array<{ gameId: string }>).map(e => e.gameId)
  const wanted = (
    ['-10m', '+1h', '+2h', '+3h', '+4h', '+5h', '+6h'] as const
  ).map(name => games[name])
  expect(
    ids,
    'GET /events is the -10m game through +6h, soonest first'
  ).deep.equals(wanted)
  expect(ids, 'the -4h game and the cancelled game are absent')
    .not.include(games['-4h'])
    .and.not.include(games.cancelled)
}

export default defineHarness({
  id: 'playback/scoreboard-server/viewers',
  title:
    'Every viewer gets a board’s states in order, refusals are named, and the board outlives a restart',
  kind: 'e2e',
  covers: [
    'src/server/scoreboard/**',
    'src/server/routes/scoreboard.ts',
    'src/common/scoreboard.ts'
  ],
  stack: 'isolated',
  fixtures: ['scoreboard-games'],
  exclusive: false,
  surfaces: {
    // Sockets and API reads only: the browser on a droplet is never opened.
    'web-chromium': { devices: [], browser: { role: 'browser', needs: [] } }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 3,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'twelve-viewers-in-order': twelveViewersInOrder,
    'viewers-across-workers': async () => {
      throw new BlockedError(
        "the 12 viewers spread across the API's workers: the stack is reached through Caddy and the fault server, and nothing it serves says which worker holds a socket (the old check read the server's own connection table)"
      )
    },
    refusals,
    'restart-keeps-board': restartKeepsBoard,
    'board-key-expiry': async () => {
      throw new BlockedError(
        "PTTL of the game's board key is at most 2 h: no control route reads the stack's Valkey"
      )
    },
    'store-outage': async () => {
      throw new BlockedError(
        "the board through a store outage (GET /scoreboard 503, game detail with scoreboard null, health and lists 200, a viewer refused 1011, no worker re-forked, homeScore 8 to a new viewer within 10 s of the store's return, and the script reloaded after NOSCRIPT): no control route stops, starts or reads the stack's Valkey, or reads the API's log"
      )
    },
    'run-list': runList
  }
})
