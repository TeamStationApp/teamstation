// E2: every change to a game's board that is not TeamStation scoring is
// logged, and scoring is not. Plays the publisher, the dashboard and the
// scorer against a running server, then reads the game's scoreboard log.
//
//   TS_TOKEN=<session of someone who runs the game> \
//     node scripts/e2e/scoreboardLog/e2.mjs --game <G> \
//     [--api http://127.0.0.1:9140/api/v1]
//
// 1. A publisher socket sends a contested packet, the same packet again a
//    second later, then a pitch speed alone, and waits out the server's
//    five-second speed hold.
// 2. A dashboard socket turns the count override on, sends the same
//    overrides again, then resets the game.
// 3. A scoring session posts one pitch through POST /games/<G>/events.
//
// It then reads the game's rows from the server's own database (the
// `databaseUrl` in serverConfig.json, which must be on this machine) and
// checks they are publisher, publisher, publisher, speedHold, dashboard and
// reset, in that order and nothing else. It prints each step, each board a
// viewer socket heard, and the rows, and exits 1 when the rows are wrong.
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

import pg from 'pg'
import WebSocket from 'ws'

const require = createRequire(import.meta.url)
require('sucrase/register')
const { TeamStationClient } = require('../../../src/common/api.ts')
const { ScoringSession } = require('../../../src/common/scoring/session.ts')
const { NO_OVERRIDES } = require('../../../src/common/scoreboard.ts')
const {
  startingSetup,
  teamsOf
} = require('../../../src/app/scoring/developmentSession.ts')
const { serverConfig } = require('../../../src/server/serverConfig.ts')
const { attachInt8Parser } = require('../../../src/server/db/int8.ts')

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:9140/api/v1' },
    game: { type: 'string' }
  }
})
const api = new URL(values.api)
const gameId = values.game
const token = process.env.TS_TOKEN
if (gameId == null) throw new Error('Give --game <gameId>')
if (token == null || token === '') throw new Error('Set TS_TOKEN')
for (const url of [api, new URL(serverConfig.databaseUrl)])
  if (!['127.0.0.1', 'localhost'].includes(url.hostname))
    throw new Error(`${url.host} is not on this machine`)

const started = Date.now()
const print = (what, detail) => {
  const at = ((Date.now() - started) / 1000).toFixed(2).padStart(6)
  console.log(
    `+${at}s  ${what}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`
  )
}
const pause = async ms => await new Promise(resolve => setTimeout(resolve, ms))

const socketBase = `${api.protocol === 'https:' ? 'wss' : 'ws'}://${api.host}${api.pathname}/scoreboard/${encodeURIComponent(gameId)}`

/** Opens one of the game's scoreboard sockets and waits for it to open. */
async function open(kind, onMessage = () => undefined) {
  const socket = new WebSocket(`${socketBase}/${kind}`, {
    headers: kind === 'socket' ? {} : { authorization: `Bearer ${token}` }
  })
  socket.on('message', data => {
    onMessage(JSON.parse(data.toString('utf8')))
  })
  socket.on('close', (code, reason) => {
    if (code !== 1000 && code !== 1005)
      print(`${kind} socket closed`, { code, reason: String(reason) })
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return socket
}

/** Scores one pitch into the game the way the app does, through the API. */
async function scorePitch() {
  const client = new TeamStationClient({ baseUrl: values.api, token })
  const game = await client.game(gameId)
  const [away, home] = await Promise.all([
    client.roster(game.awayTeamId),
    client.roster(game.homeTeamId)
  ])
  const session = await ScoringSession.open(
    {
      load: async id => await client.gameEvents(id),
      save: async (id, change) => await client.saveGameEvents(id, change)
    },
    gameId,
    {
      gamePk: gameId,
      teams: teamsOf(game),
      setup: startingSetup(game, away, home)
    },
    { setTimer: () => null, clearTimer: () => undefined }
  )
  const problems = session.apply({ type: 'pitch', call: 'B' }).problems
  if (problems.length > 0) throw new Error(problems[0].message)
  await session.flush()
}

async function main() {
  const boards = []
  const viewer = await open('socket', board => {
    boards.push(board)
    print('viewer heard', {
      balls: board.balls,
      strikes: board.strikes,
      outs: board.outs,
      pitchSpeed: board.pitchSpeed
    })
  })
  await pause(500)

  // 1. The publisher.
  const publisher = await open('publish', message => {
    print('publisher was told', message)
  })
  const contested = { balls: 2, strikes: 1 }
  print('publisher sends a contested packet', contested)
  publisher.send(JSON.stringify(contested))
  await pause(1100)
  print('publisher sends it again', contested)
  publisher.send(JSON.stringify(contested))
  await pause(1100)
  print('publisher sends a pitch speed', { pitchSpeed: 61 })
  publisher.send(JSON.stringify({ pitchSpeed: 61 }))
  print('waiting 6 s for the speed hold')
  await pause(6000)
  publisher.close(1000)

  // 2. The dashboard.
  const dashboard = await open('dashboard')
  const overrides = {
    ...NO_OVERRIDES,
    overrideCountEnabled: true,
    overrideCount: { balls: 3, strikes: 2, outs: 1 }
  }
  print('dashboard turns the count override on', overrides.overrideCount)
  dashboard.send(JSON.stringify({ type: 'overrides', data: overrides }))
  await pause(1100)
  print('dashboard sends the same overrides again')
  dashboard.send(JSON.stringify({ type: 'overrides', data: overrides }))
  await pause(1100)
  print('dashboard resets the game')
  dashboard.send(JSON.stringify({ type: 'reset' }))
  await pause(1100)
  dashboard.close(1000)

  // 3. A scoring post.
  print('scorer posts a ball')
  await scorePitch()
  await pause(1500)
  viewer.close(1000)

  attachInt8Parser()
  const pool = new pg.Pool({ connectionString: serverConfig.databaseUrl })
  try {
    const { rows } = await pool.query(
      `select version, at, cause, actor_id, publisher, overrides
        from scoreboard_log where game_id = $1 order by version`,
      [gameId]
    )
    print(`${rows.length} rows in scoreboard_log`)
    for (const row of rows)
      console.log(
        `  ${row.version}  ${row.at.toISOString()}  ${row.cause.padEnd(9)}  ${row.actor_id ?? 'null'}  ${JSON.stringify(row.publisher)}  count override ${row.overrides.overrideCountEnabled ? 'on' : 'off'}`
      )
    const causes = rows.map(row => row.cause)
    const expected = [
      'publisher',
      'publisher',
      'publisher',
      'speedHold',
      'dashboard',
      'reset'
    ]
    const receivedAt = rows.slice(0, 2).map(row => row.publisher?.receivedAt)
    const ok =
      JSON.stringify(causes) === JSON.stringify(expected) &&
      receivedAt[1] > receivedAt[0] &&
      rows[2].publisher.receivedAt === receivedAt[1] &&
      rows[3].actor_id === null &&
      rows[5].publisher === null &&
      boards.at(-1)?.balls === 1
    console.log(
      ok
        ? 'PASS: publisher, publisher (the repeat moved receivedAt), publisher (speed), speedHold, dashboard, reset; no row for the unchanged overrides or the scoring post'
        : `FAIL: causes ${JSON.stringify(causes)}`
    )
    process.exitCode = ok ? 0 : 1
  } finally {
    await pool.end()
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
