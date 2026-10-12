// E4: an upload carries the server-clock offset its app measured from the
// open to the video, and the video's wall timeline falls back to that start.
// Plays Director's upload client against a running server.
//
//   TS_TOKEN=<session of someone who films the game> \
//     node scripts/e2e/scoreboardLog/e4.mjs --game <G> --offset 1234 \
//     [--api http://127.0.0.1:9140/api/v1]
//
// The server needs a Space to finish an upload; `npm run fake-space` is one,
// with serverConfig.json's `space` pointed at it.
//
// 1. Reads the server's clock (`GET /time`).
// 2. Makes a two-second video-only H.264 file with the local FFmpeg, with no
//    B-frames and no sound, so it holds no pre-roll, and checks with ffprobe
//    that its first packet decodes at zero.
// 3. Opens an upload of it with `startAt` (a minute ago) and
//    `serverClockOffsetMs`, sends its parts, finishes it and waits for it to
//    be taken in.
// 4. Reads the video's row from the server's own database (the `databaseUrl`
//    in serverConfig.json, which must be on this machine) and checks that
//    `start_at` is `startAt` plus the offset and `start_at_clock_offset_ms`
//    is the offset.
// 5. `curl`s the video's wall timeline and checks it is one anchor at media
//    time zero on that start, `source: start`, `confidence: clock`.
//
// It prints each `curl` as it runs it, with the token as `$TOKEN`, answers
// the video id on its last line, and exits 1 when a check fails. The video
// stays; delete it when done with it.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import pg from 'pg'

const require = createRequire(import.meta.url)
require('sucrase/register')
const { serverConfig } = require('../../../src/server/serverConfig.ts')

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:9140/api/v1' },
    game: { type: 'string' },
    offset: { type: 'string', default: '1234' }
  }
})
const api = new URL(values.api)
const gameId = values.game
const offset = Number(values.offset)
const token = process.env.TS_TOKEN
if (gameId == null) throw new Error('Give --game <gameId>')
if (!Number.isInteger(offset)) throw new Error('--offset is whole ms')
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
  console.log(`  ${status} ${body}`)
  let json
  try {
    json = JSON.parse(body)
  } catch {
    json = body
  }
  return { status, json }
}

