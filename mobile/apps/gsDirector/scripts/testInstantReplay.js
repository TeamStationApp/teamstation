#!/usr/bin/env node
'use strict'

// Targeted instant-replay check over the control channel.
//
// Asserts a 5 / 7.5 / 10 s rewind: no "not ready" / failed banner, the tile stays
// `replaying` for the requested content duration, `off=` advances without a stall, then live.
//
//   DIRECTOR_DEVICE_UDID=<udid> node scripts/testInstantReplay.js --device <udid>
//
// Director must already be running with `-uiTest true`, recording, and at least one live camera
// with ~12 s of archive.

const fs = require('node:fs')
const path = require('node:path')
const deviceTarget = require('./deviceTarget')

const UDID_PATTERN =
  /^[0-9A-Fa-f]{8}-([0-9A-Fa-f]{16}|[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$/

function nowIso() {
  const date = new Date()
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')
  const mm = String(Math.abs(offset) % 60).padStart(2, '0')
  return `${date.toISOString().slice(0, 19)}${sign}${hh}:${mm}`
}

function parseArgs(argv) {
  const options = { seconds: [5, 7.5, 10], log: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    const next = argv[i + 1]
    if (value === '--device' && next) {
      options.device = next
      i += 1
    } else if (value === '--log' && next) {
      options.log = next
      i += 1
    } else if (value === '--seconds' && next) {
      options.seconds = next.split(',').map(Number)
      i += 1
    }
  }
  if (!options.device || !UDID_PATTERN.test(options.device)) {
    throw new Error('pass --device <udid>')
  }
  return options
}

function appendLog(file, line) {
  if (!file) return
  fs.appendFileSync(file, `${line}\n`)
}

async function dump(host) {
  return JSON.parse(await deviceTarget.get(host, '/dump-state'))
}

function isOffLimits(tile) {
  const name = (tile.displayName || tile.src || '').toLowerCase()
  return name.includes('010d2') || name.includes('1st') || /\bfirst\b/.test(name)
}

function liveTile(state) {
  const tiles = (state.tiles ?? []).filter(tile => !isOffLimits(tile))
  const mound = tiles.find(tile =>
    /mound/i.test(`${tile.displayName ?? ''} ${tile.src ?? ''}`)
  )
  if (mound && (mound.state === 'live' || mound.state === 'replaying')) {
    return mound
  }
  return (
    tiles.find(tile => tile.isProgram && tile.state !== 'empty') ??
    tiles.find(tile => tile.state === 'live' || tile.state === 'replaying')
  )
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function runOne(host, seconds, logFile) {
  const before = await dump(host)
  const tile = liveTile(before)
  if (!tile) throw new Error('no live tile')
  const source = tile.index + 1
  if (before.lastReplayError) {
    throw new Error(`lastReplayError already set: ${before.lastReplayError}`)
  }

  appendLog(logFile, `${nowIso()} START replay ${seconds}s source=${source}`)
  await deviceTarget.get(host, `/replay?source=${source}&seconds=${seconds}&speed=full`)

  const started = Date.now()
  const samples = []
  let sawReplay = false
  let returnedLive = false
  const deadline = started + (seconds + 8) * 1000
  let lastDisplayed = tile.displayedFrames ?? 0
  let lastDisplayedAt = started

  while (Date.now() < deadline) {
    await sleep(80)
    const state = await dump(host)
    const current = (state.tiles ?? []).find(entry => entry.index === tile.index)
    if (!current) throw new Error(`tile ${tile.index} missing`)
    const elapsed = (Date.now() - started) / 1000
    const displayed = current.displayedFrames ?? 0
    if (!sawReplay && current.state === 'live') {
      if (displayed > lastDisplayed) {
        lastDisplayed = displayed
        lastDisplayedAt = Date.now()
      } else if (Date.now() - lastDisplayedAt > 800) {
        throw new Error(
          `${seconds}s rewind paused live for ${((Date.now() - lastDisplayedAt) / 1000).toFixed(2)}s before first replay frame`
        )
      }
    }
    samples.push({
      elapsed,
      state: current.state,
      offset: current.offsetSeconds,
      displayed,
      error: state.lastReplayError,
      status: state.statusMessage
    })
    if (state.lastReplayError) {
      throw new Error(`lastReplayError=${state.lastReplayError}`)
    }
    const status = (state.statusMessage ?? '').toLowerCase()
    if (status.includes('not ready') || status.includes('replay failed')) {
      throw new Error(`statusMessage=${state.statusMessage}`)
    }
    if (current.state === 'replaying') {
      if (!sawReplay) {
        lastDisplayed = displayed
        lastDisplayedAt = Date.now()
      }
      sawReplay = true
      if (displayed > lastDisplayed) {
        lastDisplayed = displayed
        lastDisplayedAt = Date.now()
      } else if (Date.now() - lastDisplayedAt > 800) {
        throw new Error(
          `${seconds}s rewind stalled ${((Date.now() - lastDisplayedAt) / 1000).toFixed(2)}s after cutover`
        )
      }
    }
    if (sawReplay && current.state === 'live') {
      returnedLive = true
      break
    }
  }

  const replaying = samples.filter(sample => sample.state === 'replaying')
  if (!sawReplay) throw new Error(`${seconds}s rewind never entered replaying`)
  if (replaying.length < 3) throw new Error(`${seconds}s rewind had too few replaying samples`)

  const replayStart = replaying[0].elapsed
  const replayEnd = replaying[replaying.length - 1].elapsed
  const duration = replayEnd - replayStart
  if (replayStart > 2.0) {
    throw new Error(
      `${seconds}s rewind waited ${replayStart.toFixed(2)}s of live before the first decoded archive frame`
    )
  }
  if (duration > seconds + 1.5) {
    throw new Error(
      `${seconds}s rewind played ${duration.toFixed(2)}s of wall time (must be ≤ ${(seconds + 1.5).toFixed(1)}s)`
    )
  }
  const firstOff = replaying[0].offset
  const lastOff = replaying[replaying.length - 1].offset
  if (lastOff < firstOff + seconds - 1.5) {
    throw new Error(
      `${seconds}s rewind playhead only moved ${(lastOff - firstOff).toFixed(2)}s (${firstOff.toFixed(2)} → ${lastOff.toFixed(2)})`
    )
  }

  for (let i = 1; i < replaying.length; i += 1) {
    const gap = replaying[i].elapsed - replaying[i - 1].elapsed
    const offsetJump = replaying[i].offset - replaying[i - 1].offset
    if (gap > 0.8 && Math.abs(offsetJump) < 0.08) {
      throw new Error(
        `${seconds}s rewind paused: ${gap.toFixed(2)}s gap at t=${replaying[i].elapsed.toFixed(2)}`
      )
    }
    if (offsetJump - gap > 1.0) {
      throw new Error(
        `${seconds}s rewind jumped toward live by ${offsetJump.toFixed(2)}s ` +
          `at t=${replaying[i].elapsed.toFixed(2)} ` +
          `off ${replaying[i - 1].offset.toFixed(2)} → ${replaying[i].offset.toFixed(2)} ` +
          `wallGap=${gap.toFixed(2)} samples=${JSON.stringify(replaying.slice(Math.max(0, i - 2), i + 3))}`
      )
    }
  }

  if (!returnedLive) {
    throw new Error(`${seconds}s rewind did not return to live`)
  }

  appendLog(
    logFile,
    `${nowIso()} END replay ${seconds}s duration=${duration.toFixed(2)} samples=${replaying.length}`
  )
  return { seconds, duration, samples: replaying.length }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  process.env.DIRECTOR_DEVICE_UDID = options.device
  const logFile =
    options.log ||
    path.join(
      process.env.HOME,
      'agent-notes',
      `${nowIso().replace(/[:]/g, '').slice(0, 15).replace('T', '-')}-instantReplayHarness.log`
    )
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  appendLog(logFile, `RUN START ${nowIso()}`)
  appendLog(logFile, `${nowIso()} START resolve host ${options.device}`)

  const host = await deviceTarget.resolveHost(true)
  appendLog(logFile, `${nowIso()} END resolve host ${host}`)

  const state = await dump(host)
  if (!state.dvr?.isRecording) {
    throw new Error('Director is not recording — start Record so archive files exist')
  }
  const tile = liveTile(state)
  if (!tile) throw new Error('no live camera tile')

  const results = []
  for (const seconds of options.seconds) {
    results.push(await runOne(host, seconds, logFile))
    await sleep(1500)
  }
  appendLog(logFile, `${nowIso()} START wrap-up`)
  appendLog(
    logFile,
    `${nowIso()} END wrap-up ${results.map(item => `${item.seconds}s=${item.duration.toFixed(2)}`).join(' ')}`
  )
  process.stdout.write(
    `${results.map(item => `${item.seconds}s played ${item.duration.toFixed(2)}s`).join('\n')}\nlog ${logFile}\n`
  )
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exit(1)
})
