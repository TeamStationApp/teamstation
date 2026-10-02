#!/usr/bin/env node
'use strict'

// An RTMP ingest that accepts a publish and then stops reading, on purpose.
//
// This is the peer that killed TS Director on 2026-09-05: the handshake completes, the publish
// is accepted, and then the socket stops draining while the encoder keeps producing. A server
// that closes the connection proves nothing — that path was always handled. The interesting
// case is the one that stays open and silent.
//
//   node scripts/rtmpStallServer.js --stall-after 60            # stall a minute in, stay stalled
//   node scripts/rtmpStallServer.js --stall-after 60 --stall-for 20   # stall, then resume
//   node scripts/rtmpStallServer.js --port 1935 --verbose
//
// Point Director's stream URL at rtmp://<this-mac>:1935/live/<anything>.

const net = require('node:net')

const CHUNK_SIZE_IN = 128
const OUT_CHUNK = 128

function parseArgs(argv) {
  const options = { port: 1935, stallAfter: 0, stallFor: 0, verbose: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const next = argv[i + 1]
    if (flag === '--port' && next) { options.port = Number(next); i += 1 }
    else if (flag === '--stall-after' && next) { options.stallAfter = Number(next); i += 1 }
    else if (flag === '--stall-for' && next) { options.stallFor = Number(next); i += 1 }
    else if (flag === '--verbose') options.verbose = true
    else if (flag === '--frames') options.frames = true
    else if (flag.startsWith('--')) throw new Error(`unknown flag ${flag}`)
  }
  return options
}

// ---- AMF0 encoding (only the shapes the client reads back) ----

function amfNumber(value) {
  const buffer = Buffer.alloc(9)
  buffer.writeUInt8(0x00, 0)
  buffer.writeDoubleBE(value, 1)
  return buffer
}

function amfBoolean(value) {
  return Buffer.from([ 0x01, value ? 1 : 0 ])
}

function amfString(value) {
  const bytes = Buffer.from(value, 'utf8')
  const header = Buffer.alloc(3)
  header.writeUInt8(0x02, 0)
  header.writeUInt16BE(bytes.length, 1)
  return Buffer.concat([ header, bytes ])
}

function amfNull() {
  return Buffer.from([ 0x05 ])
}

function amfObject(entries) {
  const parts = []
  for (const [ key, value ] of Object.entries(entries)) {
    const name = Buffer.from(key, 'utf8')
    const length = Buffer.alloc(2)
    length.writeUInt16BE(name.length, 0)
    parts.push(length, name, value)
  }
  return Buffer.concat([ Buffer.from([ 0x03 ]), ...parts, Buffer.from([ 0x00, 0x00, 0x09 ]) ])
}

// ---- AMF0 decoding (command name and transaction id only) ----

function readAmfValue(buffer, offset) {
  if (offset >= buffer.length) return null
  const marker = buffer.readUInt8(offset)
  if (marker === 0x00) return { value: buffer.readDoubleBE(offset + 1), next: offset + 9 }
  if (marker === 0x01) return { value: buffer.readUInt8(offset + 1) !== 0, next: offset + 2 }
  if (marker === 0x02) {
    const length = buffer.readUInt16BE(offset + 1)
    return { value: buffer.slice(offset + 3, offset + 3 + length).toString('utf8'), next: offset + 3 + length }
  }
  if (marker === 0x05 || marker === 0x06) return { value: null, next: offset + 1 }
  if (marker === 0x03) {
    let cursor = offset + 1
    while (cursor + 2 <= buffer.length) {
      const keyLength = buffer.readUInt16BE(cursor)
      if (keyLength === 0) return { value: {}, next: cursor + 3 }
      cursor += 2 + keyLength
      const parsed = readAmfValue(buffer, cursor)
      if (!parsed) break
      cursor = parsed.next
    }
    return { value: {}, next: buffer.length }
  }
  return null
}

// ---- chunk framing ----

