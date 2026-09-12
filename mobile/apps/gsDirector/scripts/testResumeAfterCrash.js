#!/usr/bin/env node
// Kills the app mid-take and checks that relaunching picks the same recording back up, that the
// cameras re-arm on their own, and that the export still puts every angle and the programme on
// the wall clock across the hole where nothing was running.
//
// Simulator only, and it drives real RTSP cameras rather than the in-app test pattern, because
// re-attaching is the thing under test: after a crash Director has to rediscover each camera over
// Bonjour, open a fresh RTSP session, and give it a writer that continues the take it was already
// part of. Synthetic sources skip all three.
//
//   DIRECTOR_SIMULATOR_UDID=<udid> node scripts/testResumeAfterCrash.js
//   … --keep-farm        leave the camera farm running afterwards
//   … --scenario stream  crash while streaming only, with no take open
//   … --scenario expired come back past the resume limit and check the take is closed
//
// The farm needs sudo to bind :554 on a loopback address per camera. Without passwordless sudo
// this cannot run; say so rather than pretending a one-camera run proves anything.

const { spawn, spawnSync, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const BUNDLE = 'co.gamestation.director'
const FIXTURES = process.env.DIRECTOR_RTSP_FIXTURES_OUT || '/tmp/gs-rtsp-fixtures'
const CAMERAS = 2
const SQLITE = '/usr/bin/sqlite3'
const PATH_WITH_SBIN = `/usr/sbin:/sbin:${process.env.PATH || ''}`
const STREAM_URL = 'rtmp://127.0.0.1:1935/live/resume-test'

function usage() {
  return `Usage: DIRECTOR_SIMULATOR_UDID=<udid> node scripts/testResumeAfterCrash.js [options]
  --scenario NAME   record (default) | stream | expired
  --record-seconds N   how long to record before each crash (default 25)
  --resume-seconds N   how long to record after the last one (default 25)
  --crashes N       how many times to kill the app during the take (default 1)
  --keep-farm       leave the RTSP farm running when the run finishes
  --keep-app        leave the app running when the run finishes
`
}

function parseArgs(argv) {
  const options = {
    scenario: 'record',
    recordSeconds: 25,
    resumeSeconds: 25,
    crashes: 1,
    keepFarm: false,
    keepApp: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage())
      process.exit(0)
    } else if (arg === '--scenario') {
      options.scenario = argv[index + 1]
      index += 1
    } else if (arg === '--record-seconds') {
      options.recordSeconds = Number(argv[index + 1])
      index += 1
    } else if (arg === '--resume-seconds') {
      options.resumeSeconds = Number(argv[index + 1])
      index += 1
    } else if (arg === '--crashes') {
      options.crashes = Number(argv[index + 1])
      if (!(options.crashes >= 1)) throw new Error('--crashes needs a positive count')
      index += 1
    } else if (arg === '--keep-farm') {
      options.keepFarm = true
    } else if (arg === '--keep-app') {
      options.keepApp = true
    } else {
      throw new Error(`unknown argument ${arg}\n${usage()}`)
    }
  }
  if (!['record', 'stream', 'expired'].includes(options.scenario)) {
    throw new Error(`unknown scenario ${options.scenario}\n${usage()}`)
  }
  return options
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function simulator() {
  const udid = process.env.DIRECTOR_SIMULATOR_UDID
  if (!udid) throw new Error('set DIRECTOR_SIMULATOR_UDID')
  return udid
}

function simctl(args, options = {}) {
  const result = spawnSync('xcrun', ['simctl', ...args], { encoding: 'utf8', ...options })
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`simctl ${args.join(' ')} failed\n${result.stderr || result.stdout}`)
  }
  return result.stdout || ''
}

/// The app's own control server, which is the only way in on a device and the simplest here.
async function control(pathAndQuery) {
  const response = await fetch(`http://127.0.0.1:8765${pathAndQuery}`)
  const text = await response.text()
  if (!response.ok) throw new Error(`${pathAndQuery} -> ${response.status} ${text}`)
  return text
}

