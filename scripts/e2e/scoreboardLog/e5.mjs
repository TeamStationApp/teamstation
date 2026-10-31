// E5: frame-exact wall-clock timelines from the frames' own SEI, live and
// recorded, across a publisher's outage; and segment arrival for a publisher
// that carries none. Real server, real RTMP, real FFmpeg, real Chrome.
//
//   TS_TOKEN=<session of someone who films the game> \
//   MAESTRO_D=<daemon> MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> \
//     node scripts/e2e/scoreboardLog/e5.mjs --game <G> \
//     [--api http://127.0.0.1:9140/api/v1] [--app http://127.0.0.1:8090] \
//     [--duration 180] [--outage 60:20] [--keep]
//
// Needs the API and the live ingest on this machine (`npm start` and
// `npm run start.ingest`, with a `sessionSecret`, which stream keys are
// sealed with), and the web app built
// against it (`npm run start.web`). Its database (`databaseUrl` in
// serverConfig.json) must be on this machine too.
//
// 1. A camera for the game (`POST /games/<G>/live-streams`), and the fake
//    broadcaster publishing a stamped stream into it for `--duration` seconds
//    with an `--outage`.
// 2. During the stream, the live wall timeline before and after the outage:
//    `sei`, frame-exact, a point every half second, and one jump the length
//    of the outage.
// 3. The camera is ended; once the recording is packed up, its timeline: the
//    same, rescanned from the recording.
// 4. Then an unstamped stream of a minute with an outage of its own: `arrival`
//    points, one a segment, and the outage between them; after the end the
//    same points, and a recording as long as the live segments were.
// 5. Chrome, through maestro-d (`e5Browser.e2e.ts`), plays each recording in
//    the web app and reads the marker burned into the frame on screen at ten
//    positions of the stamped one (after the outage too) and four of the
//    unstamped one. Stamped: the marker equals `wallAt` of the frame's time
//    within one frame. Unstamped: the marker is behind `wallAt` by no more
//    than the publish latency, and by as much after the outage as before it.
// 6. Both videos and both cameras are deleted, the media with them, unless
//    `--keep`; directly from this machine's database and disk when the API
//    cannot, as against the stand-in Space.
//
// It prints each `curl` as it runs it, with the token as `$TOKEN`, and exits
// 1 when a check fails.
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import pg from 'pg'

const require = createRequire(import.meta.url)
require('sucrase/register')
const { serverConfig } = require('../../../src/server/serverConfig.ts')
const { wallAt } = require('../../../src/common/wallTimeline.ts')
const { unwrapMarker } = require('./readMarker.ts')
const {
  parseMediaPlaylist
} = require('../../../src/server/media/wallClockScan.ts')

const here = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(here, '../../..')
const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:9140/api/v1' },
    app: { type: 'string', default: 'http://127.0.0.1:8090' },
    game: { type: 'string' },
    duration: { type: 'string', default: '180' },
    outage: { type: 'string', default: '60:20' },
    keep: { type: 'boolean', default: false }
  }
})
const gameId = values.game
const token = process.env.TS_TOKEN
if (gameId == null) throw new Error('Give --game <gameId>')
if (token == null || token === '') throw new Error('Set TS_TOKEN')
for (const url of [values.api, values.app, serverConfig.databaseUrl])
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
    throw new Error(`${new URL(url).host} is not on this machine`)
const duration = Number(values.duration)
const [outageAt, outageSec] = values.outage.split(':').map(Number)
const mediaRoot = serverConfig.mediaDir
const FRAME_MS = 1000 / 30

const started = Date.now()
const print = (what, detail) => {
  const at = ((Date.now() - started) / 1000).toFixed(2).padStart(7)
  console.log(
    `+${at}s  ${what}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`
  )
}
const pause = async ms =>
  await new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
const failures = []
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
  if (!ok) failures.push(what)
}
const iso = ms => new Date(ms).toISOString()

/**
 * Runs curl as printed, with the token on its standard input and never on the
 * line, and answers the parsed body. A timeline is printed as a summary and
 * its turns: hundreds of points say nothing more than that.
 */
