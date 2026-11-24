import React, { createContext, useContext, useEffect, useRef } from 'react'

import type {
  UserTopic,
  UserTopicEvent,
  UserTopicListener
} from '../../common/gameSocket'

/** The part of `GameSocket` a user topic's reader uses. */
export interface UserTopicSocket {
  onUserChanged: (topic: UserTopic, listener: UserTopicListener) => () => void
}

const UserTopicContext = createContext<UserTopicSocket | undefined>(undefined)

/** Gives the screens below the signed-in person's socket, or none. */
export function UserTopicProvider(props: {
  socket?: UserTopicSocket
  children?: React.ReactNode
}): React.ReactElement {
  return (
    <UserTopicContext.Provider value={props.socket}>
      {props.children}
    </UserTopicContext.Provider>
  )
}

/** The signed-in person's socket, as the provider above gives it. */
export function useUserTopicSocket(): UserTopicSocket | undefined {
  return useContext(UserTopicContext)
}

/**
 * How a user topic's reader decides to read, apart from its first read: on
 * a notice, a resync, a socket that came back after a gap, an older server
 * that holds no topics (once per connection), and once in each outage while
 * the socket is down.
 */
export class UserTopicReader {
  private lastOutage: number | undefined
  constructor(private readonly read: () => void) {}

  heard(event: UserTopicEvent): void {
    switch (event.type) {
      case 'changed':
      case 'resync':
      case 'unsupported':
        this.read()
        return
      case 'subscribed':
        if (event.afterGap) this.read()
        return
      case 'unreachable':
        if (this.lastOutage === event.outage) return
        this.lastOutage = event.outage
        this.read()
    }
  }
}

/**
 * Reads `load` once now, and again as the person's `topic` says, through
 * `socket` (the provider's by default). With no socket (signed out) it reads
 * once. Reads that overlap run one after another, the later once.
 * `readNow: false` leaves the first read to the screen (`useNoticedRead`).
 */
export function useUserTopic(
  topic: UserTopic,
  load: () => Promise<void>,
  socket?: UserTopicSocket,
  options: { readNow?: boolean } = {}
): void {
  const readNow = options.readNow !== false
  const provided = useUserTopicSocket()
  const held = socket ?? provided
  const latest = useRef(load)
  latest.current = load
  useEffect(() => {
    let alive = true
    let running = false
    let again = false
    const read = (): void => {
      if (!alive) return
      if (running) {
        again = true
        return
      }
      running = true
      latest
        .current()
        .catch(() => undefined)
        .finally(() => {
          running = false
          if (again && alive) {
            again = false
            read()
          }
        })
    }
    if (readNow) read()
    if (held == null)
      return () => {
        alive = false
      }
    const reader = new UserTopicReader(read)
    let stop: (() => void) | undefined
    try {
      stop = held.onUserChanged(topic, event => {
        reader.heard(event)
      })
    } catch {
      // A platform with no socket to be had: the first read is all there is.
    }
    return () => {
      alive = false
      stop?.()
    }
  }, [topic, held, readNow])
}
