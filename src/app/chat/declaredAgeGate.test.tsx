import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NativeModules, Platform } from 'react-native'

import { asSessionUser, TeamStationClient } from '../../common/api'
import { asGroupDetail } from '../../common/publicGroups'
import { userIdOfGumbo } from '../../common/userId'
import { App } from '../App'
import type { ChatGate, DeclaredAgeAnswer } from './declaredAge'
import {
  ChatGateOverride,
  DeclaredAgeGateProvider,
  requestDeclaredAge,
  useChatAllowed,
  useDeclaredAgeGate
} from './DeclaredAgeGate'
import { ChatEngine, type ConversationListItem } from './engine/engine'

let root: Root | undefined
const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  delete NativeModules.TSDeclaredAge
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' })
})

async function mount(element: React.ReactElement): Promise<void> {
  if (root != null) {
    await act(async () => root?.unmount())
    document.body.replaceChildren()
  }
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(element)
  })
}

describe('the declared age hook', () => {
  it('stays allowed on the web and does not call the native module', async () => {
    let calls = 0
    NativeModules.TSDeclaredAge = {
      request: async () => {
        calls += 1
        return { status: 'declined' }
      }
    }
    const seen: ChatGate[] = []
    function Probe(): null {
      seen.push(useDeclaredAgeGate())
      return null
    }
    await mount(
      <DeclaredAgeGateProvider>
        <Probe />
      </DeclaredAgeGateProvider>
    )
    await act(async () => {
      await delay(30)
    })
    expect(seen[0]).equals('allowed')
    expect(seen.at(-1)).equals('allowed')
    expect(calls).equals(0)
  })

  it('treats a thrown native request and an unknown status as unavailable', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
    NativeModules.TSDeclaredAge = {
      request: async () => {
        throw new Error('sheet failed')
      }
    }
    expect(await requestDeclaredAge()).deep.equals({ status: 'unavailable' })
    NativeModules.TSDeclaredAge = {
      request: async () => ({ status: 'nope' })
    }
    expect(await requestDeclaredAge()).deep.equals({ status: 'unavailable' })
  })

  it('keeps chat while an iOS request is in flight, then denies a decline or a range under 13', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
    let answer: DeclaredAgeAnswer = { status: 'unsupported' }
    let release: (() => void) | undefined
    NativeModules.TSDeclaredAge = {
      request: async () =>
        await new Promise(resolve => {
          release = () => {
            resolve(answer)
          }
        })
    }
    const allowed: boolean[] = []
    const gates: ChatGate[] = []
    function Probe(): null {
      allowed.push(useChatAllowed())
      gates.push(useDeclaredAgeGate())
      return null
    }
    await mount(
      <DeclaredAgeGateProvider>
        <Probe />
      </DeclaredAgeGateProvider>
    )
    expect(gates[0]).equals('allowed')
    expect(allowed.every(Boolean)).equals(true)
    await act(async () => {
      await delay(10)
    })
    expect(gates).includes('pending')
    expect(allowed.every(Boolean)).equals(true)
    answer = { status: 'declined' }
    await act(async () => {
      release?.()
      await delay(10)
    })
    expect(gates.at(-1)).equals('denied')
    expect(allowed.at(-1)).equals(false)

    answer = { status: 'sharing', lowerBound: 12 }
    let releaseUnder: (() => void) | undefined
    NativeModules.TSDeclaredAge = {
      request: async () =>
        await new Promise(resolve => {
          releaseUnder = () => {
            resolve(answer)
          }
        })
    }
    gates.length = 0
    await mount(
      <DeclaredAgeGateProvider>
        <Probe />
      </DeclaredAgeGateProvider>
    )
    await act(async () => {
      releaseUnder?.()
      await delay(10)
    })
    expect(gates.at(-1)).equals('denied')

    for (const later of [
      { status: 'unsupported' },
      { status: 'unavailable' }
    ] as const) {
      let releaseLater: (() => void) | undefined
      NativeModules.TSDeclaredAge = {
        request: async () =>
          await new Promise(resolve => {
            releaseLater = () => {
              resolve(later)
            }
          })
      }
      const found: ChatGate[] = []
      function Read(): null {
        found.push(useDeclaredAgeGate())
        return null
      }
      await mount(
        <DeclaredAgeGateProvider>
          <Read />
        </DeclaredAgeGateProvider>
      )
      await act(async () => {
        releaseLater?.()
        await delay(10)
      })
      expect(found.at(-1)).equals('allowed')
    }
  })

  it('retries an unready answer ten times and then treats it as unavailable', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
    let calls = 0
    NativeModules.TSDeclaredAge = {
      request: async () => {
        calls += 1
        return { status: 'unready' }
      }
    }
    const answer = await requestDeclaredAge()
    expect(answer).deep.equals({ status: 'unavailable' })
    expect(calls).equals(11)
  }).timeout(10000)

  it('treats a missing native module as unsupported', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
    delete NativeModules.TSDeclaredAge
    expect(await requestDeclaredAge()).deep.equals({ status: 'unsupported' })
  })
})

