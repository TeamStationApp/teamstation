import { expect } from 'chai'
import type { ChildProcess, spawn } from 'child_process'
import { execFileSync } from 'child_process'
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { tmpdir } from 'os'
import { join } from 'path'

import { remuxToHls, VIDEO_FILE } from '../media/ffmpeg'
import { fileForRemux, timelineHole } from './finishVideo'
import {
  hevcInit,
  hevcSegment,
  IDR_SLICE,
  wallClockNal
} from './frameWallFixture'
import {
  segmentsFrom,
  stampNewSegments,
  timelineStartSec
} from './segmentClock'
import {
  attachSessionForTest,
  CAPTURE_LAG_MAX_MS,
  CAPTURE_LEAD_MAX_MS,
  clearLive,
  clearLiveSettled,
  codecName,
  codecRefusal,
  configureIngest,
  continuationFromCapture,
  forcePublishForTest,
  hideKey,
  isPublishableKey,
  keyFromSession,
  type LiveEvent,
  nextSegmentNumber,
  playlistContinuation,
  publishArrivedForTest,
  publishGoneForTest,
  reopenPlaylist,
  resetForTest,
  restartDelay,
  setLive,
  settleLastSegment,
  statusFor,
  type TestSession,
  tickSamplerForTest,
  writerZeroCapturedAt
} from './splitter'

/**
 * The ingest's state machine, without an RTMP server and without ffmpeg.
 *
 * What is worth testing here is the part that has gone wrong in production:
 * which children exist, which are allowed to come back, and what happens to a
 * publisher that stops sending without ever disconnecting. So the sockets are
 * fakes, the clock is a function call, and "ffmpeg" is a script that sleeps —
 * every one of those is a thing whose real version has nothing to teach us.
 */

/** Stands in for ffmpeg: takes any arguments, does nothing, waits to be killed. */
const FAKE_FFMPEG = join(tmpdir(), 'ts-live-test-ffmpeg.sh')
const KEY = 'ts_testkeytestkeytestkey'
const OTHER_KEY = 'ts_otherkeyotherkeyother'

let events: LiveEvent[] = []
let logs: string[] = []

function configure(): void {
  events = []
  logs = []
  configureIngest({
    ffmpegPath: FAKE_FFMPEG,
    bindHost: '127.0.0.1',
    port: 19_361,
    app: 'live',
    segmentSeconds: 4,
    log: message => {
      logs.push(message)
    },
    onEvent: event => {
      events.push(event)
    }
  })
}

function spec(destinations: string[] = []): {
  liveStreamId: string
  hlsDir: string
  destinations: string[]
} {
  return {
    liveStreamId: 'liv_test',
    hlsDir: join(tmpdir(), 'ts-live-test-hls'),
    destinations
  }
}

