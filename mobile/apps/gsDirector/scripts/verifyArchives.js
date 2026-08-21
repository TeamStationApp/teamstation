#!/usr/bin/env node
'use strict'

// Pulls the head of each per-camera archive off the device and decodes it.
//
// Frame counters in telemetry only prove that buffers were handed to a writer. They say nothing
// about whether the bytes on disk form a playable file at the expected rate, and the archive bugs
// found so far all produced healthy-looking counters alongside unusable output. This decodes what
// actually landed and reports the real frame rate per camera.

const { execFileSync } = require('node:child_process')
const {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync
} = require('node:fs')
const path = require('node:path')

const { resolveDevice } = require('./deviceTarget')

const UDID = resolveDevice().udid
const BUNDLE = 'co.gamestation.director'
const CONTAINER = 'Library/Application Support/GSDirector/Archives'
const OUT = path.join(__dirname, '..', 'DerivedData', 'archive-check')

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

function listing() {
  return run('xcrun', [
    'devicectl',
    'device',
    'info',
    'files',
    '--device',
    UDID,
    '--domain-type',
    'appDataContainer',
    '--domain-identifier',
    BUNDLE
  ])
}

function pull(remote, local) {
  run('xcrun', [
    'devicectl',
    'device',
    'copy',
    'from',
    '--device',
    UDID,
    '--domain-type',
    'appDataContainer',
    '--domain-identifier',
    BUNDLE,
    '--source',
    remote,
    '--destination',
    local
  ])
}

function probe(file) {
  const raw = run('ffprobe', [
    '-v',
    'error',
    '-count_frames',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=codec_name,width,height,nb_read_frames,duration',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    file
  ])
  const json = JSON.parse(raw)
  const stream = json.streams[0] || {}
  const seconds = Number(json.format.duration || stream.duration || 0)
  const frames = Number(stream.nb_read_frames || 0)
  return {
    codec: stream.codec_name,
    size: `${stream.width}x${stream.height}`,
    frames,
    seconds,
    fps: seconds > 0 ? frames / seconds : 0,
    audio: probeAudio(file)
  }
}

// R4's A/V sync half. A track that plays longer than the video it accompanies is out of sync by
// the difference, and the counters inside the app cannot show it — only the written file can.
function probeAudio(file) {
  try {
    const raw = run('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_name,sample_rate,channels,duration,start_time',
      '-of',
      'json',
      file
    ])
    const stream = JSON.parse(raw).streams[0]
    if (!stream) return null
    return {
      codec: stream.codec_name,
      rate: Number(stream.sample_rate || 0),
      channels: Number(stream.channels || 0),
      seconds: Number(stream.duration || 0),
      start: Number(stream.start_time || 0)
    }
  } catch {
    return null
  }
}

/// The highest-numbered recording that actually has segment files. The device accumulates a
/// directory per recording, including empty ones from runs that were cut short, so "the newest
/// recording" cannot be taken as "the last directory".
function latestRecording(files) {
  const numbers = [
    ...files.matchAll(
      new RegExp(`${CONTAINER}/[^/\\s]+/rec-(\\d+)/(?:init|seg-\\d+)\\.mp4`, 'g')
    )
  ].map(match => Number(match[1]))
  if (numbers.length === 0) throw new Error('no archives on the device')
  return `rec-${Math.max(...numbers)}`
}

function initNames(files, camera, recording) {
  const found = [
    ...files.matchAll(
      new RegExp(
        `${CONTAINER}/${camera}/${recording}/(init[^\\s/]*\\.mp4)`,
        'g'
      )
    )
  ].map(match => match[1])
  return [...new Set(found)].sort()
}

function main() {
  const segments = Number(process.argv[3] || 3)

  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  const files = listing()
  const recording = process.argv[2] || latestRecording(files)
  const cameras = [
    ...new Set(
      [
        ...files.matchAll(new RegExp(`${CONTAINER}/([^/]+)/${recording}/`, 'g'))
      ].map(m => m[1])
    )
  ]

  if (!cameras.length)
    throw new Error(`no camera archives found for ${recording}`)
  console.log(`${recording}: ${cameras.length} cameras\n`)

  for (const camera of cameras) {
    const dir = path.join(OUT, camera)
    mkdirSync(dir, { recursive: true })

    // The initialization segment carries its writer's sequence number, so it is read from the
    // listing rather than guessed: without the right one the concatenation has no `moov` and
    // ffprobe rejects the whole file, which reads as "the archive is corrupt".
    const names = initNames(files, camera, recording)
    for (let i = 1; i <= segments; i++)
      names.push(`seg-${String(i).padStart(5, '0')}.mp4`)

    const parts = []
    for (const name of names) {
      const local = path.join(dir, name)
      try {
        pull(`${CONTAINER}/${camera}/${recording}/${name}`, local)
      } catch {
        continue
      }
      if (existsSync(local)) parts.push(readFileSync(local))
    }
    if (parts.length < 2) {
      console.log(`${camera.padEnd(26)} no segments retrieved`)
      continue
    }

    // fMP4 plays back as the initialization segment followed by the media segments concatenated.
    const joined = path.join(dir, 'joined.mp4')
    writeFileSync(joined, Buffer.concat(parts))

    try {
      const result = probe(joined)
      const audio = result.audio
        ? `  audio ${result.audio.codec} ${result.audio.rate}Hz x${result.audio.channels} ` +
          `${result.audio.seconds.toFixed(1)}s ` +
          `drift=${(result.audio.seconds - result.seconds).toFixed(2)}s`
        : '  audio none'
      console.log(
        `${camera.padEnd(26)} ${result.codec} ${result.size}  ` +
          `${result.frames} frames in ${result.seconds.toFixed(1)}s = ${result.fps.toFixed(1)} fps` +
          audio
      )
    } catch (error) {
      console.log(
        `${camera.padEnd(26)} decode failed: ${error.message.split('\n')[0]}`
      )
    }
  }
}

main()
