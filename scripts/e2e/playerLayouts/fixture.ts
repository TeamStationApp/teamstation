/**
 * The games the player-layouts scenarios watch, made on this machine's server.
 *
 *   node -r sucrase/register scripts/e2e/playerLayouts/fixture.ts \
 *     [--out <fixture.json>] [--quick]
 *   node -r sucrase/register scripts/e2e/playerLayouts/fixture.ts \
 *     --start-live [--angles 2]|--stop-live|--score-live <innings> \
 *     [--out <fixture.json>]
 *
 * Makes an administrator (`npm run seed`) and six games (`npm run
 * scoring-game`), with a password it draws and keeps only in the fixture
 * file, which it writes readable by its owner alone:
 *
 * - **S**, scored: four angles recorded through the fake broadcaster
 *   (`--stamped`), and scored through the app's own `ScoringSession` while
 *   they record, eleven innings with runs, hits and errors on both sides
 *   (`scoringPlan.ts`).
 * - **L**, logs only: two angles, scoreboard-log rows sent over the override
 *   dashboard while they record, and no plays.
 * - **N**, scored before the overlay start date, so it has no board: one
 *   angle, two innings scored while it records.
 * - **N0**, before the overlay start date, with no events: one angle.
 * - **U**, one uploaded angle with no start time (`npm run sample-video`, a
 *   burned-in clock and a tone).
 * - **V**, live: two angles at 1280×720, so the burned-in clock fits, that go
 *   on publishing after the fixture returns, for twenty minutes or until
 *   `--stop-live`. `--start-live` publishes into the same cameras again,
 *   which the server continues as a reconnect.
 *
 * `--angles 4` with `--start-live` after `--stop-live` gives V that many new
 * cameras, up to the four a person may hold; `--live-seconds` how long they
 * publish (twenty minutes).
 * `--score-live 1` scores that many innings into V while it publishes, an
 * action every three seconds, and says when the first and last were saved:
 * for a live box score following a game as it is scored.
 *
 * `--quick` records shorter (S scores three innings), for a smoke run.
 * The API, the database and the ingest must be on this machine; the server
 * reads `serverConfig.json` from the working directory.
 */
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

import pg from 'pg'
import WebSocket from 'ws'

import {
  startingSetup,
  teamsOf
} from '../../../src/app/scoring/developmentSession'
import { TeamStationClient } from '../../../src/common/api'
import { NO_OVERRIDES } from '../../../src/common/scoreboard'
import type { ScoringAction } from '../../../src/common/scoring/actions'
import { ScoringSession } from '../../../src/common/scoring/session'
import { serverConfig } from '../../../src/server/serverConfig'
import { signInTestAccount } from '../../../src/test/passwordFixtures'
import { decide, halfPlays } from './scoringPlan'

const { values } = parseArgs({
  options: {
    out: {
      type: 'string',
      default: '/private/tmp/teamstation-playerLayouts/fixture.json'
    },
    api: {
      type: 'string',
      default: `http://127.0.0.1:${serverConfig.listenPort}/api/v1`
    },
    quick: { type: 'boolean', default: false },
    'start-live': { type: 'boolean', default: false },
    'stop-live': { type: 'boolean', default: false },
    'score-live': { type: 'string' },
    angles: { type: 'string', default: '2' },
    'live-seconds': { type: 'string', default: '1200' }
  }
})
const API = values.api
const OUT = values.out
for (const url of [API, serverConfig.databaseUrl])
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
    throw new Error(`${url} is not on this machine`)

export interface FixtureGame {
  id: string
  videos: string[]
}
export interface Fixture {
  api: string
  admin: { email: string; password: string }
  games: Record<'S' | 'L' | 'N' | 'N0' | 'U' | 'V', FixtureGame>
  /** S's innings, and when its first play was scored. */
  scored: { innings: number; firstPlayAt: number; lastPlayAt: number }
  live: Array<{ pid: number; streamId: string; videoId: string; url: string }>
}

/**
 * A request on a pooled connection the server has just let go of comes back
 * reset before the server has read it; once more on a fresh one is safe.
 */
const fetchOnce = globalThis.fetch
globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  for (let tries = 0; ; tries++) {
    try {
      return await fetchOnce(...args)
    } catch (error) {
      const code = (error as { cause?: { code?: string } }).cause?.code
      if (tries >= 2 || code !== 'ECONNRESET') throw error
    }
  }
}

const started = Date.now()
function say(what: string, detail?: unknown): void {
  const at = ((Date.now() - started) / 1000).toFixed(1).padStart(6)
  console.log(
    `+${at}s  ${what}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`
  )
}
async function pause(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}
function npm(...args: string[]): string {
  return execFileSync('npm', ['run', '--silent', ...args], { encoding: 'utf8' })
}

