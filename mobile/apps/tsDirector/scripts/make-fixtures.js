#!/usr/bin/env node
// Generates the deterministic media fixtures the encode-fidelity and scrub tests measure
// against.
//
// Frames are painted here rather than by ffmpeg's own generators because every frame has to
// carry a `FrameMarker` strip whose geometry matches Swift's
// `DirectorSources/FrameMarker.swift` exactly. Node writes raw RGB into ffmpeg, ffmpeg burns in
// the human-readable text and encodes one H.264 and one HEVC file per frame rate from the same
// pixels, so the two codecs are frame-for-frame comparable.
//
// Usage:
//   node scripts/make-fixtures.js            generate media + sidecars, rewrite manifest
//   node scripts/make-fixtures.js --verify   regenerate into a temp dir and diff the checksums

const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DIRECTOR_ROOT = path.resolve(__dirname, '..')
const FIXTURE_DIR = path.join(DIRECTOR_ROOT, 'fixtures')
const MANIFEST_PATH = path.join(FIXTURE_DIR, 'manifest.json')

// Bumped whenever the painted pixels change, so a stale manifest is obvious.
const GENERATOR_VERSION = 3

const WIDTH = 1920
const HEIGHT = 1080
const DURATION_SECONDS = 8
const GOP_SECONDS = 2
const FONT_FILE = '/System/Library/Fonts/Menlo.ttc'

// Must match DirectorSources/FrameMarker.swift.
const MARKER = {
  bitCount: 20,
  cellSize: 24,
  cellStride: 32,
  originX: 8,
  originY: 8
}
MARKER.cellCount = MARKER.bitCount + 2
MARKER.maximumValue = (1 << MARKER.bitCount) - 1

const VARIANTS = [
  { frameRate: 30, codec: 'h264' },
  { frameRate: 30, codec: 'hevc' },
  { frameRate: 60, codec: 'h264' },
  { frameRate: 60, codec: 'hevc' }
]

function fixtureName(frameRate, codec) {
  return `bars-1080p${frameRate}-${codec}`
}

// MARK: - Painting

function makeTemplate() {
  const frame = Buffer.allocUnsafe(WIDTH * HEIGHT * 3)
  for (let y = 0; y < HEIGHT; y += 1) {
    const shade = Math.round(24 + (y / HEIGHT) * 40)
    const band = Math.floor(y / (HEIGHT / 6))
    const red = band % 2 === 0 ? shade : Math.round(shade * 0.7)
    const green = Math.round(shade * 0.85)
    const blue = band % 3 === 0 ? Math.round(shade * 1.6) : shade
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 3
      frame[offset] = red
      frame[offset + 1] = green
      frame[offset + 2] = blue
    }
  }
  return frame
}

function fillRect(frame, x0, y0, width, height, red, green, blue) {
  for (let y = y0; y < y0 + height; y += 1) {
    let offset = (y * WIDTH + x0) * 3
    for (let x = 0; x < width; x += 1) {
      frame[offset] = red
      frame[offset + 1] = green
      frame[offset + 2] = blue
      offset += 3
    }
  }
}

function copyRect(destination, source, x0, y0, width, height) {
  for (let y = y0; y < y0 + height; y += 1) {
    const start = (y * WIDTH + x0) * 3
    source.copy(destination, start, start, start + width * 3)
  }
}

function drawMarker(frame, value) {
  const wrapped = value & MARKER.maximumValue
  for (let index = 0; index < MARKER.cellCount; index += 1) {
    let isWhite
    if (index === 0) {
      isWhite = true
    } else if (index === MARKER.cellCount - 1) {
      isWhite = false
    } else {
      isWhite = ((wrapped >> (index - 1)) & 1) === 1
    }
    const level = isWhite ? 255 : 0
    fillRect(
      frame,
      MARKER.originX + index * MARKER.cellStride,
      MARKER.originY,
      MARKER.cellSize,
      MARKER.cellSize,
      level,
      level,
      level
    )
  }
}

const BAR_WIDTH = 90
const BAR_TOP = 700
const BAR_HEIGHT = 240

