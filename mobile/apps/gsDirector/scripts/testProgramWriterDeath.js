#!/usr/bin/env node
// Poisons the live program AVAssetWriter mid-take and checks that a continuation
// file is opened so export lasts recording wall clock. Never clearState; never
// touch rec-18.
//
//   DIRECTOR_DEVICE_UDID=11111111-1111111111111111 \
//     node scripts/testProgramWriterDeath.js --device 11111111-1111111111111111
//
// Hardware is pinned to Bench iPad (2) — iPad Pro 11-inch (M4).
// Not part of --suite operator.

const { spawn, spawnSync, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { directorPaths, dataContainer } = require('./appContainer')
const deviceTarget = require('./deviceTarget')

const ROOT = path.resolve(__dirname, '..')
const BUNDLE = 'co.gamestation.director'
const CONTROL_PORT = 18550
const EPSILON = 1.0
const SQLITE = '/usr/bin/sqlite3'
const ARCHIVE_ROOT = 'Library/Application Support/GSDirector/Archives'
const INDEX_ROOT = 'Library/Application Support/GSDirector'
const PROGRAM_ROOT = 'Documents/Program'
const LOCAL_PORTS = [18554, 18555, 18556, 18557]
const M4_UDID = '11111111-1111111111111111'
const SIMULATOR_UDID =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/
const PROGRAM_FAMILY = /^(program-\d{8}-\d{6})(?:-\d+)?\.mp4$/i

function usage() {
  return `Usage: node scripts/testProgramWriterDeath.js [--device UDID] [--sim]
  Starts the local RTSP farm, records ~20s, kills the program writer mid-take,
  and asserts two program parts whose remux lasts wall clock D.
  Hardware is the M4 (${M4_UDID}). Do not point this at the rec-18 iPad.
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

async function send(useDevice, target, attempts = 6) {
  let last = new Error(`send ${target} failed`)
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const host = await deviceTarget.resolveHost(useDevice)
      return await deviceTarget.get(host, target, 8_000)
    } catch (error) {
      last = error
      process.stdout.write(
        `control ${target} attempt ${attempt}/${attempts}: ${error.message}\n`
      )
      await sleep(1000)
    }
  }
  throw last
}

async function dump(useDevice) {
  const text = await send(useDevice, '/dump-state')
  return JSON.parse(text)
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

function listDeviceFiles(udid, subdirectory) {
  const jsonPath = path.join(os.tmpdir(), `gs-director-files-${process.pid}.json`)
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

function programFamily(name) {
  const match = String(name).split(',')[0].trim().match(PROGRAM_FAMILY)
  return match ? match[1] : null
}

function concatPrograms(files, destination) {
  const list = path.join(path.dirname(destination), 'concat.txt')
  fs.writeFileSync(
    list,
    files.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n') + '\n'
  )
  const copied = spawnSync(
    'ffmpeg',
    ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', destination],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
  if (copied.status === 0 && fs.existsSync(destination) && fs.statSync(destination).size > 0) {
    return
  }
  execFileSync(
    'ffmpeg',
    ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-c:a', 'aac', destination],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

function recordingDuration(db, rec) {
  const recId = Number(String(rec).replace(/^rec-/, ''))
  if (!Number.isFinite(recId)) throw new Error(`bad recording id ${rec}`)
  const rows = sqliteJson(
    db,
    `SELECT id, started_at, ended_at, program_filename FROM recordings WHERE id = ${recId}`
  )
  if (rows.length === 0) throw new Error(`no recordings row for ${rec}`)
  const started = rows[0].started_at
  const ended = rows[0].ended_at
  if (ended == null) throw new Error(`${rec} has no ended_at`)
  return {
    recId,
    duration: ended - started,
    programFilename: rows[0].program_filename || ''
  }
}

function pullDeviceRecording(udid) {
  const files = listDeviceFiles(udid, ARCHIVE_ROOT)
  const latest = latestRecFromFiles(files)
  if (latest.rec === 'rec-18') {
    throw new Error('refusing to pull rec-18')
  }
  const out = path.join(ROOT, 'DerivedData', 'program-writer-death-m4')
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
  const db = pullIndexFromDevice(udid, path.join(out, 'Index'))
  const info = recordingDuration(db, latest.rec)
  const family = programFamily(info.programFilename)
  const programFiles = listDeviceFiles(udid, PROGRAM_ROOT).filter(file => {
    const name = file.name || path.basename(file.relativePath || '')
    if (!name.endsWith('.mp4') || file.resources?.isDirectory) return false
    if (!family) return false
    return programFamily(name) === family
  })
  for (const program of programFiles) {
    const name = program.name || path.basename(program.relativePath || '')
    try {
      pullFromDevice(udid, `${PROGRAM_ROOT}/${name}`, path.join(out, 'Program', name))
    } catch {
      // Program part may still be flushing.
    }
  }
  return {
    rec: latest.rec,
    archives: path.join(out, 'Archives'),
    program: path.join(out, 'Program'),
    db,
    out
  }
}

function localProgramParts(programDir, programFilename) {
  if (!fs.existsSync(programDir)) return []
  const family = programFamily(programFilename)
  return fs
    .readdirSync(programDir)
    .filter(name => name.endsWith('.mp4'))
    .filter(name => (family ? programFamily(name) === family : true))
    .map(name => path.join(programDir, name))
    .filter(file => {
      try {
        return fs.statSync(file).size > 0
      } catch {
        return false
      }
    })
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }))
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
      `Testing on Bench iPad (2) — iPad Pro 11-inch (M4) (${options.udid})\n`
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

    const useDevice = !options.simulator
    for (const index of [1, 2, 3, 4]) {
      await send(useDevice, `/enable-source?index=${index}&on=true`)
    }
    process.stdout.write('enabled 1, 2, 3, 4\n')
    await send(useDevice, '/record?on=true')
    const afterRecord = await dump(useDevice)
    process.stdout.write(
      `after record recording=${afterRecord.dvr?.isRecording ? 1 : 0}` +
        ` encodeFailures=${afterRecord.sessions?.encodeFailures ?? '?'}\n`
    )
    if (!afterRecord.dvr?.isRecording) {
      throw new Error('recording did not start')
    }
    process.stdout.write('recording 8s before kill-program-writer\n')
    for (let i = 0; i < 8; i += 1) {
      await sleep(1000)
      const pulse = await dump(useDevice)
      process.stdout.write(
        `t+${i + 1}s recording=${pulse.dvr?.isRecording ? 1 : 0}` +
          ` encodeFailures=${pulse.sessions?.encodeFailures ?? '?'}` +
          ` lastError=${pulse.dvr?.lastError || ''}\n`
      )
    }
    await send(useDevice, '/kill-program-writer')
    const afterKill = await dump(useDevice)
    process.stdout.write(
      `after kill recording=${afterKill.dvr?.isRecording ? 1 : 0}` +
        ` encodeFailures=${afterKill.sessions?.encodeFailures ?? '?'}` +
        ` lastError=${afterKill.dvr?.lastError || ''}\n`
    )
    if (!afterKill.dvr?.isRecording) {
      throw new Error('recording stopped when the program writer was killed')
    }
    process.stdout.write('recording 12s after kill-program-writer\n')
    for (let i = 0; i < 12; i += 1) {
      await sleep(1000)
      const pulse = await dump(useDevice)
      process.stdout.write(
        `t+${i + 1}s recording=${pulse.dvr?.isRecording ? 1 : 0}` +
          ` encodeFailures=${pulse.sessions?.encodeFailures ?? '?'}` +
          ` lastError=${pulse.dvr?.lastError || ''}\n`
      )
    }
    const afterRecover = await dump(useDevice)
    process.stdout.write(
      `after recover recording=${afterRecover.dvr?.isRecording ? 1 : 0}` +
        ` encodeFailures=${afterRecover.sessions?.encodeFailures ?? '?'}` +
        ` lastError=${afterRecover.dvr?.lastError || ''}\n`
    )
    await send(useDevice, '/record?on=false')
    await waitUntilIdle(useDevice)

    let programDir
    let rec
    let db
    let out
    if (options.simulator) {
      const container = dataContainer(options.udid)
      const paths = directorPaths(container)
      rec = fs
        .readdirSync(paths.archives)
        .flatMap(camera => {
          const dir = path.join(paths.archives, camera)
          if (!fs.statSync(dir).isDirectory()) return []
          return fs.readdirSync(dir).filter(name => name.startsWith('rec-'))
        })
        .sort((a, b) => Number(b.slice(4)) - Number(a.slice(4)))[0]
      programDir = paths.program
      out = path.join(ROOT, 'DerivedData', 'program-writer-death-sim')
      fs.rmSync(out, { recursive: true, force: true })
      db = copyIndexFiles(path.dirname(paths.indexDatabase), path.join(out, 'Index'))
    } else {
      const pulled = pullDeviceRecording(options.udid)
      rec = pulled.rec
      programDir = pulled.program
      db = pulled.db
      out = pulled.out
    }
    if (rec === 'rec-18') throw new Error('refusing to inspect rec-18')
    process.stdout.write(`recording ${rec} program=${programDir}\n`)

    const info = recordingDuration(db, rec)
    process.stdout.write(`${rec} wall D=${info.duration.toFixed(3)}s\n`)
    if (info.duration < 15 || info.duration > 40) {
      throw new Error(`${rec} wall D=${info.duration}s, expected ~20s`)
    }
    const parts = localProgramParts(programDir, info.programFilename)
    for (const file of parts) {
      const bytes = fs.statSync(file).size
      process.stdout.write(`${path.basename(file)}  ${bytes} bytes\n`)
      if (bytes <= 0) throw new Error(`${file} is empty`)
    }
    if (parts.length < 2) {
      throw new Error(
        `expected two program parts for ${rec}, found ${parts.length}: ${
          parts.map(file => path.basename(file)).join(', ') || 'none'
        }`
      )
    }
    const remux = path.join(out, 'program-remux.mp4')
    concatPrograms(parts, remux)
    const remuxDuration = probeDuration(remux)
    process.stdout.write(`remux ${remuxDuration.toFixed(3)}s (target D=${info.duration.toFixed(3)}s)\n`)
    if (Math.abs(remuxDuration - info.duration) > EPSILON) {
      throw new Error(`remux lasted ${remuxDuration}s, expected ~${info.duration}s`)
    }
    process.stdout.write(`ok program-writer death recovered within ${EPSILON}s of D\n`)
  } finally {
    stop()
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
