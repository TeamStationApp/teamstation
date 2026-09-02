#!/usr/bin/env node
'use strict'

// Four-hour Director + Cameraman stress loop, optionally split into hour-long recordings.
//
// Maestro (`rtsp-four-cameras`) must already have launched Director with local-network
// access. This script enables first/third/mound/handheld, starts directing, turns RECORD
// and STREAM on (ingest URL from Settings), then every 30s cuts or instant-replays over
// the control channel. A PeerTube frame is grabbed about every 3 minutes.
// Every 4 minutes the floor and peak of max(physFootprintMB, residentSizeMB) are kept for both
// Director and Cameraman. If two consecutive floors are 30% above the matching window
// from an hour earlier, the run aborts as a sustained leak. A sample at or above 1200 MB
// (Director) or 800 MB (Cameraman) aborts immediately. Replay spikes lift the peak
// only, so they do not trip the hour-ago abort. Cameraman dump-state is fetched in parallel with
// every Director dump-state (twice per tick).
//
// `--hour-blocks` records four one-hour takes. After each hour it stops, exports the take,
// checks that every movie lasts the hour, and checks that Cameraman audio/video blanks
// landed only on the handheld file.
//
//   node scripts/stressFourHour.js --device <director-udid> --cameraman-device <iphone-udid>
//   node scripts/stressFourHour.js --device <udid> --cameraman-device <udid> --seconds 120
//   node scripts/stressFourHour.js --device <udid> --cameraman-device <udid> --hour-blocks

const { execFileSync, spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const deviceTarget = require('./deviceTarget')
const { MemoryPeakGuard } = require('./memoryPeakGuard')

function exported(name) {
  if (typeof deviceTarget[name] === 'function' || deviceTarget[name] !== undefined) {
    return deviceTarget[name]
  }
  const found = Object.keys(deviceTarget).find(
    key => key.toLowerCase() === name.toLowerCase()
  )
  if (found) return deviceTarget[found]
  throw new Error(`deviceTarget missing ${name}: ${Object.keys(deviceTarget).join(', ')}`)
}

const get = exported('get')
const resolveHost = exported('resolveHost')
const pairedDevices = exported('pairedDevices')

const CAMERA_NAMES = ['first', 'third', 'mound', 'handheld']
const NAME_ALIASES = {
  first: ['first', '1st', 'first base'],
  third: ['third', '3rd', 'third base'],
  mound: ['mound'],
  handheld: ['handheld', 'hand held', 'hand-held']
}
const REPLAY_SECONDS = [5, 7.5, 10]
const REPLAY_SPEEDS = ['full', 'slow']
const PEERTUBE_API =
  'https://tube.gamestation.co/api/v1/videos/ieSgPChc5oJSqyTEwPLsBz'
const PEERTUBE_WATCH =
  'https://tube.gamestation.co/w/ieSgPChc5oJSqyTEwPLsBz'
const UDID_PATTERN =
  /^[0-9A-Fa-f]{8}-([0-9A-Fa-f]{16}|[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$/

function parseArgs(argv) {
  const options = {
    seconds: 14400,
    tickMs: 30000,
    screenshotMs: 180000,
    peertubeUrl: PEERTUBE_WATCH,
    record: true,
    stream: true,
    replay: true,
    verify: true,
    blockSeconds: 0,
    audioFaultSeconds: 8,
    videoFaultSeconds: 25,
    cameras: [...CAMERA_NAMES]
  }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    const next = argv[i + 1]
    if (value === '--device' && next) {
      options.device = next
      i += 1
    } else if (value === '--cameraman-device' && next) {
      options.cameramanDevice = next
      i += 1
    } else if (value === '--seconds' && next) {
      options.seconds = Number(next)
      i += 1
    } else if (value === '--tick-ms' && next) {
      options.tickMs = Number(next)
      i += 1
    } else if (value === '--screenshot-ms' && next) {
      options.screenshotMs = Number(next)
      i += 1
    } else if (value === '--peertube-url' && next) {
      options.peertubeUrl = next
      i += 1
    } else if (value === '--cameras' && next) {
      options.cameras = next.split(',').map(name => name.trim()).filter(Boolean)
      i += 1
    } else if (value === '--hour-blocks') {
      options.blockSeconds = 3600
    } else if (value === '--block-seconds' && next) {
      options.blockSeconds = Number(next)
      i += 1
    } else if (value === '--audio-fault-seconds' && next) {
      options.audioFaultSeconds = Number(next)
      i += 1
    } else if (value === '--video-fault-seconds' && next) {
      options.videoFaultSeconds = Number(next)
      i += 1
    } else if (value === '--no-record') {
      options.record = false
    } else if (value === '--no-stream') {
      options.stream = false
    } else if (value === '--no-replay') {
      options.replay = false
    } else if (value === '--no-verify') {
      options.verify = false
    } else if (value.startsWith('--')) {
      throw new Error(`unknown flag ${value}`)
    }
  }
  for (const name of options.cameras) {
    if (!CAMERA_NAMES.includes(name)) {
      throw new Error(`unknown camera ${name}; use ${CAMERA_NAMES.join(',')}`)
    }
  }
  if (!options.device || !UDID_PATTERN.test(options.device)) {
    throw new Error('pass --device <director-udid>')
  }
  if (!options.cameramanDevice || !UDID_PATTERN.test(options.cameramanDevice)) {
    throw new Error('pass --cameraman-device <iphone-udid>')
  }
  return options
}

function nowIso() {
  const date = new Date()
  const pad = n => String(n).padStart(2, '0')
  const offsetMin = -date.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  const y = date.getFullYear()
  const mo = pad(date.getMonth() + 1)
  const d = pad(date.getDate())
  const h = pad(date.getHours())
  const mi = pad(date.getMinutes())
  const s = pad(date.getSeconds())
  const ms = String(date.getMilliseconds()).padStart(3, '0')
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

let stopRequested = null
const sleepWaiters = []

function sleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(finish, ms)
    function finish() {
      const i = sleepWaiters.indexOf(finish)
      if (i >= 0) sleepWaiters.splice(i, 1)
      clearTimeout(timer)
      resolve()
    }
    sleepWaiters.push(finish)
  })
}

function requestStop(signal) {
  if (stopRequested) return
  stopRequested = signal
  for (const wake of sleepWaiters.slice()) wake()
}

