import { expect } from 'chai'
import { after, afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { AgeView } from '../common/age'
import {
  asSessionUser,
  type ChatConversation,
  TeamStationClient
} from '../common/api'
import { asGroupDetail } from '../common/publicGroups'
import { userIdOfGumbo } from '../common/userId'
import {
  ADULT_AGE,
  chatAgeSheet,
  NO_AGE,
  pressChatAge
} from '../test/chatAgeTesting'
import { pageOfGames } from '../test/pageOf'
import { App } from './App'
import { AppleAgeOverride } from './chat/DeclaredAgeGate'
import { ChatEngine, type ConversationListItem } from './chat/engine/engine'
import { askedKey, switchesKey } from './platform/notificationSwitches'

const delay = async (ms = 80): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const ME = userIdOfGumbo(1)
const OTHER = userIdOfGumbo(2)
const conversation: ConversationListItem = {
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

/** The browser's `Notification`, not decided yet. */
interface FakeNotification {
  permission: 'default' | 'granted' | 'denied'
  requestPermission: () => Promise<'default' | 'granted' | 'denied'>
}

// The real shell: each way into messaging from inside the app asks once, an
// address (a notification's tap, a link) never does, and on entering chat
// the ask waits for the age sheet.
describe('the app’s ask about notifications', function () {
  this.timeout(60000)
  const proto = TeamStationClient.prototype
  const originals = Object.getOwnPropertyDescriptors(proto)
  const engine = ChatEngine.prototype
  const engineOriginals = Object.getOwnPropertyDescriptors(engine)
  const global = globalThis as { Notification?: FakeNotification }
  const hadNotification = 'Notification' in global
  const notification = global.Notification
  let confirmed: AgeView
  let asked = 0
  let root: Root | undefined

  beforeEach(() => {
    window.localStorage.clear()
    asked = 0
    global.Notification = {
      permission: 'default',
      requestPermission: async () => {
        asked++
        return 'default'
      }
    }
    confirmed = ADULT_AGE
    proto.whoAmI = async () =>
      asSessionUser({ id: ME, displayName: 'Demo User', isAdmin: false })
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
        canSeePeople: true
      })
    proto.teamGamesPage = async (_id, query) => pageOfGames([], query)
    proto.teamSchedule = async () => []
    proto.teamStaff = async () => []
    proto.roster = async () => []
    proto.seasonTeams = async () => []
    proto.seasonGamesPage = async (_id, query) => pageOfGames([], query)
    proto.standings = async () => []
    proto.seasons = async () => []
    proto.accountSettings = async () => await new Promise(() => {})
    proto.chatReports = async () => []
    proto.chatLinks = async () => []
    proto.myAge = async () => confirmed
    proto.setMyAge = async () => {
      confirmed = ADULT_AGE
      return confirmed
    }
    proto.personProfile = async (kind, id, userId) => ({
      context: { kind, id, name: 'Demo Group' },
      person: {
        userId,
        shortName: 'Mookie B',
        fullName: 'Mookie Betts',
        avatarUrl: null,
        canHoldRoles: true
      },
      guardianOf: [],
      sections: [],
      viewer: { manages: false, admin: false, self: false }
    })
    proto.dmCandidates = async () => [
      {
        userId: OTHER,
        name: 'Mookie Betts',
        shortName: 'Mookie B',
        avatarUrl: null
      } as unknown as Awaited<ReturnType<TeamStationClient['dmCandidates']>>[0]
    ]
    proto.dmReach = async () => 'direct'
    proto.createDm = async () =>
      ({
        id: 'cnv_exact',
        title: 'Mookie Betts'
      }) as unknown as ChatConversation
    engine.refresh = async () => [conversation]
    engine.start = async function (this: ChatEngine) {
      this.status = 'ready'
      return 'ready'
    }
  })
  after(() => {
    Object.defineProperties(proto, originals)
    Object.defineProperties(engine, engineOriginals)
    if (hadNotification) global.Notification = notification
    else Reflect.deleteProperty(global, 'Notification')
  })
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    window.history.replaceState(null, '', '/')
    document.body.replaceChildren()
  })

  const open = async (path: string): Promise<void> => {
    window.history.replaceState(null, '', path)
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <AppleAgeOverride age="none">
          <App />
        </AppleAgeOverride>
      )
    })
    await act(async () => {
      await delay()
    })
  }
  const settle = async (action: () => void): Promise<void> => {
    await act(async () => {
      action()
      await delay()
    })
  }
  const navTab = (label: string): HTMLElement => {
    const tab = [
      ...document.querySelectorAll<HTMLElement>('[role="tab"]')
    ].find(node => node.getAttribute('aria-label') === label)
    if (tab == null) throw new Error(`No ${label} tab`)
    return tab
  }
  const ask = (): HTMLElement | null =>
    document.querySelector('[data-testid="notification-ask"]')
  const press = async (id: 'continue' | 'not-now'): Promise<void> => {
    await settle(() => {
      document
        .querySelector<HTMLElement>(`[data-testid="notification-ask-${id}"]`)!
        .click()
    })
  }
  const kept = (key: string): string | null => window.localStorage.getItem(key)

  it('asks on the Chat tab, over the chat, and never again after Not Now', async function () {
    await open('/schedule')
    expect(ask()).equals(null)
    await settle(() => {
      navTab('Chat').click()
    })
    expect(window.location.pathname).equals('/chat')
    expect(ask()).not.equals(null)
    expect(ask()!.textContent).contains(
      "TeamStation would like to send you notifications for events you've RSVP'd to and for direct messages from other users"
    )
    await press('not-now')
    expect(ask()).equals(null)
    expect(kept(askedKey(ME))).not.equals(null)
    expect(kept(switchesKey(ME))).equals(null)
    expect(asked).equals(0)
    await settle(() => {
      navTab('Home').click()
    })
    await settle(() => {
      navTab('Chat').click()
    })
    expect(ask()).equals(null)
  })

  it('on Continue turns both switches on and asks the browser', async function () {
    await open('/')
    await settle(() => {
      navTab('Chat').click()
    })
    await press('continue')
    await act(async () => {
      await delay()
    })
    expect(ask()).equals(null)
    expect(asked).equals(1)
    expect(JSON.parse(kept(switchesKey(ME)) ?? '{}')).deep.equals({
      messages: true,
      rsvpEvents: true
    })
  })

  it('asks on opening a conversation from a team’s chats', async function () {
    await open('/teams/group_demo?tab=chats')
    expect(ask()).equals(null)
    await settle(() => {
      document
        .querySelector<HTMLElement>('[data-testid="entity-chat-cnv_exact"]')!
        .click()
    })
    expect(window.location.pathname).equals('/chat/cnv_exact')
    expect(ask()).not.equals(null)
  })

  it('asks on a person’s Message button, over the conversation it opens', async function () {
    await open(`/teams/group_demo/people/${OTHER}`)
    expect(ask()).equals(null)
    const message = document.querySelector<HTMLElement>(
      '[data-testid="person-message"]'
    )
    expect(message).not.equals(null)
    await settle(() => {
      message!.click()
    })
    await act(async () => {
      await delay()
    })
    expect(window.location.pathname).equals('/chat/cnv_exact')
    expect(ask()).not.equals(null)
  })

  it('asks on a new conversation started in the app', async function () {
    // Arrived at by its address, New message asks nothing itself.
    await open('/chat/new')
    expect(ask()).equals(null)
    const button = (label: string): HTMLElement => {
      const found =
        document.querySelector<HTMLElement>(`[aria-label="${label}"]`) ??
        [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
          node => node.textContent === label
        )
      if (found == null) throw new Error(`No ${label}`)
      return found
    }
    await settle(() => {
      button('Pick Mookie B').click()
    })
    await settle(() => {
      button('Start conversation').click()
    })
    await act(async () => {
      await delay()
    })
    expect(window.location.pathname).equals('/chat/cnv_exact')
    expect(ask()).not.equals(null)
  })

  it('never asks on arriving by an address: a notification’s tap or a link', async function () {
    // A tap on a browser's notification opens its address in the window.
    await open('/chat/cnv_exact')
    expect(window.location.pathname).equals('/chat/cnv_exact')
    expect(ask()).equals(null)
    await act(async () => root?.unmount())
    await open('/chat')
    expect(ask()).equals(null)
    // Back and Forward to a chat are addresses too.
    await settle(() => {
      navTab('Home').click()
    })
    await settle(() => {
      window.history.back()
    })
    expect(window.location.pathname).equals('/chat')
    expect(ask()).equals(null)
    expect(kept(askedKey(ME))).equals(null)
  })

  it('waits for the age sheet on entering chat, and asks nothing when it is declined', async function () {
    confirmed = NO_AGE
    await open('/schedule')
    await settle(() => {
      navTab('Chat').click()
    })
    expect(chatAgeSheet()).not.equals(null)
    expect(ask(), 'never stacked on the age sheet').equals(null)
    await settle(() => {
      pressChatAge('close')
    })
    expect(chatAgeSheet()).equals(null)
    expect(ask()).equals(null)
    await settle(() => {
      navTab('Chat').click()
    })
    expect(chatAgeSheet()).not.equals(null)
    expect(ask()).equals(null)
    await settle(() => {
      pressChatAge('adult')
    })
    expect(chatAgeSheet()).equals(null)
    // Once the age sheet has finished going, which jsdom never plays: the
    // time it is given for that.
    for (let tries = 0; tries < 60 && ask() == null; tries++)
      await act(async () => {
        await delay()
      })
    expect(ask(), 'after the age sheet').not.equals(null)
  })

  it('turns both switches on quietly where notifications are allowed already', async function () {
    global.Notification = {
      permission: 'granted',
      requestPermission: async () => 'granted'
    }
    await open('/')
    await settle(() => {
      navTab('Chat').click()
    })
    expect(ask()).equals(null)
    expect(kept(askedKey(ME))).not.equals(null)
    expect(JSON.parse(kept(switchesKey(ME)) ?? '{}')).deep.equals({
      messages: true,
      rsvpEvents: true
    })
  })
})