/** One request as the app makes it, with the token. */
async function ask(path, init = {}) {
  const response = await fetch(`${values.api}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body instanceof Uint8Array
        ? { 'content-type': 'application/octet-stream' }
        : { 'content-type': 'application/json' }),
      ...init.headers
    }
  })
  const text = await response.text()
  return {
    status: response.status,
    json: text === '' ? null : JSON.parse(text)
  }
}

const ffmpeg = serverConfig.ffmpegPath
const work = mkdtempSync(join(tmpdir(), 'tsE4-'))
const pool = new pg.Pool({ connectionString: serverConfig.databaseUrl })
let videoId
try {
  print("the server's clock")
  const clock = curl(`${values.api}/time`, { auth: false })
  check(
    clock.status === 200 && Math.abs(clock.json.now - Date.now()) < 5000,
    `/time answers the server's clock (${clock.json.now - Date.now()} ms from this machine's)`
  )

  const file = join(work, 'take.mp4')
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=30:duration=2',
    '-c:v',
    'libx264',
    '-bf',
    '0',
    '-an',
    file
  ])
  const take = readFileSync(file)
  const probed = JSON.parse(
    execFileSync(
      ffmpeg.replace(/ffmpeg$/, 'ffprobe'),
      [
        '-v',
        'error',
        '-read_intervals',
        '%+#4',
        '-show_entries',
        'packet=dts_time:stream=codec_name,codec_type',
        '-of',
        'json',
        file
      ],
      { encoding: 'utf8' }
    )
  )
  print('made a video-only file', {
    bytes: take.length,
    streams: probed.streams.map(one => `${one.codec_type}/${one.codec_name}`),
    firstDts: probed.packets[0]?.dts_time
  })
  check(
    probed.streams.length === 1 && Number(probed.packets[0]?.dts_time) === 0,
    'one video stream, first packet decoding at zero: no pre-roll'
  )

  // A minute ago, on this machine's clock, which stands in for the iPad's.
  const startedAt = new Date(Date.now() - 60_000)
  const opened = await ask('/director/uploads', {
    method: 'POST',
    body: JSON.stringify({
      gameId,
      title: 'E4 upload clock offset',
      kind: 'program',
      filename: 'take.mp4',
      sizeBytes: take.length,
      startAt: startedAt.toISOString(),
      serverClockOffsetMs: offset
    })
  })
  print('POST /director/uploads', {
    status: opened.status,
    startAt: startedAt.toISOString(),
    serverClockOffsetMs: offset,
    ...opened.json
  })
  if (opened.status !== 201) throw new Error('the upload was not opened')
  const { uploadId, partSize, parts } = opened.json
  for (let index = 0; index < parts; index++) {
    const part = take.subarray(index * partSize, (index + 1) * partSize)
    const sent = await ask(`/director/uploads/${uploadId}/parts/${index}`, {
      method: 'PUT',
      body: new Uint8Array(part)
    })
    print(`PUT part ${index}`, { status: sent.status, ...sent.json })
  }
  const finished = await ask(`/director/uploads/${uploadId}/finish`, {
    method: 'POST'
  })
  print('POST finish', { status: finished.status, ...finished.json })
  let state
  for (let tries = 0; tries < 120; tries++) {
    state = (await ask(`/director/uploads/${uploadId}`)).json
    if (state.state === 'ready' || state.state === 'failed') break
    await pause(500)
  }
  print('taken in', {
    state: state.state,
    videoId: state.videoId,
    message: state.message
  })
  if (state.state !== 'ready') throw new Error('the upload was not taken in')
  videoId = state.videoId

  const upload = await pool.query(
    `select server_clock_offset_ms from director_uploads where id = $1`,
    [uploadId]
  )
  const row = (
    await pool.query(
      `select start_at, start_at_clock_offset_ms, start_at_source, sync_offset_sec
        from videos where id = $1`,
      [videoId]
    )
  ).rows[0]
  print('director_uploads row', upload.rows[0])
  print('videos row', {
    start_at: row.start_at.toISOString(),
    start_at_clock_offset_ms: row.start_at_clock_offset_ms,
    start_at_source: row.start_at_source
  })
  check(
    upload.rows[0].server_clock_offset_ms === offset,
    `the upload keeps serverClockOffsetMs ${offset}`
  )
  check(
    row.start_at.getTime() === startedAt.getTime() + offset,
    `start_at ${row.start_at.toISOString()} is startAt ${startedAt.toISOString()} + ${(offset / 1000).toFixed(3)} s`
  )
  check(
    row.start_at_clock_offset_ms === offset,
    `start_at_clock_offset_ms is ${offset}`
  )

  const timeline = curl(`${values.api}/videos/${videoId}/wall-timeline`)
  const wall = row.start_at.getTime() - row.sync_offset_sec * 1000
  check(
    timeline.status === 200 &&
      JSON.stringify(timeline.json.anchors) === JSON.stringify([[0, wall]]),
    `one anchor, [0, ${wall}] (${new Date(wall).toISOString()})`
  )
  check(
    timeline.json.source === 'start' && timeline.json.confidence === 'clock',
    `source ${timeline.json.source}, confidence ${timeline.json.confidence}`
  )
  const after = curl(`${values.api}/videos/${videoId}/wall-timeline?afterMs=0`)
  check(
    after.status === 200 && after.json.anchors.length === 0,
    'afterMs=0 adds nothing to the start'
  )
} finally {
  await pool.end()
  rmSync(work, { recursive: true, force: true })
}

console.log(
  failures.length === 0 ? 'E4 passed' : `E4 FAILED: ${failures.length}`
)
console.log(`video ${videoId}`)
process.exit(failures.length === 0 ? 0 : 1)
