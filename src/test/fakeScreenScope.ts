import type { RevisionRead } from '../common/api'
import type {
  ScreenScope,
  ScreenScopeEvent,
  ScreenScopeListener
} from '../common/gameSocket'
import type { ScreenScopeSocket } from '../common/screenScope'

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
    this.log.push(
      'revision' in event ? `${event.type} ${event.revision}` : event.type
    )
    held.listener(event)
  }

  ack(revision = '1'): void {
    this.deliver({ type: 'subscribed', revision })
  }

  changed(revision: string): void {
    this.deliver({ type: 'changed', revision })
  }
}

function describe(scope: ScreenScope): string {
  return scope.scope === 'event' ? `event:${scope.gameId}` : scope.scope
}

/**
 * The revision-collecting part of a client, for a fake one: every call made
 * through `answer` is stamped with the revision the test sets for its path.
 */
export function revisionStamps(): {
  offline: boolean
  revisions: Map<string, string>
  collectRevisions: (collector: RevisionRead[]) => void
  stopCollecting: (collector: RevisionRead[]) => void
  /** Records an answer from `path` as the real client does. */
  answer: (path: string) => void
} {
  const collectors = new Set<RevisionRead[]>()
  const revisions = new Map<string, string>()
  return {
    offline: false,
    revisions,
    collectRevisions: collector => {
      collectors.add(collector)
    },
    stopCollecting: collector => {
      collectors.delete(collector)
    },
    answer: path => {
      const revision = revisions.get(path)
      if (revision == null) return
      for (const collector of collectors) collector.push({ path, revision })
    }
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
