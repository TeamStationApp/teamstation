import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type PlaylistAnswer,
  playlistSeconds,
  type PlaylistWatchClock,
  targetSeconds,
  watchLivePlaylist
} from './livePlaylistWatch'

function manualClock(): PlaylistWatchClock & {
  advance: (ms: number) => void
  sleep: (ms: number) => void
} {
  let now = 1_000_000
  let timers: Array<{ at: number; run: () => void; id: number }> = []
  let next = 1
  const runDue = (until: number, atDue: boolean): void => {
    for (;;) {
      const due = timers
        .filter(timer => timer.at <= until)
        .sort((a, b) => a.at - b.at)[0]
      if (due == null) break
      timers = timers.filter(timer => timer !== due)
      if (atDue) now = due.at
      due.run()
    }
    now = until
  }
  return {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = next++
      timers.push({ at: now + ms, run, id })
      return id
    },
    clearTimeout: id => {
      timers = timers.filter(timer => timer.id !== id)
    },
    advance: ms => {
      runDue(now + ms, true)
    },
    // The machine slept: no timer ran on time, and the first to run sees the
    // clock already moved on.
    sleep: ms => {
      now += ms
      runDue(now, false)
    }
  }
}

/** A live media playlist of `count` segments of `seconds` each. */
function playlist(count: number, seconds = 4): string {
  const lines = [
    '#EXTM3U',
    `#EXT-X-TARGETDURATION:${String(seconds)}`,
    '#EXT-X-PLAYLIST-TYPE:EVENT'
  ]
  for (let i = 0; i < count; i++) {
    lines.push(`#EXTINF:${seconds.toFixed(6)},`, `seg${String(i)}.m4s`)
  }
  return lines.join('\n') + '\n'
}

function ok(text: string): PlaylistAnswer {
  return { status: 200, text }
}

/** A Safari `<video>` as far as the watch looks at it. */
function safari(): {
  currentTime: number
  paused: boolean
  ended: boolean
  end: number
  seekable: { length: number; end: (index: number) => number }
} {
  const video = {
    currentTime: 388,
    paused: false,
    ended: false,
    end: 388,
    seekable: { length: 1, end: () => video.end }
  }
  return video
}