let token = ''
let client: TeamStationClient

async function ask(
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    }
  })
  const text = await response.text()
  return {
    status: response.status,
    json: text === '' ? null : JSON.parse(text)
  }
}

/** A camera for a game, with its key on this machine's ingest. */
async function camera(
  gameId: string,
  label: string
): Promise<{ streamId: string; videoId: string; url: string }> {
  const made = await ask(`/games/${gameId}/live-streams`, {
    method: 'POST',
    body: JSON.stringify({ label })
  })
  if (made.status !== 201) throw new Error(`no camera: ${made.status}`)
  const body = made.json as { id: string; videoId: string; url: string }
  const key = new URL(body.url.replace(/^rtmp:/, 'http:')).pathname
    .split('/')
    .pop()!
  const { live } = serverConfig
  return {
    streamId: body.id,
    videoId: body.videoId,
    url: `rtmp://127.0.0.1:${live.port}/${live.app}/${key}`
  }
}

/** The fake broadcaster publishing into `url`: its start, and its exit. */
function broadcast(
  url: string,
  args: string[],
  detached = false
): { t0: Promise<number>; done: Promise<number>; pid: number } {
  const child = spawn(
    process.execPath,
    ['scripts/e2e/scoreboardLog/fakeBroadcaster.mjs', '--url', url, ...args],
    {
      // A detached one outlives this process, and a line written into the
      // pipes it leaves behind would end it: its complaints go to a file.
      stdio: detached
        ? [
            'ignore',
            'ignore',
            openSync(join(dirname(OUT), 'broadcaster.log'), 'a')
          ]
        : ['ignore', 'pipe', 'inherit'],
      detached
    }
  )
  let buffer = ''
  const t0 = new Promise<number>(resolve => {
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const event = JSON.parse(buffer.slice(0, at)) as {
          event: string
          t0?: number
        }
        buffer = buffer.slice(at + 1)
        if (event.event === 'planned') resolve(event.t0!)
      }
    })
  })
  const done = new Promise<number>(resolve =>
    child.on('exit', code => {
      resolve(code ?? 1)
    })
  )
  return { t0, done, pid: child.pid! }
}

async function endCamera(gameId: string, streamId: string): Promise<void> {
  const ended = await ask(`/games/${gameId}/live-streams/${streamId}/end`, {
    method: 'POST'
  })
  if (ended.status !== 200) throw new Error(`could not end ${streamId}`)
}

/** Waits for a camera's recording to be packed up. */
async function ready(gameId: string, videoId: string): Promise<void> {
  for (let tries = 0; tries < 720; tries++) {
    const game = await client.game(gameId)
    const video = game.videos.find(one => one.id === videoId)
    if (video?.status === 'ready' && video.width != null) return
    await pause(500)
  }
  throw new Error(`${videoId} was never packed up`)
}