function normalizeName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function pick(obj, ...keys) {
  if (obj == null) return undefined
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key]
  }
  const lower = {}
  for (const [key, value] of Object.entries(obj)) lower[key.toLowerCase()] = value
  for (const key of keys) {
    const hit = lower[String(key).toLowerCase()]
    if (hit !== undefined && hit !== null) return hit
  }
  return undefined
}

function matchCameraName(label) {
  const normalized = normalizeName(label)
  for (const [name, aliases] of Object.entries(NAME_ALIASES)) {
    if (aliases.some(alias => normalized === alias || normalized.includes(alias))) {
      return name
    }
  }
  return null
}

async function enforceCameras(host, state, wantedNames, actionLog) {
  for (const source of state.sources ?? []) {
    const label = pick(source, 'name', 'displayName')
    const name = matchCameraName(label)
    const index = pick(source, 'index')
    const enabled = pick(source, 'isEnabled', 'enabled') === true
    if (!name) {
      if (enabled) {
        await directorSend(host, `/enable-source?index=${index}&on=false`)
        append(actionLog, `NOTE disable unnamed index=${index}`)
      }
      continue
    }
    const wanted = wantedNames.includes(name)
    if (wanted && !enabled) {
      await directorSend(host, `/enable-source?index=${index}&on=true`)
      append(actionLog, `NOTE enable ${name} index=${index}`)
    } else if (!wanted && enabled) {
      await directorSend(host, `/enable-source?index=${index}&on=false`)
      append(actionLog, `NOTE disable ${name} index=${index}`)
    }
  }
}

function cameraMap(state) {
  const map = {}
  for (const source of state.sources ?? []) {
    const name = matchCameraName(pick(source, 'name', 'displayName'))
    if (!name) continue
    map[name] = {
      source: Number(pick(source, 'index')),
      live: false,
      archiving: false
    }
  }
  for (const tile of state.tiles ?? []) {
    const name = matchCameraName(pick(tile, 'displayName', 'name'))
    if (!name) continue
    map[name] = {
      source: Number(pick(tile, 'index')) + 1,
      live: String(pick(tile, 'state', 'status') ?? '').toLowerCase() === 'live',
      archiving: pick(tile, 'isArchiving', 'isArchiving') === true,
      fps: pick(tile, 'framesPerSecond', 'framesPerSecond'),
      out: pick(tile, 'displayedFramesPerSecond', 'displayedFramesPerSecond'),
      displayedFrames: pick(tile, 'displayedFrames', 'displayedFrames'),
      dropped: pick(tile, 'droppedFrames', 'droppedFrames'),
      enqueueFails: tile.enqueueFails ?? null,
      state: pick(tile, 'state', 'status')
    }
  }
  return map
}

function tileStateName(tile) {
  return String(tile?.state ?? '').toLowerCase()
}

function namedLiveCount(map, names = CAMERA_NAMES) {
  return names.filter(name => tileStateName(map[name]) === 'live').length
}

function namedReplayingCount(map, names = CAMERA_NAMES) {
  return names.filter(name => tileStateName(map[name]) === 'replaying').length
}

/// Live plus instant-replay. Overlapping replays can make `live` 0 while every
/// named camera is still accounted for as `replaying`.
function namedAccountedCount(map, names = CAMERA_NAMES) {
  return names.filter(name => {
    const state = tileStateName(map[name])
    return state === 'live' || state === 'replaying'
  }).length
}

async function directorGet(host, target) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return JSON.parse(await get(host, target, 20000))
    } catch (error) {
      lastError = error
      if (attempt < 3) await sleep(1000)
    }
  }
  throw lastError
}

async function directorSend(host, target) {
  const text = await get(host, target)
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

function hostnamesForDevice(udid) {
  const devices = pairedDevices()
  const device = devices.find(entry => entry.hardwareProperties.udid === udid)
  if (!device) throw new Error(`device ${udid} is not paired`)
  const hosts = new Set()
  const slug = (device.deviceProperties.name ?? '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug) hosts.add(`${slug}.local`)
  for (const host of device.connectionProperties.potentialHostnames ?? []) {
    hosts.add(host)
  }
  return [...hosts]
}

async function resolveCameramanHost(udid) {
  if (process.env.CAMERAMAN_DEVICE_ADDRESS) return process.env.CAMERAMAN_DEVICE_ADDRESS
  const port = Number(process.env.CAMERAMAN_CONTROL_PORT ?? 8766)
  for (const host of hostnamesForDevice(udid)) {
    for (const pathName of ['/health', '/dump-state']) {
      try {
        const response = await fetch(`http://${host}:${port}${pathName}`, {
          signal: AbortSignal.timeout(3000)
        })
        if (response.ok) return host
      } catch {
        continue
      }
    }
  }
  throw new Error(
    'no Cameraman address answered on 8766 — is GS Cameraman running with -uiTest true?'
  )
}

async function cameramanGet(host, target) {
  const port = Number(process.env.CAMERAMAN_CONTROL_PORT ?? 8766)
  const url = `http://${host}:${port}${target}`
  let lastError
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(20000)
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`cameraman ${target} -> ${response.status} ${text}`)
      return JSON.parse(text)
    } catch (error) {
      lastError = error
      if (attempt < 5) await sleep(2000)
    }
  }
  throw lastError
}

async function dumpDirectorAndCameraman(directorHost, cameramanHost, cameramanUdid) {
  let dirHost = directorHost
  let camHost = cameramanHost
  const [directorResult, cameramanResult] = await Promise.allSettled([
    directorGet(dirHost, '/dump-state'),
    cameramanGet(camHost, '/dump-state')
  ])
  let director = directorResult.status === 'fulfilled' ? directorResult.value : null
  if (!director) {
    try {
      dirHost = await resolveHost(true)
    } catch {
      /* keep the last known host */
    }
    director = await directorGet(dirHost, '/dump-state')
  }
  let cameraman = cameramanResult.status === 'fulfilled' ? cameramanResult.value : null
  if (!cameraman) {
    try {
      camHost = await resolveCameramanHost(cameramanUdid)
    } catch {
      /* keep the last known host */
    }
    cameraman = await cameramanGet(camHost, '/dump-state')
  }
  return {
    director,
    cameraman,
    directorHost: dirHost,
    cameramanHost: camHost
  }
}

