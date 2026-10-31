#!/usr/bin/env node
'use strict'

// Reads every picture of a programme recording or stream of marked cameras and reports what each
// seam did: how long the outgoing picture was held, and whether the pictures either side of it
// belong there. A seam is a change of camera, or a jump within one camera (a replay starting or
// ending).
//
//   node scripts/programmeCutFrames.js <video> [--fps 60] [--json <out>]
//
// Pictures come from scripts/markedRtspCameras.js, or tsNdiCameras, which reads as camera 0.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const { CAMERA_SHIFT, FRAME_BITS } = require('./markedRtspCameras')

const CELL = 16
const BITS = 24
const WIDTH = CELL * (BITS + 1)
const ANCHOR_LUMA = 200
const SET_LUMA = 128
/// Frames a camera's number may jump and still be the same run of pictures.
const JUMP_FRAMES = 30

/// One row of luma through the strip, as `{ camera, frame }`, or null where no strip reads.
function decodeRow(row) {
  const luma = index => row[Math.floor(CELL * (index + 0.5))]
  if (luma(0) < ANCHOR_LUMA) return null
  let value = 0
  for (let bit = 0; bit < BITS; bit += 1) {
    if (luma(bit + 1) > SET_LUMA) value |= 2 ** bit
  }
  return { camera: Math.floor(value / 2 ** CAMERA_SHIFT), frame: value % 2 ** FRAME_BITS }
}

function readPictures(file) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-nostdin', '-loglevel', 'error', '-i', file,
      '-fps_mode', 'passthrough',
      '-vf', `format=gray,crop=${WIDTH}:1:0:${CELL / 2}`,
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-'
    ], { stdio: ['ignore', 'pipe', 'inherit'] })
    const chunks = []
    ffmpeg.stdout.on('data', chunk => chunks.push(chunk))
    ffmpeg.on('error', reject)
    ffmpeg.on('close', code => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code} reading ${file}`))
        return
      }
      const all = Buffer.concat(chunks)
      const pictures = []
      for (let offset = 0; offset + WIDTH <= all.length; offset += WIDTH) {
        pictures.push(decodeRow(all.subarray(offset, offset + WIDTH)))
      }
      resolve(pictures)
    })
  })
}

function same(left, right) {
  return left != null && right != null && left.camera === right.camera && left.frame === right.frame
}

/// Steps between two frame numbers of one camera, across its clip's wrap, either way.
function frameStep(from, to, wrap) {
  const step = (to - from + wrap) % wrap
  return step > wrap / 2 ? step - wrap : step
}

/// Runs of one picture, in order: `{ picture, start, ticks }`. Unread pictures extend the run they
/// fall in, and are counted.
function pictureRuns(pictures) {
  const runs = []
  let unread = 0
  for (let index = 0; index < pictures.length; index += 1) {
    const picture = pictures[index]
    if (picture == null) {
      unread += 1
      if (runs.length > 0) runs[runs.length - 1].ticks += 1
      continue
    }
    const last = runs[runs.length - 1]
    if (last != null && same(last.picture, picture)) last.ticks += 1
    else runs.push({ picture, start: index, ticks: 1 })
  }
  return { runs, unread }
}

/// What each seam did. `heldTicks` is how long the outgoing camera's last picture stayed on; the
/// segments between seams, and how many are shorter than `flashTicks`, say whether anything showed
/// that should not have.
function analyse(pictures, { fps = 60, wrap = 3600, flashTicks = 3 } = {}) {
  const { runs, unread } = pictureRuns(pictures)
  const seams = []
  for (let index = 1; index < runs.length; index += 1) {
    const before = runs[index - 1]
    const after = runs[index]
    const cameraChange = before.picture.camera !== after.picture.camera
    const jump = !cameraChange && Math.abs(frameStep(before.picture.frame, after.picture.frame, wrap)) > JUMP_FRAMES
    if (!cameraChange && !jump) continue
    seams.push({
      kind: cameraChange ? 'cut' : 'jump',
      from: before.picture.camera,
      to: after.picture.camera,
      at: after.start / fps,
      tick: after.start,
      heldTicks: before.ticks,
      heldMs: before.ticks * 1000 / fps
    })
  }
  const segments = []
  let start = runs[0]?.start ?? 0
  for (const seam of seams) {
    segments.push({ camera: pictures[start]?.camera, ticks: seam.tick - start })
    start = seam.tick
  }
  if (runs.length > 0) segments.push({ camera: pictures[start]?.camera, ticks: pictures.length - start })
  const seamStarts = new Set(seams.map(seam => seam.tick))
  const lastBeforeSeam = run => seamStarts.has(run.start + run.ticks)
  const longestElsewhere = runs.filter(run => !lastBeforeSeam(run)).reduce((most, run) => Math.max(most, run.ticks), 0)
  return {
    pictures: pictures.length,
    unread,
    seams,
    // `beforeReplay`: the moment of live picture between the cut a replay makes and its first picture.
    flashes: segments
      .map((segment, index) => ({ ...segment, beforeReplay: seams[index]?.kind === 'jump', index }))
      .filter(segment => segment.index > 0 && segment.ticks < flashTicks),
    worstHeldMs: seams.reduce((most, seam) => Math.max(most, seam.heldMs), 0),
    longestHoldMs: runs.reduce((most, run) => Math.max(most, run.ticks), 0) * 1000 / fps,
    longestHoldElsewhereTicks: longestElsewhere
  }
}

async function main() {
  const [file] = process.argv.slice(2)
  const option = (name, fallback) => {
    const index = process.argv.indexOf(name)
    return index >= 0 ? process.argv[index + 1] : fallback
  }
  const report = analyse(await readPictures(file), { fps: Number(option('--fps', '60')) })
  const output = option('--json')
  if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  for (const seam of report.seams) {
    process.stdout.write(`${seam.at.toFixed(2)}s ${seam.kind} ${seam.from}->${seam.to} held ${seam.heldTicks} ticks (${seam.heldMs.toFixed(0)} ms)\n`)
  }
  process.stdout.write(`pictures ${report.pictures} unread ${report.unread} seams ${report.seams.length} flashes ${report.flashes.length} worst held ${report.worstHeldMs.toFixed(0)} ms, longest hold elsewhere ${report.longestHoldElsewhereTicks} ticks\n`)
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  })
}

module.exports = { analyse, decodeRow, pictureRuns, readPictures }
