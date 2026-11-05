import { asObject, asOptional, asString } from 'cleaners'

import type { ChangeFeed } from '../changeFeed/feed'
import { isConnectionUnavailable } from '../db/database'
import {
  SCREEN_SCOPES_CHANNEL,
  type ScreenScopeIds,
  type ScreenScopePayload
} from './syncRevision'

export const asScreenScopePayload = asObject({
  gameId: asOptional(asString),
  teamId: asOptional(asString),
  seasonId: asOptional(asString),
  userId: asOptional(asString)
})

export interface ScreenScopeListenerOptions {
  /** The process's feed, on the database the writes commit to. */
  feed: ChangeFeed
  /** Passes one notice, after its window, to the sockets it concerns. */
  deliver: (payload: ScreenScopePayload) => Promise<void>
  /**
   * The feed has returned after a gap, or a notice found no database
   * connection in time: notices were never heard or never passed on, so every
   * screen scope subscribes again and reads.
   */
  onResync: () => void
  /** Notices about the same ids within this long are sent once. */
  coalesceMs?: number
  /**
   * At most one resync per this long for notices that found no connection, so
   * screens are not sent to read over and over while the pool is starved.
   */
  starvedResyncMs?: number
  log?: (message: string) => void
}

/** A notice held for its window; a later one in the window joins it. */
interface Held {
  payload: ScreenScopePayload
  timer: ReturnType<typeof setTimeout>
}

/**
 * One worker's end of `screen_scopes`.
 *
 * It hears the worker's feed, as `GameFanout` does on `game_changes`.
 * Notices that name the same game, team, season and person within
 * `coalesceMs` are passed on once, at the window's end. Which sockets hear
 * it is the socket's to decide (`gameSocket.ts`).
 */
export class ScreenScopeListener {
  /** Settles once the channel is first in place, or that attempt has failed. */
  readonly listening: Promise<void>
  private readonly deliver: (payload: ScreenScopePayload) => Promise<void>
  private readonly onResync: () => void
  private readonly coalesceMs: number
  private readonly starvedResyncMs: number
  private readonly log: (message: string) => void
  private readonly held = new Map<string, Held>()
  private readonly stopListening: () => void
  private closed = false
  /** When the last resync for a starved notice went. */
  private starvedResyncAt: number | undefined
  /** A later one, owed at the end of the window. */
  private starvedResyncTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: ScreenScopeListenerOptions) {
    this.deliver = options.deliver
    this.onResync = options.onResync
    this.coalesceMs = options.coalesceMs ?? 250
    this.starvedResyncMs = options.starvedResyncMs ?? 30_000
    this.log =
      options.log ??
      (message => {
        console.error(`screen scopes: ${message}`)
      })
    const subscription = options.feed.subscribe(SCREEN_SCOPES_CHANNEL, {
      onPayload: text => {
        this.notified(text)
      },
      onListening: first => {
        if (!first) this.onResync()
      }
    })
    this.listening = subscription.listening
    this.stopListening = subscription.stop
  }

  /** A notify, as the feed hands it over. */
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
      waiting.payload = payload
      return
    }
    const held: Held = {
      payload,
      timer: setTimeout(() => {
        this.held.delete(key)
        this.deliver(held.payload).catch((error: unknown) => {
          if (!isConnectionUnavailable(error)) {
            this.log(
              `sending ${JSON.stringify(held.payload)}: ${String(error)}`
            )
            return
          }
          if (this.closed) return
          this.log(
            `resyncing screens for ${JSON.stringify(held.payload)}: no database connection in time`
          )
          this.resyncStarved()
        })
      }, this.coalesceMs)
    }
    this.held.set(key, held)
  }

  /**
   * Once a window. A notice missed after the window's resync was read is still
   * owed its read, so the window's end brings one more when any were held back.
   */
  private resyncStarved(): void {
    if (this.starvedResyncTimer != null) return
    const now = Date.now()
    const dueAt = (this.starvedResyncAt ?? -Infinity) + this.starvedResyncMs
    if (now >= dueAt) {
      this.starvedResyncAt = now
      this.onResync()
      return
    }
    this.starvedResyncTimer = setTimeout(() => {
      this.starvedResyncTimer = undefined
      this.starvedResyncAt = Date.now()
      this.onResync()
    }, dueAt - now)
  }

  async close(): Promise<void> {
    this.closed = true
    this.stopListening()
    clearTimeout(this.starvedResyncTimer)
    for (const held of this.held.values()) clearTimeout(held.timer)
    this.held.clear()
  }
}

/** Notices about the same ids share a window. */
function keyOf(ids: ScreenScopeIds): string {
  return JSON.stringify([ids.gameId, ids.teamId, ids.seasonId, ids.userId])
}
