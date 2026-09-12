#!/usr/bin/env node
// Builds a capture directory the RTSP farm can serve, without needing a real camera or the
// 2026-08-20 stopwatch take.
//
// The farm replays a captured take: it needs `cameras.json`, an `.mkv` per camera carrying H.264
// and AAC, and an SDP per camera. That capture lives outside the repo and is not on every
// machine, so anything that needs live RTSP cameras — the resume tests among them — could not run
// at all. This generates an equivalent one.
//
// Every frame carries a **wall-clock burn-in**: the number of milliseconds since the take's epoch,
// painted large enough to read back out of an export with OCR-free digit matching, plus a
// human-readable clock and the camera's own colour patch. That is what lets a verifier ask an
// exported file "what time is it here" and get an answer the app cannot fake.
//
//   node scripts/makeRtspFixtures.js --out /tmp/gs-rtsp-fixtures --cameras 2 --seconds 60
//
// The loop is seamless in position but not in time: the farm loops the file, so the burn-in
// repeats. A verifier reads the *pattern* of the burn-in rather than trusting it as an absolute
// clock, which is enough to say which frame is where.

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const FONT = '/System/Library/Fonts/Menlo.ttc'
const WIDTH = 1280
const HEIGHT = 720
const FPS = 30
const GOP_SECONDS = 1

const PALETTE = [
  { name: 'Fixture Cam A', slug: 'fixture-cam-a', colour: '0x1E88E5' },
  { name: 'Fixture Cam B', slug: 'fixture-cam-b', colour: '0xD81B60' },
  { name: 'Fixture Cam C', slug: 'fixture-cam-c', colour: '0x43A047' },
  { name: 'Fixture Cam D', slug: 'fixture-cam-d', colour: '0xFB8C00' }
]

function usage() {
  return `Usage: node scripts/makeRtspFixtures.js [options]
  --out DIR        Where to write the capture (default /tmp/gs-rtsp-fixtures)
  --cameras N      How many cameras, 1-4 (default 2)
  --seconds N      Loop length (default 60)
  --force          Rebuild even if the capture is already there
`
}

function parseArgs(argv) {
  const options = { out: '/tmp/gs-rtsp-fixtures', cameras: 2, seconds: 60, force: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage())
      process.exit(0)
    } else if (arg === '--out') {
      options.out = argv[index + 1]
      index += 1
    } else if (arg === '--cameras') {
      options.cameras = Number(argv[index + 1])
      index += 1
    } else if (arg === '--seconds') {
      options.seconds = Number(argv[index + 1])
      index += 1
    } else if (arg === '--force') {
      options.force = true
    } else {
      throw new Error(`unknown argument ${arg}\n${usage()}`)
    }
  }
  if (!(options.cameras >= 1 && options.cameras <= PALETTE.length)) {
    throw new Error(`--cameras must be 1..${PALETTE.length}`)
  }
  return options
}

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status})\n${result.stderr || result.stdout}`)
  }
  return result.stdout
}

/// One camera's loop file: a coloured field, a large millisecond counter, a readable clock, and
/// the camera's name. `drawtext` with `%{eif:...}` computes from the frame number, so the burn-in
/// is exact rather than approximate.
function encodeCamera(camera, index, options) {
  const file = path.join(options.out, 'video', `${camera.slug}.mkv`)
  const milliseconds = `%{eif\\:trunc(n*1000/${FPS})\\:d\\:8}`
  const clock = '%{pts\\:hms}'
  const filters = [
    `drawbox=x=0:y=0:w=${WIDTH}:h=${HEIGHT}:color=${camera.colour}@0.25:t=fill`,
    // The counter a verifier reads. White on black, monospaced, far larger than any codec ringing.
    `drawtext=fontfile=${FONT}:text='${milliseconds}':x=40:y=${HEIGHT / 2 - 90}:`
      + `fontsize=150:fontcolor=white:box=1:boxcolor=black:boxborderw=18`,
    `drawtext=fontfile=${FONT}:text='${clock}':x=40:y=${HEIGHT / 2 + 90}:`
      + `fontsize=90:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=12`,
    `drawtext=fontfile=${FONT}:text='${camera.name}':x=40:y=60:`
      + `fontsize=64:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=12`,
    // A moving bar, so a frozen frame is obvious to a person looking at the file.
    `drawbox=x='mod(t*240\\,${WIDTH})':y=${HEIGHT - 90}:w=120:h=50:color=white@0.9:t=fill`
  ].join(',')

  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${options.seconds}`,
    // A different tone per camera, so an audio track can be attributed as well.
    '-f', 'lavfi', '-i', `sine=frequency=${440 + index * 220}:sample_rate=48000:d=${options.seconds}`,
    '-vf', filters,
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-g', String(FPS * GOP_SECONDS), '-keyint_min', String(FPS * GOP_SECONDS),
    '-sc_threshold', '0', '-b:v', '4000k', '-bf', '0',
    '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '2',
    '-shortest', file
  ], `encode ${camera.slug}`)
  return file
}

