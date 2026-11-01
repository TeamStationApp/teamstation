#!/usr/bin/env node
// One camera's RTSP/RTP loop: bitstream-copy the fixture, speak interleaved TCP, and answer the
// handshake TS Director actually sends (DESCRIBE-only probes, then OPTIONS/DESCRIBE/SETUP/PLAY).

const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const net = require('node:net')

const RTP_MTU = 1200

function rtpPacket({ payloadType, sequence, timestamp, ssrc, marker, payload }) {
  const header = Buffer.alloc(12)
  header[0] = 0x80
  header[1] = (marker ? 0x80 : 0) | (payloadType & 0x7f)
  header.writeUInt16BE(sequence & 0xffff, 2)
  header.writeUInt32BE(timestamp >>> 0, 4)
  header.writeUInt32BE(ssrc >>> 0, 8)
  return Buffer.concat([header, payload])
}

function packetizeH264(nal) {
  if (nal.length <= RTP_MTU) return [nal]
  const nri = nal[0] & 0xe0
  const type = nal[0] & 0x1f
  const packets = []
  let offset = 1
  let start = true
  while (offset < nal.length) {
    const size = Math.min(RTP_MTU - 2, nal.length - offset)
    const end = offset + size >= nal.length
    const payload = Buffer.alloc(2 + size)
    payload[0] = nri | 28
    payload[1] = (start ? 0x80 : 0) | (end ? 0x40 : 0) | type
    nal.copy(payload, 2, offset, offset + size)
    packets.push(payload)
    offset += size
    start = false
  }
  return packets
}

function packetizeHevc(nal) {
  if (nal.length <= RTP_MTU) return [nal]
  const nalType = (nal[0] >> 1) & 0x3f
  const hdr0 = (nal[0] & 0x81) | (49 << 1)
  const hdr1 = nal[1]
  const packets = []
  let offset = 2
  let start = true
  while (offset < nal.length) {
    const size = Math.min(RTP_MTU - 3, nal.length - offset)
    const end = offset + size >= nal.length
    const payload = Buffer.alloc(3 + size)
    payload[0] = hdr0
    payload[1] = hdr1
    payload[2] = (start ? 0x80 : 0) | (end ? 0x40 : 0) | nalType
    nal.copy(payload, 3, offset, offset + size)
    packets.push(payload)
    offset += size
    start = false
  }
  return packets
}

function packetizeAac(accessUnit) {
  const size = accessUnit.length
  const payload = Buffer.alloc(4 + size)
  payload.writeUInt16BE(16, 0)
  payload[2] = (size >> 5) & 0xff
  payload[3] = (size & 0x1f) << 3
  accessUnit.copy(payload, 4)
  return payload
}

function interleaved(channel, packet) {
  const header = Buffer.alloc(4)
  header[0] = 0x24
  header[1] = channel
  header.writeUInt16BE(packet.length, 2)
  return Buffer.concat([header, packet])
}

function findStartCode(buffer, from) {
  for (let index = from; index + 2 < buffer.length; index += 1) {
    if (buffer[index] !== 0 || buffer[index + 1] !== 0) continue
    if (index + 3 < buffer.length && buffer[index + 2] === 0 && buffer[index + 3] === 1) {
      return { index, length: 4 }
    }
    if (buffer[index + 2] === 1) return { index, length: 3 }
  }
  return null
}

class AnnexBParser {
  constructor() {
    this.buffer = Buffer.alloc(0)
  }

  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const nals = []
    while (true) {
      const start = findStartCode(this.buffer, 0)
      if (!start) {
        if (this.buffer.length > 4) this.buffer = this.buffer.subarray(this.buffer.length - 4)
        break
      }
      const next = findStartCode(this.buffer, start.index + start.length)
      if (!next) {
        this.buffer = this.buffer.subarray(start.index)
        break
      }
      const nal = this.buffer.subarray(start.index + start.length, next.index)
      if (nal.length > 0) nals.push(Buffer.from(nal))
      this.buffer = this.buffer.subarray(next.index)
    }
    return nals
  }
}

