import { expect } from 'chai'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  attachSessionForTest,
  clearLive,
  codecName,
  codecRefusal,
  configureIngest,
  forcePublishForTest,
  hideKey,
  isPublishableKey,
  keyFromSession,
  type LiveEvent,
  nextSegmentNumber,
  publishArrivedForTest,
  publishGoneForTest,
  reopenPlaylist,
  resetForTest,
  restartDelay,
  setLive,
  statusFor,
  type TestSession,
  tickSamplerForTest
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
