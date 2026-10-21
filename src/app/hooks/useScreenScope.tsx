import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef
} from 'react'

import type { RevisionRead } from '../../common/api'
import type {
  ScreenScope,
  ScreenScopeEvent,
  ScreenScopeListener
} from '../../common/gameSocket'
import {
  type RevisionCollecting,
  ScreenScopeGate,
  type ScreenScopeSocket
} from '../../common/screenScope'

/** One scope as a string, so two of them compare as values. */
export function screenScopeKey(scope: ScreenScope): string {
  return scope.scope === 'event' ? `event:${scope.gameId}` : scope.scope
}

function scopeOfKey(key: string): ScreenScope {
  if (key.startsWith('event:'))
    return { scope: 'event', gameId: key.slice('event:'.length) }
  return { scope: key as 'home' | 'schedule' }
}

interface Shared {
  key: string
  listeners: Set<ScreenScopeListener>
  release?: () => void
  /** The last answer the scope had: what a load that joins late is told. */
  answer?: ScreenScopeEvent
}

/**
 * The visible screen's one scope, held for each of the loads on it.
 *
 * A socket holds one scope, and a subscribe to another replaces it. Home has
 * three loads (its lists, the recent game, what is live), each with its own
 * revision, so each has its own gate; they share the one subscription here.
 * A load that joins a scope already answered hears that answer, after the
 * call that joined it returns, as the gate expects of a socket.
 */
export class SharedScreenScope implements ScreenScopeSocket {
  private readonly socket: ScreenScopeSocket
  private shared: Shared | undefined

  constructor(socket: ScreenScopeSocket) {
    this.socket = socket
  }

  subscribeScope(
    scope: ScreenScope,
    listener: ScreenScopeListener
  ): () => void {
    const key = screenScopeKey(scope)
    let shared = this.shared
    if (shared?.key === key) {
      shared.listeners.add(listener)
      const answer = shared.answer
      const joined = shared
      if (answer != null)
        Promise.resolve()
          .then(() => {
            if (
              this.shared === joined &&
              joined.answer === answer &&
              joined.listeners.has(listener)
            )
              listener(answer)
          })
          .catch(() => undefined)
    } else {
      shared?.release?.()
      const fresh: Shared = { key, listeners: new Set([listener]) }
      shared = fresh
      this.shared = fresh
      try {
        fresh.release = this.socket.subscribeScope(scope, event => {
          this.heard(fresh, event)
        })
      } catch {
        // A platform with no socket: nothing will be acknowledged.
        this.heard(fresh, { type: 'stopped' })
      }
    }
    const held = shared
    return () => {
      if (!held.listeners.delete(listener)) return
      if (held.listeners.size > 0 || this.shared !== held) return
      this.shared = undefined
      held.release?.()
    }
  }

  private heard(shared: Shared, event: ScreenScopeEvent): void {
    if (this.shared !== shared) return
    if (event.type === 'resync') shared.answer = undefined
    else if (event.type !== 'changed') shared.answer = event
    for (const listener of [...shared.listeners]) listener(event)
  }
}

interface ScreenScopeValue {
  socket?: ScreenScopeSocket
  scope?: ScreenScope
}

const ScreenScopeContext = createContext<ScreenScopeValue>({})

export interface ScreenScopeProviderProps {
  /** None for a signed-out visitor: nothing is acknowledged. */
  socket?: ScreenScopeSocket
  /** The visible screen's scope; none for a screen that takes none. */
  scope?: ScreenScope
  children?: React.ReactNode
}

/**
 * Holds the visible route's scope on the socket, for as long as that route
 * is visible, and lets the screen's loads wait for it (`useScreenScope`).
 * A screen with no load to wait for, such as scoring, still holds its scope.
 */