async function state() {
  return JSON.parse(await control('/dump-state'))
}

/// Polls until `predicate` holds, so a slow simulator is a slower pass rather than a failure.
async function waitFor(label, seconds, predicate) {
  const deadline = Date.now() + seconds * 1000
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await state()
      if (predicate(last)) return last
    } catch {
      // The app is still coming up, or has just been killed. Both are expected here.
    }
    await sleep(500)
  }
  throw new Error(`timed out after ${seconds}s waiting for ${label}`)
}

// MARK: - The camera farm

function ensureFixtures() {
  if (!fs.existsSync(path.join(FIXTURES, 'cameras.json'))) {
    process.stdout.write('building RTSP fixtures…\n')
    const result = spawnSync(
      'node',
      [path.join(ROOT, 'scripts/makeRtspFixtures.js'), '--out', FIXTURES, '--cameras', String(CAMERAS)],
      { encoding: 'utf8', stdio: 'inherit' }
    )
    if (result.status !== 0) throw new Error('could not build the RTSP fixtures')
  }
}

function requireSudo() {
  const check = spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8' })
  if (check.status !== 0) {
    throw new Error(
      'this needs passwordless sudo: the cameras bind :554 on one loopback address each, '
      + 'which is what makes Director see them as separate cameras'
    )
  }
}