class AdtsParser {
  constructor() {
    this.buffer = Buffer.alloc(0)
  }

  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames = []
    let index = 0
    while (index + 7 <= this.buffer.length) {
      if (this.buffer[index] !== 0xff || (this.buffer[index + 1] & 0xf0) !== 0xf0) {
        index += 1
        continue
      }
      const frameLength =
        ((this.buffer[index + 3] & 0x03) << 11) |
        (this.buffer[index + 4] << 3) |
        (this.buffer[index + 5] >> 5)
      if (frameLength < 7) {
        index += 1
        continue
      }
      if (index + frameLength > this.buffer.length) break
      const headerLength = this.buffer[index + 1] & 0x01 ? 7 : 9
      if (frameLength > headerLength) {
        frames.push(Buffer.from(this.buffer.subarray(index + headerLength, index + frameLength)))
      }
      index += frameLength
    }
    this.buffer = this.buffer.subarray(index)
    return frames
  }
}

function h264Type(nal) {
  return nal[0] & 0x1f
}

function hevcType(nal) {
  return (nal[0] >> 1) & 0x3f
}

function isVideoVcl(codec, nal) {
  if (codec === 'hevc') {
    const type = hevcType(nal)
    return type <= 31
  }
  const type = h264Type(nal)
  return type >= 1 && type <= 5
}

function isKeyframeNal(codec, nal) {
  if (codec === 'hevc') {
    const type = hevcType(nal)
    return type >= 16 && type <= 21
  }
  return h264Type(nal) === 5
}

class LoopSource extends EventEmitter {
  constructor(options) {
    super()
    this.file = options.file
    this.codec = options.codec
    this.videoPayloadType = options.videoPayloadType
    this.audioPayloadType = options.audioPayloadType
    this.videoClock = options.videoClock ?? 90_000
    this.frameRate = options.frameRate ?? 30
    this.audioRate = options.audioRate ?? 32_000
    this.videoSsrc = options.videoSsrc
    this.audioSsrc = options.audioSsrc
    this.ffmpeg = null
    this.videoSeq = 0
    this.audioSeq = 0
    this.videoTs = 0
    this.audioTs = 0
    this.pending = []
    this.annexb = new AnnexBParser()
    this.adts = new AdtsParser()
    this.videoIncrement = Math.round(this.videoClock / this.frameRate)
  }

  start() {
    if (this.ffmpeg) return
    const bsf = this.codec === 'hevc' ? 'hevc_mp4toannexb' : 'h264_mp4toannexb'
    const rawFormat = this.codec === 'hevc' ? 'hevc' : 'h264'
    this.ffmpeg = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-re',
        '-stream_loop',
        '-1',
        '-i',
        this.file,
        '-map',
        '0:v:0',
        '-c:v',
        'copy',
        '-bsf:v',
        bsf,
        '-f',
        rawFormat,
        'pipe:1',
        '-map',
        '0:a:0',
        '-c:a',
        'copy',
        '-f',
        'adts',
        'pipe:3'
      ],
      { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] }
    )
    this.ffmpeg.stdio[1].on('data', chunk => this.handleVideo(chunk))
    this.ffmpeg.stdio[3].on('data', chunk => this.handleAudio(chunk))
    this.ffmpeg.stderr.on('data', chunk => this.emit('log', chunk.toString()))
    this.ffmpeg.on('exit', (code, signal) => {
      this.ffmpeg = null
      if (code && code !== 0) this.emit('error', new Error(`ffmpeg exited ${code}/${signal ?? ''}`))
    })
  }

  stop() {
    if (!this.ffmpeg) return
    this.ffmpeg.kill('SIGTERM')
    this.ffmpeg = null
  }

  handleVideo(chunk) {
    for (const nal of this.annexb.push(chunk)) {
      if (isVideoVcl(this.codec, nal)) {
        this.pending.push(nal)
        this.emitAccessUnit(this.pending)
        this.pending = []
        this.videoTs = (this.videoTs + this.videoIncrement) >>> 0
      } else {
        this.pending.push(nal)
      }
    }
  }

  emitAccessUnit(nals) {
    const fragments = []
    for (const nal of nals) {
      const pieces = this.codec === 'hevc' ? packetizeHevc(nal) : packetizeH264(nal)
      fragments.push(...pieces)
    }
    const keyframe = nals.some(nal => isKeyframeNal(this.codec, nal))
    fragments.forEach((payload, index) => {
      const packet = rtpPacket({
        payloadType: this.videoPayloadType,
        sequence: this.videoSeq,
        timestamp: this.videoTs,
        ssrc: this.videoSsrc,
        marker: index === fragments.length - 1,
        payload
      })
      this.videoSeq = (this.videoSeq + 1) & 0xffff
      this.emit('rtp', { channel: 0, packet, keyframe })
    })
  }

  handleAudio(chunk) {
    for (const accessUnit of this.adts.push(chunk)) {
      const packet = rtpPacket({
        payloadType: this.audioPayloadType,
        sequence: this.audioSeq,
        timestamp: this.audioTs,
        ssrc: this.audioSsrc,
        marker: true,
        payload: packetizeAac(accessUnit)
      })
      this.audioSeq = (this.audioSeq + 1) & 0xffff
      this.audioTs = (this.audioTs + 1024) >>> 0
      this.emit('rtp', { channel: 2, packet, keyframe: false })
    }
  }
}

