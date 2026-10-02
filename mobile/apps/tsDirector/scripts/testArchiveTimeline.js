#!/usr/bin/env node
// Records the bad-cameras RTSP farm and checks that every exported MOV lasts the recording
// wall clock. Never clearState; never touch a device that still holds rec-88.
//
//   DIRECTOR_DEVICE_UDID=00008132-0000193801B9001C node scripts/testArchiveTimeline.js
//   DIRECTOR_SIMULATOR_UDID=<udid> node scripts/testArchiveTimeline.js --sim --device <udid>
//
// Hardware is pinned to Pauls iPad Pro (2) — iPad Pro 11-inch (M4).

const { spawn, spawnSync, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { directorPaths, dataContainer } = require('./appContainer')
const deviceTarget = require('./deviceTarget')

const ROOT = path.resolve(__dirname, '..')
const BUNDLE = 'app.teamstation.director'
const CONTROL_PORT = 18550
const EPSILON = 0.5
const SQLITE = '/usr/bin/sqlite3'
const ARCHIVE_ROOT = 'Library/Application Support/TSDirector/Archives'
const INDEX_ROOT = 'Library/Application Support/TSDirector'
const PROGRAM_ROOT = 'Documents/Program'
const LOCAL_PORTS = [18554, 18555, 18556, 18557]
const M4_UDID = '00008132-0000193801B9001C'
const SIMULATOR_UDID =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/

function usage() {
  return `Usage: node scripts/testArchiveTimeline.js [--device UDID] [--sim]
  Starts the local bad-cameras farm, launches Director, records one take,
  and asserts equal MOV durations. Does not clearState.
  Hardware is the M4 (${M4_UDID}). Do not point this at the rec-88 iPad.
`
}

function isSimulatorUDID(udid) {
  return SIMULATOR_UDID.test(udid)
}

function lanIPv4() {
  const nets = os.networkInterfaces()
  const preferred = ['en0', 'en1', 'eth0']
  const usable = addr =>
    (addr.family === 'IPv4' || addr.family === 4) &&
    !addr.internal &&
    !String(addr.address).startsWith('169.254.')
  for (const name of preferred) {
    const found = (nets[name] || []).find(usable)
    if (found) return found.address
  }
  for (const addrs of Object.values(nets)) {
    const found = (addrs || []).find(usable)
    if (found) return found.address
  }
  throw new Error('no LAN IPv4 for RTSP hosts')
}

function rtspHosts() {
  const host = lanIPv4()
  // Semicolon, not comma: maestro-runner `-e LAN_HOSTS=a,b` truncates after `a`.
  return LOCAL_PORTS.map(port => `${host}:${port}`).join(';')
}

function parseArgs(argv) {
  const options = {
    udid: process.env.DIRECTOR_DEVICE_UDID || process.env.DIRECTOR_SIMULATOR_UDID,
    sim: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage())
      process.exit(0)
    }
    if (arg === '--sim') {
      options.sim = true
      continue
    }
    if (arg === '--device') {
      options.udid = argv[index + 1]
      index += 1
      continue
    }
    throw new Error(`unknown argument ${arg}\n${usage()}`)
  }
  if (!options.udid) {
    throw new Error('pass --device <udid> or set DIRECTOR_DEVICE_UDID / DIRECTOR_SIMULATOR_UDID')
  }
  const simulator = options.sim || isSimulatorUDID(options.udid)
  if (!simulator && options.udid !== M4_UDID) {
    throw new Error(
      `hardware runs are pinned to the M4 (${M4_UDID}); refusing ${options.udid}`
    )
  }
  return { ...options, simulator }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.stderr || result.stdout || result.status}`
    )
  }
  return result.stdout
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function startFarm() {
  const child = spawn(
    process.execPath,
    [path.join(ROOT, 'scripts', 'fakeRtspCameras.js'), '--local', '--scenario', 'bad-cameras'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  child.stdout.on('data', chunk => process.stdout.write(chunk))
  child.stderr.on('data', chunk => process.stderr.write(chunk))
  return child
}

async function waitForFarm() {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${CONTROL_PORT}/clock`)
      if (response.ok) return
    } catch {
      // Farm still binding.
    }
    await sleep(200)
  }
  throw new Error('fault farm control port never came up')
}

