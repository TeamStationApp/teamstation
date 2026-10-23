import {
  type AppCode,
  type EventName,
  type Level,
  type Property,
  userId
} from './contract'
import { EventQueue, type QueueStorage } from './queue'

/** Only a public routing DSN is accepted. Administrative credentials never belong in clients. */
export function logEndpoint(dsn: string): string | undefined {
  try {
    const url = new URL(dsn)
    if (
      url.protocol !== 'https:' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(url.username) ||
      !/^\/[0-9]{1,20}$/.test(url.pathname)
    )
      return undefined
    return url.origin + '/ingest' + url.pathname
  } catch {
    return undefined
  }
}

export interface LoggerOptions {
  app: AppCode
  dsn: string
  version?: string
  storage: QueueStorage
  id: () => string
  now?: () => number
  request?: typeof fetch
  /** Private server credential, never included in client builds or stored queue records. */
  writeToken?: string
}

/** Bounded, sanitized delivery. Callers never await network work or see logging failures. */
export class Logger {
  readonly queue?: EventQueue
  private readonly now: () => number
  constructor(private readonly options: LoggerOptions) {
    this.now = options.now ?? Date.now
    const endpoint = logEndpoint(options.dsn)
    if (endpoint == null) return
    this.queue = new EventQueue({
      key: 'logs.v1.' + options.app + '.' + endpoint,
      storage: options.storage,
      now: this.now,
      send: async (body, signal) =>
        (
          await (options.request ?? fetch)(endpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-ndjson',
              ...(options.writeToken == null
                ? {}
                : { authorization: 'Bearer ' + options.writeToken })
            },
            credentials: 'omit',
            body,
            signal
          })
        ).status
    })
    this.queue.start()
  }

  emit(
    event: EventName,
    properties: Record<string, Property> = {},
    level: Level = 'info',
    actor?: string
  ): void {
    try {
      if (this.queue == null) return
      this.queue
        .enqueue({
          D: new Date(this.now()).toISOString(),
          A: this.options.app,
          I: this.options.id(),
          E: event,
          L: level,
          R: 1,
          P: properties,
          ...(this.options.app === 'TS srv' &&
          this.options.writeToken != null &&
          userId(actor) != null
            ? { U: actor }
            : {}),
          ...(this.options.version != null &&
          /^[0-9][0-9A-Za-z.+_-]{0,63}$/.test(this.options.version)
            ? { V: this.options.version }
            : {})
        })
        .catch(() => {})
    } catch {
      /* Reporting must not change application behavior. */
    }
  }

  async close(): Promise<void> {
    try {
      await this.queue?.flush()
    } finally {
      this.queue?.stop()
    }
  }
}