function parseRtspBuffer(buffer) {
  const requests = []
  let offset = 0
  while (offset < buffer.length) {
    if (buffer[offset] === 0x24) {
      if (offset + 4 > buffer.length) break
      const length = buffer.readUInt16BE(offset + 2)
      if (offset + 4 + length > buffer.length) break
      offset += 4 + length
      continue
    }
    const slice = buffer.subarray(offset)
    const headerEnd = slice.indexOf('\r\n\r\n')
    if (headerEnd < 0) break
    const headerText = slice.subarray(0, headerEnd).toString('utf8')
    const lines = headerText.split('\r\n')
    const [method, uri, version] = lines[0].split(' ')
    const headers = {}
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':')
      if (colon < 0) continue
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
    }
    const contentLength = Number(headers['content-length'] || 0)
    const total = headerEnd + 4 + contentLength
    if (slice.length < total) break
    requests.push({ method, uri, version, headers, body: slice.subarray(headerEnd + 4, total) })
    offset += total
  }
  return { requests, rest: buffer.subarray(offset) }
}

function httpDate(date = new Date()) {
  return date.toUTCString()
}

function makeSessionId() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 8)
}

function pathOf(uri) {
  if (!uri || uri === '*') return '*'
  try {
    if (uri.startsWith('rtsp://')) return new URL(uri).pathname.replace(/\/+$/, '') || '/'
  } catch {
    // A relative control URL is normal after SETUP.
  }
  return uri.replace(/\/+$/, '') || '/'
}

