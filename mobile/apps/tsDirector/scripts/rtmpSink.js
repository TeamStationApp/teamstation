#!/usr/bin/env node
'use strict'

// A stand-in RTMP server for testing TS Director's stream: it takes what a publisher sends, saves it
// to disk exactly as sent, and checks it.
//
//   node scripts/rtmpSink.js [--port 19350] [--dir /tmp/rtmp-sink] [--expect-codec hevc|h264]
//                            [--expect-size 1920x1080] [--expect-fps 60] [--max-bitrate 10] [--once]
//
// Point Director's stream at rtmp://<this Mac's LAN address>:19350/live/<any key>.
//
// It speaks just enough RTMP to take a publish: the simple handshake, connect, createStream and
// publish, and the protocol control messages. Every audio, video and data message is written into an
// FLV file byte for byte, so the file is what went over the wire. That is what makes the checks
// worth having: Enhanced RTMP (the extension that carries H.265) is judged on the tags as the
// publisher framed them, not on something a real server re-packaged.
//
// Each connection gets its own file, and the sink keeps listening afterwards, the way a real server
// takes Director back after a reconnect. `--once` stops after one publish and exits non-zero if its
// check failed, for scripted runs.
//
// The default port is 19350, not 1935: on this bench Mac something takes LAN connections to 1935
// while a local listener still appears to own it.
//
// Checked per recording, and written next to it as JSON:
//   - the video codec as framed: Enhanced RTMP's FourCC (`hvc1`, `av01`, ...) or classic H.264, and
//     the audio codec; against --expect-codec when given;
//   - a sequence header (decoder configuration) before the first coded frame, for video and AAC;
//   - that the first picture is a keyframe, and how far apart keyframes are;
//   - gaps: any step between pictures longer than 2.5 frames, or between sound packets longer than
//     2.5 packets, which is what a dropped frame or a stalled sender looks like on arrival;
//   - timestamps that go backwards;
//   - frame rate and size (size from FFmpeg), against --expect-fps / --expect-size;
//   - the video bitrate in each whole second (min / mean / max), against --max-bitrate in Mbps;
//   - what connect and onMetaData announced (`fourCcList`, `videocodecid`, ...);
//   - that FFmpeg decodes the whole file without an error.

const net = require('net')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync, spawnSync } = require('child_process')

const options = {
  port: 19350,
  dir: '/tmp/rtmp-sink',
  expectCodec: null,
  expectSize: null,
  expectFps: null,
  maxBitrate: null,
  once: false
}

const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  const value = () => {
    const next = args[++i]
    if (next == null) fail(`${arg} needs a value`)
    return next
  }
  switch (arg) {
    case '--port': options.port = Number(value()); break
    case '--dir': options.dir = value(); break
    case '--expect-codec': options.expectCodec = value().toLowerCase().replace('h265', 'hevc'); break
    case '--expect-size': options.expectSize = value(); break
    case '--expect-fps': options.expectFps = Number(value()); break
    case '--max-bitrate': options.maxBitrate = Number(value()); break
    case '--once': options.once = true; break
    case '-h':
    case '--help':
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 38).join('\n'))
      process.exit(0)
      break
    default: fail(`unknown argument ${arg}`)
  }
}

function fail (message) {
  console.error(`✗ ${message}`)
  process.exit(2)
}

