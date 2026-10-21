import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { asSessionUser, TeamStationClient } from '../common/api'
import { userIdOfGumbo } from '../common/userId'
import { type FakeSocket, fakeSockets } from '../test/fakeScoreboardSocket'
import { mount, settle, unmount } from '../test/gameFormDom'
import { App, screenScopeOf } from './App'
import { showRoute } from './navigation/useAddressBar'
import { gameFixture } from './scoring/isUnscoredGame.test'

/** The screen-scope frames the app sent on one socket. */
function scopeFrames(socket: FakeSocket): Array<Record<string, unknown>> {
  return (socket.messages() as Array<Record<string, unknown>>).filter(
    frame => 'scope' in frame
  )
}

/** The server registers the scope the app asked for last. */
function acknowledge(socket: FakeSocket, revision: string): void {
  const asked = scopeFrames(socket).filter(frame => frame.type === 'subscribe')
  const last = asked.at(-1)
  if (last == null) throw new Error('no scope was asked for')
  socket.receive({
    type: 'subscribed',
    scope: last.scope,
    id: last.id,
    revision
  })
}

describe('the scope the visible route holds', () => {
  let originals: PropertyDescriptorMap
  const originalSocket = globalThis.WebSocket
  const originalFetch = globalThis.fetch
  let sockets: ReturnType<typeof fakeSockets>
  let reads: string[]

  beforeEach(() => {
    const api = TeamStationClient.prototype
    originals = Object.getOwnPropertyDescriptors(api)
    sockets = fakeSockets()
    reads = []
    globalThis.WebSocket = sockets.Impl as unknown as typeof WebSocket
    // The page the socket's address is found from, as a browser has one.
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: window.location
    })
    api.whoAmI = async () =>
      asSessionUser({
        id: userIdOfGumbo(101),
        displayName: 'Babe Ruth',
        isAdmin: false
      })
    api.myRoles = async () => ({ teams: {}, guardianOf: [] })
    api.hasNotifications = async () => false
    api.teams = async () => {
      reads.push('teams')
      return []
    }
    api.seasons = async () => []
    api.ownGroups = async () => []
    api.follows = async () => []
    api.guardedPlayers = async () => []
    api.recentGame = async () => null
    api.liveNow = async () => []
    api.games = async () => {
      reads.push('games')
      return []
    }
    api.game = async () => {
      reads.push('game')
      return { ...gameFixture, canScore: false, videos: [] }
    }
    api.highlights = async () => ({
      withheld: null,
      droppedCount: 0,
      highlights: []
    })
    api.gameScheduling = async () => {
      throw new Error('not a scheduler')
    }
  })
  afterEach(async () => {
    await unmount()
    Object.defineProperties(TeamStationClient.prototype, originals)
    globalThis.WebSocket = originalSocket
    globalThis.fetch = originalFetch
    delete (globalThis as { location?: unknown }).location
  })

  const tab = async (label: string): Promise<void> => {
    const node = [
      ...document.querySelectorAll<HTMLElement>('[role="tab"]')
    ].find(button => button.getAttribute('aria-label') === label)
    expect(node, label).not.equals(undefined)
    await act(async () => {
      node!.click()
    })
    await settle(50)
  }

  it('holds home, then schedule, then nothing on Videos, reading each after its ack', async () => {
    showRoute({ name: 'home' }, true)
    await mount(<App initialToken="token-one" />)
    const socket = sockets.latest()
    expect(socket.headers).deep.equals({ Authorization: 'Bearer token-one' })
    await act(async () => {
      socket.open()
    })
    await settle(50)
    expect(scopeFrames(socket)).deep.equals([
      { type: 'subscribe', scope: 'home', id: 'c1' }
    ])
    expect(reads, 'Home reads nothing before the ack').deep.equals([])
    await act(async () => {
      acknowledge(socket, '3')
    })
    await settle(50)
    expect(reads).deep.equals(['teams'])

    await tab('Schedule')
    expect(scopeFrames(socket).at(-1)).deep.include({
      type: 'subscribe',
      scope: 'schedule'
    })
    expect(reads).deep.equals(['teams'])
    await act(async () => {
      acknowledge(socket, '3')
    })
    await settle(50)
    expect(reads).deep.equals(['teams', 'games'])

    const before = scopeFrames(socket).length
    await tab('Videos')
    // Videos takes no scope: Schedule's is let go, and the list reads at once.
    expect(scopeFrames(socket).slice(before)).deep.equals([
      { type: 'unsubscribe', scope: 'schedule', id: 'c4' }
    ])
    expect(reads).deep.equals(['teams', 'games', 'games'])
  })

  it('holds the event for a pushed game', async () => {
    showRoute({ name: 'game', gameId: 'g1' }, true)
    await mount(<App initialToken="token-one" />)
    // Read once before anybody is known to be signed in, with no socket.
    expect(reads).includes('game')
    reads = []
    const socket = sockets.latest()
    await act(async () => {
      socket.open()
    })
    await settle(50)
    expect(
      scopeFrames(socket).map(({ type, scope, gameId }) => ({
        type,
        scope,
        gameId
      }))
    ).deep.equals([{ type: 'subscribe', scope: 'event', gameId: 'g1' }])
    expect(reads).not.includes('game')
    await act(async () => {
      acknowledge(socket, '8')
    })
    await settle(50)
    expect(reads).includes('game')
  })

  it('stops the scope when a REST call is refused for its session', async () => {
    const asked: string[] = []
    globalThis.fetch = (async (input: string) => {
      asked.push(input)
      return new Response('{"error":"unauthorized","message":"Sign in"}', {
        status: 401
      })
    }) as unknown as typeof fetch
    // Seasons goes to the server, and the server refuses the session.
    Object.defineProperty(
      TeamStationClient.prototype,
      'seasons',
      originals.seasons
    )
    showRoute({ name: 'home' }, true)
    await mount(<App initialToken="token-one" />)
    const socket = sockets.latest()
    await act(async () => {
      socket.open()
    })
    await settle(50)
    await act(async () => {
      acknowledge(socket, '3')
    })
    await settle(50)
    expect(asked.some(url => url.endsWith('/seasons'))).equals(true)
    expect(scopeFrames(socket).at(-1)).deep.include({
      type: 'unsubscribe',
      scope: 'home'
    })
    // Nothing else held it open, and nothing reconnects until a new token.
    expect(socket.closedWith).equals(1000)
    await settle(1200)
    expect(sockets.sockets).has.lengthOf(1)
  })
})

