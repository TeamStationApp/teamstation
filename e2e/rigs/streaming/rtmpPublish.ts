/**
 * Just enough RTMP to publish one stream: the simple handshake, connect, createStream,
 * publish, then FLV tags as audio, video and data messages. It exists so the stream URL,
 * which carries the key, never has to be on ffmpeg's command line: ffmpeg writes FLV to
 * its stdout and this sends it on.
 */

// AMF0 ----------------------------------------------------------------------------

export type Amf =
  number | boolean | string | null | undefined | AmfObject | Amf[]
export interface AmfObject {
  [key: string]: Amf
}

function encodeString(value: string): Buffer {
  const body = Buffer.from(value, 'utf8')
  const head = Buffer.alloc(2)
  head.writeUInt16BE(body.length)
  return Buffer.concat([head, body])
}

export function amfEncode(value: Amf): Buffer {
  if (typeof value === 'number') {
    const out = Buffer.alloc(9)
    out[0] = 0
    out.writeDoubleBE(value, 1)
    return out
  }
  if (typeof value === 'boolean') return Buffer.from([1, value ? 1 : 0])
  if (typeof value === 'string')
    return Buffer.concat([Buffer.from([2]), encodeString(value)])
  if (value === null) return Buffer.from([5])
  if (value === undefined) return Buffer.from([6])
  if (Array.isArray(value)) {
    const head = Buffer.alloc(5)
    head[0] = 10
    head.writeUInt32BE(value.length, 1)
    return Buffer.concat([head, ...value.map(amfEncode)])
  }
  const parts: Buffer[] = [Buffer.from([3])]
  for (const [key, entry] of Object.entries(value)) {
    parts.push(encodeString(key), amfEncode(entry))
  }
  parts.push(Buffer.from([0, 0, 9]))
  return Buffer.concat(parts)
}

export function amfEncodeAll(values: Amf[]): Buffer {
  return Buffer.concat(values.map(amfEncode))
}

function decodeOne(buf: Buffer, at: number): [Amf, number] {
  const marker = buf[at]
  const stringAt = (from: number): [string, number] => {
    const length = buf.readUInt16BE(from)
    return [
      buf.toString('utf8', from + 2, from + 2 + length),
      from + 2 + length
    ]
  }
  const objectAt = (from: number): [AmfObject, number] => {
    const out: AmfObject = {}
    let cursor = from
    for (;;) {
      if (buf.readUInt16BE(cursor) === 0 && buf[cursor + 2] === 9)
        return [out, cursor + 3]
      const [key, next] = stringAt(cursor)
      const [value, after] = decodeOne(buf, next)
      out[key] = value
      cursor = after
    }
  }
  switch (marker) {
    case 0:
      return [buf.readDoubleBE(at + 1), at + 9]
    case 1:
      return [buf[at + 1] !== 0, at + 2]
    case 2:
      return stringAt(at + 1)
    case 3:
      return objectAt(at + 1)
    case 5:
      return [null, at + 1]
    case 6:
      return [undefined, at + 1]
    case 8:
      return objectAt(at + 5)
    case 10: {
      const count = buf.readUInt32BE(at + 1)
      const items: Amf[] = []
      let cursor = at + 5
      for (let i = 0; i < count; i++) {
        const [item, next] = decodeOne(buf, cursor)
        items.push(item)
        cursor = next
      }
      return [items, cursor]
    }
    default:
      throw new Error(`AMF0 marker ${marker} is not supported`)
  }
}

export function amfDecodeAll(buf: Buffer): Amf[] {
  const out: Amf[] = []
  let at = 0
  while (at < buf.length) {
    const [value, next] = decodeOne(buf, at)
    out.push(value)
    at = next
  }
  return out
}

// Chunks ---------------------------------------------------------------------------

export interface RtmpMessage {
  csid: number
  type: number
  streamId: number
  timestamp: number
  payload: Buffer
}

export const MSG = {
  setChunkSize: 1,
  ack: 3,
  userControl: 4,
  windowAck: 5,
  peerBandwidth: 6,
  audio: 8,
  video: 9,
  data: 18,
  command: 20
} as const

