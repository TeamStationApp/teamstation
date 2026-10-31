#!/usr/bin/env node
'use strict'

// Fake 1080p60 HEVC cameras whose every picture says which camera and which frame it is, served over
// RTSP from this Mac, so a recording of them can be read frame by frame. No IP alias and no Bonjour:
// Director reaches them through `rtspHosts`.
//
//   node scripts/markedRtspCameras.js [--host <LAN address>] [--port 18554] [--count 2]
//                                     [--reported-age 0,300]
//
// The strip is the `FrameMarker` layout tsNdiCameras draws, in the top-left corner: 16 px cells from
// x=0, a white anchor cell, then 24 bits, least significant first. The low 16 bits are the frame
// number and bits 20 and up the camera, from 1; an NDI camera's strip is its frame id, so it reads
// as camera 0. scripts/programmeCutFrames.js reads them back.
//
// Each sends an RTCP sender report every second, as a real camera does, because Director times a
// picture from them; a camera that sends none has no capture time, and its pictures go on air as
// they arrive. --reported-age moves each camera's reports that many milliseconds into the past, for
// a camera whose clock says its pictures are older than they are.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createCameraServer, LoopSource, senderReport } = require('./rtspLoopServer')

const CLIP_SECONDS = 60
const FRAME_BITS = 16
const CAMERA_SHIFT = 20
const REPORT_MILLISECONDS = 1_000

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function lanAddress() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal && address.address.startsWith('10.')) return address.address
    }
  }
  throw new Error('no LAN IPv4 address; pass --host')
}

function markerFilter(camera) {
  const cell = bit => `x=${16 * (bit + 1)}:y=0:w=16:h=16:color=white:t=fill`
  const boxes = ['drawbox=x=0:y=0:w=400:h=16:color=black:t=fill', 'drawbox=x=0:y=0:w=16:h=16:color=white:t=fill']
  for (let bit = 0; bit < FRAME_BITS; bit += 1) {
    boxes.push(`drawbox=${cell(bit)}:enable='eq(mod(floor(n/${2 ** bit}),2),1)'`)
  }
  for (let bit = 0; bit < 4; bit += 1) {
    if ((camera >> bit) & 1) boxes.push(`drawbox=${cell(CAMERA_SHIFT + bit)}`)
  }
  return boxes.join(',')
}

function makeClip(camera, directory) {
  const clip = path.join(directory, `marked-camera-${camera}.mkv`)
  if (fs.existsSync(clip)) return clip
  const partial = `${clip}.partial.mkv`
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60',
    '-f', 'lavfi', '-i', `sine=frequency=${500 * camera}:sample_rate=48000`,
    '-t', String(CLIP_SECONDS),
    '-vf', `${camera === 2 ? 'hue=s=0,' : ''}${markerFilter(camera)}`,
    '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
    '-x265-params', 'keyint=60:min-keyint=60:bframes=0:slices=1:repeat-headers=1:log-level=error',
    '-b:v', '6M',
    '-c:a', 'aac', '-ac', '2', '-b:a', '128k',
    partial
  ], { stdio: 'inherit' })
  fs.renameSync(partial, clip)
  return clip
}

// VPS, SPS and PPS of the first access unit, as base64, for the SDP.
function parameterSets(clip, directory) {
  const raw = path.join(directory, `first-${path.basename(clip)}.hevc`)
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', clip,
    '-map', '0:v:0', '-c:v', 'copy', '-bsf:v', 'hevc_mp4toannexb', '-frames:v', '1', '-f', 'hevc', raw
  ])
  const bytes = fs.readFileSync(raw)
  const units = []
  let start = -1
  for (let index = 0; index + 3 < bytes.length; index += 1) {
    if (bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1) {
      if (start >= 0) units.push(bytes.subarray(start, index))
      start = index + 3
    }
  }
  if (start >= 0) units.push(bytes.subarray(start))
  const unit = type => {
    const found = units.find(candidate => ((candidate[0] >> 1) & 0x3f) === type)
    if (!found) throw new Error(`no NAL type ${type} in the first access unit`)
    // A four-byte start code leaves a trailing zero on the unit before it.
    let end = found.length
    while (end > 0 && found[end - 1] === 0) end -= 1
    return found.subarray(0, end).toString('base64')
  }
  return { vps: unit(32), sps: unit(33), pps: unit(34) }
}