function probeDuration(file) {
  const raw = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8' }
  ).trim()
  const duration = Number(raw)
  if (!Number.isFinite(duration)) throw new Error(`ffprobe duration for ${file}: ${raw}`)
  return duration
}

function newestRecording(archivesDir) {
  if (!fs.existsSync(archivesDir)) throw new Error(`no archives at ${archivesDir}`)
  const recs = []
  for (const camera of fs.readdirSync(archivesDir)) {
    const cameraDir = path.join(archivesDir, camera)
    if (!fs.statSync(cameraDir).isDirectory()) continue
    for (const rec of fs.readdirSync(cameraDir)) {
      if (!rec.startsWith('rec-')) continue
      recs.push({ camera, rec, dir: path.join(cameraDir, rec) })
    }
  }
  if (recs.length === 0) throw new Error('no rec-* directories copied')
  recs.sort((a, b) => fs.statSync(b.dir).mtimeMs - fs.statSync(a.dir).mtimeMs)
  return recs[0].rec
}

function listDeviceFiles(udid, subdirectory) {
  const jsonPath = path.join(os.tmpdir(), `ts-director-files-${process.pid}.json`)
  const args = [
    'devicectl',
    'device',
    'info',
    'files',
    '--device',
    udid,
    '--domain-type',
    'appDataContainer',
    '--domain-identifier',
    BUNDLE,
    '--json-output',
    jsonPath
  ]
  if (subdirectory) args.push('--subdirectory', subdirectory)
  execFileSync('xcrun', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  fs.rmSync(jsonPath, { force: true })
  return data.result?.files ?? []
}

function pullFromDevice(udid, remote, local) {
  fs.mkdirSync(path.dirname(local), { recursive: true })
  execFileSync(
    'xcrun',
    [
      'devicectl',
      'device',
      'copy',
      'from',
      '--device',
      udid,
      '--domain-type',
      'appDataContainer',
      '--domain-identifier',
      BUNDLE,
      '--source',
      remote,
      '--destination',
      local
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

function sqliteJson(db, sql) {
  const raw = execFileSync(SQLITE, ['-json', db, sql], { encoding: 'utf8' }).trim()
  return raw ? JSON.parse(raw) : []
}

function checkpointIndex(db) {
  execFileSync(SQLITE, [db, 'PRAGMA wal_checkpoint(FULL);'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function copyIndexFiles(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  let copied = false
  for (const name of ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm']) {
    const src = path.join(srcDir, name)
    if (!fs.existsSync(src)) continue
    fs.copyFileSync(src, path.join(destDir, name))
    copied = true
  }
  if (!copied) throw new Error(`no index.sqlite in ${srcDir}`)
  const db = path.join(destDir, 'index.sqlite')
  checkpointIndex(db)
  return db
}

function pullIndexFromDevice(udid, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  for (const name of ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm']) {
    try {
      pullFromDevice(udid, `${INDEX_ROOT}/${name}`, path.join(destDir, name))
    } catch {
      // WAL/SHM are optional if SQLite already checkpointed on device.
    }
  }
  const db = path.join(destDir, 'index.sqlite')
  if (!fs.existsSync(db)) throw new Error('index.sqlite missing on device')
  checkpointIndex(db)
  return db
}

function latestRecFromFiles(files) {
  const recs = new Map()
  for (const file of files) {
    const relative = file.relativePath || ''
    const match = relative.match(/^([^/]+)\/(rec-\d+)(?:\/|$)/)
    if (!match) continue
    const rec = match[2]
    const n = Number(rec.slice(4))
    const cameras = recs.get(rec) || { rec, n, cameras: new Set() }
    cameras.cameras.add(match[1])
    recs.set(rec, cameras)
  }
  const latest = [...recs.values()].sort((a, b) => b.n - a.n)[0]
  if (!latest) throw new Error('no rec-* directories in Archives')
  return latest
}

function pullDeviceRecording(udid) {
  const files = listDeviceFiles(udid, ARCHIVE_ROOT)
  const latest = latestRecFromFiles(files)
  const out = path.join(ROOT, 'DerivedData', 'archive-timeline-m4')
  fs.rmSync(out, { recursive: true, force: true })
  const wanted = `${latest.rec}/`
  for (const file of files) {
    const relative = file.relativePath || ''
    if (!relative.includes(`/${wanted}`) && !relative.endsWith(`/${latest.rec}`)) continue
    if (file.resources?.isDirectory) continue
    if (relative.includes('.sb-')) continue
    try {
      pullFromDevice(udid, `${ARCHIVE_ROOT}/${relative}`, path.join(out, 'Archives', relative))
    } catch {
      // Missing optional segment.
    }
  }
  const programFiles = listDeviceFiles(udid, PROGRAM_ROOT).filter(file => {
    const name = file.name || path.basename(file.relativePath || '')
    return name.endsWith('.mp4') && !file.resources?.isDirectory
  })
  programFiles.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  const program = [...programFiles].reverse().find(file => (file.metadata?.size ?? 0) > 0)
  if (program) {
    const name = program.name || path.basename(program.relativePath || '')
    try {
      pullFromDevice(udid, `${PROGRAM_ROOT}/${name}`, path.join(out, 'Program', name))
    } catch {
      // Program file may not exist.
    }
  }
  const db = pullIndexFromDevice(udid, path.join(out, 'Index'))
  return {
    rec: latest.rec,
    archives: path.join(out, 'Archives'),
    program: path.join(out, 'Program'),
    db
  }
}

function newestProgramFile(programDir) {
  if (!fs.existsSync(programDir)) return null
  const programs = fs
    .readdirSync(programDir)
    .filter(name => name.endsWith('.mp4'))
    .map(name => path.join(programDir, name))
    .filter(file => {
      try {
        return fs.statSync(file).size > 0
      } catch {
        return false
      }
    })
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
  return programs.length > 0 ? programs[programs.length - 1] : null
}

function assertWallSpans(db, rec) {
  const recId = Number(String(rec).replace(/^rec-/, ''))
  if (!Number.isFinite(recId)) throw new Error(`bad recording id ${rec}`)
  const rows = sqliteJson(
    db,
    `SELECT id, started_at, ended_at FROM recordings WHERE id = ${recId}`
  )
  if (rows.length === 0) throw new Error(`no recordings row for ${rec}`)
  const started = rows[0].started_at
  const ended = rows[0].ended_at
  if (ended == null) throw new Error(`${rec} has no ended_at`)
  const duration = ended - started
  process.stdout.write(`${rec} wall D=${duration.toFixed(3)}s\n`)
  const spans = sqliteJson(
    db,
    `SELECT source_id AS source,
            MIN(start_wall) AS t0,
            MAX(start_wall + duration) AS t1
     FROM segments
     WHERE recording_id = ${recId} AND is_initialization = 0
     GROUP BY source_id`
  )
  if (spans.length < 4) {
    throw new Error(`expected ≥4 archive sources in ${rec}, found ${spans.length}`)
  }
  for (const row of spans) {
    const span = row.t1 - row.t0
    process.stdout.write(`${row.source}  wall ${span.toFixed(3)}s\n`)
    if (Math.abs(span - duration) > EPSILON) {
      throw new Error(`${row.source} wall span ${span}s, expected ~${duration}s`)
    }
  }
  const farm = spans.filter(row => /1855[4-7]/.test(row.source))
  if (farm.length < 4) {
    throw new Error(`expected four farm cameras in ${rec}, found ${farm.length}`)
  }
  return duration
}

async function waitUntilIdle(useDevice) {
  const host = await deviceTarget.resolveHost(useDevice)
  const deadline = Date.now() + 60_000
  let last = ''
  while (Date.now() < deadline) {
    const state = JSON.parse(await deviceTarget.get(host, '/dump-state'))
    last = state.recordingStage || ''
    const recording = Boolean(state.dvr?.isRecording)
    process.stdout.write(
      `recordingStage=${last || '?'} recording=${recording ? 1 : 0}` +
        `${state.dvr?.programOutput ? ` program=${state.dvr.programOutput}` : ''}\n`
    )
    if (last === 'idle' && !recording) return state
    await sleep(1000)
  }
  throw new Error(`recording did not return to idle (last stage ${last || 'unknown'})`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.simulator) {
    process.env.DIRECTOR_SIMULATOR_UDID = options.udid
    process.stdout.write(`Testing on simulator ${options.udid}\n`)
  } else {
    process.env.DIRECTOR_DEVICE_UDID = options.udid
    process.stdout.write(
      `Testing on Pauls iPad Pro (2) — iPad Pro 11-inch (M4) (${options.udid})\n`
    )
  }

  const farm = startFarm()
  const stop = () => {
    try {
      farm.kill('SIGTERM')
    } catch {
      // ignore
    }
  }
  process.on('exit', stop)
  process.on('SIGINT', () => {
    stop()
    process.exit(1)
  })

  try {
    await waitForFarm()
    const hosts = rtspHosts()
    process.env.LAN_HOSTS = hosts
    process.stdout.write(`rtspHosts ${hosts}\n`)
    const maestroArgs = [
      path.join(ROOT, 'scripts', 'run-maestro.js'),
      '--device',
      options.udid,
      'archive-timeline'
    ]
    if (options.simulator) maestroArgs.splice(1, 0, '--sim')
    const maestro = spawnSync(process.execPath, maestroArgs, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'inherit',
      env: process.env
    })
    if (maestro.status !== 0) throw new Error('maestro archive-timeline failed')

    const control = path.join(ROOT, 'scripts', 'control.js')
    const controlDevice = ['--device', options.udid]
    run(process.execPath, [control, ...controlDevice, 'enable', '1', '2', '3', '4'])
    run(process.execPath, [control, ...controlDevice, 'send', '/record?on=true'])

    const clock = JSON.parse(await (await fetch(`http://127.0.0.1:${CONTROL_PORT}/clock`)).text())
    const waitMs = Math.max(5, (clock.durationSeconds ?? 45) + 2) * 1000
    process.stdout.write(`recording ${waitMs / 1000}s against the fault farm\n`)
    await sleep(waitMs)
    run(process.execPath, [control, ...controlDevice, 'send', '/record?on=false'])
    await waitUntilIdle(!options.simulator)

    let archivesDir
    let programDir
    let rec
    let db
    if (options.simulator) {
      const container = dataContainer(options.udid)
      const paths = directorPaths(container)
      rec = newestRecording(paths.archives)
      archivesDir = paths.archives
      programDir = paths.program
      const out = path.join(ROOT, 'DerivedData', 'archive-timeline-sim')
      fs.rmSync(out, { recursive: true, force: true })
      db = copyIndexFiles(path.dirname(paths.indexDatabase), path.join(out, 'Index'))
    } else {
      const pulled = pullDeviceRecording(options.udid)
      rec = pulled.rec
      archivesDir = pulled.archives
      programDir = pulled.program
      db = pulled.db
    }
    process.stdout.write(`recording ${rec} archives=${archivesDir}\n`)

    const duration = assertWallSpans(db, rec)
    const program = newestProgramFile(programDir)
    if (!program) throw new Error('no non-empty program MOV')
    const programDuration = probeDuration(program)
    process.stdout.write(`${path.basename(program)}  ${programDuration.toFixed(3)}s\n`)
    if (Math.abs(programDuration - duration) > EPSILON) {
      throw new Error(
        `${program} lasted ${programDuration}s, expected ~${duration}s`
      )
    }
    process.stdout.write(`ok equal-length within ${EPSILON}s of ${duration.toFixed(3)}s\n`)
  } finally {
    stop()
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
