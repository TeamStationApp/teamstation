import { expect } from 'chai'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { Platform } from 'react-native'

import { asSessionUser, TeamStationClient } from '../common/api'
import { GAME_SOCKET_PROTOCOL } from '../common/gameSocket'
import { userIdOfGumbo } from '../common/userId'
import { type FakeSocket, fakeSockets } from '../test/fakeScoreboardSocket'
import { find, mount, settle, unmount } from '../test/gameFormDom'
import { App } from './App'
import { showRoute } from './navigation/useAddressBar'
import { gameFixture } from './scoring/isUnscoredGame.test'

const TITLE = 'Update required'
const BODY =
  'This version of TeamStation can no longer follow games live. Update the app to continue.'

/** The game subscribes the app sent on one socket. */
function gameSubscribes(socket: FakeSocket): Array<Record<string, unknown>> {
  return (socket.messages() as Array<Record<string, unknown>>).filter(
    frame => frame.type === 'subscribe' && !('scope' in frame)
  )
}

describe('the update required notice', () => {
  let originals: PropertyDescriptorMap
  const originalSocket = globalThis.WebSocket
  const originalFetch = globalThis.fetch
  const originalIndexedDB = Object.getOwnPropertyDescriptor(
    globalThis,
    'indexedDB'
  )
  const originalOs = Platform.OS
  let sockets: ReturnType<typeof fakeSockets>
  let reloads: number

  beforeEach(() => {
    const api = TeamStationClient.prototype
    originals = Object.getOwnPropertyDescriptors(api)
    sockets = fakeSockets()
    reloads = 0
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: new IDBFactory()
    })
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed')
    }
    globalThis.WebSocket = sockets.Impl as unknown as typeof WebSocket
    // The page the socket's address is found from, and what Reload reloads.
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: {
        href: window.location.href,
        reload: () => {
          reloads++
        }
      }
    })
    api.whoAmI = async () =>
      asSessionUser({
        id: userIdOfGumbo(101),
        displayName: 'Babe Ruth',
        isAdmin: false
      })
    api.myRoles = async () => ({ teams: {}, guardianOf: [] })
    api.umpireLeagues = async () => []
    api.health = async () => ({
      status: 'ok',
      version: '1',
      database: 'ok',
      migrations: 1,
      dictation: false,
      dictationModels: []
    })
    api.hasNotifications = async () => false
    api.chatConversations = async () => []
    api.chatLinks = async () => []
    api.teams = async () => []
    api.seasons = async () => []
    api.ownGroups = async () => []
    api.follows = async () => []
    api.guardedPlayers = async () => []
    api.recentGame = async () => null
    api.liveNow = async () => []
    api.games = async () => []
    api.game = async () => ({ ...gameFixture, canScore: false, videos: [] })
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
    Platform.OS = originalOs
    await unmount()
    Object.defineProperties(TeamStationClient.prototype, originals)
    globalThis.WebSocket = originalSocket
    globalThis.fetch = originalFetch
    if (originalIndexedDB == null)
      delete (globalThis as { indexedDB?: unknown }).indexedDB
    else Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB)
    delete (globalThis as { location?: unknown }).location
  })

  /** Opens a game, and returns its subscribe once the app has sent it. */
  const openGame = async (): Promise<{
    socket: FakeSocket
    subscribe: Record<string, unknown>
  }> => {
    showRoute({ name: 'game', gameId: 'g1' }, true)
    await mount(<App initialToken="token-one" />)
    const socket = sockets.latest()
    await act(async () => {
      socket.open()
    })
    await settle(50)
    const scope = (socket.messages() as Array<Record<string, unknown>>).find(
      frame => frame.scope === 'event'
    )
    await act(async () => {
      socket.receive({ type: 'subscribed', scope: 'event', id: scope?.id })
    })
    await settle(50)
    const [subscribe] = gameSubscribes(socket)
    expect(subscribe).deep.include({
      gameId: 'g1',
      protocol: GAME_SOCKET_PROTOCOL
    })
    return { socket, subscribe }
  }

  const refuse = async (
    socket: FakeSocket,
    subscribe: Record<string, unknown>
  ): Promise<void> => {
    await act(async () => {
      socket.receive({
        type: 'error',
        id: subscribe.id,
        code: 'forbidden',
        reason: 'updateRequired',
        message: 'Update TeamStation to keep following games.'
      })
    })
    await settle(50)
  }

  it('shows nothing while the server follows the game', async () => {
    await openGame()
    expect(document.body.textContent).not.contains(TITLE)
  })

  it('covers the game screen once its listener hears the refusal, with Reload on the web', async () => {
    const { socket, subscribe } = await openGame()
    await refuse(socket, subscribe)
    const notice = document.querySelector(
      '[data-testid="updateRequiredNotice"]'
    )
    expect(notice?.textContent).contains(TITLE)
    expect(notice?.textContent).contains(BODY)
    // Drawn over the screen, which stays mounted beneath it.
    expect(find('Back')).not.equals(undefined)
    const reload = [
      ...notice!.querySelectorAll<HTMLElement>('[role="button"]')
    ].find(node => node.textContent === 'Reload')
    expect(reload).not.equals(undefined)
    await act(async () => {
      reload!.click()
    })
    expect(reloads).equals(1)
    // The refused game is never asked for again.
    expect(gameSubscribes(socket)).lengthOf(1)
  })

  it('shows it when the server refuses a screen’s scope as too old', async () => {
    showRoute({ name: 'home' }, true)
    await mount(<App initialToken="token-one" />)
    const socket = sockets.latest()
    await act(async () => {
      socket.open()
    })
    await settle(50)
    const scope = (socket.messages() as Array<Record<string, unknown>>).find(
      frame => frame.scope === 'home'
    )
    expect(scope).deep.include({
      type: 'subscribe',
      protocol: GAME_SOCKET_PROTOCOL
    })
    expect(document.body.textContent).not.contains(TITLE)
    await refuse(socket, scope!)
    const notice = document.querySelector(
      '[data-testid="updateRequiredNotice"]'
    )
    expect(notice?.textContent).contains(TITLE)
  })

  it('offers no Reload on a phone, which updates from its store', async () => {
    const { socket, subscribe } = await openGame()
    Platform.OS = 'ios'
    await refuse(socket, subscribe)
    const notice = document.querySelector(
      '[data-testid="updateRequiredNotice"]'
    )
    expect(notice?.textContent).contains(TITLE)
    expect(notice?.querySelectorAll('[role="button"]')).lengthOf(0)
  })
})
