import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { COALESCE_MS } from '../common/screenScope'
import { userIdOfGumbo } from '../common/userId'
import { confirmedChatAgeHooks } from '../test/chatAgeTesting'
import { fakeSockets } from '../test/fakeScoreboardSocket'
import { find, mount, press, settle, unmount } from '../test/gameFormDom'
import { App } from './App'
import { showRoute } from './navigation/useAddressBar'
import type { StoredUser } from './platform/storedUser'
import { OFFLINE_CREATE_MESSAGE } from './sync/cachingClient'
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
})