function barX(index, frameCount) {
  const sweep = (index % frameCount) / frameCount
  return Math.round(sweep * (WIDTH - BAR_WIDTH))
}

// MARK: - Generation

async function writeFrames(stdin, frameCount) {
  const template = makeTemplate()
  const frame = Buffer.from(template)
  let previousBarX = null

  for (let index = 0; index < frameCount; index += 1) {
    if (previousBarX !== null) {
      copyRect(frame, template, previousBarX, BAR_TOP, BAR_WIDTH, BAR_HEIGHT)
    }
    const x = barX(index, frameCount)
    fillRect(frame, x, BAR_TOP, BAR_WIDTH, BAR_HEIGHT, 250, 230, 90)
    previousBarX = x

    drawMarker(frame, index)

    if (!stdin.write(frame)) {
      await new Promise(resolve => stdin.once('drain', resolve))
    }
  }
  stdin.end()
}

function drawTextFilter(label) {
  const common = `fontfile=${FONT_FILE}:fontcolor=white:borderw=4:bordercolor=black@0.8`
  return [
    `drawtext=${common}:text='${label}':x=60:y=170:fontsize=64`,
    `drawtext=${common}:text='%{pts\\:hms}':x=60:y=280:fontsize=140`,
    `drawtext=${common}:text='frame %{n}':x=60:y=470:fontsize=72`
  ].join(',')
}

// x264 and x265 are only bit-exact across runs when their threading is pinned, and the whole
// point of these fixtures is that the checksums in the manifest keep meaning something.
function encoderArgs(codec, frameRate) {
  const gop = String(frameRate * GOP_SECONDS)
  if (codec === 'h264') {
    return [
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-g',
      gop,
      '-keyint_min',
      gop,
      '-sc_threshold',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-x264-params',
      'threads=2:sliced-threads=0:deterministic=1'
    ]
  }
  return [
    '-c:v',
    'libx265',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-tag:v',
    'hvc1',
    '-pix_fmt',
    'yuv420p',
    '-x265-params',
    `keyint=${gop}:min-keyint=${gop}:scenecut=0:pools=2:frame-threads=1:log-level=error`
  ]
}

function ffmpegArgs(frameRate, outputs) {
  const label = `TS Director fixture ${frameRate}fps`
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-s',
    `${WIDTH}x${HEIGHT}`,
    '-r',
    String(frameRate),
    '-i',
    'pipe:0',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${DURATION_SECONDS}`,
    '-filter_complex',
    `[0:v]${drawTextFilter(label)},split=2[v0][v1]`
  ]
  for (const [index, output] of outputs.entries()) {
    args.push(
      '-map',
      `[v${index}]`,
      '-map',
      '1:a',
      ...encoderArgs(output.codec, frameRate),
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      '-video_track_timescale',
      '90000',
      '-y',
      output.path
    )
  }
  return args
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} exited ${code}\n${stderr}`))
    })
    if (options.onSpawn) options.onSpawn(child)
  })
}

async function generateFrameRate(frameRate, targetDir) {
  const outputs = VARIANTS.filter(
    variant => variant.frameRate === frameRate
  ).map(variant => ({
    codec: variant.codec,
    name: fixtureName(frameRate, variant.codec),
    path: path.join(targetDir, `${fixtureName(frameRate, variant.codec)}.mp4`)
  }))

  const args = ffmpegArgs(frameRate, outputs)
  const frameCount = frameRate * DURATION_SECONDS

  process.stdout.write(
    `  encoding ${outputs.map(o => o.codec).join(' + ')} at ${frameRate} fps\n`
  )
  let writeError = null
  await run('ffmpeg', args, {
    onSpawn: child => {
      child.stdin.on('error', error => {
        writeError = error
      })
      writeFrames(child.stdin, frameCount).catch(error => {
        writeError = error
      })
    }
  })
  if (writeError) throw writeError

  return outputs.map(output => ({
    ...output,
    frameRate,
    frameCount,
    ffmpeg: ['ffmpeg', ...args]
  }))
}

// MARK: - Probing