function startFarm() {
  const child = spawn(
    'sudo',
    [
      '-n', 'node', path.join(ROOT, 'scripts/fakeRtspCameras.js'),
      '--fixtures', FIXTURES, '--local', '--advertise', '--base-port', '554'
    ],
    {
      cwd: ROOT,
      env: { ...process.env, PATH: PATH_WITH_SBIN },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let log = ''
  child.stdout.on('data', chunk => { log += chunk })
  child.stderr.on('data', chunk => { log += chunk })
  return { child, log: () => log }
}

/// An RTMP ingest that accepts a publish and keeps draining, so a resumed stream has somewhere
/// real to go. Without one the app dials, fails, and stops streaming — which is correct behaviour
/// and proves nothing about resuming.
function startRtmpSink() {
  const child = spawn('node', [path.join(ROOT, 'scripts/rtmpStallServer.js'), '--port', '1935'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', chunk => { log += chunk })
  child.stderr.on('data', chunk => { log += chunk })
  return { child, log: () => log }
}

function stopFarm(farm) {
  if (!farm) return
  spawnSync('sudo', ['-n', 'pkill', '-f', 'fakeRtspCameras'], { encoding: 'utf8' })
  try { farm.child.kill('SIGTERM') } catch { /* already gone */ }
}

// MARK: - The app

/// Arguments every launch in this run gets. The stream destination belongs here rather than in a
/// `configure` command: that one is a session overlay and dies with the process, while in
/// production the destination is a Settings value that has been on disk since the operator typed
/// it. Passing it each launch is the closest a test gets to that.
let sharedLaunchArguments = []

function launch(extra = []) {
  simctl([
    'launch', simulator(), BUNDLE,
    '-uiTest', 'YES', '-debugHUD', 'YES', '-segmentSeconds', '3',
    ...sharedLaunchArguments, ...extra
  ])
}

function container() {
  return simctl(['get_app_container', simulator(), BUNDLE, 'data']).trim()
}

/// Reads the index. WAL, so the sidecars come too or the copy is a stale snapshot and every
/// answer is quietly wrong.
function readIndex(sql) {
  const source = path.join(container(), 'Library/Application Support/GSDirector/index.sqlite')
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-index-'))
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${source}${suffix}`
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(scratch, `index.sqlite${suffix}`))
  }
  const out = execFileSync(SQLITE, [path.join(scratch, 'index.sqlite'), sql], { encoding: 'utf8' })
  fs.rmSync(scratch, { recursive: true, force: true })
  return out.trim()
}

/// Stops anything this launch resumed from an earlier run, so the run under test starts from
/// nothing rather than from somebody else's take.
async function clearInheritedSession() {
  const snapshot = await state()
  if (snapshot.dvr?.isRecording) {
    process.stdout.write('  a take was resumed from an earlier run; stopping it first\n')
    await control('/record?on=false')
    await waitFor('the inherited take to close', 180, current => current.dvr?.isRecording === false)
  }
  if (snapshot.isStreaming) {
    await control('/stream?on=false')
    await waitFor('the inherited stream to stop', 60, current => current.isStreaming === false)
  }
}

async function enableFixtureCameras() {
  const found = await waitFor('both fixture cameras to be discovered', 90, snapshot => {
    const fixtures = (snapshot.sources || []).filter(source => /Fixture Cam/.test(source.name || ''))
    return fixtures.length >= CAMERAS
  })
  const fixtures = (found.sources || [])
    .filter(source => /Fixture Cam/.test(source.name || ''))
    .slice(0, CAMERAS)
  // By name, never by row number. Paul's own cameras are on this network and enabling one of
  // those would put a test recording on somebody's phone.
  for (const source of fixtures) {
    await control(`/enable-source?index=${source.index}&on=true`)
  }
  await control('/start')
  await waitFor('both cameras to deliver frames', 90, snapshot =>
    (snapshot.tiles || []).filter(tile => (tile.receivedFrames || 0) > 30).length >= CAMERAS)
  return fixtures
}

// MARK: - Checks

function check(label, condition, detail = '') {
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`)
    return true
  }
  process.stdout.write(`  FAIL ${label}${detail ? ` — ${detail}` : ''}\n`)
  failures.push(label)
  return false
}

const failures = []

// MARK: - Scenarios

async function scenarioRecord(options) {
  process.stdout.write('\n== a take that was rolling when the app died\n')
  await control('/record?on=true')
  await sleep(1_000)
  // Cut to the second camera, so the resume has a preference to restore that is not the default.
  await control('/program?source=2')
  const rolling = await waitFor('segments to be written', 60, snapshot =>
    (snapshot.dvr?.segmentCount || 0) > 2)
  const startedAt = rolling.dvr.recordingStartedAt
  const programBefore = rolling.programSource
  check('a take is rolling', rolling.dvr.isRecording === true)
  check('the programme is on the second camera', programBefore === 1, `programSource=${programBefore}`)

  let recordingID = ''
  let segmentsBeforeFirstCrash = 0
  let killedAt = 0

  for (let round = 1; round <= options.crashes; round += 1) {
    await sleep(options.recordSeconds * 1_000)
    const before = await state()
    if (round === 1) segmentsBeforeFirstCrash = before.dvr.segmentCount
    process.stdout.write(
      `  kill ${round} of ${options.crashes}: ${before.dvr.segmentCount} segments so far\n`
    )

    killedAt = Date.now() / 1_000
    try { await control('/crash') } catch { /* the reply dies with the process */ }
    await sleep(4_000)

    recordingID = readIndex('SELECT id FROM recordings WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1;')
    check(`kill ${round}: the take is still open in the index`, recordingID !== '', `id=${recordingID}`)
    const live = readIndex('SELECT recording_id, streaming FROM live_session;')
    check(`kill ${round}: the live session survived`, live.startsWith(recordingID),
      `live_session=${live}`)

    launch()
    const resumed = await waitFor('the take to be picked up again', 90, snapshot =>
      snapshot.dvr?.isRecording === true)
    const downSeconds = Date.now() / 1_000 - killedAt

    check(`kill ${round}: recording resumed without being asked`, resumed.dvr.isRecording === true)
    check(`kill ${round}: it is the same take, not a new one`,
      Math.abs((resumed.dvr.recordingStartedAt || 0) - startedAt) < 0.5,
      `startedAt ${resumed.dvr.recordingStartedAt} vs ${startedAt}`)
    check(`kill ${round}: the resume was counted`, (resumed.dvr.resumeCount || 0) === round,
      `resumeCount=${resumed.dvr.resumeCount}, expected ${round}`)
    check(`kill ${round}: the downtime is the app being away, not the take being long`,
      resumed.dvr.lastDowntimeSeconds > 0 && resumed.dvr.lastDowntimeSeconds < downSeconds + 20,
      `down=${resumed.dvr.lastDowntimeSeconds}s, actually ${downSeconds.toFixed(1)}s`)
    check(`kill ${round}: no second recording was opened`,
      readIndex('SELECT COUNT(*) FROM recordings;')
        === readIndex(`SELECT COUNT(*) FROM recordings WHERE id <= ${recordingID};`),
      `recordings=${readIndex('SELECT id, ended_at FROM recordings;')}`)

    // The cameras have to come back on their own: rediscovered over Bonjour, a fresh RTSP session,
    // and a writer that continues the take.
    const rearmed = await waitFor('both cameras to archive again', 120, snapshot =>
      (snapshot.tiles || []).filter(tile => tile.isArchiving).length >= CAMERAS)
    check(`kill ${round}: both cameras re-armed with no operator action`,
      (rearmed.tiles || []).filter(tile => tile.isArchiving).length >= CAMERAS)
    check(`kill ${round}: the programme went back to the camera the operator chose`,
      rearmed.programSource === programBefore,
      `programSource=${rearmed.programSource} vs ${programBefore}`)
  }

  await sleep(options.resumeSeconds * 1_000)
  const growing = await state()
  check('segments are being written to the same take',
    growing.dvr.segmentCount > 0 &&
      Number(readIndex(`SELECT COUNT(*) FROM segments WHERE recording_id = ${recordingID};`))
        > Number(segmentsBeforeFirstCrash),
    `segments now ${readIndex(`SELECT COUNT(*) FROM segments WHERE recording_id = ${recordingID};`)}`)

  const parts = readIndex(`SELECT part, MIN(wall - program_seconds) FROM program_anchors WHERE recording_id = ${recordingID} GROUP BY part ORDER BY part;`)
  check('the programme has a part for each stretch it was running',
    parts.split('\n').filter(Boolean).length >= options.crashes + 1,
    `part starts=${parts.replace(/\n/g, ' | ')}`)
  const cuts = readIndex(`SELECT wall, source_id, intended FROM program_cuts WHERE recording_id = ${recordingID} ORDER BY wall;`)
  check('the cut the operator made is on record', cuts.length > 0, `program_cuts=${cuts.replace(/\n/g, ' | ')}`)

  process.stdout.write('  stopping the take\n')
  await control('/record?on=false')
  const stopped = await waitFor('the take to close', 180, snapshot =>
    snapshot.dvr?.isRecording === false)
  check('only the operator closes the take', stopped.dvr.isRecording === false)
  check('the live session is gone once the take is stopped',
    readIndex('SELECT COUNT(*) FROM live_session;') === '0')

  const bounds = readIndex(`SELECT started_at, ended_at FROM recordings WHERE id = ${recordingID};`)
  const [takeStart, takeEnd] = bounds.split('|').map(Number)
  const takeSeconds = takeEnd - takeStart
  check('the take spans every outage',
    takeSeconds > options.recordSeconds * options.crashes + options.resumeSeconds,
    `take is ${takeSeconds.toFixed(1)}s`)

  process.stdout.write('  exporting\n')
  await control('/export-recording')
  const exported = await waitFor('the export to finish', 300, snapshot =>
    (snapshot.dvr?.lastExportFiles || []).length > 0 || snapshot.dvr?.lastExportError)
  check('the export produced files', !exported.dvr.lastExportError,
    exported.dvr.lastExportError || '')

  const prepared = path.join(
    container(), 'Library/Application Support/GSDirector/Prepared', `rec-${recordingID}`
  )
  const files = fs.existsSync(prepared) ? fs.readdirSync(prepared).filter(name => !name.startsWith('.')) : []
  check('every camera and the programme were exported', files.length >= CAMERAS + 1,
    `files=${files.join(', ')}`)

  for (const name of files) {
    const file = path.join(prepared, name)
    const duration = decodedSeconds(file)
    check(`${name} is as long as the take`, Math.abs(duration - takeSeconds) < 3,
      `${duration.toFixed(1)}s vs ${takeSeconds.toFixed(1)}s`)
  }

  // The outage should be a freeze, not a hole — and each file has its own outage, because the
  // programme comes back with the app while a camera comes back when it reconnects. Read the two
  // ends of each hole out of the index rather than guessing them from the requested timings, then
  // probe inside that file's own hole.
  for (const name of files) {
    const file = path.join(prepared, name)
    // The last hole, which is the one `killedAt` marks. With several kills the earlier ones are
    // covered by the same mechanism and by the length check above.
    const hole = holeFor({ name, recordingID, takeStart, crashAt: killedAt })
    if (!hole) {
      check(`${name} has a measurable outage`, false, 'nothing in the index says where it is')
      continue
    }
    if (hole.to - hole.from < 1.5) {
      process.stdout.write(
        `  ${name}: only ${(hole.to - hole.from).toFixed(1)}s of hole, too short to probe\n`
      )
      continue
    }
    const middle = (hole.from + hole.to) / 2
    const spread = Math.max(0.4, Math.min(2, (hole.to - hole.from) / 4))
    process.stdout.write(
      `  ${name}: hole ${hole.from.toFixed(1)}–${hole.to.toFixed(1)}s, probing `
      + `${(middle - spread).toFixed(1)}s and ${(middle + spread).toFixed(1)}s\n`
    )
    const first = frameSignature(file, middle - spread)
    const second = frameSignature(file, middle + spread)
    if (!first || !second) {
      check(`${name} decodes inside the outage`, false, 'no frame came back')
      continue
    }
    check(`${name} holds one frame through the outage`, first.hash === second.hash,
      `${first.hash.slice(0, 12)} vs ${second.hash.slice(0, 12)}`)
    check(`${name} holds a picture rather than going black`, first.mean > 8,
      `mean luma ${first.mean.toFixed(1)}`)
  }
}

/// Where one exported file's hole is, in seconds from the take's start.
///
/// Not one window for the whole take: the programme resumes with the app, and each camera resumes
/// when it has rediscovered its server and reconnected, which is seconds later and different per
/// camera. Asking every file about the same span would test the slowest camera's hole against the
/// programme's content and call a correct file a failure.
function holeFor({ name, recordingID, takeStart, crashAt }) {
  const crashOffset = crashAt - takeStart
  const camera = /-(Fixture_Cam_[A-Z])\.mov$/.exec(name)
  if (camera) {
    const slug = camera[1].replace(/_/g, ' ')
    const rows = readIndex(
      `SELECT s.source_id, MIN(s.start_wall) FROM segments s WHERE s.recording_id = ${recordingID}`
      + ` AND s.start_wall > ${crashAt} GROUP BY s.source_id;`
    )
    // Two cameras, two rows; the export names them but the index keys them by identity, so take
    // the earliest first segment after the crash that is not already covered. Both cameras
    // reconnect within a second or two of each other, so the earliest is a fair floor for either
    // and never claims more hole than there was.
    const starts = rows.split('\n').filter(Boolean).map(row => Number(row.split('|')[1]))
    if (starts.length === 0) return null
    const back = Math.max(...starts) - takeStart
    void slug
    return { from: crashOffset, to: back }
  }
  const parts = readIndex(
    `SELECT start FROM (SELECT part, MIN(wall - program_seconds) AS start FROM program_anchors`
    + ` WHERE recording_id = ${recordingID} GROUP BY part)`
    + ` WHERE start > ${crashAt} ORDER BY start LIMIT 1;`
  )
  if (!parts) return null
  return { from: crashOffset, to: Number(parts) - takeStart }
}

async function scenarioStream(options) {
  process.stdout.write('\n== a stream that was up when the app died, with no take open\n')
  await control('/stream?on=true')
  const streaming = await waitFor('the stream to come up', 60, snapshot => snapshot.isStreaming === true)
  check('streaming', streaming.isStreaming === true)
  check('no take was opened', streaming.dvr.isRecording === false)
  const recordingsBefore = readIndex('SELECT COUNT(*) FROM recordings;')

  await sleep(8_000)
  const live = readIndex('SELECT recording_id, streaming FROM live_session;')
  check('the live session says streaming and names no take', live.endsWith('|1') && live.startsWith('|'),
    `live_session=${live}`)

  process.stdout.write('  killing the app\n')
  try { await control('/crash') } catch { /* expected */ }
  await sleep(4_000)
  launch()

  const resumed = await waitFor('the stream to be re-dialled', 90, snapshot =>
    snapshot.isStreaming === true || snapshot.dvr?.resumedStream === true)
  check('the stream came back', resumed.isStreaming === true || resumed.dvr.resumedStream === true)
  check('it was the resume that dialled it', resumed.dvr.resumedStream === true)
  check('still no take', resumed.dvr.isRecording === false)
  check('and none was opened by the resume',
    readIndex('SELECT COUNT(*) FROM recordings;') === recordingsBefore,
    `recordings ${readIndex('SELECT COUNT(*) FROM recordings;')} vs ${recordingsBefore}`)

  await control('/stream?on=false')
  await waitFor('the stream to stop', 60, snapshot => snapshot.isStreaming === false)
  check('stopping the stream clears the live session',
    readIndex('SELECT COUNT(*) FROM live_session;') === '0')
}

async function scenarioExpired(options) {
  process.stdout.write('\n== an app that came back too late\n')
  await control('/record?on=true')
  const rolling = await waitFor('segments to be written', 60, snapshot =>
    (snapshot.dvr?.segmentCount || 0) > 2)
  check('a take is rolling', rolling.dvr.isRecording === true)
  await sleep(8_000)

  process.stdout.write('  killing the app\n')
  try { await control('/crash') } catch { /* expected */ }
  await sleep(8_000)

  const recordingID = readIndex('SELECT id FROM recordings WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1;')
  check('the take is open before the relaunch', recordingID !== '')

  // One second of grace, so being away for the few seconds a relaunch takes is already too long.
  process.stdout.write('  relaunching with a one-second resume limit\n')
  launch(['-resumeLimit', '1'])
  const after = await waitFor('the app to settle', 90, snapshot => snapshot.clockSeconds > 0)
  await sleep(4_000)
  const settled = await state()

  check('nothing was resumed', settled.dvr.isRecording === false,
    `isRecording=${settled.dvr.isRecording}`)
  check('the take was closed at its last media',
    readIndex(`SELECT ended_at IS NOT NULL FROM recordings WHERE id = ${recordingID};`) === '1')
  check('the live session was cleared', readIndex('SELECT COUNT(*) FROM live_session;') === '0')

  const bounds = readIndex(`SELECT started_at, ended_at FROM recordings WHERE id = ${recordingID};`)
  const [start, end] = bounds.split('|').map(Number)
  check('it was closed at its media, not at the relaunch', end - start < 60,
    `take reads ${(end - start).toFixed(1)}s`)
}

// MARK: - Media helpers

/// Duration from decoding rather than from the container header, which reports nonsense for a
/// programme master (24,837 s for a 6.7-minute file, measured).
function decodedSeconds(file) {
  const result = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=duration', '-of', 'default=nw=1:nk=1', file
  ], { encoding: 'utf8' })
  const stated = Number((result.stdout || '').trim())
  if (Number.isFinite(stated) && stated > 0 && stated < 20_000) return stated
  const counted = spawnSync('ffprobe', [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames,avg_frame_rate', '-of', 'default=nw=1:nk=1', file
  ], { encoding: 'utf8' })
  const [frames, rate] = (counted.stdout || '').trim().split('\n')
  const [numerator, denominator] = (rate || '30/1').split('/').map(Number)
  const fps = denominator ? numerator / denominator : 30
  return fps > 0 ? Number(frames) / fps : 0
}

