import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { asSessionUser, TeamStationClient } from '../common/api'
import { userIdOfGumbo } from '../common/userId'
import { fakeSockets } from '../test/fakeScoreboardSocket'
import { fill, find, mount, press, settle, unmount } from '../test/gameFormDom'
import legacyChatRecord from '../test/legacyChatKeyRecord.json'
import { nodeSqliteExecutor } from '../test/nodeSqliteExecutor'
import { App } from './App'
import { recordFromJson } from './chat/keyRecord'
import { keyStore } from './chat/keyStore'
import { showRoute } from './navigation/useAddressBar'
import type { StoredUser } from './platform/storedUser'
import {
  cacheFileName,
  type DocumentStore,
  openCacheStore
} from './sync/cacheStore'
import { CachingClient, OFFLINE_CREATE_MESSAGE } from './sync/cachingClient'
import { OFFLINE_BANNER } from './sync/useOffline'

const BETTS: StoredUser = {
  id: userIdOfGumbo(50),
  displayName: 'Mookie B',
  isAdmin: false
}

/** The entry the server makes for the player queued offline. */
const madePlayer = {
  userId: userIdOfGumbo(77),
  gumboId: 77,
  shortName: 'Jackie R',
  nameDetails: {
    firstName: 'Jackie',
    lastName: 'Robinson',
    displayName: 'Jackie Robinson'
  },
  jersey: '42',
  positions: [],
  isPlayer: true,
  role: 'member',
  section: 'player',
  staffRoles: [],
  inheritedFrom: null
}

const banner = (): HTMLElement | null =>
  document.querySelector('[data-testid="offlineBanner"]')
const bannerText = (): string | undefined =>
  document.querySelector('[data-testid="offlineBannerText"]')?.textContent ??
  undefined
const refusal = (): string | undefined =>
  document.querySelector('[data-testid="offlineCreateMessage"]')?.textContent ??
  undefined