function createCameraServer(options) {
  const {
    host,
    port,
    path = '/live/mainstream',
    sdp,
    serverHeader,
    source,
    // Optional: ({ method: 'GET' | 'SET', body }) => { status, reason, body }. A TS Cameraman
    // answers its parameter vocabulary here; NearStream has none.
    parameters = null,
    publicMethods: publicOverride = null,
    // Bind address when it differs from the advertised host. macOS lets an unprivileged process
    // bind :554 on the wildcard but not on a specific address.
    listenHost = host
  } = options
  const normalizedPath = path.replace(/\/+$/, '') || '/'
  const publicMethods = publicOverride || (
    serverHeader.startsWith('Hamedal')
      ? 'OPTIONS, DESCRIBE, SETUP, TEARDOWN, PLAY, PAUSE, ANNOUNCE, RECORD, SET_PARAMETER, GET_PARAMETER'
      : 'OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN, GET_PARAMETER')

  const sessions = new Map()
  const sockets = new Set()

  function reply(socket, request, status, reason, extraHeaders = {}, body = '') {
    const bodyBuffer = Buffer.from(body, 'utf8')
    const headers = [
      `RTSP/1.0 ${status} ${reason}`,
      `CSeq: ${request.headers.cseq ?? 0}`,
      `Server: ${serverHeader}`,
      `Date: ${httpDate()}`
    ]
    for (const [name, value] of Object.entries(extraHeaders)) {
      if (value != null) headers.push(`${name}: ${value}`)
    }
    if (bodyBuffer.length > 0) {
      headers.push(`Content-Length: ${bodyBuffer.length}`)
    }
    socket.write(`${headers.join('\r\n')}\r\n\r\n`)
    if (bodyBuffer.length > 0) socket.write(bodyBuffer)
  }

  function contentBase(requestHost) {
    return `rtsp://${requestHost ?? host}:${port}${normalizedPath}/`
  }

  function handle(socket, state, request) {
    const method = (request.method || '').toUpperCase()
    const uriPath = pathOf(request.uri)
    const session = request.headers.session ? sessions.get(request.headers.session) : state.session
    const requestHost = host

    if (method === 'OPTIONS') {
      reply(socket, request, 200, 'OK', { Public: publicMethods })
      return
    }

    if (method === 'DESCRIBE') {
      if (uriPath !== '*' && uriPath !== normalizedPath && !uriPath.startsWith(`${normalizedPath}/`)) {
        reply(socket, request, 404, 'Not Found')
        return
      }
      if (!state.session) {
        state.session = { id: makeSessionId(), playing: false, socket }
        sessions.set(state.session.id, state.session)
      }
      const extra = {
        'Content-Type': 'application/sdp',
        'Content-Base': contentBase(requestHost)
      }
      if (serverHeader.startsWith('Hamedal')) {
        extra.Session = state.session.id
        extra['x-Accept-Dynamic-Rate'] = '1'
        extra['x-Accept-Retransmit'] = 'our-retransmit'
      }
      reply(socket, request, 200, 'OK', extra, sdp.endsWith('\n') ? sdp : `${sdp}\n`)
      return
    }

    if (method === 'SETUP') {
      if (!state.session) {
        state.session = { id: makeSessionId(), playing: false, socket }
        sessions.set(state.session.id, state.session)
      }
      const transport = request.headers.transport || 'RTP/AVP/TCP;unicast;interleaved=0-1'
      const interleavedMatch = /interleaved=(\d+)/i.exec(transport)
      const channel = interleavedMatch ? Number(interleavedMatch[1]) : uriPath.includes('trackID=1') ? 2 : 0
      const pair = `${channel}-${channel + 1}`
      reply(socket, request, 200, 'OK', {
        Session: `${state.session.id};timeout=60`,
        Transport: `RTP/AVP/TCP;unicast;interleaved=${pair}`
      })
      return
    }

    if (method === 'PLAY') {
      if (!state.session) {
        reply(socket, request, 454, 'Session Not Found')
        return
      }
      state.session.playing = true
      state.session.waitKey = true
      state.session.socket = socket
      source.start()
      reply(socket, request, 200, 'OK', {
        Session: state.session.id,
        Range: 'npt=0.000-'
      })
      return
    }

    if (method === 'PAUSE') {
      if (state.session) state.session.playing = false
      reply(socket, request, 200, 'OK', session ? { Session: state.session.id } : {})
      return
    }

    if (method === 'TEARDOWN') {
      if (state.session) {
        state.session.playing = false
        sessions.delete(state.session.id)
        state.session = null
      }
      reply(socket, request, 200, 'OK')
      return
    }

    if (method === 'GET_PARAMETER' || method === 'SET_PARAMETER') {
      const body = (request.body || Buffer.alloc(0)).toString('utf8')
      // An empty body is the keepalive every client sends; a body is a parameter request.
      if (parameters && body.trim().length > 0) {
        const answer = parameters({ method: method === 'GET_PARAMETER' ? 'GET' : 'SET', body })
        const extra = state.session ? { Session: state.session.id } : {}
        if (answer.body) extra['Content-Type'] = 'text/parameters'
        reply(socket, request, answer.status, answer.reason, extra, answer.body || '')
        return
      }
      reply(socket, request, 200, 'OK', state.session ? { Session: state.session.id } : {})
      return
    }

    reply(socket, request, 501, 'Not Implemented')
  }

  const onRtp = ({ channel, packet, keyframe }) => {
    for (const session of sessions.values()) {
      if (!session.playing || !session.socket || session.socket.destroyed) continue
      if (session.waitKey) {
        if (channel !== 0 || !keyframe) continue
        session.waitKey = false
      }
      try {
        session.socket.write(interleaved(channel, packet))
      } catch {
        session.playing = false
      }
    }
  }
  source.on('rtp', onRtp)

  const server = net.createServer(socket => {
    socket.setNoDelay(true)
    sockets.add(socket)
    const state = { buffer: Buffer.alloc(0), session: null }
    socket.on('data', data => {
      state.buffer = Buffer.concat([state.buffer, data])
      const parsed = parseRtspBuffer(state.buffer)
      state.buffer = parsed.rest
      for (const request of parsed.requests) handle(socket, state, request)
    })
    socket.on('close', () => {
      sockets.delete(socket)
      if (state.session) {
        state.session.playing = false
        sessions.delete(state.session.id)
      }
    })
    socket.on('error', () => socket.destroy())
  })

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, listenHost, () => {
          server.off('error', reject)
          resolve()
        })
      })
    },
    async close() {
      source.off('rtp', onRtp)
      source.stop()
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    }
  }
}