/** Lets a fetch that has already answered finish what it started. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

async function run(
  clock: ReturnType<typeof manualClock>,
  seconds: number,
  each?: () => void
): Promise<void> {
  for (let i = 0; i < seconds / 5; i++) {
    each?.()
    clock.advance(5000)
    await settle()
  }
}

describe('watching Safari read a live playlist', function () {
  it('reloads a player that has stopped reading a playlist the game carries on writing', async function () {
    const clock = manualClock()
    const started = clock.now()
    const video = safari()
    let reloads = 0
    let fetches = 0
    const stop = watchLivePlaylist(video, {
      url: 'https://example.test/master.m3u8',
      wantsToPlay: () => true,
      reload: () => {
        reloads += 1
      },
      // A segment every four seconds, as the camera keeps sending.
      fetch: async () => {
        fetches += 1
        return ok(playlist(100 + Math.floor((clock.now() - started) / 4000)))
      },
      clock
    })
    // Under twenty seconds still, nobody looks.
    await run(clock, 15)
    expect(fetches).equals(0)
    // The first look notes how far the server has got; the next sees it grew.
    await run(clock, 15)
    expect(fetches).equals(1)
    expect(reloads).equals(0)
    await run(clock, 10)
    expect(reloads, 'loaded again').equals(1)
    // Still behind, it is loaded again, less and less often.
    await run(clock, 200)
    expect(reloads).within(2, 4)
    stop()
  })

  it('leaves a player alone while the game itself is waiting, however long its segments', async function () {
    const clock = manualClock()
    const video = safari()
    // Eight-second segments: a player holds back 24 s, so the server's
    // playlist runs well past its end while nothing new is written.
    let reloads = 0
    let fetches = 0
    const stop = watchLivePlaylist(video, {
      url: 'https://example.test/master.m3u8',
      wantsToPlay: () => true,
      reload: () => {
        reloads += 1
      },
      fetch: async () => {
        fetches += 1
        return ok(playlist(52, 8))
      },
      clock
    })
    await run(clock, 300)
    expect(fetches).greaterThan(10)
    expect(reloads).equals(0)
    stop()
  })

  it('wants two of the playlist’s own segments of growth before it reloads', async function () {
    const clock = manualClock()
    const video = safari()
    let count = 52
    let reloads = 0
    const stop = watchLivePlaylist(video, {
      url: 'https://example.test/master.m3u8',
      wantsToPlay: () => true,
      reload: () => {
        reloads += 1
      },
      fetch: async () => ok(playlist(count, 8)),
      clock
    })
    await run(clock, 25)
    // One eight-second segment more: not enough.
    count += 1
    await run(clock, 10)
    expect(reloads).equals(0)
    count += 1
    await run(clock, 10)
    expect(reloads).equals(1)
    stop()
  })

  it('leaves a player on a slow line alone: it is still reading its playlist', async function () {
    const clock = manualClock()
    const video = safari()
    let fetches = 0
    const stop = watchLivePlaylist(video, {
      url: 'https://example.test/master.m3u8',
      wantsToPlay: () => true,
      reload: () => undefined,
      fetch: async () => {
        fetches += 1
        return ok(playlist(200))
      },
      clock
    })
    // The picture waits for its buffer while the end of what it can reach moves on.
    await run(clock, 120, () => {
      video.end += 4
    })
    expect(fetches).equals(0)
    stop()
  })

  it('leaves a picture that is still playing alone, whatever its end does', async function () {
    const clock = manualClock()
    const video = safari()
    let fetches = 0
    const stop = watchLivePlaylist(video, {
      url: 'https://example.test/master.m3u8',
      wantsToPlay: () => true,
      reload: () => undefined,
      fetch: async () => {
        fetches += 1
        return ok(playlist(200))
      },
      clock
    })
    await run(clock, 120, () => {
      video.currentTime += 5
    })
    expect(fetches).equals(0)
    stop()
  })

  it('leaves a paused or ended player, or one nobody wants playing, alone', async function () {
    for (const state of ['paused', 'ended', 'unwanted']) {
      const clock = manualClock()
      const video = safari()
      video.paused = state === 'paused'
      video.ended = state === 'ended'
      let fetches = 0
      const stop = watchLivePlaylist(video, {
        url: 'https://example.test/master.m3u8',
        wantsToPlay: () => state !== 'unwanted',
        reload: () => undefined,
        fetch: async () => {
          fetches += 1
          return ok(playlist(200))
        },
        clock
      })
      await run(clock, 120)
      expect(fetches, state).equals(0)
      stop()
    }
  })

  it('reloads at once when the address is refused, so a new one can be asked for', async function () {
    const clock = manualClock()
    const video = safari()
    let reloads = 0
    const stop = watchLivePlaylist(video, {
      url: 'https://example.test/master.m3u8',
      wantsToPlay: () => true,
      reload: () => {
        reloads += 1
      },
      fetch: async () => ({ status: 403 }),
      clock
    })
    await run(clock, 25)
    expect(reloads).equals(1)
    stop()
  })

  it('starts its clocks again after the machine slept', async function () {
    const clock = manualClock()
    const started = clock.now()
    const video = safari()
    let fetches = 0
    const stop = watchLivePlaylist(video, {
      url: 'https://example.test/master.m3u8',
      wantsToPlay: () => true,
      reload: () => undefined,
      fetch: async () => {
        fetches += 1
        return ok(playlist(100 + Math.floor((clock.now() - started) / 4000)))
      },
      clock
    })
    await run(clock, 10)
    clock.sleep(60_000)
    await settle()
    // Woken, it waits as long as it would have for a fresh stall.
    await run(clock, 15)
    expect(fetches).equals(0)
    stop()
  })

  it('stops looking once it is detached, even mid-fetch', async function () {
    const clock = manualClock()
    const video = safari()
    let reloads = 0
    let answer: (value: PlaylistAnswer) => void = () => undefined
    const stop = watchLivePlaylist(video, {
      url: 'https://example.test/master.m3u8',
      wantsToPlay: () => true,
      reload: () => {
        reloads += 1
      },
      fetch: async () =>
        await new Promise<PlaylistAnswer>(resolve => {
          answer = resolve
        }),
      clock
    })
    await run(clock, 25)
    stop()
    answer({ status: 403 })
    await settle()
    expect(reloads).equals(0)
  })
})

describe('reading a playlist', function () {
  it('adds up a media playlist’s segments', function () {
    expect(playlistSeconds(playlist(3))).equals(12)
    expect(
      playlistSeconds('#EXTM3U\n#EXTINF:3.95,\na.m4s\n#EXTINF:4.05,\nb.m4s\n')
    ).closeTo(8, 1e-9)
  })

  it('has no length for a master playlist, an empty one or anything else', function () {
    expect(
      playlistSeconds(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\nvideo.m3u8\n'
      )
    ).equals(undefined)
    expect(playlistSeconds('#EXTM3U\n')).equals(undefined)
    expect(playlistSeconds('<html>')).equals(undefined)
  })

  it('reads the target duration, four seconds if none is given', function () {
    expect(targetSeconds(playlist(3, 8))).equals(8)
    expect(targetSeconds('#EXTM3U\n')).equals(4)
  })
})
