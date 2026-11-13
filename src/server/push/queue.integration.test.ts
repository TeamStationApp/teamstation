import { EventEmitter } from 'node:events'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, afterEach, before, beforeEach, describe, it } from 'mocha'

import {
  pushTestPrefix,
  senderDeps,
  type TestPushQueue,
  testPushQueue,
  transcript
} from '../../test/pushQueueKit'
import { quiet, testRedisUrl } from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import {
  ENQUEUE_TIMEOUT_MS,
  makePushEnqueuer,
  PUSH_GROUP,
  PushQueue,
  pushQueueKeys,
  WOKEN_TTL_SECONDS
} from './queue'
import { MAX_ATTEMPTS, type PushRequest, RETRY_DELAYS_MS } from './requests'
import { runPushSender, settleEntry } from './sender/main'

/**
 * The push queue on the test Valkey (`TS_TEST_REDIS_URL`), each case under a
 * prefix of its own: what the API queues, how the push sender reads, takes
 * over, settles, tries again and gives up on it, and the API's enqueuer when
 * Valkey is not there.
 */

/** A chat request for a conversation that is nowhere: nothing to wake. */
const chat = (c: string, attempt = 1): PushRequest => ({
  v: 1,
  t: 'chat',
  c,
  seq: 1,
  sender: 'usr_nobody',
  attempt,
  to: undefined,
  due: undefined
})

/** A database that answers every read with nothing. */
const empty = {
  selectFrom: () => ({
    selectAll: () => empty.chain,
    select: () => empty.chain
  }),
  chain: new Proxy(
    {},
    {
      get: (_target, key) =>
        key === 'execute'
          ? async () => []
          : key === 'then'
            ? undefined
            : () => empty.chain
    }
  )
} as unknown as Kysely<Database> & { chain: unknown }

