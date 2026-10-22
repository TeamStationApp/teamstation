import { asObject, asOptional, asString } from 'cleaners'
import { Client } from 'pg'

import {
  SCREEN_SCOPES_CHANNEL,
  type ScreenScopeIds,
  type ScreenScopePayload
} from './syncRevision'

const asDecimal = (raw: unknown): string => {
  const text = asString(raw)
  if (!/^\d+$/.test(text)) throw new TypeError('Expected a decimal revision')
  return text
}

export const asScreenScopePayload = asObject({
  revision: asDecimal,
  gameId: asOptional(asString),
  teamId: asOptional(asString),
  seasonId: asOptional(asString),
  userId: asOptional(asString)
})

export interface ScreenScopeListenerOptions {
  /** Where the `LISTEN` connection goes: the database the writes commit to. */
  databaseUrl: string
  /** Passes one notice, after its window, to the sockets it concerns. */
  deliver: (payload: ScreenScopePayload) => Promise<void>
  /**
   * Listening again after the connection was lost: notices in between were
   * never heard, so every screen scope subscribes again and reads.
   */
  onResync: () => void
  /** Notices about the same ids within this long are sent once. */
  coalesceMs?: number
  /** How long to wait before listening again after the connection is lost. */
  retryMs?: number
  log?: (message: string) => void
}

/** A notice held for its window; a later one in the window raises it. */
interface Held {
  payload: ScreenScopePayload
  timer: ReturnType<typeof setTimeout>
}

/**
 * One worker's end of `screen_scopes`.
 *
 * It holds one `LISTEN` connection, beside the one `GameFanout` holds on
 * `game_changes`. Notices that name the same game, team, season and person
 * within `coalesceMs` are passed on once, with the greatest revision among
 * them. Which sockets hear it is the socket's to decide (`gameSocket.ts`).
 */
export class ScreenScopeListener {
  /** Settles once the first `LISTEN` is in place, or has failed. */
  readonly listening: Promise<void>
  private readonly databaseUrl: string
  private readonly deliver: (payload: ScreenScopePayload) => Promise<void>
  private readonly onResync: () => void
  private readonly coalesceMs: number
  private readonly retryMs: number
  private readonly log: (message: string) => void
  private readonly held = new Map<string, Held>()
  private client: Client | undefined
  private readonly hangingUp = new Set<Promise<void>>()
  private retry: ReturnType<typeof setTimeout> | undefined
  /** Set once a connection is lost, until a new `LISTEN` is in place. */
  private missed = false
  private closed = false

  constructor(options: ScreenScopeListenerOptions) {
    this.databaseUrl = options.databaseUrl
    this.deliver = options.deliver
    this.onResync = options.onResync
    this.coalesceMs = options.coalesceMs ?? 250
    this.retryMs = options.retryMs ?? 1000
    this.log =
      options.log ??
      (message => {
        console.error(`screen scopes: ${message}`)
      })
    this.listening = this.listen()
  }

  /** A notify, as the `LISTEN` connection hands it over. */
  notified(text: string | undefined): void {
    if (text == null || this.closed) return
    let payload: ScreenScopePayload
    try {
      payload = asScreenScopePayload(JSON.parse(text))
    } catch {
      this.log(`ignoring a notify that does not read: ${text}`)
      return
    }
    const key = keyOf(payload)
    const waiting = this.held.get(key)
    if (waiting != null) {
      if (BigInt(payload.revision) > BigInt(waiting.payload.revision))
        waiting.payload = payload
      return
    }
    const held: Held = {
      payload,
      timer: setTimeout(() => {
        this.held.delete(key)
        this.deliver(held.payload).catch((error: unknown) => {
          this.log(`sending ${JSON.stringify(held.payload)}: ${String(error)}`)
        })
      }, this.coalesceMs)
    }
    this.held.set(key, held)
  }

  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.retry)
    for (const held of this.held.values()) clearTimeout(held.timer)
    this.held.clear()
    const client = this.client
    this.client = undefined
    if (client != null) this.hangUp(client)
    await Promise.all([...this.hangingUp])
  }

  private hangUp(client: Client): void {
    const ending: Promise<void> = client
      .end()
      .catch(() => undefined)
      .finally(() => {
        this.hangingUp.delete(ending)
      })
    this.hangingUp.add(ending)
  }

  private async listen(): Promise<void> {
    if (this.closed) return
    const client = new Client({ connectionString: this.databaseUrl })
    this.client = client
    client.on('notification', message => {
      if (this.client === client) this.notified(message.payload)
    })
    client.on('error', error => {
      this.lost(client, String(error))
    })
    client.on('end', () => {
      this.lost(client, 'the connection ended')
    })
    try {
      await client.connect()
      await client.query(`listen ${SCREEN_SCOPES_CHANNEL}`)
    } catch (error) {
      this.lost(client, String(error))
      return
    }
    if (this.missed && this.client === client) {
      this.missed = false
      this.onResync()
    }
  }

  private lost(client: Client, why: string): void {
    if (this.client !== client || this.closed) return
    this.client = undefined
    this.missed = true
    this.log(`lost the ${SCREEN_SCOPES_CHANNEL} listener: ${why}`)
    this.hangUp(client)
    this.retry = setTimeout(() => {
      this.listen().catch(() => undefined)
    }, this.retryMs)
  }
}

/** Notices about the same ids share a window. */
function keyOf(ids: ScreenScopeIds): string {
  return JSON.stringify([ids.gameId, ids.teamId, ids.seasonId, ids.userId])
}
