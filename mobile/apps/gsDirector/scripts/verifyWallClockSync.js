#!/usr/bin/env node
// Judges an exported GS Director file against the wall clock its live fixture cameras show and sound.
//
// The fixture cameras (`makeRtspFixtures.js --live`) draw the Unix time each frame was generated as
// 32 binary cells, and beep on every whole wall-clock second. `tools/wallClockSync` reads both back
// out of a file with AVFoundation; this decides whether what it read is right:
//
//   length     the file lasts the take, start to stop
//   pace       its picture runs at wall speed — every sample outside a hole shows the same offset
//              from the take's clock, so nothing drifts, jumps or closes up
//   holes      where the app was away, the picture holds one frame
//   sync       every beep lands where the picture says the whole second is
//   rhythm     beeps come a second apart, so the sound runs at wall speed too
//
//   node scripts/verifyWallClockSync.js <file> --take-start <unix s> --take-end <unix s>
//        [--holes 27.1-35.6,90-95] [--every 2] [--json]
//
// Exit status 0 when every check passes. Used by `testResumeAfterCrash.js` on each export.

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SOURCE = path.join(ROOT, 'tools', 'wallClockSync', 'wallClockSync.swift')
const BINARY = path.join(ROOT, 'DerivedData', 'tools', 'wallClockSync')

/// Tolerances, in milliseconds unless stated. Sync matches `docs/sync-test-plan.md`: pass within
/// 40 ms, fail past 100 ms, one frame interval of slack for where a probe lands within a frame.
const LIMITS = {
  lengthSeconds: 0.1,
  paceSpreadMs: 100,
  absoluteOffsetMs: 1000,
  syncPassMs: 40,
  syncFailMs: 100,
  rhythmMs: 40,
  holeMarginSeconds: 0.75
}

function usage() {
  return `Usage: node scripts/verifyWallClockSync.js <file> --take-start <unix s> --take-end <unix s>
  --holes a-b,c-d   seconds into the file where the app was away (default none)
  --every N         seconds between picture probes (default 2)
  --settle N        also judge pace and sync leaving out N seconds after each hole, and say so
  --json            print the full report as JSON
`
}

function parseArgs(argv) {
  const options = { holes: [], every: 2, json: false, settleSeconds: 0 }
  const rest = [...argv]
  options.file = rest.shift()
  while (rest.length > 0) {
    const flag = rest.shift()
    if (flag === '--take-start') options.takeStart = Number(rest.shift())
    else if (flag === '--take-end') options.takeEnd = Number(rest.shift())
    else if (flag === '--every') options.every = Number(rest.shift())
    else if (flag === '--settle') options.settleSeconds = Number(rest.shift())
    else if (flag === '--json') options.json = true
    else if (flag === '--holes') {
      options.holes = (rest.shift() || '').split(',').filter(Boolean).map(span => {
        const [from, to] = span.split('-').map(Number)
        return { from, to }
      })
    } else if (flag === '--help' || flag === '-h') {
      process.stdout.write(usage())
      process.exit(0)
    } else {
      throw new Error(`unknown argument ${flag}\n${usage()}`)
    }
  }
  if (!options.file || !Number.isFinite(options.takeStart) || !Number.isFinite(options.takeEnd)) {
    throw new Error(usage())
  }
  return options
}

/// Builds the reader if it is missing or older than its source.
function ensureBinary() {
  const stale = !fs.existsSync(BINARY)
    || fs.statSync(BINARY).mtimeMs < fs.statSync(SOURCE).mtimeMs
  if (!stale) return BINARY
  fs.mkdirSync(path.dirname(BINARY), { recursive: true })
  const sdk = spawnSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).stdout.trim()
  const build = spawnSync('xcrun', ['swiftc', '-O', '-sdk', sdk, '-o', BINARY, SOURCE], { encoding: 'utf8' })
  if (build.status !== 0) throw new Error(`could not build wallClockSync\n${build.stderr}`)
  return BINARY
}

function read(file, every) {
  const result = spawnSync(ensureBinary(), [file, '--every', String(every)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.status !== 0) throw new Error(`wallClockSync failed on ${file}\n${result.stderr}`)
  const report = JSON.parse(result.stdout)
  if (report.error) throw new Error(`wallClockSync: ${report.error}`)
  return report
}

/// The marker carries milliseconds mod 2^32. Signed difference from what the take's clock expects.
function wrappedDifference(marker, expectedMs) {
  const modulus = 4_294_967_296
  let difference = (marker - (expectedMs % modulus)) % modulus
  if (difference >= modulus / 2) difference -= modulus
  if (difference < -modulus / 2) difference += modulus
  return difference
}

function inHole(seconds, holes, margin = 0, settle = 0) {
  return holes.some(hole => seconds >= hole.from - margin && seconds <= hole.to + margin + settle)
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))]
}

