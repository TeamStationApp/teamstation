import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  ENQUEUE_TIMEOUT_MS,
  type EnqueueConnection,
  enqueueWithin
} from './queue'

/**
 * `enqueueWithin`, over a connection the case drives by hand: how it waits for
 * a reconnect and tries once more, and that the whole of it, waits and tries,
 * stays within the API's budget.
 */

/** How much later than the budget a timer may fire on a loaded machine. */
const SLACK_MS = 40

/** A connection whose state the case sets, and whose waiters it wakes. */
class Connection implements EnqueueConnection {
  up = true
  away = false
  waiting = new Set<() => void>()
  stopped = 0

  ready = (): boolean => this.up
  coming = (): boolean => !this.away
  next = (then: () => void): (() => void) => {
    this.waiting.add(then)
    return () => {
      this.stopped++
      this.waiting.delete(then)
    }
  }

  /** Loses the connection: a reconnect follows. */
  lose(): void {
    this.up = false
  }

  /** The reconnect, `ms` from now, succeeds or fails. */
  later(ms: number, outcome: 'ready' | 'failed'): void {
    setTimeout(() => {
      if (outcome === 'ready') this.up = true
      else this.away = true
      for (const then of [...this.waiting]) then()
    }, ms)
  }
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Never answers. */
const hangs = async (): Promise<never> =>
  await new Promise<never>(() => undefined)

/** The answer or the failure, and how long it took. */
async function timed<T>(
  work: () => Promise<T>
): Promise<{ ms: number; answer?: T; error?: string }> {
  const started = Date.now()
  try {
    const answer = await work()
    return { ms: Date.now() - started, answer }
  } catch (error) {
    return {
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

describe('enqueueWithin', function () {
  it('answers a ready connection at once, with the whole budget', async function () {
    const connection = new Connection()
    const given: number[] = []
    const result = await timed(
      async () =>
        await enqueueWithin(
          connection,
          async timeoutMs => {
            given.push(timeoutMs)
            return 'queued'
          },
          ENQUEUE_TIMEOUT_MS
        )
    )
    expect(result.answer).equals('queued')
    expect(given).deep.equals([ENQUEUE_TIMEOUT_MS])
  })

  it('gives up on an unanswered try at the budget, and does not try again while connected', async function () {
    const connection = new Connection()
    let tries = 0
    const result = await timed(
      async () =>
        await enqueueWithin(
          connection,
          async () => {
            tries++
            return await hangs()
          },
          ENQUEUE_TIMEOUT_MS
        )
    )
    expect(result.error).equals('Valkey did not answer in time')
    expect(tries).equals(1)
    expect(result.ms)
      .at.least(ENQUEUE_TIMEOUT_MS - 5)
      .and.at.most(ENQUEUE_TIMEOUT_MS + SLACK_MS)
  })

  it('passes on a failure the connection stood through, untried again', async function () {
    const connection = new Connection()
    let tries = 0
    const result = await timed(
      async () =>
        await enqueueWithin(
          connection,
          async () => {
            tries++
            throw new Error('WRONGTYPE')
          },
          ENQUEUE_TIMEOUT_MS
        )
    )
    expect(result.error).equals('WRONGTYPE')
    expect(tries).equals(1)
  })

  it('waits for the reconnect after a try loses the connection, and tries once more in the time left', async function () {
    const connection = new Connection()
    const given: number[] = []
    const result = await timed(
      async () =>
        await enqueueWithin(
          connection,
          async timeoutMs => {
            given.push(timeoutMs)
            if (given.length === 1) {
              connection.lose()
              connection.later(100, 'ready')
              throw new Error('Socket closed unexpectedly')
            }
            return 'queued'
          },
          ENQUEUE_TIMEOUT_MS
        )
    )
    expect(result.answer).equals('queued')
    expect(given).length(2)
    expect(given[0]).equals(ENQUEUE_TIMEOUT_MS)
    // The second try has what the wait left of the budget.
    expect(given[1])
      .at.most(ENQUEUE_TIMEOUT_MS - 95)
      .and.at.least(ENQUEUE_TIMEOUT_MS - 100 - SLACK_MS)
    expect(connection.waiting.size).equals(0)
    expect(connection.stopped).equals(1)
  })

  it('waits for a connection found not ready, then tries it once', async function () {
    const connection = new Connection()
    connection.lose()
    connection.later(60, 'ready')
    let tries = 0
    const result = await timed(
      async () =>
        await enqueueWithin(
          connection,
          async () => {
            tries++
            // Lost again: there is no second wait.
            connection.lose()
            connection.later(10, 'ready')
            throw new Error('Socket closed unexpectedly')
          },
          ENQUEUE_TIMEOUT_MS
        )
    )
    expect(result.error).equals('Socket closed unexpectedly')
    expect(tries).equals(1)
    expect(result.ms).below(ENQUEUE_TIMEOUT_MS)
  })

  it('tries no more than twice when the retry loses the connection too', async function () {
    const connection = new Connection()
    let tries = 0
    const result = await timed(
      async () =>
        await enqueueWithin(
          connection,
          async () => {
            tries++
            connection.lose()
            connection.later(20, 'ready')
            throw new Error('Socket closed unexpectedly')
          },
          ENQUEUE_TIMEOUT_MS
        )
    )
    expect(result.error).equals('Socket closed unexpectedly')
    expect(tries).equals(2)
    expect(result.ms).below(ENQUEUE_TIMEOUT_MS)
  })

  it('keeps a late reconnect and its retry within the budget', async function () {
    const connection = new Connection()
    const given: number[] = []
    const result = await timed(
      async () =>
        await enqueueWithin(
          connection,
          async timeoutMs => {
            given.push(timeoutMs)
            if (given.length === 1) {
              connection.lose()
              connection.later(ENQUEUE_TIMEOUT_MS - 50, 'ready')
              throw new Error('Socket closed unexpectedly')
            }
            return await hangs()
          },
          ENQUEUE_TIMEOUT_MS
        )
    )
    expect(result.error).equals('Valkey did not answer in time')
    expect(given).length(2)
    expect(given[1]).at.most(55)
    expect(result.ms).at.most(ENQUEUE_TIMEOUT_MS + SLACK_MS)
  })

  it('gives up on a reconnect that has not come by the budget', async function () {
    const connection = new Connection()
    let tries = 0
    const result = await timed(
      async () =>
        await enqueueWithin(
          connection,
          async () => {
            tries++
            connection.lose()
            throw new Error('Socket closed unexpectedly')
          },
          ENQUEUE_TIMEOUT_MS
        )
    )
    expect(result.error).equals('Valkey did not reconnect in time')
    expect(tries).equals(1)
    expect(result.ms)
      .at.least(ENQUEUE_TIMEOUT_MS - 5)
      .and.at.most(ENQUEUE_TIMEOUT_MS + SLACK_MS)
    expect(connection.waiting.size).equals(0)
  })

  it('stops waiting when the reconnect fails', async function () {
    const connection = new Connection()
    connection.lose()
    connection.later(30, 'failed')
    let tries = 0
    const result = await timed(
      async () =>
        await enqueueWithin(
          connection,
          async () => {
            tries++
            return 'queued'
          },
          ENQUEUE_TIMEOUT_MS
        )
    )
    expect(result.error).equals('Valkey is not connected')
    expect(tries).equals(0)
    expect(result.ms).below(ENQUEUE_TIMEOUT_MS / 2)
  })

  it('does not wait for Valkey that has been away', async function () {
    const connection = new Connection()
    connection.lose()
    connection.away = true
    let tries = 0
    const result = await timed(
      async () =>
        await enqueueWithin(
          connection,
          async () => {
            tries++
            return 'queued'
          },
          ENQUEUE_TIMEOUT_MS
        )
    )
    expect(result.error).equals('Valkey is not connected')
    expect(tries).equals(0)
    expect(result.ms).below(20)
    expect(connection.waiting.size).equals(0)
  })

  it('does not retry a lost connection when Valkey was found away', async function () {
    const connection = new Connection()
    let tries = 0
    const result = await timed(
      async () =>
        await enqueueWithin(
          connection,
          async () => {
            tries++
            connection.lose()
            connection.away = true
            throw new Error('connect ECONNREFUSED')
          },
          ENQUEUE_TIMEOUT_MS
        )
    )
    expect(result.error).equals('connect ECONNREFUSED')
    expect(tries).equals(1)
    expect(result.ms).below(20)
  })

  it('stays within the budget across reconnect times, never trying more than twice', async function () {
    this.timeout(20000)
    for (const reconnectMs of [0, 1, 50, 200, 400, 480, 499, 500, 520, 800]) {
      const connection = new Connection()
      let tries = 0
      const result = await timed(
        async () =>
          await enqueueWithin(
            connection,
            async timeoutMs => {
              tries++
              expect(timeoutMs).at.most(ENQUEUE_TIMEOUT_MS)
              if (tries === 1) {
                connection.lose()
                connection.later(reconnectMs, 'ready')
                throw new Error('Socket closed unexpectedly')
              }
              await sleep(Math.min(timeoutMs, 30))
              return 'queued'
            },
            ENQUEUE_TIMEOUT_MS
          )
      )
      expect(tries, `reconnect at ${reconnectMs} ms`).at.most(2)
      expect(result.ms, `reconnect at ${reconnectMs} ms`).at.most(
        ENQUEUE_TIMEOUT_MS + SLACK_MS
      )
      if (reconnectMs <= 400)
        expect(result.answer, `reconnect at ${reconnectMs} ms`).equals('queued')
      await sleep(Math.max(0, reconnectMs - result.ms) + 5)
    }
  })
})