function sdpFor(camera, host, sets) {
  return [
    'v=0',
    `o=- 0 0 IN IP4 ${host}`,
    `s=Marked camera ${camera}`,
    'c=IN IP4 0.0.0.0',
    't=0 0',
    'a=control:*',
    'm=video 0 RTP/AVP 96',
    'a=rtpmap:96 H265/90000',
    `a=fmtp:96 sprop-vps=${sets.vps};sprop-sps=${sets.sps};sprop-pps=${sets.pps}`,
    'a=control:trackID=0',
    `a=ssrc:${4240 + camera * 2}`,
    'm=audio 0 RTP/AVP 97',
    'a=rtpmap:97 mpeg4-generic/48000/2',
    'a=fmtp:97 streamtype=5;profile-level-id=15;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=1190',
    'a=control:trackID=1',
    `a=ssrc:${4241 + camera * 2}`,
    ''
  ].join('\r\n')
}

/// Reports the RTP timestamp going out now as this moment, less `reportedAgeMs`.
function sendReports(source, reportedAgeMs, sent) {
  const wallMs = Date.now() - reportedAgeMs
  source.emit('rtp', {
    channel: 1,
    keyframe: false,
    packet: senderReport({ ssrc: source.videoSsrc, wallMs, rtpTimestamp: source.videoTs, ...sent.video })
  })
  source.emit('rtp', {
    channel: 3,
    keyframe: false,
    packet: senderReport({ ssrc: source.audioSsrc, wallMs, rtpTimestamp: source.audioTs, ...sent.audio })
  })
}

async function main() {
  const host = option('--host', lanAddress())
  const basePort = Number(option('--port', '18554'))
  const count = Number(option('--count', '2'))
  const reportedAges = option('--reported-age', '').split(',').map(Number)
  const directory = path.join(os.tmpdir(), 'ts-director-marked-cameras')
  fs.mkdirSync(directory, { recursive: true })

  const running = []
  for (let camera = 1; camera <= count; camera += 1) {
    const clip = makeClip(camera, directory)
    const port = basePort + camera - 1
    const source = new LoopSource({
      file: clip,
      codec: 'hevc',
      frameRate: 60,
      videoPayloadType: 96,
      audioPayloadType: 97,
      videoClock: 90_000,
      audioRate: 48_000,
      videoSsrc: 4240 + camera * 2,
      audioSsrc: 4241 + camera * 2
    })
    source.on('log', message => process.stderr.write(`camera ${camera}: ${message}`))
    source.on('error', error => process.stderr.write(`camera ${camera}: ${error.message}\n`))
    const server = createCameraServer({
      host,
      port,
      path: '/live/mainstream',
      sdp: sdpFor(camera, host, parameterSets(clip, directory)),
      serverHeader: 'GStreamer RTSP server',
      source,
      listenHost: '0.0.0.0'
    })
    await server.listen()
    const sent = { video: { packets: 0, octets: 0 }, audio: { packets: 0, octets: 0 } }
    source.on('rtp', ({ channel, packet }) => {
      const stream = channel === 0 ? sent.video : channel === 2 ? sent.audio : null
      if (!stream) return
      stream.packets += 1
      stream.octets += Math.max(0, packet.length - 12)
    })
    source.start()
    const reports = setInterval(() => sendReports(source, reportedAges[camera - 1] || 0, sent), REPORT_MILLISECONDS)
    running.push({ server, source, reports })
    process.stdout.write(`camera ${camera} rtsp://${host}:${port}/live/mainstream\n`)
  }
  process.stdout.write('ready\n')

  const shutdown = () => {
    for (const { source, reports } of running) {
      clearInterval(reports)
      source.stop()
    }
    Promise.all(running.map(({ server }) => server.close())).finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.stack}\n`)
    process.exit(1)
  })
}

module.exports = { CAMERA_SHIFT, FRAME_BITS }
