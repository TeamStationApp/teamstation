#!/usr/bin/env node
'use strict'

// Four-hour Director + Cameraman stress loop.
//
// Maestro (`rtsp-four-cameras`) must already have launched Director with local-network
// access. This script enables first/third/mound/handheld, starts directing, turns RECORD
// and STREAM on (ingest URL from Settings), then every 30s cuts or instant-replays over
// the control channel. A PeerTube frame is grabbed about every 3 minutes.
//
//   node scripts/stressFourHour.js --device <director-udid> --cameraman-device <iphone-udid>
//   node scripts/stressFourHour.js --device <udid> --cameraman-device <udid> --seconds 120

const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const deviceTarget = require('./deviceTarget')

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
  'https://tube.gamestation.co/api/v1/videos/demoVideoId0000000000'
const PEERTUBE_WATCH =
  'https://tube.gamestation.co/w/demoVideoId0000000000'
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
      dropped: pick(tile, 'droppedFrames', 'droppedFrames')
    }
  }
  return map
}

function namedLiveCount(map, names = CAMERA_NAMES) {
  return names.filter(name => map[name]?.live).length
}

async function directorGet(host, target) {
  return JSON.parse(await get(host, target))
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
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000)
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`cameraman ${target} -> ${response.status} ${text}`)
      return JSON.parse(text)
    } catch (error) {
      lastError = error
      if (attempt < 3) await sleep(1000)
    }
  }
  throw lastError
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
    `START device=${options.device} cameraman=${options.cameramanDevice} seconds=${options.seconds} record=${options.record} stream=${options.stream} replay=${options.replay} cameras=${options.cameras.join(',')}`
  )
  append(actionLog, `NOTE peertube ${options.peertubeUrl}`)

  const host = await resolveHost(true)
  const cameramanHost = await resolveCameramanHost(options.cameramanDevice)
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
  // One camera: require it live. Four cameras: two overlapping replays can drop
  // live to 2, which is still a healthy session.
  const minLive = wanted === 1 ? 1 : 2
  if (namedLiveCount(map, options.cameras) < wanted) {
    await directorSend(host, '/start')
  }
  await waitFor(`${wanted} live named cameras`, 90000, async () => {
    state = await directorGet(host, '/dump-state')
    map = cameraMap(state)
    return namedLiveCount(map, options.cameras) === wanted
  })

  if (options.record) await directorSend(host, '/record?on=true')
  else await directorSend(host, '/record?on=false')
  if (options.stream) await directorSend(host, '/stream?on=true')
  else await directorSend(host, '/stream?on=false')
  await waitFor('record/stream mode', 30000, async () => {
    state = await directorGet(host, '/dump-state')
    map = cameraMap(state)
    const recording = pick(state.dvr, 'isRecording', 'recording') === true
    const streaming = pick(state, 'isStreaming', 'streaming') === true
    if (options.record && !recording) return false
    if (!options.record && recording) return false
    if (options.stream && !streaming) return false
    if (!options.stream && streaming) return false
    if (options.record && !options.cameras.every(name => map[name]?.archiving)) return false
    return true
  })
  append(
    actionLog,
    `NOTE record=${options.record} stream=${options.stream} cameras=${options.cameras.join(',')}`
  )

  const t0 = Date.now()
  let lastShot = 0
  let ticksOk = 0
  let ticksSkip = 0
  let cameramanZeroStreak = 0
  let keyframeAgeStreak = 0
  let abortReason = null
  let lastProgram = (state.programSource ?? 0) + 1

  try {
    while (Date.now() - t0 < options.seconds * 1000) {
      if (stopRequested) {
        append(actionLog, `NOTE stopped by ${stopRequested}`)
        break
      }
      const tickStarted = Date.now()
      try {
        state = await directorGet(host, '/dump-state')
      } catch (error) {
        abortReason = `director dump-state failed: ${error.message}`
        break
      }
      map = cameraMap(state)
      lastProgram = (state.programSource ?? 0) + 1
      await enforceCameras(host, state, options.cameras, actionLog)
      state = await directorGet(host, '/dump-state')
      map = cameraMap(state)

      const health = {
        recording: pick(state.dvr, 'isRecording', 'recording') === true,
        streaming: pick(state, 'isStreaming', 'streaming') === true,
        live: namedLiveCount(map, options.cameras),
        thermal: pick(state, 'thermalState', 'thermal'),
        memoryMB: pick(state, 'availableMemoryMB', 'memoryMB'),
        physFootprintMB: pick(state, 'physFootprintMB'),
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
        program: lastProgram,
        fps: Object.fromEntries(CAMERA_NAMES.map(name => [name, map[name]?.fps ?? null])),
        dropped: Object.fromEntries(CAMERA_NAMES.map(name => [name, map[name]?.dropped ?? null]))
      }

      let cameraman
      try {
        cameraman = await cameramanGet(cameramanHost, '/dump-state')
      } catch (error) {
        abortReason = `cameraman dump-state failed: ${error.message}`
        append(healthLog, `ABORT ${abortReason}`)
        break
      }
      const clients = cameraman.server?.clientCount ?? cameraman.clientCount ?? 0
      health.cameramanRunning = cameraman.isRunning === true
      health.cameramanClients = clients
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
      if (health.live < minLive) {
        abortReason = `only ${health.live} named cameras live`
        break
      }
      if (options.cameras.includes('handheld') && clients < 1) {
        cameramanZeroStreak += 1
        if (cameramanZeroStreak >= 2) {
          abortReason = 'cameraman clients stayed 0 (lost handheld)'
          break
        }
      } else {
        cameramanZeroStreak = 0
      }
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
      const newCrashes = crashSnapshot().filter(file => !crashesAtStart.has(file))
      if (newCrashes.length) {
        abortReason = `crash report ${newCrashes[0]}`
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