function selfTest() {
  const tiny = Buffer.from([0x65, 1, 2, 3, 4])
  const single = packetizeH264(tiny)
  if (single.length !== 1 || single[0].length !== 5) throw new Error('H264 single NAL')

  const big = Buffer.alloc(3000, 7)
  big[0] = 0x65
  const fragments = packetizeH264(big)
  if (fragments.length < 3) throw new Error('H264 FU-A count')
  if ((fragments[0][0] & 0x1f) !== 28) throw new Error('H264 FU-A type')
  if ((fragments[0][1] & 0x80) === 0) throw new Error('H264 FU-A start')
  if ((fragments[fragments.length - 1][1] & 0x40) === 0) throw new Error('H264 FU-A end')

  const hevc = Buffer.alloc(3000, 9)
  hevc[0] = 0x26
  hevc[1] = 0x01
  const hevcFragments = packetizeHevc(hevc)
  if (((hevcFragments[0][0] >> 1) & 0x3f) !== 49) throw new Error('HEVC FU type')

  const aac = packetizeAac(Buffer.alloc(100, 1))
  if (aac.readUInt16BE(0) !== 16) throw new Error('AAC AU-headers-length')
  if (((aac[2] << 5) | (aac[3] >> 3)) !== 100) throw new Error('AAC size')

  const parser = new AnnexBParser()
  const nals = parser.push(Buffer.from([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 0, 1, 0x68, 3, 0, 0, 1, 0x65, 4]))
  if (nals.length !== 2) throw new Error(`annex-b nals ${nals.length}`)

  const adts = new AdtsParser()
  const header = Buffer.from([0xff, 0xf1, 0x4c, 0x80, 0x01, 0x40, 0xfc, 9, 9, 9])
  const frames = adts.push(header)
  if (frames.length !== 1 || frames[0].length !== 3) {
    throw new Error(`ADTS frame ${frames.length}:${frames[0] && frames[0].length}`)
  }

  return 'ok'
}

// A camera that generates its picture and sound live, stamped with the wall clock, instead of
// looping a captured file.
//
// Every frame carries the Unix time it was generated, in milliseconds mod 2^32, as 32 binary cells
// with a sentinel cell that is always white; every whole wall-clock second the sound beeps at the
// camera's own tone for 50 ms. So an exported file can be asked, at any position, what time its
// picture says and whether its sound agrees — the ground truth a looped capture cannot give,
// because its burn-in restarts every loop and its sound is a steady tone.
//
// The epoch is taken as ffmpeg is spawned and `-re` paces generation, so frame n is epoch + n/fps.
// The time from spawning to the first frame arriving here is kept as `startLatencyMs`, so a verifier
// can tell a constant generation delay from a placement error.
const LIVE_MARKER = { bits: 32, originX: 40, originY: 40, stride: 36, cell: 32, sentinelSlot: 32 }

function liveMarkerFilters(epochMs) {
  const { bits, originX, originY, stride, cell, sentinelSlot } = LIVE_MARKER
  const filters = [
    `drawbox=x=20:y=20:w=${originX + (sentinelSlot + 1) * stride - 16}:h=72:color=black:t=fill`
  ]
  for (let bit = 0; bit < bits; bit += 1) {
    filters.push(
      `drawbox=x=${originX + bit * stride}:y=${originY}:w=${cell}:h=${cell}:color=white:t=fill:`
      + `enable='mod(floor((${epochMs}+t*1000)/pow(2\\,${bit}))\\,2)'`
    )
  }
  filters.push(
    `drawbox=x=${originX + sentinelSlot * stride}:y=${originY}:w=${cell}:h=${cell}:color=white:t=fill`
  )
  return filters
}

