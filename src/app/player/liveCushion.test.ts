import { expect } from 'chai'
import { describe, it } from 'mocha'

import { seekTo } from './explicitSeek'
import { joinLiveWithCushion, SLACK_SEC } from './liveCushion'
import { readRealEndSec, realEndSec } from './livePlaylistEnd'
import type { VideoEventName } from './videoHandle'

function player(currentTime: number): {
  currentTime: number
  liveEdge: number | null
  fire: (type: VideoEventName) => void
  addEventListener: (type: VideoEventName, fn: () => void) => void
  removeEventListener: (type: VideoEventName, fn: () => void) => void
  listening: () => number
} {
  const listeners = new Map<VideoEventName, Set<() => void>>()
  return {
    currentTime,
    liveEdge: null,
    fire: type => {
      listeners.get(type)?.forEach(fn => {
        fn()
      })
    },
    addEventListener: (type, fn) => {
      const set = listeners.get(type) ?? new Set()
      set.add(fn)
      listeners.set(type, set)
    },
    removeEventListener: (type, fn) => {
      listeners.get(type)?.delete(fn)
    },
    listening: () =>
      [...listeners.values()].reduce((sum, set) => sum + set.size, 0)
  }
}

/** Lets a settled promise's callbacks run. */
const settle = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('a phone joining a live game (U26)', function () {
  it('moves to 45 s behind the playlist’s real end on the first play', async function () {
    const p = player(488)
    p.liveEdge = 488
    let reads = 0
    const stop = joinLiveWithCushion(p, async () => {
      reads += 1
      return 500
    })
    // Not before a play.
    p.fire('timeupdate')
    await settle()
    expect(p.currentTime).equals(488)
    p.fire('play')
    await settle()
    expect(p.currentTime).equals(455)
    // Once: a later play or update leaves the viewer where they are.
    p.currentTime = 470
    p.fire('play')
    p.fire('timeupdate')
    await settle()
    expect(p.currentTime).equals(470)
    expect(reads).equals(1)
    stop()
    expect(p.listening()).equals(0)
  })

  it('waits for the player to say where its range ends', async function () {
    const p = player(0)
    const stop = joinLiveWithCushion(p, async () => 1200)
    p.fire('play')
    await settle()
    expect(p.currentTime).equals(0)
    p.liveEdge = 1188
    p.fire('timeupdate')
    await settle()
    expect(p.currentTime).equals(1155)
    stop()
  })

  it('leaves a start already within the slack of the cushion', async function () {
    const p = player(1155 - SLACK_SEC + 1)
    p.liveEdge = 1188
    const stop = joinLiveWithCushion(p, async () => 1200)
    p.fire('play')
    await settle()
    expect(p.currentTime).equals(1155 - SLACK_SEC + 1)
    stop()
  })

  it('falls back to moving back by what it lacks when the playlist cannot be read', async function () {
    // At the end of its range, AVPlayer's hold-back short of the newest
    // footage: back by the rest of the cushion, from where it is.
    for (const read of [
      async () => undefined,
      async () => await Promise.reject(new Error('offline'))
    ]) {
      const p = player(2388)
      p.liveEdge = 2388
      const stop = joinLiveWithCushion(p, read)
      p.fire('play')
      await settle()
      expect(p.currentTime).equals(2355)
      stop()
    }
    // Nor does one with no reader at all.
    const p = player(2388)
    p.liveEdge = 2388
    joinLiveWithCushion(p)
    p.fire('play')
    await settle()
    expect(p.currentTime).equals(2355)
    // A range that starts later than nought: its length is no position, and
    // a seek to it would send the viewer minutes back.
    const late = player(9000)
    late.liveEdge = 600
    joinLiveWithCushion(late, async () => undefined)
    late.fire('play')
    await settle()
    expect(late.currentTime).equals(8967)
  })

  it('yields to a seek of the viewer’s own, before or while the playlist is read', async function () {
    const before = player(0)
    before.liveEdge = 600
    const stopBefore = joinLiveWithCushion(before, async () => 612)
    seekTo(before, 300)
    before.fire('play')
    await settle()
    expect(before.currentTime).equals(300)
    stopBefore()

    const during = player(588)
    during.liveEdge = 588
    let answer: (end: number) => void = () => undefined
    const stopDuring = joinLiveWithCushion(
      during,
      async () => await new Promise<number>(resolve => (answer = resolve))
    )
    during.fire('play')
    seekTo(during, 120)
    answer(600)
    await settle()
    expect(during.currentTime).equals(120)
    stopDuring()
  })
})

describe('where a live playlist’s newest footage ends (U26)', function () {
  it('sums every segment, across its discontinuities', function () {
    expect(
      realEndSec(
        [
          '#EXTM3U',
          '#EXT-X-TARGETDURATION:4',
          '#EXTINF:4.000000,',
          'seg000000.m4s',
          '#EXTINF:3.960000,',
          'seg000001.m4s',
          '#EXT-X-DISCONTINUITY',
          '#EXT-X-PROGRAM-DATE-TIME:2026-10-19T19:04:27.256-0700',
          '#EXTINF:4.000000,',
          'seg000002.m4s',
          ''
        ].join('\n')
      )
    ).closeTo(11.96, 1e-9)
    expect(realEndSec('#EXTM3U\n#EXT-X-TARGETDURATION:4\n')).equals(undefined)
    expect(realEndSec('<html>')).equals(undefined)
  })

  it('reads it off the playlist at its address, and nothing on a refusal or no network', async function () {
    const real = globalThis.fetch
    const answers: Array<() => Promise<Response>> = [
      async () =>
        new Response('#EXTM3U\n#EXTINF:4.0,\na.m4s\n#EXTINF:2.5,\nb.m4s\n'),
      async () => new Response('gone', { status: 404 }),
      async () => await Promise.reject(new Error('offline'))
    ]
    const asked: Array<HeadersInit | undefined> = []
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      asked.push(init?.headers)
      return await answers[asked.length - 1]()
    }) as typeof fetch
    try {
      expect(
        await readRealEndSec('https://media.example.test/v/master.m3u8')
      ).equals(6.5)
      expect(
        await readRealEndSec('https://media.example.test/v/master.m3u8')
      ).equals(undefined)
      expect(
        await readRealEndSec('https://media.example.test/v/master.m3u8')
      ).equals(undefined)
      expect(asked[0]).deep.equals({ 'cache-control': 'no-cache' })
    } finally {
      globalThis.fetch = real
    }
  })
})