/// The SDP the farm serves verbatim on DESCRIBE. Parameter sets come out of the encoded file, so
/// a decoder can start from the first packet rather than waiting for an in-band SPS.
function writeSdp(camera, file, options) {
  const probe = JSON.parse(run('ffprobe', [
    '-v', 'error', '-print_format', 'json',
    '-show_streams', '-show_entries', 'stream=codec_type,extradata,sample_rate,channels',
    '-of', 'json', file
  ], `probe ${camera.slug}`))

  const video = probe.streams.find(stream => stream.codec_type === 'video')
  const audio = probe.streams.find(stream => stream.codec_type === 'audio')
  if (!video || !audio) throw new Error(`${camera.slug}: expected one video and one audio stream`)

  const { sps, pps } = parameterSets(file)
  // AudioSpecificConfig for AAC-LC 48 kHz stereo: object type 2, index 3, 2 channels.
  const config = '1190'
  const lines = [
    'v=0',
    `o=- 0 0 IN IP4 127.0.0.1`,
    `s=${camera.name}`,
    'c=IN IP4 0.0.0.0',
    't=0 0',
    'a=control:*',
    'm=video 0 RTP/AVP 96',
    'a=rtpmap:96 H264/90000',
    `a=fmtp:96 packetization-mode=1;profile-level-id=640028;sprop-parameter-sets=${sps},${pps}`,
    'a=control:trackID=0',
    `a=ssrc:${1000 + PALETTE.indexOf(camera) * 2}`,
    'm=audio 0 RTP/AVP 97',
    `a=rtpmap:97 mpeg4-generic/${audio.sample_rate || 48000}/2`,
    'a=fmtp:97 streamtype=5;profile-level-id=15;mode=AAC-hbr;sizelength=13;indexlength=3;'
      + `indexdeltalength=3;config=${config}`,
    'a=control:trackID=1',
    `a=ssrc:${1001 + PALETTE.indexOf(camera) * 2}`
  ]
  const sdpPath = path.join(options.out, 'sdp', `${camera.slug}.sdp`)
  fs.writeFileSync(sdpPath, `${lines.join('\r\n')}\r\n`)
  return sdpPath
}

/// Pulls the SPS and PPS out of the encoded file as base64, which is what `sprop-parameter-sets`
/// carries. Read from the Annex B elementary stream rather than the container's extradata so the
/// bytes are exactly what a depacketizer will meet.
function parameterSets(file) {
  const raw = path.join(path.dirname(file), `${path.basename(file, '.mkv')}.h264`)
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', file,
    '-map', '0:v:0', '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb', '-frames:v', '1',
    '-f', 'h264', raw
  ], `extract parameter sets from ${file}`)
  const bytes = fs.readFileSync(raw)
  fs.unlinkSync(raw)

  const units = []
  let start = -1
  for (let index = 0; index + 3 < bytes.length; index += 1) {
    if (bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1) {
      if (start >= 0) units.push(bytes.subarray(start, index))
      start = index + 3
    }
  }
  if (start >= 0) units.push(bytes.subarray(start))

  const find = type => units.find(unit => (unit[0] & 0x1f) === type)
  const sps = find(7)
  const pps = find(8)
  if (!sps || !pps) throw new Error(`${file}: no SPS/PPS in the first access unit`)
  return { sps: sps.toString('base64'), pps: pps.toString('base64') }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const manifest = path.join(options.out, 'cameras.json')
  if (fs.existsSync(manifest) && !options.force) {
    const existing = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    if (existing.cameras?.length === options.cameras) {
      process.stdout.write(`fixtures already at ${options.out}\n`)
      return
    }
  }

  for (const leaf of ['video', 'sdp']) {
    fs.mkdirSync(path.join(options.out, leaf), { recursive: true })
  }

  const cameras = PALETTE.slice(0, options.cameras).map((camera, index) => {
    process.stdout.write(`encoding ${camera.slug} (${options.seconds}s)…\n`)
    const file = encodeCamera(camera, index, options)
    writeSdp(camera, file, options)
    return {
      slug: camera.slug,
      displayName: camera.name,
      kind: 'gs-cameraman',
      rtsp: { server: 'GStreamer RTSP server', path: '/live/mainstream' },
      bonjour: {
        // Identity is the TXT uuid, so two cameras on one address are still two cameras.
        instance: camera.name,
        serviceType: '_rtsp._tcp',
        hostname: `${camera.slug}.local`,
        srvPort: 554,
        txt: {
          uuid: uuidFor(camera.slug),
          name: camera.name,
          model: 'fixture',
          protovers: '1'
        }
      }
    }
  })

  fs.writeFileSync(manifest, `${JSON.stringify({
    generator: 'makeRtspFixtures.js',
    seconds: options.seconds,
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    cameras
  }, null, 2)}\n`)
  process.stdout.write(`wrote ${options.cameras} camera(s) to ${options.out}\n`)
}

/// Stable per slug, so a camera keeps its identity across regenerations and Director does not
/// treat a rebuilt fixture as a new camera.
function uuidFor(slug) {
  const hash = require('node:crypto').createHash('sha1').update(slug).digest('hex')
  return [
    hash.slice(0, 8), hash.slice(8, 12), `4${hash.slice(13, 16)}`,
    ((parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32)
  ].join('-')
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }
}

module.exports = { PALETTE, uuidFor }
