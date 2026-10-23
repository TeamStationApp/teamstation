import { mkdir, open, readFile, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import { parseEvent } from '../common/observability/contract'
import { environment, type LogDocument, type OpenSearch } from './openSearch'

/** A single process owns this file. Accept only after the sanitized snapshot is durable. */
export class LogSpool {
  private rows: LogDocument[] = []
  private serial: Promise<void> = Promise.resolve()
  private sending = false
  private retryAt = 0
  private failures = 0
  private healthy = true
  dropped = 0
  lastSuccess?: string
  readonly ready: Promise<void>
  constructor(
    private readonly file: string,
    private readonly sink: Pick<OpenSearch, 'bulk'>,
    private readonly now = Date.now,
    private readonly capacity = 32 * 1024 * 1024
  ) {
    this.ready = this.load()
  }

  private async load(): Promise<void> {
    try {
      const info = await stat(this.file)
      if (info.size > this.capacity) throw new Error('Spool exceeds capacity')
      const raw: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      if (!Array.isArray(raw) || raw.length > 100000)
        throw new Error('Invalid spool')
      for (const row of raw) {
        const { N, T, ...event } = row
        if (typeof T !== 'string' || !Number.isFinite(Date.parse(T)))
          throw new Error('Invalid receipt time')
        // Stored documents may outlive the client admission window during an outage.
        this.rows.push({
          ...parseEvent(event, Date.parse(event.D)),
          N: environment(N),
          T
        })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.healthy = false
        throw new Error('Spool cannot be restored')
      }
    }
  }

  status(): {
    pending: number
    dropped: number
    healthy: boolean
    lastSuccess?: string
  } {
    return {
      pending: this.rows.length,
      dropped: this.dropped,
      healthy: this.healthy,
      lastSuccess: this.lastSuccess
    }
  }

  async append(events: LogDocument[]): Promise<void> {
    await this.ready
    await this.exclusive(async () => {
      const next = [...this.rows]
      const ids = new Set(next.map(row => row.N + ':' + row.I))
      for (const row of events)
        if (!ids.has(row.N + ':' + row.I)) {
          next.push(row)
          ids.add(row.N + ':' + row.I)
        }
      if (
        next.length > 100000 ||
        Buffer.byteLength(JSON.stringify(next)) > this.capacity
      )
        throw new Error('Spool full')
      await this.persist(next)
      this.rows = next
    })
  }

  async flush(): Promise<void> {
    await this.ready
    if (this.sending || this.now() < this.retryAt || this.rows.length === 0)
      return
    this.sending = true
    const batch = this.rows.slice(0, 50)
    try {
      const outcomes = await this.sink.bulk(batch)
      const remove = new Set(
        batch
          .filter((_, i) => outcomes[i] === 'done' || outcomes[i] === 'drop')
          .map(row => row.N + ':' + row.I)
      )
      await this.exclusive(async () => {
        const next = this.rows.filter(row => !remove.has(row.N + ':' + row.I))
        await this.persist(next)
        this.rows = next
        this.dropped += outcomes.filter(x => x === 'drop').length
      })
      if (outcomes.includes('done'))
        this.lastSuccess = new Date(this.now()).toISOString()
      if (outcomes.includes('retry')) this.backoff()
      else {
        this.failures = 0
        this.retryAt = 0
      }
    } catch {
      this.backoff()
    } finally {
      this.sending = false
    }
  }

  private backoff(): void {
    this.failures = Math.min(8, this.failures + 1)
    this.retryAt =
      this.now() +
      Math.min(60000, 1000 * 2 ** this.failures) * (0.5 + Math.random() * 0.5)
  }

  private async persist(rows: LogDocument[]): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      const handle = await open(this.file + '.new', 'w', 0o600)
      try {
        await handle.writeFile(JSON.stringify(rows))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(this.file + '.new', this.file)
      const directory = await open(dirname(this.file), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
      this.healthy = true
    } catch {
      this.healthy = false
      throw new Error('Spool persistence unavailable')
    }
  }

  private async exclusive(run: () => Promise<void>): Promise<void> {
    const pending = this.serial.then(run)
    this.serial = pending.catch(() => {})
    await pending
  }
}