function readCameramanHealth(dump) {
  const server = dump.server && typeof dump.server === 'object' ? dump.server : {}
  return {
    running: dump.isRunning === true,
    clients: server.clientCount ?? dump.clientCount ?? 0,
    captured: dump.capturedFrames ?? null,
    encoded: dump.encodedFrames ?? null,
    encodeFailure: dump.encodeFailure ?? null,
    dropped: dump.droppedFrames ?? server.droppedFrames ?? null,
    physFootprintMB: dump.physFootprintMB ?? null,
    residentSizeMB: dump.residentSizeMB ?? null,
    availableMemoryMB: dump.availableMemoryMB ?? null,
    cpuPercent: dump.cpuPercent ?? null,
    thermal: dump.thermalState ?? null,
    cpuCores: dump.cpuCores ?? null,
    isListening: server.isListening === true,
    lastError: server.lastError ?? null,
    lastDisconnectReason: server.lastDisconnectReason ?? null,
    acceptedClients: server.acceptedClients ?? null,
    closedClients: server.closedClients ?? null,
    sendQueuePendingBytes: server.sendQueuePendingBytes ?? null,
    sendQueueFlushes: server.sendQueueFlushes ?? null,
    listenerState: server.listenerState ?? null,
    cameraFailure: dump.cameraFailure ?? null,
    interrupted: dump.interrupted === true,
    interruptionReason: dump.interruptionReason ?? null,
    audioPendingBytes: dump.audioPendingBytes ?? null
  }
}

function applyCameramanHealth(health, dump) {
  const cam = readCameramanHealth(dump)
  health.cameraman = cam
  health.cameramanRunning = cam.running
  health.cameramanClients = cam.clients
  health.cameramanCaptured = cam.captured
  health.cameramanEncoded = cam.encoded
  health.cameramanEncodeFailure = cam.encodeFailure
  health.cameramanDropped = cam.dropped
  health.cameramanPhysFootprintMB = cam.physFootprintMB
  health.cameramanResidentSizeMB = cam.residentSizeMB
  health.cameramanAvailableMemoryMB = cam.availableMemoryMB
  health.cameramanCpuPercent = cam.cpuPercent
  health.cameramanThermal = cam.thermal
  health.cameramanListening = cam.isListening
  health.cameramanLastDisconnect = cam.lastDisconnectReason
  health.cameramanInterrupted = cam.interrupted
  health.cameramanAudioPendingBytes = cam.audioPendingBytes
  return cam
}

function processPid(udid, needle) {
  const jsonPath = path.join(
    os.tmpdir(),
    `gs-procs-${udid.slice(-6)}-${process.pid}.json`
  )
  try {
    execFileSync(
      'xcrun',
      [
        'devicectl',
        'device',
        'info',
        'processes',
        '--device',
        udid,
        '--json-output',
        jsonPath
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const raw = fs.readFileSync(jsonPath, 'utf8')
    const data = JSON.parse(raw.slice(raw.indexOf('{')))
    const list =
      data.result?.runningProcesses ??
      data.result?.processes ??
      data.runningProcesses ??
      []
    const hit = list.find(entry => {
      let blob = `${entry.executable ?? ''} ${entry.name ?? ''} ${entry.bundleIdentifier ?? ''}`
      try {
        blob = decodeURIComponent(blob)
      } catch {
        /* executable is a file URL with percent-escapes */
      }
      return blob.toLowerCase().includes(needle.toLowerCase())
    })
    return hit?.processIdentifier ?? hit?.pid ?? hit?.processId ?? null
  } catch {
    return null
  } finally {
    try {
      fs.unlinkSync(jsonPath)
    } catch {
      /* ignore */
    }
  }
}

function walkFiles(dir, depth) {
  if (depth < 0) return []
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(full, depth - 1))
    else files.push(full)
  }
  return files
}

function crashSnapshot() {
  const roots = [
    path.join(os.homedir(), 'Library/Logs/CrashReporter/MobileDevice'),
    path.join(os.homedir(), 'Library/Logs/DiagnosticReports')
  ]
  const names = []
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const entry of walkFiles(root, 2)) {
      if (/director|cameraman|jetsam/i.test(entry)) names.push(entry)
    }
  }
  return names.sort()
}

function pickAction(map, programSource, cameras, replay) {
  if (!replay) {
    const target = cameras[Math.floor(Math.random() * cameras.length)]
    const source = map[target]?.source
    if (!source) return { kind: 'skip', label: `skip ${target} unmapped` }
    return {
      kind: 'cut',
      label: `cut ${target}`,
      path: `/program?source=${source}`
    }
  }
  const targets = [...cameras, 'output']
  const target = targets[Math.floor(Math.random() * targets.length)]
  if (target === 'output') {
    const seconds = REPLAY_SECONDS[Math.floor(Math.random() * REPLAY_SECONDS.length)]
    const speed = REPLAY_SPEEDS[Math.floor(Math.random() * REPLAY_SPEEDS.length)]
    return {
      kind: 'replay',
      label: `replay output ${seconds}s ${speed}`,
      path: `/replay?source=${programSource}&seconds=${seconds}&speed=${speed}`
    }
  }
  const source = map[target]?.source
  if (!source) {
    return { kind: 'skip', label: `skip ${target} unmapped` }
  }
  if (Math.floor(Math.random() * 7) === 0) {
    return {
      kind: 'cut',
      label: `cut ${target}`,
      path: `/program?source=${source}`
    }
  }
  const seconds = REPLAY_SECONDS[Math.floor(Math.random() * REPLAY_SECONDS.length)]
  const speed = REPLAY_SPEEDS[Math.floor(Math.random() * REPLAY_SPEEDS.length)]
  return {
    kind: 'replay',
    label: `replay ${target} ${seconds}s ${speed}`,
    path: `/replay?source=${source}&seconds=${seconds}&speed=${speed}`
  }
}

