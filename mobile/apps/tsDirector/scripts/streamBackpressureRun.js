#!/usr/bin/env node
'use strict'

// Measures what a stalled RTMP uplink does to Director's memory, across a mixed camera fleet.
//
// The 2026-09-05 crash was invisible in telemetry: the backlog grew at the stream bitrate while
// the dropped-packet counter sat at zero, because the cap was compared against a queue that is
// always empty while a send is blocked. This samples the three numbers that separate the two
// worlds — `physFootprintMB`, `streamQueuedBytes`, `streamDroppedPackets` — and reports the
// footprint slope in MB/min, which is the number the fix has to flatten.
//
//   node scripts/streamBackpressureRun.js --device <ipad-udid> \
//     --ios <iphone-udid> --ios <iphone-udid> --android <pixel-serial> \
//     --seconds 1800 --label after-fix
//
// Cameramen are optional: pass none to measure the Director alone. Read-only over the control
// channel — it starts and stops nothing, so an operator or another script can drive the rig.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const deviceTarget = require('./deviceTarget')

const CAMERAMAN_PORT = Number(process.env.CAMERAMAN_CONTROL_PORT ?? 8766)

function parseArgs(argv) {
  const options = {
    seconds: 1800,
    intervalMs: 10000,
    label: 'run',
    ios: [],
    android: []
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const next = argv[i + 1]
    if (flag === '--device' && next) { options.device = next; i += 1 }
    else if (flag === '--ios' && next) { options.ios.push(next); i += 1 }
    else if (flag === '--android' && next) { options.android.push(next); i += 1 }
    else if (flag === '--seconds' && next) { options.seconds = Number(next); i += 1 }
    else if (flag === '--interval' && next) { options.intervalMs = Number(next) * 1000; i += 1 }
    else if (flag === '--label' && next) { options.label = next; i += 1 }
    else if (flag.startsWith('--')) throw new Error(`unknown flag ${flag}`)
  }
  if (!options.device) throw new Error('pass --device <director-udid>')
  return options
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function pick(source, ...names) {
  for (const name of names) {
    if (source && source[name] !== undefined && source[name] !== null) return source[name]
  }
  return null
}

// ---- cameramen ----

async function iosHost(udid) {
  const devices = deviceTarget.pairedDevices()
  const device = devices.find(entry => entry.hardwareProperties.udid === udid)
  if (!device) throw new Error(`iPhone ${udid} is not paired`)
  const hosts = new Set()
  const slug = (device.deviceProperties.name ?? '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (slug) hosts.add(`${slug}.local`)
  for (const host of device.connectionProperties.potentialHostnames ?? []) hosts.add(host)
  for (const host of hosts) {
    try {
      const response = await fetch(`http://${host}:${CAMERAMAN_PORT}/dump-state`, {
        signal: AbortSignal.timeout(3000)
      })
      if (response.ok) return `http://${host}:${CAMERAMAN_PORT}`
    } catch { continue }
  }
  throw new Error(`no Cameraman on ${udid} answered ${CAMERAMAN_PORT} — launched with -uiTest true?`)
}

// adb port-forwarding avoids depending on the phone's LAN address, which changes with the network.
function androidHost(serial, localPort) {
  execFileSync('adb', [ '-s', serial, 'forward', `tcp:${localPort}`, `tcp:${CAMERAMAN_PORT}` ], {
    stdio: [ 'ignore', 'ignore', 'pipe' ]
  })
  return `http://127.0.0.1:${localPort}`
}

async function dump(base) {
  const response = await fetch(`${base}/dump-state`, { signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw new Error(`dump-state ${response.status}`)
  return JSON.parse(await response.text())
}

// ---- reporting ----

/// Least-squares slope in MB per minute. A mean of per-sample deltas is dominated by the noisiest
/// pair; the regression uses every sample, which is what makes "flat" a defensible claim.
function slopePerMinute(samples) {
  const usable = samples.filter(s => Number.isFinite(s.footprint))
  if (usable.length < 3) return null
  const t0 = usable[0].at
  const xs = usable.map(s => (s.at - t0) / 60000)
  const ys = usable.map(s => s.footprint)
  const n = xs.length
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - meanX) * (ys[i] - meanY)
    den += (xs[i] - meanX) ** 2
  }
  return den === 0 ? null : num / den
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  process.env.DIRECTOR_DEVICE_UDID = options.device

  const directorHost = await deviceTarget.resolveHost(true)
  const directorBase = `http://${directorHost}:${deviceTarget.PORT}`
  process.stdout.write(`director ${directorBase}\n`)

  const cameramen = []
  for (const udid of options.ios) {
    try {
      cameramen.push({ name: udid.slice(-6), kind: 'ios', base: await iosHost(udid) })
    } catch (error) {
      process.stdout.write(`WARN ios ${udid}: ${error.message}\n`)
    }
  }
  let port = 8790
  for (const serial of options.android) {
    try {
      cameramen.push({ name: serial.slice(-6), kind: 'android', base: androidHost(serial, port) })
      port += 1
    } catch (error) {
      process.stdout.write(`WARN android ${serial}: ${error.message}\n`)
    }
  }
  for (const camera of cameramen) process.stdout.write(`cameraman ${camera.kind} ${camera.name} ${camera.base}\n`)

  const outPath = path.join(
    os.homedir(),
    '.cursor',
    'logs',
    `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-backpressure-${options.label}.csv`
  )
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  const columns = [
    'iso', 'elapsedSec', 'physFootprintMB', 'residentSizeMB', 'streamQueuedBytes',
    'streamDroppedPackets', 'streamMbps', 'isStreaming', 'isRecording',
    ...cameramen.map(c => `cam_${c.name}_MB`)
  ]
  fs.writeFileSync(outPath, `${columns.join(',')}\n`)
  process.stdout.write(`csv ${outPath}\n\n`)

  const started = Date.now()
  const samples = []
  let firstDrops = null

  while ((Date.now() - started) / 1000 < options.seconds) {
    const at = Date.now()
    let state
    try {
      state = await dump(directorBase)
    } catch (error) {
      process.stdout.write(`${new Date().toISOString()} director dump failed: ${error.message}\n`)
      await sleep(options.intervalMs)
      continue
    }

    const footprint = Number(pick(state, 'physFootprintMB'))
    const queued = Number(pick(state, 'streamQueuedBytes') ?? 0)
    const drops = Number(pick(state, 'streamDroppedPackets') ?? 0)
    const mbps = Number(pick(state, 'streamMegabitsPerSecond', 'streamMbps') ?? 0)
    const streaming = pick(state, 'isStreaming', 'streaming') === true
    const recording = pick(state, 'isRecording') === true || pick(state.dvr ?? {}, 'isRecording') === true
    if (firstDrops === null) firstDrops = drops

    const camMB = []
    for (const camera of cameramen) {
      try {
        const camState = await dump(camera.base)
        camMB.push(Number(pick(camState, 'physFootprintMB') ?? NaN))
      } catch {
        camMB.push(NaN)
      }
    }

    const elapsed = Math.round((at - started) / 1000)
    samples.push({ at, footprint, queued, drops })
    fs.appendFileSync(outPath, [
      new Date(at).toISOString(), elapsed, footprint, Number(pick(state, 'residentSizeMB') ?? 0),
      queued, drops, mbps.toFixed(2), streaming, recording, ...camMB
    ].join(',') + '\n')

    process.stdout.write(
      `${String(elapsed).padStart(5)}s mem=${String(footprint).padStart(5)}MB ` +
      `queued=${String(queued).padStart(8)} drops=${String(drops).padStart(6)} ` +
      `${mbps.toFixed(2)}Mbps stream=${streaming ? 'on' : 'OFF'} rec=${recording ? 'on' : 'OFF'}` +
      (camMB.length ? ` cams=${camMB.map(v => (Number.isFinite(v) ? `${v}MB` : '?')).join(' ')}` : '') +
      '\n'
    )
    await sleep(options.intervalMs)
  }

  const slope = slopePerMinute(samples)
  const lastDrops = samples.length ? samples[samples.length - 1].drops : 0
  const peakQueued = samples.reduce((max, s) => Math.max(max, s.queued), 0)
  process.stdout.write('\n--- summary ---\n')
  process.stdout.write(`samples          ${samples.length}\n`)
  process.stdout.write(`footprint slope  ${slope === null ? 'n/a' : `${slope.toFixed(1)} MB/min`}\n`)
  process.stdout.write(`dropped packets  ${firstDrops} -> ${lastDrops}\n`)
  process.stdout.write(`peak queuedBytes ${peakQueued}\n`)
  process.stdout.write(`csv              ${outPath}\n`)
  // The two worlds, stated as the run sees them.
  if (slope !== null && slope > 20 && lastDrops === firstDrops) {
    process.stdout.write('VERDICT growing with nothing shed — this is the pre-fix signature\n')
  } else if (slope !== null && Math.abs(slope) <= 20 && lastDrops > firstDrops) {
    process.stdout.write('VERDICT shedding and flat — this is what the fix should look like\n')
  } else {
    process.stdout.write('VERDICT inconclusive: no stall reached, or the stream was not live\n')
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exit(1)
})