export function ScreenScopeProvider(
  props: ScreenScopeProviderProps
): React.ReactElement {
  const { socket, children } = props
  const shared = useMemo(
    () => (socket == null ? undefined : new SharedScreenScope(socket)),
    [socket]
  )
  const key = props.scope == null ? undefined : screenScopeKey(props.scope)
  const scope = useMemo(
    () => (key == null ? undefined : scopeOfKey(key)),
    [key]
  )
  useEffect(() => {
    if (shared == null || scope == null) return
    return shared.subscribeScope(scope, () => undefined)
  }, [shared, scope])
  const value = useMemo(() => ({ socket: shared, scope }), [shared, scope])
  return (
    <ScreenScopeContext.Provider value={value}>
      {children}
    </ScreenScopeContext.Provider>
  )
}

/** What a screen's load reads through, as far as the gate is concerned. */
type ScopeClient = Partial<RevisionCollecting>

function collectingOf(client: ScopeClient | undefined): RevisionCollecting {
  return {
    get offline() {
      return client?.offline === true
    },
    collectRevisions: (collector: RevisionRead[]) => {
      client?.collectRevisions?.(collector)
    },
    stopCollecting: (collector: RevisionRead[]) => {
      client?.stopCollecting?.(collector)
    }
  }
}

/**
 * Runs one of the visible screen's loads when its scope allows. With
 * `passGameNotices`, a home or schedule notice that names one game alone does
 * not run it: a list of teams and seasons shows no game.
 *
 * Returns the function the screen calls wherever it called `load` before:
 * from `useForegroundRefresh`, a timer, or a socket's game frame. While
 * online with a socket, the first call holds the screen's scope and the
 * load waits for the server's `subscribed` (or three seconds); a later
 * `changed` newer than what the load read runs it again. With no socket, no
 * scope, or the client offline, a call runs the load at once.
 *
 * A new `load` (its inputs changed) makes a new function, so a hook that
 * depends on it calls again.
 */
export function useScreenScope(
  load: () => Promise<void>,
  client?: ScopeClient,
  options: {
    /** The load shows no games: a notice of one game alone reads nothing. */
    passGameNotices?: boolean
  } = {}
): ScreenScopeRead {
  const passGameNotices = options.passGameNotices === true
  const { socket, scope } = useContext(ScreenScopeContext)
  const latest = useRef(load)
  latest.current = load
  const gate = useMemo(
    () =>
      new ScreenScopeGate({
        load: async () => {
          await latest.current()
        },
        socket,
        client: collectingOf(client),
        ...(passGameNotices
          ? {
              passes: (notice: { gameId?: string }) => notice.gameId != null
            }
          : {})
      }),
    [socket, client, passGameNotices]
  )
  /** The gate and scope this render's function may act on, once mounted. */
  const live = useRef<
    { gate: ScreenScopeGate; scope?: ScreenScope } | undefined
  >(undefined)
  /** Whether that gate has entered that scope yet. */
  const entered = useRef(false)
  useEffect(() => {
    live.current = { gate, scope }
    return () => {
      gate.leave()
      live.current = undefined
      entered.current = false
    }
  }, [gate, scope])
  const read = useCallback(async (): Promise<void> => {
    // Unmounted, or a function an older render handed out.
    if (live.current?.gate !== gate || live.current.scope !== scope) return
    if (entered.current) {
      gate.refresh()
      return
    }
    entered.current = true
    gate.enter(scope)
    // `load` is read through `latest`. It is a dependency so that a new one
    // makes a new function, and the hooks that call it ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate, scope, load])
  return useMemo(
    () =>
      Object.assign(read, {
        alongside: async (other: () => Promise<void>): Promise<void> => {
          if (live.current?.gate !== gate) {
            await other()
            return
          }
          await gate.alongside(other)
        }
      }),
    [read, gate]
  )
}

/**
 * The function `useScreenScope` hands back: the load, when the scope allows,
 * and `alongside` for a read the screen makes by another way (a game's play
 * frame), whose answer then counts for the scope's notice of the same commit.
 */
export type ScreenScopeRead = (() => Promise<void>) & {
  alongside: (read: () => Promise<void>) => Promise<void>
}