/// The video encoder a live camera uses, shared by the stream and by the sample its SDP is read from.
///
/// `zerolatency` would otherwise turn on x264's sliced threads, which cut every picture into several
/// slices. The packetizer here, like a camera's, starts a new access unit at each coded slice, so a
/// sliced picture went out under several timestamps and nothing could put it back together: a pull
/// got nine frames in three seconds.
function liveVideoEncoderArgs(fps) {
  return [
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-tune', 'zerolatency',
    '-x264-params', 'sliced-threads=0',
    '-g', String(fps), '-keyint_min', String(fps), '-sc_threshold', '0', '-bf', '0', '-b:v', '4000k'
  ]
}

/// The ffmpeg command for one live camera. Also used, bounded with `-t`, to encode the sample the
/// fixture generator reads parameter sets from, so the SDP matches what is actually sent.
function liveArgs({ epochMs, width = 1280, height = 720, fps = 30, colour, name, toneHz }) {
  const flash = `drawbox=x=40:y=110:w=240:h=80:color=white:t=fill:`
    + `enable='lt(mod(${epochMs}+t*1000\\,1000)\\,${(1000 / fps).toFixed(3)})'`
  const video = [
    `drawbox=x=0:y=0:w=${width}:h=${height}:color=${colour}@0.35:t=fill`,
    ...liveMarkerFilters(epochMs),
    flash,
    `drawtext=fontfile=/System/Library/Fonts/Menlo.ttc:text='${name}':x=40:y=${height - 120}:`
      + 'fontsize=56:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=10',
    "drawtext=fontfile=/System/Library/Fonts/Menlo.ttc:text='%{localtime\\:%H\\\\\\:%M\\\\\\:%S}':"
      + `x=${width - 420}:y=${height - 120}:fontsize=56:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=10`
  ].join(',')
  // The AAC encoder delays its output by 1024 samples of priming, so a beep generated exactly on the
  // second would reach the wire 21 ms behind the frame that shows that second. Generating it that
  // much early makes the camera itself sync-exact, so anything an export shows is Director's.
  const lead = (1024 / 48000).toFixed(6)
  const beep = `if(lt(mod(${epochMs}/1000+t+${lead}\\,1)\\,0.05)\\,0.8*sin(2*PI*${toneHz}*t)\\,0)`
  return [
    '-hide_banner', '-loglevel', 'error', '-re',
    '-f', 'lavfi', '-i', `color=c=gray:s=${width}x${height}:r=${fps}`,
    '-f', 'lavfi', '-i', `aevalsrc=exprs='${beep}|${beep}':s=48000`,
    '-filter_complex', `[0:v]${video}[v]`,
    '-map', '[v]', ...liveVideoEncoderArgs(fps), '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', 'pipe:1',
    '-map', '1:a', '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '2', '-f', 'adts', 'pipe:3'
  ]
}

/// An RTCP sender report: this RTP timestamp was this wall-clock instant.
///
/// A real camera sends one every few seconds per stream, and Director takes a picture's capture time
/// — and places a stream's sound against its picture — from them. A fixture that sends none is timed
/// by arrival instead, which measures the fixture's pipes rather than Director.
function senderReport({ ssrc, wallMs, rtpTimestamp, packets, octets }) {
  const packet = Buffer.alloc(28)
  packet[0] = 0x80
  packet[1] = 200
  packet.writeUInt16BE(6, 2)
  packet.writeUInt32BE(ssrc >>> 0, 4)
  const ntpSeconds = Math.floor(wallMs / 1000) + 2_208_988_800
  const fraction = Math.floor(((wallMs % 1000) / 1000) * 4_294_967_296)
  packet.writeUInt32BE(ntpSeconds >>> 0, 8)
  packet.writeUInt32BE(fraction >>> 0, 12)
  packet.writeUInt32BE(rtpTimestamp >>> 0, 16)
  packet.writeUInt32BE(packets >>> 0, 20)
  packet.writeUInt32BE(octets >>> 0, 24)
  return packet
}

