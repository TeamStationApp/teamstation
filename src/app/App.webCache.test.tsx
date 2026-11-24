import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { AppState } from 'react-native'

import { COALESCE_MS } from '../common/screenScope'
import { userIdOfGumbo } from '../common/userId'
import { confirmedChatAgeHooks } from '../test/chatAgeTesting'
import { fakeSockets } from '../test/fakeScoreboardSocket'
import { find, mount, press, settle, unmount } from '../test/gameFormDom'
import { App } from './App'
import { showRoute } from './navigation/useAddressBar'
import type { StoredUser } from './platform/storedUser'
import { CachingClient, OFFLINE_CREATE_MESSAGE } from './sync/cachingClient'
import { OFFLINE_BANNER } from './sync/useOffline'

const BETTS: StoredUser = {
  id: userIdOfGumbo(50),
  displayName: 'Mookie B',
  isAdmin: false
}

const bannerText = (): string | undefined =>
  document.querySelector('[data-testid="offlineBannerText"]')?.textContent ??
  undefined
const refusal = (): string | undefined =>
  document.querySelector('[data-testid="offlineCreateMessage"]')?.textContent ??
  undefined

async function tab(label: string): Promise<void> {
  await act(async () => {
    document
      .querySelector<HTMLElement>(`[role="tab"][aria-label="${label}"]`)!
      .click()
  })
}

/**
 * The web's App, given no document cache: it runs the phone's queued client
 * on `./sync/cache`'s in-memory store, so it says it is offline as the phone
 * does.
 */
describe('the web shell on its in-memory cache', () => {
  confirmedChatAgeHooks()
  const originalSocket = globalThis.WebSocket
  const originalFetch = globalThis.fetch
  let offline = false
  let reads: string[] = []

  beforeEach(() => {
    offline = false
    reads = []
    globalThis.WebSocket = fakeSockets().Impl as unknown as typeof WebSocket
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: window.location
    })
    globalThis.fetch = async (url: unknown) => {
      if (offline) throw new TypeError('Failed to fetch')
      const path = String(url)
      reads.push(path)
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

  it('says it is offline once a request cannot leave, keeps a create shut, and clears once a read succeeds', async function () {
    this.timeout(30_000)
    showRoute({ name: 'home' }, true)
    await mount(<App initialToken="token-one" initialUser={BETTS} />)
    // Home's reads wait out the screen scope's coalescing window.
    await settle(COALESCE_MS + 200)
    expect(bannerText(), 'online, nothing waits').equals(undefined)
    expect(reads, 'Home read').includes('/api/v1/me/home')

    // A read with no signal: the client is offline, as the phone's is.
    offline = true
    await tab('Schedule')
    await settle(COALESCE_MS + 200)
    expect(bannerText()).equals(OFFLINE_BANNER)
    await tab('Home')
    await settle(200)
    await press('Create Team')
    await settle(100)
    expect(refusal()).equals(OFFLINE_CREATE_MESSAGE)
    expect(
      document.querySelector('[aria-label="Team name"]'),
      'no form'
    ).equals(null)
    expect(find('Create Team'), 'still on Home').not.equals(undefined)

    // The next read that succeeds clears it.
    offline = false
    await tab('Schedule')
    await settle(COALESCE_MS + 200)
    expect(bannerText(), 'back online').equals(undefined)
  })

  it('keeps the queue sending while the tab is hidden', async function () {
    const listen = AppState.addEventListener.bind(AppState)
    const setActive = Object.getOwnPropertyDescriptor(
      CachingClient.prototype,
      'setActive'
    )!
    const changes: Array<(state: string) => void> = []
    const active: boolean[] = []
    AppState.addEventListener = ((
      type: 'change',
      listener: (state: string) => void
    ) => {
      changes.push(listener)
      return listen(type, listener)
    }) as typeof AppState.addEventListener
    CachingClient.prototype.setActive = function (next: boolean) {
      active.push(next)
    }
    try {
      showRoute({ name: 'home' }, true)
      await mount(<App initialToken="token-one" initialUser={BETTS} />)
      await settle(COALESCE_MS + 200)
      expect(changes, 'App listens for the tab hiding').not.deep.equals([])
      await act(async () => {
        for (const change of changes) change('background')
      })
      await act(async () => {
        for (const change of changes) change('active')
      })
      expect(active).not.deep.equals([])
      expect(active.every(value => value)).equals(true)
    } finally {
      AppState.addEventListener = listen
      Object.defineProperty(CachingClient.prototype, 'setActive', setActive)
    }
  })

  it('reads nothing ahead and keeps no games to score, and on a return to the tab or once a read succeeds again only sends what is queued', async function () {
    this.timeout(30_000)
    const listen = AppState.addEventListener.bind(AppState)
    const wakeOutbox = Object.getOwnPropertyDescriptor(
      CachingClient.prototype,
      'wakeOutbox'
    )!
    const startSet = Object.getOwnPropertyDescriptor(
      CachingClient.prototype,
      'startOfflineSet'
    )!
    let started = 0
    const changes: Array<(state: string) => void> = []
    const woken: boolean[] = []
    AppState.addEventListener = ((
      type: 'change',
      listener: (state: string) => void
    ) => {
      changes.push(listener)
      return listen(type, listener)
    }) as typeof AppState.addEventListener
    CachingClient.prototype.startOfflineSet = function () {
      started++
      return startSet.value.call(this, ...arguments)
    }
    CachingClient.prototype.wakeOutbox = function (reachable = false) {
      woken.push(reachable)
    }
    try {
      showRoute({ name: 'home' }, true)
      await mount(<App initialToken="token-one" initialUser={BETTS} />)
      await settle(COALESCE_MS + 200)
      expect(reads, 'Home read').includes('/api/v1/me/home')
      expect(woken, 'nothing after Home').deep.equals([])
      await act(async () => {
        for (const change of changes) change('background')
      })
      await act(async () => {
        for (const change of changes) change('active')
      })
      expect(woken, 'on a return').deep.equals([true])
      offline = true
      await tab('Schedule')
      await settle(COALESCE_MS + 200)
      expect(bannerText()).equals(OFFLINE_BANNER)
      offline = false
      await tab('Home')
      await settle(COALESCE_MS + 200)
      expect(bannerText(), 'back online').equals(undefined)
      expect(woken.length, 'once a read succeeds again').greaterThan(1)
      expect(started, 'a tab keeps no games to score offline').equals(0)
      // The list of games a prefetch stores for scoring.
      expect(
        reads.filter(path => path.includes('lookbackHours')),
        'no prefetch read'
      ).deep.equals([])
    } finally {
      AppState.addEventListener = listen
      Object.defineProperty(CachingClient.prototype, 'wakeOutbox', wakeOutbox)
      Object.defineProperty(
        CachingClient.prototype,
        'startOfflineSet',
        startSet
      )
    }
  })
})
