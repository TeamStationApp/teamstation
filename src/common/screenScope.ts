import type {
  ScreenScope,
  ScreenScopeEvent,
  ScreenScopeListener
} from './gameSocket'

/**
 * How long a screen waits for its scope's `subscribed` before it reads
 * anyway, so it can leave its loading state.
 */
export const ACK_GIVE_UP_MS = 3000

/** The part of `GameSocket` a screen's scope uses. */
export interface ScreenScopeSocket {
  subscribeScope: (
    scope: ScreenScope,
    listener: ScreenScopeListener
  ) => () => void
}

/**
 * The shortest time between the starts of two reads a screen's notices
 * cause. A notice with no read running and none begun this long ago reads at
 * once; any other waits, and every notice until that read begins is covered
 * by it.
 */
export const COALESCE_MS = 3000

/** The part of the client a screen's load reads through. */
export interface ScreenScopeClient {
  /** Set while requests fail to leave the device. */
  offline?: boolean
}

/** The clock a gate times its reads by: the platform's, unless given. */
export interface ScreenScopeTimers {
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  /** In milliseconds, for the time since a read began. */
  now?: () => number
}

export interface ScreenScopeGateOptions extends ScreenScopeTimers {
  /** The screen's existing load: the REST calls it already makes. */
  load: () => Promise<void>
  /** None for a signed-out visitor: there is nothing to acknowledge. */
  socket?: ScreenScopeSocket
  client?: ScreenScopeClient
  giveUpMs?: number
  /** `COALESCE_MS` unless given. */
  coalesceMs?: number
  /**
   * A notice this load does not show, which reads nothing: Home's lists of
   * teams and seasons let a notice of one game alone pass.
   */
  passes?: (notice: { gameId?: string }) => boolean
  /** A load that threw. The gate goes on; the screen shows its own error. */
  onError?: (error: unknown) => void
}

/**
 * When a screen that holds a scope may read.
 *
 * While online with a socket, the screen's load does not run until the
 * server acknowledges the scope (`subscribed`), so every write committed
 * after the read began is announced to it. If no acknowledgement comes
 * within `giveUpMs` the load runs so the screen can leave its loading
 * state, and runs again when the acknowledgement does arrive: that second
 * read is the one that closes the race. Every later `subscribed` (after a
 * reconnect or a server `resync`) reads again at once.
 *
 * A `changed` reads at once when no read of the screen is running and the
 * last one began `coalesceMs` ago or more. Otherwise it is owed: one read,
 * once any running read has finished and `coalesceMs` have passed since the
 * last began, covers it and every other notice until that read begins. A
 * read the screen starts itself (a refresh, or `alongside`) counts as a read
 * here. A screen that has left its scope, or replaced it, hears nothing more
 * from it.
 *
 * While the socket is down after a lost or refused connection, waiting to
 * try again, a read runs at once rather than wait out the retry. A first
 * connect on its way is waited for as above.
 *
 * With no socket, no scope, or the client offline, a read runs at once. So
 * does it once the scope was refused or stopped for want of a token.
 */
export class ScreenScopeGate {
  private readonly load: () => Promise<void>
  private readonly socket: ScreenScopeSocket | undefined
  private readonly client: ScreenScopeClient | undefined
  private readonly giveUpMs: number
  private readonly coalesceMs: number
  private readonly onError: (error: unknown) => void
  private readonly passes: (notice: { gameId?: string }) => boolean
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  private readonly now: () => number
  /** Moves on each enter and leave, so a stale answer is told apart. */
  private generation = 0
  private release: (() => void) | undefined
  private acked = false
  /** Nothing will be acknowledged: a read runs at once. */
  private direct = true
  /** The socket is down and retrying: reads run at once until it is back. */
  private unreachable = false
  /** A read is wanted and waits for the acknowledgement. */
  private wanted = false
  private giveUp: unknown
  private running = false
  /** A read was asked for while one ran: it runs once that one ends. */
  private again = false
  /** A notice is owed a read, no sooner than `coalesceMs` after the last. */
  private dirty = false
  /** The owed read, waiting out `coalesceMs`. */
  private owed: unknown
  /** When the last read began, the screen's own included. */
  private startedAt: number | undefined
  /** Reads the screen is making by another way (`alongside`). */
  private outside = 0

