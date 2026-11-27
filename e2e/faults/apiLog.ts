import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

/**
 * The stack API's log, as the fault server reads it: the file the API
 * unit's standard output is appended to (`/srv/e2e/log/api.log` on a pool
 * stack, beside the checkout the fault server runs from). Its lines carry no
 * time, so each is stamped when the fault server first reads it: on every
 * poll, and on every ask, so an ask sees every line written before it.
 */

export interface ApiLogLine {
  /** When the fault server first read the line, in ms; no earlier than it was written. */
  at: number
  text: string
}

export interface ApiLogOptions {
  /** How many lines to keep, the newest; older ones are dropped. */
  keep?: number
  /** How often to read while nobody asks; 0 reads only when asked. */
  pollMs?: number
  now?: () => number
}

export class ApiLogTail {
  readonly path: string
  private readonly keep: number
  private readonly now: () => number
  private readonly lines: ApiLogLine[] = []
  private offset = 0
  private partial = ''
  private readonly timer: ReturnType<typeof setInterval> | undefined

  constructor(path: string, options: ApiLogOptions = {}) {
    this.path = path
    this.keep = options.keep ?? 50_000
    this.now = options.now ?? Date.now
    const pollMs = options.pollMs ?? 1000
    if (pollMs > 0) {
      const timer = setInterval(() => {
        try {
          this.read()
        } catch {
          // Not there yet, or unreadable: the next ask says so.
        }
      }, pollMs)
      // It never keeps the fault server's process up on its own.
      ;(timer as { unref?: () => void }).unref?.()
      this.timer = timer
    }
  }

  /** Reads what the file gained since the last read. Throws when it cannot be read. */
  read(): void {
    const fd = openSync(this.path, 'r')
    try {
      const size = fstatSync(fd).size
      // Truncated or replaced: start again from its top.
      if (size < this.offset) {
        this.offset = 0
        this.partial = ''
      }
      if (size === this.offset) return
      const bytes = Buffer.alloc(size - this.offset)
      let got = 0
      while (got < bytes.length) {
        const n = readSync(
          fd,
          bytes,
          got,
          bytes.length - got,
          this.offset + got
        )
        if (n === 0) break
        got += n
      }
      this.offset += got
      const text = this.partial + bytes.subarray(0, got).toString('utf8')
      const parts = text.split('\n')
      // The last part has no newline yet: it waits for the rest of its line.
      this.partial = parts.pop() ?? ''
      const at = this.now()
      for (const line of parts) this.lines.push({ at, text: line })
      if (this.lines.length > this.keep) {
        this.lines.splice(0, this.lines.length - this.keep)
      }
    } finally {
      closeSync(fd)
    }
  }

  /** Every kept line read at or after `since`, after reading what is new. */
  since(since: number): ApiLogLine[] {
    this.read()
    return this.lines.filter(line => line.at >= since)
  }

  close(): void {
    if (this.timer != null) clearInterval(this.timer)
  }
}
