import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { AppState } from 'react-native'

import {
  asSessionUser,
  type SessionUser,
  TeamStationClient
} from '../common/api'
import { HttpError } from '../common/errors'
import { userIdOfGumbo } from '../common/userId'
import { fakeSockets } from '../test/fakeScoreboardSocket'
import { mount, press, settle, unmount } from '../test/gameFormDom'
import { App } from './App'
import { showRoute } from './navigation/useAddressBar'
import type { StoredUser } from './platform/storedUser'
import type { DocumentStore, StoredDocument } from './sync/cacheStore'

const ICHIRO: StoredUser = {
  id: userIdOfGumbo(51),
  displayName: 'Ichiro S',
  isAdmin: true
}

/** The phone's cache files, kept in memory, one per user id. */
function memoryCaches(): {
  open: (userId: string) => Promise<DocumentStore>
  opened: string[]
  destroyed: string[]
  files: Map<string, Map<string, StoredDocument>>
} {
  const files = new Map<string, Map<string, StoredDocument>>()
  const opened: string[] = []
  const destroyed: string[] = []
  return {
    files,
    opened,
    destroyed,
    open: async userId => {
      opened.push(userId)
      const file = files.get(userId) ?? new Map<string, StoredDocument>()
      files.set(userId, file)
      return {
        read: async key => file.get(key),
        store: async (key, document) => {
          const held = file.get(key)
          if (held?.pending === true) return held
          const stored = { ...document, pending: false }
          file.set(key, stored)
          return stored
        },
        close: async () => undefined,
        destroy: async () => {
          destroyed.push(userId)
          files.delete(userId)
        }
      }
    }
  }
}