async function grabPeerTubeFrame(outFile) {
  let playlistUrl
  try {
    const response = await fetch(PEERTUBE_API, { signal: AbortSignal.timeout(15000) })
    if (response.ok) {
      const json = await response.json()
      const playlists = json.streamingPlaylists ?? []
      playlistUrl =
        playlists[0]?.playlistUrl ??
        playlists[0]?.files?.[0]?.fileUrl ??
        json.files?.[0]?.fileUrl
    }
  } catch {
    /* public API may require auth; the watch page still embeds the HLS URL */
  }
  if (!playlistUrl) {
    const page = await fetch(PEERTUBE_WATCH, { signal: AbortSignal.timeout(15000) })
    if (!page.ok) throw new Error(`PeerTube watch page ${page.status}`)
    const html = await page.text()
    const match = html.match(/https?:[^"'\\\s]+\.m3u8[^"'\\\s]*/)
    if (!match) throw new Error('PeerTube watch page has no HLS playlist')
    playlistUrl = match[0].replace(/\\u0026/g, '&')
  }
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      playlistUrl,
      '-frames:v',
      '1',
      outFile
    ],
    { timeout: 20000 }
  )
}

function startLogStream(logPath, udids) {
  const fd = fs.openSync(logPath, 'a')
  const kids = []
  const predicate =
    'process CONTAINS[c] "Director" OR process CONTAINS[c] "Cameraman" OR subsystem CONTAINS "gamestation"'
  try {
    kids.push(
      spawn(
        'log',
        ['stream', '--style', 'compact', '--level', 'error', '--predicate', predicate],
        { stdio: ['ignore', fd, fd] }
      )
    )
  } catch {
    /* host unified log may not include the devices */
  }
  for (const udid of udids) {
    try {
      kids.push(
        spawn(
          'xcrun',
          ['devicectl', 'device', 'syslog', '--device', udid],
          { stdio: ['ignore', fd, fd] }
        )
      )
    } catch {
      continue
    }
  }
  return () => {
    for (const kid of kids) {
      try {
        kid.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
    try {
      fs.closeSync(fd)
    } catch {
      /* ignore */
    }
  }
}

function append(file, line) {
  fs.appendFileSync(file, `${nowIso()} ${line}\n`)
}

const DIRECTOR_BUNDLE = 'co.gamestation.director'
const PREPARED_ROOT = 'Library/Application Support/GSDirector/Prepared'
const HOUR_DURATION_SLACK = 30
const FILE_DURATION_SLACK = 3

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
    DIRECTOR_BUNDLE,
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
      DIRECTOR_BUNDLE,
      '--source',
      remote,
      '--destination',
      local
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
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

function parseDetectWindows(stderr, startRe, endRe) {
  const windows = []
  let open = null
  for (const line of stderr.split('\n')) {
    const start = line.match(startRe)
    if (start) {
      open = { start: Number(start[1]), end: null }
      continue
    }
    const end = line.match(endRe)
    if (end && open) {
      open.end = Number(end[1])
      windows.push(open)
      open = null
    }
  }
  if (open) windows.push(open)
  return windows
}

function detectBlanks(file) {
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-i',
      file,
      '-af',
      'silencedetect=noise=-35dB:d=2',
      '-vf',
      'blackdetect=d=2:pix_th=0.12',
      '-f',
      'null',
      '-'
    ],
    { encoding: 'utf8' }
  )
  const stderr = `${result.stderr || ''}${result.stdout || ''}`
  return {
    silence: parseDetectWindows(
      stderr,
      /silence_start:\s*([0-9.]+)/,
      /silence_end:\s*([0-9.]+)/
    ),
    black: parseDetectWindows(
      stderr,
      /black_start:([0-9.]+)/,
      /black_end:([0-9.]+)/
    )
  }
}

function windowCovers(windows, start, end, slack = 2.5) {
  return windows.some(window => {
    const from = window.start
    const to = window.end == null ? Infinity : window.end
    return from <= start + slack && to >= end - slack
  })
}

function windowOverlaps(windows, start, end) {
  return windows.some(window => {
    const from = window.start
    const to = window.end == null ? Infinity : window.end
    return from < end && to > start
  })
}

function planFaults(blockSeconds, options) {
  const audioAt = Math.min(90, Math.max(20, Math.floor(blockSeconds / 8)))
  const videoAt = Math.min(180, Math.max(audioAt + options.audioFaultSeconds + 20, Math.floor(blockSeconds / 4)))
  return [
    {
      kind: 'audio',
      at: audioAt,
      duration: options.audioFaultSeconds,
      started: false,
      ended: false
    },
    {
      kind: 'video',
      at: videoAt,
      duration: options.videoFaultSeconds,
      started: false,
      ended: false
    }
  ]
}

async function applyScheduledFaults(elapsedSec, faults, cameramanHost, actionLog) {
  for (const fault of faults) {
    if (!fault.started && elapsedSec >= fault.at) {
      const pathName = fault.kind === 'audio' ? '/set-audio?on=false' : '/set-video?on=false'
      await cameramanGet(cameramanHost, pathName)
      fault.started = true
      fault.startedAtIso = nowIso()
      fault.startedElapsed = elapsedSec
      append(
        actionLog,
        `FAULT ${fault.kind} off elapsed=${elapsedSec.toFixed(1)}s duration=${fault.duration}s`
      )
    }
    if (fault.started && !fault.ended && elapsedSec >= fault.at + fault.duration) {
      const pathName = fault.kind === 'audio' ? '/set-audio?on=true' : '/set-video?on=true'
      await cameramanGet(cameramanHost, pathName)
      fault.ended = true
      fault.endedAtIso = nowIso()
      fault.endedElapsed = elapsedSec
      append(actionLog, `FAULT ${fault.kind} on elapsed=${elapsedSec.toFixed(1)}s`)
    }
  }
}

async function restoreFaults(faults, cameramanHost, actionLog) {
  for (const fault of faults) {
    if (fault.started && !fault.ended) {
      const pathName = fault.kind === 'audio' ? '/set-audio?on=true' : '/set-video?on=true'
      try {
        await cameramanGet(cameramanHost, pathName)
        fault.ended = true
        fault.endedAtIso = nowIso()
        append(actionLog, `FAULT ${fault.kind} restored at block end`)
      } catch (error) {
        append(actionLog, `NOTE restore ${fault.kind} failed: ${error.message}`)
      }
    }
  }
}

async function waitUntilIdle(host, actionLog) {
  let last = ''
  await waitFor('recording idle', 180000, async () => {
    const state = await directorGet(host, '/dump-state')
    const recording = pick(state.dvr, 'isRecording', 'recording') === true
    const stage = String(state.recordingStage || '')
    if (stage !== last) {
      append(actionLog, `NOTE recordingStage=${stage || '?'} recording=${recording ? 1 : 0}`)
      last = stage
    }
    return !recording && (stage === 'idle' || stage === '')
  })
}

