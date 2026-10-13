import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  isOpenPlaylist,
  liveRejoin,
  REJOIN_POLL_MS,
  type RejoinClock
} from './liveRejoin'

/**
 * A live game whose playlist was closed under the player, while the game
 * still lists the video as live: the player waits for it to open again and
 * rejoins. A video the game no longer lists as live ends as it always has.
 */

const OPEN = '#EXTM3U\n#EXTINF:4.000000,\nseg000000.m4s\n'
const CLOSED = `${OPEN}#EXT-X-ENDLIST\n`
const MULTIVARIANT =
  '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nvideo.m3u8\n'

function manualClock(): RejoinClock & {
  advance: (ms: number) => void
  pending: () => number
} {
  let now = 0
  let timers: Array<{ at: number; run: () => void; id: number }> = []
  let next = 1
  return {
    setTimeout: (run, ms) => {
      const id = next++
      timers.push({ at: now + ms, run, id })
      return id
    },
    clearTimeout: id => {
      timers = timers.filter(timer => timer.id !== id)
    },
    advance: ms => {
      now += ms
      const due = timers.filter(timer => timer.at <= now)
      timers = timers.filter(timer => timer.at > now)
      for (const timer of due) timer.run()
    },
    pending: () => timers.length
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++)
    await new Promise(resolve => setImmediate(resolve))
}

function rig(options: {
  live: Array<boolean | 'throw'>
  playlists: Array<string | 'throw'>
}): {
  rejoins: number
  asked: number
  fetched: number
  clock: ReturnType<typeof manualClock>
  waiter: ReturnType<typeof liveRejoin>
} {
  const clock = manualClock()
  const state = {
    rejoins: 0,
    asked: 0,
    fetched: 0,
    clock,
    waiter: undefined as unknown as ReturnType<typeof liveRejoin>
  }
  state.waiter = liveRejoin({
    isLive: () => {
      const answer =
        options.live[Math.min(state.asked, options.live.length - 1)]
      state.asked += 1
      if (answer === 'throw') throw new Error('the server is away')
      return answer
    },
    fetchPlaylist: async () => {
      const text =
        options.playlists[Math.min(state.fetched, options.playlists.length - 1)]
      state.fetched += 1
      if (text === 'throw') throw new Error('no network')
      return text
    },
    rejoin: () => {
      state.rejoins += 1
    },
    clock
  })
  return state
}

describe('rejoining a live game whose playlist was closed', function () {
  it('reads a playlist as open only while it lists segments and is not closed', function () {
    expect(isOpenPlaylist(OPEN)).equals(true)
    expect(isOpenPlaylist(CLOSED)).equals(false)
    expect(isOpenPlaylist(MULTIVARIANT)).equals(false)
  })

  it('lets a video the game no longer lists as live end, as it always has', async function () {
    const state = rig({ live: [false], playlists: [OPEN] })
    state.waiter.ended()
    await settle()
    expect(state.asked).equals(1)
    expect(state.fetched).equals(0)
    expect(state.rejoins).equals(0)
    expect(state.clock.pending()).equals(0)
  })

  it('waits for a live video’s playlist to open, then rejoins once', async function () {
    const state = rig({ live: [true], playlists: [CLOSED, CLOSED, OPEN] })
    state.waiter.ended()
    await settle()
    expect(state.fetched).equals(1)
    expect(state.rejoins).equals(0)
    // Told again while it is waiting: still one wait.
    state.waiter.ended()
    await settle()
    expect(state.fetched).equals(1)
    state.clock.advance(REJOIN_POLL_MS)
    await settle()
    expect(state.fetched).equals(2)
    expect(state.rejoins).equals(0)
    state.clock.advance(REJOIN_POLL_MS)
    await settle()
    expect(state.rejoins).equals(1)
    expect(state.clock.pending()).equals(0)
    // Closed again later: it waits again.
    state.waiter.ended()
    await settle()
    expect(state.rejoins).equals(2)
  })

  it('keeps waiting through a server or a network it cannot reach', async function () {
    const state = rig({ live: ['throw', true], playlists: ['throw', OPEN] })
    state.waiter.ended()
    await settle()
    expect(state.rejoins).equals(0)
    expect(state.clock.pending()).equals(1)
    state.clock.advance(REJOIN_POLL_MS)
    await settle()
    expect(state.rejoins).equals(1)
  })

  it('stops the moment the player goes, even part way through a look', async function () {
    const waiting = rig({ live: [true], playlists: [CLOSED] })
    waiting.waiter.ended()
    await settle()
    waiting.waiter.stop()
    expect(waiting.clock.pending()).equals(0)
    waiting.waiter.ended()
    await settle()
    expect(waiting.fetched).equals(1)

    // Gone while the server was being asked, and while the playlist was.
    for (const gone of ['asking', 'fetching'] as const) {
      let release: () => void = () => undefined
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      let rejoins = 0
      const waiter = liveRejoin({
        isLive: async () => {
          if (gone === 'asking') await held
          return true
        },
        fetchPlaylist: async () => {
          if (gone === 'fetching') await held
          return OPEN
        },
        rejoin: () => {
          rejoins += 1
        },
        clock: manualClock()
      })
      waiter.ended()
      await settle()
      waiter.stop()
      release()
      await settle()
      expect(rejoins, gone).equals(0)
    }
  })

  it('runs on the real clock when none is given', function (done) {
    const waiter = liveRejoin({
      isLive: () => true,
      fetchPlaylist: async () => CLOSED,
      rejoin: () => undefined,
      pollMs: 5
    })
    waiter.ended()
    setTimeout(() => {
      waiter.stop()
      done()
    }, 30)
  })
})
