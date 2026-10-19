import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  playlistSeconds,
  type PlaylistWatchClock,
  watchLivePlaylist
} from './livePlaylistWatch'

function manualClock(): PlaylistWatchClock & { advance: (ms: number) => void } {
  let now = 1_000_000
  let timers: Array<{ at: number; run: () => void; id: number }> = []
  let next = 1
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
      const until = now + ms
      for (;;) {
        const due = timers
          .filter(timer => timer.at <= until)
          .sort((a, b) => a.at - b.at)[0]
        if (due == null) break
        timers = timers.filter(timer => timer !== due)
        now = due.at
        due.run()
      }
      now = until
    }
  }
}

/** A live media playlist of `count` four-second segments. */
function playlist(count: number): string {
  const lines = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-PLAYLIST-TYPE:EVENT'
  ]
  for (let i = 0; i < count; i++) lines.push('#EXTINF:4.000000,', `seg${i}.m4s`)
  return lines.join('\n') + '\n'
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

describe('watching Safari read a live playlist', function () {
  it('reloads a player that has stopped reading a playlist the game has carried on writing', async function () {
    const clock = manualClock()
    const video = safari()
    // The server's playlist runs 100 segments: 400 s. The player stopped at 388.
    let server = playlist(100)
    let reloads = 0
    let fetches = 0
    const stop = watchLivePlaylist(video, {
      url: 'https://example.test/master.m3u8',
      wantsToPlay: () => true,
      reload: () => {
        reloads += 1
      },
      fetchText: async () => {
        fetches += 1
        return server
      },
      clock
    })
    // Under twenty seconds still, nobody looks.
    clock.advance(15_000)
    await settle()
    expect(fetches).equals(0)
    // Twenty seconds on the playlist has grown and the player has not.
    server = playlist(110)
    clock.advance(10_000)
    await settle()
    expect(fetches).equals(1)
    expect(reloads, 'loaded again').equals(1)
    // Still behind: loaded again once it has stood still as long again, and
    // after that the waits double.
    clock.advance(20_000)
    await settle()
    expect(reloads).equals(1)
    clock.advance(5_000)
    await settle()
    expect(reloads).equals(2)
    clock.advance(35_000)
    await settle()
    expect(reloads).equals(2)
    clock.advance(10_000)
    await settle()
    expect(reloads).equals(3)
    stop()
  })

  it('leaves a player alone while the game itself is waiting', async function () {
    const clock = manualClock()
    const video = safari()
    // The camera at the field is away: the server's playlist ends where the
    // player's does, but for the three segments a player holds back.
    let reloads = 0
    const stop = watchLivePlaylist(video, {
      url: 'https://example.test/master.m3u8',
      wantsToPlay: () => true,
      reload: () => {
        reloads += 1
      },
      fetchText: async () => playlist(100),
      clock
    })
    for (let i = 0; i < 24; i++) {
      clock.advance(5000)
      await settle()
    }
    expect(reloads).equals(0)
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
      fetchText: async () => {
        fetches += 1
        return playlist(200)
      },
      clock
    })
    // The picture waits for its buffer while the end of what it can reach moves on.
    for (let i = 0; i < 24; i++) {
      video.end += 4
      clock.advance(5000)
      await settle()
    }
    expect(fetches).equals(0)
    stop()
  })

  it('leaves a paused player, or one nobody wants playing, alone', async function () {
    for (const paused of [true, false]) {
      const clock = manualClock()
      const video = safari()
      video.paused = paused
      let fetches = 0
      const stop = watchLivePlaylist(video, {
        url: 'https://example.test/master.m3u8',
        wantsToPlay: () => paused,
        reload: () => undefined,
        fetchText: async () => {
          fetches += 1
          return playlist(200)
        },
        clock
      })
      clock.advance(120_000)
      await settle()
      expect(fetches).equals(0)
      stop()
    }
  })

  it('stops looking once it is detached, even mid-fetch', async function () {
    const clock = manualClock()
    const video = safari()
    let reloads = 0
    let answer: (text: string) => void = () => undefined
    const stop = watchLivePlaylist(video, {
      url: 'https://example.test/master.m3u8',
      wantsToPlay: () => true,
      reload: () => {
        reloads += 1
      },
      fetchText: async () =>
        await new Promise<string>(resolve => {
          answer = resolve
        }),
      clock
    })
    clock.advance(25_000)
    stop()
    answer(playlist(200))
    await settle()
    expect(reloads).equals(0)
  })
})

describe('how long a playlist runs', function () {
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
})