async function exportLatestRecording(host, actionLog) {
  const before = await directorGet(host, '/dump-state')
  const previousID = before.dvr?.lastExportRecordingID ?? null
  await directorSend(host, '/export-recording')
  append(actionLog, 'NOTE export-recording started')
  await waitFor('export to finish', 30 * 60 * 1000, async () => {
    const state = await directorGet(host, '/dump-state')
    const dvr = state.dvr || {}
    if (dvr.lastExportError) throw new Error(`export failed: ${dvr.lastExportError}`)
    if (dvr.isExporting === true) return false
    const id = dvr.lastExportRecordingID
    if (id == null || id === previousID) return false
    return Array.isArray(dvr.lastExportFiles) && dvr.lastExportFiles.length > 0
  })
  const state = await directorGet(host, '/dump-state')
  const dvr = state.dvr || {}
  append(
    actionLog,
    `NOTE exported rec-${dvr.lastExportRecordingID} files=${(dvr.lastExportFiles || []).join(',')}`
  )
  return {
    recordingID: dvr.lastExportRecordingID,
    files: dvr.lastExportFiles || []
  }
}

function pullPreparedRecording(udid, recordingID, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true })
  fs.mkdirSync(destDir, { recursive: true })
  const remoteDir = `${PREPARED_ROOT}/rec-${recordingID}`
  const files = listDeviceFiles(udid, remoteDir)
  const pulled = []
  for (const file of files) {
    const name = file.name || path.basename(file.relativePath || '')
    if (!name || file.resources?.isDirectory) continue
    if (!/\.(mov|mp4)$/i.test(name)) continue
    const local = path.join(destDir, name)
    pullFromDevice(udid, `${remoteDir}/${name}`, local)
    pulled.push(local)
  }
  if (pulled.length === 0) throw new Error(`no prepared movies for rec-${recordingID}`)
  return pulled
}

function verifyHourExports(files, expectedSeconds, faults, actionLog) {
  const durations = files.map(file => ({
    file,
    name: path.basename(file),
    duration: probeDuration(file)
  }))
  for (const row of durations) {
    append(actionLog, `NOTE duration ${row.name}=${row.duration.toFixed(3)}s`)
    if (Math.abs(row.duration - expectedSeconds) > HOUR_DURATION_SLACK) {
      throw new Error(
        `${row.name} lasted ${row.duration.toFixed(3)}s, expected ~${expectedSeconds}s`
      )
    }
  }
  const values = durations.map(row => row.duration)
  const spread = Math.max(...values) - Math.min(...values)
  append(actionLog, `NOTE duration-spread=${spread.toFixed(3)}s`)
  if (spread > FILE_DURATION_SLACK) {
    throw new Error(`export durations differ by ${spread.toFixed(3)}s`)
  }

  const handheld = durations.find(row => /hand/i.test(row.name))
  if (!handheld) {
    append(actionLog, 'NOTE no handheld export to analyse for blanks')
    return { durations, spread }
  }
  const detected = detectBlanks(handheld.file)
  append(
    actionLog,
    `NOTE handheld black=${JSON.stringify(detected.black)} silence=${JSON.stringify(detected.silence)}`
  )
  for (const fault of faults.filter(item => item.started)) {
    const start = fault.startedElapsed ?? fault.at
    const end = fault.endedElapsed ?? fault.at + fault.duration
    if (fault.kind === 'audio') {
      if (!windowCovers(detected.silence, start, end)) {
        throw new Error(
          `handheld audio mute ${start.toFixed(1)}-${end.toFixed(1)}s was not silent`
        )
      }
      if (windowOverlaps(detected.black, start, end)) {
        throw new Error(
          `handheld video went black during audio mute ${start.toFixed(1)}-${end.toFixed(1)}s`
        )
      }
    }
    if (fault.kind === 'video') {
      if (!windowCovers(detected.black, start, end)) {
        throw new Error(
          `handheld video blank ${start.toFixed(1)}-${end.toFixed(1)}s was not black`
        )
      }
      if (windowCovers(detected.silence, start, end)) {
        throw new Error(
          `handheld audio went silent during video blank ${start.toFixed(1)}-${end.toFixed(1)}s`
        )
      }
    }
  }
  return { durations, spread, detected }
}

async function waitFor(label, timeoutMs, fn) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await sleep(2000)
  }
  throw new Error(`timeout waiting for ${label}`)
}

