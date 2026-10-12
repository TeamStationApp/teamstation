// E3: a game's board at any moment can be rebuilt, and a viewer is told when
// it changes. Reads a game's board timeline from a running server, then
// watches it change while a scorer and a dashboard write through a different
// worker of the cluster.
//
//   TS_TOKEN=<session of someone who runs the game> \
//     node scripts/e2e/scoreboardLog/e3.mjs --game <G> \
//     [--api http://127.0.0.1:9140/api/v1]
//
// 1. `curl`s the timeline and prints its steps, each named for what made it:
//    a scoring action, a play's end, or a scoreboard log row and its cause.
// 2. Opens a `timeline=1` socket and a plain viewer socket on one worker, and
//    a scorer and a dashboard on the other (each socket's worker is read from
//    the operating system's table of connections, each HTTP connection's from
//    `/health`). The scorer posts a pitch and then undoes it; the dashboard
//    turns the inning override on and off. After each write it waits for the
//    notice, `curl`s the timeline again and checks it holds the write.
// 3. Checks that the undone pitch has left no step, that the last step is
//    `GET /scoreboard/<G>`, that the plain socket was sent bare boards and no
//    notice, and that the timeline without a token is 401.
//
// It prints each `curl` as it runs it, with the token as `$TOKEN`, and exits
// 1 when a check fails.
import { execFileSync, spawnSync } from 'node:child_process'
import http from 'node:http'
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
const failures = []
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
  if (!ok) failures.push(what)
}

const timelineUrl = query =>
  `${values.api}/games/${encodeURIComponent(gameId)}/scoreboard-timeline${query}`

/**
 * Runs curl as printed, with the token in the environment and never on the
 * line, and answers the status and the parsed body.
 */
function curl(url, { auth = true } = {}) {
  const header = auth ? '-H "Authorization: Bearer $TOKEN" ' : ''
  const line = `curl -s ${header}"${url}"`
  console.log(`$ ${line}`)
  const ran = spawnSync('sh', ['-c', `${line} -w '\\n%{http_code}'`], {
    encoding: 'utf8',
    env: { ...process.env, TOKEN: token }
  })
  const text = ran.stdout.trimEnd()
  const cut = text.lastIndexOf('\n')
  const status = Number(text.slice(cut + 1))
  const body = text.slice(0, cut)
  let json
  try {
    json = JSON.parse(body)
  } catch {
    json = body
  }
  return { status, json }
}

/** What made each moment: the log's rows and the scorer's action times. */
async function sourcesOf(pool) {
  const sources = new Map()
  const plays = await pool.query(
    `select "atBatIndex", "endTime", gumbo->'teamStation'->'actionTimes' as times
      from events where "gameId" = $1`,
    [gameId]
  )
  for (const play of plays.rows) {
    if (play.endTime != null)
      sources.set(play.endTime.getTime(), `play ${play.atBatIndex} end`)
    for (const time of play.times ?? [])
      sources.set(Date.parse(time), `scoring (play ${play.atBatIndex})`)
  }
  const game = await pool.query(
    `select "currentPlay"->'teamStation'->'actionTimes' as times from games where id = $1`,
    [gameId]
  )
  for (const time of game.rows[0]?.times ?? [])
    sources.set(Date.parse(time), 'scoring (at-bat in progress)')
  const rows = await pool.query(
    'select at, cause from scoreboard_log where game_id = $1',
    [gameId]
  )
  for (const row of rows.rows)
    sources.set(row.at.getTime(), `log: ${row.cause}`)
  return sources
}

const short = state =>
  `${state.awayTeam} ${state.awayScore} – ${state.homeTeam} ${state.homeScore}, ` +
  `${state.half} ${state.inning}, ${state.balls}-${state.strikes}, ${state.outs} out, ` +
  `bases ${[state.base1, state.base2, state.base3].map(on => (on ? 'x' : '-')).join('')}` +
  `${state.pitchSpeed > 0 ? `, ${state.pitchSpeed} mph` : ''}`

async function printSteps(pool, steps) {
  const sources = await sourcesOf(pool)
  for (const step of steps)
    console.log(
      `  ${new Date(step.at).toISOString()}  ${(sources.get(step.at) ?? '?').padEnd(30)}  ${short(step.state)}`
    )
}

/**
 * One connection to the API, kept alive, so every request on it reaches the
 * same worker; `/health` says which.
 */
