import type { IncomingMessage, ServerResponse } from 'node:http'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  AngleReplay,
  isKeyframe,
  parseReplayArgs,
  readFixture,
  type ReplayDeps,
  replayHandler
} from './replayServer'
import { FakeRtmpServer } from './rtmpFake.test'
import { type FlvTag, MSG } from './rtmpPublish'

/** An FLV file of `tags`, as ffmpeg writes one. */
export function flvOf(tags: FlvTag[]): Buffer {
  const parts = [Buffer.from([0x46, 0x4c, 0x56, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0])]
  for (const tag of tags) {
    const head = Buffer.alloc(11)
    head[0] = tag.type
    head.writeUIntBE(tag.data.length, 1, 3)
    head.writeUIntBE(tag.timestamp & 0xffffff, 4, 3)
    head[7] = (tag.timestamp >> 24) & 0xff
    const size = Buffer.alloc(4)
    size.writeUInt32BE(11 + tag.data.length)
    parts.push(head, tag.data, size)
  }
  return Buffer.concat(parts)
}

const key = (timestamp: number): FlvTag => ({
  type: MSG.video,
  timestamp,
  data: Buffer.from([0x1c, 1, timestamp & 0xff])
})
const inter = (timestamp: number): FlvTag => ({
  type: MSG.video,
  timestamp,
  data: Buffer.from([0x2c, 1, timestamp & 0xff])
})
const sound = (timestamp: number): FlvTag => ({
  type: MSG.audio,
  timestamp,
  data: Buffer.from([0xaf, 1, timestamp & 0xff])
})

/** A 200 ms fixture: a keyframe every 100 ms, a frame every 33. */
function fixture(): Buffer {
  return flvOf([
    { type: MSG.data, timestamp: 0, data: Buffer.from([2, 0, 1, 0x41]) },
    { type: MSG.video, timestamp: 0, data: Buffer.from([0x1c, 0, 0]) },
    { type: MSG.audio, timestamp: 0, data: Buffer.from([0xaf, 0, 0]) },
    key(0),
    sound(10),
    inter(33),
    inter(66),
    key(100),
    sound(110),
    inter(133),
    inter(166)
  ])
}

const URL = 'rtmp://ingest.test:1936/live/secret-key'

type ServerOptions = ConstructorParameters<typeof FakeRtmpServer>[0]

/** An angle on a fake clock, its connections to fake ingests, and readers of what each got. */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the rig's shape is what it returns
function rig(serverOptions: ServerOptions[] = []) {
  const clock = { t: 1_000_000 }
  const servers: FakeRtmpServer[] = []
  const log: string[] = []
  let tick: (() => void) | null = null
  const deps: ReplayDeps = {
    connect: (host, port) => {
      const server = new FakeRtmpServer(serverOptions[servers.length] ?? {})
      server.host = host
      server.port = port
      servers.push(server)
      return server.socket
    },
    now: () => clock.t,
    setInterval: fn => {
      tick = fn
      return fn
    },
    clearInterval: handle => {
      if (tick === handle) tick = null
    },
    sleep: async ms => {
      clock.t += ms
    },
    log: line => log.push(line)
  }
  const at = (ms: number): void => {
    clock.t = start + ms
    tick?.()
  }
  let start = 0
  const angle = new AngleReplay(readFixture('SynthA', fixture()), deps)
  const begin = async (): Promise<void> => {
    await angle.start(URL)
    start = angle.startedAtMs
  }
  /** The media a server got, past the sequence headers: [type, timestamp, the fixture tag's timestamp]. */
  const media = (server: FakeRtmpServer): Array<[number, number, number]> =>
    server.received
      .filter(
        m =>
          (m.type === MSG.video || m.type === MSG.audio) && m.payload[1] === 1
      )
      .map(m => [m.type, m.timestamp, m.payload[2]])
  /** The sequence headers a server got, with their timestamps. */
  const headers = (server: FakeRtmpServer): Array<[number, number]> =>
    server.received
      .filter(m => m.type !== MSG.command && m.payload[1] !== 1 && m.type !== 1)
      .map(m => [m.type, m.timestamp])
  return { angle, servers, clock, log, at, begin, media, headers, deps }
}