/// A hash of one decoded frame and its mean luma, so "the picture froze" and "the picture went
/// black" are different answers rather than the same one.
function frameSignature(file, seconds) {
  const out = path.join(os.tmpdir(), `resume-frame-${process.pid}-${Math.random().toString(36).slice(2)}.pgm`)
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(seconds), '-i', file, '-frames:v', '1',
    '-vf', 'scale=64:36,format=gray', out
  ], { encoding: 'utf8' })
  if (result.status !== 0 || !fs.existsSync(out)) return null
  const bytes = fs.readFileSync(out)
  fs.unlinkSync(out)
  // Skip the PGM header: three whitespace-separated fields after the magic.
  let offset = 2
  let fields = 0
  while (offset < bytes.length && fields < 3) {
    while (offset < bytes.length && /\s/.test(String.fromCharCode(bytes[offset]))) offset += 1
    while (offset < bytes.length && !/\s/.test(String.fromCharCode(bytes[offset]))) offset += 1
    fields += 1
  }
  offset += 1
  const pixels = bytes.subarray(offset)
  if (pixels.length === 0) return null
  const mean = pixels.reduce((total, value) => total + value, 0) / pixels.length
  const hash = require('node:crypto').createHash('sha1').update(pixels).digest('hex')
  return { hash, mean }
}