function stamp () {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// MARK: - AMF0

function amfEncode (value) {
  if (value === null || value === undefined) return Buffer.from([0x05])
  if (typeof value === 'number') {
    const b = Buffer.alloc(9); b[0] = 0x00; b.writeDoubleBE(value, 1); return b
  }
  if (typeof value === 'boolean') return Buffer.from([0x01, value ? 1 : 0])
  if (typeof value === 'string') {
    const s = Buffer.from(value, 'utf8'); const h = Buffer.alloc(3); h[0] = 0x02; h.writeUInt16BE(s.length, 1)
    return Buffer.concat([h, s])
  }
  const parts = [Buffer.from([0x03])]
  for (const [k, v] of Object.entries(value)) {
    const key = Buffer.from(k, 'utf8'); const kh = Buffer.alloc(2); kh.writeUInt16BE(key.length)
    parts.push(kh, key, amfEncode(v))
  }
  parts.push(Buffer.from([0x00, 0x00, 0x09]))
  return Buffer.concat(parts)
}

function amfDecodeAll (buf) {
  const values = []
  let at = 0
  function read () {
    const type = buf[at++]
    switch (type) {
      case 0x00: { const v = buf.readDoubleBE(at); at += 8; return v }
      case 0x01: return buf[at++] !== 0
      case 0x02: { const n = buf.readUInt16BE(at); at += 2; const s = buf.toString('utf8', at, at + n); at += n; return s }
      case 0x03:
      case 0x08: {
        if (type === 0x08) at += 4
        const obj = {}
        while (at < buf.length) {
          const n = buf.readUInt16BE(at); at += 2
          if (n === 0 && buf[at] === 0x09) { at++; break }
          const key = buf.toString('utf8', at, at + n); at += n
          obj[key] = read()
        }
        return obj
      }
      case 0x05: case 0x06: return null
      case 0x0a: { const n = buf.readUInt32BE(at); at += 4; const a = []; for (let i = 0; i < n; i++) a.push(read()); return a }
      case 0x0b: { const v = buf.readDoubleBE(at); at += 10; return new Date(v) }
      case 0x0c: { const n = buf.readUInt32BE(at); at += 4; const s = buf.toString('utf8', at, at + n); at += n; return s }
      default: throw new Error(`AMF0 type ${type} at ${at - 1}`)
    }
  }
  while (at < buf.length) values.push(read())
  return values
}

// MARK: - A connection

const CHUNK_OUT = 4096
const WINDOW = 2_500_000

class Session {
  constructor (socket) {
    this.socket = socket
    this.base = path.join(options.dir, `rtmp-${stamp()}-${crypto.randomBytes(2).toString('hex')}`)
    this.buffer = Buffer.alloc(0)
    this.state = 'c0c1'
    this.chunkIn = 128
    this.streams = new Map()
    this.received = 0
    this.acked = 0
    this.connect = null
    this.metadata = null
    this.publishName = null
    this.tags = []
    this.file = null
    this.bytesWritten = 0
    socket.on('data', (data) => this.onData(data))
    socket.on('error', () => {})
    socket.on('close', () => this.finish())
  }

  onData (data) {
    this.received += data.length
    this.buffer = Buffer.concat([this.buffer, data])
    try {
      this.process()
    } catch (error) {
      this.protocolError = String(error.message || error)
      this.socket.destroy()
    }
    if (this.received - this.acked >= WINDOW) {
      this.acked = this.received
      const b = Buffer.alloc(4); b.writeUInt32BE(this.received >>> 0)
      this.send(2, 0, 3, 0, b)
    }
  }

  process () {
    for (;;) {
      if (this.state === 'c0c1') {
        if (this.buffer.length < 1537) return
        const c1 = this.buffer.subarray(1, 1537)
        this.buffer = this.buffer.subarray(1537)
        const s1 = Buffer.alloc(1536); crypto.randomFillSync(s1, 8); s1.fill(0, 0, 8)
        this.socket.write(Buffer.concat([Buffer.from([0x03]), s1, c1]))
        this.state = 'c2'
      } else if (this.state === 'c2') {
        if (this.buffer.length < 1536) return
        this.buffer = this.buffer.subarray(1536)
        this.state = 'chunks'
      } else if (!this.readChunk()) {
        return
      }
    }
  }

  // One chunk, if a whole one has arrived.
  readChunk () {
    const b = this.buffer
    if (b.length < 1) return false
    let at = 0
    const fmt = b[0] >> 6
    let csid = b[0] & 0x3f
    at = 1
    if (csid === 0) { if (b.length < 2) return false; csid = b[1] + 64; at = 2 } else if (csid === 1) { if (b.length < 3) return false; csid = b[1] + b[2] * 256 + 64; at = 3 }
    const headerSize = [11, 7, 3, 0][fmt]
    if (b.length < at + headerSize) return false
    const prev = this.streams.get(csid) || { timestamp: 0, delta: 0, length: 0, type: 0, streamId: 0, extended: false, pending: null }
    const s = { ...prev }
    let field = null
    if (fmt <= 2) field = b.readUIntBE(at, 3)
    if (fmt <= 1) { s.length = b.readUIntBE(at + 3, 3); s.type = b[at + 6] }
    if (fmt === 0) s.streamId = b.readUInt32LE(at + 7)
    at += headerSize
    if (fmt <= 2) s.extended = field === 0xffffff
    if (s.extended) {
      if (b.length < at + 4) return false
      if (fmt <= 2) field = b.readUInt32BE(at)
      at += 4
    }
    const starting = !prev.pending || fmt !== 3
    if (fmt === 0) { s.timestamp = field; s.delta = 0 } else if (fmt === 1 || fmt === 2) { s.delta = field }
    if (starting && fmt !== 0) s.timestamp = (prev.timestamp + s.delta) >>> 0
    const have = starting ? 0 : prev.pending.length
    const take = Math.min(this.chunkIn, s.length - have)
    if (b.length < at + take) return false
    const payload = b.subarray(at, at + take)
    s.pending = starting ? Buffer.from(payload) : Buffer.concat([prev.pending, payload])
    this.buffer = b.subarray(at + take)
    if (s.pending.length >= s.length) {
      const message = s.pending
      s.pending = null
      this.streams.set(csid, s)
      this.onMessage(s.type, s.timestamp, s.streamId, message)
    } else {
      this.streams.set(csid, s)
    }
    return true
  }

  send (csid, timestamp, type, streamId, payload) {
    const parts = []
    for (let at = 0; at < payload.length || at === 0; at += CHUNK_OUT) {
      if (at === 0) {
        const h = Buffer.alloc(12)
        h[0] = csid & 0x3f
        h.writeUIntBE(Math.min(timestamp, 0xffffff), 1, 3)
        h.writeUIntBE(payload.length, 4, 3)
        h[7] = type
        h.writeUInt32LE(streamId, 8)
        parts.push(h)
      } else {
        parts.push(Buffer.from([0xc0 | (csid & 0x3f)]))
      }
      parts.push(payload.subarray(at, at + CHUNK_OUT))
      if (payload.length === 0) break
    }
    if (!this.socket.destroyed) this.socket.write(Buffer.concat(parts))
  }

  command (streamId, ...values) {
    this.send(streamId === 0 ? 3 : 5, 0, 20, streamId, Buffer.concat(values.map(amfEncode)))
  }

  onMessage (type, timestamp, streamId, payload) {
    switch (type) {
      case 1: this.chunkIn = payload.readUInt32BE(0) & 0x7fffffff; break
      case 2: this.streams.forEach((s) => { s.pending = null }); break
      case 3: case 4: case 5: case 6: break
      case 20: this.onCommand(streamId, amfDecodeAll(payload)); break
      case 8: case 9: this.write(type, timestamp, payload); break
      case 18: this.onData18(timestamp, payload); break
      default: break
    }
  }

  onCommand (streamId, values) {
    const [name, transaction] = values
    switch (name) {
      case 'connect': {
        this.connect = values[2] || {}
        const ack = Buffer.alloc(4); ack.writeUInt32BE(WINDOW)
        this.send(2, 0, 5, 0, ack)
        const bw = Buffer.alloc(5); bw.writeUInt32BE(WINDOW); bw[4] = 2
        this.send(2, 0, 6, 0, bw)
        const size = Buffer.alloc(4); size.writeUInt32BE(CHUNK_OUT)
        this.send(2, 0, 1, 0, size)
        const reply = {
          level: 'status',
          code: 'NetConnection.Connect.Success',
          description: 'Connection succeeded.',
          objectEncoding: 0
        }
        // Enhanced RTMP: a server says which codecs it takes by echoing the list.
        if (this.connect.fourCcList) reply.fourCcList = this.connect.fourCcList
        this.command(0, '_result', transaction, { fmsVer: 'FMS/3,5,7,7009', capabilities: 31 }, reply)
        break
      }
      case 'createStream':
        this.command(0, '_result', transaction, null, 1)
        break
      case 'publish':
        this.publishName = values[3]
        this.command(streamId, 'onStatus', 0, null, {
          level: 'status', code: 'NetStream.Publish.Start', description: `${values[3]} is now published.`
        })
        console.log(`▸ publish "${this.publishName}" from ${this.socket.remoteAddress}, writing ${path.basename(this.base)}.flv`)
        break
      case 'deleteStream':
      case 'FCUnpublish':
        break
      default:
        if (transaction) this.command(0, '_result', transaction, null, null)
    }
  }

  onData18 (timestamp, payload) {
    let values
    try { values = amfDecodeAll(payload) } catch { return }
    let body = payload
    if (values[0] === '@setDataFrame') {
      // Stored without the wrapper, as a player expects it.
      body = Buffer.concat(values.slice(1).map(amfEncode))
      values = values.slice(1)
    }
    if (values[0] === 'onMetaData') this.metadata = values[1]
    this.write(18, timestamp, body)
  }

  write (type, timestamp, payload) {
    if (!this.file) {
      fs.mkdirSync(options.dir, { recursive: true })
      this.file = fs.openSync(`${this.base}.flv`, 'w')
      fs.writeSync(this.file, Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0, 0, 0, 9, 0, 0, 0, 0]))
    }
    const header = Buffer.alloc(11)
    header[0] = type
    header.writeUIntBE(payload.length, 1, 3)
    header.writeUIntBE(timestamp & 0xffffff, 4, 3)
    header[7] = (timestamp >>> 24) & 0xff
    const size = Buffer.alloc(4); size.writeUInt32BE(payload.length + 11)
    fs.writeSync(this.file, Buffer.concat([header, payload, size]))
    this.bytesWritten += payload.length
    if (type === 8 || type === 9) this.tags.push(describe(type, timestamp, payload))
  }

  finish () {
    if (this.finished) return
    this.finished = true
    sessions.delete(this)
    if (!this.file) {
      // A connection that never published is a port probe or a client giving up; one that published
      // and then sent nothing is a failed stream, and says so.
      if (!this.publishName) return
      console.log(`✘ publish "${this.publishName}" ended without any audio or video${this.protocolError ? ` (RTMP: ${this.protocolError})` : ''}`)
      failures++
      if (options.once) {
        server.close()
        process.exit(1)
      }
      return
    }
    fs.closeSync(this.file)
    const report = check(this)
    fs.writeFileSync(`${this.base}.json`, JSON.stringify(report, null, 2))
    print(report, `${this.base}.json`)
    if (!report.pass) failures++
    if (options.once) {
      server.close()
      process.exit(failures > 0 ? 1 : 0)
    }
  }
}