async function main() {
  process.on('SIGINT', () => requestStop('SIGINT'))
  process.on('SIGTERM', () => requestStop('SIGTERM'))

  const options = parseArgs(process.argv.slice(2))
  process.env.DIRECTOR_DEVICE_UDID = options.device

  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  const logDir = path.join(os.homedir(), '.cursor', 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  const actionLog = path.join(logDir, `${stamp}-stressFourHour-actions.log`)
  const healthLog = path.join(logDir, `${stamp}-stressFourHour-health.log`)
  const unifiedLog = path.join(logDir, `${stamp}-stressFourHour-unified.log`)
  const shotDir = path.join(logDir, `${stamp}-stressFourHour-peertube`)
  fs.mkdirSync(shotDir, { recursive: true })

  append(
    actionLog,
    `START device=${options.device} cameraman=${options.cameramanDevice} seconds=${options.seconds} blockSeconds=${options.blockSeconds || options.seconds} record=${options.record} stream=${options.stream} replay=${options.replay} cameras=${options.cameras.join(',')}`
  )
  append(actionLog, `NOTE peertube ${options.peertubeUrl}`)

  let host = await resolveHost(true)
  let cameramanHost = await resolveCameramanHost(options.cameramanDevice)
  append(actionLog, `NOTE director-host=${host} cameraman-host=${cameramanHost}`)

  const directorPid = processPid(options.device, 'GS Director.app/GS Director')
  const cameramanPid = processPid(options.cameramanDevice, 'GS Cameraman.app/GS Cameraman')
  append(
    actionLog,
    `NOTE directorPid=${directorPid ?? 'unknown'} cameramanPid=${cameramanPid ?? 'unknown'}`
  )
  const crashesAtStart = new Set(crashSnapshot())
  const stopLogs = startLogStream(unifiedLog, [options.device, options.cameramanDevice])

  let state = await directorGet(host, '/dump-state')
  let map = cameraMap(state)
  if (CAMERA_NAMES.some(name => !map[name])) {
    try {
      await directorSend(host, '/search-cameras')
    } catch {
      /* search may not exist; dump-state wait still applies */
    }
    await waitFor('named cameras', 60000, async () => {
      state = await directorGet(host, '/dump-state')
      map = cameraMap(state)
      return CAMERA_NAMES.every(name => map[name])
    })
  }

  await enforceCameras(host, state, options.cameras, actionLog)

  state = await directorGet(host, '/dump-state')
  map = cameraMap(state)
  const freeDisk = pick(state.dvr, 'freeDiskBytes', 'freeBytes')
  const needDisk = 50 * 1024 * 1024 * 1024
  if (freeDisk != null && Number(freeDisk) < needDisk) {
    throw new Error(`free disk ${freeDisk} bytes is below ${needDisk} byte floor`)
  }
  append(actionLog, `NOTE free-disk=${freeDisk ?? 'unknown'}`)

  const wanted = options.cameras.length
  if (namedLiveCount(map, options.cameras) < wanted) {
    await directorSend(host, '/start')
  }
  await waitFor(`${wanted} live named cameras`, 90000, async () => {
    state = await directorGet(host, '/dump-state')
    map = cameraMap(state)
    return namedLiveCount(map, options.cameras) === wanted
  })

  if (options.stream) await directorSend(host, '/stream?on=true')
  else await directorSend(host, '/stream?on=false')
  await waitFor('stream mode', 30000, async () => {
    state = await directorGet(host, '/dump-state')
    const streaming = pick(state, 'isStreaming', 'streaming') === true
    if (options.stream && !streaming) return false
    if (!options.stream && streaming) return false
    return true
  })
  append(
    actionLog,
    `NOTE stream=${options.stream} cameras=${options.cameras.join(',')}`
  )

  const blockSeconds = options.blockSeconds > 0 ? options.blockSeconds : options.seconds
  const blockCount =
    options.blockSeconds > 0
      ? Math.max(1, Math.round(options.seconds / options.blockSeconds))
      : 1
  append(
    actionLog,
    `NOTE blocks=${blockCount} blockSeconds=${blockSeconds} audioFault=${options.audioFaultSeconds}s videoFault=${options.videoFaultSeconds}s`
  )

  const t0 = Date.now()
  let lastShot = 0
  let ticksOk = 0
  let ticksSkip = 0
  let cameramanZeroStreak = 0
  let cameramanListenStreak = 0
  let cameramanStoppedStreak = 0
  let cameramanInterruptedStreak = 0
  let keyframeAgeStreak = 0
  let programFrameAgeStreak = 0
  let displayStallStreak = 0
  let cameramanEncodeStreak = 0
  let lastCameramanEncoded = null
  let lastCameramanCaptured = null
  let encoderResetIncreaseTicks = 0
  let lastEncoderResetCount = 0
  let abortReason = null
  let lastProgram = (state.programSource ?? 0) + 1
  const memoryGuard = new MemoryPeakGuard({ hardCapMB: 1200 })
  const cameramanMemoryGuard = new MemoryPeakGuard({ hardCapMB: 800 })
  const hourResults = []
  const exportDir = path.join(logDir, `${stamp}-stressFourHour-exports`)
  fs.mkdirSync(exportDir, { recursive: true })

  try {
    for (let block = 1; block <= blockCount; block += 1) {
      if (stopRequested || abortReason) break
      append(actionLog, `NOTE block ${block}/${blockCount} start`)
      const faults = planFaults(blockSeconds, options)
      if (options.record) await directorSend(host, '/record?on=true')
      else await directorSend(host, '/record?on=false')
      await waitFor('record mode', 30000, async () => {
        state = await directorGet(host, '/dump-state')
        map = cameraMap(state)
        const recording = pick(state.dvr, 'isRecording', 'recording') === true
        if (options.record && !recording) return false
        if (!options.record && recording) return false
        if (options.record && !options.cameras.every(name => map[name]?.archiving)) return false
        return true
      })
      const blockT0 = Date.now()
      while (Date.now() - blockT0 < blockSeconds * 1000) {
      if (Date.now() - t0 >= options.seconds * 1000) break
      if (stopRequested) {
        append(actionLog, `NOTE stopped by ${stopRequested}`)
        break
      }
      const tickStarted = Date.now()
      let dumps
      try {
        dumps = await dumpDirectorAndCameraman(host, cameramanHost, options.cameramanDevice)
        if (dumps.directorHost) host = dumps.directorHost
        if (dumps.cameramanHost) cameramanHost = dumps.cameramanHost
      } catch (error) {
        abortReason = error.message
        append(healthLog, `ABORT ${abortReason}`)
        break
      }
      state = dumps.director
      map = cameraMap(state)
      lastProgram = (state.programSource ?? 0) + 1
      await enforceCameras(host, state, options.cameras, actionLog)
      try {
        dumps = await dumpDirectorAndCameraman(host, cameramanHost, options.cameramanDevice)
        if (dumps.directorHost) host = dumps.directorHost
        if (dumps.cameramanHost) cameramanHost = dumps.cameramanHost
      } catch (error) {
        abortReason = error.message
        append(healthLog, `ABORT ${abortReason}`)
        break
      }
      state = dumps.director
      const cameraman = dumps.cameraman
      map = cameraMap(state)

      const health = {
        recording: pick(state.dvr, 'isRecording', 'recording') === true,
        streaming: pick(state, 'isStreaming', 'streaming') === true,
        live: namedLiveCount(map, options.cameras),
        replaying: namedReplayingCount(map, options.cameras),
        accounted: namedAccountedCount(map, options.cameras),
        thermal: pick(state, 'thermalState', 'thermal'),
        memoryMB: pick(state, 'availableMemoryMB', 'memoryMB'),
        physFootprintMB: pick(state, 'physFootprintMB'),
        residentSizeMB: pick(state, 'residentSizeMB'),
        decodeSessions: pick(state.sessions, 'decodeSessions'),
        archiveBytes: pick(state.dvr, 'byteCount', 'bytes'),
        archiveSegments: pick(state.dvr, 'segmentCount', 'segments'),
        playoutDepth: Array.isArray(state.tiles)
          ? state.tiles.reduce((n, t) => n + (Number(t.playoutDepth) || 0), 0)
          : null,
        replayError: pick(state, 'lastReplayError', 'replayError'),
        disk: pick(state.dvr, 'freeDiskBytes', 'freeBytes'),
        encodeFailures: pick(state.sessions, 'encodeFailures', 'failures'),
        streamKeyframeAge: pick(state, 'streamKeyframeAgeSeconds', 'kfage'),
        streamKeyframeCount: pick(state, 'streamKeyframeCount', 'kfn'),
        streamPendingEncodes: pick(state, 'streamPendingEncodes', 'pend'),
        streamEncodeCallbackAge: pick(state, 'streamEncodeCallbackAgeSeconds', 'cbage'),
        programFrameAge: pick(state, 'programFrameAgeSeconds', 'pfage'),
        streamIdleKeyframeCount: pick(state, 'streamIdleKeyframeCount', 'idlekf'),
        streamEncoderResetCount: pick(state, 'streamEncoderResetCount', 'encreset'),
        program: lastProgram,
        composedFrames: pick(state, 'composedFrames'),
        fps: Object.fromEntries(CAMERA_NAMES.map(name => [name, map[name]?.fps ?? null])),
        out: Object.fromEntries(CAMERA_NAMES.map(name => [name, map[name]?.out ?? null])),
        displayedFrames: Object.fromEntries(
          CAMERA_NAMES.map(name => [name, map[name]?.displayedFrames ?? null])
        ),
        dropped: Object.fromEntries(CAMERA_NAMES.map(name => [name, map[name]?.dropped ?? null])),
        enqueueFails: Object.fromEntries(
          CAMERA_NAMES.map(name => [name, map[name]?.enqueueFails ?? null])
        ),
        tileState: Object.fromEntries(CAMERA_NAMES.map(name => [name, map[name]?.state ?? null]))
      }

      const cam = applyCameramanHealth(health, cameraman)
      append(healthLog, JSON.stringify(health))

      if (directorPid) {
        const nowPid = processPid(options.device, 'GS Director.app/GS Director')
        if (nowPid && nowPid !== directorPid) {
          abortReason = `director PID changed ${directorPid} -> ${nowPid}`
          break
        }
      }
      if (cameramanPid) {
        const nowPid = processPid(options.cameramanDevice, 'GS Cameraman.app/GS Cameraman')
        if (nowPid && nowPid !== cameramanPid) {
          abortReason = `cameraman PID changed ${cameramanPid} -> ${nowPid}`
          break
        }
      }
      if (options.record && !health.recording) {
        abortReason = 'recording dropped to off'
        break
      }
      if (options.stream && !health.streaming) {
        abortReason = 'streaming dropped to off'
        break
      }
      if (health.accounted < wanted) {
        abortReason =
          `only ${health.accounted} named cameras live or replaying` +
          ` (live=${health.live} replaying=${health.replaying})`
        break
      }
      if (cam.cameraFailure) {
        abortReason = `cameraman capture failure ${cam.cameraFailure}`
        break
      }
      if (cam.interrupted) {
        cameramanInterruptedStreak += 1
        if (cameramanInterruptedStreak >= 2) {
          abortReason = `cameraman capture interrupted (${cam.interruptionReason ?? 'unknown'})`
          break
        }
      } else {
        cameramanInterruptedStreak = 0
      }
      if (!cam.isListening) {
        cameramanListenStreak += 1
        if (cameramanListenStreak >= 2) {
          abortReason =
            `cameraman listener down (${cam.listenerState ?? 'unknown'}: ${cam.lastError ?? 'no lastError'})`
          break
        }
      } else {
        cameramanListenStreak = 0
      }
      if (!cam.running) {
        cameramanStoppedStreak += 1
        if (cameramanStoppedStreak >= 2) {
          abortReason = 'cameraman isRunning stayed false'
          break
        }
      } else {
        cameramanStoppedStreak = 0
      }
      if (options.cameras.includes('handheld') && cam.clients < 1) {
        cameramanZeroStreak += 1
        if (cameramanZeroStreak >= 2) {
          const encodedAdvancing =
            lastCameramanEncoded != null &&
            Number.isFinite(Number(cam.encoded)) &&
            Number(cam.encoded) > lastCameramanEncoded
          abortReason =
            `cameraman clients stayed 0 (lost handheld)` +
            ` listening=${cam.isListening}` +
            ` running=${cam.running}` +
            ` encodedAdvancing=${encodedAdvancing}` +
            ` lastDisconnect=${cam.lastDisconnectReason ?? 'none'}` +
            ` mem=${cam.physFootprintMB ?? '?'}MB`
          break
        }
      } else {
        cameramanZeroStreak = 0
      }
      const frozenDisplay = options.cameras.filter(name => {
        const tile = map[name]
        return tile?.live && Number(tile.fps) > 20 && Number(tile.out) === 0
      })
      if (frozenDisplay.length > 0) {
        displayStallStreak += 1
        if (displayStallStreak >= 2) {
          abortReason = `display stalled (${frozenDisplay.join(',')}) fps>20 out=0`
          break
        }
      } else {
        displayStallStreak = 0
      }
      if (cameraman.encodeFailure) {
        abortReason = `cameraman encodeFailure ${cameraman.encodeFailure}`
        break
      }
      const encoded = Number(cameraman.encodedFrames)
      const captured = Number(cameraman.capturedFrames)
      const handheldFps = Number(map.handheld?.fps)
      if (
        options.cameras.includes('handheld') &&
        Number.isFinite(handheldFps) &&
        handheldFps > 20 &&
        Number.isFinite(encoded)
      ) {
        const encodeFrozen =
          lastCameramanEncoded != null && encoded === lastCameramanEncoded
        const captureFrozen =
          lastCameramanCaptured != null && captured === lastCameramanCaptured
        if (encodeFrozen || captureFrozen) {
          cameramanEncodeStreak += 1
          if (cameramanEncodeStreak >= 2) {
            abortReason = encodeFrozen
              ? `cameraman encodedFrames frozen at ${encoded}`
              : `cameraman capturedFrames frozen at ${captured}`
            break
          }
        } else {
          cameramanEncodeStreak = 0
        }
      } else {
        cameramanEncodeStreak = 0
      }
      lastCameramanEncoded = Number.isFinite(encoded) ? encoded : lastCameramanEncoded
      lastCameramanCaptured = Number.isFinite(captured) ? captured : lastCameramanCaptured
      const kfAge = Number(health.streamKeyframeAge)
      if (options.stream && Number.isFinite(kfAge) && kfAge > 8) {
        keyframeAgeStreak += 1
        if (keyframeAgeStreak >= 2) {
          abortReason = `RTMP keyframe age ${kfAge}s`
          break
        }
      } else {
        keyframeAgeStreak = 0
      }
      const programAge = Number(health.programFrameAge)
      if (options.stream && Number.isFinite(programAge) && programAge > 30) {
        programFrameAgeStreak += 1
        if (programFrameAgeStreak >= 2) {
          abortReason = `program frames stopped reaching RTMP (${programAge}s)`
          break
        }
      } else {
        programFrameAgeStreak = 0
      }
      const resetCount = Number(health.streamEncoderResetCount)
      if (options.stream && Number.isFinite(resetCount)) {
        if (resetCount > lastEncoderResetCount) {
          encoderResetIncreaseTicks += 1
          lastEncoderResetCount = resetCount
          if (encoderResetIncreaseTicks > 3) {
            abortReason = `RTMP encoder reset loop (${resetCount})`
            break
          }
        } else {
          encoderResetIncreaseTicks = 0
        }
      }
      const newCrashes = crashSnapshot().filter(file => !crashesAtStart.has(file))
      if (newCrashes.length) {
        abortReason = `crash report ${newCrashes[0]}`
        break
      }
      const leak = memoryGuard.sample(
        Date.now(),
        Math.max(Number(health.physFootprintMB) || 0, Number(health.residentSizeMB) || 0)
      )
      if (leak) {
        abortReason = leak
        break
      }
      const cameramanLeak = cameramanMemoryGuard.sample(
        Date.now(),
        Math.max(Number(cam.physFootprintMB) || 0, Number(cam.residentSizeMB) || 0)
      )
      if (cameramanLeak) {
        abortReason = `cameraman ${cameramanLeak}`
        break
      }

      if (options.stream && (Date.now() - lastShot >= options.screenshotMs || lastShot === 0)) {
        const shot = path.join(shotDir, `${Date.now()}.jpg`)
        try {
          await grabPeerTubeFrame(shot)
          append(actionLog, `SHOT ${shot} program=${health.program} live=${health.live}`)
        } catch (error) {
          append(actionLog, `NOTE peertube screenshot failed: ${error.message}`)
        }
        lastShot = Date.now()
      }

      await applyScheduledFaults(
        (Date.now() - blockT0) / 1000,
        faults,
        cameramanHost,
        actionLog
      )

      const action = options.replay
        ? pickAction(map, lastProgram, options.cameras, true)
        : pickAction(map, lastProgram, options.cameras, false)
      if (action.kind === 'skip' || !action.path) {
        ticksSkip += 1
        append(actionLog, `SKIP ${action.label}`)
      } else {
        try {
          await directorSend(host, action.path)
          ticksOk += 1
          append(actionLog, `TAP ${action.label} ${action.path}`)
        } catch (error) {
          ticksSkip += 1
          append(actionLog, `SKIP ${action.label} ${error.message}`)
        }
      }

      const used = Date.now() - tickStarted
      if (stopRequested) {
        append(actionLog, `NOTE stopped by ${stopRequested}`)
        break
      }
      await sleep(Math.max(0, options.tickMs - used))
      }

      await restoreFaults(faults, cameramanHost, actionLog)
      const recordedSeconds = (Date.now() - blockT0) / 1000
      try {
        await directorSend(host, '/record?on=false')
        append(actionLog, `NOTE block ${block} record off after ${recordedSeconds.toFixed(1)}s`)
      } catch (error) {
        append(actionLog, `NOTE record off failed: ${error.message}`)
      }
      if (abortReason || stopRequested) break
      if (options.record) {
        try {
          await waitUntilIdle(host, actionLog)
          const exported = await exportLatestRecording(host, actionLog)
          const dest = path.join(exportDir, `block-${block}-rec-${exported.recordingID}`)
          const files = pullPreparedRecording(options.device, exported.recordingID, dest)
          const verified = verifyHourExports(files, recordedSeconds, faults, actionLog)
          hourResults.push({
            block,
            recordingID: exported.recordingID,
            dest,
            files: files.map(name => path.basename(name)),
            durations: verified.durations.map(row => ({
              name: row.name,
              duration: Number(row.duration.toFixed(3))
            })),
            spread: verified.spread,
            faults: faults.map(fault => ({
              kind: fault.kind,
              at: fault.at,
              duration: fault.duration,
              startedElapsed: fault.startedElapsed ?? null,
              endedElapsed: fault.endedElapsed ?? null
            }))
          })
          append(actionLog, `NOTE block ${block} verified`)
        } catch (error) {
          abortReason = `block ${block} export/verify: ${error.message}`
          append(actionLog, `ABORT ${abortReason}`)
          break
        }
      }
    }
  } finally {
    append(actionLog, abortReason ? `ABORT ${abortReason}` : 'NOTE loop finished')
    try {
      await directorSend(host, '/record?on=false')
      append(actionLog, 'NOTE record off')
    } catch (error) {
      append(actionLog, `NOTE record off failed: ${error.message}`)
    }
    stopLogs()
  }

  if (options.verify) {
    const env = { ...process.env, DIRECTOR_DEVICE_UDID: options.device }
    const scripts = []
    if (options.record) scripts.push('verifyArchives.js')
    if (options.stream) scripts.push('verifyProgram.js')
    for (const script of scripts) {
      try {
        execFileSync('node', [path.join(__dirname, script)], { env, stdio: 'inherit' })
        append(actionLog, `NOTE ${script} completed`)
      } catch (error) {
        append(actionLog, `NOTE ${script} failed: ${error.message}`)
      }
    }
  }

  const summary = {
    abortReason,
    ticksOk,
    ticksSkip,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    actionLog,
    healthLog,
    unifiedLog,
    shotDir,
    exportDir,
    hourResults,
    directorPid,
    cameramanPid
  }
  append(actionLog, `END ${JSON.stringify(summary)}`)
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  if (abortReason) process.exitCode = 1
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exit(1)
})