describe('replaying a fixture', function () {
  it('splits a fixture into what opens a connection and the media, and knows its loop', function () {
    const read = readFixture('SynthA', fixture())
    expect(read.config.map(tag => tag.type)).deep.equals([
      MSG.data,
      MSG.video,
      MSG.audio
    ])
    expect(read.media).length(8)
    expect(read.loopMs).equals(166 + 33)
    expect(isKeyframe(key(0))).equals(true)
    expect(isKeyframe(inter(33))).equals(false)
    expect(isKeyframe(sound(10))).equals(false)
    // The muxer's end of sequence (frame type 1, packet type 2) is no picture.
    const end = (timestamp: number): FlvTag => ({
      type: MSG.video,
      timestamp,
      data: Buffer.from([0x1c, 2])
    })
    expect(isKeyframe(end(199))).equals(false)
    // Nor in an enhanced tag: its packet type is in the first byte's low bits.
    expect(
      isKeyframe({
        type: MSG.video,
        timestamp: 0,
        data: Buffer.from([0x92, 0])
      })
    ).equals(false)
    expect(
      isKeyframe({
        type: MSG.video,
        timestamp: 0,
        data: Buffer.from([0x91, 0])
      })
    ).equals(true)
    expect(
      isKeyframe({
        type: MSG.video,
        timestamp: 0,
        data: Buffer.from([0x93, 0])
      })
    ).equals(true)
    const ended = readFixture(
      'SynthA',
      Buffer.concat([fixture(), flvOf([end(199)]).subarray(13)])
    )
    expect(ended.media).length(8)
    expect(ended.loopMs).equals(166 + 33)
    expect(() =>
      readFixture('SynthB', flvOf([key(0), inter(33), inter(66)]))
    ).throws('the SynthB fixture has no keyframes')
  })

  it('sends each tag when its time comes, and from the start again after the end', async function () {
    const r = rig()
    await r.begin()
    expect(r.angle.state).equals('live')
    const [server] = r.servers
    expect(server.host).equals('ingest.test')
    expect(server.port).equals(1936)
    // The sequence headers first, then nothing before its time.
    expect(r.headers(server)).deep.equals([
      [MSG.data, 0],
      [MSG.video, 0],
      [MSG.audio, 0]
    ])
    expect(r.media(server)).deep.equals([])
    r.at(0)
    expect(r.media(server)).deep.equals([[MSG.video, 0, 0]])
    r.at(40)
    expect(r.media(server).slice(1)).deep.equals([
      [MSG.audio, 10, 10],
      [MSG.video, 33, 33]
    ])
    // Past the end: the second loop, its timestamps carrying on.
    r.at(199 + 15)
    expect(r.media(server).slice(-2)).deep.equals([
      [MSG.video, 199, 0],
      [MSG.audio, 209, 10]
    ])
    expect(r.angle.describe()).deep.equals({
      label: 'SynthA',
      state: 'live',
      startedAtMs: 1_000_000,
      loopMs: 199
    })
  })

  it('comes back from a cut at the next keyframe where the stream would be, timestamps carrying on', async function () {
    const r = rig()
    await r.begin()
    r.at(40)
    // 50 ms of cut: back at 90, so at the keyframe of 100.
    r.clock.t = 1_000_000 + 40
    const cutting = r.angle.cut(0.05)
    await cutting
    expect(r.servers).length(2)
    expect(r.servers[0].socket.destroyed).equals(true)
    r.at(100)
    expect(r.media(r.servers[1])).deep.equals([[MSG.video, 100, 100]])
    // The sequence headers go again first, at 0, as an encoder sends them.
    expect(r.headers(r.servers[1])).deep.equals([
      [MSG.data, 0],
      [MSG.video, 0],
      [MSG.audio, 0]
    ])
  })

  it('leaves the stream to a start that came during a cut', async function () {
    const r = rig()
    await r.begin()
    let back: () => void = () => {}
    r.deps.sleep = async () => {
      await new Promise<void>(resolve => {
        back = resolve
      })
    }
    const cutting = r.angle.cut(64)
    await r.angle.start(URL)
    expect(r.servers).length(2)
    back()
    await cutting
    // The cut's own reopen never comes: one connection on the stream key.
    expect(r.servers).length(2)
    expect(r.angle.state).equals('live')
  })

  it('starts the timestamps from zero again after a cut with a discontinuity', async function () {
    const r = rig()
    await r.begin()
    r.at(40)
    await r.angle.cut(0.05, true)
    r.at(140)
    expect(r.media(r.servers[1])).deep.equals([
      [MSG.video, 0, 100],
      [MSG.audio, 10, 110],
      [MSG.video, 33, 133]
    ])
  })

  it('past the last keyframe of a loop, comes back at the next loop', async function () {
    const r = rig()
    await r.begin()
    r.clock.t = 1_000_000 + 120
    await r.angle.cut(0)
    r.at(199)
    expect(r.media(r.servers[1])[0]).deep.equals([MSG.video, 199, 0])
  })

  it('reconnects once when the ingest drops it, and says so', async function () {
    const r = rig()
    await r.begin()
    r.at(0)
    r.servers[0].emit('close')
    r.at(10)
    for (let i = 0; i < 20; i++)
      await new Promise(resolve => setImmediate(resolve))
    expect(r.servers).length(2)
    expect(r.angle.state).equals('live')
    expect(r.log).deep.equals([
      'SynthA: the ingest closed the connection; reconnecting once',
      'SynthA: back on the ingest'
    ])
  })

  it('stays down once the ingest refuses it, and never logs the URL', async function () {
    const r = rig([{}, { publishCode: 'NetStream.Publish.BadName' }])
    await r.begin()
    r.at(0)
    r.servers[0].emit('close')
    r.at(10)
    for (let i = 0; i < 20; i++)
      await new Promise(resolve => setImmediate(resolve))
    expect(r.angle.state).equals('refused')
    await r.angle
      .cut(1)
      .then(() => expect.fail('cut a refused camera'))
      .catch((error: unknown) => {
        expect((error as Error).message).includes('the SynthA camera is down')
      })
    expect(r.log.join('\n')).not.includes('secret-key')
    expect(r.angle.describe().reason).to.be.a('string')
  })

  it('a camera that is not running cannot be cut, and a stop ends it', async function () {
    const r = rig()
    await r.angle
      .cut(1)
      .catch((error: unknown) =>
        expect((error as Error).message).equals(
          'the SynthA camera is not running'
        )
      )
    await r.begin()
    await r.angle.stop()
    expect(r.angle.state).equals('ended')
    expect(r.servers[0].socket.destroyed).equals(true)
  })

  it('does not ask again after a refusal', async function () {
    const r = rig([{}, { refuseConnect: true }])
    await r.begin()
    let failure: Error | null = null
    await r.angle.cut(1).catch((error: unknown) => {
      failure = error as Error
    })
    expect(r.servers).length(2)
    expect(String(failure)).includes('refused')
    expect(r.angle.state).equals('refused')
  })

  for (const then of ['start', 'stop'] as const)
    it(`leaves the stream to a ${then} that came while a reconnect waited to try again`, async function () {
      const r = rig([{}, { hold: true }])
      // The cut's first reconnect goes before the handshake is answered.
      const connect = r.deps.connect
      r.deps.connect = (host, port) => {
        const socket = connect(host, port)
        const server = r.servers.at(-1)!
        if (r.servers.length === 2)
          setImmediate(() => {
            server.emit('close')
          })
        return socket
      }
      await r.begin()
      let sleeps = 0
      let tryAgain: () => void = () => {}
      let waiting: () => void = () => {}
      const retrying = new Promise<void>(resolve => {
        waiting = resolve
      })
      r.deps.sleep = async () => {
        sleeps += 1
        if (sleeps === 1) return
        waiting()
        await new Promise<void>(resolve => {
          tryAgain = resolve
        })
      }
      const cutting = r.angle.cut(1)
      await retrying
      if (then === 'start') await r.angle.start(URL)
      else await r.angle.stop()
      const opened = r.servers.length
      tryAgain()
      await cutting
      // The cut tries no more: one connection on the stream key, or none.
      expect(r.servers).length(opened)
      expect(r.angle.state).equals(then === 'start' ? 'live' : 'ended')
    })

  it('tries a cut camera three times when the network drops it, then gives up', async function () {
    const r = rig([{}, { hold: true }, { hold: true }, { hold: true }])
    // A connection that goes before the handshake is answered.
    const connect = r.deps.connect
    r.deps.connect = (host, port) => {
      const socket = connect(host, port)
      const server = r.servers.at(-1)!
      if (r.servers.length > 1)
        setImmediate(() => {
          server.emit('close')
        })
      return socket
    }
    await r.begin()
    let failure: Error | null = null
    await r.angle.cut(1).catch((error: unknown) => {
      failure = error as Error
    })
    expect(r.servers).length(4)
    expect(String(failure)).includes('closed the connection')
    expect(String(failure)).not.includes('secret-key')
    expect(r.angle.state).equals('refused')
    expect(r.log.filter(line => line.includes('trying again'))).length(2)
  })
})