function encodeChunk(chunkStreamID, messageTypeID, messageStreamID, payload) {
  const header = Buffer.alloc(12)
  header.writeUInt8(chunkStreamID & 0x3f, 0)
  header.writeUIntBE(0, 1, 3)
  header.writeUIntBE(payload.length, 4, 3)
  header.writeUInt8(messageTypeID, 7)
  header.writeUInt32LE(messageStreamID, 8)
  const pieces = [ header ]
  let offset = 0
  while (offset < payload.length) {
    if (offset > 0) pieces.push(Buffer.from([ 0xc0 | (chunkStreamID & 0x3f) ]))
    const take = Math.min(OUT_CHUNK, payload.length - offset)
    pieces.push(payload.slice(offset, offset + take))
    offset += take
  }
  return Buffer.concat(pieces)
}

function command(values) {
  return encodeChunk(3, 20, 0, Buffer.concat(values))
}

// ---- connection ----

function handle(socket, options, log) {
  socket.setNoDelay(true)
  let buffered = Buffer.alloc(0)
  let stage = 'c0c1'
  let chunkSizeIn = CHUNK_SIZE_IN
  const partial = new Map()
  const previous = new Map()
  let mediaBytes = 0
  let stalled = false

  const stall = () => {
    if (stalled) return
    stalled = true
    socket.pause()
    log(`STALL reading stopped after ${mediaBytes} media bytes`)
    if (options.stallFor > 0) {
      setTimeout(() => {
        stalled = false
        socket.resume()
        log('RESUME reading again')
      }, options.stallFor * 1000)
    }
  }

  if (options.stallAfter > 0) setTimeout(stall, options.stallAfter * 1000)

  // With --frames, every 10 s: video messages and keyframes received, so a keyframe storm or a
  // doubled frame rate shows on the wire rather than only in the sender's own counters.
  const frames = { video: 0, keyframes: 0 }
  const frameTimer = options.frames
    ? setInterval(() => {
      log(`frames video=${frames.video} keyframes=${frames.keyframes} per 10 s`)
      frames.video = 0
      frames.keyframes = 0
    }, 10_000)
    : null

  socket.on('data', chunk => {
    buffered = Buffer.concat([ buffered, chunk ])
    mediaBytes += chunk.length

    if (stage === 'c0c1') {
      if (buffered.length < 1537) return
      const c1 = buffered.slice(1, 1537)
      buffered = buffered.slice(1537)
      // S0 + S1 + S2. S2 echoes C1, which is all any client checks in practice.
      socket.write(Buffer.concat([ Buffer.from([ 3 ]), Buffer.alloc(1536), c1 ]))
      stage = 'c2'
      log('handshake: sent S0 S1 S2')
    }
    if (stage === 'c2') {
      if (buffered.length < 1536) return
      buffered = buffered.slice(1536)
      stage = 'chunks'
      log('handshake: complete')
    }

    while (stage === 'chunks') {
      const parsed = readChunk(buffered, chunkSizeIn, partial, previous)
      if (!parsed) break
      buffered = parsed.rest
      if (parsed.message) {
        const payload = parsed.message.payload
        // FLV video tag: high nibble 1 is a keyframe; AVC packet type 1 is a picture, 0 the config.
        if (parsed.message.type === 9 && payload.length > 1 && payload.readUInt8(1) === 1) {
          frames.video += 1
          if (payload.readUInt8(0) >> 4 === 1) frames.keyframes += 1
        }
        const result = onMessage(parsed.message, socket, log)
        if (result && result.chunkSize) chunkSizeIn = result.chunkSize
      }
    }
  })

  socket.on('error', error => log(`socket error ${error.message}`))
  socket.on('close', () => {
    if (frameTimer) clearInterval(frameTimer)
    log(`closed after ${mediaBytes} bytes`)
  })
}

