import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React from 'react'

import { asSessionUser, TeamStationClient } from '../common/api'
import { userIdOfGumbo } from '../common/userId'
import { fakeSockets } from '../test/fakeScoreboardSocket'
import { mount, press, settle, unmount } from '../test/gameFormDom'
import { App } from './App'
import { showRoute } from './navigation/useAddressBar'
import type { StoredUser } from './platform/storedUser'
import { HOME_LIST_EXPANDED_KEY } from './screens/homeListExpanded'
import type { DocumentStore, StoredDocument } from './sync/cacheStore'

const ALEX: StoredUser = {
  id: userIdOfGumbo(18),
  displayName: 'Alex Lee',
  isAdmin: false
}

/** The phone's cache files, kept in memory, one per user id. */
function memoryCaches(): (userId: string) => Promise<DocumentStore> {
  const files = new Map<string, Map<string, StoredDocument>>()
  return async userId => {
    const file = files.get(userId) ?? new Map<string, StoredDocument>()
    files.set(userId, file)
    return {
      read: async key => file.get(key),
      atomically: async () => {
        throw new Error('This file keeps no outbox')
      },
      store: async (key, document) => {
        const held = file.get(key)
        if (held?.pending === true) return held
        const stored = { ...document, pending: false }
        file.set(key, stored)
        return stored
      },
      close: async () => undefined,
      destroy: async () => {
        files.delete(userId)
      }
    }
  }
}

function rememberOpen(): void {
  window.localStorage.setItem(
    HOME_LIST_EXPANDED_KEY,
    JSON.stringify({ teams: true, seasons: true, leagues: false })
  )
}

describe('the home list window on this device', () => {
  let originals: PropertyDescriptorMap
  const originalSocket = globalThis.WebSocket
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    const api = TeamStationClient.prototype
    originals = Object.getOwnPropertyDescriptors(api)
    globalThis.WebSocket = fakeSockets().Impl as unknown as typeof WebSocket
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: window.location
    })
    globalThis.fetch = async (url: unknown) => {
      const path = String(url)
      if (path.endsWith('/details'))
        return Response.json({
          clientName: 'Example builds',
          scopes: ['openid'],
          csrfToken: 'proof'
        })
      if (path.endsWith('/me/home'))
        return Response.json({ teams: [], seasons: [], leagues: [] })
      return Response.json({ teams: {} })
    }
    api.whoAmI = async () =>
      asSessionUser({
        id: ALEX.id,
        displayName: ALEX.displayName,
        isAdmin: false
      })
    api.myRoles = async () => ({ teams: {}, guardianOf: [] })
    api.hasNotifications = async () => false
    api.teams = async () => []
    api.home = async () => ({ teams: [], seasons: [], leagues: [] })
    api.seasons = async () => []
    api.ownGroups = async () => []
    api.follows = async () => []
    api.guardedPlayers = async () => []
    api.recentGame = async () => null
    api.liveNow = async () => []
    api.signOut = async function (this: TeamStationClient) {
      this.token = undefined
    }
    window.localStorage.removeItem(HOME_LIST_EXPANDED_KEY)
  })

  afterEach(async () => {
    await unmount()
    Object.defineProperties(TeamStationClient.prototype, originals)
    globalThis.WebSocket = originalSocket
    globalThis.fetch = originalFetch
    delete (globalThis as { location?: unknown }).location
    window.localStorage.removeItem(HOME_LIST_EXPANDED_KEY)
  })

  it('forgets the open sections on sign-out', async () => {
    showRoute({ name: 'account' }, true)
    rememberOpen()
    await mount(
      <App
        initialToken="token-one"
        initialUser={ALEX}
        documentCache={memoryCaches()}
      />
    )
    await settle(50)
    expect(window.localStorage.getItem(HOME_LIST_EXPANDED_KEY)).not.equals(null)
    await press('Sign out')
    await settle(50)
    expect(window.localStorage.getItem(HOME_LIST_EXPANDED_KEY)).equals(null)
    console.log('sign-out home.listExpanded removed')
  })

  it('forgets the open sections when switching accounts', async () => {
    showRoute({ name: 'oauthApprove', uid: 'request' }, true)
    rememberOpen()
    await mount(
      <App
        initialToken="token-one"
        initialUser={ALEX}
        documentCache={memoryCaches()}
      />
    )
    await settle(50)
    expect(window.localStorage.getItem(HOME_LIST_EXPANDED_KEY)).not.equals(null)
    await press('Use a different account')
    await settle(50)
    expect(window.location.pathname).equals('/sign-in')
    expect(window.localStorage.getItem(HOME_LIST_EXPANDED_KEY)).equals(null)
    console.log('switch-account home.listExpanded removed')
  })
})