/** The scorer: the app's own scoring session, posting through the API. */
async function scorer(gameId: string): Promise<ScoringSession> {
  const game = await client.game(gameId)
  const [away, home] = await Promise.all([
    client.roster(game.awayTeamId),
    client.roster(game.homeTeamId)
  ])
  return await ScoringSession.open(
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
}

/**
 * Scores `innings` innings of `scoringPlan.ts` into the game, one action
 * every `spacingMs`, saving as it goes: each action's time is when it was
 * applied, inside the recording.
 */
async function scoreGame(
  gameId: string,
  innings: number,
  spacingMs: number
): Promise<{ first: number; last: number }> {
  const session = await scorer(gameId)
  let first = 0
  let last = 0
  const begun = Date.now()
  let applied = 0
  const apply = async (action: ScoringAction): Promise<void> => {
    const problems = session.apply(action).problems
    if (problems.length > 0)
      throw new Error(`${JSON.stringify(action)}: ${problems[0].message}`)
    last = Date.now()
    if (first === 0) first = last
    await session.flush()
    // On a schedule, so the time each save takes does not add up.
    applied += 1
    await pause(begun + applied * spacingMs - Date.now())
  }
  for (let inning = 1; inning <= innings; inning++)
    for (const top of [true, false]) {
      for (const batter of halfPlays(inning, top, innings))
        for (const action of batter) {
          for (let waiting; (waiting = decide(session.state)) != null;)
            await apply(waiting)
          await apply(action)
        }
      say(`scored ${top ? 'top' : 'bottom'} ${inning}`)
    }
  for (let waiting; (waiting = decide(session.state)) != null;)
    await apply(waiting)
  await session.flush()
  return { first, last }
}

/** The override dashboard, as the app's own dashboard screen talks to it. */
async function dashboard(gameId: string): Promise<WebSocket> {
  const socket = new WebSocket(
    `${API.replace(/^http/, 'ws')}/scoreboard/${encodeURIComponent(gameId)}/dashboard`,
    { headers: { authorization: `Bearer ${token}` } }
  )
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return socket
}

/** Records `count` angles of a game for `seconds`; answers their videos. */
async function record(
  gameId: string,
  count: number,
  seconds: number,
  during: (t0: number) => Promise<void> = async () => undefined
): Promise<string[]> {
  const cameras = []
  for (let index = 0; index < count; index++)
    cameras.push(await camera(gameId, `Angle ${index + 1}`))
  const casts = cameras.map(one =>
    // Every game's angles encode at once, so each is given long enough.
    broadcast(one.url, [
      '--stamped',
      '--duration',
      String(seconds),
      '--lead',
      String(60 + seconds)
    ])
  )
  const t0 = Math.max(
    ...(await Promise.all(casts.map(async cast => await cast.t0)))
  )
  await pause(t0 - Date.now() + 2000)
  await during(t0)
  const codes = await Promise.all(casts.map(async cast => await cast.done))
  if (codes.some(code => code !== 0))
    throw new Error(`a broadcast into ${gameId} failed`)
  for (const one of cameras) await endCamera(gameId, one.streamId)
  for (const one of cameras) await ready(gameId, one.videoId)
  say(
    `recorded ${gameId}`,
    cameras.map(one => one.videoId)
  )
  return cameras.map(one => one.videoId)
}

/**
 * V's angles, publishing for `--live-seconds` (twenty minutes) from once they
 * are encoded. Every angle encodes at once, so the lead grows with them: four
 * twenty-minute encodes ran past the broadcaster's own lead and it gave up.
 */
function publishLive(url: string, angles = 2): number {
  const seconds = Number(values['live-seconds'])
  // Measured: four encodes at once take more than twice as long as two.
  const lead = Math.ceil(10 + (seconds / 4) * Math.max(1, angles / 2) ** 2)
  return broadcast(
    url,
    ['--stamped', '--duration', String(seconds), '--lead', String(lead)],
    true
  ).pid
}

async function startLive(): Promise<void> {
  if (!existsSync(OUT)) throw new Error(`no fixture at ${OUT}`)
  const fixture = JSON.parse(readFileSync(OUT, 'utf8')) as Fixture
  const live =
    fixture.live.length > 0
      ? fixture.live.map(one => ({ ...one, pid: publishLive(one.url) }))
      : await freshLive(fixture)
  const games = {
    ...fixture.games,
    V: { ...fixture.games.V, videos: live.map(one => one.videoId) }
  }
  writeFileSync(OUT, JSON.stringify({ ...fixture, games, live }, null, 2), {
    mode: 0o600
  })
  say(
    'publishing the live angles again',
    live.map(one => one.pid)
  )
  process.exit(0)
}

/**
 * V's angles again after `--stop-live` ended them, which the server will not
 * take a publish into: the ended cameras and their recordings are removed,
 * so the game has two angles named as before, and two new ones publish.
 */
async function freshLive(fixture: Fixture): Promise<Fixture['live']> {
  token = await signInTestAccount(API, fixture.admin)
  const V = fixture.games.V.id
  const listed = await ask(`/games/${V}/live-streams`)
  for (const one of (listed.json as { mine: Array<{ id: string }> }).mine) {
    await ask(`/games/${V}/live-streams/${one.id}`, { method: 'DELETE' })
  }
  for (const videoId of fixture.games.V.videos) {
    await ask(`/videos/${videoId}`, { method: 'DELETE' })
  }
  const live = []
  const angles = Number(values.angles)
  for (let index = 0; index < angles; index++) {
    const one = await camera(V, `Angle ${index + 1}`)
    live.push({ ...one, pid: publishLive(one.url, angles) })
  }
  return live
}

async function stopLive(): Promise<void> {
  if (!existsSync(OUT)) throw new Error(`no fixture at ${OUT}`)
  const fixture = JSON.parse(readFileSync(OUT, 'utf8')) as Fixture
  token = await signInTestAccount(API, fixture.admin)
  for (const one of fixture.live) {
    try {
      process.kill(one.pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
    await endCamera(fixture.games.V.id, one.streamId).catch(() => undefined)
  }
  writeFileSync(OUT, JSON.stringify({ ...fixture, live: [] }, null, 2), {
    mode: 0o600
  })
  say('stopped the live angles')
}

/** Scores V while it is live (`--score-live`). */
async function scoreLive(innings: number): Promise<void> {
  if (!existsSync(OUT)) throw new Error(`no fixture at ${OUT}`)
  const fixture = JSON.parse(readFileSync(OUT, 'utf8')) as Fixture
  token = await signInTestAccount(API, fixture.admin)
  client = new TeamStationClient({ baseUrl: API, token })
  const scored = await scoreGame(fixture.games.V.id, innings, 3000)
  say('scored V live', scored)
}

async function main(): Promise<void> {
  if (values['score-live'] != null) {
    await scoreLive(Number(values['score-live']))
    return
  }
  if (values['start-live']) {
    await startLive()
    return
  }
  if (values['stop-live']) {
    await stopLive()
    return
  }
  const stamp = Date.now().toString(36)
  const admin = {
    email: `player.layouts.${stamp}@example.test`,
    password: randomBytes(18).toString('base64url')
  }
  const viewer = {
    email: `player.layouts.viewer.${stamp}@example.test`,
    password: randomBytes(18).toString('base64url')
  }
  npm('seed', '--', admin.email, admin.password)
  const made = npm(
    'scoring-game',
    '--',
    viewer.email,
    viewer.password,
    '--games',
    '6'
  )
  const ids = [...made.matchAll(/^GAME_ID=(.+)$/gm)].map(m => m[1])
  if (ids.length !== 6) throw new Error(`made ${ids.length} games, not 6`)
  const [S, L, N, N0, U, V] = ids
  token = await signInTestAccount(API, admin)
  client = new TeamStationClient({ baseUrl: API, token })

  // N and N0 are before the overlay's start date: no board is drawn on them.
  const pool = new pg.Pool({ connectionString: serverConfig.databaseUrl })
  try {
    await pool.query(
      `update games set start_at = '2026-09-15T17:00:00Z' where id = any($1)`,
      [[N, N0]]
    )
    // U's one angle is an upload with no start time.
    const uVideo = `vid_layouts_${stamp}`
    await pool.query(
      `insert into videos (id, game_id, title, kind, status, storage, duration_sec, width, height)
       values ($1, $2, 'Upload', 'program', 'ready', 'local', 120, 1280, 720)`,
      [uVideo, U]
    )
    npm('sample-video', '--', uVideo, '120')
    say('made U', uVideo)

    const innings = values.quick ? 3 : 11
    const length = values.quick ? 90 : 300
    // Every action of S's innings inside its recording, with room either
    // side: about 30 actions an inning.
    const spacing = Math.floor(((length - 40) * 1000) / (innings * 30))
    let scored = { first: 0, last: 0 }
    const [sVideos, lVideos, nVideos, n0Videos] = await Promise.all([
      record(S, 4, length, async () => {
        scored = await scoreGame(S, innings, spacing)
      }),
      record(L, 2, 60, async t0 => {
        const desk = await dashboard(L)
        const on = {
          ...NO_OVERRIDES,
          overrideCountEnabled: true,
          overrideCount: { balls: 2, strikes: 1, outs: 1 },
          overrideScoreEnabled: true,
          overrideScore: { awayScore: 3, homeScore: 2 }
        }
        await pause(t0 + 10_000 - Date.now())
        desk.send(JSON.stringify({ type: 'overrides', data: on }))
        await pause(t0 + 30_000 - Date.now())
        desk.send(
          JSON.stringify({
            type: 'overrides',
            data: { ...on, overrideScore: { awayScore: 4, homeScore: 2 } }
          })
        )
        desk.close()
      }),
      record(N, 1, 60, async () => {
        await scoreGame(N, 2, 600)
      }),
      record(N0, 1, 60)
    ])

    // V goes on publishing after this returns, for the live scenarios.
    const live = []
    for (let index = 0; index < 2; index++) {
      const one = await camera(V, `Angle ${index + 1}`)
      live.push({
        pid: publishLive(one.url),
        streamId: one.streamId,
        videoId: one.videoId,
        url: one.url
      })
    }

    const fixture: Fixture = {
      api: API,
      admin,
      games: {
        S: { id: S, videos: sVideos },
        L: { id: L, videos: lVideos },
        N: { id: N, videos: nVideos },
        N0: { id: N0, videos: n0Videos },
        U: { id: U, videos: [uVideo] },
        V: { id: V, videos: live.map(one => one.videoId) }
      },
      scored: { innings, firstPlayAt: scored.first, lastPlayAt: scored.last },
      live
    }
    writeFileSync(OUT, JSON.stringify(fixture, null, 2), { mode: 0o600 })
    say(`wrote ${OUT}`, Object.fromEntries(Object.entries(fixture.games)))
  } finally {
    await pool.end()
  }
  // The live broadcasters are detached; this process may go.
  process.exit(0)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