async function probeFrames(file) {
  const { stdout } = await run('ffprobe', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'frame=pts,pts_time,key_frame',
    '-of',
    'json',
    file
  ])
  const parsed = JSON.parse(stdout)
  return (parsed.frames ?? []).map((frame, index) => ({
    frameID: index,
    markerValue: index & MARKER.maximumValue,
    pts: Number(frame.pts),
    ptsSeconds: Number(frame.pts_time),
    isKeyFrame: frame.key_frame === 1
  }))
}

async function probeFormat(file) {
  const { stdout } = await run('ffprobe', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-show_entries',
    'format=duration:stream=codec_name,width,height,avg_frame_rate',
    '-of',
    'json',
    file
  ])
  return JSON.parse(stdout)
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

// MARK: - Entry point

async function build(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true })

  const entries = []
  for (const frameRate of [30, 60]) {
    const outputs = await generateFrameRate(frameRate, targetDir)
    for (const output of outputs) {
      const frames = await probeFrames(output.path)
      if (frames.length !== output.frameCount) {
        throw new Error(
          `${output.name}: encoded ${frames.length} frames, expected ${output.frameCount}`
        )
      }
      const sidecarPath = path.join(targetDir, `${output.name}.frames.json`)
      fs.writeFileSync(
        sidecarPath,
        `${JSON.stringify(
          {
            name: output.name,
            frameRate: output.frameRate,
            markerBitCount: MARKER.bitCount,
            frames
          },
          null,
          2
        )}\n`
      )

      const format = await probeFormat(output.path)
      const videoStream = (format.streams ?? []).find(stream => stream.width)
      entries.push({
        name: output.name,
        file: `${output.name}.mp4`,
        sidecar: `${output.name}.frames.json`,
        codec: videoStream?.codec_name ?? output.codec,
        width: videoStream?.width ?? WIDTH,
        height: videoStream?.height ?? HEIGHT,
        frameRate: output.frameRate,
        frameCount: frames.length,
        gopSeconds: GOP_SECONDS,
        durationSeconds: Number(format.format?.duration ?? DURATION_SECONDS),
        keyFrameCount: frames.filter(frame => frame.isKeyFrame).length,
        sha256: sha256(output.path),
        sidecarSha256: sha256(sidecarPath),
        ffmpeg: output.ffmpeg
      })
    }
  }

  return {
    generatorVersion: GENERATOR_VERSION,
    width: WIDTH,
    height: HEIGHT,
    durationSeconds: DURATION_SECONDS,
    marker: MARKER,
    fixtures: entries.sort((a, b) => a.name.localeCompare(b.name))
  }
}

function comparableManifest(manifest) {
  return JSON.stringify({
    ...manifest,
    fixtures: manifest.fixtures.map(({ ffmpeg, ...rest }) => rest)
  })
}

async function main() {
  const verify = process.argv.includes('--verify')
  const targetDir = verify
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'tsdirector-fixtures-'))
    : FIXTURE_DIR

  const started = Date.now()
  const manifest = await build(targetDir)
  const seconds = ((Date.now() - started) / 1000).toFixed(1)

  if (!verify) {
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
    process.stdout.write(
      `Wrote ${manifest.fixtures.length} fixtures in ${seconds}s -> ${FIXTURE_DIR}\n`
    )
    return
  }

  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(
      'no committed manifest to verify against — run without --verify first'
    )
  }
  const committed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  fs.rmSync(targetDir, { recursive: true, force: true })

  if (comparableManifest(committed) !== comparableManifest(manifest)) {
    for (const fixture of manifest.fixtures) {
      const other = committed.fixtures.find(
        entry => entry.name === fixture.name
      )
      if (!other) {
        process.stderr.write(
          `  ${fixture.name}: missing from the committed manifest\n`
        )
      } else if (other.sha256 !== fixture.sha256) {
        process.stderr.write(
          `  ${fixture.name}: ${other.sha256} != ${fixture.sha256}\n`
        )
      }
    }
    throw new Error('fixtures are not reproducible on this machine')
  }
  process.stdout.write(`Fixtures reproduce byte-for-byte (${seconds}s)\n`)
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
