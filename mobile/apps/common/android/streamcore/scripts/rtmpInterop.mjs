#!/usr/bin/env node
// Scenario E6: the Kotlin stream path against real RTMP servers.
//
//   node mobile/apps/common/android/streamcore/scripts/rtmpInterop.mjs [--log <file>] [--seconds 40]
//                                                                     [--only hls|stall|reconnect]
//
// It makes a 1920x1080 HEVC and AAC clip with ffmpeg, then runs `RtmpInteropTest` (Gradle, in
// tsCameramanAndroid) three times, each publishing the clip for 40 s through StreamSessionController,
// ProgramStreamer and RTMPClient:
//
//   1. hls: to the server's node-media-server splitter, configured and started through
//      `configureIngest` / `startIngest` / `setLive` exactly as the live controller does. The HLS it
//      writes must report hevc 1920x1080 and aac.
//   2. stall: to tsDirector/scripts/rtmpStallServer.js, which stops reading 8 s in and starts again
//      22 s later. The backlog must stay within the send budget, be shed, and start on a keyframe.
//   3. reconnect: to tsDirector/scripts/rtmpSink.js, killed 10 s into the publish and started again
//      at 25 s. The publisher must come back, and in every recording the sink keeps the audio
//      timestamps must never go backwards.
//
// Every command and what it printed goes to the log, each command on a `$` line. Needs ffmpeg,
// ffprobe and node on PATH, and the repository's node_modules.

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const streamcore = resolve(here, '..')
const repo = resolve(streamcore, '../../../../..')
const cameraman = join(repo, 'mobile/apps/tsCameramanAndroid')
const director = join(repo, 'mobile/apps/tsDirector/scripts')
const work = join(streamcore, 'build/rtmpInterop')

const options = { log: join(work, 'kotlin-stream-interop.log'), seconds: 40, only: null }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--log') options.log = resolve(argv[++i])
  else if (argv[i] === '--seconds') options.seconds = Number(argv[++i])
  else if (argv[i] === '--only') options.only = argv[++i]
  else throw new Error(`unknown argument ${argv[i]}`)
}

mkdirSync(work, { recursive: true })
mkdirSync(dirname(options.log), { recursive: true })
writeFileSync(options.log, '')

function log(text) {
  process.stdout.write(`${text}\n`)
  appendFileSync(options.log, `${text}\n`)
}

/** Runs a command to completion, logging it on a `$` line and its output below. */
function run(command, args, { cwd = repo, env = {}, quiet = false } = {}) {
  log(`$ ${[command, ...args].join(' ')}`)
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 << 20 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const lines = output.split('\n').filter(line => line.trim() !== '' && !line.startsWith('w: '))
  for (const line of quiet ? lines.slice(-12) : lines) log(`  ${line}`)
  return { status: result.status, output }
}

/** Starts a server in the background, logging it on a `$` line and its output as it comes. */
function background(name, command, args, { cwd = repo, onLine = () => {} } = {}) {
  log(`$ ${[command, ...args].join(' ')} &`)
  const child = spawn(command, args, { cwd, env: process.env })
  for (const stream of [child.stdout, child.stderr]) {
    let pending = ''
    stream.on('data', data => {
      pending += data.toString()
      let at
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at)
        pending = pending.slice(at + 1)
        if (line.trim() !== '') log(`  [${name}] ${line}`)
        onLine(line)
      }
    })
  }
  return child
}