function worker() {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  const request = async (method, path, body) =>
    await new Promise((resolve, reject) => {
      const url = new URL(`${values.api}${path}`)
      const req = http.request(
        url,
        {
          method,
          agent,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body == null ? {} : { 'content-type': 'application/json' })
          }
        },
        res => {
          const chunks = []
          res.on('data', chunk => chunks.push(chunk))
          res.on('end', () => {
            resolve({
              status: res.statusCode,
              text: Buffer.concat(chunks).toString('utf8'),
              headers: res.headers
            })
          })
        }
      )
      req.on('error', reject)
      req.end(body)
    })
  return {
    agent,
    pid: async () => JSON.parse((await request('GET', '/health')).text).pid,
    // What TeamStationClient calls, over this one connection.
    fetch: async (url, init = {}) => {
      const path = new URL(url).pathname.replace(api.pathname, '')
      const answer = await request(init.method ?? 'GET', path, init.body)
      return new Response(answer.text, {
        status: answer.status,
        headers: { 'content-type': answer.headers['content-type'] ?? '' }
      })
    },
    close: () => agent.destroy()
  }
}

/** The server process holding the other end of one of our connections. */
function serverPidOf(localPort) {
  const listed = execFileSync(
    '/usr/sbin/lsof',
    ['-nP', `-iTCP@127.0.0.1:${localPort}`, '-sTCP:ESTABLISHED', '-Fpn'],
    { encoding: 'utf8' }
  )
  let pid
  for (const line of listed.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    if (line === `n127.0.0.1:${api.port}->127.0.0.1:${localPort}`) return pid
  }
  return undefined
}

const socketBase = `ws://${api.host}${api.pathname}/scoreboard/${encodeURIComponent(gameId)}`

