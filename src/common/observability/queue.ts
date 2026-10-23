import {
  bytes,
  type EventRecord,
  jsonLine,
  MAX_AGE_MS,
  parseEvent
} from './contract'

export interface QueueStorage {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
}
export interface QueueOptions {
  key: string
  storage: QueueStorage
  send: (body: string, signal: AbortSignal) => Promise<number>
  now?: () => number
  random?: () => number
  maxEvents?: number
  maxBytes?: number
}

/** One owner and identity per queue. Storage operations and sends are serialized. */
export class EventQueue {
  private events: EventRecord[] = []
  private serial: Promise<void> = Promise.resolve()
  private sending?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private controller?: AbortController
  private failures = 0
  private nextAt = 0
  private generation = 0
  private stopped = false
  readonly ready: Promise<void>
  dropped = 0
  storageFailed = false
  lastSuccess?: number
  private readonly now: () => number

  constructor(private readonly options: QueueOptions) {
    options.maxEvents = Number.isFinite(options.maxEvents)
      ? Math.max(0, Math.min(500, Math.floor(options.maxEvents!)))
      : 500
    options.maxBytes = Number.isFinite(options.maxBytes)
      ? Math.max(0, Math.min(524288, Math.floor(options.maxBytes!)))
      : 524288
    this.now = options.now ?? Date.now
    this.ready = this.exclusive(async () => {
      try {
        const text = await options.storage.getItem(options.key)
        if (text != null && bytes(text) <= (options.maxBytes ?? 524288)) {
          const rows: unknown = JSON.parse(text)
          if (Array.isArray(rows))
            for (const row of rows.slice(-500)) {
              try {
                this.events.push(parseEvent(row, this.now()))
              } catch {
                this.dropped++
              }
            }
        }
      } catch {
        this.storageFailed = true
      }
      this.trim()
    })
  }

  get size(): number {
    return this.events.length
  }

  start(): void {
    if (this.timer != null || this.stopped) return
    this.timer = setInterval(() => {
      this.flush().catch(() => {})
    }, 5000)
  }

  /** False means not accepted; storage failure never escapes into the app. */
  async enqueue(value: unknown): Promise<boolean> {
    let event: EventRecord
    try {
      event = parseEvent(value, this.now())
    } catch {
      return false
    }
    return await this.exclusive(async () => {
      if (this.stopped) return false
      if (!this.events.some(row => row.I === event.I)) this.events.push(event)
      this.trim()
      await this.persist()
      return this.events.some(row => row.I === event.I)
    })
  }

  async flush(): Promise<void> {
    if (this.sending != null) {
      await this.sending
      return
    }
    this.sending = this.deliver().finally(() => {
      this.sending = undefined
    })
    await this.sending
  }

  private async deliver(): Promise<void> {
    await this.ready
    if (this.stopped || this.now() < this.nextAt) return
    const generation = this.generation
    const batch = await this.exclusive(async () => {
      this.trim()
      const rows: EventRecord[] = []
      let size = 0
      for (const row of this.events) {
        const length = bytes(jsonLine(row, this.now()))
        if (rows.length === 50 || size + length > 65536) break
        size += length
        rows.push(row)
      }
      return rows
    })
    if (batch.length === 0 || this.stopped) return
    const controller = new AbortController()
    this.controller = controller
    let timeout: ReturnType<typeof setTimeout> | undefined
    let status = 0
    try {
      status = await Promise.race([
        this.options.send(
          batch.map(row => jsonLine(row, this.now())).join(''),
          controller.signal
        ),
        new Promise<number>(resolve => {
          timeout = setTimeout(() => {
            controller.abort()
            resolve(0)
          }, 10000)
        })
      ])
    } catch {
      /* A rejected transport is retryable. */
    } finally {
      clearTimeout(timeout)
      this.controller = undefined
    }
    if (generation !== this.generation || this.stopped) return
    await this.exclusive(async () => {
      if (generation !== this.generation) return
      const accepted = status >= 200 && status < 300
      const permanent =
        status >= 400 && status < 500 && status !== 408 && status !== 429
      if (accepted || permanent) {
        const ids = new Set(batch.map(row => row.I))
        this.events = this.events.filter(row => !ids.has(row.I))
        if (accepted) this.lastSuccess = this.now()
        else this.dropped += batch.length
        this.failures = 0
        this.nextAt = 0
        await this.persist()
      } else {
        this.failures = Math.min(this.failures + 1, 8)
        const random = this.options.random ?? Math.random
        this.nextAt =
          this.now() +
          Math.min(60000, 1000 * 2 ** this.failures) * (0.5 + random() * 0.5)
      }
    })
  }

  /** Clear before attaching a different authenticated identity. */
  async clear(): Promise<void> {
    this.generation++
    this.controller?.abort()
    await this.exclusive(async () => {
      this.events = []
      this.nextAt = 0
      this.failures = 0
      await this.persist()
    })
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.timer)
    this.timer = undefined
    this.controller?.abort()
  }

  private trim(): void {
    const before = this.events.length
    this.events = this.events.filter(
      row => Date.parse(row.D) >= this.now() - MAX_AGE_MS
    )
    while (
      this.events.length > 0 &&
      (this.events.length > (this.options.maxEvents ?? 500) ||
        bytes(JSON.stringify(this.events)) > (this.options.maxBytes ?? 524288))
    )
      this.events.shift()
    this.dropped += before - this.events.length
  }

  private async persist(): Promise<void> {
    try {
      await this.options.storage.setItem(
        this.options.key,
        JSON.stringify(this.events)
      )
      this.storageFailed = false
    } catch {
      this.storageFailed = true
    }
  }

  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.serial.then(run)
    this.serial = result.then(
      () => undefined,
      () => undefined
    )
    return await result
  }
}