/** Splits a message into chunks: a type-0 header, then type-3 continuations. */
export function writeChunks(message: RtmpMessage, chunkSize: number): Buffer {
  const extended = message.timestamp >= 0xffffff
  const header = Buffer.alloc(12)
  header[0] = message.csid & 0x3f
  header.writeUIntBE(extended ? 0xffffff : message.timestamp, 1, 3)
  header.writeUIntBE(message.payload.length, 4, 3)
  header[7] = message.type
  header.writeUInt32LE(message.streamId, 8)
  const ext = Buffer.alloc(extended ? 4 : 0)
  if (extended) ext.writeUInt32BE(message.timestamp >>> 0)
  const parts: Buffer[] = [header, ext]
  for (let at = 0; at < message.payload.length; at += chunkSize) {
    if (at > 0) parts.push(Buffer.from([0xc0 | (message.csid & 0x3f)]), ext)
    parts.push(message.payload.subarray(at, at + chunkSize))
  }
  return Buffer.concat(parts)
}

interface ChunkState {
  timestamp: number
  delta: number
  length: number
  type: number
  streamId: number
  extended: boolean
  body: Buffer[]
  received: number
}

/** Reassembles messages from a chunk stream, following the peer's chunk size. */
export class ChunkReader {
  private buffer = Buffer.alloc(0)
  private readonly streams = new Map<number, ChunkState>()
  chunkSize = 128

  push(data: Buffer): RtmpMessage[] {
    this.buffer = Buffer.concat([this.buffer, data])
    const out: RtmpMessage[] = []
    for (;;) {
      const message = this.next()
      if (message === null) return out
      if (message === undefined) continue
      if (message.type === MSG.setChunkSize) {
        this.chunkSize = message.payload.readUInt32BE(0) & 0x7fffffff
      }
      out.push(message)
    }
  }

  /** A whole message, undefined for a chunk that did not finish one, null to wait. */
  private next(): RtmpMessage | undefined | null {
    const buf = this.buffer
    if (buf.length < 1) return null
    const fmt = buf[0] >> 6
    let csid = buf[0] & 0x3f
    let at = 1
    if (csid === 0) {
      if (buf.length < 2) return null
      csid = buf[1] + 64
      at = 2
    } else if (csid === 1) {
      if (buf.length < 3) return null
      csid = buf[1] + buf[2] * 256 + 64
      at = 3
    }
    const sizes = [11, 7, 3, 0]
    if (buf.length < at + sizes[fmt]) return null
    const previous = this.streams.get(csid)
    const state: ChunkState = previous ?? {
      timestamp: 0,
      delta: 0,
      length: 0,
      type: 0,
      streamId: 0,
      extended: false,
      body: [],
      received: 0
    }
    let stamp = 0
    if (fmt <= 2) stamp = buf.readUIntBE(at, 3)
    if (fmt <= 1) {
      state.length = buf.readUIntBE(at + 3, 3)
      state.type = buf[at + 6]
    }
    if (fmt === 0) state.streamId = buf.readUInt32LE(at + 7)
    at += sizes[fmt]
    if (fmt <= 2) state.extended = stamp === 0xffffff
    if (state.extended) {
      if (buf.length < at + 4) return null
      stamp = fmt === 3 ? stamp : buf.readUInt32BE(at)
      at += 4
    }
    const starting = state.received === 0
    const take = Math.min(this.chunkSize, state.length - state.received)
    if (buf.length < at + take) return null
    if (starting) {
      if (fmt === 0) state.timestamp = stamp
      else if (fmt <= 2) {
        state.delta = stamp
        state.timestamp += stamp
      } else state.timestamp += state.delta
    }
    state.body.push(buf.subarray(at, at + take))
    state.received += take
    this.buffer = buf.subarray(at + take)
    this.streams.set(csid, state)
    if (state.received < state.length) return undefined
    const payload = Buffer.concat(state.body)
    state.body = []
    state.received = 0
    return {
      csid,
      type: state.type,
      streamId: state.streamId,
      timestamp: state.timestamp,
      payload
    }
  }
}

// FLV ------------------------------------------------------------------------------

export interface FlvTag {
  type: number
  timestamp: number
  data: Buffer
}

/** Reads FLV tags from a byte stream, header and all. */
export class FlvReader {
  private buffer = Buffer.alloc(0)
  private headerDone = false

