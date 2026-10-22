import type { RevisionRead } from './api'
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

/** The part of the client a screen's load reads through. */
export interface RevisionCollecting {
  /** Set while requests fail to leave the device. */
  offline?: boolean
  collectRevisions: (collector: RevisionRead[]) => void
  stopCollecting: (collector: RevisionRead[]) => void
}

export interface ScreenScopeGateOptions {
  /** The screen's existing load: the REST calls it already makes. */
  load: () => Promise<void>
  /** None for a signed-out visitor: there is nothing to acknowledge. */
  socket?: ScreenScopeSocket
  client?: RevisionCollecting
  giveUpMs?: number
  /**
   * A notice this load does not show, which reads nothing: Home's lists of
   * teams and seasons let a notice of one game alone pass.
   */
  passes?: (notice: { revision: string; gameId?: string }) => boolean
  /** A load that threw. The gate goes on; the screen shows its own error. */
  onError?: (error: unknown) => void
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/** The least revision among one load's answers, or none if none had one. */
export function leastRevision(
  reads: readonly RevisionRead[]
): bigint | undefined {
  let least: bigint | undefined
  for (const read of reads) {
    const revision = BigInt(read.revision)
    if (least == null || revision < least) least = revision
  }
  return least
}

/**
 * When a screen that holds a scope may read.
 *
 * While online with a socket, the screen's load does not run until the
 * server acknowledges the scope (`subscribed`), so every write committed
 * after the read's snapshot is announced to it. If no acknowledgement comes
 * within `giveUpMs` the load runs so the screen can leave its loading
 * state, and runs again when the acknowledgement does arrive: that second
 * read is the one that closes the race. Every later `subscribed` (after a
 * reconnect or a server `resync`) reads again.
 *
 * The revision the screen holds is the least one among the answers of its
 * last load. A `changed` newer than that reads again, once even if several
 * arrive while a load runs; one at or below it does nothing. A screen that
 * has left its scope, or replaced it, hears nothing more from it.
 *
 * While the socket is down after a lost or refused connection, waiting to
 * try again, a read runs at once rather than wait out the retry, and the
 * next `subscribed` reads again only when it is newer than that read. A
 * first connect on its way is waited for as above.
 *
 * With no socket, no scope, or the client offline, a read runs at once. So
 * does it once the scope was refused or stopped for want of a token.
 */
export class ScreenScopeGate {
  private readonly load: () => Promise<void>
  private readonly socket: ScreenScopeSocket | undefined
  private readonly client: RevisionCollecting | undefined
  private readonly giveUpMs: number
  private readonly onError: (error: unknown) => void
  private readonly passes: (notice: {
    revision: string
    gameId?: string
  }) => boolean

  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  /** Moves on each enter and leave, so a stale answer is told apart. */
  private generation = 0
  private release: (() => void) | undefined
  private acked = false
  /** Nothing will be acknowledged: a read runs at once. */
  private direct = true
  /**
   * The socket is down and retrying: reads run at once until the next
   * acknowledgement, which reads again only if it is newer.
   */
  private unreachable = false
  /** A read is wanted and waits for the acknowledgement. */
  private wanted = false
  private giveUp: unknown
  private running = false
  /** Another read was asked for while one ran. */
  private again = false
  private held: bigint | undefined
  /** The newest notice heard while a load ran. */
  private newest: bigint | undefined
  /** Reads the screen is making by another way (`alongside`). */
  private outside = 0
  /** The newest notice heard while one of those ran. */
  private newestOutside: bigint | undefined

  constructor(options: ScreenScopeGateOptions) {
    this.load = options.load
    this.socket = options.socket
    this.client = options.client
    this.giveUpMs = options.giveUpMs ?? ACK_GIVE_UP_MS
    this.onError = options.onError ?? (() => undefined)
    this.passes = options.passes ?? (() => false)
    this.setTimer =
      options.setTimer ?? ((run, ms) => globalThis.setTimeout(run, ms))
    this.clearTimer =
      options.clearTimer ??
      (timer => {
        globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>)
      })
  }

  /** The revision of what the screen shows, as a decimal string. */
  get revision(): string | undefined {
    return this.held?.toString()
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
   * way: a game's play frame. Its answers count as what the screen shows, so
   * the scope's notice of the same commit reads nothing more; a notice newer
   * than them, heard meanwhile or after, reads as usual.
   */
  async alongside(read: () => Promise<void>): Promise<void> {
    const generation = this.generation
    const collector: RevisionRead[] = []
    this.client?.collectRevisions(collector)
    this.outside++
    let failed = true
    try {
      await read()
      failed = false
    } finally {
      this.client?.stopCollecting(collector)
      if (generation === this.generation) {
        this.outside--
        const least = failed ? undefined : leastRevision(collector)
        if (least != null && (this.held == null || least > this.held))
          this.held = least
        const newest = this.newestOutside
        if (this.outside === 0) {
          this.newestOutside = undefined
          if (newest != null && (this.held == null || newest > this.held))
            this.requestLoad()
        }
      }
    }
  }

  /** The screen is no longer visible: its scope goes, and its notices. */
  leave(): void {
    this.generation++
    this.release?.()
    this.release = undefined
    this.stopWaiting()
    this.acked = false
    this.direct = true
    this.unreachable = false
    this.running = false
    this.again = false
    this.held = undefined
    this.newest = undefined
    this.outside = 0
    this.newestOutside = undefined
  }

  private heard(event: ScreenScopeEvent): void {
    switch (event.type) {
      case 'subscribed': {
        const read = this.unreachable && !this.running ? this.held : undefined
        this.acked = true
        this.unreachable = false
        this.stopWaiting()
        // Read while the socket was down: an acknowledgement no newer than
        // that read has nothing more to show, and notices from here on do.
        if (read != null && BigInt(event.revision) <= read) return
        this.requestLoad()
        return
      }
      case 'unreachable':
        if (this.acked) return
        this.unreachable = true
        this.runWanted()
        return
      case 'changed': {
        // Before the acknowledgement a notice is older than the read the
        // acknowledgement starts.
        if (!this.acked && !this.direct) return
        if (this.passes(event)) return
        const revision = BigInt(event.revision)
        if (this.outside > 0 && !this.running) {
          if (this.newestOutside == null || revision > this.newestOutside)
            this.newestOutside = revision
          return
        }
        if (this.running) {
          if (this.newest == null || revision > this.newest)
            this.newest = revision
          return
        }
        if (this.held == null || revision > this.held) this.requestLoad()
        return
      }
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
    this.newest = undefined
    const collector: RevisionRead[] = []
    this.client?.collectRevisions(collector)
    let failed = false
    try {
      await this.load()
    } catch (error: unknown) {
      failed = true
      this.onError(error)
    } finally {
      this.client?.stopCollecting(collector)
    }
    if (generation !== this.generation) return
    this.running = false
    // A load that failed left the screen as it was, at the revision it had.
    if (!failed) this.held = leastRevision(collector)
    const newest = this.newest
    this.newest = undefined
    if (
      this.again ||
      (newest != null && (this.held == null || newest > this.held))
    )
      this.requestLoad()
  }
}
