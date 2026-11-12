import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { FakeRtmpServer } from './rtmpFake.test'
import {
  BACKGROUND,
  clockLayout,
  clockText,
  counterLayout,
  glyph,
  INK,
  isFlashFrame,
  LABEL_ORIGIN,
  pixel,
  renderAudio,
  renderFrame,
  samplesForFrame,
  segmentCentre,
  SEGMENTS,
  WHITE
} from './syntheticFrames'
import {
  type ChildLike,
  ffmpegArgs,
  nodeDeps,
  type PublisherDeps,
  readSecretFile,
  redact,
  SyntheticPublisher
} from './syntheticPublisher'

const URL = 'rtmp://ingest.example.test:1936/live/sk_0000000000000000'

describe('the synthetic frames', function () {
  // Frame 3 is the first after the flash, 100 ms in at 30 fps.
  const start = Date.UTC(2026, 0, 1, 12, 34, 56, 689)

  it('burns the wall clock into known pixels as seven segments', function () {
    const frame = renderFrame({
      index: 3,
      startEpochMs: start,
      label: 'Synthetic'
    })
    const text = clockText(start + 100)
    expect(text).equals('12:34:56.789')
    const { boxes, stroke } = clockLayout()
    Array.from(text).forEach((char, index) => {
      const lit = SEGMENTS[char]
      if (lit == null) return
      for (const segment of 'abcdefg') {
        const [x, y] = segmentCentre(boxes[index], stroke, segment)
        expect(pixel(frame, x, y), `${char} ${segment}`).deep.equals(
          lit.includes(segment) ? INK : BACKGROUND
        )
      }
    })
  })

  it('burns the frame counter and the label', function () {
    const frame = renderFrame({ index: 1234, startEpochMs: start, label: 'C' })
    const { boxes, stroke } = counterLayout()
    // 00001234: the last digit is 4, which lights f and not a.
    expect(pixel(frame, ...segmentCentre(boxes[7], stroke, 'f'))).deep.equals(
      INK
    )
    expect(pixel(frame, ...segmentCentre(boxes[7], stroke, 'a'))).deep.equals(
      BACKGROUND
    )
    // C's top row is 01110: its second cell is lit, its first is not.
    const { x, y, scale } = LABEL_ORIGIN
    expect(pixel(frame, x + scale + 1, y + 1)).deep.equals(WHITE)
    expect(pixel(frame, x + 1, y + 1)).deep.equals(BACKGROUND)
    expect(glyph('?')).equals(glyph(' '))
  })

  it('flashes white for the first three frames of every ten seconds', function () {
    const flashing = Array.from({ length: 700 }, (_, index) => index).filter(
      index => isFlashFrame(index)
    )
    expect(flashing).deep.equals([0, 1, 2, 300, 301, 302, 600, 601, 602])
    const frame = renderFrame({ index: 300, startEpochMs: start, label: 'x' })
    expect(pixel(frame, 640, 360)).deep.equals(WHITE)
    expect(pixel(frame, 0, 0)).deep.equals(WHITE)
  })

  it('sounds a 1 kHz burst under each flash and silence between', function () {
    const burst = renderAudio(0, 4800)
    // A quarter period in, a 1 kHz sine at 48 kHz is at its peak.
    expect(burst.readInt16LE(12 * 2)).equals(16000)
    const after = renderAudio(9600, 100)
    expect(
      [...new Int16Array(after.buffer, after.byteOffset, 100)].every(
        v => v === 0
      )
    ).equals(true)
    expect(renderAudio(480000 + 12, 1).readInt16LE(0)).equals(16000)
    expect(samplesForFrame(0)).deep.equals([0, 1600])
    expect(samplesForFrame(29)).deep.equals([46400, 1600])
  })

  it('reads the clock in the bench time zone', function () {
    expect(clockText(Date.UTC(2026, 0, 1, 0, 0, 0, 5), -300)).equals(
      '19:00:00.005'
    )
  })
})

interface FakeChild extends ChildLike {
  frames: Buffer[]
  audio: Buffer[]
  killed: string[]
  ended: boolean
  exit: () => void
  out: (data: Buffer) => void
  err: (data: Buffer) => void
  /** Fails a pipe the way a write to an ffmpeg that has gone does. */
  pipeError: (pipe: 'stdin' | 'audio') => void
}