// What one audio or video tag says about itself, from its first bytes.
function describe (type, timestamp, p) {
  if (type === 9) {
    const first = p[0]
    if (first & 0x80) {
      // Enhanced RTMP: [IsExHeader:1][FrameType:3][PacketType:4], then a FourCC.
      const packetType = first & 0x0f
      return {
        kind: 'video',
        timestamp,
        size: p.length,
        enhanced: true,
        fourcc: p.toString('latin1', 1, 5),
        key: ((first >> 4) & 0x07) === 1,
        sequenceHeader: packetType === 0,
        coded: packetType === 1 || packetType === 3,
        end: packetType === 2
      }
    }
    const codecId = first & 0x0f
    const avcPacket = p[1]
    return {
      kind: 'video',
      timestamp,
      size: p.length,
      enhanced: false,
      codecId,
      key: (first >> 4) === 1,
      sequenceHeader: codecId === 7 && avcPacket === 0,
      coded: codecId !== 7 || avcPacket === 1,
      end: codecId === 7 && avcPacket === 2
    }
  }
  const soundFormat = p[0] >> 4
  return {
    kind: 'audio',
    timestamp,
    size: p.length,
    soundFormat,
    sequenceHeader: soundFormat === 10 && p[1] === 0,
    coded: soundFormat !== 10 || p[1] === 1
  }
}