interface Answer {
  status: number
  body: Record<string, unknown>
}

async function call(
  handler: ReturnType<typeof replayHandler>,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {}
): Promise<Answer> {
  const chunks =
    options.body === undefined
      ? []
      : [Buffer.from(JSON.stringify(options.body))]
  const req = {
    method,
    url: path,
    headers:
      options.token == null ? {} : { authorization: `Bearer ${options.token}` },
    async *[Symbol.asyncIterator]() {
      yield* chunks
    }
  } as unknown as IncomingMessage
  const answer: Answer = { status: 0, body: {} }
  const res = {
    writeHead: (status: number) => {
      answer.status = status
    },
    end: (text: string) => {
      answer.body = JSON.parse(text) as Record<string, unknown>
    }
  } as unknown as ServerResponse
  await handler(req, res)
  return answer
}

describe('the replay routes', function () {
  it('answer health without the token, and nothing else without it', async function () {
    const r = rig()
    const handler = replayHandler(new Map([['SynthA', r.angle]]), 'tok')
    expect(await call(handler, 'GET', '/__e2e/health')).deep.equals({
      status: 200,
      body: { status: 'ok' }
    })
    expect((await call(handler, 'GET', '/__e2e/publishers')).status).equals(401)
    expect(
      (await call(handler, 'GET', '/__e2e/publishers', { token: 'wrong' }))
        .status
    ).equals(401)
  })

  it('start, cut, list and stop an angle', async function () {
    const r = rig()
    const handler = replayHandler(new Map([['SynthA', r.angle]]), 'tok')
    const token = 'tok'
    const started = await call(handler, 'PUT', '/__e2e/publishers/SynthA', {
      token,
      body: { url: URL }
    })
    expect(started).deep.equals({
      status: 200,
      body: {
        label: 'SynthA',
        state: 'live',
        startedAtMs: 1_000_000,
        loopMs: 199
      }
    })
    const cut = await call(handler, 'POST', '/__e2e/publishers/SynthA/cut', {
      token,
      body: { seconds: 1 }
    })
    expect(cut.body.state).equals('live')
    const listed = await call(handler, 'GET', '/__e2e/publishers', { token })
    expect((listed.body.publishers as unknown[]).length).equals(1)
    const stopped = await call(handler, 'DELETE', '/__e2e/publishers/SynthA', {
      token
    })
    expect(stopped.body.state).equals('ended')
    expect(JSON.stringify([started, cut, listed, stopped])).not.includes(
      'secret-key'
    )
  })

  it('refuse what they do not know', async function () {
    const r = rig()
    const handler = replayHandler(new Map([['SynthA', r.angle]]), 'tok')
    const token = 'tok'
    expect(
      (
        await call(handler, 'PUT', '/__e2e/publishers/SynthZ', {
          token,
          body: {}
        })
      ).status
    ).equals(404)
    expect(
      (await call(handler, 'GET', '/__e2e/nothing', { token })).status
    ).equals(404)
    expect(
      (
        await call(handler, 'PUT', '/__e2e/publishers/SynthA', {
          token,
          body: {}
        })
      ).status
    ).equals(400)
    expect(
      (await call(handler, 'GET', '/__e2e/publishers/SynthA', { token })).status
    ).equals(405)
    expect(
      (await call(handler, 'POST', '/__e2e/publishers', { token })).status
    ).equals(405)
    // A cut of a camera that is not running is the publisher's failure.
    const failed = await call(handler, 'POST', '/__e2e/publishers/SynthA/cut', {
      token,
      body: { seconds: 1 }
    })
    expect(failed.status).equals(502)
    expect(failed.body.error).equals('the SynthA camera is not running')
  })

  it('reads its command line', function () {
    expect(
      parseReplayArgs(['--fixtures', '/f', '--token-file', '/t'])
    ).deep.equals({
      fixtures: '/f',
      tokenFile: '/t',
      port: 9400,
      host: '127.0.0.1',
      labels: ['SynthA', 'SynthB', 'SynthC', 'SynthD', 'Synthetic']
    })
    expect(
      parseReplayArgs([
        '--fixtures',
        '/f',
        '--token-file',
        '/t',
        '--port',
        '9500',
        '--host',
        '0.0.0.0',
        '--labels',
        'SynthA'
      ])
    ).deep.include({ port: 9500, host: '0.0.0.0', labels: ['SynthA'] })
    expect(() => parseReplayArgs(['--fixtures'])).throws('unknown or empty')
    expect(() => parseReplayArgs(['--fixtures', '/f'])).throws(
      '--token-file is needed'
    )
  })
})