function judge(report, options) {
  const takeSeconds = options.takeEnd - options.takeStart
  const takeStartMs = options.takeStart * 1000
  const margin = LIMITS.holeMarginSeconds
  const checks = []
  const add = (name, pass, detail, measured) => checks.push({ name, pass, detail, measured })

  // Length: the file is the take, not the footage.
  const lengthError = report.duration - takeSeconds
  add('length', Math.abs(lengthError) <= LIMITS.lengthSeconds,
    `${report.duration.toFixed(3)} s against a ${takeSeconds.toFixed(3)} s take (${lengthError >= 0 ? '+' : ''}${(lengthError * 1000).toFixed(0)} ms)`,
    { durationSeconds: report.duration, takeSeconds, errorMs: lengthError * 1000 })
  add('tracks', report.audioTracks === 1 && Math.abs(report.audioSeconds - report.videoSeconds) <= 0.5,
    `video ${report.videoSeconds.toFixed(3)} s, audio ${report.audioSeconds.toFixed(3)} s on ${report.audioTracks} track(s)`,
    { videoSeconds: report.videoSeconds, audioSeconds: report.audioSeconds, audioTracks: report.audioTracks })

  // Pace and sync, judged twice when asked: strictly, and again leaving out the first seconds after
  // each hole. A camera that reconnects is placed by arrival until its sender reports settle, so the
  // strict pass says whether that happened and the settled one whether everything else is right.
  const passes = [{ suffix: '', settle: 0 }]
  if (options.settleSeconds > 0) passes.push({ suffix: ' (settled)', settle: options.settleSeconds })
  for (const { suffix, settle } of passes) {
    const live = report.samples.filter(sample => sample.marker !== null && !inHole(sample.t, options.holes, margin, settle))
    const offsets = live.map(sample => wrappedDifference(sample.marker, takeStartMs + sample.pts * 1000))
    const offset = median(offsets)
    const spread = offsets.length ? percentile(offsets, 95) - percentile(offsets, 5) : null
    const unreadable = report.samples.filter(sample => sample.marker === null && !inHole(sample.t, options.holes, margin, settle))
    add(`pace${suffix}`, offsets.length >= 3 && spread <= LIMITS.paceSpreadMs,
      offsets.length
        ? `${offsets.length} samples, picture ${offset >= 0 ? '+' : ''}${offset.toFixed(0)} ms from the take's clock, spread ${spread.toFixed(0)} ms (5th–95th)`
        : 'no readable picture outside the holes',
      { samples: offsets.length, offsetMs: offset, spreadMs: spread, unreadableOutsideHoles: unreadable.length })
    if (!suffix) {
      add('placement', offset !== null && Math.abs(offset) <= LIMITS.absoluteOffsetMs,
        offset !== null ? `picture sits ${offset.toFixed(0)} ms from where the take's clock puts it` : 'nothing to place',
        { offsetMs: offset })
    }
    const beeps = report.beeps.filter(beep => beep.marker !== null && !inHole(beep.t, options.holes, margin, settle))
    const sync = beeps.map(beep => {
      const pictureMs = beep.marker + (beep.t - beep.pts) * 1000
      return ((pictureMs % 1000) + 1500) % 1000 - 500
    })
    const syncMedian = median(sync)
    const worst = sync.length ? Math.max(...sync.map(Math.abs)) : null
    add(`sync${suffix}`, sync.length >= 3 && Math.abs(syncMedian) <= LIMITS.syncPassMs && worst <= LIMITS.syncFailMs,
      sync.length
        ? `${sync.length} beeps, sound ${syncMedian >= 0 ? 'after' : 'before'} picture by ${Math.abs(syncMedian).toFixed(1)} ms median, worst ${worst.toFixed(1)} ms`
        : 'no beeps with a readable picture outside the holes',
      { beeps: sync.length, medianMs: syncMedian, worstMs: worst })
  }

  // Holes: one picture held from edge to edge.
  for (const hole of options.holes) {
    const inside = report.samples.filter(sample => sample.t > hole.from + margin && sample.t < hole.to - margin)
    const values = new Set(inside.map(sample => sample.marker))
    const held = inside.length > 0 && values.size === 1 && !values.has(null)
    add(`hole ${hole.from.toFixed(1)}–${hole.to.toFixed(1)} s`, inside.length === 0 || held,
      inside.length === 0 ? 'too short to probe' : held ? `${inside.length} probes, one frame held` : `${values.size} different pictures inside`,
      { probes: inside.length, distinct: values.size })
  }

  // Rhythm: consecutive beeps within one live stretch are a second apart. Settled like pace and sync:
  // a camera whose sound was placed by arrival before its sender reports settled jumps back into
  // line once they do, and that jump is one bad interval at the start of the stretch.
  for (const { suffix, settle } of passes) {
    const gaps = []
    for (let index = 1; index < report.beeps.length; index += 1) {
      const previous = report.beeps[index - 1].t
      const current = report.beeps[index].t
      const between = options.holes.some(hole => previous < hole.to + margin + settle && current > hole.from - margin)
      if (!between && current - previous < 1.5) gaps.push((current - previous - 1) * 1000)
    }
    const worstGap = gaps.length ? Math.max(...gaps.map(Math.abs)) : null
    add(`rhythm${suffix}`, gaps.length >= 3 && worstGap <= LIMITS.rhythmMs,
      gaps.length ? `${gaps.length} intervals, worst ${worstGap.toFixed(1)} ms off a second` : 'too few consecutive beeps',
      { intervals: gaps.length, worstMs: worstGap })
  }

  return { file: report.file, takeSeconds, checks, pass: checks.every(check => check.pass) }
}

function verify(file, options) {
  return judge(read(file, options.every ?? 2), { holes: [], ...options, file })
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const verdict = verify(options.file, options)
  if (options.json) {
    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`)
  } else {
    process.stdout.write(`${path.basename(verdict.file)}\n`)
    for (const check of verdict.checks) {
      process.stdout.write(`  ${check.pass ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}\n`)
    }
  }
  process.exitCode = verdict.pass ? 0 : 1
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(2)
  }
}

module.exports = { verify, judge, LIMITS }