describe('live ingest', function () {
  before(function () {
    writeFileSync(FAKE_FFMPEG, '#!/bin/sh\nexec sleep 30\n')
    chmodSync(FAKE_FFMPEG, 0o755)
  })

  beforeEach(function () {
    configure()
  })

  afterEach(function () {
    resetForTest()
  })

  it('refuses a key that could be a path or an argument', function () {
    expect(isPublishableKey('ts_abcdefgh')).equals(true)
    expect(isPublishableKey('../../etc/passwd')).equals(false)
    expect(isPublishableKey('key with spaces')).equals(false)
    expect(isPublishableKey('-i')).equals(false)
    expect(isPublishableKey('short')).equals(false)
    expect(isPublishableKey(undefined)).equals(false)
  })

  it('reads the key however the address was spelled', function () {
    // What TS Director and ffmpeg send.
    expect(
      keyFromSession({ streamApp: 'live', streamName: KEY }, 'live')
    ).equals(KEY)
    // A URL pasted with a trailing slash.
    expect(
      keyFromSession({ streamApp: `live/${KEY}`, streamName: '' }, 'live')
    ).equals(KEY)
    // OBS: the whole URL in the server box, the key box left empty.
    expect(keyFromSession({ streamApp: `live/${KEY}` }, 'live')).equals(KEY)
    // Somebody else's server on the same port, and an address we cannot read.
    expect(
      keyFromSession({ streamApp: 'other', streamName: KEY }, 'live')
    ).equals(undefined)
    expect(
      keyFromSession({ streamApp: `live/${KEY}`, streamName: 'more' }, 'live')
    ).equals(undefined)
  })

  it('reads a codec however the publisher spells it', function () {
    // Enhanced RTMP sends the four-character code as the integer its bytes
    // make. Reading 1752589105 as a codec id turned real HEVC away.
    expect(codecName(1752589105)).equals('hvc1')
    expect(codecName(1751479857)).equals('hev1')
    expect(codecName(1635148593)).equals('avc1')
    expect(codecName(12)).equals('hvc1')
    expect(codecName(7)).equals('avc1')
    expect(codecName('HVC1')).equals('hvc1')
  })

  it('takes HEVC and turns everything else away by name', function () {
    expect(codecRefusal(1752589105)).equals(null)
    expect(codecRefusal(12)).equals(null)
    expect(codecRefusal('hev1')).equals(null)
    // Not known yet: the metadata arrives a moment after the publish starts,
    // and refusing on that would refuse everybody.
    expect(codecRefusal(0)).equals(null)
    expect(codecRefusal(undefined)).equals(null)

    expect(codecRefusal(7)).contains('H.264')
    expect(codecRefusal(1635148593)).contains('H.264')
    expect(codecRefusal('av01')).contains('av01')
  })

  it('keeps the stream key out of anything it says', function () {
    expect(hideKey('rtmp://ingest.example.com/live/secretkey')).equals(
      'rtmp://ingest.example.com/live/…'
    )
  })

  it('writes HLS and nothing else until a destination is added', function () {
    setLive(KEY, spec())
    forcePublishForTest(KEY, true)

    const status = statusFor(KEY)
    expect(status?.outputs.length).equals(1)
    expect(status?.outputs[0].kind).equals('hls')
    expect(status?.outputs[0].label).equals('TeamStation')
    expect(status?.ingress.publishing).equals(true)
  })

  it('keeps a late sound track at its stream time in the HLS it writes', async function () {
    // A stand-in that writes down what it was asked to do.
    const argsFile = join(tmpdir(), 'ts-live-test-args.txt')
    rmSync(argsFile, { force: true })
    writeFileSync(
      FAKE_FFMPEG,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${argsFile}\nexec sleep 30\n`
    )
    try {
      setLive(KEY, spec())
      forcePublishForTest(KEY, true)
      let args: string[] = []
      for (
        let i = 0;
        i < 100 && args.at(-1) !== join(spec().hlsDir, 'master.m3u8');
        i++
      ) {
        await new Promise(resolve => setTimeout(resolve, 20))
        try {
          args = readFileSync(argsFile, 'utf8').trim().split('\n')
        } catch {}
      }
      const at = args.indexOf('-hls_segment_options')
      expect(at, args.join(' ')).greaterThan(-1)
      expect(args[at + 1]).equals('movflags=+frag_discont')
      expect(args[args.indexOf('-f') + 1]).equals('hls')
    } finally {
      writeFileSync(FAKE_FFMPEG, '#!/bin/sh\nexec sleep 30\n')
      rmSync(argsFile, { force: true })
    }
  })

  it('adds an onward destination as a second output, with its key hidden', function () {
    setLive(KEY, spec(['rtmp://relay.example.com/live/theirkey']))
    forcePublishForTest(KEY, true)

    const status = statusFor(KEY)
    expect(status?.outputs.map(output => output.kind)).deep.equals([
      'hls',
      'rtmp'
    ])
    expect(status?.outputs[1].label).equals('rtmp://relay.example.com/live/…')
    // Twice over: the label a person reads, and the status that is written to
    // the database and handed to the app.
    expect(JSON.stringify(status)).does.not.contain('theirkey')
  })

  it('leaves an unchanged configuration alone', function () {
    setLive(KEY, spec(['rtmp://relay.example.com/live/theirkey']))
    forcePublishForTest(KEY, true)
    const before = statusFor(KEY)?.outputs[1].restartCount

    setLive(KEY, spec(['rtmp://relay.example.com/live/theirkey']))
    const after = statusFor(KEY)?.outputs[1].restartCount
    expect(after).equals(before)
    expect(statusFor(KEY)?.ingress.publishing).equals(true)
  })

  it('retires the destination that changed and leaves the rest alone', function () {
    setLive(KEY, spec(['rtmp://relay.example.com/live/first']))
    forcePublishForTest(KEY, true)
    const before = statusFor(KEY)?.outputs.find(output => output.kind === 'hls')

    logs.length = 0
    setLive(KEY, spec(['rtmp://relay.example.com/live/second']))
    const status = statusFor(KEY)
    expect(status?.outputs.length).equals(2)
    expect(status?.outputs[1].label).equals('rtmp://relay.example.com/live/…')
    // The new destination is spawned because the stream is already publishing;
    // the old one is released and can never spawn again.
    expect(status?.outputs[1].state).equals('connecting')
    // And the recording did not notice. Replacing it cost seconds of the game
    // and a discontinuity in the playlist every time somebody touched the
    // onward switch.
    const after = statusFor(KEY)?.outputs.find(output => output.kind === 'hls')
    expect(after?.state).equals(before?.state)
    expect(after?.restartCount).equals(before?.restartCount)
    expect(
      logs.filter(
        line => line.includes('TeamStation') && line.includes('retired')
      ),
      'the recording was not retired'
    ).deep.equals([])
  })

  it('starts the second leg without touching the first', function () {
    setLive(KEY, spec())
    forcePublishForTest(KEY, true)
    expect(statusFor(KEY)?.outputs.length).equals(1)

    logs.length = 0
    setLive(KEY, spec(['rtmp://relay.example.com/live/theirkey']))
    const outputs = statusFor(KEY)?.outputs ?? []
    expect(outputs.length).equals(2)
    expect(outputs[0].kind).equals('hls')
    expect(outputs[1].kind).equals('rtmp')
    // One ffmpeg started, and it is the new leg. The recording's writer is the
    // one that was already running.
    expect(logs.filter(line => line.includes('ffmpeg →'))).deep.equals([
      '[live:liv_test] ffmpeg → rtmp://relay.example.com/live/…'
    ])
  })

  it('stops the outputs when the publisher goes', function () {
    setLive(KEY, spec(['rtmp://relay.example.com/live/theirkey']))
    forcePublishForTest(KEY, true)
    forcePublishForTest(KEY, false)

    const status = statusFor(KEY)
    expect(status?.ingress.publishing).equals(false)
    expect(status?.outputs.every(output => output.state === 'stopped')).equals(
      true
    )
    expect(events.filter(event => event.type === 'publishEnded').length).equals(
      1
    )
  })

  it('says the publish ended when the key is taken away under it', function () {
    setLive(KEY, spec())
    forcePublishForTest(KEY, true)
    events.length = 0
    clearLive(KEY, 'the key was replaced')
    // Rotating a key cuts the stream off from this side, so nothing else is
    // going to report it: the row would otherwise say `publishing` for ever
    // about a publisher that has been disconnected.
    const ended = events.filter(event => event.type === 'publishEnded')
    expect(ended.length).equals(1)
    expect(ended[0].reason).equals('the key was replaced')
  })

  it('says nothing about a publish that was not happening', function () {
    setLive(OTHER_KEY, spec())
    events.length = 0
    clearLive(OTHER_KEY, 'no longer open')
    expect(events.filter(event => event.type === 'publishEnded').length).equals(
      0
    )
  })

  it('reports a publish starting and ending, in that order', function () {
    setLive(KEY, spec())
    forcePublishForTest(KEY, true)
    forcePublishForTest(KEY, false)
    expect(
      events.filter(event => event.type !== 'status').map(event => event.type)
    ).deep.equals(['publishStarted', 'publishEnded'])
  })

  it('closes a publisher that stopped sending without disconnecting', function () {
    let closed = 0
    let destroyed = 0
    let doneCalled = 0
    setLive(KEY, spec())
    forcePublishForTest(KEY, true)
    attachSessionForTest(KEY, {
      id: 'session-1',
      // Frozen: the socket is alive as far as the server knows, and no more
      // bytes will ever arrive. This is the failure that used to need a
      // process restart, because every reconnect was refused.
      inBytes: 1024,
      close: () => {
        closed += 1
      },
      socket: {
        destroy: () => {
          destroyed += 1
        }
      },
      broadcast: {
        donePublish: () => {
          doneCalled += 1
        }
      }
    })

    // The first tick banks the frozen byte count; thirty silent ones after it
    // are what the ingest calls a corpse.
    for (let at = 0; at < 31; at++) tickSamplerForTest()

    expect(statusFor(KEY)?.ingress.publishing).equals(false)
    expect(closed).equals(1)
    expect(destroyed).equals(1)
    expect(doneCalled).equals(1)
    expect(events.some(event => event.type === 'publishEnded')).equals(true)
    // Stopped, not released: a reconnect must bring the same outputs back.
    expect(statusFor(KEY)?.outputs[0].state).equals('stopped')
  })

  it('counts bytes as they arrive', function () {
    setLive(KEY, spec())
    forcePublishForTest(KEY, true)
    const session = { id: 'session-2', inBytes: 0 }
    attachSessionForTest(KEY, session)

    session.inBytes = 4096
    tickSamplerForTest()
    expect(statusFor(KEY)?.ingress.bytesPerSecond).equals(4096)
    expect(statusFor(KEY)?.ingress.bytesReceived).equals(4096)
    expect(statusFor(KEY)?.ingress.receivingPackets).equals(true)

    session.inBytes = 4096
    tickSamplerForTest()
    expect(statusFor(KEY)?.ingress.bytesPerSecond).equals(0)
    expect(statusFor(KEY)?.ingress.receivingPackets).equals(false)
  })

  it('forgets a key that has been taken away', function () {
    setLive(KEY, spec())
    forcePublishForTest(KEY, true)
    clearLive(KEY, 'revoked')
    expect(statusFor(KEY)).equals(undefined)
  })

  it('keeps two streams apart', function () {
    setLive(KEY, spec())
    setLive(OTHER_KEY, { ...spec(), liveStreamId: 'liv_other' })
    forcePublishForTest(KEY, true)

    expect(statusFor(KEY)?.ingress.publishing).equals(true)
    expect(statusFor(OTHER_KEY)?.ingress.publishing).equals(false)
    expect(statusFor(OTHER_KEY)?.liveStreamId).equals('liv_other')
  })
})

/** node-media-server's own broadcast: one per path, with one publisher. */
interface Broadcast {
  publisher: unknown
  postPublish: (session: unknown) => string | null
  donePublish: (session: unknown) => void
  subscribers: Map<string, { close?: () => void }>
}
interface NmsContext {
  eventEmitter: {
    on: (event: string, listener: (session: never) => void) => void
    off: (event: string, listener: (session: never) => void) => void
  }
}

describe('a publisher replaced by its own reconnect', function () {
  /**
   * An encoder whose network dropped redials the moment it is back, while its
   * old connection — dead without a FIN — still holds the key. These run the
   * publish through node-media-server's real broadcast, because what matters
   * is its order: it reports `postPublish` and only then checks for a
   * publisher already on the path, so the quiet one has to be gone by the
   * time the report returns.
   */
  const BroadcastServer =
    require('node-media-server/src/server/broadcast_server.js') as new () => Broadcast
  const Context = require('node-media-server/src/core/context.js') as NmsContext

  let broadcast: Broadcast
  let subscriberClosed = 0

  /** A publisher on `KEY`'s path, as an RTMP session presents itself. */
  function publisher(id: string): TestSession & {
    closed: number
    destroyed: number
  } {
    const session = {
      id,
      streamApp: 'live',
      streamName: KEY,
      streamPath: `/live/${KEY}`,
      inBytes: 0,
      closed: 0,
      destroyed: 0,
      broadcast,
      close: () => {
        session.closed += 1
      },
      socket: {
        destroy: () => {
          session.destroyed += 1
        }
      }
    }
    return session
  }

  /** What the RTMP session does when its client asks to publish. */
  function push(session: TestSession): string | null {
    return broadcast.postPublish(session)
  }

  beforeEach(function () {
    configure()
    broadcast = new BroadcastServer()
    subscriberClosed = 0
    // The HLS writer reading the stream: ours, and the only reader there is.
    broadcast.subscribers.set('reader', {
      close: () => {
        subscriberClosed += 1
      }
    })
    Context.eventEmitter.on('postPublish', publishArrivedForTest)
    Context.eventEmitter.on('donePublish', publishGoneForTest)
    setLive(KEY, spec())
  })

  afterEach(function () {
    Context.eventEmitter.off('postPublish', publishArrivedForTest)
    Context.eventEmitter.off('donePublish', publishGoneForTest)
    resetForTest()
  })

  it('lets a new publish replace one whose socket died, at once', function () {
    const dead = publisher('dead')
    expect(push(dead)).equals(null)
    dead.inBytes = 50_000
    tickSamplerForTest()
    // The network goes: nothing more arrives, and the socket never closes.
    tickSamplerForTest()
    tickSamplerForTest()

    const back = publisher('back')
    expect(push(back)).equals(null)

    expect(broadcast.publisher).equals(back)
    expect(dead.closed).equals(1)
    expect(dead.destroyed).equals(1)
    // The writer read the dead one to its end, so it closed its segment.
    expect(subscriberClosed).equals(1)
    expect(statusFor(KEY)?.ingress.publishing).equals(true)
    expect(
      events.filter(event => event.type !== 'status').map(event => event.type)
    ).deep.equals(['publishStarted', 'publishEnded', 'publishStarted'])
    expect(logs.join('\n')).contains(
      'dead sent nothing for 2s; back replaces it'
    )

    // The bytes counted now are the new connection's.
    back.inBytes = 8192
    tickSamplerForTest()
    expect(statusFor(KEY)?.ingress.bytesPerSecond).equals(8192)
    expect(statusFor(KEY)?.ingress.receivingPackets).equals(true)
  })

  it('keeps the same stream and its one writer across the replacement', function () {
    const dead = publisher('dead')
    push(dead)
    tickSamplerForTest()
    tickSamplerForTest()
    push(publisher('back'))

    const status = statusFor(KEY)
    expect(status?.liveStreamId).equals('liv_test')
    // Stopped for the old connection and wanted again for the new one: the
    // same output, not a released one and a second beside it.
    expect(status?.outputs).length(1)
    expect(status?.outputs[0].kind).equals('hls')
    const started = events.filter(event => event.type === 'publishStarted')
    expect(started.map(event => event.liveStreamId)).deep.equals([
      'liv_test',
      'liv_test'
    ])
  })

  it('does not hear the replaced connection closing as the stream ending', function () {
    const dead = publisher('dead')
    push(dead)
    tickSamplerForTest()
    tickSamplerForTest()
    push(publisher('back'))
    const before = events.length

    // Its socket finally closes; the broadcast now belongs to the new one.
    broadcast.donePublish(dead)
    publishGoneForTest(dead)

    expect(events.length).equals(before)
    expect(statusFor(KEY)?.ingress.publishing).equals(true)
  })

  it('keeps today’s one publisher per key while the first is still sending', function () {
    const live = publisher('live')
    push(live)
    live.inBytes = 10_000
    tickSamplerForTest()
    live.inBytes = 20_000
    tickSamplerForTest()

    const second = publisher('second')
    expect(push(second)).contains('already has a publisher')

    expect(broadcast.publisher).equals(live)
    expect(live.closed).equals(0)
    expect(subscriberClosed).equals(0)
    expect(logs.join('\n')).contains('second publisher ignored')
  })

  it('does not replace a publisher that sent something since the last tick', function () {
    const live = publisher('live')
    push(live)
    tickSamplerForTest()
    tickSamplerForTest()
    // Quiet for two ticks, and then a burst arrives before the third.
    live.inBytes = 4096

    expect(push(publisher('second'))).contains('already has a publisher')
    expect(broadcast.publisher).equals(live)
    expect(live.closed).equals(0)
  })

  it('does not replace one that has been quiet for less than two ticks', function () {
    const live = publisher('live')
    push(live)
    tickSamplerForTest()

    expect(push(publisher('second'))).contains('already has a publisher')
    expect(broadcast.publisher).equals(live)
  })

  it('replaces a quiet publisher before a looked-up key is let through', async function () {
    let lookups = 0
    configureIngest({
      ffmpegPath: FAKE_FFMPEG,
      bindHost: '127.0.0.1',
      port: 19_361,
      app: 'live',
      segmentSeconds: 4,
      log: message => {
        logs.push(message)
      },
      onEvent: event => {
        events.push(event)
      },
      resolve: async () => {
        lookups += 1
        return spec()
      }
    })
    const dead = publisher('dead')
    push(dead)
    await new Promise(resolve => setImmediate(resolve))
    expect(statusFor(KEY)?.ingress.publishing).equals(true)
    tickSamplerForTest()
    tickSamplerForTest()

    const back = publisher('back')
    // The lookup is asynchronous; the server's check is not. The quiet one is
    // gone before the check, and the new one is taken on once the key is
    // confirmed.
    expect(push(back)).equals(null)
    expect(dead.closed).equals(1)
    await new Promise(resolve => setImmediate(resolve))
    expect(lookups).equals(2)
    expect(statusFor(KEY)?.ingress.publishing).equals(true)
    back.inBytes = 2048
    tickSamplerForTest()
    expect(statusFor(KEY)?.ingress.bytesPerSecond).equals(2048)
  })

  it('ends the stream when its publisher disconnects', function () {
    const leaving = publisher('leaving')
    push(leaving)
    broadcast.donePublish(leaving)

    expect(statusFor(KEY)?.ingress.publishing).equals(false)
    expect(subscriberClosed).equals(1)
    const ended = events.find(event => event.type === 'publishEnded')
    expect(ended?.type === 'publishEnded' ? ended.reason : '').equals(
      'The stream ended'
    )
  })

  it('answers each lookup the way the controller answered it', async function () {
    const answers: Array<Awaited<ReturnType<typeof lookUp>>> = [
      'there is no room to record',
      undefined
    ]
    async function lookUp(): Promise<
      ReturnType<typeof spec> | string | undefined
    > {
      const next = answers.shift()
      if (next === 'throw') throw new Error('the database is down')
      return next
    }
    configureIngest({
      ffmpegPath: FAKE_FFMPEG,
      bindHost: '127.0.0.1',
      port: 19_361,
      app: 'live',
      segmentSeconds: 4,
      log: message => {
        logs.push(message)
      },
      onEvent: event => {
        events.push(event)
      },
      resolve: lookUp
    })
    answers.push('throw')
    for (const id of ['full', 'unknown', 'broken']) {
      const one = publisher(id)
      push(one)
      await new Promise(resolve => setImmediate(resolve))
      expect(one.closed, id).equals(1)
      broadcast.donePublish(one)
    }
    expect(
      events
        .filter(event => event.type === 'rejected')
        .map(event => (event.type === 'rejected' ? event.reason : ''))
    ).deep.equals(['there is no room to record', 'unknown key', 'unknown key'])
    expect(logs.join('\n')).contains('could not look a key up')
  })

  it('ignores a publish under another app, and refuses a key it cannot read', function () {
    const elsewhere = publisher('elsewhere')
    elsewhere.streamApp = 'other'
    expect(push(elsewhere)).equals(null)
    expect(elsewhere.closed).equals(0)
    broadcast.donePublish(elsewhere)
    publishGoneForTest(elsewhere)

    const odd = publisher('odd')
    odd.streamName = 'not a key'
    push(odd)
    expect(odd.closed).equals(1)
  })

  it('leaves a publish on a key it was not given to the server', function () {
    clearLive(KEY, 'test')
    const stranger = publisher('stranger')
    expect(push(stranger)).equals(null)
    // No lookup is configured, so an unknown key is closed on arrival.
    expect(stranger.closed).equals(1)
    expect(logs.join('\n')).contains('refused a publish')
  })
})

describe('a stream that comes back', function () {
  /**
   * The bug this covers overwrote the first half of a game with the second.
   * A writer that starts where one has already been must continue the
   * playlist, and the only account of what happened that survives a crash, a
   * drop, or this whole process restarting is what is on the disk.
   */
  const dir = join(tmpdir(), 'ts-live-test-reconnect')

  beforeEach(function () {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  })

  after(function () {
    rmSync(dir, { recursive: true, force: true })
  })

  it('waits longer each time a writer fails on top of the last', function () {
    let count = 0
    const waits: number[] = []
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const again = restartDelay(count, 200)
      waits.push(again.delayMs)
      count = again.nextCount
    }
    expect(waits).deep.equals([1000, 2000, 5000, 10000, 10000])
  })

  it('starts over for a writer that had been running a while', function () {
    // Four failures in a row, then one an hour into the game: that last one
    // is the first failure of its own, not the fifth of the morning's.
    const again = restartDelay(4, 3_600_000)
    expect(again.delayMs).equals(1000)
    expect(again.nextCount).equals(1)
  })

  it('starts at nought where nothing has been written', function () {
    expect(nextSegmentNumber(dir)).equals(0)
    expect(nextSegmentNumber(join(dir, 'not-here'))).equals(0)
  })

  it('carries on after the segments that are there', function () {
    for (const name of ['seg000000.m4s', 'seg000001.m4s', 'seg000002.m4s']) {
      writeFileSync(join(dir, name), 'x')
    }
    expect(nextSegmentNumber(dir)).equals(3)
  })

  it('is not fooled by the numbering having a hole in it', function () {
    writeFileSync(join(dir, 'seg000000.m4s'), 'x')
    writeFileSync(join(dir, 'seg000009.m4s'), 'x')
    writeFileSync(join(dir, 'init.mp4'), 'x')
    writeFileSync(join(dir, 'master.m3u8'), '#EXTM3U\n')
    expect(nextSegmentNumber(dir)).equals(10)
  })

  it('takes the end off a playlist that is about to grow again', function () {
    const path = join(dir, 'master.m3u8')
    writeFileSync(
      path,
      '#EXTM3U\n#EXTINF:4.000000,\nseg000000.m4s\n#EXT-X-ENDLIST\n'
    )
    reopenPlaylist(dir)
    const playlist = readFileSync(path, 'utf8')
    // Without this the second half of the game exists on disk and no player
    // ever reaches it.
    expect(playlist).does.not.contain('#EXT-X-ENDLIST')
    expect(playlist).contains('seg000000.m4s')
    expect(playlist.endsWith('\n')).equals(true)
  })

  it('leaves an open playlist alone', function () {
    const path = join(dir, 'master.m3u8')
    const open = '#EXTM3U\n#EXTINF:4.000000,\nseg000000.m4s\n'
    writeFileSync(path, open)
    reopenPlaylist(dir)
    expect(readFileSync(path, 'utf8')).equals(open)
  })
})

describe('a live playlist through a reconnect', function () {
  this.timeout(30000)
  const dir = spec().hlsDir
  const argsFile = join(tmpdir(), 'ts-live-test-reconnect-args.txt')

  /** The arguments the stand-in ffmpeg was started with, once it has been. */
  async function writerArgs(): Promise<string[]> {
    let args: string[] = []
    for (let i = 0; i < 100 && args.at(-1) !== join(dir, 'master.m3u8'); i++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      try {
        args = readFileSync(argsFile, 'utf8').trim().split('\n')
      } catch {}
    }
    return args
  }
  const argAfter = (args: string[], flag: string): string | undefined => {
    const at = args.indexOf(flag)
    return at < 0 ? undefined : args[at + 1]
  }

  beforeEach(function () {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    rmSync(argsFile, { force: true })
    writeFileSync(
      FAKE_FFMPEG,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${argsFile}\nexec sleep 30\n`
    )
    chmodSync(FAKE_FFMPEG, 0o755)
    resetForTest()
    configure()
  })

  afterEach(function () {
    resetForTest()
    const pidFile = join(tmpdir(), 'ts-live-test-reconnect-pids.txt')
    try {
      for (const pid of readFileSync(pidFile, 'utf8').trim().split('\n')) {
        const n = Number(pid)
        if (!(n > 0)) continue
        try {
          process.kill(-n, 'SIGKILL')
        } catch {
          try {
            process.kill(n, 'SIGKILL')
          } catch {
            // Already gone.
          }
        }
      }
    } catch {
      // No writer recorded a pid.
    }
    rmSync(pidFile, { force: true })
    writeFileSync(FAKE_FFMPEG, '#!/bin/sh\nexec sleep 30\n')
    rmSync(argsFile, { force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  it('never lets the writer close the playlist, and dates every segment', async function () {
    setLive(KEY, spec())
    forcePublishForTest(KEY, true)
    const args = await writerArgs()
    const flags = argAfter(args, '-hls_flags')?.split('+') ?? []
    expect(flags).includes('omit_endlist')
    expect(flags).includes('program_date_time')
    // A first run starts a playlist rather than continuing one.
    expect(flags).not.includes('append_list')
    expect(flags).not.includes('discont_start')
    expect(argAfter(args, '-start_number')).equals('0')
    expect(args).not.includes('-output_ts_offset')
  })

  it('carries on the playlist it finds, under the same numbers, from where it stopped', async function () {
    writeFileSync(
      join(dir, 'master.m3u8'),
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:EVENT',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXTINF:4.000000,',
        'seg000000.m4s',
        '#EXTINF:4.000000,',
        'seg000001.m4s',
        '#EXTINF:3.960000,',
        'seg000002.m4s',
        // Closed past the reconnect grace, and now the publisher is back.
        '#EXT-X-ENDLIST',
        ''
      ].join('\n')
    )
    for (const name of ['seg000000.m4s', 'seg000001.m4s', 'seg000002.m4s'])
      writeFileSync(join(dir, name), 'x')

    setLive(KEY, spec())
    forcePublishForTest(KEY, true)
    const args = await writerArgs()
    const flags = argAfter(args, '-hls_flags')?.split('+') ?? []
    expect(flags).includes('append_list')
    // The join is marked by `append_list` itself; this would also mark one
    // above segments a player already has.
    expect(flags).not.includes('discont_start')
    // The playlist's own first number, so nothing already in it is
    // renumbered, and the new timestamps start where the old ones stopped.
    expect(argAfter(args, '-start_number')).equals('0')
    // The continuation offset is applied to the new segments after they are
    // closed. The muxer is not asked to shift timestamps it has already written.
    expect(args).not.includes('-output_ts_offset')
    expect(readFileSync(join(dir, 'master.m3u8'), 'utf8')).not.contains(
      '#EXT-X-ENDLIST'
    )
  })

  it('starts the next segments at the wall clock, hole included', async function () {
    const awayMs = 30_000
    const mediaMs = 11_960
    const first = new Date(Date.now() - awayMs - mediaMs)
    const pdt = first.toISOString().replace(/\.\d{3}Z$/, '.000Z')
    writeFileSync(
      join(dir, 'master.m3u8'),
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:EVENT',
        '#EXT-X-MAP:URI="init.mp4"',
        `#EXT-X-PROGRAM-DATE-TIME:${pdt}`,
        '#EXTINF:4.000000,',
        'seg000000.m4s',
        '#EXTINF:4.000000,',
        'seg000001.m4s',
        '#EXTINF:3.960000,',
        'seg000002.m4s',
        ''
      ].join('\n')
    )
    for (const name of ['seg000000.m4s', 'seg000001.m4s', 'seg000002.m4s'])
      writeFileSync(join(dir, name), 'x')

    setLive(KEY, spec())
    forcePublishForTest(KEY, true)
    const args = await writerArgs()
    expect(args).not.includes('-output_ts_offset')
  })

  it('stamps a segment the restarted writer closes and leaves the earlier part', async function () {
    const box = (type: string, payload: Buffer): Buffer => {
      const head = Buffer.alloc(8)
      head.writeUInt32BE(payload.length + 8, 0)
      head.write(type, 4, 'latin1')
      return Buffer.concat([head, payload])
    }
    const mdhd = Buffer.alloc(16)
    mdhd.writeUInt32BE(1000, 12)
    const tkhd = Buffer.alloc(16)
    tkhd.writeUInt32BE(1, 12)
    const init = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      box(
        'moov',
        box(
          'trak',
          Buffer.concat([
            box('tkhd', tkhd),
            box(
              'mdia',
              Buffer.concat([box('mdhd', mdhd), box('hdlr', Buffer.alloc(12))])
            )
          ])
        )
      )
    ])
    const segment = (earliest: number): Buffer => {
      const sidx = Buffer.alloc(24)
      sidx.writeUInt32BE(1000, 8)
      sidx.writeUInt32BE(earliest, 12)
      const tfhd = Buffer.alloc(8)
      tfhd.writeUInt32BE(1, 4)
      const tfdt = Buffer.alloc(8)
      tfdt.writeUInt32BE(earliest, 4)
      return Buffer.concat([
        box('sidx', sidx),
        box(
          'moof',
          box('traf', Buffer.concat([box('tfhd', tfhd), box('tfdt', tfdt)]))
        )
      ])
    }
    writeFileSync(join(dir, 'init.mp4'), init)
    const prior = segment(0)
    writeFileSync(join(dir, 'seg000000.m4s'), prior)
    const pdt = new Date(Date.now() - 30_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, '.000Z')
    writeFileSync(
      join(dir, 'master.m3u8'),
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:EVENT',
        '#EXT-X-MAP:URI="init.mp4"',
        `#EXT-X-PROGRAM-DATE-TIME:${pdt}`,
        '#EXTINF:4.000000,',
        'seg000000.m4s',
        ''
      ].join('\n')
    )
    setLive(KEY, spec())
    forcePublishForTest(KEY, true)
    await writerArgs()
    // The stamper runs on every watch event and progress line for the rest
    // of the game, so it never lists the whole directory.
    // The module object itself: the splitter reads `readdirSync` off it.
    const fs = require('fs') as { readdirSync: typeof readdirSync }
    const readdir = fs.readdirSync
    const listings: string[] = []
    fs.readdirSync = ((path: string, ...rest: unknown[]) => {
      listings.push(String(path))
      return (readdir as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof readdir
    writeFileSync(join(dir, 'seg000001.m4s'), segment(0))
    const placed = async (name: string): Promise<number | undefined> =>
      timelineStartSec(init, readFileSync(join(dir, name)))
    let moved = await placed('seg000001.m4s')
    try {
      for (let i = 0; i < 50 && !(moved != null && moved > 10); i++) {
        await new Promise(resolve => setTimeout(resolve, 40))
        moved = await placed('seg000001.m4s')
      }
    } finally {
      fs.readdirSync = readdir
    }
    expect(moved ?? 0).closeTo(30, 2)
    expect(listings.filter(path => path.startsWith(dir))).deep.equals([])
    expect(readFileSync(join(dir, 'seg000000.m4s')).equals(prior)).equals(true)
    writeFileSync(join(dir, 'seg000002.m4s'), segment(0))
    await clearLiveSettled(KEY, 'ended')
    let tail = await placed('seg000002.m4s')
    for (let i = 0; i < 20 && !(tail != null && tail > 10); i++) {
      await new Promise(resolve => setTimeout(resolve, 40))
      tail = await placed('seg000002.m4s')
    }
    expect(tail ?? 0).closeTo(30, 2)
    expect(readFileSync(join(dir, 'seg000000.m4s')).equals(prior)).equals(true)
    const tfdt = readFileSync(join(dir, 'seg000001.m4s')).indexOf('tfdt')
    expect(
      readFileSync(join(dir, 'seg000001.m4s')).readUInt32BE(tfdt + 8)
    ).greaterThan(10_000)
  })

  /**
   * A first publish of three segments (11.96 s) on the disk, stamped from
   * nought, with the program dates an HLS writer gives them: `pdtLagMs` after
   * the video's start, which is how far the writer trailed the capture.
   */
  function firstPublishOnDisk(
    videoStartMs: number,
    pdtLagMs = 1400
  ): {
    init: Buffer
    listed: Buffer[]
  } {
    const init = hevcInit()
    writeFileSync(join(dir, 'init.mp4'), init)
    const listed = [0, 4, 8].map(at =>
      hevcSegment(at, [wallClockNal(videoStartMs + at * 1000), IDR_SLICE])
    )
    listed.forEach((bytes, at) => {
      writeFileSync(join(dir, `seg00000${at}.m4s`), bytes)
    })
    writeFileSync(
      join(dir, 'master.m3u8'),
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:EVENT',
        '#EXT-X-MAP:URI="init.mp4"',
        `#EXT-X-PROGRAM-DATE-TIME:${new Date(videoStartMs + pdtLagMs).toISOString()}`,
        '#EXTINF:4.000000,',
        'seg000000.m4s',
        '#EXTINF:4.000000,',
        'seg000001.m4s',
        '#EXTINF:3.960000,',
        'seg000002.m4s',
        ''
      ].join('\n')
    )
    return { init, listed }
  }

  /** Where a segment sits on the timeline, once something has stamped it. */
  async function placedAt(
    init: Buffer,
    name: string,
    beyond = 1
  ): Promise<number | undefined> {
    let at: number | undefined
    for (let i = 0; i < 100; i++) {
      try {
        at = timelineStartSec(init, readFileSync(join(dir, name)))
      } catch {
        at = undefined
      }
      if (at != null && at > beyond) return at
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    return at
  }

  it('places a returning publish where its frame wall clocks say, so the hole is the absence', async function () {
    // The publisher was away for 30 s, and its first picture back was
    // captured 0.3 s ago. The writer's program date trailed the first
    // publish's capture by 1.4 s, so the wall clock would put it 1.1 s early.
    const back = Date.now() - 300
    const videoStartMs = back - 41_960
    const { init, listed } = firstPublishOnDisk(videoStartMs)
    const initBefore = readFileSync(join(dir, 'init.mp4'))
    setLive(KEY, { ...spec(), videoStartMs })
    forcePublishForTest(KEY, true)
    await writerArgs()
    writeFileSync(
      join(dir, 'seg000003.m4s'),
      hevcSegment(0, [wallClockNal(back), IDR_SLICE])
    )
    const start = await placedAt(init, 'seg000003.m4s')
    expect(start ?? 0).closeTo(41.96, 0.001)
    expect((start ?? 0) - 11.96).closeTo(30, 0.001)
    // The init segment and everything listed before the return are as they were.
    expect(readFileSync(join(dir, 'init.mp4')).equals(initBefore)).equals(true)
    listed.forEach((bytes, at) => {
      expect(readFileSync(join(dir, `seg00000${at}.m4s`)).equals(bytes)).equals(
        true
      )
    })
    expect(logs.join('\n')).contains('by its frame wall clocks')
  })

  it('leaves a return its frame wall clocks placed where it is when this server restarts', async function () {
    // The return's writer started 3 s after its first picture was captured,
    // the first publish's 1.4 s after, so the program date listed for the
    // return is 1.6 s past where its pictures were placed.
    const back = Date.now() - 300
    const videoStartMs = back - 41_960
    const { init } = firstPublishOnDisk(videoStartMs)
    setLive(KEY, { ...spec(), videoStartMs })
    forcePublishForTest(KEY, true)
    await writerArgs()
    writeFileSync(
      join(dir, 'seg000003.m4s'),
      hevcSegment(0, [wallClockNal(back), IDR_SLICE])
    )
    expect((await placedAt(init, 'seg000003.m4s')) ?? 0).closeTo(41.96, 0.001)
    appendFileSync(
      join(dir, 'master.m3u8'),
      [
        '#EXT-X-DISCONTINUITY',
        `#EXT-X-PROGRAM-DATE-TIME:${new Date(back + 3000).toISOString()}`,
        '#EXTINF:4.000000,',
        'seg000003.m4s',
        ''
      ].join('\n')
    )
    const placed = readFileSync(join(dir, 'seg000003.m4s'))
    // A deploy mid-game, and the publisher returns once more: the new
    // process remembers nothing of the writers before it.
    resetForTest()
    configure()
    rmSync(argsFile, { force: true })
    setLive(KEY, { ...spec(), videoStartMs })
    forcePublishForTest(KEY, true)
    await writerArgs()
    expect(
      timelineStartSec(init, readFileSync(join(dir, 'seg000003.m4s')))
    ).closeTo(41.96, 0.001)
    expect(readFileSync(join(dir, 'seg000003.m4s')).equals(placed)).equals(true)
  })

  it('moves the segments it stamped at the wall clock once a later one carries the server’s clock', async function () {
    const back = Date.now() - 300
    const videoStartMs = back - 41_960
    const { init } = firstPublishOnDisk(videoStartMs)
    setLive(KEY, { ...spec(), videoStartMs })
    forcePublishForTest(KEY, true)
    await writerArgs()
    // The publisher had not measured the server's clock for its first segment,
    // whose pictures carry its own.
    writeFileSync(
      join(dir, 'seg000003.m4s'),
      hevcSegment(0, [wallClockNal(back - 5000, false), IDR_SLICE])
    )
    const wall = await placedAt(init, 'seg000003.m4s')
    expect(wall ?? 0).closeTo(40.86, 0.25)
    writeFileSync(
      join(dir, 'seg000004.m4s'),
      hevcSegment(4, [wallClockNal(back + 4000), IDR_SLICE])
    )
    expect((await placedAt(init, 'seg000004.m4s', 10)) ?? 0).closeTo(
      45.96,
      0.001
    )
    expect(
      timelineStartSec(init, readFileSync(join(dir, 'seg000003.m4s')))
    ).closeTo(41.96, 0.001)
  })

  it('keeps the wall clock for a publisher that sends no frame wall clocks, or an unbelievable one', async function () {
    const back = Date.now() - 300
    const videoStartMs = back - 41_960
    const { init } = firstPublishOnDisk(videoStartMs)
    setLive(KEY, { ...spec(), videoStartMs })
    forcePublishForTest(KEY, true)
    await writerArgs()
    // An hour out: a clock nobody set, not a capture.
    writeFileSync(
      join(dir, 'seg000003.m4s'),
      hevcSegment(0, [wallClockNal(back - 3_600_000), IDR_SLICE])
    )
    expect((await placedAt(init, 'seg000003.m4s')) ?? 0).closeTo(40.86, 0.25)
    writeFileSync(join(dir, 'seg000004.m4s'), hevcSegment(4, [IDR_SLICE]))
    expect((await placedAt(init, 'seg000004.m4s', 10)) ?? 0).closeTo(
      44.86,
      0.25
    )
    expect(events.some(event => event.type === 'publisherPlaced')).equals(false)
  })

  it('places a return with no frame wall clocks by the wall clock its writer starts at, however long the recovery took', async function () {
    const videoStartMs = Date.now() - 41_960
    const { init } = firstPublishOnDisk(videoStartMs)
    const firstDateMs = videoStartMs + 1400
    // Each segment the recovery and the timeline's end read takes 0.3 s:
    // a long game's worth of them after this server restarts.
    const promises = require('fs/promises') as {
      open: (...args: unknown[]) => Promise<unknown>
    }
    const open = promises.open
    promises.open = async (...args: unknown[]) => {
      await new Promise(resolve => setTimeout(resolve, 300))
      return await open(...args)
    }
    let startedAt = 0
    try {
      setLive(KEY, { ...spec(), videoStartMs })
      forcePublishForTest(KEY, true)
      await writerArgs()
      startedAt = Date.now()
    } finally {
      promises.open = open
    }
    writeFileSync(join(dir, 'seg000003.m4s'), hevcSegment(0, [IDR_SLICE]))
    expect((await placedAt(init, 'seg000003.m4s')) ?? 0).closeTo(
      (startedAt - firstDateMs) / 1000,
      0.25
    )
  })

  it('never puts a return on top of the pictures before it', async function () {
    const back = Date.now() - 300
    // A frame wall clock 0.3 s inside the listed media goes at its end; one
    // 5 s inside is not of this publish at all.
    const videoStartMs = back - 11_960 + 300
    const { init } = firstPublishOnDisk(videoStartMs, 0)
    setLive(KEY, { ...spec(), videoStartMs })
    forcePublishForTest(KEY, true)
    await writerArgs()
    writeFileSync(
      join(dir, 'seg000003.m4s'),
      hevcSegment(0, [wallClockNal(back), IDR_SLICE])
    )
    expect((await placedAt(init, 'seg000003.m4s')) ?? 0).closeTo(11.96, 0.001)
    expect(
      continuationFromCapture(11.96, videoStartMs + 6_960, videoStartMs)
    ).equals(undefined)
    expect(
      continuationFromCapture(11.96, videoStartMs + 20_000, undefined)
    ).equals(undefined)
  })

  it('tells the controller where a first publish starts, from its first picture’s wall clock', async function () {
    setLive(KEY, spec())
    forcePublishForTest(KEY, true)
    await writerArgs()
    const captured = Date.now() - 900
    writeFileSync(join(dir, 'init.mp4'), hevcInit())
    writeFileSync(
      join(dir, 'seg000000.m4s'),
      hevcSegment(0.2, [wallClockNal(captured), IDR_SLICE])
    )
    let placed: LiveEvent | undefined
    for (let i = 0; i < 100 && placed == null; i++) {
      await new Promise(resolve => setTimeout(resolve, 30))
      placed = events.find(event => event.type === 'publisherPlaced')
    }
    expect(
      placed?.type === 'publisherPlaced' ? placed.startedAt.getTime() : 0
    ).closeTo(captured - 200, 0.001)
    // Said once.
    writeFileSync(
      join(dir, 'seg000001.m4s'),
      hevcSegment(4.2, [wallClockNal(captured + 4000), IDR_SLICE])
    )
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(events.filter(event => event.type === 'publisherPlaced')).length(1)
    // A first writer stamps nothing.
    expect(
      timelineStartSec(hevcInit(), readFileSync(join(dir, 'seg000001.m4s')))
    ).closeTo(4.2, 1e-9)
  })

  it('believes a writer’s zero only near when the writer started', function () {
    const started = 1_790_000_000_000
    expect(
      writerZeroCapturedAt(
        { capturedAtMs: started + 3000, pictureSec: 4 },
        started
      )
    ).equals(started - 1000)
    expect(
      writerZeroCapturedAt(
        { capturedAtMs: started - CAPTURE_LEAD_MAX_MS - 1, pictureSec: 0 },
        started
      )
    ).equals(undefined)
    expect(
      writerZeroCapturedAt(
        { capturedAtMs: started + CAPTURE_LAG_MAX_MS + 1, pictureSec: 0 },
        started
      )
    ).equals(undefined)
    expect(
      writerZeroCapturedAt({ capturedAtMs: Number.NaN, pictureSec: 0 }, started)
    ).equals(undefined)
  })

  /** A playlist whose one segment ended half a minute ago, so a restart reads it. */
  function playlistLeftOpen(): void {
    const pdt = new Date(Date.now() - 30_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, '.000Z')
    writeFileSync(join(dir, 'init.mp4'), 'x')
    writeFileSync(join(dir, 'seg000000.m4s'), 'x')
    writeFileSync(
      join(dir, 'master.m3u8'),
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:EVENT',
        '#EXT-X-MAP:URI="init.mp4"',
        `#EXT-X-PROGRAM-DATE-TIME:${pdt}`,
        '#EXTINF:4.000000,',
        'seg000000.m4s',
        ''
      ].join('\n')
    )
  }

  /** How many times the stand-in ffmpeg was started. */
  function spawnCount(): number {
    const path = join(tmpdir(), 'ts-live-test-reconnect-spawns.txt')
    try {
      return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
        .length
    } catch {
      return 0
    }
  }

  function countSpawns(): void {
    const path = join(tmpdir(), 'ts-live-test-reconnect-spawns.txt')
    rmSync(path, { force: true })
    writeFileSync(
      FAKE_FFMPEG,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${argsFile}\necho spawn >> ${path}\nexec sleep 30\n`
    )
    chmodSync(FAKE_FFMPEG, 0o755)
  }

  it('does not start a writer when the publisher leaves while the playlist is being read', async function () {
    playlistLeftOpen()
    countSpawns()
    setLive(KEY, spec())
    // The read yields before ffmpeg exists. The stop lands in that gap.
    forcePublishForTest(KEY, true)
    forcePublishForTest(KEY, false)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(spawnCount()).equals(0)
  })

  it('does not start a writer when the stream is ended while the playlist is being read', async function () {
    playlistLeftOpen()
    countSpawns()
    setLive(KEY, spec())
    forcePublishForTest(KEY, true)
    clearLive(KEY, 'ended')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(spawnCount()).equals(0)
  })

  it('starts one writer when the publisher returns while the playlist is being read', async function () {
    playlistLeftOpen()
    countSpawns()
    setLive(KEY, spec())
    forcePublishForTest(KEY, true)
    forcePublishForTest(KEY, false)
    forcePublishForTest(KEY, true)
    const args = await writerArgs()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(args.at(-1)).equals(join(dir, 'master.m3u8'))
    expect(spawnCount()).equals(1)
  })

  it('starts the next writer after one that has not exited yet', async function () {
    this.timeout(25000)
    const pids = join(tmpdir(), 'ts-live-test-reconnect-pids.txt')
    rmSync(pids, { force: true })
    const spawns = join(tmpdir(), 'ts-live-test-reconnect-spawns.txt')
    rmSync(spawns, { force: true })
    // SIGTERM is ignored, which is a writer still flushing when its stop
    // arrives. The shell stays, so the stop cannot be mistaken for an exit.
    writeFileSync(
      FAKE_FFMPEG,
      `#!/bin/sh\necho $$ >> ${pids}\nprintf '%s\\n' "$@" > ${argsFile}\necho spawn >> ${spawns}\ntrap 'true' TERM\nwhile true; do sleep 30; done\n`
    )
    chmodSync(FAKE_FFMPEG, 0o755)
    setLive(KEY, spec())
    forcePublishForTest(KEY, true)
    await writerArgs()
    expect(spawnCount()).equals(1)
    forcePublishForTest(KEY, false)
    forcePublishForTest(KEY, true)
    // The drain gives the first writer ten seconds, then stops it. It is
    // still alive, so this return must not start a second writer beside it.
    await new Promise(resolve => setTimeout(resolve, 11_000))
    expect(spawnCount()).equals(1)
    const alive = Number(readFileSync(pids, 'utf8').trim().split('\n')[0])
    let stillAlive = false
    try {
      process.kill(alive, 0)
      stillAlive = true
    } catch {
      stillAlive = false
    }
    expect(stillAlive, 'the first writer was still exiting').equals(true)
    // The stop's own escalation is what ends a writer that ignores SIGTERM.
    for (let i = 0; i < 25 && spawnCount() < 2; i++) {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    expect(spawnCount()).equals(2)
  })

  it('finishes a phantom exit once the writer Node called gone is killed', async function () {
    countSpawns()
    // The module object itself: the splitter reads `spawn` off it.
    const processes = require('child_process') as { spawn: typeof spawn }
    const spawnReal = processes.spawn
    const children: ChildProcess[] = []
    processes.spawn = ((...args: Parameters<typeof spawn>) => {
      const child = spawnReal(...args)
      children.push(child)
      return child
    }) as typeof spawn
    try {
      setLive(KEY, spec())
      forcePublishForTest(KEY, true)
      await writerArgs()
    } finally {
      processes.spawn = spawnReal
    }
    const writer = children[0]
    const pid = writer.pid ?? 0
    // Node says the writer exited while the OS still has it. Node emits
    // `exit` once per child, so the real one never arrives.
    const emit = writer.emit.bind(writer)
    writer.emit = ((event: string, ...args: unknown[]) =>
      event === 'exit' ? false : emit(event, ...args)) as typeof writer.emit
    emit('exit', 1, null)
    expect(logs.join('\n')).contains(`phantom exit pid=${String(pid)}`)
    for (let i = 0; i < 60 && spawnCount() < 2; i++) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(() => process.kill(pid, 0)).throws()
    // The writer is off the books and the restart was armed.
    expect(spawnCount()).equals(2)
    expect(statusFor(KEY)?.outputs[0].restartCount).equals(1)
  })

  it('works out where a playlist carries on from', function () {
    expect(playlistContinuation(undefined, 7)).deep.equals({
      startNumber: 7,
      offsetSec: 0
    })
    expect(playlistContinuation('#EXTM3U\n', 3)).deep.equals({
      startNumber: 3,
      offsetSec: 0
    })
    const listed = (sequence: number, numbers: number[]): string =>
      [
        '#EXTM3U',
        `#EXT-X-MEDIA-SEQUENCE:${sequence}`,
        ...numbers.flatMap(n => [
          '#EXTINF:4.000000,',
          `seg${String(n).padStart(6, '0')}.m4s`
        ])
      ].join('\n')
    expect(playlistContinuation(listed(0, [0, 1, 2]), 3)).deep.equals({
      startNumber: 0,
      offsetSec: 12
    })
    // Numbering an older writer broke: the media sequence is kept, as long as
    // no new segment can land on a listed one.
    expect(
      playlistContinuation(listed(454, [89, 90, 209, 210]), 211).startNumber
    ).equals(454)
    // Where keeping it would overwrite one, it moves just far enough.
    expect(playlistContinuation(listed(0, [5, 6, 7]), 8).startNumber).equals(5)
    // A name with no length is not listed, as the writer that continues the
    // playlist counts it: it numbers the new segments after the one listed.
    expect(
      playlistContinuation(`${listed(0, [5])}\nseg000009.m4s\n`, 10)
    ).deep.equals({ startNumber: 5, offsetSec: 4 })
  })

  it('adds the wall-clock absence to the timestamp offset', function () {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PROGRAM-DATE-TIME:2026-10-14T16:00:00.000Z',
      '#EXTINF:4.000000,',
      'seg000000.m4s',
      '#EXT-X-PROGRAM-DATE-TIME:2026-10-14T16:00:04.000Z',
      '#EXTINF:4.000000,',
      'seg000001.m4s',
      '#EXT-X-PROGRAM-DATE-TIME:2026-10-14T16:00:08.000Z',
      '#EXTINF:3.960000,',
      'seg000002.m4s',
      // A date that does not parse is not a program date time.
      '#EXT-X-PROGRAM-DATE-TIME:not-a-date',
      ''
    ].join('\n')
    const wallEnd = new Date('2026-10-14T16:00:11.960Z')
    expect(playlistContinuation(playlist, 3, wallEnd)).deep.equals({
      startNumber: 0,
      offsetSec: 11.96
    })
    const later = new Date(wallEnd.getTime() + 30_000)
    expect(playlistContinuation(playlist, 3, later)).deep.equals({
      startNumber: 0,
      offsetSec: 41.96
    })
    // A clock still inside the last segment does not invent a hole.
    const early = new Date(wallEnd.getTime() - 500)
    expect(playlistContinuation(playlist, 3, early).offsetSec).equals(11.96)
  })

  it('pairs a program date with the duration written before it', function () {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:3.000000,',
      '#EXT-X-PROGRAM-DATE-TIME:2026-10-14T16:00:00.000Z',
      'seg000000.m4s',
      '#EXTINF:3.000000,',
      '#EXT-X-PROGRAM-DATE-TIME:2026-10-14T16:00:03.000Z',
      'seg000001.m4s',
      '#EXTINF:3.000000,',
      '#EXT-X-PROGRAM-DATE-TIME:2026-10-14T16:00:06.000Z',
      'seg000002.m4s',
      ''
    ].join('\n')
    const wallEnd = new Date('2026-10-14T16:00:09.000Z')
    expect(playlistContinuation(playlist, 3, wallEnd).offsetSec).equals(9)
    expect(
      playlistContinuation(playlist, 3, new Date(wallEnd.getTime() - 500))
        .offsetSec
    ).equals(9)
    expect(
      playlistContinuation(playlist, 3, new Date(wallEnd.getTime() - 1000 / 30))
        .offsetSec
    ).equals(9)
    expect(
      playlistContinuation(playlist, 3, new Date(wallEnd.getTime() + 30_000))
        .offsetSec
    ).equals(39)
  })

  it('lists the last segment a writer closed at its true length', function () {
    let ffmpeg = process.env.TS_FFMPEG ?? '/opt/homebrew/bin/ffmpeg'
    try {
      execFileSync(ffmpeg, ['-version'])
    } catch {
      ffmpeg = ''
    }
    if (ffmpeg === '') this.skip()
    // Five seconds at 30 frames a second, a keyframe a second, through FLV
    // as RTMP brings it, copied into 4 s segments: the second segment is the
    // last second, the one the writer closed.
    const flv = join(dir, 'in.flv')
    execFileSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x120:rate=30:duration=5',
      '-c:v',
      'libx265',
      '-x265-params',
      'log-level=none:bframes=0',
      '-g',
      '30',
      '-f',
      'flv',
      flv
    ])
    execFileSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      flv,
      '-c',
      'copy',
      '-tag:v',
      'hvc1',
      '-f',
      'hls',
      '-hls_time',
      '4',
      '-hls_playlist_type',
      'event',
      '-hls_segment_type',
      'fmp4',
      '-hls_fmp4_init_filename',
      'init.mp4',
      '-hls_flags',
      'omit_endlist',
      '-hls_segment_filename',
      join(dir, 'seg%06d.m4s'),
      join(dir, 'master.m3u8')
    ])
    const path = join(dir, 'master.m3u8')
    const written = readFileSync(path, 'utf8')
    // FFmpeg's own account falls short of the second.
    expect(written).contains('seg000001.m4s')
    expect(written).not.contains('#EXTINF:1.000000,')
    settleLastSegment(dir)
    const settled = readFileSync(path, 'utf8')
    expect(settled).contains('#EXTINF:1.000000,\nseg000001.m4s')
    expect(settled).contains('#EXTINF:4.000000,\nseg000000.m4s')
    // Once right, it is left alone.
    settleLastSegment(dir)
    expect(readFileSync(path, 'utf8')).equals(settled)
    // Nothing it can read, nothing it changes.
    writeFileSync(join(dir, 'seg000001.m4s'), 'x')
    writeFileSync(path, written)
    settleLastSegment(dir)
    expect(readFileSync(path, 'utf8')).equals(written)
    rmSync(path)
    settleLastSegment(dir)
  })

  it('waits for the writer to finish its last word before a stream is closed', async function () {
    const last = join(dir, 'last-word.txt')
    // A writer that, told to stop, takes a moment and then writes once more.
    writeFileSync(
      FAKE_FFMPEG,
      `#!/bin/sh\ntrap 'sleep 0.3; echo done > ${last}; exit 0' TERM\nsleep 30 &\nwait\n`
    )
    setLive(KEY, spec())
    forcePublishForTest(KEY, true)
    await new Promise(resolve => setTimeout(resolve, 300))
    await clearLiveSettled(KEY, 'the stream was ended')
    expect(readFileSync(last, 'utf8').trim()).equals('done')
    expect(statusFor(KEY)).equals(undefined)
    // A key it does not hold is nothing to wait for.
    await clearLiveSettled(OTHER_KEY, 'never held')
  })

  it('keeps a hole of a few hundred milliseconds and a continuous frame of slack', function () {
    const frame = 1 / 30
    expect(
      timelineHole([
        { start: 0, duration: 4 },
        { start: 4.3, duration: 4 }
      ])
    ).equals(true)
    expect(
      timelineHole([
        { start: 0, duration: 4 },
        { start: 4 + frame, duration: 4 }
      ])
    ).equals(false)
    expect(
      timelineHole([
        { start: 0.066667, duration: 4 },
        { start: 4.066667, duration: 4 }
      ])
    ).equals(false)
  })

  it('keeps a timestamp hole when the live playlist is remuxed', async function () {
    this.timeout(30_000)
    let ffmpeg = process.env.TS_FFMPEG ?? '/opt/homebrew/bin/ffmpeg'
    try {
      execFileSync(ffmpeg, ['-version'])
    } catch {
      ffmpeg = ''
    }
    if (ffmpeg === '') this.skip()
    const common = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x120:rate=30:duration=1',
      '-c:v',
      'libx264',
      '-g',
      '30',
      '-f',
      'hls',
      '-hls_time',
      '4',
      '-hls_playlist_type',
      'event',
      '-hls_segment_type',
      'fmp4',
      '-hls_segment_filename',
      join(dir, 'seg%06d.m4s')
    ]
    execFileSync(ffmpeg, [
      ...common,
      '-hls_flags',
      'independent_segments+omit_endlist',
      join(dir, 'master.m3u8')
    ])
    execFileSync(ffmpeg, [
      ...common,
      '-hls_flags',
      'independent_segments+append_list+omit_endlist',
      join(dir, 'master.m3u8')
    ])
    const initPath = join(dir, 'init.mp4')
    const firstPath = join(dir, 'seg000000.m4s')
    const initBefore = readFileSync(initPath)
    const firstBefore = readFileSync(firstPath)
    stampNewSegments(dir, 31, segmentsFrom(dir, 1))
    const init = readFileSync(initPath)
    const first = readFileSync(firstPath)
    const second = readFileSync(join(dir, 'seg000001.m4s'))
    expect(init.equals(initBefore)).equals(true)
    expect(first.equals(firstBefore)).equals(true)
    expect(timelineStartSec(init, first)).closeTo(0, 0.2)
    expect(timelineStartSec(init, second)).closeTo(31, 0.1)
    const ffprobe = ffmpeg.replace(/ffmpeg$/, 'ffprobe')
    const range = (bytes: Buffer): { min: number; max: number } => {
      const file = join(dir, 'probe.mp4')
      writeFileSync(file, Buffer.concat([init, bytes]))
      const text = execFileSync(ffprobe, [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'packet=pts_time',
        '-of',
        'csv=p=0',
        file
      ]).toString()
      const times = text
        .trim()
        .split('\n')
        .map(Number)
        .filter(value => Number.isFinite(value))
      return { min: Math.min(...times), max: Math.max(...times) }
    }
    const early = range(first)
    const later = range(second)
    expect(later.min - early.max).closeTo(30, 1)
    const playlist = readFileSync(join(dir, 'master.m3u8'), 'utf8')
    const closed = join(dir, 'closed.m3u8')
    writeFileSync(
      closed,
      playlist.includes('#EXT-X-ENDLIST')
        ? playlist
        : `${playlist.trimEnd()}\n#EXT-X-ENDLIST\n`
    )
    const listed = execFileSync(ffprobe, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'packet=pts_time',
      '-of',
      'csv=p=0',
      closed
    ])
      .toString()
      .trim()
      .split('\n')
      .map(Number)
      .filter(value => Number.isFinite(value))
      .sort((a, b) => a - b)
    let hole = 0
    for (let i = 1; i < listed.length; i++) {
      hole = Math.max(hole, listed[i] - listed[i - 1])
    }
    expect(hole).closeTo(30, 1)
    const source = await fileForRemux(dir)
    const scratch = readdirSync(join(dir, '.holes'))
    expect(scratch.some(name => name.endsWith('.mp4'))).equals(false)
    const vod = join(dir, 'vod')
    mkdirSync(vod)
    await remuxToHls(ffmpeg, {
      input: source,
      outDir: vod,
      videoTag: 'avc1',
      concatList: true
    })
    const probed = execFileSync(ffmpeg.replace(/ffmpeg$/, 'ffprobe'), [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      join(vod, VIDEO_FILE)
    ])
    expect(Number(probed.toString().trim())).closeTo(32, 1)
  })
})
