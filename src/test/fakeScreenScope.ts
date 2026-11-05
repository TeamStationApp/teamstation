import type {
  ScreenScope,
  ScreenScopeEvent,
  ScreenScopeListener
} from '../common/gameSocket'
import type {
  ScreenScopeSocket,
  ScreenScopeTimers
} from '../common/screenScope'

/** One scope a screen asked the fake socket for. */
export interface HeldScope {
  scope: ScreenScope
  listener: ScreenScopeListener
  released: boolean
}

/**
 * The part of `GameSocket` a screen's scope uses, driven by hand: the test
 * sees each scope asked for and answers as the server would.
 */
export class FakeScopeSocket implements ScreenScopeSocket {
  readonly held: HeldScope[] = []
  /** What happened, in order, for a test that checks the order of things. */
  readonly log: string[]

  constructor(log: string[] = []) {
    this.log = log
  }

  subscribeScope(
    scope: ScreenScope,
    listener: ScreenScopeListener
  ): () => void {
    const entry: HeldScope = { scope: { ...scope }, listener, released: false }
    for (const other of this.held) other.released = true
    this.held.push(entry)
    this.log.push(`subscribe ${describe(scope)}`)
    return () => {
      if (entry.released) return
      entry.released = true
      this.log.push(`unsubscribe ${describe(scope)}`)
    }
  }

  /** The scope held now, if any. */
  current(): HeldScope | undefined {
    const last = this.held.at(-1)
    return last == null || last.released ? undefined : last
  }

  /** The scopes asked for, in order, as `home`, `schedule`, `event:<id>`. */
  asked(): string[] {
    return this.held.map(entry => describe(entry.scope))
  }

  /** The server answers the scope held now. */
  deliver(event: ScreenScopeEvent): void {
    const held = this.current()
    if (held == null) throw new Error('no scope is held')
    this.log.push(event.type)
    held.listener(event)
  }

  ack(): void {
    this.deliver({ type: 'subscribed' })
  }

  /** A notice, naming a game, and a post's own (`byPost`) when it says so. */
  changed(gameId?: string, byPost?: boolean): void {
    this.deliver({
      type: 'changed',
      ...(gameId == null ? {} : { gameId }),
      ...(byPost === true ? { byPost } : {})
    })
  }
}

function describe(scope: ScreenScope): string {
  return scope.scope === 'event' ? `event:${scope.gameId}` : scope.scope
}

/**
 * A clock a test moves by hand, for the gate (`ScreenScopeTimers`): its
 * timers run only when `advance` passes their time, in the order they fall
 * due, each seeing `now()` at its own time.
 */
export function testClock(start = 1_000_000): Required<ScreenScopeTimers> & {
  /** Moves the clock on, running every timer that falls due on the way. */
  advance: (ms: number) => void
  /** The delays of the timers waiting now, in the order they were set. */
  pending: () => number[]
} {
  let now = start
  let next = 1
  const waiting = new Map<number, { at: number; run: () => void }>()
  return {
    now: () => now,
    setTimer: (run, ms) => {
      const id = next++
      waiting.set(id, { at: now + ms, run })
      return id
    },
    clearTimer: timer => {
      waiting.delete(timer as number)
    },
    advance: ms => {
      const until = now + ms
      for (;;) {
        let due: [number, { at: number; run: () => void }] | undefined
        for (const entry of waiting)
          if (entry[1].at <= until && (due == null || entry[1].at < due[1].at))
            due = entry
        if (due == null) break
        waiting.delete(due[0])
        now = due[1].at
        due[1].run()
      }
      now = until
    },
    pending: () => [...waiting.values()].map(entry => entry.at - now)
  }
}

/**
 * Holds every timer set for `ms` (the three seconds a screen waits for its
 * acknowledgement) so a test fires them when it likes; others run as usual.
 */
export function heldTimers(ms: number): {
  /** Runs every held timer that has not been cleared. */
  fire: () => void
  pending: () => number
  restore: () => void
} {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const held = new Map<object, () => void>()
  globalThis.setTimeout = ((
    callback: () => void,
    delay?: number,
    ...rest: unknown[]
  ) => {
    if (delay !== ms) return realSet(callback, delay, ...rest)
    const id = {}
    held.set(id, callback)
    return id
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = (id: unknown) => {
    if (typeof id === 'object' && id != null && held.delete(id)) return
    realClear(id as Parameters<typeof clearTimeout>[0])
  }
  return {
    fire: () => {
      const due = [...held.values()]
      held.clear()
      for (const run of due) run()
    },
    pending: () => held.size,
    restore: () => {
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
    }
  }
}
