import { expect } from 'chai'
import { describe, it } from 'mocha'

import { FakeRtmpServer } from './rtmpFake.test'
import {
  amfDecodeAll,
  amfEncode,
  amfEncodeAll,
  ChunkReader,
  FlvReader,
  MSG,
  parseRtmpUrl,
  RtmpPublisher,
  writeChunks
} from './rtmpPublish'

const URL = 'rtmp://ingest.example.test:1936/live/sk_000000000000'

function flvBytes(
  tags: Array<{ type: number; timestamp: number; data: Buffer }>
): Buffer {
  const header = Buffer.from([0x46, 0x4c, 0x56, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0])
  const parts = [header]
  for (const tag of tags) {
    const head = Buffer.alloc(11)
    head[0] = tag.type
    head.writeUIntBE(tag.data.length, 1, 3)
    head.writeUIntBE(tag.timestamp & 0xffffff, 4, 3)
    head[7] = (tag.timestamp >>> 24) & 0xff
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(11 + tag.data.length)
    parts.push(head, tag.data, tail)
  }
  return Buffer.concat(parts)
}

describe('RTMP publishing', function () {
  it('round-trips AMF0 values', function () {
    const values = [
      'connect',
      1,
      { app: 'live', nested: { ok: true }, list: [1, 'two'] },
      null,
      undefined,
      false
    ]
    expect(amfDecodeAll(amfEncodeAll(values))).deep.equals(values)
    const ecma = Buffer.concat([
      Buffer.from([8, 0, 0, 0, 1]),
      amfEncode({ a: 1 }).subarray(1)
    ])
    expect(amfDecodeAll(ecma)).deep.equals([{ a: 1 }])
    expect(() => amfDecodeAll(Buffer.from([0x11]))).throws(/marker 17/)
  })

  it('splits and rejoins messages across chunks, with extended timestamps', function () {
    const reader = new ChunkReader()
    const big = Buffer.alloc(300, 7)
    const bytes = Buffer.concat([
      writeChunks(
        {
          csid: 6,
          type: MSG.video,
          streamId: 1,
          timestamp: 0x1000000,
          payload: big
        },
        128
      ),
      writeChunks(
        {
          csid: 70,
          type: MSG.audio,
          streamId: 1,
          timestamp: 5,
          payload: Buffer.from([1, 2])
        },
        128
      )
    ])
    // Fed a byte at a time, as a socket may.
    const messages = [...bytes].flatMap(byte =>
      reader.push(Buffer.from([byte]))
    )
    expect(messages[0].payload).deep.equals(big)
    expect(messages[0].timestamp).equals(0x1000000)
    expect(messages[0].streamId).equals(1)
    // csid 70 is written with a one-byte basic header, read back as csid 6.
    expect(messages[1].type).equals(MSG.audio)
  })

  it('reads two- and three-byte basic headers, and type 1–3 chunk headers', function () {
    const reader = new ChunkReader()
    const fmt0 = writeChunks(
      {
        csid: 3,
        type: MSG.command,
        streamId: 0,
        timestamp: 10,
        payload: Buffer.from([1])
      },
      128
    )
    const fmt1 = Buffer.from([0x40 | 3, 0, 0, 5, 0, 0, 1, MSG.command, 2])
    const fmt2 = Buffer.from([0x80 | 3, 0, 0, 7, 3])
    const fmt3 = Buffer.from([0xc0 | 3, 4])
    const twoByte = Buffer.from([
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      1,
      MSG.command,
      0,
      0,
      0,
      0,
      9
    ])
    const threeByte = Buffer.from([
      1,
      1,
      0,
      0,
      0,
      1,
      0,
      0,
      1,
      MSG.command,
      0,
      0,
      0,
      0,
      8
    ])
    const out = reader.push(
      Buffer.concat([fmt0, fmt1, fmt2, fmt3, twoByte, threeByte])
    )
    expect(out.map(m => m.timestamp)).deep.equals([10, 15, 22, 29, 1, 1])
    expect(out.map(m => m.csid)).deep.equals([3, 3, 3, 3, 64, 65])
    expect(reader.push(Buffer.from([0]))).deep.equals([])
    expect(new ChunkReader().push(Buffer.from([1, 0]))).deep.equals([])
    const size = Buffer.alloc(4)
    size.writeUInt32BE(256)
    const setter = new ChunkReader()
    setter.push(
      writeChunks(
        {
          csid: 2,
          type: MSG.setChunkSize,
          streamId: 0,
          timestamp: 0,
          payload: size
        },
        128
      )
    )
    expect(setter.chunkSize).equals(256)
  })

  it('reads FLV tags however the bytes arrive', function () {
    const bytes = flvBytes([
      { type: 18, timestamp: 0, data: Buffer.from('meta') },
      { type: 9, timestamp: 0x01000010, data: Buffer.alloc(40, 1) }
    ])
    const reader = new FlvReader()
    const tags = [
      reader.push(bytes.subarray(0, 5)),
      reader.push(bytes.subarray(5, 30)),
      reader.push(bytes.subarray(30))
    ].flat()
    expect(
      tags.map(tag => [tag.type, tag.timestamp, tag.data.length])
    ).deep.equals([
      [18, 0, 4],
      [9, 0x01000010, 40]
    ])
    expect(() => new FlvReader().push(Buffer.alloc(13))).throws(/not an FLV/)
  })

  it('parses a URL into its parts, and never repeats a bad one', function () {
    expect(parseRtmpUrl(URL)).deep.equals({
      host: 'ingest.example.test',
      port: 1936,
      app: 'live',
      key: 'sk_000000000000',
      tcUrl: 'rtmp://ingest.example.test:1936/live'
    })
    expect(parseRtmpUrl('rtmp://h.example.test/live/k/x').port).equals(1935)
    let message = ''
    try {
      parseRtmpUrl('http://secret.example.test/key')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).match(/not rtmp/)
    expect(message).not.contains('secret')
  })

  it('connects, creates a stream, publishes and sends tags', async function () {
    const ack = Buffer.alloc(4)
    ack.writeUInt32BE(10)
    const ping = Buffer.from([0, 6, 0, 0, 0, 9])
    const server = new FakeRtmpServer({
      greet: [
        {
          csid: 2,
          type: MSG.windowAck,
          streamId: 0,
          timestamp: 0,
          payload: ack
        },
        {
          csid: 2,
          type: MSG.userControl,
          streamId: 0,
          timestamp: 0,
          payload: ping
        },
        {
          csid: 2,
          type: MSG.userControl,
          streamId: 0,
          timestamp: 0,
          payload: Buffer.from([0, 0, 0, 0, 0, 1])
        }
      ]
    })
    const publisher = new RtmpPublisher(server.socket, parseRtmpUrl(URL))
    await publisher.open()
    expect(publisher.streamId).equals(1)
    const names = server.commands().map(command => command[0])
    expect(names).deep.equals([
      'connect',
      'releaseStream',
      'FCPublish',
      'createStream',
      'publish'
    ])
    const connect = server.commands()[0][2] as Record<string, unknown>
    expect(connect.tcUrl).equals('rtmp://ingest.example.test:1936/live')
    expect(server.commands()[4][3]).equals('sk_000000000000')
    expect(server.received.some(m => m.type === MSG.ack)).equals(true)
    expect(
      server.received
        .find(m => m.type === MSG.userControl)!
        .payload.readUInt16BE(0)
    ).equals(7)
    publisher.sendTag({
      type: 18,
      timestamp: 0,
      data: amfEncodeAll(['onMetaData', { width: 1280 }])
    })
    publisher.sendTag({ type: 9, timestamp: 40, data: Buffer.alloc(5000, 2) })
    publisher.sendTag({ type: 8, timestamp: 40, data: Buffer.from([0xaf, 1]) })
    const media = server.received.filter(
      m => m.type !== MSG.command && m.csid >= 4
    )
    expect(media.map(m => [m.type, m.csid, m.streamId])).deep.equals([
      [18, 5, 1],
      [9, 6, 1],
      [8, 4, 1]
    ])
    expect(amfDecodeAll(media[0].payload)[0]).equals('@setDataFrame')
    expect(media[1].payload.length).equals(5000)
    publisher.close()
    expect(server.socket.destroyed).equals(true)
    expect(server.commands().at(-1)![0]).equals('deleteStream')
    expect(() => {
      publisher.sendTag({ type: 8, timestamp: 0, data: Buffer.alloc(1) })
    }).throws(/closed/)
    publisher.close()
  })

  it('rejects a refused connect or publish, and a dropped connection', async function () {
    const refuse = async (server: FakeRtmpServer): Promise<string> => {
      const publisher = new RtmpPublisher(server.socket, parseRtmpUrl(URL))
      return await publisher.open().then(
        () => 'opened',
        (error: unknown) => (error as Error).message
      )
    }
    expect(await refuse(new FakeRtmpServer({ refuseConnect: true }))).match(
      /refused: not allowed/
    )
    expect(
      await refuse(
        new FakeRtmpServer({ publishCode: 'NetStream.Publish.BadName' })
      )
    ).match(/BadName/)
    const held = new FakeRtmpServer({ hold: true })
    const pending = refuse(held)
    held.emit('error', new Error('reset'))
    expect(await pending).match(/connection failed: reset/)
    const closed = new FakeRtmpServer({ hold: true })
    const waiting = refuse(closed)
    closed.emit('close')
    expect(await waiting).match(/closed the connection/)
  })
})