describe('a denied gate removes chat from the app', () => {
  it('drops the Chat tab, a chat address, and entity chat lists', async () => {
    const proto = TeamStationClient.prototype
    const originals = Object.getOwnPropertyDescriptors(proto)
    proto.whoAmI = async () =>
      asSessionUser({
        id: userIdOfGumbo(1),
        displayName: 'Demo User',
        isAdmin: false
      })
    proto.myRoles = async () => ({ teams: {}, guardianOf: [] })
    proto.hasNotifications = async () => false
    proto.group = async ({ kind, id }) =>
      asGroupDetail({
        group: { kind, id, name: 'Demo Group', locality: null, imageUrl: null },
        nonMemberView: true,
        parents: [],
        children: [],
        participatingSeasons: [],
        competingTeams: [],
        games: [],
        staff: [],
        canViewPrivate: false,
        canManage: false,
        canSeePeople: false
      })
    proto.teamGames = async () => []
    proto.teamSchedule = async () => []
    proto.teamStaff = async () => []
    proto.roster = async () => []
    proto.seasonTeams = async () => []
    proto.seasonGames = async () => []
    proto.standings = async () => []
    proto.seasons = async () => []
    proto.accountSettings = async () => await new Promise(() => {})
    proto.chatReports = async () => []
    const engine = ChatEngine.prototype
    const engineOriginals = Object.getOwnPropertyDescriptors(engine)
    engine.refresh = async () =>
      [
        {
          id: 'cnv_exact',
          kind: 'teamFans',
          title: 'Demo Group Chat',
          scope: { type: 'team', id: 'group_demo' },
          scopeName: 'Demo Group',
          lastSeq: 0,
          lastMessageAt: null,
          unread: 0,
          canPost: false,
          canModerate: false,
          locked: true,
          noHolder: false,
          closed: false,
          memberCount: 2,
          unverified: false
        }
      ] as ConversationListItem[]
    const labels = (): string[] =>
      [...document.querySelectorAll('[role="tab"]')].map(
        node => node.getAttribute('aria-label') ?? node.textContent ?? ''
      )
    try {
      for (const path of [
        '/chat',
        '/teams/group_demo?tab=chats',
        '/seasons/group_demo?tab=chats',
        '/groups/league/group_demo?tab=chats',
        '/account'
      ]) {
        window.history.replaceState(null, '', path)
        await mount(
          <ChatGateOverride gate="denied">
            <App />
          </ChatGateOverride>
        )
        await act(async () => {
          await delay(80)
        })
        expect(labels(), path).not.includes('Chat')
        expect(
          document.querySelector('[data-testid="chat-workspace"]'),
          path
        ).equals(null)
        expect(
          document.querySelector('[data-testid="chat-composer"]'),
          path
        ).equals(null)
        expect(
          document.querySelector('[data-testid="entity-chat-list"]'),
          path
        ).equals(null)
        if (path === '/account') {
          const body = document.body.textContent ?? ''
          expect(body, path).includes('Sign out')
          expect(body, path).not.includes('Chat devices')
          expect(body, path).not.includes('Reported messages')
        }
        await act(async () => root?.unmount())
        document.body.replaceChildren()
      }

      proto.whoAmI = async () =>
        asSessionUser({
          id: userIdOfGumbo(1),
          displayName: 'Demo User',
          isAdmin: true
        })
      window.history.replaceState(null, '', '/account')
      await mount(<App />)
      await act(async () => {
        await delay(80)
      })
      const reports = [
        ...document.querySelectorAll<HTMLElement>('[role="button"]')
      ].find(node =>
        (node.getAttribute('aria-label') ?? '').startsWith('Reported messages')
      )
      expect(reports, 'Reported messages').not.equals(undefined)
      await act(async () => {
        reports!.click()
        await delay(80)
      })
      expect(document.body.textContent ?? '').includes('No open reports.')
    } finally {
      Object.defineProperties(proto, originals)
      Object.defineProperties(engine, engineOriginals)
      window.history.replaceState(null, '', '/')
    }
  }).timeout(30000)
})
