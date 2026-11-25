import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type {
  UserTopic,
  UserTopicEvent,
  UserTopicListener
} from '../../common/gameSocket'
import { UserTopicReader, useUserTopic } from './useUserTopic'

/** A socket the test tells what its topics hear. */
class FakeTopics {
  listeners = new Map<UserTopic, Set<UserTopicListener>>()
  onUserChanged(topic: UserTopic, listener: UserTopicListener): () => void {
    let set = this.listeners.get(topic)
    if (set == null) {
      set = new Set()
      this.listeners.set(topic, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  async tell(topic: UserTopic, event: UserTopicEvent): Promise<void> {
    await act(async () => {
      for (const listener of [...(this.listeners.get(topic) ?? [])])
        listener(event)
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

describe('a user topic’s reader', () => {
  it('reads on a notice, a resync, an older server and a gap, and once in each outage', () => {
    let reads = 0
    const reader = new UserTopicReader(() => {
      reads++
    })
    reader.heard({ type: 'subscribed', afterGap: false })
    expect(reads, 'the first read is the screen’s').equals(0)
    reader.heard({ type: 'changed' })
    reader.heard({ type: 'resync' })
    reader.heard({ type: 'unsupported' })
    expect(reads).equals(3)
    reader.heard({ type: 'unreachable', outage: 1 })
    reader.heard({ type: 'unreachable', outage: 1 })
    expect(reads, 'once for outage 1').equals(4)
    reader.heard({ type: 'subscribed', afterGap: true })
    expect(reads, 'back after a gap').equals(5)
    reader.heard({ type: 'unreachable', outage: 2 })
    expect(reads).equals(6)
  })
})

describe('useUserTopic', () => {
  let root: Root | undefined
  beforeEach(() => {
    root = createRoot(document.createElement('div'))
  })
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })
  function Probe(props: {
    load: () => Promise<void>
    socket?: FakeTopics
    readNow?: boolean
  }): null {
    useUserTopic('badge', props.load, props.socket, { readNow: props.readNow })
    return null
  }

  it('reads now and on each notice, one read at a time, and stops hearing once gone', async () => {
    const socket = new FakeTopics()
    let reads = 0
    let release: (() => void) | undefined
    const load = async (): Promise<void> => {
      reads++
      await new Promise<void>(resolve => {
        release = resolve
      })
    }
    await act(async () => {
      root!.render(<Probe load={load} socket={socket} />)
    })
    expect(reads).equals(1)
    // Two notices while the read runs make one more read once it ends.
    await socket.tell('badge', { type: 'changed' })
    await socket.tell('badge', { type: 'changed' })
    await socket.tell('tess', { type: 'changed' })
    expect(reads).equals(1)
    await act(async () => {
      release?.()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(reads).equals(2)
    await act(async () => {
      release?.()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(reads).equals(2)
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    expect(socket.listeners.get('badge')?.size).equals(0)
  })

  it('reads once with no socket, and leaves the first read to the screen when asked', async () => {
    let reads = 0
    const load = async (): Promise<void> => {
      reads++
    }
    await act(async () => {
      root!.render(<Probe load={load} />)
    })
    expect(reads).equals(1)
    const socket = new FakeTopics()
    let later = 0
    await act(async () => {
      root!.render(
        <Probe
          load={async () => {
            later++
          }}
          socket={socket}
          readNow={false}
        />
      )
    })
    expect(later).equals(0)
    await socket.tell('badge', { type: 'changed' })
    expect(later).equals(1)
  })
})
