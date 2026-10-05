#!/usr/bin/env node
'use strict'

// Checks a file TS Distributor stitched: is its sound whole, and are its sound and picture the
// take's length and in step from the start?
//
//   node scripts/verifyStitched.js <file.mov> [--segments <folder> [--source <id>]]
//                                  [--length <seconds>] [--min-ms 0.5] [--list 20] [--json]
//
// It decodes the file's sound with ffmpeg and reports every run of exact digital zeros at least
// --min-ms long (0.5 ms by default), with its time. A camera's sound is rendered from archive
// segments, and a stretch the render had nothing for comes out as exact zeros, so a run of them is a
// hole the stitcher left -- or a stretch the camera really sent nothing for. Quiet sound from a real
// microphone is not exactly zero for half a millisecond.
//
// It reports the sound's and the picture's lengths, from the decoded samples and the picture
// stream, and where each starts on the file's timeline (edit lists applied, as ffmpeg reads them):
// the A/V start offset is the sound's start less the picture's.
//
// AVFoundation writes AAC with the encoder's priming -- 2,112 samples, 44 ms at 48 kHz -- inside the
// track's edit, and skips it by convention when it plays; ffmpeg plays it. So ffmpeg decodes such a
// track 2,112 samples longer than the picture and its sound 44 ms late. When the decoded sound is
// the picture's length plus exactly that, the report says so, gives the length and offset as
// AVFoundation plays them, and places the runs of zeros on that timeline.
//
// With --segments, the folder TS Distributor keeps a take's segments in (`index.sqlite` beside
// `Archives/`), every run is placed against the camera's segment joins. A join is where one segment
// of the camera's archive ends and the next begins; a segment's sound starts tens of milliseconds
// after its first picture, so a run from 50 ms before a join to 250 ms after it counts as at that
// join. A join where the archive itself has a gap -- the next segment starts more than 20 ms after
// the last one ended -- is reported as an archive gap, which the file is right to keep as silence;
// a run there may start as early as where the last segment ended.
// --source picks the camera when the index holds several; its default is the one whose name or id
// is the file name's suffix (`...-1st.mov` → `1st`), else the only one.
//
// --length is the take's length in seconds; with it the check also fails when the sound or picture
// differs from it by more than one picture.
//
// Exits 1 when a run of zeros sits at a join that is not an archive gap, or a length is off.

const { execFileSync, spawn } = require('node:child_process')
const { basename } = require('node:path')

// The encoder delay of Apple's AAC encoder, in samples.
const APPLE_AAC_PRIMING = 2112

function parseArgs(argv) {
  const args = { minMs: 0.5, list: 20, json: false }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--segments') args.segments = argv[++i]
    else if (arg === '--source') args.source = argv[++i]
    else if (arg === '--length') args.length = Number(argv[++i])
    else if (arg === '--min-ms') args.minMs = Number(argv[++i])
    else if (arg === '--list') args.list = Number(argv[++i])
    else if (arg === '--json') args.json = true
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
    else rest.push(arg)
  }
  if (rest.length !== 1) throw new Error('give one file')
  args.file = rest[0]
  return args
}

function probe(file) {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries',
      'stream=index,codec_type,codec_name,sample_rate,channels,start_time,duration,nb_frames,avg_frame_rate',
      '-of', 'json', file],
    { encoding: 'utf8', maxBuffer: 1 << 24 }
  )
  const { streams } = JSON.parse(out)
  return {
    video: streams.find((s) => s.codec_type === 'video'),
    audio: streams.find((s) => s.codec_type === 'audio')
  }
}

function rate(fraction) {
  const [n, d] = String(fraction ?? '0/1').split('/').map(Number)
  return d > 0 ? n / d : 0
}

