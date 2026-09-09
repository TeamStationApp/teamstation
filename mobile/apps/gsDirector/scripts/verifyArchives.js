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

/// The names directly inside one directory of the app container.
///
/// Listing the container recursively is not viable on a device that has been recording for weeks:
/// every segment of every past recording is walked, which took over three minutes here and failed
/// intermittently with `CoreDevice.ActionError error 3` over the wireless tunnel — a transport
/// error that reads as a missing or corrupt archive. One level at a time answers in under a second.
function listDir(subdirectory) {
  const text = run('xcrun', [
    'devicectl',
    'device',
    'info',
    'files',
    '--device',
    UDID,
    '--domain-type',
    'appDataContainer',
    '--domain-identifier',
    BUNDLE,
    '--subdirectory',
    subdirectory,
    '--no-recurse'
  ])
  // Rows are `<name>  <resources>  <size>  <date>`, and every entry is at least readable, so the
  // resources column is what distinguishes a row from the header and its underline.
  return [...text.matchAll(/^(\S+)\s+(?:Writable|Readable)/gm)].map(match => match[1])
}

const recordingsIn = camera =>
  listDir(`${CONTAINER}/${camera}`).filter(name => /^rec-\d+$/.test(name))

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
  // The *video track's* own duration, not the container's. The container reports the longest
  // track, so when a sender misdeclares its frame rate the video timeline can run at half real
  // speed while the audio track is correct — and dividing the frame count by the container
  // duration then yields a plausible frame rate that hides it completely. Measured on a real
  // NDI|HX converter declaring 120/1 while sending 60: video track 3.000s for 360 frames against
  // a 5.887s audio track, reported here as a healthy 59.4 fps until this preferred the stream.
  const seconds = Number(stream.duration || json.format.duration || 0)
  const containerSeconds = Number(json.format.duration || 0)
  const frames = Number(stream.nb_read_frames || 0)
  return {
    codec: stream.codec_name,
    size: `${stream.width}x${stream.height}`,
    frames,
    seconds,
    containerSeconds,
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
/// recording" cannot be taken as "the last directory". Searching downwards from the highest
/// number keeps this to one directory listing in the normal case.
function latestRecording(byCamera) {
  const numbers = [...new Set([...byCamera.values()].flat())]
    .map(name => Number(name.slice('rec-'.length)))
    .sort((left, right) => right - left)
  for (const number of numbers) {
    const recording = `rec-${number}`
    for (const [camera, recordings] of byCamera) {
      if (!recordings.includes(recording)) continue
      if (contentsOf(camera, recording).length) return recording
    }
  }
  throw new Error('no archives on the device')
}

const contentsCache = new Map()

function contentsOf(camera, recording) {
  const key = `${camera}/${recording}`
  if (!contentsCache.has(key)) {
    contentsCache.set(
      key,
      listDir(`${CONTAINER}/${key}`).filter(name => name.endsWith('.mp4'))
    )
  }
  return contentsCache.get(key)
}

const initNames = (camera, recording) =>
  contentsOf(camera, recording)
    .filter(name => name.startsWith('init'))
    .sort()

function main() {
  const segments = Number(process.argv[3] || 3)

  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  const byCamera = new Map(
    listDir(CONTAINER).map(camera => [camera, recordingsIn(camera)])
  )
  const recording = process.argv[2] || latestRecording(byCamera)
  const cameras = [...byCamera]
    .filter(([, recordings]) => recordings.includes(recording))
    .map(([camera]) => camera)

  if (!cameras.length)
    throw new Error(`no camera archives found for ${recording}`)
  console.log(`${recording}: ${cameras.length} cameras\n`)

  for (const camera of cameras) {
    const dir = path.join(OUT, camera)
    mkdirSync(dir, { recursive: true })

    // The initialization segment carries its writer's sequence number, so it is read from the
    // listing rather than guessed: without the right one the concatenation has no `moov` and
    // ffprobe rejects the whole file, which reads as "the archive is corrupt".
    const names = initNames(camera, recording)
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
      if (existsSync(local)) parts.push({ name, local })
    }
    if (!parts.length) {
      console.log(`${camera.padEnd(26)} no segments retrieved`)
      continue
    }

    const hasInit = parts.some(part => part.name.startsWith('init'))
    const joined = path.join(dir, 'joined.mp4')
    if (hasInit) {
      writeFileSync(joined, Buffer.concat(parts.map(part => readFileSync(part.local))))
    } else {
      // Complete MP4 files (one writer per segment) are probed individually.
      writeFileSync(joined, readFileSync(parts[0].local))
    }

    try {
      const result = probe(joined)
      const drift = result.audio ? result.audio.seconds - result.seconds : 0
      const audio = result.audio
        ? `  audio ${result.audio.codec} ${result.audio.rate}Hz x${result.audio.channels} ` +
          `${result.audio.seconds.toFixed(1)}s ` +
          `drift=${drift.toFixed(2)}s`
        : '  audio none'
      // A video track materially shorter or longer than the audio beside it is not a rounding
      // artefact: it is the whole file playing at the wrong speed, and it has to be shouted about
      // rather than left for someone to notice in a frame-rate column.
      if (Math.abs(drift) > 0.5) {
        console.log(
          `${''.padEnd(26)} ** VIDEO/AUDIO TIMELINE MISMATCH: video ${result.seconds.toFixed(3)}s ` +
            `vs audio ${result.audio.seconds.toFixed(3)}s — video plays ` +
            `${(result.audio.seconds / result.seconds).toFixed(2)}x wrong speed **`
        )
      }
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
