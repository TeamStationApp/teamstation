#!/usr/bin/env node
// An RTSP client that connects to TS Cameraman, runs the full method sequence, reassembles the
// interleaved RTP, and reports what it actually received.
//
// This exists because TS Director cannot be run from here, and every other check in this app is
// Cameraman's own code judging itself. This is an independent reader: it knows nothing about the
// app's internals and fails on anything that is not on the wire correctly. It writes an Annex-B
// elementary stream so ffprobe can act as a third opinion.
//
//   node scripts/rtspClient.js --host 10.0.1.23 --seconds 10 --out /tmp/live.h264
//
// Exits non-zero with a specific reason on any protocol or media fault.

'use strict'

const net = require('net')
const fs = require('fs')
const dgram = require('dgram')

const RTP_HEADER_BYTES = 12
const INTERLEAVED_HEADER_BYTES = 4
const MAGIC = 0x24 // '$'

function parseArgs (argv) {
  const options = {
    host: null,
    port: 8554,
    path: 'live',
    seconds: 10,
    out: null,
    audioOut: null,
    timeout: 15000,
    // ffmpeg and VLC both pick their own channels, so exercising non-default ones is closer to a
    // real client than accepting whatever the server would have chosen.
    videoChannel: 0,
    audioChannel: 2,
    requireAudio: true,
    json: false
  }

  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${key} needs a value`)
      i += 1
      return value
    }
    switch (key) {
      case '--host': options.host = next(); break
      case '--port': options.port = Number(next()); break
      case '--path': options.path = next(); break
      case '--seconds': options.seconds = Number(next()); break
      case '--out': options.out = next(); break
      case '--audio-out': options.audioOut = next(); break
      case '--timeout': options.timeout = Number(next()); break
      case '--video-channel': options.videoChannel = Number(next()); break
      case '--audio-channel': options.audioChannel = Number(next()); break
      case '--no-audio': options.requireAudio = false; break
      case '--json': options.json = true; break
      case '--discover': options.discover = true; break
      default: throw new Error(`unknown argument ${key}`)
    }
  }
  return options
}

// ---------------------------------------------------------------------------
// SDP
// ---------------------------------------------------------------------------

function parseSDP (text) {
  const session = { name: null, media: [] }
  let current = null

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line.length < 2 || line[1] !== '=') continue
    const field = line[0]
    const value = line.slice(2)

    if (field === 's') {
      session.name = value
    } else if (field === 'm') {
      const parts = value.split(' ')
      current = {
        kind: parts[0],
        payloadTypes: parts.slice(3).map(Number),
        control: null,
        rtpmap: null,
        fmtp: {},
        ssrcAttributes: {}
      }
      session.media.push(current)
    } else if (field === 'a') {
      const separator = line.indexOf(':')
      const name = separator === -1 ? value : line.slice(2, separator)
      const attribute = separator === -1 ? '' : line.slice(separator + 1)

      if (name === 'control') {
        if (current === null) session.control = attribute
        else current.control = attribute
      } else if (name === 'rtpmap' && current !== null) {
        // "96 H264/90000" or "97 mpeg4-generic/48000/1"
        const [payloadType, rest] = attribute.split(' ')
        const [encoding, clockRate, channels] = (rest || '').split('/')
        current.rtpmap = {
          payloadType: Number(payloadType),
          encoding,
          clockRate: Number(clockRate),
          channels: channels === undefined ? null : Number(channels)
        }
      } else if (name === 'fmtp' && current !== null) {
        const space = attribute.indexOf(' ')
        for (const parameter of attribute.slice(space + 1).split(';')) {
          const equals = parameter.indexOf('=')
          if (equals === -1) continue
          const key = parameter.slice(0, equals).trim().toLowerCase()
          current.fmtp[key] = parameter.slice(equals + 1).trim()
        }
      } else if (name === 'ssrc' && current !== null) {
        // RFC 5576: "a=ssrc:<id> cname:<value>"
        const space = attribute.indexOf(' ')
        if (space !== -1) {
          const id = attribute.slice(0, space).trim()
          const item = attribute.slice(space + 1)
          const colon = item.indexOf(':')
          if (colon !== -1) {
            current.ssrcAttributes[id] = current.ssrcAttributes[id] || {}
            current.ssrcAttributes[id][item.slice(0, colon)] = item.slice(colon + 1)
          }
        }
      }
    }
  }
  return session
}

/// RFC 2326 C.1.1: a track control may be absolute, rooted, relative, or "*".
function absoluteControlURL (control, base) {
  if (!control || control === '*') return base
  if (control.toLowerCase().startsWith('rtsp://')) return control
  if (control.startsWith('/')) {
    const schemeEnd = base.indexOf('://')
    const pathStart = base.indexOf('/', schemeEnd + 3)
    return pathStart === -1 ? base + control : base.slice(0, pathStart) + control
  }
  return base.endsWith('/') ? base + control : base + '/' + control
}

// ---------------------------------------------------------------------------
// Depacketizers
// ---------------------------------------------------------------------------

/// RFC 6184. Single NAL units, STAP-A aggregates and FU-A fragments.
class H264Depacketizer {
  constructor () {
    this.fragment = null
    this.fragmentHeader = 0
    this.unsupported = 0
  }

  /// Returns the complete NAL units in this packet.
  push (payload) {
    if (payload.length < 1) return []
    const type = payload[0] & 0x1f

    if (type >= 1 && type <= 23) return [payload]

    if (type === 24) {
      // STAP-A: 1 byte header, then repeated [16-bit size][NAL].
      const units = []
      let offset = 1
      while (offset + 2 <= payload.length) {
        const size = payload.readUInt16BE(offset)
        offset += 2
        if (size === 0 || offset + size > payload.length) break
        units.push(payload.subarray(offset, offset + size))
        offset += size
      }
      return units
    }

    if (type === 28) {
      if (payload.length < 3) return []
      const fuHeader = payload[1]
      const isStart = (fuHeader & 0x80) !== 0
      const isEnd = (fuHeader & 0x40) !== 0

      if (isStart) {
        this.fragmentHeader = (payload[0] & 0xe0) | (fuHeader & 0x1f)
        this.fragment = []
      }
      if (this.fragment === null) return [] // joined mid-fragment
      this.fragment.push(payload.subarray(2))

      if (isEnd) {
        const nal = Buffer.concat([Buffer.from([this.fragmentHeader]), ...this.fragment])
        this.fragment = null
        return [nal]
      }
      return []
    }

    this.unsupported += 1
    return []
  }

  static describe (nal) {
    const type = nal[0] & 0x1f
    return {
      type,
      isParameterSet: type === 7 || type === 8,
      isKeyframe: type === 5
    }
  }
}

/// RFC 7798. The NAL header is two bytes, the type sits in different bits, and the fragmentation
/// type is 49 rather than 28 — none of the H.264 rules transfer.
class HEVCDepacketizer {
  constructor () {
    this.fragment = null
    this.fragmentHeader = null
    this.unsupported = 0
  }

  push (payload) {
    if (payload.length < 2) return []
    const type = (payload[0] >> 1) & 0x3f

    if (type <= 47) return [payload]

    if (type === 48) {
      const units = []
      let offset = 2
      while (offset + 2 <= payload.length) {
        const size = payload.readUInt16BE(offset)
        offset += 2
        if (size === 0 || offset + size > payload.length) break
        units.push(payload.subarray(offset, offset + size))
        offset += size
      }
      return units
    }

    if (type === 49) {
      if (payload.length < 4) return []
      const fuHeader = payload[2]
      const isStart = (fuHeader & 0x80) !== 0
      const isEnd = (fuHeader & 0x40) !== 0

      if (isStart) {
        const nalType = fuHeader & 0x3f
        this.fragmentHeader = Buffer.from([(payload[0] & 0x81) | (nalType << 1), payload[1]])
        this.fragment = []
      }
      if (this.fragment === null) return []
      this.fragment.push(payload.subarray(3))

      if (isEnd) {
        const nal = Buffer.concat([this.fragmentHeader, ...this.fragment])
        this.fragment = null
        return [nal]
      }
      return []
    }

    this.unsupported += 1
    return []
  }

  static describe (nal) {
    const type = (nal[0] >> 1) & 0x3f
    return {
      type,
      isParameterSet: type >= 32 && type <= 34,
      isKeyframe: type >= 16 && type <= 21
    }
  }
}

/// RFC 3640 mpeg4-generic, AAC-hbr. Several access units per packet is legal, and a reader that
/// assumes one silently truncates the audio.
class AACDepacketizer {
  constructor (framing) {
    this.framing = framing
  }

  push (payload) {
    if (payload.length <= 2) return []
    const headerBits = payload.readUInt16BE(0)
    if (headerBits === 0) return [payload.subarray(2)]

    const headerBytes = Math.ceil(headerBits / 8)
    if (payload.length < 2 + headerBytes) return []

    const sizes = []
    let bitOffset = 0
    const readBits = (count) => {
      let value = 0
      for (let i = 0; i < count; i += 1) {
        const byte = payload[2 + ((bitOffset + i) >> 3)]
        const bit = (byte >> (7 - ((bitOffset + i) & 7))) & 1
        value = (value << 1) | bit
      }
      bitOffset += count
      return value
    }

    while (bitOffset + this.framing.sizeLength <= headerBits) {
      const size = readBits(this.framing.sizeLength)
      const indexBits = sizes.length === 0 ? this.framing.indexLength : this.framing.indexDeltaLength
      if (bitOffset + indexBits > headerBits) break
      if (indexBits > 0) readBits(indexBits)
      sizes.push(size)
    }

    const units = []
    let offset = 2 + headerBytes
    for (const size of sizes) {
      if (size === 0 || offset + size > payload.length) break
      units.push(payload.subarray(offset, offset + size))
      offset += size
    }
    return units
  }
}

function adtsHeader (payloadCount, sampleRate, channelCount) {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
  const frequencyIndex = rates.indexOf(sampleRate)
  if (frequencyIndex === -1) return null
  const frameLength = payloadCount + 7
  const header = Buffer.alloc(7)
  header[0] = 0xff
  header[1] = 0xf1
  header[2] = (1 << 6) | (frequencyIndex << 2) | (channelCount >> 2)
  header[3] = ((channelCount & 3) << 6) | ((frameLength >> 11) & 0x03)
  header[4] = (frameLength >> 3) & 0xff
  header[5] = ((frameLength & 7) << 5) | 0x1f
  header[6] = 0xfc
  return header
}

// ---------------------------------------------------------------------------
// RTCP
// ---------------------------------------------------------------------------

function parseRTCP (packet) {
  const result = { senderReports: [], sdes: {} }
  let offset = 0

  while (offset + 4 <= packet.length) {
    const type = packet[offset + 1]
    const words = packet.readUInt16BE(offset + 2)
    const end = offset + (words + 1) * 4
    if (end > packet.length) break

    if (type === 200) {
      result.senderReports.push({
        ssrc: packet.readUInt32BE(offset + 4),
        ntpSeconds: packet.readUInt32BE(offset + 8),
        ntpFraction: packet.readUInt32BE(offset + 12),
        rtpTimestamp: packet.readUInt32BE(offset + 16),
        packetCount: packet.readUInt32BE(offset + 20),
        octetCount: packet.readUInt32BE(offset + 24)
      })
    } else if (type === 202) {
      // One chunk: SSRC then a [type][length][text] item list terminated by a zero byte.
      let cursor = offset + 8
      while (cursor < end) {
        const itemType = packet[cursor]
        if (itemType === 0) break
        const length = packet[cursor + 1]
        const text = packet.subarray(cursor + 2, cursor + 2 + length).toString('utf8')
        const names = { 1: 'cname', 2: 'name', 6: 'tool' }
        result.sdes[names[itemType] || `type${itemType}`] = text
        cursor += 2 + length
      }
    }
    offset = end
  }
  return result
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

class RTSPClient {
  constructor (options) {
    this.options = options
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.cseq = 1
    this.session = null
    this.pendingResponse = null
    this.baseURL = `rtsp://${options.host}:${options.port}/${options.path}`

    this.stats = {
      videoPackets: 0,
      videoBytes: 0,
      frames: 0,
      keyframes: 0,
      parameterSets: 0,
      audioPackets: 0,
      audioAccessUnits: 0,
      audioBytes: 0,
      sequenceGaps: 0,
      timestampRegressions: 0,
      unsupportedUnits: 0,
      rtcpSenderReports: 0,
      rtcp: null,
      unknownChannels: {}
    }

    this.videoNALs = []
    this.currentFrame = []
    this.lastVideoSequence = null
    this.lastVideoTimestamp = null
    this.firstVideoTimestamp = null
    this.lastAudioSequence = null
    this.firstAudioTimestamp = null
    this.lastAudioTimestamp = null
    this.videoOut = null
    this.audioOut = null
  }

  connect () {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.options.host, port: this.options.port })
      // A camera whose listener is bound but not accepting shows up as a hang, not a refusal, so a
      // connect timeout is the only way to tell the two apart.
      socket.setTimeout(this.options.timeout)
      socket.once('connect', () => {
        socket.setTimeout(0)
        this.socket = socket
        socket.on('data', (chunk) => this.onData(chunk))
        resolve()
      })
      socket.once('timeout', () => {
        socket.destroy()
        reject(new Error(`timed out connecting to ${this.options.host}:${this.options.port}`))
      })
      socket.once('error', reject)
    })
  }

  onData (chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.drain()
  }

  /// RTSP responses and interleaved media share the connection, so each read may hold either or both.
  drain () {
    for (;;) {
      if (this.buffer.length === 0) return

      if (this.buffer[0] === MAGIC) {
        if (this.buffer.length < INTERLEAVED_HEADER_BYTES) return
        const channel = this.buffer[1]
        const length = this.buffer.readUInt16BE(2)
        if (this.buffer.length < INTERLEAVED_HEADER_BYTES + length) return
        const payload = this.buffer.subarray(
          INTERLEAVED_HEADER_BYTES,
          INTERLEAVED_HEADER_BYTES + length
        )
        this.onInterleaved(channel, Buffer.from(payload))
        this.buffer = this.buffer.subarray(INTERLEAVED_HEADER_BYTES + length)
        continue
      }

      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const headerText = this.buffer.subarray(0, headerEnd).toString('utf8')
      const headers = {}
      const lines = headerText.split('\r\n')
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':')
        if (colon === -1) continue
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      const contentLength = Number(headers['content-length'] || 0)
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + contentLength) return

      const statusParts = lines[0].split(' ')
      const response = {
        statusCode: Number(statusParts[1]),
        reason: statusParts.slice(2).join(' '),
        headers,
        body: this.buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8')
      }
      this.buffer = this.buffer.subarray(bodyStart + contentLength)

      const pending = this.pendingResponse
      this.pendingResponse = null
      if (pending) pending.resolve(response)
    }
  }

  request (method, uri, headers = {}) {
    return new Promise((resolve, reject) => {
      if (this.pendingResponse) {
        reject(new Error('a request is already outstanding'))
        return
      }
      const all = { CSeq: String(this.cseq), 'User-Agent': 'tsCameraman-integration/1.0', ...headers }
      if (this.session) all.Session = this.session
      this.cseq += 1

      let text = `${method} ${uri} RTSP/1.0\r\n`
      for (const [name, value] of Object.entries(all)) text += `${name}: ${value}\r\n`
      text += '\r\n'

      const timer = setTimeout(() => {
        this.pendingResponse = null
        reject(new Error(`${method} timed out after ${this.options.timeout} ms`))
      }, this.options.timeout)

      this.pendingResponse = {
        resolve: (response) => {
          clearTimeout(timer)
          // CSeq must match, or the response belongs to a different request and the session is
          // desynchronised.
          const expected = Number(all.CSeq)
          if (Number(response.headers.cseq) !== expected) {
            reject(new Error(
              `${method} got CSeq ${response.headers.cseq}, expected ${expected}`
            ))
            return
          }
          resolve(response)
        }
      }
      this.socket.write(text)
      // Media may already be flowing, so anything buffered has to be processed after writing too.
      this.drain()
    })
  }

  onInterleaved (channel, payload) {
    if (channel === this.options.videoChannel) this.onVideoRTP(payload)
    else if (channel === this.options.audioChannel) this.onAudioRTP(payload)
    else if (channel === this.options.videoChannel + 1 || channel === this.options.audioChannel + 1) {
      this.onRTCP(payload)
    } else {
      this.stats.unknownChannels[channel] = (this.stats.unknownChannels[channel] || 0) + 1
    }
  }

  static parseRTP (packet) {
    if (packet.length < RTP_HEADER_BYTES) return null
    if ((packet[0] >> 6) !== 2) return null
    const csrcCount = packet[0] & 0x0f
    const hasExtension = (packet[0] & 0x10) !== 0
    const hasPadding = (packet[0] & 0x20) !== 0

    let offset = RTP_HEADER_BYTES + csrcCount * 4
    if (packet.length < offset) return null
    if (hasExtension) {
      if (packet.length < offset + 4) return null
      offset += 4 + packet.readUInt16BE(offset + 2) * 4
      if (packet.length < offset) return null
    }
    let end = packet.length
    if (hasPadding) {
      const padding = packet[end - 1]
      if (padding === 0 || end - padding < offset) return null
      end -= padding
    }

    return {
      payloadType: packet[1] & 0x7f,
      marker: (packet[1] & 0x80) !== 0,
      sequenceNumber: packet.readUInt16BE(2),
      timestamp: packet.readUInt32BE(4),
      ssrc: packet.readUInt32BE(8),
      payload: packet.subarray(offset, end)
    }
  }

  onVideoRTP (packet) {
    const parsed = RTSPClient.parseRTP(packet)
    if (parsed === null) {
      this.stats.malformedRTP = (this.stats.malformedRTP || 0) + 1
      return
    }

    this.stats.videoPackets += 1
    this.stats.videoBytes += parsed.payload.length

    if (this.lastVideoSequence !== null) {
      // 16-bit wrap: the signed difference keeps working across 65535.
      const delta = ((parsed.sequenceNumber - this.lastVideoSequence + 32768) & 0xffff) - 32768
      if (delta > 1) this.stats.sequenceGaps += delta - 1
    }
    this.lastVideoSequence = parsed.sequenceNumber

    if (this.firstVideoTimestamp === null) this.firstVideoTimestamp = parsed.timestamp
    if (this.lastVideoTimestamp !== null && parsed.timestamp < this.lastVideoTimestamp) {
      this.stats.timestampRegressions += 1
    }

    // A timestamp change ends the previous picture, and it has to be handled before this packet's
    // NALs are added — otherwise the first NAL of the new frame is counted into the old one and every
    // frame is counted twice.
    if (this.lastVideoTimestamp !== null && parsed.timestamp !== this.lastVideoTimestamp) {
      this.completeFrame()
    }
    this.lastVideoTimestamp = parsed.timestamp

    const units = this.videoDepacketizer.push(parsed.payload)
    for (const nal of units) {
      const described = this.describeNAL(nal)
      if (described.isParameterSet) this.stats.parameterSets += 1
      if (described.isKeyframe) this.frameHasKeyframe = true
      this.currentFrame.push(nal)
    }

    if (parsed.marker) this.completeFrame()
  }

  completeFrame () {
    if (this.currentFrame.length === 0) return
    this.stats.frames += 1
    if (this.frameHasKeyframe) this.stats.keyframes += 1
    this.frameHasKeyframe = false

    if (this.videoOut) {
      for (const nal of this.currentFrame) {
        fs.writeSync(this.videoOut, Buffer.from([0, 0, 0, 1]))
        fs.writeSync(this.videoOut, nal)
      }
    }
    this.currentFrame = []
  }

  onAudioRTP (packet) {
    const parsed = RTSPClient.parseRTP(packet)
    if (parsed === null) return

    this.stats.audioPackets += 1
    if (this.lastAudioSequence !== null) {
      const delta = ((parsed.sequenceNumber - this.lastAudioSequence + 32768) & 0xffff) - 32768
      if (delta > 1) this.stats.audioSequenceGaps = (this.stats.audioSequenceGaps || 0) + delta - 1
    }
    this.lastAudioSequence = parsed.sequenceNumber
    if (this.firstAudioTimestamp === null) this.firstAudioTimestamp = parsed.timestamp
    this.lastAudioTimestamp = parsed.timestamp

    const units = this.audioDepacketizer.push(parsed.payload)
    for (const unit of units) {
      this.stats.audioAccessUnits += 1
      this.stats.audioBytes += unit.length
      if (this.audioOut) {
        const header = adtsHeader(unit.length, this.audioSampleRate, this.audioChannelCount)
        if (header) {
          fs.writeSync(this.audioOut, header)
          fs.writeSync(this.audioOut, unit)
        }
      }
    }
  }

  onRTCP (packet) {
    const parsed = parseRTCP(packet)
    this.stats.rtcpSenderReports += parsed.senderReports.length
    if (Object.keys(parsed.sdes).length > 0) this.stats.rtcp = parsed.sdes
  }

  describeNAL (nal) {
    return this.codec === 'hevc' ? HEVCDepacketizer.describe(nal) : H264Depacketizer.describe(nal)
  }

  async run () {
    await this.connect()

    const options = await this.request('OPTIONS', this.baseURL)
    if (options.statusCode !== 200) throw new Error(`OPTIONS returned ${options.statusCode}`)
    for (const method of ['DESCRIBE', 'SETUP', 'PLAY', 'TEARDOWN']) {
      if (!(options.headers.public || '').includes(method)) {
        throw new Error(`OPTIONS does not advertise ${method}: ${options.headers.public}`)
      }
    }

    const describe = await this.request('DESCRIBE', this.baseURL, { Accept: 'application/sdp' })
    if (describe.statusCode !== 200) throw new Error(`DESCRIBE returned ${describe.statusCode}`)
    if ((describe.headers['content-type'] || '') !== 'application/sdp') {
      throw new Error(`DESCRIBE returned ${describe.headers['content-type']}`)
    }

    const sdp = parseSDP(describe.body)
    const base = (describe.headers['content-base'] || this.baseURL).replace(/\/$/, '')
    const video = sdp.media.find((m) => m.kind === 'video')
    const audio = sdp.media.find((m) => m.kind === 'audio')
    if (!video) throw new Error('the SDP advertises no video track')

    const encoding = (video.rtpmap && video.rtpmap.encoding || '').toUpperCase()
    if (encoding === 'H264') this.codec = 'h264'
    else if (encoding === 'H265' || encoding === 'HEVC') this.codec = 'hevc'
    else throw new Error(`unexpected video encoding ${encoding}`)

    this.videoDepacketizer = this.codec === 'hevc' ? new HEVCDepacketizer() : new H264Depacketizer()

    // The parameter sets must be in the SDP: a client that waits for the in-band copy shows nothing
    // until the next keyframe.
    const sdpParameterSets = this.codec === 'h264'
      ? (video.fmtp['sprop-parameter-sets'] || '').split(',').filter(Boolean)
      : ['sprop-vps', 'sprop-sps', 'sprop-pps'].map((k) => video.fmtp[k]).filter(Boolean)
    if (sdpParameterSets.length < 2) {
      throw new Error(`the SDP carries ${sdpParameterSets.length} parameter sets`)
    }

    const cnames = new Set()
    for (const attributes of Object.values(video.ssrcAttributes)) {
      if (attributes.cname) cnames.add(attributes.cname)
    }
    this.sdpCNAME = [...cnames][0] || null

    if (audio) {
      this.audioSampleRate = audio.rtpmap.clockRate
      this.audioChannelCount = audio.rtpmap.channels || 1
      this.audioDepacketizer = new AACDepacketizer({
        sizeLength: Number(audio.fmtp.sizelength || 13),
        indexLength: Number(audio.fmtp.indexlength || 3),
        indexDeltaLength: Number(audio.fmtp.indexdeltalength || 3)
      })
    } else if (this.options.requireAudio) {
      throw new Error('the SDP advertises no audio track')
    }

    if (this.options.out) this.videoOut = fs.openSync(this.options.out, 'w')
    if (this.options.audioOut && audio) this.audioOut = fs.openSync(this.options.audioOut, 'w')

    // The parameter sets go into the file first, so ffprobe can decode from the very first frame
    // rather than waiting for an in-band copy.
    if (this.videoOut) {
      for (const encoded of sdpParameterSets) {
        fs.writeSync(this.videoOut, Buffer.from([0, 0, 0, 1]))
        fs.writeSync(this.videoOut, Buffer.from(encoded, 'base64'))
      }
    }

    const videoURL = absoluteControlURL(video.control, base)
    const videoSetup = await this.request('SETUP', videoURL, {
      Transport: `RTP/AVP/TCP;unicast;interleaved=${this.options.videoChannel}-${this.options.videoChannel + 1}`
    })
    if (videoSetup.statusCode !== 200) throw new Error(`video SETUP returned ${videoSetup.statusCode}`)
    this.session = (videoSetup.headers.session || '').split(';')[0]
    if (!this.session) throw new Error('SETUP returned no Session header')
    // The server names the channels it will use, which need not be the ones asked for.
    const videoChannels = /interleaved=(\d+)-(\d+)/.exec(videoSetup.headers.transport || '')
    if (!videoChannels) throw new Error(`video SETUP returned ${videoSetup.headers.transport}`)
    this.options.videoChannel = Number(videoChannels[1])

    if (audio) {
      const audioSetup = await this.request('SETUP', absoluteControlURL(audio.control, base), {
        Transport: `RTP/AVP/TCP;unicast;interleaved=${this.options.audioChannel}-${this.options.audioChannel + 1}`
      })
      if (audioSetup.statusCode !== 200) throw new Error(`audio SETUP returned ${audioSetup.statusCode}`)
      const audioChannels = /interleaved=(\d+)-(\d+)/.exec(audioSetup.headers.transport || '')
      if (audioChannels) this.options.audioChannel = Number(audioChannels[1])
    }

    const play = await this.request('PLAY', this.baseURL, { Range: 'npt=now-' })
    if (play.statusCode !== 200) throw new Error(`PLAY returned ${play.statusCode}`)

    const startedAt = Date.now()
    await new Promise((resolve) => setTimeout(resolve, this.options.seconds * 1000))
    const elapsed = (Date.now() - startedAt) / 1000

    const teardown = await this.request('TEARDOWN', this.baseURL)
    if (teardown.statusCode !== 200) throw new Error(`TEARDOWN returned ${teardown.statusCode}`)

    this.completeFrame()
    if (this.videoOut) fs.closeSync(this.videoOut)
    if (this.audioOut) fs.closeSync(this.audioOut)
    this.socket.destroy()

    this.stats.unsupportedUnits = this.videoDepacketizer.unsupported
    const clockRate = video.rtpmap.clockRate
    const videoDuration = this.lastVideoTimestamp === null
      ? 0
      : (this.lastVideoTimestamp - this.firstVideoTimestamp) / clockRate

    return {
      sessionName: sdp.name,
      sdpCNAME: this.sdpCNAME,
      codec: this.codec,
      elapsed,
      videoDuration,
      measuredFrameRate: videoDuration > 0 ? this.stats.frames / videoDuration : 0,
      measuredBitrate: elapsed > 0 ? Math.round((this.stats.videoBytes * 8) / elapsed) : 0,
      audioDuration: this.audioSampleRate && this.lastAudioTimestamp !== null
        ? (this.lastAudioTimestamp - this.firstAudioTimestamp) / this.audioSampleRate
        : 0,
      ...this.stats
    }
  }
}