// Every run of frames whose samples are all exactly zero, at least `minFrames` long, as
// [start frame, length in frames]; and how many frames were decoded.
function zeroRuns(file, channels, minFrames) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0',
      '-f', 's16le', '-acodec', 'pcm_s16le', '-'
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const runs = []
    let frame = 0
    let runStart = -1
    let carry = Buffer.alloc(0)
    let errors = ''
    const frameBytes = 2 * channels
    ffmpeg.stdout.on('data', (chunk) => {
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk
      const whole = data.length - (data.length % frameBytes)
      for (let offset = 0; offset < whole; offset += frameBytes) {
        let silent = true
        for (let c = 0; c < channels; c++) {
          if (data.readInt16LE(offset + 2 * c) !== 0) { silent = false; break }
        }
        if (silent) {
          if (runStart < 0) runStart = frame
        } else if (runStart >= 0) {
          if (frame - runStart >= minFrames) runs.push([runStart, frame - runStart])
          runStart = -1
        }
        frame++
      }
      carry = Buffer.from(data.subarray(whole))
    })
    ffmpeg.stderr.on('data', (d) => { errors += d })
    ffmpeg.on('error', reject)
    ffmpeg.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg failed: ${errors.trim()}`))
      if (runStart >= 0 && frame - runStart >= minFrames) runs.push([runStart, frame - runStart])
      resolve({ runs, frames: frame })
    })
  })
}

function sql(index, query) {
  const out = execFileSync('sqlite3', ['-separator', '|', `file:${index}?mode=ro&immutable=1`, query], {
    encoding: 'utf8',
    maxBuffer: 1 << 26
  })
  return out.split('\n').filter(Boolean).map((line) => line.split('|'))
}

// The camera's joins, in seconds from the start of the take: [{ at, gap }], `gap` the archive's own
// gap there in seconds (0 when the next segment starts where the last ended).
function joins(folder, file, wanted) {
  const index = `${folder}/index.sqlite`
  const [recording] = sql(index, 'select id, started_at from recordings order by id desc limit 1')
  if (recording == null) throw new Error(`no recording in ${index}`)
  const [id, startedAt] = [recording[0], Number(recording[1])]
  const sources = sql(index, `select distinct source_id from segments where recording_id = ${id}`).map((r) => r[0])
  const named = sql(index, `select * from sqlite_master where name = 'recording_sources'`).length
    ? sql(index, `select * from recording_sources where recording_id = ${id}`)
    : []
  const suffix = basename(file).replace(/\.[^.]*$/, '').split('-').pop()
  let source = wanted
  if (source == null) {
    const byName = named.find((row) => row.includes(suffix))
    source = byName ? sources.find((s) => byName.includes(s)) : null
    if (source == null && sources.includes(suffix)) source = suffix
    if (source == null && sources.length === 1) source = sources[0]
  } else {
    const byName = named.find((row) => row.includes(source))
    if (!sources.includes(source) && byName) source = sources.find((s) => byName.includes(s)) ?? source
  }
  if (source == null || !sources.includes(source)) {
    throw new Error(`pick a camera with --source: ${sources.join(', ')}`)
  }
  const rows = sql(
    index,
    `select start_wall, duration from segments where recording_id = ${id} and source_id = '${source.replace(/'/g, "''")}' and is_initialization = 0 order by start_wall`
  ).map(([start, duration]) => [Number(start), Number(duration)])
  const result = []
  for (let i = 1; i < rows.length; i++) {
    const [lastStart, lastDuration] = rows[i - 1]
    const gap = rows[i][0] - (lastStart + lastDuration)
    result.push({ at: rows[i][0] - startedAt, gap: gap > 0.02 ? gap : 0 })
  }
  return { source, joins: result }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { video, audio } = probe(args.file)
  if (audio == null) throw new Error('no sound track')
  const sampleRate = Number(audio.sample_rate)
  const channels = Number(audio.channels) || 1
  const minFrames = Math.max(1, Math.round((args.minMs / 1000) * sampleRate))
  const { runs, frames } = await zeroRuns(args.file, channels, minFrames)
  const pictureStart = video ? Number(video.start_time) || 0 : null
  const fps = video ? rate(video.avg_frame_rate) : 0
  const decoded = frames / sampleRate
  // The priming ffmpeg plays and AVFoundation skips, when the lengths say it is there.
  const appleAac = audio.codec_name === 'aac' && video != null &&
    Math.abs(decoded - Number(video.duration) - APPLE_AAC_PRIMING / sampleRate) < 0.001
  const priming = appleAac ? APPLE_AAC_PRIMING / sampleRate : 0
  const soundStart = Number(audio.start_time) || 0
  const report = {
    file: args.file,
    sound: {
      start: soundStart,
      length: decoded - priming,
      decodedByFfmpeg: decoded,
      unskippedPrimingMs: Math.round(priming * 1e6) / 1e3,
      sampleRate,
      channels
    },
    picture: video
      ? { start: pictureStart, length: Number(video.duration), frames: Number(video.nb_frames), fps }
      : null,
    avStartOffsetMs: video ? Math.round((soundStart - pictureStart) * 1e6) / 1e3 : null,
    ffmpegAvStartOffsetMs: video ? Math.round((soundStart + priming - pictureStart) * 1e6) / 1e3 : null,
    // On the timeline the sound plays on, so a run inside the priming starts at the sound's start.
    zeroRuns: runs.map(([start, length]) => {
      const from = Math.max(0, start / sampleRate - priming)
      const to = (start + length) / sampleRate - priming
      return { at: Math.round((soundStart + from) * 1e4) / 1e4, ms: Math.round((to - from) * 1e5) / 1e2 }
    }).filter((run) => run.ms >= args.minMs),
    failures: []
  }
  if (args.segments != null) {
    const { source, joins: list } = joins(args.segments, args.file, args.source)
    const sorted = list.map((j) => j.at)
    let atJoin = 0
    let atGap = 0
    for (const run of report.zeroRuns) {
      // The last join at or before the run's latest possible start.
      let lo = 0
      let hi = sorted.length - 1
      let found = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (sorted[mid] <= run.at + 0.05) { found = mid; lo = mid + 1 } else hi = mid - 1
      }
      // A gap in the archive is silent from where the last segment ended, its length before the
      // next one starts.
      const next = list[found + 1]
      if (next != null && next.gap > 0 && next.at - next.gap - 0.05 <= run.at) found++
      if (found >= 0 && run.at - sorted[found] <= 0.25) {
        const join = list[found]
        run.join = Math.round(join.at * 1e4) / 1e4
        if (join.gap > 0) {
          run.archiveGapMs = Math.round(join.gap * 1e5) / 1e2
          atGap++
        } else {
          atJoin++
        }
      }
    }
    report.segments = {
      source,
      joins: list.length,
      archiveGaps: list.filter((j) => j.gap > 0).length,
      runsAtJoins: atJoin,
      runsAtArchiveGaps: atGap
    }
    if (atJoin > 0) report.failures.push(`${atJoin} runs of zeros at segment joins`)
  }
  if (args.length != null && Number.isFinite(args.length)) {
    const frame = fps > 0 ? 1 / fps : 1 / 30
    if (Math.abs(report.sound.length - args.length) > frame) {
      report.failures.push(`sound is ${report.sound.length.toFixed(3)} s, the take ${args.length} s`)
    }
    if (report.picture && Math.abs(report.picture.length - args.length) > frame) {
      report.failures.push(`picture is ${report.picture.length.toFixed(3)} s, the take ${args.length} s`)
    }
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    const s = report.sound
    console.log(`${args.file}`)
    console.log(`  sound   ${s.length.toFixed(3)} s from ${s.start.toFixed(4)} s, ${s.sampleRate} Hz x${s.channels}`)
    if (s.unskippedPrimingMs > 0) {
      console.log(`          (ffmpeg decodes ${s.decodedByFfmpeg.toFixed(3)} s: it plays the ${s.unskippedPrimingMs} ms AAC priming AVFoundation skips)`)
    }
    if (report.picture) {
      const p = report.picture
      console.log(`  picture ${p.length.toFixed(3)} s from ${p.start.toFixed(4)} s, ${p.frames} frames at ${p.fps.toFixed(3)} fps`)
      console.log(`  A/V start offset ${report.avStartOffsetMs} ms` +
        (priming > 0 ? ` (${report.ffmpegAvStartOffsetMs} ms as ffmpeg plays it)` : ''))
    }
    console.log(`  zero runs >= ${args.minMs} ms: ${report.zeroRuns.length}`)
    for (const run of report.zeroRuns.slice(0, args.list)) {
      const where = run.archiveGapMs != null
        ? ` archive gap of ${run.archiveGapMs} ms at join ${run.join} s`
        : run.join != null ? ` at join ${run.join} s` : ''
      console.log(`    ${run.at.toFixed(4)} s  ${run.ms} ms${where}`)
    }
    if (report.segments) {
      const g = report.segments
      console.log(`  camera ${g.source}: ${g.joins} joins, ${g.archiveGaps} archive gaps; runs at joins ${g.runsAtJoins}, at archive gaps ${g.runsAtArchiveGaps}`)
    }
    console.log(report.failures.length ? `  FAIL: ${report.failures.join('; ')}` : '  OK')
  }
  process.exitCode = report.failures.length ? 1 : 0
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 2
})