// MARK: - Main

async function main() {
  const options = parseArgs(process.argv.slice(2))
  simulator()
  requireSudo()
  ensureFixtures()

  if (options.scenario === 'stream') sharedLaunchArguments = ['-streamURL', STREAM_URL]
  const farm = startFarm()
  const rtmp = options.scenario === 'stream' ? startRtmpSink() : null
  let ok = false
  try {
    await sleep(6_000)
    process.stdout.write(`camera farm:\n${farm.log().split('\n').map(line => `  ${line}`).join('\n')}\n`)

    simctl(['terminate', simulator(), BUNDLE], { allowFailure: true })
    await sleep(1_000)
    launch()
    await waitFor('the app to come up', 90, snapshot => snapshot.clockSeconds > 0)
    // A previous run that ended badly leaves a live session, and this launch will have picked it
    // up — correctly, which is the whole feature, and uselessly for a test that wants to measure
    // its own take from zero.
    await clearInheritedSession()
    await enableFixtureCameras()

    if (options.scenario === 'record') await scenarioRecord(options)
    if (options.scenario === 'stream') await scenarioStream(options)
    if (options.scenario === 'expired') await scenarioExpired(options)
    ok = failures.length === 0
  } finally {
    if (rtmp) { try { rtmp.child.kill('SIGTERM') } catch { /* already gone */ } }
    if (!options.keepFarm) stopFarm(farm)
    if (!options.keepApp) simctl(['terminate', simulator(), BUNDLE], { allowFailure: true })
  }

  process.stdout.write('\n')
  if (ok) {
    process.stdout.write(`PASS — ${options.scenario}\n`)
  } else {
    process.stdout.write(`FAIL — ${options.scenario}: ${failures.length} check(s)\n`)
    for (const failure of failures) process.stdout.write(`  ${failure}\n`)
    process.exitCode = 1
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`)
    process.exit(1)
  })
}