  push(data: Buffer): FlvTag[] {
    this.buffer = Buffer.concat([this.buffer, data])
    const out: FlvTag[] = []
    if (!this.headerDone) {
      if (this.buffer.length < 13) return out
      if (this.buffer.toString('latin1', 0, 3) !== 'FLV') {
        throw new Error('not an FLV stream')
      }
      const headerSize = this.buffer.readUInt32BE(5)
      this.buffer = this.buffer.subarray(headerSize + 4)
      this.headerDone = true
    }
    while (this.buffer.length >= 11) {
      const size = this.buffer.readUIntBE(1, 3)
      if (this.buffer.length < 11 + size + 4) break
      const timestamp =
        this.buffer.readUIntBE(4, 3) + this.buffer[7] * 0x1000000
      out.push({
        type: this.buffer[0] & 0x1f,
        timestamp,
        data: Buffer.from(this.buffer.subarray(11, 11 + size))
      })
      this.buffer = this.buffer.subarray(11 + size + 4)
    }
    return out
  }
}

// The publisher --------------------------------------------------------------------

export interface RtmpSocket {
  write: (data: Buffer) => unknown
  on: (
    event: 'data' | 'close' | 'error',
    listener: (arg: any) => void
  ) => unknown
  destroy: () => unknown
}

export interface RtmpTarget {
  host: string
  port: number
  app: string
  key: string
  tcUrl: string
}

/** rtmp://host[:port]/app/key: the app is the first path part, the key the rest. */
export function parseRtmpUrl(url: string): RtmpTarget {
  const match = /^rtmp:\/\/([^/:]+)(?::(\d+))?\/([^/]+)\/(.+)$/.exec(url.trim())
  if (match == null) {
    // The URL is a secret: say what is wrong without repeating it.
    throw new Error('the RTMP URL is not rtmp://host[:port]/app/key')
  }
  const port = match[2] == null ? 1935 : Number(match[2])
  return {
    host: match[1],
    port,
    app: match[3],
    key: match[4],
    tcUrl: `rtmp://${match[1]}:${port}/${match[3]}`
  }
}

const OUT_CHUNK_SIZE = 4096
const HANDSHAKE = 1536

export class RtmpPublisher {
  private readonly reader = new ChunkReader()
  private handshake: Buffer | null = Buffer.alloc(0)
  private readonly waiting = new Map<number, (args: Amf[]) => void>()
  private statusWaiter: ((info: AmfObject) => void) | null = null
  private failure: ((error: Error) => void) | null = null
  private received = 0
  private windowAck = 0
  private acked = 0
  streamId = 0
  closed = false

  constructor(
    private readonly socket: RtmpSocket,
    private readonly target: RtmpTarget
  ) {
    socket.on('data', (data: Buffer) => {
      this.onData(data)
    })
    socket.on('error', (error: Error) => {
      this.fail(new Error(`RTMP connection failed: ${error.message}`))
    })
    socket.on('close', () => {
      this.closed = true
      this.fail(new Error('the RTMP server closed the connection'))
    })
  }

  private fail(error: Error): void {
    const failure = this.failure
    this.failure = null
    failure?.(error)
  }

  private send(message: RtmpMessage): void {
    this.socket.write(writeChunks(message, OUT_CHUNK_SIZE))
  }

  private command(values: Amf[], streamId = 0): void {
    this.send({
      csid: 3,
      type: MSG.command,
      streamId,
      timestamp: 0,
      payload: amfEncodeAll(values)
    })
  }

  private onData(data: Buffer): void {
    if (this.handshake != null) {
      this.handshake = Buffer.concat([this.handshake, data])
      if (this.handshake.length < 1 + 2 * HANDSHAKE) return
      const s1 = this.handshake.subarray(1, 1 + HANDSHAKE)
      const rest = this.handshake.subarray(1 + 2 * HANDSHAKE)
      this.handshake = null
      this.socket.write(Buffer.from(s1))
      this.afterHandshake()
      if (rest.length === 0) return
      data = rest
    }
    this.received += data.length
    for (const message of this.reader.push(data)) this.onMessage(message)
    if (this.windowAck > 0 && this.received - this.acked >= this.windowAck) {
      this.acked = this.received
      const payload = Buffer.alloc(4)
      payload.writeUInt32BE(this.received >>> 0)
      this.send({ csid: 2, type: MSG.ack, streamId: 0, timestamp: 0, payload })
    }
  }