/// Finds a Cameraman on the local network by Bonjour, so a run does not need a hard-coded address.
function discover (timeout = 5000) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const question = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      ...'_rtsp._tcp.local'.split('.').map((label) => Buffer.concat([
        Buffer.from([label.length]), Buffer.from(label, 'ascii')
      ])),
      Buffer.from([0x00, 0x00, 0x0c, 0x00, 0x01])
    ])

    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('no _rtsp._tcp service answered within ' + timeout + ' ms'))
    }, timeout)

    socket.on('message', (message, remote) => {
      // Any answer at all means something is advertising; the address is what matters here.
      if (message.length > 12) {
        clearTimeout(timer)
        socket.close()
        resolve(remote.address)
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      socket.close()
      reject(error)
    })
    socket.bind(() => {
      socket.setMulticastTTL(255)
      socket.send(question, 5353, '224.0.0.251')
    })
  })
}

async function main () {
  const options = parseArgs(process.argv)

  if (!options.host) {
    if (!options.discover) throw new Error('--host is required (or --discover)')
    options.host = await discover()
    process.stderr.write(`discovered ${options.host}\n`)
  }

  const client = new RTSPClient(options)
  const report = await client.run()

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    for (const [key, value] of Object.entries(report)) {
      process.stdout.write(`${key}: ${JSON.stringify(value)}\n`)
    }
  }

  // The checks that decide the exit code. A client that connects and receives nothing is the exact
  // failure this whole script exists to catch, so "it ran" is not success.
  const problems = []
  if (report.frames === 0) problems.push('no video frames were received')
  if (report.keyframes === 0) problems.push('no keyframe was received')
  if (report.sequenceGaps > 0) problems.push(`${report.sequenceGaps} RTP sequence gaps`)
  if (report.timestampRegressions > 0) {
    problems.push(`${report.timestampRegressions} timestamp regressions`)
  }
  if (report.unsupportedUnits > 0) {
    problems.push(`${report.unsupportedUnits} packets used an unimplemented payload form`)
  }
  if (report.malformedRTP) problems.push(`${report.malformedRTP} malformed RTP packets`)
  if (Object.keys(report.unknownChannels).length > 0) {
    problems.push(`media arrived on unexpected channels ${Object.keys(report.unknownChannels)}`)
  }
  if (report.measuredFrameRate < 20) {
    problems.push(`frame rate ${report.measuredFrameRate.toFixed(1)} is below 20`)
  }
  if (options.requireAudio && report.audioAccessUnits === 0) {
    problems.push('no audio access units were received')
  }
  if (!report.rtcp || !report.rtcp.cname) problems.push('no RTCP SDES CNAME was received')
  if (report.rtcp && report.sdpCNAME && report.rtcp.cname !== report.sdpCNAME) {
    // RFC 5576 requires them to be the same string.
    problems.push(`SDP cname ${report.sdpCNAME} != RTCP CNAME ${report.rtcp.cname}`)
  }

  if (problems.length > 0) {
    process.stderr.write('FAILED:\n' + problems.map((p) => `  - ${p}`).join('\n') + '\n')
    process.exit(1)
  }
  process.stderr.write('OK\n')
}

main().catch((error) => {
  process.stderr.write(`FAILED: ${error.message}\n`)
  process.exit(1)
})