/** A database that is away. */
const away = {
  selectFrom: () => {
    throw new Error('the database is away')
  }
} as unknown as Kysely<Database>

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('the push queue', function () {
  this.timeout(30000)
  let kit: TestPushQueue

  before(async function () {
    kit = await testPushQueue()
  })

  after(async function () {
    await kit?.close()
  })

  beforeEach(async function () {
    const { requests, later, dead } = kit.queue.keys
    await kit.client.del([requests, later, dead])
    await kit.queue.ensureGroup()
  })

  afterEach(async function () {
    await kit.client.del(kit.queue.keys.dead)
  })

  const pending = async (): Promise<number> =>
    Number(
      (await kit.client.xPending(kit.queue.keys.requests, PUSH_GROUP)).pending
    )

  it('names its keys under the prefix, as the change feed does', function () {
    const { woken, ...streams } = pushQueueKeys('ts:app')
    expect(streams).deep.equals({
      requests: 'ts:app:push:requests',
      later: 'ts:app:push:later',
      dead: 'ts:app:push:dead'
    })
    expect(woken('usr_1', 'cnv_1')).equals('ts:app:push:woken:usr_1:cnv_1')
  })

  it('makes its group once, and reads what was queued before it', async function () {
    await kit.client.del(kit.queue.keys.requests)
    // Nothing there yet: the group comes with the stream.
    await kit.queue.ensureGroup()
    await kit.queue.ensureGroup()
    await kit.queue.add(chat('cnv_one'))
    const [entry] = await kit.queue.read('a', 16, 1)
    expect(entry.read).deep.equals({ request: chat('cnv_one') })
    expect(entry.raw).equals(JSON.stringify(chat('cnv_one')))
  })

  it('queues and reads, and an entry done is acknowledged and deleted', async function () {
    const ids = [
      await kit.queue.add(chat('cnv_one')),
      await kit.queue.add(chat('cnv_two'))
    ]
    transcript(
      'queue',
      `\n## enqueue, read, XACK\n$ XADD ${kit.queue.keys.requests} MAXLEN ~ 100000 * r <chat request>: ${ids.join(', ')}`
    )
    const entries = await kit.queue.read('a', 16, 1)
    expect(entries.map(entry => entry.read)).deep.equals([
      { request: chat('cnv_one') },
      { request: chat('cnv_two') }
    ])
    expect(await pending()).equals(2)
    transcript(
      'queue',
      `$ XREADGROUP GROUP ${PUSH_GROUP} a COUNT 16: ${entries.map(entry => entry.raw).join(' ')}; XPENDING ${await pending()}`
    )
    // Read once: a second read gets nothing.
    expect(await kit.queue.read('a', 16, 1)).deep.equals([])
    for (const entry of entries)
      expect(await settleEntry(kit.queue, entry, senderDeps(empty, {}))).equals(
        null
      )
    expect(await pending()).equals(0)
    expect(await kit.client.xLen(kit.queue.keys.requests)).equals(0)
    transcript(
      'queue',
      `$ settled (nothing to wake): XACK + XDEL ${ids.join(', ')}; XPENDING ${await pending()}, XLEN ${await kit.client.xLen(kit.queue.keys.requests)}`
    )
  })

  it('takes over what a sender that died left in hand, and lets go of what was trimmed', async function () {
    await kit.queue.add(chat('cnv_held'))
    await kit.queue.add(chat('cnv_trimmed'))
    const [held, trimmed] = await kit.queue.read('died', 16, 1)
    await kit.client.xDel(kit.queue.keys.requests, trimmed.id)
    // Not idle long enough yet.
    expect(await kit.queue.reclaim('alive', 60_000, 16)).deep.equals([])
    await sleep(60)
    const taken = await kit.queue.reclaim('alive', 50, 16)
    expect(taken.map(entry => entry.id)).deep.equals([held.id])
    transcript(
      'queue',
      `\n## reclaim\n$ consumer "died" reads ${held.id} and ${trimmed.id}, then dies; ${trimmed.id} is trimmed away\n$ XAUTOCLAIM ${kit.queue.keys.requests} ${PUSH_GROUP} alive 50 0-0: took over ${taken.map(entry => entry.id).join(', ')}; the trimmed one acknowledged`
    )
    const { consumers } = await kit.client.xPending(
      kit.queue.keys.requests,
      PUSH_GROUP
    )
    expect(consumers).deep.equals([{ name: 'alive', deliveriesCounter: 1 }])
    await kit.queue.done(held.id)
    expect(await pending()).equals(0)
  })

  it('tries a failed request again after each delay, then gives it up', async function () {
    let now = 1_000_000
    const deps = senderDeps(away, {}, { clock: () => new Date(now) })
    await kit.queue.add(chat('cnv_failing'))
    transcript(
      'queue',
      `\n## retry, then dead letter (the database is away)\n$ XADD ${kit.queue.keys.requests} * r ${JSON.stringify(chat('cnv_failing'))}`
    )
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      const [entry] = await kit.queue.read('a', 16, 1)
      expect(entry.read).deep.equals({
        request: chat('cnv_failing', attempt)
      })
      await settleEntry(kit.queue, entry, deps)
      expect(await pending()).equals(0)
      const delay = RETRY_DELAYS_MS[attempt - 1]
      const [waiting] = await kit.client.zRangeWithScores(
        kit.queue.keys.later,
        0,
        0
      )
      transcript(
        'queue',
        `$ attempt ${attempt} failed: XACK + XDEL ${entry.id}; ZADD ${kit.queue.keys.later} ${waiting.score} (now + ${delay / 1000} s) ${waiting.value}`
      )
      // Waiting, not on the stream, until its time comes.
      expect(await kit.queue.promote(now + delay - 1)).equals(0)
      expect(await kit.queue.read('a', 16, 1)).deep.equals([])
      now += delay
      expect(await kit.queue.promote(now)).equals(1)
    }
    const [last] = await kit.queue.read('a', 16, 1)
    expect(last.read).deep.equals({
      request: chat('cnv_failing', MAX_ATTEMPTS)
    })
    await settleEntry(kit.queue, last, deps)
    expect(await kit.client.zCard(kit.queue.keys.later)).equals(0)
    expect(await pending()).equals(0)
    const dead = await kit.client.xRange(kit.queue.keys.dead, '-', '+')
    expect(dead.map(entry => entry.message)).deep.equals([
      {
        r: JSON.stringify(chat('cnv_failing', MAX_ATTEMPTS)),
        error: 'gave up after 5 attempts: Error: the database is away',
        at: new Date(now).toISOString()
      }
    ])
    transcript(
      'queue',
      `$ attempt ${MAX_ATTEMPTS} failed: XACK + XDEL ${last.id}; XADD ${kit.queue.keys.dead} ${JSON.stringify(dead[0].message)}; ZCARD later 0, XPENDING ${await pending()}`
    )
  })

  it('gives up on an entry it cannot read at once, and goes on with the rest', async function () {
    await kit.client.xAdd(kit.queue.keys.requests, '*', { r: '{"v":1,' })
    await kit.client.xAdd(kit.queue.keys.requests, '*', {
      r: JSON.stringify({ ...chat('cnv_zero'), attempt: 0 })
    })
    await kit.client.xAdd(kit.queue.keys.requests, '*', { other: 'field' })
    await kit.queue.add(chat('cnv_fine'))
    const said: string[] = []
    const signals = new EventEmitter()
    const sender = runPushSender({
      queue: kit.queue,
      deps: senderDeps(empty, {}, { log: line => said.push(line) }),
      consumer: 'loop',
      signals,
      readBlockMs: 50
    })
    const deadline = Date.now() + 10000
    while ((await kit.client.xLen(kit.queue.keys.requests)) > 0) {
      if (Date.now() > deadline) throw new Error(`stuck: ${said.join('\n')}`)
      await sleep(20)
    }
    signals.emit('SIGTERM')
    await sender.stop()
    const dead = await kit.client.xRange(kit.queue.keys.dead, '-', '+')
    const errors = dead.map(entry => entry.message.error)
    expect(errors[0]).match(/^the request cannot be read: SyntaxError: /)
    expect(errors.slice(1)).deep.equals([
      'attempt 0 is not a try',
      'the entry has no request'
    ])
    expect(dead.map(entry => entry.message.r)).deep.equals([
      '{"v":1,',
      JSON.stringify({ ...chat('cnv_zero'), attempt: 0 }),
      ''
    ])
    expect(await pending()).equals(0)
    expect(said.filter(line => line.startsWith('push sender: gave up'))).length(
      3
    )
    expect(said.at(-1)).equals('push sender: stopped on SIGTERM')
  })

  it('puts back what is due on its way round, and takes over what was left in hand', async function () {
    await kit.queue.add(chat('cnv_left'))
    const [left] = await kit.queue.read('died', 16, 1)
    await kit.client.zAdd(kit.queue.keys.later, {
      score: 0,
      value: JSON.stringify(chat('cnv_due', 2))
    })
    const said: string[] = []
    const sender = runPushSender({
      queue: kit.queue,
      deps: senderDeps(empty, {}, { log: line => said.push(line) }),
      consumer: 'loop',
      signals: new EventEmitter(),
      readBlockMs: 50,
      reclaimEveryMs: 0,
      reclaimIdleMs: 0
    })
    const deadline = Date.now() + 10000
    while (
      (await kit.client.xLen(kit.queue.keys.requests)) > 0 ||
      (await kit.client.zCard(kit.queue.keys.later)) > 0
    ) {
      if (Date.now() > deadline) throw new Error(`stuck: ${said.join('\n')}`)
      await sleep(20)
    }
    await sender.stop('SIGINT')
    expect(said).include('push sender: took over 1 request(s)')
    expect(said.at(-1)).equals('push sender: stopped on SIGINT')
    expect(left.read).deep.equals({ request: chat('cnv_left') })
    expect(await pending()).equals(0)
  })

  it('pauses while Valkey is away, and goes on once it is back', async function () {
    const said: string[] = []
    let failures = 2
    const flaky = Object.create(kit.queue) as typeof kit.queue
    flaky.promote = async now => {
      if (failures > 0) {
        failures--
        throw new Error('Socket closed unexpectedly')
      }
      return await kit.queue.promote(now)
    }
    await kit.queue.add(chat('cnv_after'))
    const paused: number[] = []
    const sender = runPushSender({
      queue: flaky,
      deps: senderDeps(empty, {}, { log: line => said.push(line) }),
      consumer: 'loop',
      signals: new EventEmitter(),
      readBlockMs: 50,
      pauseAfter: count => {
        paused.push(count)
        return 10
      }
    })
    const deadline = Date.now() + 10000
    while ((await kit.client.xLen(kit.queue.keys.requests)) > 0) {
      if (Date.now() > deadline) throw new Error(`stuck: ${said.join('\n')}`)
      await sleep(20)
    }
    await sender.stop()
    // Said once, not once a turn, and its end said too.
    expect(said.filter(line => line.includes('Socket closed'))).deep.equals([
      'push sender: Error: Socket closed unexpectedly'
    ])
    expect(said).include('push sender: going again after 2 failed turns')
    expect(paused).deep.equals([1, 2])
  })

  it('says a long outage once a minute, not once a turn', async function () {
    const said: string[] = []
    const away = Object.create(kit.queue) as typeof kit.queue
    away.promote = async () => {
      throw new Error('The client is offline')
    }
    const sender = runPushSender({
      queue: away,
      deps: senderDeps(empty, {}, { log: line => said.push(line) }),
      consumer: 'loop',
      signals: new EventEmitter(),
      readBlockMs: 50,
      pauseAfter: () => 5
    })
    await sleep(300)
    await sender.stop()
    expect(said.filter(line => line.includes('offline'))).deep.equals([
      'push sender: Error: The client is offline'
    ])
  })

  it('reads no longer than until the next request waiting is due', async function () {
    const said: string[] = []
    // A held post, or a retry, due 500 ms on: the sender's read would
    // otherwise wait out its whole 5 s before putting it back.
    const due = Date.now() + 500
    await kit.client.zAdd(kit.queue.keys.later, {
      score: due,
      value: JSON.stringify(chat('cnv_soon', 2))
    })
    // Watched from inside the sender: its read holds the connection.
    let putBackAt = 0
    const watched = Object.create(kit.queue) as typeof kit.queue
    watched.promote = async now => {
      const moved = await kit.queue.promote(now)
      if (moved > 0) putBackAt = Date.now()
      return moved
    }
    const sender = runPushSender({
      queue: watched,
      deps: senderDeps(empty, {}, { log: line => said.push(line) }),
      consumer: 'loop',
      signals: new EventEmitter(),
      readBlockMs: 5000
    })
    try {
      const deadline = Date.now() + 10000
      // eslint-disable-next-line no-unmodified-loop-condition -- the sender sets it
      while (putBackAt === 0) {
        if (Date.now() > deadline) throw new Error(`stuck: ${said.join('\n')}`)
        await sleep(20)
      }
      expect(putBackAt - due).lessThan(1000)
    } finally {
      await sender.stop()
    }
  })

  it('settles each entry as it finishes, so one slow entry holds up no held wake come due', async function () {
    // A large conversation's wakes, with APNs slow: its first read of the
    // database takes 3 s, and everything after is quick.
    let reads = 0
    const slowFirst: unknown = new Proxy(
      {},
      {
        get: (_target, key) =>
          key === 'execute'
            ? async () => {
                if (++reads === 1) await sleep(3000)
                return []
              }
            : key === 'then'
              ? undefined
              : () => slowFirst
      }
    )
    const slow = {
      selectFrom: () => ({
        selectAll: () => slowFirst,
        select: () => slowFirst
      })
    } as unknown as Kysely<Database>
    await kit.queue.add(chat('cnv_large'))
    // A DM's hold ends 400 ms on.
    const due = Date.now() + 400
    await kit.client.zAdd(kit.queue.keys.later, {
      score: due,
      value: JSON.stringify({ ...chat('cnv_dm'), due })
    })
    const settled: Array<{ at: number; reads: number }> = []
    const watched = Object.create(kit.queue) as typeof kit.queue
    watched.done = async id => {
      settled.push({ at: Date.now(), reads })
      await kit.queue.done(id)
    }
    const said: string[] = []
    const sender = runPushSender({
      queue: watched,
      deps: senderDeps(slow, {}, { log: line => said.push(line) }),
      consumer: 'loop',
      signals: new EventEmitter(),
      readBlockMs: 500
    })
    try {
      const deadline = Date.now() + 10000
      while (settled.length < 2) {
        if (Date.now() > deadline) throw new Error(`stuck: ${said.join('\n')}`)
        await sleep(20)
      }
    } finally {
      await sender.stop()
    }
    // The held wake was sent within moments of its hold ending, while the
    // slow entry was still in hand, and that one settled after.
    expect(settled[0].at - due).lessThan(1000)
    expect(settled[1].at - settled[0].at).greaterThan(1500)
    expect(await pending()).equals(0)
  })

  it('lets go of the consumers dead senders left behind holding nothing', async function () {
    const { requests } = kit.queue.keys
    await kit.client.xGroupCreateConsumer(requests, PUSH_GROUP, 'host:1')
    await kit.client.xGroupCreateConsumer(requests, PUSH_GROUP, 'host:2')
    // host:3 died holding a request: it stays until that is taken over.
    await kit.queue.add(chat('cnv_held'))
    await kit.queue.read('host:3', 16, 1)
    await sleep(20)
    // Idle too short a time: kept.
    expect(await kit.queue.dropIdleConsumers('loop', 60_000)).deep.equals([])
    const said: string[] = []
    const sender = runPushSender({
      queue: kit.queue,
      deps: senderDeps(empty, {}, { log: line => said.push(line) }),
      consumer: 'loop',
      signals: new EventEmitter(),
      readBlockMs: 50,
      reclaimEveryMs: 60_000,
      reclaimIdleMs: 10
    })
    try {
      const deadline = Date.now() + 10000
      while (!said.some(line => line.includes('idle consumer'))) {
        if (Date.now() > deadline) throw new Error(`stuck: ${said.join('\n')}`)
        await sleep(20)
      }
    } finally {
      await sender.stop()
    }
    expect(said).include(
      'push sender: let go of idle consumer(s) host:1, host:2'
    )
    const left = await kit.client.xInfoConsumers(requests, PUSH_GROUP)
    expect(left.map(consumer => String(consumer.name)).sort()).deep.equals([
      'host:3',
      'loop'
    ])
  })

  it('says a stop that fails, on a signal', async function () {
    const said: string[] = []
    const signals = new EventEmitter()
    const sender = runPushSender({
      queue: kit.queue,
      deps: senderDeps(empty, {}, { log: line => said.push(line) }),
      consumer: 'loop',
      signals,
      readBlockMs: 50,
      onStopped: async () => {
        throw new Error('the database would not close')
      }
    })
    signals.emit('SIGINT')
    const deadline = Date.now() + 10000
    while (!said.some(line => line.includes('stop failed'))) {
      if (Date.now() > deadline) throw new Error(`no stop: ${said.join('\n')}`)
      await sleep(20)
    }
    expect(said).include(
      'push sender: stop failed: Error: the database would not close'
    )
    await sender.stop().catch(() => undefined)
  })

  it('makes its group again when Valkey has lost the stream', async function () {
    const said: string[] = []
    const sender = runPushSender({
      queue: kit.queue,
      deps: senderDeps(empty, {}, { log: line => said.push(line) }),
      consumer: 'loop',
      signals: new EventEmitter(),
      readBlockMs: 50
    })
    try {
      await kit.queue.add(chat('cnv_before'))
      while ((await kit.client.xLen(kit.queue.keys.requests)) > 0)
        await sleep(20)
      // Flushed, or a Valkey that restarted with nothing saved.
      await kit.client.del(kit.queue.keys.requests)
      await sleep(200)
      await kit.queue.add(chat('cnv_after'))
      const deadline = Date.now() + 10000
      while ((await kit.client.xLen(kit.queue.keys.requests)) > 0) {
        if (Date.now() > deadline) throw new Error(`stuck: ${said.join('\n')}`)
        await sleep(20)
      }
    } finally {
      await sender.stop()
    }
    expect(said.some(line => line.includes('NOGROUP'))).equals(true)
    expect(await pending()).equals(0)
  })

  it('never gives one entry to two senders', async function () {
    for (let index = 0; index < 60; index++)
      await kit.queue.add(chat(`cnv_${index}`))
    const seen: string[] = []
    const take = async (consumer: string): Promise<void> => {
      for (;;) {
        const entries = await kit.queue.read(consumer, 7, 1)
        if (entries.length === 0) return
        seen.push(...entries.map(entry => entry.id))
        await sleep(1)
      }
    }
    // Each on a connection of its own, as two processes would be.
    const second = kit.client.duplicate()
    second.on('error', quiet)
    await second.connect()
    try {
      const other = new PushQueue(second, kit.prefix)
      await Promise.all([
        take('a'),
        (async () => {
          for (;;) {
            const entries = await other.read('b', 7, 1)
            if (entries.length === 0) return
            seen.push(...entries.map(entry => entry.id))
            await sleep(1)
          }
        })()
      ])
    } finally {
      await second.close()
    }
    expect(seen).length(60)
    expect(new Set(seen).size).equals(60)
  })

  it('renews what it has in hand, so a batch slower than the idle window is never taken over and done twice', async function () {
    await kit.queue.add(chat('cnv_large'))
    // Each piece of work takes three idle windows: a large chat's wakes,
    // with APNs slow.
    let started = 0
    const slowChain: unknown = new Proxy(
      {},
      {
        get: (_target, key) =>
          key === 'execute'
            ? async () => {
                started++
                await sleep(900)
                return []
              }
            : key === 'then'
              ? undefined
              : () => slowChain
      }
    )
    const slow = {
      selectFrom: () => ({
        selectAll: () => slowChain,
        select: () => slowChain
      })
    } as unknown as Kysely<Database>
    const said: string[] = []
    // Two senders, each on a connection of its own, as two nodes are.
    const second = kit.client.duplicate()
    second.on('error', quiet)
    await second.connect()
    const options = {
      deps: senderDeps(slow, {}, { log: (line: string) => said.push(line) }),
      signals: new EventEmitter(),
      readBlockMs: 20,
      reclaimEveryMs: 20,
      reclaimIdleMs: 300
    }
    const senders = [
      runPushSender({ ...options, queue: kit.queue, consumer: 'node-a' }),
      runPushSender({
        ...options,
        queue: new PushQueue(second, kit.prefix),
        consumer: 'node-b'
      })
    ]
    try {
      const deadline = Date.now() + 10000
      const settled = async (): Promise<boolean> =>
        started > 0 && (await kit.client.xLen(kit.queue.keys.requests)) === 0
      while (!(await settled())) {
        if (Date.now() > deadline) throw new Error(`stuck: ${said.join('\n')}`)
        await sleep(20)
      }
      // Past several more idle windows, in case a takeover was coming.
      await sleep(600)
    } finally {
      for (const sender of senders) await sender.stop()
      await second.close()
    }
    expect(started).equals(1)
    expect(said.filter(line => line.includes('took over'))).deep.equals([])
    expect(await pending()).equals(0)
  })

  it('stops on SIGTERM with the entries in hand given their time, and no more', async function () {
    await kit.queue.add(chat('cnv_slow'))
    let release = (): void => {}
    const slow = {
      selectFrom: () => {
        throw new Error('unused')
      }
    } as unknown as Kysely<Database>
    const deps = senderDeps(slow, {})
    // The work in hand never ends: the stop leaves it after its grace.
    const hanging = Object.create(kit.queue) as typeof kit.queue
    const hang = async (): Promise<void> => {
      await new Promise<void>(resolve => {
        release = resolve
      })
    }
    hanging.done = hang
    hanging.retry = hang
    const said: string[] = []
    const sender = runPushSender({
      queue: hanging,
      deps: { ...deps, log: line => said.push(line) },
      consumer: 'loop',
      signals: new EventEmitter(),
      readBlockMs: 50
    })
    while ((await pending()) === 0) await sleep(10)
    const asked = Date.now()
    await sender.stop()
    expect(Date.now() - asked).within(3900, 4900)
    expect(said).include(
      'push sender: left the requests in hand to be taken over'
    )
    release()
    // Still pending, for whoever comes next.
    expect(await pending()).equals(1)
  })
})

