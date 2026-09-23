import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  SAMPLE_SCOREBOARD,
  type ScoreboardState
} from '../../common/scoreboard'
import { fakeClock, fakeSockets } from '../../test/fakeScoreboardSocket'
import {
  connectScoreboard,
  openReconnecting,
  realSchedule,
  RECONNECT_MS
} from './scoreboardSocket'

function viewer(): {
  states: ScoreboardState[]
  closed: () => number
  sockets: ReturnType<typeof fakeSockets>
  clock: ReturnType<typeof fakeClock>
  handle: { close: () => void }
} {
  const sockets = fakeSockets()
  const clock = fakeClock()
  const states: ScoreboardState[] = []
  let closed = 0
  const handle = connectScoreboard({
    url: 'ws://host/api/v1/scoreboard/g1/socket',
    onState: state => states.push(state),
    onClosed: () => {
      closed++
    },
    WebSocketImpl: sockets.Impl,
    schedule: clock.schedule
  })
  return { states, closed: () => closed, sockets, clock, handle }
}

describe('connectScoreboard', function () {
  it('delivers every state the server sends, and ignores what it cannot read', function () {
    const { states, sockets } = viewer()
    const socket = sockets.latest()
    expect(socket.url).equals('ws://host/api/v1/scoreboard/g1/socket')
    socket.open()
    socket.receive(SAMPLE_SCOREBOARD)
    socket.receive('not json')
    socket.receive({ balls: 'three' })
    socket.receive({ ...SAMPLE_SCOREBOARD, balls: 3 })
    expect(states.map(state => state.balls)).deep.equals([2, 3])
  })

  for (const code of [1006, 1001, 1011]) {
    it(`reconnects ${RECONNECT_MS} ms after a ${code} close`, function () {
      const { sockets, clock, closed } = viewer()
      sockets.latest().drop(code)
      clock.advance(RECONNECT_MS - 1)
      expect(sockets.sockets).length(1)
      clock.advance(1)
      expect(sockets.sockets).length(2)
      expect(closed()).equals(0)
    })
  }

  it('calls onClosed on 4404 and never tries again', function () {
    const { sockets, clock, closed } = viewer()
    sockets.latest().open()
    sockets.latest().drop(4404)
    expect(closed()).equals(1)
    clock.advance(60_000)
    expect(sockets.sockets).length(1)
    expect(clock.pending()).equals(0)
  })

  it('stops for good when the page closes it, even mid-wait', function () {
    const { sockets, clock, handle } = viewer()
    sockets.latest().drop(1006)
    expect(clock.pending()).equals(1)
    handle.close()
    expect(clock.pending()).equals(0)
    clock.advance(RECONNECT_MS)
    expect(sockets.sockets).length(1)
  })

  it('closes an open socket with 1000 and hears nothing more from it', function () {
    const { sockets, states, handle } = viewer()
    const socket = sockets.latest()
    socket.open()
    handle.close()
    expect(socket.closedWith).equals(1000)
    socket.receive(SAMPLE_SCOREBOARD)
    expect(states).length(0)
  })
})

describe('openReconnecting', function () {
  it('retries a socket that could not even be made', function () {
    const clock = fakeClock()
    let made = 0
    // Stands in for a constructor that throws, as WebSocket does on a bad URL.
    function Refused(): never {
      made++
      throw new Error('SyntaxError')
    }
    const socket = openReconnecting({
      url: 'nonsense',
      stopOn: [],
      onMessage: () => undefined,
      onStop: () => undefined,
      WebSocketImpl: Refused as never,
      schedule: clock.schedule
    })
    expect(made).equals(1)
    expect(socket.send('x')).equals(false)
    clock.advance(RECONNECT_MS)
    expect(made).equals(2)
    socket.close()
  })

  it('sends only while open, and reports opening', function () {
    const sockets = fakeSockets()
    let opened = 0
    const socket = openReconnecting({
      url: 'ws://host/x',
      stopOn: [4401],
      onOpen: () => {
        opened++
      },
      onMessage: () => undefined,
      onStop: () => undefined,
      WebSocketImpl: sockets.Impl,
      schedule: fakeClock().schedule
    })
    expect(socket.send('early')).equals(false)
    sockets.latest().open()
    expect(opened).equals(1)
    expect(socket.send('now')).equals(true)
    expect(sockets.latest().sent).deep.equals(['now'])
    // An error event alone changes nothing; the close that follows does.
    sockets.latest().onerror?.({})
    socket.close()
  })

  it('ignores a close from a socket it has already replaced', function () {
    const sockets = fakeSockets()
    const clock = fakeClock()
    let stops = 0
    openReconnecting({
      url: 'ws://host/x',
      stopOn: [4404],
      onMessage: () => undefined,
      onStop: () => {
        stops++
      },
      WebSocketImpl: sockets.Impl,
      schedule: clock.schedule
    })
    const first = sockets.latest()
    first.drop(1006)
    clock.advance(RECONNECT_MS)
    first.drop(4404)
    expect(stops).equals(0)
    expect(sockets.sockets).length(2)
  })

  it('uses the global WebSocket when given none', function () {
    const sockets = fakeSockets()
    const held = globalThis.WebSocket
    globalThis.WebSocket = sockets.Impl as unknown as typeof WebSocket
    try {
      const socket = openReconnecting({
        url: 'ws://host/y',
        stopOn: [],
        onMessage: () => undefined,
        onStop: () => undefined
      })
      expect(sockets.latest().url).equals('ws://host/y')
      socket.close()
    } finally {
      globalThis.WebSocket = held
    }
  })

  it('has a real clock that can be called off', async function () {
    let ran = false
    const cancel = realSchedule(() => {
      ran = true
    }, 1)
    cancel()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(ran).equals(false)
    await new Promise<void>(resolve => {
      realSchedule(resolve, 1)
    })
  })
})