function curl(url, { method = 'GET' } = {}) {
  const line = `curl -s${method === 'GET' ? '' : ` -X ${method}`} -H "Authorization: Bearer $TOKEN"`
  console.log(`$ ${line} "${url}"`)
  const args = ['-s', '-X', method, '-H', '@-', url, '-w', '\n%{http_code}']
  const ran = spawnSync('curl', args, {
    encoding: 'utf8',
    input: `Authorization: Bearer ${token}\n`,
    maxBuffer: 1 << 26
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
  if (Array.isArray(json?.anchors)) {
    const { anchors, ...rest } = json
    console.log(
      `  ${status} ${JSON.stringify({ ...rest, points: anchors.length })}`
    )
    if (anchors.length > 0) {
      const [m0, w0] = anchors[0]
      const [m1, w1] = anchors.at(-1)
      console.log(
        `    first [${m0}, ${w0}] ${iso(w0)}   last [${m1}, ${w1}] ${iso(w1)}`
      )
    }
    for (const turn of turns(anchors))
      console.log(
        `    turn  [${turn.from.join(', ')}] -> [${turn.to.join(', ')}]  wall moves ${turn.jumpMs} ms more than media`
      )
  } else {
    console.log(
      `  ${status} ${body.length > 400 ? `${body.slice(0, 400)}…` : body}`
    )
  }
  return { status, json }
}

/** Where a timeline leaves 1×: each pair of points the wall moves 20 ms past. */
function turns(anchors, beyondMs = 20) {
  const out = []
  for (let i = 1; i < anchors.length; i++) {
    const [m0, w0] = anchors[i - 1]
    const [m1, w1] = anchors[i]
    const jumpMs = w1 - w0 - (m1 - m0)
    if (Math.abs(jumpMs) > beyondMs)
      out.push({ from: anchors[i - 1], to: anchors[i], jumpMs })
  }
  return out
}

/** One request as the app makes it, with the token. */
async function ask(path, init = {}) {
  const response = await fetch(`${values.api}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...init.headers
    }
  })
  const text = await response.text()
  return {
    status: response.status,
    json: text === '' ? null : JSON.parse(text)
  }
}

/** Room left where the recordings go, in GB. */
function freeGb() {
  const stats = statfsSync(mediaRoot)
  return (stats.bavail * stats.bsize) / 1e9
}

/** A camera for the game, with its key on this machine's ingest. */
async function newCamera(label) {
  const made = await ask(`/games/${gameId}/live-streams`, {
    method: 'POST',
    body: JSON.stringify({ label })
  })
  if (made.status !== 201)
    throw new Error(`no camera: ${made.status} ${JSON.stringify(made.json)}`)
  const key = new URL(made.json.url.replace(/^rtmp:/, 'http:')).pathname
    .split('/')
    .pop()
  const { live } = serverConfig
  print(`camera "${label}"`, {
    streamId: made.json.id,
    videoId: made.json.videoId,
    keyPrefix: made.json.keyPrefix
  })
  return {
    streamId: made.json.id,
    videoId: made.json.videoId,
    url: `rtmp://127.0.0.1:${live.port}/${live.app}/${key}`
  }
}

/**
 * The fake broadcaster, publishing into `url`. Answers its T0 once it has
 * planned it, and a promise of its end; `during` runs at the times it names,
 * T0-relative, while it publishes.
 */
async function broadcast(url, args, during = []) {
  const line = `node scripts/e2e/scoreboardLog/fakeBroadcaster.mjs --url rtmp://127.0.0.1:${serverConfig.live.port}/${serverConfig.live.app}/$KEY ${args.join(' ')}`
  console.log(`$ ${line}`)
  const child = spawn(
    process.execPath,
    [join(here, 'fakeBroadcaster.mjs'), '--url', url, ...args],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'inherit']
    }
  )
  let t0
  let planned
  const t0Known = new Promise(resolve => {
    planned = resolve
  })
  let buffer = ''
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8')
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const event = JSON.parse(buffer.slice(0, at))
      buffer = buffer.slice(at + 1)
      const { at: when, ...rest } = event
      console.log(`  ${iso(when)}  ${JSON.stringify(rest)}`)
      if (event.event === 'planned') {
        t0 = event.t0
        planned(t0)
      }
    }
  })
  const ended = new Promise(resolve => child.on('exit', resolve))
  await t0Known
  const results = []
  for (const { atSec, run } of during) {
    await pause(t0 + atSec * 1000 - Date.now())
    results.push(await run())
  }
  const code = await ended
  check(code === 0, `the broadcaster published every part (exit ${code})`)
  return { t0, results }
}

/** Ends a camera and waits for its recording to be packed up and rescanned. */
async function finish(camera, pool) {
  const ended = curl(
    `${values.api}/games/${gameId}/live-streams/${camera.streamId}/end`,
    { method: 'POST' }
  )
  check(ended.status === 200, 'the camera is ended')
  for (let tries = 0; tries < 240; tries++) {
    const row = (
      await pool.query(
        'select status, width, duration_sec from videos where id = $1',
        [camera.videoId]
      )
    ).rows[0]
    if (row?.status === 'ready' && row.width != null) {
      print('recording packed up', row)
      return
    }
    await pause(500)
  }
  throw new Error(`${camera.videoId} was never packed up`)
}

