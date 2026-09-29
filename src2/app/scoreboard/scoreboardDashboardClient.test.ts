import { expect } from 'chai'
import { describe, it } from 'mocha'

import { NO_OVERRIDES, SAMPLE_SCOREBOARD } from '../../common/scoreboard'
import type { ScoreboardDashboard } from '../../common/scoreboardEvents'
import { fakeClock, fakeSockets } from '../../test/fakeScoreboardSocket'
import { connectDashboard } from './scoreboardDashboardClient'
import { RECONNECT_MS } from './scoreboardSocket'

const countOn = {
  ...NO_OVERRIDES,
  overrideCountEnabled: true,
  overrideCount: { balls: 1, strikes: 0, outs: 0 }
}
const stateMessage = {
  type: 'state',
  automated: SAMPLE_SCOREBOARD,
  overrides: NO_OVERRIDES,
  final: SAMPLE_SCOREBOARD,
  gameAt: 1,
  watcherAt: null
}

function dashboard(): {
  sockets: ReturnType<typeof fakeSockets>
  clock: ReturnType<typeof fakeClock>
  states: ScoreboardDashboard[]
  errors: string[]
  stops: number[]
  client: ReturnType<typeof connectDashboard>
} {
  const sockets = fakeSockets()
  const clock = fakeClock()
  const states: ScoreboardDashboard[] = []
  const errors: string[] = []
  const stops: number[] = []
  const client = connectDashboard({
    url: 'ws://host/api/v1/scoreboard/g1/dashboard',
    onState: state => states.push(state),
    onError: message => errors.push(message),
    onStop: code => stops.push(code),
    WebSocketImpl: sockets.Impl,
    schedule: clock.schedule
  })
  return { sockets, clock, states, errors, stops, client }
}

describe('scoreboardDashboardClient', function () {
  it('sends overrides and reset in the order made, holding them until open', function () {
    const { sockets, client } = dashboard()
    client.send({ type: 'overrides', data: countOn })
    client.send({ type: 'reset' })
    expect(sockets.latest().sent).deep.equals([])
    sockets.latest().open()
    client.send({ type: 'overrides', data: NO_OVERRIDES })
    expect(sockets.latest().messages()).deep.equals([
      { type: 'overrides', data: countOn },
      { type: 'reset' },
      { type: 'overrides', data: NO_OVERRIDES }
    ])
  })

  it('hands on each state, and each error reply, and ignores the rest', function () {
    const { sockets, states, errors } = dashboard()
    sockets.latest().open()
    sockets.latest().receive(stateMessage)
    sockets.latest().receive({ error: 'unreadable' })
    sockets.latest().receive('not json')
    sockets.latest().receive({ type: 'state' })
    expect(states).length(1)
    expect(states[0].gameAt).equals(1)
    expect(states[0].overrides.overrideCountEnabled).equals(false)
    expect(states[0]).not.have.property('type')
    expect(errors).deep.equals(['unreadable'])
  })

  for (const code of [1006, 1011]) {
    it(`reconnects ${RECONNECT_MS} ms after ${code}, and sends what waited`, function () {
      const { sockets, clock, client, stops } = dashboard()
      sockets.latest().open()
      sockets.latest().drop(code)
      client.send({ type: 'reset' })
      clock.advance(RECONNECT_MS)
      expect(sockets.sockets).length(2)
      sockets.latest().open()
      expect(sockets.latest().messages()).deep.equals([{ type: 'reset' }])
      expect(stops).deep.equals([])
    })
  }

  for (const code of [4401, 4403, 4404]) {
    it(`stops on ${code}`, function () {
      const { sockets, clock, stops } = dashboard()
      sockets.latest().open()
      sockets.latest().drop(code)
      expect(stops).deep.equals([code])
      clock.advance(60_000)
      expect(sockets.sockets).length(1)
    })
  }

  it('closes for good', function () {
    const { sockets, clock, client } = dashboard()
    sockets.latest().open()
    client.close()
    expect(sockets.latest().closedWith).equals(1000)
    clock.advance(60_000)
    expect(sockets.sockets).length(1)
  })
})