/// One sender report for each of `source`'s two streams, and what it has sent so far, which
/// `countSent` keeps.
function sendSenderReports(source, { wallMs, videoTimestamp, audioTimestamp, sent }) {
  source.emit('rtp', {
    channel: 1,
    keyframe: false,
    packet: senderReport({ ssrc: source.videoSsrc, wallMs, rtpTimestamp: videoTimestamp, ...sent.video })
  })
  source.emit('rtp', {
    channel: 3,
    keyframe: false,
    packet: senderReport({ ssrc: source.audioSsrc, wallMs, rtpTimestamp: audioTimestamp, ...sent.audio })
  })
}

function countSent(source) {
  const sent = { video: { packets: 0, octets: 0 }, audio: { packets: 0, octets: 0 } }
  source.on('rtp', ({ channel, packet }) => {
    const stream = channel === 0 ? sent.video : channel === 2 ? sent.audio : null
    if (!stream) return
    stream.packets += 1
    stream.octets += Math.max(0, packet.length - 12)
  })
  return sent
}

class LiveSource extends LoopSource {
  constructor(options) {
    super({ ...options, codec: 'h264', frameRate: options.fps ?? 30, audioRate: 48_000 })
    this.live = options
    this.epochMs = null
    this.spawnedAt = null
    this.startLatencyMs = null
    this.reportTimer = null
    this.sent = countSent(this)
  }

  /// Frame n is generated at epoch + n/fps and audio sample k at epoch + k/48000, and the RTP
  /// timestamps count from zero at the epoch on both, so the mapping is exact rather than estimated.
  sendReports() {
    if (this.epochMs === null || this.startLatencyMs === null) return
    const wallMs = Date.now()
    const elapsedMs = wallMs - this.spawnedAt
    sendSenderReports(this, {
      wallMs,
      videoTimestamp: Math.round(elapsedMs * (this.videoClock / 1000)),
      audioTimestamp: Math.round(elapsedMs * 48),
      sent: this.sent
    })
  }

  stop() {
    if (this.reportTimer) clearInterval(this.reportTimer)
    this.reportTimer = null
    super.stop()
  }

  start() {
    if (this.ffmpeg) return
    this.spawnedAt = Date.now()
    this.epochMs = this.spawnedAt % 4_294_967_296
    this.startLatencyMs = null
    this.ffmpeg = spawn('ffmpeg', liveArgs({ ...this.live, epochMs: this.epochMs }), {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe']
    })
    this.ffmpeg.stdio[1].on('data', chunk => {
      if (this.startLatencyMs === null) {
        this.startLatencyMs = Date.now() - this.spawnedAt
        this.emit('clock', { epochMs: this.epochMs, spawnedAt: this.spawnedAt, startLatencyMs: this.startLatencyMs })
        if (!this.reportTimer) this.reportTimer = setInterval(() => this.sendReports(), 1000)
      }
      this.handleVideo(chunk)
    })
    this.ffmpeg.stdio[3].on('data', chunk => this.handleAudio(chunk))
    this.ffmpeg.stderr.on('data', chunk => this.emit('log', chunk.toString()))
    this.ffmpeg.on('exit', (code, signal) => {
      this.ffmpeg = null
      if (code && code !== 0 && signal !== 'SIGTERM') {
        this.emit('error', new Error(`ffmpeg exited ${code}/${signal ?? ''}`))
      }
    })
  }
}

/// The same encoder, bounded and written to one file, for the fixture generator to read parameter
/// sets from. Identical settings mean identical SPS and PPS, so the SDP describes the live stream.
function liveSampleArgs(options, file, seconds = 1) {
  const args = liveArgs({ ...options, epochMs: 0 })
  const filter = args.indexOf('-filter_complex')
  const head = args.slice(0, filter + 2).filter(arg => arg !== '-re')
  return [
    ...head, '-y', '-t', String(seconds),
    '-map', '[v]', '-map', '1:a',
    ...liveVideoEncoderArgs(options.fps ?? 30),
    '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '2',
    file
  ]
}

module.exports = {
  LIVE_MARKER,
  LiveSource,
  liveArgs,
  liveSampleArgs,
  LoopSource,
  countSent,
  sendSenderReports,
  senderReport,
  createCameraServer,
  packetizeH264,
  packetizeHevc,
  packetizeAac,
  rtpPacket,
  selfTest
}

if (require.main === module) {
  process.stdout.write(`${selfTest()}\n`)
}
