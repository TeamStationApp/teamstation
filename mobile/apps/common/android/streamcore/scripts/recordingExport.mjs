#!/usr/bin/env node
// Scenario E7: the Kotlin recording path, recorded, interrupted, resumed, exported, and checked.
//
//   node mobile/apps/common/android/streamcore/scripts/recordingExport.mjs [--log <file>]
//
// It makes a 1920x1080 HEVC clip, a tone and a run of silence with ffmpeg, then runs
// `RecordingExportTest` (Gradle, in tsCameramanAndroid). The test records 30 s with jittered capture
// times, kills the take, resumes it 10 s later as part 2, records 30 s more, stops and exports. This
// script then reads the export with ffprobe and expects:
//
//   - one HEVC track and one AAC track
//   - video and audio each spanning the 70 s of wall clock, within one frame
//   - the hole held as one picture, with every AAC packet in it the silent packet
//   - ffmpeg decoding the whole export without an error
//
// Every command and what it printed goes to the log, each command on a `$` line. Needs ffmpeg and
// ffprobe on PATH.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const streamcore = resolve(here, '..')
const cameraman = resolve(streamcore, '../../../tsCameramanAndroid')
const work = join(streamcore, 'build/recordingExport')

const options = { log: join(work, 'kotlin-recording.log') }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--log') options.log = resolve(argv[++i])
  else throw new Error(`unknown argument ${argv[i]}`)
}
mkdirSync(work, { recursive: true })
mkdirSync(dirname(options.log), { recursive: true })
writeFileSync(options.log, '')

function log(text) {
  process.stdout.write(`${text}\n`)
  appendFileSync(options.log, `${text}\n`)
}

function run(command, args, { cwd = work, env = {}, show = 40 } = {}) {
  log(`$ ${[command, ...args].join(' ')}`)
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 256 << 20 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const lines = output.split('\n').filter(line => line.trim() !== '' && !line.startsWith('w: '))
  for (const line of lines.slice(0, show)) log(`  ${line}`)
  if (lines.length > show) log(`  … ${lines.length - show} more lines`)
  return { status: result.status, output: result.stdout ?? '' }
}

const failures = []
function expect(ok, what) {
  log(`  ${ok ? 'ok' : 'FAILED'}: ${what}`)
  if (!ok) failures.push(what)
}

log(`# Kotlin recording (E7), ${new Date().toISOString()}`)
run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '4',
  '-c:v', 'libx265', '-preset', 'ultrafast', '-b:v', '1500k',
  '-x265-params', 'keyint=60:min-keyint=60:bframes=0:scenecut=0:repeat-headers=1:log-level=error', '-f', 'hevc', 'fixture.h265'
])
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-f', 'adts', 'fixture.aac'])
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '1', '-c:a', 'aac', '-b:a', '128k', '-f', 'adts', 'silence.aac'])

const testLog = join(work, 'test.log')
rmSync(testLog, { force: true })
const gradle = run('./gradlew', [':streamcore:testDebugUnitTest', '--tests', '*RecordingExportTest', '--console=plain', '-q'], {
  cwd: cameraman,
  env: { TS_RECORDING_E2E_DIR: work, TS_RECORDING_E2E_LOG: testLog },
  show: 12
})
if (existsSync(testLog)) {
  log('  RecordingExportTest:')
  for (const line of readFileSync(testLog, 'utf8').split('\n').filter(Boolean)) log(`    ${line}`)
}
expect(gradle.status === 0, 'RecordingExportTest passed')

const exported = join(work, 'kotlin-recording-export.mp4')
const streams = run('ffprobe', ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,width,height', '-of', 'compact', 'kotlin-recording-export.mp4'])
const kinds = streams.output.split('\n').filter(Boolean)
expect(kinds.filter(line => line.includes('codec_type=video')).length === 1 && /codec_name=hevc\|codec_type=video\|width=1920\|height=1080/.test(streams.output), 'one HEVC 1920x1080 track')
expect(kinds.filter(line => line.includes('codec_type=audio')).length === 1 && /codec_name=aac\|codec_type=audio/.test(streams.output), 'one AAC track')

function packets(stream, hash) {
  const args = ['-v', 'error', '-select_streams', stream, '-show_entries', `packet=pts_time,duration_time${hash ? ',data_hash' : ''}`]
  if (hash) args.push('-show_data_hash', 'MD5')
  args.push('-of', 'csv=p=0', 'kotlin-recording-export.mp4')
  const result = run('ffprobe', args, { show: 0 })
  return result.output.split('\n').filter(Boolean).map(line => {
    const [pts, duration, data] = line.split(',')
    return { pts: Number(pts), duration: Number(duration), hash: data }
  })
}

const frame = 1 / 30
const wallLength = 70
const video = packets('v:0', false)
const audio = packets('a:0', true)
const videoEnd = Math.max(...video.map(p => p.pts + p.duration))
const audioEnd = Math.max(...audio.map(p => p.pts + p.duration))
log(`  video: ${video.length} packets, ${video[0].pts.toFixed(3)}..${videoEnd.toFixed(3)} s`)
log(`  audio: ${audio.length} packets, ${audio[0].pts.toFixed(3)}..${audioEnd.toFixed(3)} s`)
expect(Math.abs(video[0].pts) <= frame && Math.abs(videoEnd - wallLength) <= frame, `video spans the ${wallLength} s wall length within one frame`)
expect(Math.abs(audio[0].pts) <= frame && Math.abs(audioEnd - wallLength) <= frame, `audio spans the ${wallLength} s wall length within one frame`)

const held = video.reduce((longest, p) => (p.duration > longest.duration ? p : longest))
const holeStart = held.pts + frame
const holeEnd = held.pts + held.duration
const after = video.filter(p => p.pts > held.pts && p.pts < holeEnd - 1e-3)
log(`  the hole: one picture at ${held.pts.toFixed(3)} s held ${held.duration.toFixed(3)} s, to ${holeEnd.toFixed(3)} s`)
expect(held.duration > 10 && after.length === 0, 'the hole is held as one picture')
const silentHash = `MD5:${createHash('md5').update(readFileSync(join(work, 'silent.aac.raw'))).digest('hex')}`
const inHole = audio.filter(p => p.pts >= holeStart + 0.05 && p.pts + p.duration <= holeEnd - 0.05)
const silent = inHole.filter(p => p.hash === silentHash)
log(`  the hole's sound: ${inHole.length} AAC packets, ${silent.length} of them the silent packet (${silentHash})`)
expect(inHole.length > 400 && silent.length === inHole.length, 'the hole is filled with silent AAC')

const decode = run('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-i', 'kotlin-recording-export.mp4', '-f', 'null', '-'])
expect(decode.status === 0 && decode.output.trim() === '', 'ffmpeg decodes the whole export without an error')

log('')
log(failures.length === 0 ? 'PASS kotlin recording' : `FAIL kotlin recording: ${failures.join('; ')}`)
process.exit(failures.length === 0 ? 0 : 1)
