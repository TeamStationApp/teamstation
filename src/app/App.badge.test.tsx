import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { AppState } from 'react-native'

import { userIdOfGumbo } from '../common/userId'
import { confirmedChatAgeHooks } from '../test/chatAgeTesting'
import { type FakeSocket, fakeSockets } from '../test/fakeScoreboardSocket'
import { mount, settle, unmount } from '../test/gameFormDom'
import { App } from './App'
import { showRoute } from './navigation/useAddressBar'
import type { StoredUser } from './platform/storedUser'

const BETTS: StoredUser = {
  id: userIdOfGumbo(50),
  displayName: 'Mookie B',
  isAdmin: false
}

/** The topic frames the app sent on one socket. */
function topicFrames(socket: FakeSocket): Array<Record<string, unknown>> {
  return (socket.messages() as Array<Record<string, unknown>>).filter(
    frame => 'topic' in frame
  )
}

/**
 * The bell reads when the person's `badge` topic says so, and never on a
 * timer or a return to the foreground; a slow answer to it says nothing
 * about the rest of the app being offline.
 */
describe('the bell on the person’s socket', () => {
  confirmedChatAgeHooks()
  const originalSocket = globalThis.WebSocket
  const originalFetch = globalThis.fetch
  let sockets: ReturnType<typeof fakeSockets>
  let summaries = 0
  let unreachableBell = false
  let pending = false

  beforeEach(() => {
    summaries = 0
    unreachableBell = false
    pending = false
    sockets = fakeSockets()
    globalThis.WebSocket = sockets.Impl as unknown as typeof WebSocket
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: window.location
    })
    globalThis.fetch = async (url: unknown) => {
      const path = String(url)
      if (path.endsWith('/me/notifications/summary')) {
        summaries++
        if (unreachableBell) throw new TypeError('Failed to fetch')
        return new Response(JSON.stringify({ hasPending: pending }), {
          status: 200
        })
      }
      if (path.endsWith('/me/home'))
        return new Response(
          JSON.stringify({ teams: [], seasons: [], leagues: [] }),
          { status: 200 }
        )
      if (path.endsWith('/auth/me'))
        return new Response(JSON.stringify(BETTS), { status: 200 })
      return new Response('[]', { status: 200 })
    }
  })
  afterEach(async () => {
    await unmount()
    globalThis.WebSocket = originalSocket
    globalThis.fetch = originalFetch
    delete (globalThis as { location?: unknown }).location
  })

  it('subscribes the badge topic, reads on its notice and after a gap, and never on a timer or the foreground', async function () {
    this.timeout(30_000)
    const listen = AppState.addEventListener.bind(AppState)
    const changes: Array<(state: string) => void> = []
    AppState.addEventListener = ((
      type: 'change',
      listener: (state: string) => void
    ) => {
      changes.push(listener)
      return listen(type, listener)
    }) as typeof AppState.addEventListener
    try {
      showRoute({ name: 'home' }, true)
      await mount(<App initialToken="token-one" initialUser={BETTS} />)
      await settle(200)
      expect(summaries, 'one read at start').equals(1)
      const socket = sockets.latest()
      await act(async () => {
        socket.open()
      })
      const asked = topicFrames(socket).find(
        frame => frame.type === 'subscribe' && frame.topic === 'badge'
      )
      expect(asked, 'the badge topic').not.equals(undefined)
      await act(async () => {
        socket.receive({ type: 'subscribed', topic: 'badge', id: asked!.id })
      })
      await settle(50)
      expect(summaries, 'a first subscribe reads nothing more').equals(1)
      // The foreground reads nothing.
      await act(async () => {
        for (const change of changes) change('background')
      })
      await act(async () => {
        for (const change of changes) change('active')
      })
      await settle(50)
      expect(summaries).equals(1)
      // A notice reads once.
      pending = true
      await act(async () => {
        socket.receive({ type: 'userChanged', topic: 'badge' })
      })
      await settle(50)
      expect(summaries).equals(2)
      expect(
        document.querySelector('[data-testid="notification-pending-dot"]'),
        'the dot'
      ).not.equals(null)
      // Another topic's notice reads nothing of the bell.
      await act(async () => {
        socket.receive({ type: 'userChanged', topic: 'tess' })
      })
      await settle(50)
      expect(summaries).equals(2)
    } finally {
      AppState.addEventListener = listen
    }
  })

  it('leaves the app online when the bell’s read cannot leave the device', async function () {
    this.timeout(30_000)
    unreachableBell = true
    showRoute({ name: 'home' }, true)
    await mount(<App initialToken="token-one" initialUser={BETTS} />)
    await settle(200)
    expect(summaries).equals(1)
    expect(
      document.querySelector('[data-testid="offlineBannerText"]'),
      'the bell says nothing about the rest of the app'
    ).equals(null)
  })
})