  private onMessage(message: RtmpMessage): void {
    if (message.type === MSG.windowAck) {
      this.windowAck = message.payload.readUInt32BE(0)
      return
    }
    if (
      message.type === MSG.userControl &&
      message.payload.readUInt16BE(0) === 6
    ) {
      const payload = Buffer.from(message.payload)
      payload.writeUInt16BE(7, 0)
      this.send({
        csid: 2,
        type: MSG.userControl,
        streamId: 0,
        timestamp: 0,
        payload
      })
      return
    }
    if (message.type !== MSG.command) return
    const [name, txn, , info] = amfDecodeAll(message.payload)
    if (name === '_result' || name === '_error') {
      const resolve = this.waiting.get(Number(txn))
      this.waiting.delete(Number(txn))
      if (name === '_error') {
        const detail = (info as AmfObject | undefined)?.description
        this.fail(
          new Error(
            `the RTMP server refused: ${typeof detail === 'string' ? detail : 'no reason'}`
          )
        )
      } else resolve?.(amfDecodeAll(message.payload))
      return
    }
    if (name === 'onStatus') this.statusWaiter?.(info as AmfObject)
  }

  private afterHandshakeResolve: (() => void) | null = null
  private afterHandshake(): void {
    this.afterHandshakeResolve?.()
  }

  private async call(txn: number, values: Amf[], streamId = 0): Promise<Amf[]> {
    return await new Promise(resolve => {
      this.waiting.set(txn, resolve)
      this.command(values, streamId)
    })
  }

  /** Handshake, connect, createStream and publish; resolves once publishing starts. */
  async open(): Promise<void> {
    const failed = new Promise<never>((resolve, reject) => {
      this.failure = reject
    })
    const steps = async (): Promise<void> => {
      await new Promise<void>(resolve => {
        this.afterHandshakeResolve = resolve
        const c1 = Buffer.alloc(HANDSHAKE)
        c1.writeUInt32BE(0, 0)
        for (let i = 8; i < HANDSHAKE; i++) c1[i] = (i * 7919) & 0xff
        this.socket.write(Buffer.concat([Buffer.from([3]), c1]))
      })
      const size = Buffer.alloc(4)
      size.writeUInt32BE(OUT_CHUNK_SIZE)
      this.send({
        csid: 2,
        type: MSG.setChunkSize,
        streamId: 0,
        timestamp: 0,
        payload: size
      })
      const { app, key, tcUrl } = this.target
      await this.call(1, [
        'connect',
        1,
        {
          app,
          type: 'nonprivate',
          flashVer: 'FMLE/3.0 (compatible; TeamStation soak)',
          tcUrl,
          fourCcList: ['hvc1']
        }
      ])
      this.command(['releaseStream', 2, null, key])
      this.command(['FCPublish', 3, null, key])
      const created = await this.call(4, ['createStream', 4, null])
      this.streamId = Number(created[3])
      const started = new Promise<void>((resolve, reject) => {
        this.statusWaiter = info => {
          const code = typeof info?.code === 'string' ? info.code : ''
          if (code === 'NetStream.Publish.Start') resolve()
          else if (/error|badname|failed|rejected/i.test(code)) {
            reject(new Error(`the RTMP server refused to publish: ${code}`))
          }
        }
      })
      this.command(['publish', 5, null, key, 'live'], this.streamId)
      await started
    }
    await Promise.race([steps(), failed])
    // From here a failure is reported when the next tag is sent.
    this.failure = () => {}
  }

  sendTag(tag: FlvTag): void {
    if (this.closed) throw new Error('the RTMP connection is closed')
    const csid = tag.type === MSG.audio ? 4 : tag.type === MSG.video ? 6 : 5
    const payload =
      tag.type === MSG.data
        ? Buffer.concat([amfEncode('@setDataFrame'), tag.data])
        : tag.data
    this.send({
      csid,
      type: tag.type,
      streamId: this.streamId,
      timestamp: tag.timestamp,
      payload
    })
  }

  close(): void {
    if (!this.closed) {
      try {
        this.command(['deleteStream', 6, null, this.streamId])
      } catch {}
    }
    this.closed = true
    this.socket.destroy()
  }
}
