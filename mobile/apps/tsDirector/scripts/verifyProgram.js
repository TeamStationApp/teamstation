#!/usr/bin/env node
// Pulls the most recent program master file off the device and reports what is actually in it.
//
// The program tile on screen is rendered by an AVSampleBufferDisplayLayer, and WebDriverAgent
// screenshots exclude hardware video layers — so the composited picture cannot be checked from a
// Maestro screenshot at all. The recorded file is the only place the scorebug burn-in and the mixed
// audio track can be seen, which makes this the verification of record for both.

const { execFileSync } = require('child_process')
const { existsSync, mkdirSync, rmSync } = require('fs')
const path = require('path')

const { resolveDevice } = require('./deviceTarget')

// Resolved when the script runs, not when it is loaded, so a test can import `newestProgram`.
let UDID
const BUNDLE = 'app.teamstation.director'
const OUT = path.join(__dirname, '..', 'artifacts', 'program')

function run (command, args) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function listing () {
  return run('xcrun', [
    'devicectl', 'device', 'info', 'files',
    '--device', UDID,
    '--domain-type', 'appDataContainer',
    '--domain-identifier', BUNDLE,
    '--username', 'mobile',
    // The whole container runs to more entries than a listing can buffer.
    '--subdirectory', 'Documents/Program'
  ])
}

function pull (remote, local) {
  run('xcrun', [
    'devicectl', 'device', 'copy', 'from',
    '--device', UDID,
    '--domain-type', 'appDataContainer',
    '--domain-identifier', BUNDLE,
    '--source', remote,
    '--destination', local
  ])
}

function probe (file) {
  const raw = run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,width,height,sample_rate,channels,nb_read_packets,duration',
    '-count_packets',
    '-of', 'json',
    file
  ])
  return JSON.parse(raw).streams || []
}

// The newest master by its stamp, then by its part: a resumed take's `program-…-2.mp4` sorts before
// the part-one `program-….mp4` it continues as plain text, so the last name listed was part one.
function newestProgram (names) {
  const key = (name) => {
    const match = /^program-(\d{8})-(\d{6})(?:-(\d+))?\.mp4$/.exec(name)
    if (match == null) return [ '', 0 ]
    return [ `${match[1]}${match[2]}`, Number(match[3] || 1) ]
  }
  return [ ...names ].sort((a, b) => {
    const [ stampA, partA ] = key(a)
    const [ stampB, partB ] = key(b)
    return stampA === stampB ? partA - partB : stampA < stampB ? -1 : 1
  })[names.length - 1]
}

function main () {
  UDID = resolveDevice().udid
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  const names = listing().match(/program-\d{8}-\d{6}(?:-\d+)?\.mp4/g) ?? []
  const unique = [ ...new Set(names) ]
  if (!unique.length) throw new Error('no program files on device')

  const name = newestProgram(unique)
  const local = path.join(OUT, name)
  pull(`Documents/Program/${name}`, local)
  if (!existsSync(local)) throw new Error(`copy produced nothing for ${name}`)

  console.log(`program: ${name}\n`)
  const streams = probe(local)
  for (const stream of streams) {
    if (stream.codec_type === 'video') {
      const seconds = Number(stream.duration || 0)
      const frames = Number(stream.nb_read_packets || 0)
      console.log(
        `  video  ${stream.codec_name} ${stream.width}x${stream.height}  ` +
          `${frames} frames in ${seconds.toFixed(1)}s = ${(frames / (seconds || 1)).toFixed(1)} fps`
      )
    }
    if (stream.codec_type === 'audio') {
      console.log(
        `  audio  ${stream.codec_name} ${stream.sample_rate}Hz x${stream.channels}  ` +
          `${Number(stream.duration || 0).toFixed(1)}s`
      )
    }
  }
  if (!streams.some((stream) => stream.codec_type === 'audio')) console.log('  audio  none')

  // A frame from a few seconds in, by which point the scorebug has certainly been snapshotted.
  const frame = path.join(OUT, 'frame.png')
  run('ffmpeg', [ '-v', 'error', '-y', '-ss', '3', '-i', local, '-frames:v', '1', frame ])
  console.log(`\n  frame  ${frame}`)
}

if (require.main === module) main()

module.exports = { newestProgram }