function median (values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const codecNames = { hvc1: 'hevc', av01: 'av1', vp09: 'vp9', avc1: 'h264' }
const soundNames = { 10: 'aac', 2: 'mp3', 11: 'speex' }

function analyse (tags, kind, problems) {
  const all = tags.filter((t) => t.kind === kind)
  if (all.length === 0) return null
  const coded = all.filter((t) => t.coded)
  const firstCoded = all.findIndex((t) => t.coded)
  const firstHeader = all.findIndex((t) => t.sequenceHeader)
  if (firstHeader < 0 || (firstCoded >= 0 && firstHeader > firstCoded)) {
    problems.push(`${kind}: no sequence header before the first coded frame`)
  }
  const times = coded.map((t) => t.timestamp)
  const steps = times.slice(1).map((t, i) => t - times[i])
  const step = median(steps.filter((s) => s > 0))
  const gaps = []
  let backwards = 0
  steps.forEach((s, i) => {
    if (s < 0) backwards++
    if (step > 0 && s > step * 2.5) gaps.push({ at: times[i] / 1000, seconds: s / 1000 })
  })
  if (gaps.length) problems.push(`${kind}: ${gaps.length} gap(s), the first at ${gaps[0].at.toFixed(2)} s (${gaps[0].seconds} s)`)
  if (backwards) problems.push(`${kind}: ${backwards} timestamp(s) went backwards`)
  const first = times[0] ?? 0
  const last = times[times.length - 1] ?? 0
  const perSecond = new Map()
  for (const t of coded) {
    const second = Math.floor((t.timestamp - first) / 1000)
    perSecond.set(second, (perSecond.get(second) || 0) + t.size * 8)
  }
  // The last second is usually partial, so it is left out of the rates.
  const whole = [...perSecond.entries()].filter(([s]) => s < Math.floor((last - first) / 1000)).map(([, bits]) => bits / 1e6)
  return {
    all,
    coded,
    summary: {
      frames: coded.length,
      start: first / 1000,
      duration: (last - first) / 1000,
      gaps: gaps.length,
      firstGaps: gaps.slice(0, 20),
      backwards,
      mbps: whole.length
        ? {
            min: Number(Math.min(...whole).toFixed(2)),
            mean: Number((whole.reduce((a, b) => a + b, 0) / whole.length).toFixed(2)),
            max: Number(Math.max(...whole).toFixed(2))
          }
        : null
    }
  }
}

function check (session) {
  const problems = []
  const report = {
    file: `${session.base}.flv`,
    publishName: session.publishName,
    connect: session.connect,
    metadata: session.metadata,
    streams: {},
    problems,
    pass: true
  }
  if (session.protocolError) problems.push(`RTMP: ${session.protocolError}`)

  const video = analyse(session.tags, 'video', problems)
  if (video) {
    const firstCoded = video.coded[0]
    const enhanced = video.all.some((t) => t.enhanced)
    const fourccs = [...new Set(video.all.filter((t) => t.enhanced).map((t) => t.fourcc))]
    const codec = enhanced ? (codecNames[fourccs[0]] || fourccs[0]) : (video.all[0].codecId === 7 ? 'h264' : `codecId ${video.all[0].codecId}`)
    const keys = video.coded.filter((t) => t.key).map((t) => t.timestamp)
    const keySteps = keys.slice(1).map((t, i) => (t - keys[i]) / 1000)
    const fps = video.coded.length > 1 ? (video.coded.length - 1) / video.summary.duration : 0
    report.streams.video = {
      codec,
      framing: enhanced ? `Enhanced RTMP (${fourccs.join(', ')})` : 'classic FLV',
      fps: Number(fps.toFixed(2)),
      firstIsKeyframe: firstCoded?.key ?? false,
      keyframes: keys.length,
      keyframeInterval: keySteps.length
        ? { median: Number(median(keySteps).toFixed(3)), max: Number(Math.max(...keySteps).toFixed(3)) }
        : null,
      ...video.summary
    }
    if (enhanced && fourccs.length > 1) problems.push(`video: more than one FourCC (${fourccs.join(', ')})`)
    if (!report.streams.video.firstIsKeyframe) problems.push('video does not open on a keyframe')
    if (options.expectCodec && codec !== options.expectCodec) problems.push(`video codec ${codec}, expected ${options.expectCodec}`)
    if (options.expectFps && Math.abs(fps - options.expectFps) > options.expectFps * 0.01) {
      problems.push(`video at ${fps.toFixed(2)} fps, expected ${options.expectFps}`)
    }
    if (options.maxBitrate && video.summary.mbps && video.summary.mbps.max > options.maxBitrate) {
      problems.push(`video reached ${video.summary.mbps.max} Mbps in a second, above ${options.maxBitrate}`)
    }
  } else {
    problems.push('no video')
  }

  const audio = analyse(session.tags, 'audio', problems)
  if (audio) {
    report.streams.audio = { codec: soundNames[audio.all[0].soundFormat] || `soundFormat ${audio.all[0].soundFormat}`, ...audio.summary }
    delete report.streams.audio.mbps
  } else {
    problems.push('no audio')
  }
  if (video && audio) report.audioStartsAfterVideo = Number((audio.summary.start - video.summary.start).toFixed(3))

  // FFmpeg's view of the same bytes: the size it decodes to, and whether it decodes cleanly.
  try {
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', report.file]).toString())
    const v = (probe.streams || []).find((s) => s.codec_type === 'video')
    if (v && report.streams.video) {
      report.streams.video.size = `${v.width}x${v.height}`
      report.streams.video.profile = v.profile
      if (options.expectSize && report.streams.video.size !== options.expectSize) {
        problems.push(`video size ${report.streams.video.size}, expected ${options.expectSize}`)
      }
    }
  } catch (error) {
    problems.push(`ffprobe could not read the file: ${String(error.message).split('\n')[0]}`)
  }
  const decode = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', report.file, '-f', 'null', '-'], { encoding: 'utf8' })
  const decodeErrors = (decode.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean)
  report.decodeErrors = decodeErrors.slice(0, 30)
  if (decodeErrors.length) problems.push(`FFmpeg reported ${decodeErrors.length} error(s) decoding the file`)

  report.pass = problems.length === 0
  return report
}

function print (report, jsonFile) {
  const v = report.streams.video
  const a = report.streams.audio
  console.log(report.pass ? '✔ stream checked: no problems' : '✘ stream checked: problems found')
  if (v) {
    console.log(`  video ${v.codec} (${v.framing})${v.profile ? ` ${v.profile}` : ''} ${v.size || ''} ${v.fps} fps, ` +
      `${v.duration} s, ${v.mbps ? `${v.mbps.min}/${v.mbps.mean}/${v.mbps.max} Mbps min/mean/max` : 'no whole second'}, ` +
      `keyframes every ${v.keyframeInterval ? v.keyframeInterval.median : '?'} s`)
  }
  if (a) console.log(`  audio ${a.codec}, ${a.duration} s`)
  for (const problem of report.problems) console.log(`  - ${problem}`)
  console.log(`  report: ${jsonFile}`)
}

const sessions = new Set()
let failures = 0
const server = net.createServer((socket) => {
  socket.setNoDelay(true)
  sessions.add(new Session(socket))
})
server.on('error', (error) => fail(`cannot listen on port ${options.port}: ${error.message}`))
server.listen(options.port, '0.0.0.0', () => {
  console.log(`▸ listening on rtmp://0.0.0.0:${options.port}/live/<key>, saving to ${options.dir}`)
})

process.on('SIGINT', () => {
  // Every open publish is closed and checked before exiting.
  server.close()
  for (const session of [...sessions]) session.socket.destroy()
  setTimeout(() => process.exit(failures > 0 ? 1 : 0), 200)
})
