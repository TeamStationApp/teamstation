// The DOM these tests render into. `npm test` and `coverage.app` load it already; the server's
// coverage scripts run every `src/**/*.test.ts` without it, so the file brings its own.
import '../../test/scoringDomSetup.cjs'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import type { RadarDevice, RadarState } from './phoneStreamClient'
import {
  makeScoreboardRadarPublisher,
  PITCH_CLEAR,
  type PublisherSocket,
  readingPayload,
  scoreboardPublishUrl,
  useScoreboardRadarPublisher
} from './scoreboardRadarPublisher'

const START = 1_790_000_000_000

interface FakeSocket extends PublisherSocket {
  url: string
  headers: Record<string, string>
  sent: string[]
  closed: boolean
  readyState: number
  /** The server answers: the socket is open. */
  accept: () => void
  /** The connection ends with `code`. */
  drop: (code?: number) => void
}

function harness(): {
  sockets: FakeSocket[]
  open: (url: string, headers: Record<string, string>) => PublisherSocket
  timers: {
    setTimeout: (work: () => void, ms: number) => unknown
    clearTimeout: (timer: unknown) => void
  }
  /** Runs every timer due within `ms` from now, in order. */
  advance: (ms: number) => void
  waits: number[]
  clock: () => number
} {
  const sockets: FakeSocket[] = []
  let time = START
  let nextId = 1
  const due = new Map<number, { at: number; work: () => void }>()
  const waits: number[] = []
  return {
    sockets,
    waits,
    clock: () => time,
    open: (url, headers) => {
      const socket: FakeSocket = {
        url,
        headers,
        sent: [],
        closed: false,
        readyState: 0,
        onopen: null,
        onclose: null,
        onerror: null,
        send: text => {
          socket.sent.push(text)
        },
        close: () => {
          socket.closed = true
          socket.readyState = 3
        },
        accept: () => {
          socket.readyState = 1
          socket.onopen?.()
        },
        drop: code => {
          socket.readyState = 3
          socket.onerror?.(new Error('dropped'))
          socket.onclose?.({ code })
        }
      }
      sockets.push(socket)
      return socket
    },
    timers: {
      setTimeout: (work, ms) => {
        const id = nextId++
        waits.push(ms)
        due.set(id, { at: time + ms, work })
        return id
      },
      clearTimeout: timer => {
        due.delete(timer as number)
      }
    },
    advance: ms => {
      const until = time + ms
      for (;;) {
        const next = [...due.entries()]
          .filter(([, entry]) => entry.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (next == null) break
        due.delete(next[0])
        time = next[1].at
        next[1].work()
      }
      time = until
    }
  }
}

const device = (overrides: Partial<RadarDevice> = {}): RadarDevice => ({
  serial: 'TAG-00000001',
  connection: 'connected',
  batteryPercent: 80,
  pitchMph: null,
  exitMph: null,
  readingAt: null,
  ...overrides
})

const radar = (...devices: RadarDevice[]): RadarState => ({
  enabled: true,
  scanning: false,
  bluetooth: 'on',
  devices,
  nearby: []
})

describe('the scoreboard radar publisher', function () {
  it('publishes to the game’s scoreboard socket on the API’s host', function () {
    expect(
      scoreboardPublishUrl('https://teamstation.example.test/api/v1/', 'gam_1')
    ).equals('wss://teamstation.example.test/api/v1/scoreboard/gam_1/publish')
    expect(
      scoreboardPublishUrl('http://bench.example.test:9100/api/v1', 'gam 2')
    ).equals('ws://bench.example.test:9100/api/v1/scoreboard/gam%202/publish')
    expect(scoreboardPublishUrl('/api/v1', 'gam_1')).equals(null)
  })

  it('words a reading as TS Cameraman does', function () {
    expect(readingPayload(72.4, 88)).equals(
      '{"pitchSpeed":72,"exitVelocity":88}'
    )
    expect(readingPayload(72, null)).equals('{"pitchSpeed":72}')
    expect(readingPayload(0, 91)).equals('{"exitVelocity":91}')
    expect(readingPayload(null, 0)).equals(null)
  })

  it('sends a reading with the bearer token, then the clear 5 s later', function () {
    const h = harness()
    const publisher = makeScoreboardRadarPublisher({
      apiBase: 'https://teamstation.example.test/api/v1',
      gameId: 'gam_1',
      token: 'token-0000',
      open: h.open,
      timers: h.timers,
      now: h.clock
    })
    // Paired, so the socket opens; nothing to say yet.
    publisher.update(radar(device()))
    expect(h.sockets).has.length(1)
    const socket = h.sockets[0]
    expect(socket.url).equals(
      'wss://teamstation.example.test/api/v1/scoreboard/gam_1/publish'
    )
    expect(socket.headers).deep.equals({ Authorization: 'Bearer token-0000' })
    // A pitch while the socket is still opening waits for it.
    publisher.update(radar(device({ pitchMph: 72, readingAt: START + 1000 })))
    expect(socket.sent).deep.equals([])
    socket.accept()
    expect(socket.sent).deep.equals(['{"pitchSpeed":72}'])
    h.advance(4999)
    expect(socket.sent).has.length(1)
    h.advance(1)
    expect(socket.sent).deep.equals(['{"pitchSpeed":72}', PITCH_CLEAR])
    publisher.stop()
    expect(socket.closed).equals(true)
  })

  it('sends only what arrived, restarting the hold on each pitch', function () {
    const h = harness()
    const publisher = makeScoreboardRadarPublisher({
      apiBase: 'https://teamstation.example.test/api/v1',
      gameId: 'gam_1',
      token: 'token-0000',
      open: h.open,
      timers: h.timers,
      now: h.clock
    })
    // A reading from before the screen opened is not news.
    publisher.update(radar(device({ pitchMph: 60, readingAt: START - 5000 })))
    h.sockets[0].accept()
    expect(h.sockets[0].sent).deep.equals([])
    h.advance(1000)
    publisher.update(radar(device({ pitchMph: 72, readingAt: START + 1000 })))
    h.advance(3000)
    // The exit of the same pitch: exit velocity only, and the hold runs on.
    publisher.update(
      radar(device({ pitchMph: 72, exitMph: 88, readingAt: START + 4000 }))
    )
    // The same report again is not another reading.
    publisher.update(
      radar(device({ pitchMph: 72, exitMph: 88, readingAt: START + 4000 }))
    )
    h.advance(2000)
    expect(h.sockets[0].sent).deep.equals([
      '{"pitchSpeed":72}',
      '{"exitVelocity":88}',
      PITCH_CLEAR
    ])
    // The same two speeds at a new time are a new reading of both.
    publisher.update(
      radar(device({ pitchMph: 72, exitMph: 88, readingAt: START + 9000 }))
    )
    h.advance(3000)
    publisher.update(
      radar(device({ pitchMph: 75, exitMph: 88, readingAt: START + 12000 }))
    )
    h.advance(4999)
    expect(h.sockets[0].sent.slice(3)).deep.equals([
      '{"pitchSpeed":72,"exitVelocity":88}',
      '{"pitchSpeed":75}'
    ])
    h.advance(1)
    expect(h.sockets[0].sent.at(-1)).equals(PITCH_CLEAR)
    publisher.stop()
  })

  it('takes the latest reading across radars', function () {
    const h = harness()
    const publisher = makeScoreboardRadarPublisher({
      apiBase: 'https://teamstation.example.test/api/v1',
      gameId: 'gam_1',
      token: 'token-0000',
      open: h.open,
      timers: h.timers,
      now: h.clock
    })
    const first = device({ serial: 'TAG-00000001' })
    const second = device({ serial: 'TAG-00000002' })
    publisher.update(radar(first, second))
    h.sockets[0].accept()
    publisher.update(
      radar(
        { ...first, pitchMph: 70, readingAt: START + 2000 },
        { ...second, pitchMph: 71, readingAt: START + 2100 }
      )
    )
    // The first radar's report of an older pitch comes late: not sent.
    publisher.update(
      radar(
        { ...first, pitchMph: 69, readingAt: START + 2050 },
        { ...second, pitchMph: 71, readingAt: START + 2100 }
      )
    )
    expect(h.sockets[0].sent).deep.equals(['{"pitchSpeed":71}'])
    publisher.stop()
  })

  it('drops a pending clear when the radar goes, so a later pairing starts clean', function () {
    const h = harness()
    const publisher = makeScoreboardRadarPublisher({
      apiBase: 'https://teamstation.example.test/api/v1',
      gameId: 'gam_1',
      token: 'token-0000',
      open: h.open,
      timers: h.timers,
      now: h.clock
    })
    publisher.update(radar(device({ pitchMph: 72, readingAt: START + 1000 })))
    h.sockets[0].accept()
    expect(h.sockets[0].sent).deep.equals(['{"pitchSpeed":72}'])
    // Unpaired inside the hold: the clear does not wait for the next radar.
    publisher.update(radar())
    h.advance(10000)
    publisher.update(radar(device({ readingAt: START + 1000, pitchMph: 72 })))
    expect(h.sockets).has.length(2)
    h.sockets[1].accept()
    expect(h.sockets[1].sent).deep.equals([])
    publisher.stop()
  })

  it('closes when no radar is paired, opens again when one is, and backs off after a drop', function () {
    const h = harness()
    const publisher = makeScoreboardRadarPublisher({
      apiBase: 'https://teamstation.example.test/api/v1',
      gameId: 'gam_1',
      token: 'token-0000',
      open: h.open,
      timers: h.timers,
      now: h.clock
    })
    publisher.update(null)
    publisher.update({ ...radar(device()), enabled: false })
    expect(h.sockets).has.length(0)
    publisher.update(radar(device()))
    publisher.update(radar())
    expect(h.sockets[0].closed).equals(true)
    // The closed socket's own close is not a drop.
    h.sockets[0].drop(1000)
    expect(h.waits).deep.equals([])
    publisher.update(radar(device()))
    expect(h.sockets).has.length(2)
    h.sockets[1].accept()
    h.sockets[1].drop(1006)
    h.advance(1000)
    expect(h.sockets).has.length(3)
    h.sockets[2].drop(1006)
    h.advance(2000)
    expect(h.sockets).has.length(4)
    expect(h.waits).deep.equals([1000, 2000])
    // A reading while it is down waits for the next socket.
    h.sockets[3].drop(1006)
    publisher.update(radar(device({ exitMph: 90, readingAt: START + 5000 })))
    h.advance(4000)
    h.sockets[4].accept()
    expect(h.sockets[4].sent).deep.equals(['{"exitVelocity":90}'])
    // Unpaired while a retry waits: the retry is dropped.
    h.sockets[4].drop(1006)
    publisher.update(radar())
    h.advance(60000)
    expect(h.sockets).has.length(5)
    publisher.stop()
    publisher.update(radar(device()))
    expect(h.sockets).has.length(5)
  })

  it('stops trying once the server refuses', function () {
    const h = harness()
    const publisher = makeScoreboardRadarPublisher({
      apiBase: 'https://teamstation.example.test/api/v1',
      gameId: 'gam_1',
      token: 'token-0000',
      open: h.open,
      timers: h.timers,
      now: h.clock
    })
    publisher.update(radar(device()))
    h.sockets[0].drop(4403)
    publisher.update(radar(device({ pitchMph: 70, readingAt: START + 1 })))
    h.advance(60000)
    expect(h.sockets).has.length(1)
    expect(h.sockets[0].sent).deep.equals([])
    publisher.stop()
  })

  it('sends nothing for an API without a host', function () {
    const h = harness()
    const publisher = makeScoreboardRadarPublisher({
      apiBase: '/api/v1',
      gameId: 'gam_1',
      token: 'token-0000',
      open: h.open,
      timers: h.timers,
      now: h.clock
    })
    publisher.update(radar(device({ pitchMph: 70, readingAt: START + 1 })))
    h.advance(10000)
    expect(h.sockets).has.length(0)
    publisher.stop()
  })

  it('runs for as long as the screen with a token is up', async function () {
    const h = harness()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    function Screen(props: {
      token: string | null
      state: RadarState | null
    }): null {
      useScoreboardRadarPublisher({
        apiBase: 'https://teamstation.example.test/api/v1',
        gameId: 'gam_1',
        token: props.token,
        radar: props.state,
        open: h.open,
        timers: h.timers
      })
      return null
    }
    const show = async (
      token: string | null,
      state: RadarState | null
    ): Promise<void> => {
      await act(async () => {
        root.render(React.createElement(Screen, { token, state }))
      })
    }
    await show(null, radar(device()))
    expect(h.sockets).has.length(0)
    await show('token-0000', radar(device()))
    expect(h.sockets).has.length(1)
    h.sockets[0].accept()
    await show(
      'token-0000',
      radar(device({ pitchMph: 80, readingAt: Date.now() + 1000 }))
    )
    expect(h.sockets[0].sent).deep.equals(['{"pitchSpeed":80}'])
    await act(async () => {
      root.unmount()
    })
    expect(h.sockets[0].closed).equals(true)
  })
})