function readChunk(buffer, chunkSize, partial, previous) {
  if (buffer.length < 1) return null
  let offset = 0
  const first = buffer.readUInt8(offset)
  const fmt = first >> 6
  let csid = first & 0x3f
  offset += 1
  if (csid === 0) {
    if (buffer.length < offset + 1) return null
    csid = 64 + buffer.readUInt8(offset)
    offset += 1
  } else if (csid === 1) {
    if (buffer.length < offset + 2) return null
    csid = 64 + buffer.readUInt8(offset) + buffer.readUInt8(offset + 1) * 256
    offset += 2
  }

  const headerSize = fmt === 0 ? 11 : fmt === 1 ? 7 : fmt === 2 ? 3 : 0
  if (buffer.length < offset + headerSize) return null
  const prior = previous.get(csid) ?? { length: 0, type: 0, streamID: 0 }
  let length = prior.length
  let type = prior.type
  let streamID = prior.streamID
  let timestamp = 0
  if (fmt <= 2) {
    timestamp = buffer.readUIntBE(offset, 3)
    if (fmt <= 1) {
      length = buffer.readUIntBE(offset + 3, 3)
      type = buffer.readUInt8(offset + 6)
    }
    if (fmt === 0) streamID = buffer.readUInt32LE(offset + 7)
  }
  offset += headerSize
  if (timestamp === 0xffffff) {
    if (buffer.length < offset + 4) return null
    offset += 4
  }
  previous.set(csid, { length, type, streamID })

  const held = partial.get(csid) ?? Buffer.alloc(0)
  const take = Math.min(chunkSize, length - held.length)
  if (buffer.length < offset + take) return null
  const body = buffer.slice(offset, offset + take)
  const rest = buffer.slice(offset + take)
  const combined = Buffer.concat([ held, body ])
  if (combined.length < length) {
    partial.set(csid, combined)
    return { rest, message: null }
  }
  partial.delete(csid)
  return { rest, message: { type, streamID, payload: combined } }
}

function onMessage(message, socket, log) {
  if (message.type === 1) {
    const size = message.payload.readUInt32BE(0)
    log(`client set chunk size ${size}`)
    return { chunkSize: size }
  }
  // onMetaData (AMF0 data message): log the frame rate the sender declares.
  if (message.type === 18) {
    const at = message.payload.indexOf('framerate')
    if (at >= 0 && message.payload.length >= at + 18 && message.payload.readUInt8(at + 9) === 0) {
      log(`metadata framerate=${message.payload.readDoubleBE(at + 10)}`)
    }
    return null
  }
  if (message.type !== 20) {
    return null
  }
  const name = readAmfValue(message.payload, 0)
  if (!name) return null
  const tx = readAmfValue(message.payload, name.next)
  const transaction = tx && typeof tx.value === 'number' ? tx.value : 0
  log(`command ${name.value}#${transaction}`)

  if (name.value === 'connect') {
    // Window Ack Size, then Set Peer Bandwidth, then the _result the client waits on.
    const ack = Buffer.alloc(4)
    ack.writeUInt32BE(2_500_000, 0)
    socket.write(encodeChunk(2, 5, 0, ack))
    const bandwidth = Buffer.alloc(5)
    bandwidth.writeUInt32BE(2_500_000, 0)
    bandwidth.writeUInt8(2, 4)
    socket.write(encodeChunk(2, 6, 0, bandwidth))
    socket.write(command([
      amfString('_result'),
      amfNumber(transaction),
      amfObject({ fmsVer: amfString('FMS/3,0,1,123'), capabilities: amfNumber(31) }),
      amfObject({
        level: amfString('status'),
        code: amfString('NetConnection.Connect.Success'),
        description: amfString('Connection succeeded.')
      })
    ]))
    return null
  }

  if (name.value === 'createStream') {
    // The client reads the stream id out of the fourth value.
    socket.write(command([
      amfString('_result'),
      amfNumber(transaction),
      amfNull(),
      amfNumber(1)
    ]))
    return null
  }

  if (name.value === 'publish') {
    socket.write(command([
      amfString('onStatus'),
      amfNumber(0),
      amfNull(),
      amfObject({
        level: amfString('status'),
        code: amfString('NetStream.Publish.Start'),
        description: amfString('Start publishing'),
        clientid: amfBoolean(true)
      })
    ]))
    return null
  }

  return null
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const log = message => {
    if (options.verbose) process.stdout.write(`[rtmp-stall] ${message}\n`)
  }
  const server = net.createServer(socket => {
    process.stdout.write(`[rtmp-stall] connection from ${socket.remoteAddress}\n`)
    handle(socket, options, log)
  })
  server.listen(options.port, () => {
    const stall = options.stallAfter > 0
      ? `stalling ${options.stallAfter}s in` + (options.stallFor > 0 ? ` for ${options.stallFor}s` : ' permanently')
      : 'never stalling'
    process.stdout.write(`[rtmp-stall] listening on ${options.port}, ${stall}\n`)
  })
}

main()