describe('the phone shell offline', () => {
  const originalSocket = globalThis.WebSocket
  const originalFetch = globalThis.fetch
  let dir: string
  let net: {
    offline: boolean
    posts: string[]
    refuseSession?: boolean
    refusePlayers?: boolean
    /** Each POST's path and the token it went with. */
    sentWith?: string[]
  }

  const openCache = async (userId: string): Promise<DocumentStore> =>
    await openCacheStore(nodeSqliteExecutor(join(dir, cacheFileName(userId))))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'teamstation-banner-'))
    net = { offline: false, posts: [] }
    globalThis.WebSocket = fakeSockets().Impl as unknown as typeof WebSocket
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: window.location
    })
    // Every list reads as empty, a new player is made, and with no signal
    // nothing leaves the device.
    globalThis.fetch = async (url: unknown, init?: RequestInit) => {
      if (net.offline) throw new TypeError('Load failed')
      const path = String(url)
      if (net.refuseSession === true)
        return new Response(
          JSON.stringify({ code: 'unauthorized', message: 'Sign in again' }),
          { status: 401 }
        )
      if (init?.method === 'POST' && net.refusePlayers === true)
        return new Response(
          JSON.stringify({
            code: 'forbidden',
            message: 'Only the team’s staff'
          }),
          { status: 403 }
        )
      if (init?.method === 'POST') {
        net.posts.push(path)
        net.sentWith?.push(
          `${path} ${String((init.headers as Record<string, string> | undefined)?.authorization)}`
        )
        return new Response(JSON.stringify(madePlayer), { status: 201 })
      }
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
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * What an earlier launch left: Home's lists, read online, and one roster
   * player added with no signal, still queued.
   */
  async function earlierLaunch(): Promise<void> {
    const client = new CachingClient({
      baseUrl: '/api/v1',
      token: 'token-one',
      openCache,
      outbox: { setTimer: () => 0, clearTimer: () => undefined }
    })
    client.openFor(BETTS.id)
    await Promise.all([
      client.teams(),
      client.seasons(),
      client.ownGroups(),
      client.follows(),
      client.guardedPlayers(),
      client.recentGame()
    ])
    net.offline = true
    await client.createRosterPlayer('tem_hawks', {
      firstName: 'Jackie',
      lastName: 'Robinson',
      jersey: '42',
      positions: [],
      bats: 'right',
      throws: 'right'
    })
    await client.drainOutbox()
    expect((await client.outboxSummary()).count).equals(1)
  }

  it('says it is offline with what waits, keeps Create Team shut, and clears once the queue is sent', async () => {
    await earlierLaunch()
    showRoute({ name: 'home' }, true)
    await mount(
      <App
        initialToken="token-one"
        initialUser={BETTS}
        documentCache={openCache}
      />
    )
    await settle(100)

    expect(banner(), 'the banner is up').not.equals(null)
    expect(bannerText()).equals(`${OFFLINE_BANNER} · 1 edit waiting`)
    expect(refusal()).equals(undefined)

    // Home is painted from the phone, and its create does not open.
    await press('Create Team')
    await settle(50)
    expect(refusal()).equals(OFFLINE_CREATE_MESSAGE)
    expect(
      document.querySelector('[aria-label="Team name"]'),
      'no form'
    ).equals(null)
    expect(find('Create Team'), 'still on Home').not.equals(undefined)
    for (const label of ['Create Season', 'Create League']) {
      await press(label)
      expect(find(label), label).not.equals(undefined)
    }
    expect(refusal()).equals(OFFLINE_CREATE_MESSAGE)

    // The server answers again: the next read succeeds, the queue goes.
    net.offline = false
    await act(async () => {
      document
        .querySelector<HTMLElement>('[role="tab"][aria-label="Schedule"]')!
        .click()
    })
    await settle(200)
    expect(net.posts).deep.equals(['/api/v1/teams/tem_hawks/roster-players'])
    expect(banner(), 'nothing to say').equals(null)
  })

  it('shows no banner on the web, which keeps no queue', async () => {
    net.offline = true
    showRoute({ name: 'home' }, true)
    await mount(<App initialToken="token-one" />)
    await settle(100)
    expect(banner()).equals(null)
  })
  it('keeps what was queued through a launch the server refuses, and sends it once the same person signs in', async () => {
    await earlierLaunch()
    // The session ran out while the phone was away.
    net.offline = false
    net.refuseSession = true
    const signIns: string[] = []
    const prototype = TeamStationClient.prototype
    const original = Object.getOwnPropertyDescriptor(
      prototype,
      'signInWithPassword'
    )!
    prototype.signInWithPassword = async function (
      this: TeamStationClient,
      email: string
    ) {
      signIns.push(email)
      net.refuseSession = false
      this.token = 'token-two'
      return { token: 'token-two', expiresAt: '', user: asSessionUser(BETTS) }
    }
    const tokens: Array<string | undefined> = []
    try {
      showRoute({ name: 'home' }, true)
      await mount(
        <App
          initialToken="token-one"
          initialUser={BETTS}
          onToken={token => tokens.push(token)}
          documentCache={openCache}
        />
      )
      await settle(100)
      expect(tokens).deep.equals([undefined])
      expect(net.posts, 'nothing sent on a dead token').deep.equals([])
      await press('Use a password instead')
      await fill('E-mail address', 'mookie@example.test')
      await fill('Password', 'not-a-real-password')
      await press('Sign in')
      await settle(200)
      expect(signIns).deep.equals(['mookie@example.test'])
      expect(net.posts).deep.equals(['/api/v1/teams/tem_hawks/roster-players'])
    } finally {
      Object.defineProperty(prototype, 'signInWithPassword', original)
    }
  })

  it('offers a way out of a player the server refused, from the banner', async () => {
    await earlierLaunch()
    net.offline = false
    net.refusePlayers = true
    showRoute({ name: 'home' }, true)
    await mount(
      <App
        initialToken="token-one"
        initialUser={BETTS}
        documentCache={openCache}
      />
    )
    await settle(150)
    const line = (): HTMLElement | null =>
      document.querySelector('[data-testid="heldTeamMessage"]')
    expect(line()?.textContent).equals(
      'A player added on this phone was not saved: Only the team’s staff'
    )
    // Opening the choice and cancelling it changes nothing.
    await act(async () => {
      line()!.click()
    })
    expect(find('Try Again')).not.equals(undefined)
    await press('Cancel')
    expect(line()).not.equals(null)
    await act(async () => {
      line()!.click()
    })
    await press("Use Server's Copy")
    await settle(150)
    expect(line()).equals(null)
    expect(banner(), 'nothing left to say').equals(null)
  })
  /** How many writes the person's file still holds, read beside the app. */
  function queuedOnDisk(): number | undefined {
    const file = join(dir, cacheFileName(BETTS.id))
    if (!existsSync(file)) return undefined
    const reader = nodeSqliteExecutor(file)
    try {
      return (
        reader.db.prepare('SELECT count(*) AS n FROM outbox').get() as {
          n: number
        }
      ).n
    } finally {
      reader.db.close()
    }
  }

  it('keeps the file when the scoreboard socket refuses the session (4401), and goes to sign in', async () => {
    await earlierLaunch()
    const sockets = fakeSockets()
    globalThis.WebSocket = sockets.Impl as unknown as typeof WebSocket
    const tokens: Array<string | undefined> = []
    showRoute({ name: 'scoreboardOverride', gameId: 'g1' }, true)
    await mount(
      <App
        initialToken="token-one"
        initialUser={BETTS}
        onToken={token => tokens.push(token)}
        documentCache={openCache}
      />
    )
    await settle(100)
    const board = sockets.sockets.find(socket =>
      socket.url.includes('dashboard')
    )
    expect(board, 'the board’s socket').not.equals(undefined)
    await act(async () => {
      board!.drop(4401)
    })
    await settle(100)
    expect(tokens).deep.equals([undefined])
    expect(document.querySelector('[aria-label="E-mail address"]')).not.equals(
      null
    )
    expect(queuedOnDisk(), 'the queue is kept').equals(1)
  })

  it('asks before Sign Out loses what is queued: Cancel keeps it, Sign Out deletes it', async () => {
    await earlierLaunch()
    const trace: string[] = []
    const saved = JSON.stringify(legacyChatRecord)
    let held: string | undefined = saved
    let finishRevocation!: () => void
    const revoking = new Promise<void>(resolve => {
      finishRevocation = resolve
    })
    const original = {
      exists: keyStore.exists,
      load: keyStore.load,
      wipe: keyStore.wipe
    }
    const originalRevoke = Object.getOwnPropertyDescriptor(
      TeamStationClient.prototype,
      'revokeChatDevice'
    )!
    keyStore.exists = async () => {
      trace.push('exists')
      return held != null
    }
    keyStore.load = async () => {
      trace.push('load')
      return held == null ? undefined : recordFromJson(held)
    }
    keyStore.wipe = async () => {
      trace.push('wipe')
      held = undefined
    }
    TeamStationClient.prototype.revokeChatDevice = async () => {
      trace.push('revoke')
      await revoking
      throw new TypeError('Load failed')
    }
    try {
      showRoute({ name: 'account' }, true)
      await mount(
        <App
          initialToken="token-one"
          initialUser={BETTS}
          documentCache={openCache}
          onToken={token => {
            if (token == null) trace.push('session cleared')
          }}
        />
      )
      await settle(100)
      const startupReads = trace.slice()
      await press('Sign out')
      expect(document.body.textContent).includes(
        '1 change on this phone has not been sent and will be lost.'
      )
      await press('Cancel')
      await settle(50)
      expect(queuedOnDisk()).equals(1)
      expect(held, 'all saved chat key bytes survive cancellation').equals(
        saved
      )
      expect(
        trace,
        'cancellation leaves the approval controller’s initial key reads unchanged'
      ).deep.equals(startupReads)
      trace.length = 0
      expect(find('Sign out'), 'still signed in').not.equals(undefined)
      await press('Sign out')
      await press('Sign Out')
      await settle(50)
      expect(trace).deep.equals(['exists', 'load', 'revoke'])
      expect(held).equals(saved)
      expect(queuedOnDisk()).equals(1)
      finishRevocation()
      await settle(100)
      expect(queuedOnDisk(), 'the file is gone').equals(undefined)
      expect(held).equals(undefined)
      expect(trace).deep.equals([
        'exists',
        'load',
        'revoke',
        'wipe',
        'session cleared'
      ])
    } finally {
      finishRevocation()
      Object.assign(keyStore, original)
      Object.defineProperty(
        TeamStationClient.prototype,
        'revokeChatDevice',
        originalRevoke
      )
    }
  })
  it('sends nothing of a refused person’s queue under the next person’s token, and sends it once they are back', async () => {
    await earlierLaunch()
    net.sentWith = []
    const PETE: StoredUser = {
      id: userIdOfGumbo(60),
      displayName: 'Pete A',
      isAdmin: false
    }
    let next: { user: StoredUser; token: string } = {
      user: PETE,
      token: 'token-two'
    }
    const prototype = TeamStationClient.prototype
    const original = Object.getOwnPropertyDescriptor(
      prototype,
      'signInWithPassword'
    )!
    prototype.signInWithPassword = async function (this: TeamStationClient) {
      // The sign-in's own request, which wakes the queue, then its token.
      net.refuseSession = false
      await (
        this as unknown as {
          request: (
            m: string,
            p: string,
            c: (raw: unknown) => unknown
          ) => Promise<unknown>
        }
      ).request('POST', '/auth/password', raw => raw)
      this.token = next.token
      // A drain that the sign-in's request woke, reaching the queue before
      // the shell opens the new person's file.
      await (this as unknown as CachingClient).drainOutbox()
      return {
        token: next.token,
        expiresAt: '',
        user: asSessionUser(next.user)
      }
    }
    const signIn = async (): Promise<void> => {
      await press('Use a password instead')
      await fill('E-mail address', 'someone@example.test')
      await fill('Password', 'not-a-real-password')
      await press('Sign in')
      await settle(200)
    }
    try {
      showRoute({ name: 'home' }, true)
      await mount(
        <App
          initialToken="token-one"
          initialUser={BETTS}
          documentCache={openCache}
        />
      )
      await settle(100)
      // Signal back, and the session refused: back to sign in.
      net.offline = false
      net.refuseSession = true
      await act(async () => {
        document
          .querySelector<HTMLElement>('[role="tab"][aria-label="Schedule"]')!
          .click()
      })
      await settle(150)
      expect(
        document.querySelector('[aria-label="E-mail address"]')
      ).not.equals(null)
      // Somebody else signs in on the phone.
      await signIn()
      const players = (): string[] =>
        net.sentWith!.filter(line => line.includes('/roster-players'))
      expect(players(), 'nothing of the first person’s').deep.equals([])
      // They sign out; the first person signs in again: theirs goes, once.
      await press('Account, Pete A')
      await press('Sign out')
      await settle(100)
      next = { user: BETTS, token: 'token-three' }
      await signIn()
      expect(players()).deep.equals([
        '/api/v1/teams/tem_hawks/roster-players Bearer token-three'
      ])
    } finally {
      Object.defineProperty(prototype, 'signInWithPassword', original)
    }
  })
})