describe("the API's push enqueuer", function () {
  this.timeout(30000)

  it('queues a first try under the server prefix', async function () {
    const prefix = pushTestPrefix()
    const enqueuer = makePushEnqueuer(
      {
        redis: { url: testRedisUrl, prefix },
        databaseUrl: 'postgres://localhost/unused'
      },
      quiet
    )
    // The primary's first sweep waits for Valkey, rather than be dropped.
    const ready: string[] = []
    enqueuer.whenReady(() => ready.push('on the way up'))
    expect(ready).deep.equals([])
    const kit = await testPushQueue()
    try {
      const deadline = Date.now() + 5000
      while (
        !(await enqueuer.add({
          t: 'reminder',
          kind: 'game',
          eventId: 'gam_one',
          startAt: '2027-05-01T22:00:00.000Z'
        }))
      ) {
        if (Date.now() > deadline) throw new Error('never connected')
        await sleep(20)
      }
      enqueuer.whenReady(() => ready.push('at once'))
      expect(ready).deep.equals(['on the way up', 'at once'])
      const entries = await kit.client.xRange(
        pushQueueKeys(prefix).requests,
        '-',
        '+'
      )
      expect(entries.map(entry => JSON.parse(entry.message.r))).deep.equals([
        {
          t: 'reminder',
          kind: 'game',
          eventId: 'gam_one',
          startAt: '2027-05-01T22:00:00.000Z',
          v: 1,
          attempt: 1
        }
      ])
      await kit.client.del(pushQueueKeys(prefix).requests)

      // A read is queued only where a wake reached its reader.
      const read = {
        t: 'read' as const,
        u: 'usr_one',
        c: 'cnv_one',
        seq: 4,
        session: 'ses_one'
      }
      expect(await enqueuer.addRead(read)).equals(false)
      const marks = new PushQueue(kit.client, kit.prefix)
      const onServer = new PushQueue(kit.client, prefix)
      await onServer.markWoken(['usr_one'], 'cnv_one', 4)
      expect(await enqueuer.addRead(read)).equals(true)
      const queued = await kit.client.xRange(
        pushQueueKeys(prefix).requests,
        '-',
        '+'
      )
      expect(queued.map(entry => JSON.parse(entry.message.r))).deep.equals([
        { ...read, v: 1, attempt: 1 }
      ])
      // The kit's own prefix holds no mark.
      expect(await marks.wokenAt('usr_one', 'cnv_one')).equals(null)
      await kit.client.del([
        pushQueueKeys(prefix).requests,
        pushQueueKeys(prefix).woken('usr_one', 'cnv_one')
      ])
    } finally {
      await enqueuer.close()
      await kit.close()
    }
  })

  it('marks whom a wake reached, up to its highest seq, until a read covers it', async function () {
    const kit = await testPushQueue()
    try {
      const { queue, client } = kit
      expect(await queue.markWoken([], 'cnv_one', 3)).deep.equals([])
      await queue.markWoken(['usr_b'], 'cnv_one', 1)
      // Answered: whoever had no mark before.
      expect(
        await queue.markWoken(['usr_a', 'usr_b'], 'cnv_one', 5)
      ).deep.equals(['usr_a'])
      // A lower seq renews the mark and keeps its seq.
      expect(await queue.markWoken(['usr_a'], 'cnv_one', 2)).deep.equals([])
      expect(await queue.wokenAt('usr_a', 'cnv_one')).equals(5)
      expect(await queue.wokenAt('usr_b', 'cnv_one')).equals(5)
      expect(await client.ttl(queue.keys.woken('usr_a', 'cnv_one')))
        .to.be.above(WOKEN_TTL_SECONDS - 10)
        .and.at.most(WOKEN_TTL_SECONDS)
      // A read short of it keeps it; one at it or past it drops it.
      expect(await queue.readPast('usr_a', 'cnv_one', 4)).equals(false)
      expect(await queue.wokenAt('usr_a', 'cnv_one')).equals(5)
      expect(await queue.readPast('usr_a', 'cnv_one', 5)).equals(true)
      expect(await queue.wokenAt('usr_a', 'cnv_one')).equals(null)
      expect(await queue.readPast('usr_a', 'cnv_one', 9)).equals(false)
      expect(await queue.readPast('usr_b', 'cnv_one', 7)).equals(true)
    } finally {
      await kit.close()
    }
  })

  it('drops a request at once with Valkey away, says so once a minute, and never throws', async function () {
    const said: string[] = []
    const enqueuer = makePushEnqueuer(
      {
        redis: { url: 'redis://127.0.0.1:1', prefix: 'unused' },
        databaseUrl: 'postgres://localhost/unused'
      },
      line => said.push(line)
    )
    let swept = false
    enqueuer.whenReady(() => {
      swept = true
    })
    try {
      const asked = Date.now()
      for (let index = 0; index < 3; index++)
        expect(
          await enqueuer.add({ t: 'chat', c: 'cnv_x', seq: 1, sender: 'usr_x' })
        ).equals(false)
      expect(
        await enqueuer.addRead({
          t: 'read',
          u: 'usr_x',
          c: 'cnv_x',
          seq: 1,
          session: undefined
        })
      ).equals(false)
      expect(Date.now() - asked).lessThan(ENQUEUE_TIMEOUT_MS)
      expect(
        said.filter(line => line.startsWith('push queue: dropped'))
      ).deep.equals([
        'push queue: dropped a chat request: Valkey is not connected'
      ])
      expect(swept).equals(false)
    } finally {
      await enqueuer.close()
    }
  })
})
