import { expect } from 'chai'
import { describe, it } from 'mocha'

import { measureOffset } from './serverClock'

/**
 * A device clock 40 s behind the server, and a network whose round trips the
 * test chooses: each reading takes `trips[n]` ms, the server answering half
 * way through.
 */
function network(trips: number[]): {
  local: () => number
  fetchTime: () => Promise<number>
} {
  let device = 1_000_000
  let n = 0
  return {
    local: () => device,
    fetchTime: async () => {
      const trip = trips[n++]
      if (trip < 0) throw new Error('offline')
      device += trip / 2
      const server = device + 40_000
      device += trip / 2
      return server
    }
  }
}

describe('measuring the server clock (U43)', function () {
  it('keeps the reading with the lowest round trip', async function () {
    const { local, fetchTime } = network([300, 80, 20, 500, 60])
    expect(await measureOffset(fetchTime, 5, local)).deep.equals({
      offsetMs: 40_000,
      roundTripMs: 20
    })
  })

  it('takes the server to have read its clock half way through the trip', async function () {
    let device = 0
    const sample = await measureOffset(
      async () => {
        // The server reads its clock right away, then the answer takes 100 ms.
        const server = device + 5000
        device += 100
        return server
      },
      1,
      () => device
    )
    expect(sample).deep.equals({ offsetMs: 4950, roundTripMs: 100 })
  })

  it('skips a reading that fails, and fails when every one does', async function () {
    const some = network([-1, 40, -1])
    expect(await measureOffset(some.fetchTime, 3, some.local)).deep.equals({
      offsetMs: 40_000,
      roundTripMs: 40
    })
    const none = network([-1, -1])
    let thrown: unknown
    await measureOffset(none.fetchTime, 2, none.local).catch(
      (error: unknown) => {
        thrown = error
      }
    )
    expect(String(thrown)).includes('offline')
  })
})