async function freePort() {
  return await new Promise(resolvePort => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

const sleep = ms => new Promise(done => setTimeout(done, ms))

async function waitFor(check, seconds, what) {
  const deadline = Date.now() + seconds * 1000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

function stop(child, signal = 'SIGTERM') {
  if (child.exitCode == null && child.signalCode == null) child.kill(signal)
}

/**
 * The Gradle run of RtmpInteropTest against `url`, expecting `mode` of the server, without blocking
 * the event loop: the servers' output is read, and the sink killed, while it runs.
 */
async function gradle(mode, url, note = '') {
  const testLog = join(work, `test-${mode}.log`)
  rmSync(testLog, { force: true })
  const args = [':streamcore:testDebugUnitTest', '--tests', '*RtmpInteropTest', '--console=plain', '-q']
  log(`$ TS_RTMP_INTEROP_MODE=${mode} TS_RTMP_INTEROP_URL=${url.replace(/[^/]*$/, '…')} ./gradlew ${args.join(' ')}${note}`)
  const child = spawn('./gradlew', args, {
    cwd: cameraman,
    env: {
      ...process.env,
      TS_RTMP_INTEROP_URL: url,
      TS_RTMP_INTEROP_MODE: mode,
      TS_RTMP_INTEROP_FIXTURE: work,
      TS_RTMP_INTEROP_SECONDS: String(options.seconds),
      TS_RTMP_INTEROP_LOG: testLog
    }
  })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const code = await new Promise(done => child.on('exit', done))
  for (const line of output.split('\n').filter(line => line.trim() && !line.startsWith('w: ')).slice(-12)) log(`  ${line}`)
  if (existsSync(testLog)) {
    log(`  RtmpInteropTest (${mode}):`)
    for (const line of readFileSync(testLog, 'utf8').split('\n').filter(Boolean)) log(`    ${line}`)
  }
  log(`  gradle exit ${code}`)
  return code === 0
}

/** Audio timestamps in an FLV file, in order. */
function flvAudioStamps(file) {
  const data = readFileSync(file)
  const stamps = []
  let offset = data.readUInt32BE(5) + 4
  while (offset + 11 <= data.length) {
    const type = data[offset] & 0x1f
    const size = data.readUIntBE(offset + 1, 3)
    const stamp = data.readUIntBE(offset + 4, 3) | (data[offset + 7] << 24)
    if (offset + 11 + size > data.length) break
    // AAC raw frames only; the sequence header carries no sound.
    if (type === 8 && data[offset + 12] === 1) stamps.push(stamp >>> 0)
    offset += 11 + size + 4
  }
  return stamps
}

const results = {}

async function hls() {
  const port = await freePort()
  const key = 'interop0000000000000000000000000001'
  const hlsDir = join(work, 'hls')
  rmSync(hlsDir, { recursive: true, force: true })
  mkdirSync(hlsDir, { recursive: true })
  // The live controller's own calls, without its database: the ingest is configured, started, and
  // told the one key it may take and where that key's HLS goes.
  const ingest = `
    const live = require('./src/server/live/splitter.ts')
    live.configureIngest({
      ffmpegPath: 'ffmpeg', bindHost: '127.0.0.1', port: ${port}, app: 'live', segmentSeconds: 2,
      log: message => console.log(message),
      onEvent: event => { if (event.type !== 'status') console.log('event', event.type, event.reason ?? '') }
    })
    if (!live.startIngest()) process.exit(1)
    live.setLive('${key}', { liveStreamId: '00000000-0000-4000-8000-000000000001', hlsDir: ${JSON.stringify(hlsDir)}, destinations: [] })
    process.on('SIGTERM', () => { live.stopIngest(); setTimeout(() => process.exit(0), 12000) })
  `
  let listening = false
  const splitter = background('splitter', 'node', ['-r', 'sucrase/register', '-e', ingest], {
    onLine: line => { if (/1935|listen|Node Media|rtmp/i.test(line)) listening = true }
  })
  await sleep(3000)
  const passed = await gradle('hls', `rtmp://127.0.0.1:${port}/live/${key}`)
  // The HLS writer finishes its last segment and closes the playlist once the publisher has gone.
  await sleep(12000)
  stop(splitter)
  await sleep(1000)
  const playlist = join(hlsDir, 'master.m3u8')
  const probe = run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'compact', playlist])
  const hevc = /codec_name=hevc\|width=1920\|height=1080/.test(probe.output)
  const aac = /codec_name=aac/.test(probe.output)
  const segments = existsSync(hlsDir) ? readdirSync(hlsDir).filter(name => !name.endsWith('.m3u8')).length : 0
  log(`  hls: hevc 1920x1080 ${hevc ? 'yes' : 'NO'}, aac ${aac ? 'yes' : 'NO'}, ${segments} segment(s), splitter listening ${listening}`)
  results.hls = passed && hevc && aac
}

async function stall() {
  const port = await freePort()
  const server = background('stall', 'node', [join(director, 'rtmpStallServer.js'), '--port', String(port), '--stall-after', '8', '--stall-for', '22', '--verbose'])
  await sleep(1000)
  results.stall = await gradle('stall', `rtmp://127.0.0.1:${port}/live/interop-stall`)
  stop(server)
}

/** The reconnect run, with the sink killed and restarted while Gradle publishes. */
function reconnectWithKill() {
  return new Promise(resolveRun => {
    ;(async () => {
      const port = await freePort()
      const dir = join(work, 'sink')
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      const sinkArgs = [join(director, 'rtmpSink.js'), '--port', String(port), '--dir', dir, '--expect-codec', 'hevc']
      let publishes = 0
      const onLine = line => { if (line.includes('▸ publish')) publishes += 1 }
      let sink = background('sink', 'node', sinkArgs, { onLine })
      await sleep(1000)
      const finished = gradle(
        'reconnect',
        `rtmp://127.0.0.1:${port}/live/interop-sink`,
        '   (the sink is killed 10 s into the publish and started again at 25 s)'
      )
      await waitFor(() => publishes >= 1, 120, 'the first publish')
      await sleep(10_000)
      log('  killing the sink (SIGKILL), 10 s into the publish')
      stop(sink, 'SIGKILL')
      await sleep(15_000)
      log('  starting the sink again, 25 s into the publish')
      sink = background('sink', 'node', sinkArgs, { onLine })
      const passed = await finished
      await sleep(3000)
      stop(sink, 'SIGINT')
      await sleep(5000)
      stop(sink, 'SIGKILL')
      // Every recording the sink kept, one per publish: its audio timestamps never go backwards.
      const recordings = readdirSync(dir).filter(name => name.endsWith('.flv')).sort()
      let monotonic = recordings.length >= 2
      for (const name of recordings) {
        const stamps = flvAudioStamps(join(dir, name))
        const backwards = stamps.slice(1).filter((stamp, i) => stamp < stamps[i]).length
        if (backwards > 0 || stamps.length === 0) monotonic = false
        log(`  ${name}: ${stamps.length} AAC frames, ${stamps[0] ?? '-'}..${stamps[stamps.length - 1] ?? '-'} ms, ${backwards} backwards`)
      }
      log(`  reconnect: ${publishes} publish(es), ${recordings.length} recording(s), audio monotonic in each: ${monotonic ? 'yes' : 'NO'}`)
      resolveRun(passed && publishes >= 2 && monotonic)
    })().catch(error => {
      log(`  reconnect failed: ${error.message}`)
      resolveRun(false)
    })
  })
}

log(`# Kotlin stream interop (E6), ${new Date().toISOString()}`)
log('# The clip: 4 s of 1920x1080 HEVC at 30 fps (2 s GOP, no B-frames) and 48 kHz stereo AAC.')
run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
  '-t', '4', '-c:v', 'libx265', '-preset', 'ultrafast', '-b:v', '1500k',
  '-x265-params', 'keyint=60:min-keyint=60:bframes=0:scenecut=0:repeat-headers=1:log-level=error',
  '-f', 'hevc', join(work, 'fixture.h265')
])
run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '4', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-f', 'adts', join(work, 'fixture.aac')
])

if (!options.only || options.only === 'hls') await hls()
if (!options.only || options.only === 'stall') await stall()
if (!options.only || options.only === 'reconnect') results.reconnect = await reconnectWithKill()

log('')
for (const [name, passed] of Object.entries(results)) log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
process.exit(Object.values(results).every(Boolean) ? 0 : 1)