/** Opens a socket over a worker's connection and says which worker took it. */
async function open(kind, over, onMessage) {
  const socket = new WebSocket(`${socketBase}/${kind}`, {
    agent: over.agent,
    headers: kind.startsWith('socket')
      ? {}
      : { authorization: `Bearer ${token}` }
  })
  socket.on('message', data => {
    onMessage?.(data.toString('utf8'))
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return { socket, pid: serverPidOf(socket._socket.localPort) }
}

async function main() {
  attachInt8Parser()
  const pool = new pg.Pool({ connectionString: serverConfig.databaseUrl })
  try {
    // 1. The timeline as it stands.
    print('the timeline as it stands')
    const first = curl(timelineUrl(''))
    console.log(
      `  ${first.status}, version ${first.json.version}, ${first.json.steps.length} steps`
    )
    await printSteps(pool, first.json.steps)
    const ats = first.json.steps.map(step => step.at)
    check(
      ats.every((at, i) => i === 0 || at > ats[i - 1]),
      'the steps are in time order'
    )
    const sources = await sourcesOf(pool)
    const kinds = first.json.steps.map(step =>
      (sources.get(step.at) ?? '').startsWith('log') ? 'log' : 'scoring'
    )
    check(
      kinds.includes('log') && kinds.includes('scoring'),
      'they interleave scoring and log changes'
    )

    // 2. Two workers: listeners on one, writers on the other.
    const one = worker()
    let two = worker()
    const pidOne = await one.pid()
    let pidTwo = await two.pid()
    for (let tries = 0; pidTwo === pidOne && tries < 8; tries++) {
      two.close()
      two = worker()
      pidTwo = await two.pid()
    }
    check(pidOne !== pidTwo, `two workers: ${pidOne} and ${pidTwo}`)

    const notices = []
    const listener = await open('socket?timeline=1', one, text => {
      notices.push({ at: Date.now(), text })
      print('timeline socket heard', JSON.parse(text))
    })
    const plain = []
    const viewer = await open('socket', worker(), text => {
      plain.push(text)
    })
    print(
      `timeline=1 socket on worker ${listener.pid}, plain socket on worker ${viewer.pid}`
    )
    check(listener.pid === pidOne, 'the timeline socket is on the first worker')
    await pause(500)

    /** Waits for the next notice and says how long it took. */
    async function nextNotice(after, count) {
      const deadline = Date.now() + 5000
      while (notices.length < count && Date.now() < deadline) await pause(10)
      const notice = notices[count - 1]
      const ms = notice == null ? Infinity : notice.at - after
      check(
        notice?.text === '{"type":"changed"}' && ms <= 1000,
        `a change notice within 1 s (${ms} ms)`
      )
    }

    // The scorer, over the second worker.
    const client = new TeamStationClient({
      baseUrl: values.api,
      token,
      fetch: two.fetch
    })
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
    check(
      (await two.pid()) === pidTwo,
      `the scorer posts through worker ${pidTwo}`
    )

    const before = curl(timelineUrl(`?from=${started - 60_000}`)).json.steps

    print('scorer posts a strike')
    const strikeAt = Date.now()
    const problems = session.apply({ type: 'pitch', call: 'S' }).problems
    if (problems.length > 0) throw new Error(problems[0].message)
    await session.flush()
    await nextNotice(strikeAt, 1)
    const struck = curl(timelineUrl(`?from=${strikeAt - 60_000}`))
    await printSteps(pool, struck.json.steps)
    const strikeStep = struck.json.steps.find(step => step.at >= strikeAt)
    check(
      strikeStep != null &&
        strikeStep.state.strikes === before.at(-1).state.strikes + 1,
      'the refetched timeline holds the strike'
    )

    print('scorer undoes it')
    const undoAt = Date.now()
    session.undo()
    await session.flush()
    await nextNotice(undoAt, 2)
    const undone = curl(timelineUrl(`?from=${strikeAt - 60_000}`))
    await printSteps(pool, undone.json.steps)
    check(
      !undone.json.steps.some(step => step.at === strikeStep?.at),
      'the refetched timeline no longer holds the undone strike'
    )
    check(
      JSON.stringify(undone.json.steps.at(-1).state) ===
        JSON.stringify(before.at(-1).state),
      'and ends on the board from before it'
    )

    // The dashboard, over the second worker.
    const dashboard = await open('dashboard', two)
    print(`dashboard socket on worker ${dashboard.pid}`)
    check(dashboard.pid === pidTwo, 'the dashboard is on the second worker')
    const inning = {
      ...NO_OVERRIDES,
      overrideInningEnabled: true,
      overrideInning: { inning: 7, half: 'bottom' }
    }
    print('dashboard turns the inning override on', inning.overrideInning)
    const onAt = Date.now()
    dashboard.socket.send(JSON.stringify({ type: 'overrides', data: inning }))
    await nextNotice(onAt, 3)
    const on = curl(timelineUrl(`?from=${onAt - 1000}`))
    await printSteps(pool, on.json.steps)
    check(
      on.json.steps.at(-1).state.inning === 7 &&
        on.json.steps.at(-1).state.half === 'bottom',
      'the refetched timeline holds the override'
    )
    await pause(1100)
    print('dashboard turns it off')
    const offAt = Date.now()
    dashboard.socket.send(
      JSON.stringify({
        type: 'overrides',
        data: { ...inning, overrideInningEnabled: false }
      })
    )
    await nextNotice(offAt, 4)
    const off = curl(timelineUrl(`?from=${offAt - 1000}`))
    await printSteps(pool, off.json.steps)
    dashboard.socket.close(1000)

    // 3. The end state.
    await pause(500)
    const whole = curl(timelineUrl(''))
    console.log(
      `  ${whole.status}, version ${whole.json.version}, ${whole.json.steps.length} steps`
    )
    await printSteps(pool, whole.json.steps)
    const live = curl(
      `${values.api}/scoreboard/${encodeURIComponent(gameId)}`,
      {
        auth: false
      }
    )
    console.log(`  ${live.status}  ${short(live.json.state)}`)
    check(
      JSON.stringify(whole.json.steps.at(-1).state) ===
        JSON.stringify(live.json.state),
      'the last step is the board GET /scoreboard/<G> draws'
    )

    console.log(`plain socket heard ${plain.length} messages:`)
    for (const text of plain) console.log(`  ${text}`)
    check(
      plain.length === 5 &&
        plain.every(text => {
          const board = JSON.parse(text)
          return board.type === undefined && typeof board.inGame === 'boolean'
        }),
      'the plain socket was sent a bare board on opening and after each of the four writes, and no notice'
    )
    check(
      plain.at(-1) === JSON.stringify(live.json.state),
      'its last board is byte for byte the live board'
    )
    check(
      notices.length === 4,
      `the timeline socket heard ${notices.length} notices, one per write`
    )

    const anonymous = curl(timelineUrl(''), { auth: false })
    console.log(`  ${anonymous.status}  ${JSON.stringify(anonymous.json)}`)
    check(anonymous.status === 401, 'no token is 401')

    listener.socket.close(1000)
    viewer.socket.close(1000)
    one.close()
    two.close()
  } finally {
    await pool.end()
  }
  console.log(
    failures.length === 0 ? 'PASS' : `FAIL: ${failures.length} checks failed`
  )
  process.exitCode = failures.length === 0 ? 0 : 1
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
