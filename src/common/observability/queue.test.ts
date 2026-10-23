import { expect } from 'chai'
import { describe, it } from 'mocha'

import { MAX_AGE_MS } from './contract'
import { NOW, sample } from './contract.test'
import { EventQueue, type QueueOptions } from './queue'

function setup(extra: Partial<QueueOptions> = {}): {
  queue: EventQueue
  sent: string[]
  saved: () => string | null
  advance: (ms: number) => void
} {
  let saved: string | null = null
  let now = NOW
  const sent: string[] = []
  const queue = new EventQueue({
    key: 'demo',
    now: () => now,
    random: () => 0,
    storage: {
      getItem: async () => saved,
      setItem: async (_key, value) => {
        saved = value
      }
    },
    send: async body => {
      sent.push(body)
      return 200
    },
    ...extra
  })
  return {
    queue,
    sent,
    saved: () => saved,
    advance: (ms: number) => {
      now += ms
    }
  }
}
const row = (n: number): ReturnType<typeof sample> => ({
  ...sample(),
  I: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
})

describe('bounded event delivery', () => {
  it('times out a stalled sender while periodic flushes share the pending request', async function () {
    this.timeout(15000)
    let signal: AbortSignal | undefined
    let calls = 0
    const t = setup({
      send: async (_body, pending) => {
        calls++
        signal = pending
        return await new Promise<number>(() => {})
      }
    })
    await t.queue.enqueue(row(1))
    t.queue.start()
    try {
      await t.queue.flush()
    } finally {
      t.queue.stop()
    }
    expect(calls).equals(1)
    expect(signal?.aborted).equals(true)
    expect(t.queue.size).equals(1)
  })
  it('persists sanitized events, deduplicates and flushes D-first JSONL', async () => {
    const t = setup()
    expect(await t.queue.enqueue({ ...row(1), chat: 'private' })).equals(false)
    expect(await t.queue.enqueue(row(1))).equals(true)
    await t.queue.enqueue(row(1))
    expect(t.queue.size).equals(1)
    expect(t.saved()).not.contains('private')
    const first = t.queue.flush()
    await Promise.all([first, t.queue.flush()])
    expect(t.sent).length(1)
    expect(t.sent[0]).matches(/^\{"D":.*\}\n$/)
    expect(t.queue.size).equals(0)
    expect(t.queue.lastSuccess).equals(NOW)
  })
  it('drops the oldest on event/byte capacity and expires old rows', async () => {
    const t = setup({ maxEvents: 1 })
    await t.queue.enqueue(row(1))
    await t.queue.enqueue(row(2))
    expect(t.queue.dropped).equals(1)
    t.advance(MAX_AGE_MS + 1)
    await t.queue.flush()
    expect(t.queue.size).equals(0)
    expect(t.queue.dropped).equals(2)
    const tiny = setup({ maxBytes: 1 })
    expect(await tiny.queue.enqueue(row(1))).equals(false)
  })
  it('recovers valid persisted rows and contains corrupt or failed storage', async () => {
    for (const text of [
      'invalid',
      '{}',
      'x'.repeat(524289),
      JSON.stringify([row(1), { chat: 'private' }])
    ]) {
      const t = setup({
        storage: { getItem: async () => text, setItem: async () => {} }
      })
      await t.queue.ready
      expect(t.queue.size).equals(text.startsWith('[') ? 1 : 0)
      t.queue.stop()
    }
    const t = setup({
      storage: {
        getItem: async () => {
          throw Error()
        },
        setItem: async () => {
          throw Error()
        }
      }
    })
    await t.queue.ready
    expect(t.queue.storageFailed).equals(true)
    expect(await t.queue.enqueue(row(1))).equals(true)
    expect(t.queue.storageFailed).equals(true)
    await t.queue.flush()
    expect(t.queue.size).equals(0)
  })
  it('backs off transient responses, preserves identity and drops permanent refusals', async () => {
    for (const status of [0, 408, 429, 500, 503, -1]) {
      let calls = 0
      const t = setup({
        send: async () => {
          calls++
          if (status === -1) throw Error()
          return status
        }
      })
      await t.queue.enqueue(row(1))
      await t.queue.flush()
      await t.queue.flush()
      expect(calls).equals(1)
      expect(t.queue.size).equals(1)
      for (let i = 0; i < 10; i++) {
        t.advance(60001)
        await t.queue.flush()
      }
      expect(calls).equals(11)
    }
    const t = setup({ send: async () => 400 })
    await t.queue.enqueue(row(1))
    await t.queue.flush()
    expect(t.queue.size).equals(0)
    expect(t.queue.dropped).equals(1)
  })
  it('keeps new rows while acknowledging an in-flight batch and clears on identity change', async () => {
    let finish!: (status: number) => void
    let began!: () => void
    const start = new Promise<void>(resolve => {
      began = resolve
    })
    const t = setup({
      send: async () => {
        began()
        return await new Promise<number>(resolve => {
          finish = resolve
        })
      }
    })
    await t.queue.enqueue(row(1))
    const flight = t.queue.flush()
    await start
    await t.queue.enqueue(row(2))
    finish(200)
    await flight
    expect(t.queue.size).equals(1)
    const second = t.queue.flush()
    await new Promise(resolve => setImmediate(resolve))
    await t.queue.clear()
    await t.queue.enqueue(row(3))
    finish(200)
    await second
    expect(t.queue.size).equals(1)
    expect(t.saved()).contains(row(3).I)
    t.queue.start()
    t.queue.start()
    t.queue.stop()
    t.queue.start()
    expect(await t.queue.enqueue(row(4))).equals(false)
    await t.queue.flush()
  })
  it('sends at most 50 rows and contains stop during preparation', async () => {
    const t = setup()
    for (let i = 0; i < 51; i++) await t.queue.enqueue(row(i))
    await t.queue.flush()
    expect(t.queue.size).equals(1)
    expect(t.sent[0].trim().split('\n')).length(50)
    const pending = t.queue.flush()
    t.queue.stop()
    await pending
  })
})