function fakeChild(exitOnEnd = true): FakeChild {
  const exits: Array<() => void> = []
  let out: (data: Buffer) => void = () => {}
  let err: (data: Buffer) => void = () => {}
  const pipeListeners: Record<string, (error: Error) => void> = {}
  const child: FakeChild = {
    frames: [],
    audio: [],
    killed: [],
    ended: false,
    stdin: {
      write: data => {
        child.frames.push(data)
        return true
      },
      end: () => {
        child.ended = true
        if (exitOnEnd) child.exit()
      },
      on: (_event, listener) => (pipeListeners.stdin = listener)
    },
    stdout: { on: (_event, listener) => (out = listener) },
    stderr: { on: (_event, listener) => (err = listener) },
    stdio: [
      null,
      null,
      null,
      {
        write: (data: Buffer) => {
          child.audio.push(data)
          return true
        },
        on: (_event: 'error', listener: (error: Error) => void) =>
          (pipeListeners.audio = listener)
      }
    ],
    kill: signal => {
      child.killed.push(String(signal))
      child.exit()
    },
    on: (_event, listener) => {
      exits.push(() => {
        listener(0)
      })
    },
    exit: () => {
      for (const fn of exits.splice(0)) fn()
    },
    out: data => {
      out(data)
    },
    err: data => {
      err(data)
    },
    pipeError: pipe => {
      pipeListeners[pipe](new Error('write EPIPE'))
    }
  }
  return child
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- a test rig's handles
function harness(
  options: { exitOnEnd?: boolean; server?: () => FakeRtmpServer } = {}
) {
  let now = 1_700_000_000_000
  const children: FakeChild[] = []
  const servers: FakeRtmpServer[] = []
  const spawned: Array<{ command: string; args: string[] }> = []
  const timers: Array<() => void> = []
  const cleared: unknown[] = []
  const logs: string[] = []
  const deps: PublisherDeps = {
    spawn: (command, args) => {
      spawned.push({ command, args })
      const child = fakeChild(options.exitOnEnd ?? true)
      children.push(child)
      return child
    },
    connect: (host, port) => {
      const server = options.server?.() ?? new FakeRtmpServer()
      server.host = host
      server.port = port
      servers.push(server)
      return server.socket
    },
    now: () => now,
    setInterval: fn => {
      timers.push(fn)
      return timers.length
    },
    clearInterval: handle => {
      cleared.push(handle)
    },
    sleep: async ms => {
      now += ms
    },
    readSecret: () => URL,
    log: line => {
      logs.push(line)
    }
  }
  return {
    deps,
    children,
    servers,
    spawned,
    timers,
    cleared,
    logs,
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe('the synthetic publisher', function () {
  it('never puts the URL, its key or its host on the command line', async function () {
    const rig = harness()
    const publisher = new SyntheticPublisher(
      {
        ffmpeg: '/opt/ffmpeg/bin/ffmpeg',
        urlFile: '/x/url',
        label: 'Synthetic'
      },
      rig.deps
    )
    await publisher.start()
    const { command, args } = rig.spawned[0]
    expect(command).equals('/opt/ffmpeg/bin/ffmpeg')
    const line = args.join(' ')
    for (const secret of [
      'rtmp://',
      'sk_0000000000000000',
      'ingest.example.test',
      '1936'
    ]) {
      expect(line).not.contains(secret)
    }
    expect(args).includes('libx265')
    expect(args.slice(-3)).deep.equals(['-f', 'flv', 'pipe:1'])
    expect(rig.servers[0].host).equals('ingest.example.test')
    expect(rig.servers[0].port).equals(1936)
    expect(publisher.running).equals(true)
    await publisher.stop()
  })

  it('writes the frames and sound the clock has reached, and sends FLV on', async function () {
    const rig = harness()
    const publisher = new SyntheticPublisher(
      { ffmpeg: 'ffmpeg', urlFile: '/x/url', label: 'C', fps: 10 },
      rig.deps
    )
    await publisher.start()
    rig.advance(1000)
    rig.timers[0]()
    const child = rig.children[0]
    expect(child.frames).length(11)
    expect(child.audio).length(11)
    expect(child.audio[0].length).equals(4800 * 2)
    const flv = Buffer.concat([
      Buffer.from([0x46, 0x4c, 0x56, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]),
      Buffer.from([9, 0, 0, 2, 0, 0, 40, 0, 0, 0, 0, 7, 7, 0, 0, 0, 13])
    ])
    child.out(flv)
    const video = rig.servers[0].received.filter(m => m.type === 9)
    expect(video.map(m => [m.timestamp, m.payload.length])).deep.equals([
      [40, 2]
    ])
    child.err(Buffer.from(`warning about ${URL}\n\n`))
    expect(rig.logs).deep.equals(['ffmpeg: warning about [redacted]'])
    await publisher.stop()
    expect(child.ended).equals(true)
    expect(rig.servers[0].socket.destroyed).equals(true)
    // What ffmpeg still flushes after a stop goes nowhere, and says nothing.
    child.out(flv.subarray(13))
    expect(rig.logs).deep.equals(['ffmpeg: warning about [redacted]'])
    expect(rig.servers).length(1)
  })

  it('cuts for the asked seconds and comes back on the same timeline', async function () {
    const rig = harness()
    const publisher = new SyntheticPublisher(
      { ffmpeg: 'ffmpeg', urlFile: '/x/url', label: 'C', fps: 2 },
      rig.deps
    )
    await publisher.start()
    rig.advance(60_000)
    rig.timers[0]()
    expect(rig.children[0].frames.length).equals(121)
    await publisher.cut(30)
    expect(rig.children[0].killed).deep.equals(['SIGKILL'])
    expect(rig.servers[0].socket.destroyed).equals(true)
    expect(rig.cleared).deep.equals([1])
    expect(rig.spawned).length(2)
    const second = rig.spawned[1].args
    expect(second[second.indexOf('-output_ts_offset') + 1]).equals('90.000')
    expect(
      rig.spawned[0].args[rig.spawned[0].args.indexOf('-output_ts_offset') + 1]
    ).equals('0.000')
    // The first frame after the cut is the one the wall clock is on, not the next unsent.
    rig.advance(600)
    rig.timers[1]()
    expect(rig.children[1].frames.length).equals(2)
    await publisher.cut(30, { discontinuity: true })
    const third = rig.spawned[2].args
    expect(third[third.indexOf('-output_ts_offset') + 1]).equals('0.000')
    expect(publisher.launches).length(3)
    await publisher.stop()
    expect(publisher.running).equals(false)
    await publisher.stop()
  })

  it('refuses to start twice or cut when stopped, and hides the URL when the server refuses', async function () {
    const rig = harness()
    const publisher = new SyntheticPublisher(
      { ffmpeg: 'ffmpeg', urlFile: '/x/url', label: 'C' },
      rig.deps
    )
    expect(
      await publisher.cut(5).then(
        () => '',
        (e: unknown) => (e as Error).message
      )
    ).match(/not running/)
    await publisher.start()
    expect(
      await publisher.start().then(
        () => '',
        (e: unknown) => (e as Error).message
      )
    ).match(/already running/)
    await publisher.stop()
    const refusing = harness({
      server: () =>
        new FakeRtmpServer({ publishCode: 'NetStream.Publish.BadName' })
    })
    const refused = new SyntheticPublisher(
      { ffmpeg: 'ffmpeg', urlFile: '/x/url', label: 'C' },
      refusing.deps
    )
    const message = await refused.start().then(
      () => '',
      (e: unknown) => (e as Error).message
    )
    expect(message).match(/BadName/)
    expect(refusing.spawned).length(0)
  })

  const ticks = async (): Promise<void> => {
    for (let i = 0; i < 20; i++)
      await new Promise(resolve => setImmediate(resolve))
  }
  const FINISHED = "This game's stream has already finished."

  it('says once when the ingest drops it, and reconnects once', async function () {
    const rig = harness()
    const publisher = new SyntheticPublisher(
      { ffmpeg: 'ffmpeg', urlFile: '/x/url', label: 'C' },
      rig.deps
    )
    await publisher.start()
    rig.servers[0].emit('close')
    rig.children[0].out(Buffer.from('FLV'))
    rig.children[0].out(Buffer.from('FLV'))
    await ticks()
    expect(
      rig.logs.filter(line => line.includes('closed the connection'))
    ).length(1)
    expect(rig.logs).includes('synthetic publisher: back on the ingest')
    expect(rig.servers).length(2)
    expect(rig.children[0].killed).deep.equals(['SIGKILL'])
    expect(publisher.running).equals(true)
    expect(publisher.down).equals(null)
    await publisher.stop()
  })

  it('stays down when the ingest refuses it, and every later cut says why', async function () {
    let made = 0
    const rig = harness({
      server: () =>
        made++ === 0
          ? new FakeRtmpServer()
          : new FakeRtmpServer({
              publishCode: 'NetStream.Publish.BadName',
              publishDescription: FINISHED
            })
    })
    const publisher = new SyntheticPublisher(
      { ffmpeg: 'ffmpeg', urlFile: '/x/url', label: 'C' },
      rig.deps
    )
    await publisher.start()
    rig.servers[0].emit('close')
    rig.children[0].out(Buffer.from('FLV'))
    await ticks()
    expect(publisher.down).equals(
      `the RTMP server refused to publish: NetStream.Publish.BadName: ${FINISHED}`
    )
    expect(rig.logs.at(-1)).match(/down for the rest of the run: .*finished/)
    expect(
      await publisher.cut(5).then(
        () => '',
        (e: unknown) => (e as Error).message
      )
    ).match(/^the synthetic camera is down: the ingest refused it/)
    expect(rig.servers).length(2)
    await publisher.stop()
  })

  it('tries a timed-out reconnect after a cut again, ten seconds later', async function () {
    let made = 0
    const rig = harness({
      server: () => {
        const server = new FakeRtmpServer({ hold: made === 1 || made === 2 })
        made++
        return server
      }
    })
    const publisher = new SyntheticPublisher(
      { ffmpeg: 'ffmpeg', urlFile: '/x/url', label: 'C' },
      rig.deps
    )
    await publisher.start()
    const cut = publisher.cut(5)
    // The first two reconnects never get the handshake back and time out.
    await ticks()
    rig.servers[1].emit('error', new Error('read ETIMEDOUT'))
    await ticks()
    rig.servers[2].emit('error', new Error('read ETIMEDOUT'))
    await cut
    expect(rig.servers).length(4)
    expect(
      rig.logs.filter(line => line.includes('could not reconnect'))
    ).length(2)
    expect(publisher.running).equals(true)
    expect(publisher.down).equals(null)
    await publisher.stop()
  })

  it('stays down when a cut comes back to a refusal', async function () {
    let made = 0
    const rig = harness({
      server: () =>
        made++ === 0
          ? new FakeRtmpServer()
          : new FakeRtmpServer({
              publishCode: 'NetStream.Publish.BadName',
              publishDescription: FINISHED
            })
    })
    const publisher = new SyntheticPublisher(
      { ffmpeg: 'ffmpeg', urlFile: '/x/url', label: 'C' },
      rig.deps
    )
    await publisher.start()
    expect(
      await publisher.cut(5).then(
        () => '',
        (e: unknown) => (e as Error).message
      )
    ).match(/finished/)
    expect(publisher.down).match(/finished/)
    expect(
      await publisher.cut(5).then(
        () => '',
        (e: unknown) => (e as Error).message
      )
    ).match(/^the synthetic camera is down/)
    expect(rig.servers).length(2)
  })

  it('logs a broken ffmpeg pipe instead of throwing, and stops feeding an ffmpeg that has gone', async function () {
    const rig = harness()
    const publisher = new SyntheticPublisher(
      { ffmpeg: '/f', urlFile: '/x/url', label: 'Synthetic' },
      rig.deps
    )
    await publisher.start()
    const child = rig.children[0]
    child.pipeError('stdin')
    child.pipeError('audio')
    expect(rig.logs.filter(line => line.includes('EPIPE'))).deep.equals([
      'synthetic publisher: ffmpeg stdin: write EPIPE',
      'synthetic publisher: ffmpeg audio: write EPIPE'
    ])
    rig.advance(1000)
    rig.timers[0]()
    const fed = child.frames.length
    expect(fed).greaterThan(0)
    child.exit()
    rig.advance(1000)
    rig.timers[0]()
    expect(child.frames.length).equals(fed)
    await publisher.stop()
  })

  it('kills an ffmpeg that does not finish after a graceful stop', async function () {
    const rig = harness({ exitOnEnd: false })
    const publisher = new SyntheticPublisher(
      { ffmpeg: 'ffmpeg', urlFile: '/x/url', label: 'C' },
      rig.deps
    )
    await publisher.start()
    await publisher.stop()
    expect(rig.children[0].killed).deep.equals(['SIGKILL'])
  })

  it('reads the URL only from a mode-600 file', function () {
    const dir = mkdtempSync(join(tmpdir(), 'soak-url-'))
    try {
      const path = join(dir, 'url')
      writeFileSync(path, `${URL}\n`, { mode: 0o600 })
      expect(readSecretFile(path)).equals(URL)
      chmodSync(path, 0o644)
      expect(() => readSecretFile(path)).throws(/mode 644/)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('builds its arguments and redacts its secrets', function () {
    const args = ffmpegArgs({
      fps: 30,
      tsOffsetSec: 1.5,
      videoArgs: ['-c:v', 'hevc_videotoolbox']
    })
    expect(args).includes('hevc_videotoolbox')
    expect(args[args.indexOf('-output_ts_offset') + 1]).equals('1.500')
    expect(args[args.indexOf('-s') + 1]).equals('1280x720')
    expect(redact('a key b', ['key', ''])).equals('a [redacted] b')
    expect(typeof nodeDeps.spawn).equals('function')
  })

  it('runs its default clock and sleep', async function () {
    const before = nodeDeps.now()
    await nodeDeps.sleep(1)
    expect(nodeDeps.now()).gte(before)
    let ticks = 0
    const handle = nodeDeps.setInterval(() => ticks++, 1)
    await nodeDeps.sleep(10)
    nodeDeps.clearInterval(handle)
    expect(ticks).gte(1)
    const said: unknown[] = []
    const original = console.log
    console.log = (line: unknown) => said.push(line)
    try {
      nodeDeps.log('hello')
    } finally {
      console.log = original
    }
    expect(said).deep.equals(['hello'])
  })
})
