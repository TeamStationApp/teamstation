import React, { act } from 'react'

import { ScreenScopeValueProvider } from '../app/hooks/useScreenScope'
import { UserTopicProvider } from '../app/hooks/useUserTopic'
import type {
  ScreenScope,
  ScreenScopeListener,
  UserTopic,
  UserTopicListener
} from '../common/gameSocket'
import type { ScreenScopeSocket } from '../common/screenScope'

/**
 * A screen's notices, as a test sends them: a scope socket that acknowledges
 * every subscribe at once, the person's topics, and a clock under which no
 * notice waits out the coalescing window.
 */
export class ScreenNotices implements ScreenScopeSocket {
  private readonly scopes = new Set<ScreenScopeListener>()
  private readonly topics = new Map<UserTopic, Set<UserTopicListener>>()
  private now = 0
  readonly timers = {
    now: (): number => (this.now += 60_000)
  }

  subscribeScope(
    _scope: ScreenScope,
    listener: ScreenScopeListener
  ): () => void {
    this.scopes.add(listener)
    queueMicrotask(() => {
      if (this.scopes.has(listener)) listener({ type: 'subscribed' })
    })
    return () => {
      this.scopes.delete(listener)
    }
  }

  onUserChanged(topic: UserTopic, listener: UserTopicListener): () => void {
    let set = this.topics.get(topic)
    if (set == null) {
      set = new Set()
      this.topics.set(topic, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  /** The screen's scope says something it shows changed. */
  async changed(notice: { gameId?: string } = {}): Promise<void> {
    await act(async () => {
      for (const listener of [...this.scopes])
        listener({ type: 'changed', ...notice })
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }

  /** The person's topic says to read it again. */
  async ring(topic: UserTopic = 'badge'): Promise<void> {
    await act(async () => {
      for (const listener of [...(this.topics.get(topic) ?? [])])
        listener({ type: 'changed' })
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }

  /** Both at once, inside a test's own `act`. */
  notifyNow(): void {
    for (const listener of [...this.scopes]) listener({ type: 'changed' })
    for (const listener of [...(this.topics.get('badge') ?? [])])
      listener({ type: 'changed' })
  }

  /** Both at once: whatever the screen reads again by. */
  async notify(): Promise<void> {
    await this.changed()
    await this.ring()
  }
}

/** The scope a screen holds when a test names none: one value, so it never moves. */
const HOME: ScreenScope = { scope: 'home' }

/** Gives the screens below a scope on `notices`, and its topics. */
export function NoticesProvider(props: {
  notices: ScreenNotices
  scope?: ScreenScope
  children?: React.ReactNode
}): React.ReactElement {
  const { notices } = props
  const value = React.useMemo(
    () => ({
      socket: notices,
      scope: props.scope ?? HOME,
      timers: notices.timers
    }),
    [notices, props.scope]
  )
  return (
    <UserTopicProvider socket={notices}>
      <ScreenScopeValueProvider value={value}>
        {props.children}
      </ScreenScopeValueProvider>
    </UserTopicProvider>
  )
}
