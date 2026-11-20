import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import {
  ClientClosedError,
  ClientOfflineError,
  ConnectionTimeoutError,
  DisconnectsClientError,
  SocketClosedUnexpectedlyError,
  SocketTimeoutError
} from 'redis'

import {
  closeValkey,
  type EnqueueConnection,
  enqueueWithin,
  inPublicationOrder,
  isConnectionError,
  onceAMinute,
  runValkey,
  valkeyClientOptions,
  valkeyConnection,
  ValkeyTimeout,
  ValkeyUnavailable,
  watchValkeyConnection,
  within
} from './client'

const ENQUEUE_TIMEOUT_MS = 500

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

/** What every replay-safe caller asks for: a second try after a lost connection. */
async function replayable<T>(
  connection: EnqueueConnection,
  attempt: (timeoutMs: number) => Promise<T>,
  budgetMs: number,
  now: () => number = Date.now
): Promise<T> {
  return await enqueueWithin(connection, attempt, budgetMs, now, true)
}

describe('enqueueWithin', function () {
  it('retries a lost reply even when the connection has already recovered', async function () {
    let tries = 0
    expect(
      await replayable(
        new Connection(),
        async () => {
          if (++tries === 1) throw new SocketClosedUnexpectedlyError()
          return 'recovered'
        },
        100
      )
    ).equals('recovered')
    expect(tries).equals(2)
  })

  it('starts no command when the budget is exhausted, including after readiness', async function () {
    let tries = 0
    const attempt = async (): Promise<void> => {
      tries++
    }
    expect(
      (
        await timed(async () => {
          await replayable(new Connection(), attempt, 0)
        })
      ).error
    ).equals('Valkey had no time left to send the command')
    const connection = new Connection()
    connection.lose()
    connection.next = then => {
      connection.up = true
      then()
      return () => {
        connection.stopped++
      }
    }
    const clock = [0, 0, 101]
    expect(
      (
        await timed(async () => {
          await replayable(connection, attempt, 100, () => clock.shift()!)
        })
      ).error
    ).equals('Valkey had no time left to send the command')
    expect(connection.stopped).equals(1)
    expect(tries).equals(0)
  })

  it('says a budget spent before sending is not an unanswered command', async function () {
    let problem: unknown
    try {
      await replayable(new Connection(), async () => undefined, 0)
    } catch (error) {
      problem = error
    }
    expect(problem).instanceOf(ValkeyTimeout)
    expect((problem as ValkeyTimeout).what).equals('budget')
  })

  it('sends an operation not known to be replay-safe only once after a lost connection', async function () {
    const connection = new Connection()
    let tries = 0
    let problem: unknown
    try {
      await enqueueWithin(
        connection,
        async () => {
          tries++
          throw new SocketClosedUnexpectedlyError()
        },
        ENQUEUE_TIMEOUT_MS
      )
    } catch (error) {
      problem = error
    }
    expect(problem).instanceOf(SocketClosedUnexpectedlyError)
    expect(tries).equals(1)
  })

  it('does not accept a resolved result after its deadline', async function () {
    expect(
      (
        await timed(
          async () => await within(Promise.resolve('late'), 0, 'answer')
        )
      ).error
    ).equals('Valkey did not answer in time')
  })

  it('never retries a server error even if the connection also goes away', async function () {
    const connection = new Connection()
    let tries = 0
    const result = await timed(
      async () =>
        await replayable(
          connection,
          async () => {
            tries++
            connection.lose()
            throw new Error('WRONGTYPE')
          },
          100
        )
    )
    expect(result.error).equals('WRONGTYPE')
    expect(tries).equals(1)
  })
  it('answers a ready connection at once, with the whole budget', async function () {
    const connection = new Connection()
    const given: number[] = []
    const result = await timed(
      async () =>
        await replayable(
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
        await replayable(
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
        await replayable(
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
        await replayable(
          connection,
          async timeoutMs => {
            given.push(timeoutMs)
            if (given.length === 1) {
              connection.lose()
              connection.later(100, 'ready')
              throw new SocketClosedUnexpectedlyError()
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
        await replayable(
          connection,
          async () => {
            tries++
            // Lost again: there is no second wait.
            connection.lose()
            connection.later(10, 'ready')
            throw new SocketClosedUnexpectedlyError()
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
        await replayable(
          connection,
          async () => {
            tries++
            connection.lose()
            connection.later(20, 'ready')
            throw new SocketClosedUnexpectedlyError()
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
        await replayable(
          connection,
          async timeoutMs => {
            given.push(timeoutMs)
            if (given.length === 1) {
              connection.lose()
              connection.later(ENQUEUE_TIMEOUT_MS - 50, 'ready')
              throw new SocketClosedUnexpectedlyError()
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
        await replayable(
          connection,
          async () => {
            tries++
            connection.lose()
            throw new SocketClosedUnexpectedlyError()
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
        await replayable(
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
        await replayable(
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
        await replayable(
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
          await replayable(
            connection,
            async timeoutMs => {
              tries++
              expect(timeoutMs).at.most(ENQUEUE_TIMEOUT_MS)
              if (tries === 1) {
                connection.lose()
                connection.later(reconnectMs, 'ready')
                throw new SocketClosedUnexpectedlyError()
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

class Client extends EventEmitter {
  isReady = false
  isOpen = true
}

describe('Valkey connection policy', function () {
  it('shares event listeners across reconnect waiters and removes completed waits', async function () {
    const client = new Client()
    const connection = valkeyConnection(client)
    let cancelled = 0
    connection.next(() => cancelled++)()
    for (let round = 0; round < 3; round++) {
      const pending = Array.from(
        { length: 30 },
        async () => await runValkey(client, async () => 'ready')
      )
      expect(
        ['ready', 'error', 'end'].map(event => client.listenerCount(event))
      ).deep.equals([1, 1, 1])
      client.isReady = true
      client.emit('ready')
      expect(await Promise.all(pending)).deep.equals(Array(30).fill('ready'))
      client.isReady = false
      client.emit('error', new SocketClosedUnexpectedlyError())
    }
    expect(cancelled).equals(0)
  })

  it('drains before closing, bounds a silent peer and closes an offline client at once', async function () {
    let answer = (): void => undefined
    const pending = new Promise<void>(resolve => {
      answer = resolve
    })
    let pings = 0
    let destroyed = 0
    const client = {
      isReady: true,
      isOpen: true,
      ping: async () => {
        pings++
        await pending
      },
      destroy: () => {
        destroyed++
        client.isOpen = false
        client.isReady = false
      }
    }
    const closing = closeValkey(client)
    expect(destroyed).equals(0)
    answer()
    await closing
    expect(destroyed).equals(1)
    await closeValkey(client)
    expect(destroyed).equals(1)
    expect(pings).equals(1)
    client.isOpen = true
    await closeValkey(client)
    expect(destroyed).equals(2)
    expect(pings).equals(1)
    client.isReady = client.isOpen = true
    client.ping = hangs
    const started = Date.now()
    await closeValkey(client, 25)
    expect(Date.now() - started).within(20, 100)
    expect(destroyed).equals(3)
  })

  it('waits through a keepalive re-emitting the same socket failure', async function () {
    const client = new Client()
    client.isReady = true
    const connection = valkeyConnection(client)
    const error = new SocketClosedUnexpectedlyError()
    client.isReady = false
    client.emit('error', error)
    client.emit('error', error)
    expect(connection.coming()).equals(true)
    const reconnect = runValkey(client, async () => 'recovered')
    client.emit('error', error)
    await sleep(5)
    client.isReady = true
    client.emit('ready')
    expect(await reconnect).equals('recovered')
    expect(client.listenerCount('error')).equals(1)
    expect(client.listenerCount('ready')).equals(1)
    expect(client.listenerCount('end')).equals(1)
  })

  it('tracks fresh reconnects and failed attempts, with no accumulating waiters', async function () {
    const client = new Client()
    const connection = valkeyConnection(client)
    expect(valkeyConnection(client)).equals(connection)
    expect(connection.coming()).equals(true)
    const baseline = ['ready', 'error', 'end'].map(event =>
      client.listenerCount(event)
    )
    const asked = runValkey(client, async () => 'ready')
    client.isReady = true
    client.emit('ready')
    expect(await asked).equals('ready')
    client.emit('error', new Error('a failed ping with a live socket'))
    expect(connection.ready()).equals(true)
    client.isReady = false
    client.emit('error', new SocketClosedUnexpectedlyError())
    expect(connection.coming()).equals(true)
    const reconnect = runValkey(client, async () => 'again')
    client.emit('error', new Error('connection refused'))
    expect((await timed(async () => await reconnect)).error).equals(
      'Valkey is not connected'
    )
    expect(connection.coming()).equals(false)
    client.isReady = true
    client.emit('ready')
    expect(connection.ready()).equals(true)
    client.isReady = false
    client.emit('error', new SocketClosedUnexpectedlyError())
    const closing = runValkey(client, async () => 'closed')
    client.isOpen = false
    client.emit('end')
    expect((await timed(async () => await closing)).error).equals(
      'Valkey is not connected'
    )
    expect(connection.coming()).equals(false)
    expect(
      ['ready', 'error', 'end'].map(event => client.listenerCount(event))
    ).deep.equals(baseline)
  })

  it('removes timeout waiters and stops after a failed initial connection', async function () {
    const client = new Client()
    valkeyConnection(client)
    expect(
      (
        await timed(
          async () => await runValkey(client, async () => 'unused', 10)
        )
      ).error
    ).equals('Valkey did not reconnect in time')
    expect(client.listenerCount('ready')).equals(1)
    expect(client.listenerCount('error')).equals(1)
    expect(client.listenerCount('end')).equals(1)
    client.emit('error', new Error('connect failed'))
    expect(
      (await timed(async () => await runValkey(client, async () => 'unused')))
        .error
    ).equals('Valkey is not connected')
  })

  it('recognizes transport errors without treating server or arbitrary values as one', function () {
    for (const error of [
      new ClientClosedError(),
      new ClientOfflineError(),
      new SocketClosedUnexpectedlyError(),
      new ConnectionTimeoutError(),
      new SocketTimeoutError(100),
      new DisconnectsClientError(),
      Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
      Object.assign(new Error('unreachable'), { code: 'EHOSTUNREACH' }),
      Object.assign(new Error('no network'), { code: 'ENETUNREACH' }),
      Object.assign(new Error('bad cert'), {
        code: 'ERR_TLS_CERT_ALTNAME_INVALID'
      }),
      Object.assign(new Error('bad record'), {
        code: 'ERR_SSL_WRONG_VERSION_NUMBER'
      })
    ])
      expect(isConnectionError(error)).equals(true)
    for (const error of [
      undefined,
      'closed',
      new Error('WRONGTYPE'),
      Object.assign(new Error('error'), { code: 'OTHER' })
    ])
      expect(isConnectionError(error)).equals(false)
  })

  it('names roles, configures keepalive, and reads the requested certificate', function () {
    const options = valkeyClientOptions(
      'redis://example.test',
      'scoreboard subscriber'
    )
    expect(options.name).equals(`scoreboard-sub-${process.pid}`)
    expect(options.pingInterval).equals(60000)
    expect(options.disableOfflineQueue).equals(true)
    expect(options.socket).equals(undefined)
    const dir = mkdtempSync(join(tmpdir(), 'valkey-ca-'))
    try {
      const file = join(dir, 'ca.pem')
      writeFileSync(file, 'fixture authority')
      const custom = valkeyClientOptions(
        'rediss://example.test',
        'feed',
        file,
        { name: 'test-client', pingInterval: 50 }
      )
      expect(custom).includes({ name: 'test-client', pingInterval: 50 })
      expect(custom.socket).deep.equals({ tls: true, ca: 'fixture authority' })
      expect(() =>
        valkeyClientOptions(
          'rediss://example.test',
          'feed',
          join(dir, 'missing')
        )
      ).throws('cannot be read')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('limits repeated errors and recoveries independently', function () {
    const logs: string[] = []
    const client = new Client()
    watchValkeyConnection(client, message => logs.push(message), 'feed')
    client.emit('ready')
    for (let i = 0; i < 3; i++) {
      client.emit('error', i === 0 ? new Error('disconnected') : 'again')
      client.emit('ready')
    }
    expect(logs).deep.equals([
      'redis feed: disconnected',
      'redis feed: connected again'
    ])
    let now = 0
    const limited = onceAMinute(
      message => logs.push(message),
      () => now
    )
    expect(limited('first')).equals(true)
    now = 59999
    expect(limited('hidden')).equals(false)
    now = 60000
    expect(limited('second')).equals(true)
    expect(logs.slice(2)).deep.equals(['first', 'second'])
  })

  it('lets only the latest notice retry, and never resends after a newer one', async function () {
    const order = { last: 0 }
    const sent: string[] = []
    const first = inPublicationOrder(order, async () => {
      sent.push('first')
    })
    await first()
    // Nothing newer: the first may be retried.
    await first()
    const second = inPublicationOrder(order, async () => {
      sent.push('second')
    })
    await second()
    let problem: unknown
    try {
      await first()
    } catch (error) {
      problem = error
    }
    expect(problem).instanceOf(ValkeyUnavailable)
    expect(sent).deep.equals(['first', 'first', 'second'])
  })
})