describe('the phone session with no signal', () => {
  let originals: PropertyDescriptorMap
  const originalSocket = globalThis.WebSocket
  const originalFetch = globalThis.fetch
  const originalListen = AppState.addEventListener.bind(AppState)
  let sockets: ReturnType<typeof fakeSockets>
  let answer: () => Promise<SessionUser | null>
  let fetched: string[]
  let foreground: Array<(state: string) => void>
  let refuseReads = false
  let netDown = false

  beforeEach(() => {
    const api = TeamStationClient.prototype
    originals = Object.getOwnPropertyDescriptors(api)
    sockets = fakeSockets()
    fetched = []
    foreground = []
    globalThis.WebSocket = sockets.Impl as unknown as typeof WebSocket
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: window.location
    })
    // What the prefetch reads, which goes through `request` itself.
    refuseReads = false
    netDown = false
    globalThis.fetch = async (url: unknown) => {
      fetched.push(String(url))
      if (netDown) throw new TypeError('Load failed')
      return refuseReads
        ? new Response(
            JSON.stringify({ code: 'unauthorized', message: 'Sign in again' }),
            { status: 401 }
          )
        : new Response('[]', { status: 200 })
    }
    AppState.addEventListener = ((
      type: 'change',
      listener: (state: string) => void
    ) => {
      foreground.push(listener)
      return originalListen(type, listener)
    }) as typeof AppState.addEventListener
    answer = async () => {
      throw new HttpError('offline', 'Cannot reach TeamStation.')
    }
    api.whoAmI = async () => await answer()
    api.myRoles = async () => ({ teams: {}, guardianOf: [] })
    api.hasNotifications = async () => false
    api.teams = async () => []
    api.seasons = async () => []
    api.ownGroups = async () => []
    api.follows = async () => []
    api.guardedPlayers = async () => []
    api.recentGame = async () => null
    api.liveNow = async () => []
    api.signOut = async function (this: TeamStationClient) {
      this.token = undefined
    }
  })
  afterEach(async () => {
    await unmount()
    Object.defineProperties(TeamStationClient.prototype, originals)
    globalThis.WebSocket = originalSocket
    globalThis.fetch = originalFetch
    AppState.addEventListener = originalListen
    delete (globalThis as { location?: unknown }).location
  })

  it('keeps the token and opens on the stored user when whoAmI cannot leave the device', async () => {
    showRoute({ name: 'home' }, true)
    const caches = memoryCaches()
    const tokens: Array<string | undefined> = []
    const users: Array<StoredUser | undefined> = []
    await mount(
      <App
        initialToken="token-one"
        initialUser={ICHIRO}
        onToken={token => tokens.push(token)}
        onUser={user => users.push(user)}
        documentCache={caches.open}
      />
    )
    await settle(50)
    // Signed in as the stored user: Home holds its scope with the kept token.
    expect(sockets.latest().headers).deep.equals({
      Authorization: 'Bearer token-one'
    })
    expect(tokens, 'the token is kept').deep.equals([])
    expect(users, 'the stored user is kept').deep.equals([])
    expect(caches.opened).deep.equals([ICHIRO.id])
    expect(caches.destroyed).deep.equals([])
  })

  it('clears the token and the stored user when the server says nobody, and keeps their file', async () => {
    showRoute({ name: 'home' }, true)
    answer = async () => null
    const caches = memoryCaches()
    caches.files.set(ICHIRO.id, new Map())
    const tokens: Array<string | undefined> = []
    const users: Array<StoredUser | undefined> = []
    await mount(
      <App
        initialToken="token-one"
        initialUser={ICHIRO}
        onToken={token => tokens.push(token)}
        onUser={user => users.push(user)}
        documentCache={caches.open}
      />
    )
    await settle(50)
    expect(tokens).deep.equals([undefined])
    expect(users).deep.equals([undefined])
    // What they queued sends once they sign in again; only signing out
    // deletes it.
    expect(caches.destroyed).deep.equals([])
    expect(sockets.sockets, 'nobody is signed in').length(0)
  })

  it('leaves the web signed out when whoAmI cannot reach the server', async () => {
    showRoute({ name: 'home' }, true)
    const caches = memoryCaches()
    await mount(<App documentCache={caches.open} />)
    await settle(50)
    expect(sockets.sockets).length(0)
    expect(caches.opened).deep.equals([])
  })

  it('keeps who answered, opens their file, reads ahead after Home and on foreground, and deletes it on sign-out', async () => {
    showRoute({ name: 'account' }, true)
    answer = async () =>
      asSessionUser({
        id: ICHIRO.id,
        displayName: ICHIRO.displayName,
        isAdmin: false
      })
    const caches = memoryCaches()
    const users: Array<StoredUser | undefined> = []
    await mount(
      <App
        initialToken="token-one"
        initialUser={ICHIRO}
        onUser={user => users.push(user)}
        documentCache={caches.open}
      />
    )
    await settle(50)
    expect(users).deep.equals([{ ...ICHIRO, isAdmin: false }])
    expect(caches.opened).deep.equals([ICHIRO.id])

    const before = fetched.length
    await act(async () => {
      for (const listener of foreground) listener('active')
    })
    await settle(50)
    expect(fetched.slice(before)).includes('/api/v1/me/roles')

    await press('Sign out')
    await settle(50)
    expect(caches.destroyed).deep.equals([ICHIRO.id])
    expect(users.at(-1)).equals(undefined)
  })
  for (const [code, why] of [
    ['internal', 'a 502 while the server restarts'],
    ['unavailable', 'a 503'],
    ['rateLimited', 'a 429']
  ] as const)
    it(`keeps the session and the queued file on ${why} at launch`, async () => {
      showRoute({ name: 'home' }, true)
      answer = async () => {
        throw new HttpError(code, 'The server is busy')
      }
      const caches = memoryCaches()
      caches.files.set(ICHIRO.id, new Map())
      const tokens: Array<string | undefined> = []
      const users: Array<StoredUser | undefined> = []
      await mount(
        <App
          initialToken="token-one"
          initialUser={ICHIRO}
          onToken={token => tokens.push(token)}
          onUser={user => users.push(user)}
          documentCache={caches.open}
        />
      )
      await settle(50)
      expect(tokens, 'the token is kept').deep.equals([])
      expect(users, 'the stored user is kept').deep.equals([])
      expect(caches.opened).deep.equals([ICHIRO.id])
      expect(caches.destroyed, 'nothing queued is lost').deep.equals([])
      expect(sockets.latest().headers).deep.equals({
        Authorization: 'Bearer token-one'
      })
    })

  it('asks again once the server answers, and keeps who it says', async () => {
    showRoute({ name: 'home' }, true)
    const caches = memoryCaches()
    const users: Array<StoredUser | undefined> = []
    await mount(
      <App
        initialToken="token-one"
        initialUser={ICHIRO}
        onUser={user => users.push(user)}
        documentCache={caches.open}
      />
    )
    await settle(50)
    answer = async () =>
      asSessionUser({
        id: ICHIRO.id,
        displayName: 'Ichiro Suzuki',
        isAdmin: false
      })
    await act(async () => {
      for (const listener of foreground) listener('active')
    })
    await settle(50)
    expect(users).deep.equals([
      { id: ICHIRO.id, displayName: 'Ichiro Suzuki', isAdmin: false }
    ])
    // Settled: the next foreground does not ask again.
    let asked = 0
    answer = async () => {
      asked++
      return null
    }
    await act(async () => {
      for (const listener of foreground) listener('active')
    })
    await settle(50)
    expect(asked).equals(0)
  })

  it('sends a restored session refused once the server answers to sign in, keeping its file', async () => {
    showRoute({ name: 'home' }, true)
    const caches = memoryCaches()
    const tokens: Array<string | undefined> = []
    const users: Array<StoredUser | undefined> = []
    await mount(
      <App
        initialToken="token-one"
        initialUser={ICHIRO}
        onToken={token => tokens.push(token)}
        onUser={user => users.push(user)}
        documentCache={caches.open}
      />
    )
    await settle(50)
    answer = async () => null
    await act(async () => {
      for (const listener of foreground) listener('active')
    })
    await settle(50)
    expect(tokens).deep.equals([undefined])
    expect(users).deep.equals([undefined])
    expect(caches.destroyed, 'the queue waits for the same person').deep.equals(
      []
    )
    expect(document.querySelector('[aria-label="E-mail address"]')).not.equals(
      null
    )
  })

  it('sends a session the server refuses mid-use to sign in, keeping its file', async () => {
    showRoute({ name: 'home' }, true)
    answer = async () =>
      asSessionUser({
        id: ICHIRO.id,
        displayName: ICHIRO.displayName,
        isAdmin: true
      })
    const caches = memoryCaches()
    const tokens: Array<string | undefined> = []
    await mount(
      <App
        initialToken="token-one"
        initialUser={ICHIRO}
        onToken={token => tokens.push(token)}
        documentCache={caches.open}
      />
    )
    await settle(50)
    expect(tokens).deep.equals([])
    // The next read is answered 401.
    refuseReads = true
    await act(async () => {
      for (const listener of foreground) listener('active')
    })
    await settle(50)
    expect(tokens).deep.equals([undefined])
    expect(caches.destroyed).deep.equals([])
    expect(document.querySelector('[aria-label="E-mail address"]')).not.equals(
      null
    )
  })
  it('reads ahead once after Home, not on every notice Home reads again for, and again when the server answers after no signal', async () => {
    showRoute({ name: 'home' }, true)
    answer = async () =>
      asSessionUser({
        id: ICHIRO.id,
        displayName: ICHIRO.displayName,
        isAdmin: true
      })
    let teamReads = 0
    TeamStationClient.prototype.teams = async () => {
      teamReads++
      return []
    }
    await mount(
      <App
        initialToken="token-one"
        initialUser={ICHIRO}
        documentCache={memoryCaches().open}
      />
    )
    await settle(50)
    const ahead = (): number =>
      fetched.filter(url => url.endsWith('/me/roles')).length
    // Home's scope is acknowledged, its lists read, and the phone reads ahead.
    const socket = sockets.latest()
    await act(async () => {
      socket.open()
    })
    const asked = socket
      .messages()
      .find(
        (frame): frame is { id: string } =>
          (frame as { scope?: string }).scope === 'home'
      )!
    await act(async () => {
      socket.receive({
        type: 'subscribed',
        scope: 'home',
        id: asked.id,
        revision: '1'
      })
    })
    await settle(50)
    const reads = teamReads
    expect(ahead(), 'once, after Home').equals(1)
    // Somebody scores: a team's notice reads Home's lists again, and not
    // everything ahead.
    for (const revision of ['2', '3']) {
      await act(async () => {
        socket.receive({ type: 'changed', scope: 'home', revision })
      })
      await settle(50)
    }
    expect(teamReads).greaterThan(reads)
    expect(ahead()).equals(1)
    // No signal, then the server answers again: it reads ahead once more.
    netDown = true
    await act(async () => {
      for (const listener of foreground) listener('active')
    })
    await settle(50)
    const before = ahead()
    netDown = false
    await act(async () => {
      document
        .querySelector<HTMLElement>('[role="tab"][aria-label="Schedule"]')!
        .click()
    })
    await settle(100)
    expect(ahead()).greaterThan(before)
  })
})
