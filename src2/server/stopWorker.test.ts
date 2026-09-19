import { expect } from 'chai'
import { describe, it } from 'mocha'

import { type StoppableServer, stopWorker } from './stopWorker'

/**
 * Short enough that the suite stays quick, far enough apart that a slow
 * machine cannot mistake one deadline for the other.
 */
const CUT_MS = 20
const DEADLINE_MS = 60

const wait = async (ms: number): Promise<void> =>
  await new Promise(resolve => setTimeout(resolve, ms))

interface Harness {
  server: StoppableServer
  /** Calls `close`'s callback, as a real server does once nothing is open. */
  finishClosing: () => void
  closedIdle: number
  closedAll: number
  exits: number[]
  logs: string[]
}

function makeHarness(): Harness {
  let done: (() => void) | undefined
  const harness: Harness = {
    server: {
      close: callback => {
        done = callback
      },
      closeIdleConnections: () => {
        harness.closedIdle++
      },
      closeAllConnections: () => {
        harness.closedAll++
      }
    },
    finishClosing: () => done?.(),
    closedIdle: 0,
    closedAll: 0,
    exits: [],
    logs: []
  }
  return harness
}

function stop(
  harness: Harness,
  destroyDatabase: () => Promise<unknown> = async () => {}
): void {
  stopWorker({
    server: harness.server,
    destroyDatabase,
    cutConnectionsMs: CUT_MS,
    deadlineMs: DEADLINE_MS,
    exit: code => harness.exits.push(code),
    log: message => harness.logs.push(message)
  })
}

describe('stopWorker', function () {
  it('closes idle connections first, so an idle worker goes at once', function () {
    const harness = makeHarness()
    stop(harness)

    expect(harness.closedIdle).equals(1)
    expect(harness.closedAll).equals(0)
  })

  it('exits zero once the server and the pool are closed', async function () {
    const harness = makeHarness()
    stop(harness)

    harness.finishClosing()
    await wait(1)

    expect(harness.exits).deep.equals([0])
    expect(harness.logs).deep.equals([])
  })

  it('cuts the connections under requests that outstay the budget', async function () {
    const harness = makeHarness()
    stop(harness)

    await wait(CUT_MS + 10)

    expect(harness.closedAll).equals(1)
  })

  /**
   * The production failure. `close` never called back, so the worker sat there
   * until the primary SIGKILLed it and exited 1, and a routine deploy was
   * logged as a failed service.
   */
  it('leaves on its own when the server never finishes closing', async function () {
    const harness = makeHarness()
    stop(harness)

    await wait(DEADLINE_MS + 20)

    expect(harness.exits).deep.equals([0])
    expect(harness.logs).deep.equals([
      'stop deadline passed while waiting for open requests; going anyway'
    ])
  })

  /**
   * The other half of it: a pool with a client still checked out never ends,
   * and `destroy` is the last thing a worker waits on.
   */
  it('leaves on its own when the database pool never closes', async function () {
    const harness = makeHarness()
    stop(harness, async () => await new Promise(() => {}))

    harness.finishClosing()
    await wait(DEADLINE_MS + 20)

    expect(harness.exits).deep.equals([0])
    expect(harness.logs).deep.equals([
      'stop deadline passed while closing the database; going anyway'
    ])
  })

  it('exits zero when the pool closes badly, and says so', async function () {
    const harness = makeHarness()
    stop(harness, async () => {
      throw new Error('pool is wedged')
    })

    harness.finishClosing()
    await wait(1)

    expect(harness.exits).deep.equals([0])
    expect(harness.logs).deep.equals([
      'the database pool did not close: Error: pool is wedged'
    ])
  })

  it('exits once, however many ways out arrive', async function () {
    const harness = makeHarness()
    stop(harness)

    harness.finishClosing()
    await wait(DEADLINE_MS + 20)

    expect(harness.exits).deep.equals([0])
  })
})