  constructor(options: ScreenScopeGateOptions) {
    this.load = options.load
    this.socket = options.socket
    this.client = options.client
    this.giveUpMs = options.giveUpMs ?? ACK_GIVE_UP_MS
    this.coalesceMs = options.coalesceMs ?? COALESCE_MS
    this.onError = options.onError ?? (() => undefined)
    this.passes = options.passes ?? (() => false)
    this.setTimer =
      options.setTimer ?? ((run, ms) => globalThis.setTimeout(run, ms))
    this.clearTimer =
      options.clearTimer ??
      (timer => {
        globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>)
      })
    this.now = options.now ?? (() => Date.now())
  }

  /** Whether the server has registered the scope this screen holds. */
  get acknowledged(): boolean {
    return this.acked
  }

  /**
   * The screen became visible: holds `scope` in place of any other and
   * reads as the gate allows. `undefined` is a screen that takes no scope.
   */
  enter(scope: ScreenScope | undefined): void {
    this.leave()
    const generation = this.generation
    this.direct = scope == null || this.socket == null
    if (scope != null && this.socket != null) {
      this.release = this.socket.subscribeScope(scope, event => {
        if (generation === this.generation) this.heard(event)
      })
    }
    this.refresh()
  }

  /**
   * The screen wants its data read: on entering, from the foreground
   * refresh, or a live timer. Before the acknowledgement it waits for it.
   */
  refresh(): void {
    if (
      this.direct ||
      this.acked ||
      this.unreachable ||
      this.client?.offline === true
    ) {
      this.requestLoad()
      return
    }
    this.wanted = true
    if (this.giveUp != null) return
    const generation = this.generation
    this.giveUp = this.setTimer(() => {
      if (generation !== this.generation) return
      this.giveUp = undefined
      this.runWanted()
    }, this.giveUpMs)
  }

  /**
   * A read the screen makes by another way, for news that came by another
   * way: a game's play frame. It counts as a read: a notice heard while it
   * runs is owed one more, and one after it waits out `coalesceMs` from its
   * start. So does a notice owed before it began: its read is timed again
   * from this one's start once this one ends.
   */
  async alongside(read: () => Promise<void>): Promise<void> {
    const generation = this.generation
    this.outside++
    this.startedAt = this.now()
    this.stopOwing()
    try {
      await read()
    } finally {
      if (generation === this.generation) {
        this.outside--
        this.settled()
      }
    }
  }

  /** The screen is no longer visible: its scope goes, and its notices. */
  leave(): void {
    this.generation++
    this.release?.()
    this.release = undefined
    this.stopWaiting()
    this.stopOwing()
    this.acked = false
    this.direct = true
    this.unreachable = false
    this.running = false
    this.again = false
    this.dirty = false
    this.startedAt = undefined
    this.outside = 0
  }

  private heard(event: ScreenScopeEvent): void {
    switch (event.type) {
      case 'subscribed':
        this.acked = true
        this.unreachable = false
        this.stopWaiting()
        this.requestLoad()
        return
      case 'unreachable':
        if (this.acked) return
        this.unreachable = true
        this.runWanted()
        return
      case 'changed':
        // Before the acknowledgement a notice is older than the read the
        // acknowledgement starts.
        if (!this.acked && !this.direct) return
        if (this.passes(event)) return
        this.noticed()
        return
      case 'resync':
        this.acked = false
        return
      case 'error':
      case 'stopped':
        this.acked = false
        this.direct = true
        this.runWanted()
    }
  }

  /** A notice the screen shows: it reads at once, or is owed a read. */
  private noticed(): void {
    if (this.running || this.outside > 0) {
      this.dirty = true
      return
    }
    if (this.owed != null) return
    this.dirty = true
    this.readWhenDue()
  }

  /** Reads what is owed once `coalesceMs` have passed since the last read began. */
  private readWhenDue(): void {
    const wait =
      this.startedAt == null ? 0 : this.startedAt + this.coalesceMs - this.now()
    if (wait <= 0) {
      this.requestLoad()
      return
    }
    // Leaving clears it, so it only ever runs for this scope.
    this.owed = this.setTimer(() => {
      this.owed = undefined
      if (this.running || this.outside > 0) return
      this.requestLoad()
    }, wait)
  }

  /** A read ended: what was asked for meanwhile runs, or waits its turn. */
  private settled(): void {
    if (this.running || this.outside > 0) return
    if (this.again) {
      this.requestLoad()
      return
    }
    if (this.dirty && this.owed == null) this.readWhenDue()
  }

  /** Runs the read that was waiting for the acknowledgement, if one was. */
  private runWanted(): void {
    if (!this.wanted) return
    this.stopWaiting()
    this.requestLoad()
  }

  private stopWaiting(): void {
    this.wanted = false
    if (this.giveUp != null) this.clearTimer(this.giveUp)
    this.giveUp = undefined
  }

  private stopOwing(): void {
    if (this.owed != null) this.clearTimer(this.owed)
    this.owed = undefined
  }

  /** Reads now, or once the running read ends. Covers every notice so far. */
  private requestLoad(): void {
    if (this.running) {
      this.again = true
      return
    }
    this.run().catch(this.onError)
  }

  private async run(): Promise<void> {
    const generation = this.generation
    this.running = true
    this.again = false
    this.dirty = false
    this.stopOwing()
    this.startedAt = this.now()
    try {
      await this.load()
    } catch (error: unknown) {
      this.onError(error)
    }
    if (generation !== this.generation) return
    this.running = false
    this.settled()
  }
}