describe('which scope a route holds', () => {
  type Top = Parameters<typeof screenScopeOf>[1]
  it('holds home and schedule as tabs, an event for a game, its scoring and Coach Game, and nothing else', () => {
    expect(screenScopeOf('home', undefined, false)).deep.equals({
      scope: 'home'
    })
    expect(screenScopeOf('schedule', undefined, false)).deep.equals({
      scope: 'schedule'
    })
    expect(screenScopeOf('videos', undefined, false)).equals(undefined)
    expect(screenScopeOf('search', undefined, false)).equals(undefined)
    const tops: Top[] = [
      { name: 'game', gameId: 'g1', title: 'Game' },
      { name: 'scoreGame', gameId: 'g1' },
      { name: 'coachGame', gameId: 'g1', teamId: 't1' }
    ]
    for (const top of tops)
      expect(screenScopeOf('videos', top, true), top?.name).deep.equals({
        scope: 'event',
        gameId: 'g1'
      })
    // DJ Game is its own screen on an iPhone, and the game's page elsewhere.
    const dj: Top = { name: 'djGame', gameId: 'g1' }
    expect(screenScopeOf('home', dj, true)).equals(undefined)
    expect(screenScopeOf('home', dj, false)).deep.equals({
      scope: 'event',
      gameId: 'g1'
    })
    expect(
      screenScopeOf('home', { name: 'scoreOptions', gameId: 'g1' }, false)
    ).equals(undefined)
    expect(screenScopeOf('home', { name: 'account' }, false)).equals(undefined)
  })
})