/**
 * A playlist's total `EXTINF`, in seconds: `master.m3u8` is the live one
 * until the recording replaces it, `video.m3u8` the recording's.
 */
function playlistSeconds(videoId, name) {
  const path = join(mediaRoot, 'work', 'videos', videoId, name)
  return parseMediaPlaylist(readFileSync(path, 'utf8')).segments.reduce(
    (sum, segment) => sum + segment.durationSec,
    0
  )
}

const pool = new pg.Pool({ connectionString: serverConfig.databaseUrl })
const cameras = []
const work = mkdtempSync(join(tmpdir(), 'tsE5-'))
try {
  const gb = freeGb()
  print('free space where recordings go', { gb: Number(gb.toFixed(2)) })
  if (gb < 2) throw new Error('under 2 GB free: not encoding')

  const clock = curl(`${values.api}/time`)
  check(
    Math.abs(clock.json.now - Date.now()) < 5000,
    `/time answers the server's clock (${clock.json.now - Date.now()} ms from this machine's)`
  )

  // ---- 1-3: stamped -------------------------------------------------------
  console.log(
    `\n# A stamped stream: ${duration} s, ${outageSec} s outage at ${outageAt} s`
  )
  const stamped = await newCamera('E5 stamped')
  cameras.push(stamped)
  const timelineUrl = videoId => `${values.api}/videos/${videoId}/wall-timeline`
  const {
    t0,
    results: [beforeOutage, afterOutage]
  } = await broadcast(
    stamped.url,
    ['--stamped', '--duration', String(duration), '--outage', values.outage],
    [
      {
        atSec: outageAt * 0.75,
        run: async () => curl(timelineUrl(stamped.videoId))
      },
      {
        atSec: outageAt + outageSec + 30,
        run: async () => curl(timelineUrl(stamped.videoId))
      }
    ]
  )
  print('T0', { t0, iso: iso(t0) })
  for (const [label, timeline] of [
    ['before the outage', beforeOutage],
    ['after the outage', afterOutage]
  ]) {
    check(
      timeline.status === 200 &&
        timeline.json.live === true &&
        timeline.json.source === 'sei' &&
        timeline.json.confidence === 'frame',
      `live, ${label}: live ${timeline.json.live}, source ${timeline.json.source}, confidence ${timeline.json.confidence}`
    )
    check(
      timeline.json.anchors[0][1] === t0,
      `live, ${label}: media 0 is T0 (${timeline.json.anchors[0][1] - t0} ms)`
    )
  }
  check(
    turns(beforeOutage.json.anchors).length === 0,
    'live, before the outage: one straight line, a point every half second'
  )
  const liveTurns = turns(afterOutage.json.anchors)
  check(
    liveTurns.length === 1 &&
      Math.abs(liveTurns[0].jumpMs - outageSec * 1000) <= 2 * FRAME_MS,
    `live, after the outage: one jump of ${liveTurns[0]?.jumpMs} ms at media ${liveTurns[0]?.to[0]} (the outage is ${outageSec * 1000} ms)`
  )
  await finish(stamped, pool)
  const vod = curl(timelineUrl(stamped.videoId))
  check(
    vod.json.live === false &&
      vod.json.source === 'sei' &&
      vod.json.confidence === 'frame',
    `recorded: live ${vod.json.live}, source ${vod.json.source}, confidence ${vod.json.confidence}`
  )
  const vodTurns = turns(vod.json.anchors)
  check(
    vodTurns.length === 1 &&
      Math.abs(vodTurns[0].jumpMs - outageSec * 1000) <= 2 * FRAME_MS,
    `recorded: one jump of ${vodTurns[0]?.jumpMs} ms at media ${vodTurns[0]?.to[0]}`
  )
  const liveBefore = beforeOutage.json.anchors
  check(
    JSON.stringify(vod.json.anchors.slice(0, liveBefore.length)) ===
      JSON.stringify(liveBefore),
    `recorded: the ${liveBefore.length} points before the outage are the live ones`
  )
  const anchorRows = await pool.query(
    `select count(*)::int as n, bool_and(source = 'sei') as sei, bool_and(corrected) as corrected from video_wall_anchors where video_id = $1`,
    [stamped.videoId]
  )
  print('video_wall_anchors', anchorRows.rows[0])

  // ---- 4: unstamped -------------------------------------------------------
  const plainDuration = 60
  const plainOutage = [20, 20]
  console.log(
    `\n# An unstamped stream: ${plainDuration} s, ${plainOutage[1]} s outage at ${plainOutage[0]} s`
  )
  const plain = await newCamera('E5 unstamped')
  cameras.push(plain)
  const {
    t0: plainT0,
    results: [plainLive]
  } = await broadcast(
    plain.url,
    ['--duration', String(plainDuration), '--outage', plainOutage.join(':')],
    [
      {
        atSec: plainDuration + 3,
        run: async () => curl(timelineUrl(plain.videoId))
      }
    ]
  )
  const arrivals = plainLive.json.anchors
  check(
    plainLive.json.live === true &&
      plainLive.json.source === 'arrival' &&
      plainLive.json.confidence === 'approximate',
    `live: source ${plainLive.json.source}, confidence ${plainLive.json.confidence}, ${arrivals.length} points`
  )
  const segmentStarts = arrivals.map(([mediaMs]) => mediaMs)
  check(
    segmentStarts.every(
      (mediaMs, i) => i === 0 || mediaMs > segmentStarts[i - 1]
    ) && arrivals.length >= 8,
    `live: one point a segment, at ${segmentStarts.join(', ')} ms`
  )
  const plainTurns = turns(arrivals, 1500)
  check(
    plainTurns.length === 1 &&
      Math.abs(plainTurns[0].jumpMs - plainOutage[1] * 1000) <= 2000,
    `live: the outage is in the points, a jump of ${plainTurns[0]?.jumpMs} ms at media ${plainTurns[0]?.to[0]}`
  )
  print(
    'each point late by (arrival less the marker it starts with)',
    arrivals.map(([mediaMs, wallMs]) => {
      // Before the outage media time is the picture's own; after it the
      // picture is `outage` further on.
      const pictureMs =
        mediaMs < plainOutage[0] * 1000
          ? mediaMs
          : mediaMs + plainOutage[1] * 1000
      return wallMs - (plainT0 + pictureMs)
    })
  )
  const liveSec = playlistSeconds(plain.videoId, 'master.m3u8')
  await finish(plain, pool)
  const plainVod = curl(timelineUrl(plain.videoId))
  check(
    plainVod.json.live === false && plainVod.json.source === 'arrival',
    `recorded: live ${plainVod.json.live}, source ${plainVod.json.source}, ${plainVod.json.anchors.length} points`
  )
  check(
    JSON.stringify(plainVod.json.anchors.slice(0, arrivals.length)) ===
      JSON.stringify(arrivals),
    'recorded: the live points carried over unchanged'
  )
  // The points sit at the live segments' starts, and the recording is those
  // segments end to end. Each live writer's last segment, the one before a
  // reconnect and the one at the end, is listed about a frame short, and the
  // remux counts it whole: so the recording may run a frame longer per
  // writer, and the points after a reconnect sit that much early in it.
  const writers = 2
  const recordingSec = playlistSeconds(plain.videoId, 'video.m3u8')
  check(
    Math.abs(recordingSec - liveSec) * 1000 <= writers * (FRAME_MS + 10),
    `the recording is the live segments end to end, to a frame a writer: ${recordingSec.toFixed(3)} s and ${liveSec.toFixed(3)} s`
  )

  // ---- 5: Chrome --------------------------------------------------------
  console.log('\n# The marker on screen, in Chrome')
  const playedSec = duration - outageSec
  // Four before the outage, one just after it, and five more on to the end.
  const step = (playedSec - 3 - (outageAt + 1)) / 5
  const positions = [
    2.3,
    outageAt * 0.3,
    outageAt * 0.6,
    outageAt - 1.7,
    outageAt + 0.3,
    ...[1, 2, 3, 4, 5].map(n => outageAt + 1 + n * step)
  ].map(at => Math.round(at * 10) / 10)
  const plan = {
    app: values.app,
    api: values.api,
    videos: [
      { gameId, videoId: stamped.videoId, positions },
      { gameId, videoId: plain.videoId, positions: [5, 15, 25, 35] }
    ]
  }
  const planPath = join(work, 'plan.json')
  const resultsPath = join(work, 'results.json')
  writeFileSync(planPath, JSON.stringify(plan))
  const mocha =
    'npx mocha -r sucrase/register --extension ts --timeout 900000 scripts/e2e/scoreboardLog/e5Browser.e2e.ts'
  console.log(`$ E5_PLAN=plan.json E5_RESULTS=results.json ${mocha}`)
  const browser = spawnSync('sh', ['-c', mocha], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, E5_PLAN: planPath, E5_RESULTS: resultsPath }
  })
  console.log(browser.stdout.trimEnd().replace(/^/gm, '  '))
  if (browser.status !== 0) console.log(browser.stderr)
  check(browser.status === 0, 'Chrome played both recordings')
  const results = existsSync(resultsPath)
    ? JSON.parse(readFileSync(resultsPath, 'utf8'))
    : []
  const [stampedReads, plainReads] = [stamped, plain].map(
    camera => results.find(one => one.videoId === camera.videoId)?.reads ?? []
  )

  console.log(
    '  stamped: position  frame time  marker wall               wallAt(frame time)        marker - wallAt'
  )
  for (const read of stampedReads) {
    const expected = wallAt(vod.json.anchors, read.mediaTime * 1000)
    const marker =
      read.marker == null ? null : unwrapMarker(read.marker, expected)
    const off = marker == null ? null : marker - expected
    console.log(
      `           ${String(read.position).padStart(6)}  ${read.mediaTime.toFixed(3).padStart(9)}  ${marker == null ? 'unread'.padEnd(24) : iso(marker)}  ${iso(expected)}  ${off == null ? '-' : `${off.toFixed(1)} ms`}`
    )
    check(
      off != null && Math.abs(off) <= FRAME_MS,
      `stamped at ${read.position} s: the marker is wallAt(frame time) within one frame`
    )
  }
  check(
    stampedReads.length === positions.length,
    `${stampedReads.length} of ${positions.length} positions read`
  )
  check(
    stampedReads.some(read => read.mediaTime > outageAt),
    'positions after the outage were read'
  )

  console.log(
    '  unstamped: position  frame time  marker wall               wallAt(frame time)        wallAt - marker'
  )
  const lateness = []
  for (const read of plainReads) {
    const expected = wallAt(plainVod.json.anchors, read.mediaTime * 1000)
    const marker =
      read.marker == null ? null : unwrapMarker(read.marker, expected)
    const late = marker == null ? null : expected - marker
    lateness.push({ position: read.position, late })
    console.log(
      `             ${String(read.position).padStart(6)}  ${read.mediaTime.toFixed(3).padStart(9)}  ${marker == null ? 'unread'.padEnd(24) : iso(marker)}  ${iso(expected)}  ${late == null ? '-' : `${late.toFixed(0)} ms`}`
    )
    check(
      late != null && late > -1500 && late < 5000,
      `unstamped at ${read.position} s: late by the publish latency at most (${late} ms)`
    )
  }
  const beforeLate = lateness
    .filter(one => one.position < plainOutage[0])
    .map(one => one.late)
  const afterLate = lateness
    .filter(one => one.position >= plainOutage[0])
    .map(one => one.late)
  check(
    beforeLate.length > 0 &&
      afterLate.length > 0 &&
      Math.abs(Math.max(...afterLate) - Math.min(...beforeLate)) < 2000,
    'unstamped: as late after the outage as before it'
  )
} finally {
  if (!values.keep) {
    console.log('\n# Cleaning up')
    for (const camera of cameras) {
      const gone = curl(`${values.api}/videos/${camera.videoId}`, {
        method: 'DELETE'
      })
      curl(`${values.api}/games/${gameId}/live-streams/${camera.streamId}`, {
        method: 'DELETE'
      })
      const dir = join(mediaRoot, 'work', 'videos', camera.videoId)
      if (gone.status >= 300) {
        // The stand-in Space (`npm run fake-space`) lists and deletes
        // nothing, so the API cannot delete a recording kept there. Then, on
        // this machine only, the rows go from the database and the files
        // from the disk, as the overlay rig does.
        await pool.query('delete from live_streams where id = $1', [
          camera.streamId
        ])
        await pool.query('delete from videos where id = $1', [camera.videoId])
        for (const root of [
          dir,
          join(serverConfig.workDir, 'space', 'videos', camera.videoId)
        ])
          rmSync(root, { recursive: true, force: true })
        console.log(`removed ${camera.videoId} from this machine directly`)
      }
      check(!existsSync(dir), `${camera.videoId}'s media is gone`)
    }
  }
  await pool.end()
  rmSync(work, { recursive: true, force: true })
}

console.log(
  failures.length === 0 ? '\nE5 passed' : `\nE5 FAILED: ${failures.length}`
)
process.exit(failures.length === 0 ? 0 : 1)
