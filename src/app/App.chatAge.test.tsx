import { expect } from 'chai'
import { after, afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asSessionUser, TeamStationClient } from '../common/api'
import type { ChatAge, ChatAgeSource } from '../common/chatAge'
import { asGroupDetail } from '../common/publicGroups'
import { userIdOfGumbo } from '../common/userId'
import { chatAgeSheet, clickPill, pressChatAge } from '../test/chatAgeTesting'
import { App } from './App'
import type { AppleAge } from './chat/declaredAge'
import { AppleAgeOverride } from './chat/DeclaredAgeGate'
import { DeviceApprovals } from './chat/deviceApprovals'
import { ChatEngine, type ConversationListItem } from './chat/engine/engine'

const delay = async (ms = 80): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const conversation = (unread: number): ConversationListItem => ({
  id: 'cnv_exact',
  kind: 'teamFans',
  title: 'Demo Group Chat',
  scope: { type: 'team', id: 'group_demo' },
  scopeName: 'Demo Group',
  lastSeq: 0,
  lastMessageAt: null,
  unread,
  canPost: false,
  canModerate: false,
  locked: true,
  noHolder: false,
  closed: false,
  memberCount: 2,
  unverified: false
})

// The real shell, its chat surfaces behind the age sheet, with the account's
// answer and this device's Apple answer chosen by each case.
describe('the app before and after the chat age sheet', function () {
  this.timeout(60000)
  const proto = TeamStationClient.prototype
  const originals = Object.getOwnPropertyDescriptors(proto)
  const engine = ChatEngine.prototype
  const engineOriginals = Object.getOwnPropertyDescriptors(engine)
  let confirmed: ChatAge
  const writes: ChatAgeSource[] = []
  let root: Root | undefined

  // Each case, since other files restore the client's prototype after theirs.
  beforeEach(() => {
    proto.whoAmI = async () =>
      asSessionUser({
        id: userIdOfGumbo(1),
        displayName: 'Demo User',
        isAdmin: true
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
    proto.chatAge = async () => confirmed
    proto.confirmChatAge = async (source: ChatAgeSource) => {
      writes.push(source)
      confirmed = {
        confirmed: true,
        source,
        confirmedAt: '2027-04-12T12:00:00.000Z'
      }
      return confirmed
    }
    engine.refresh = async () => [conversation(2)]
  })
  after(() => {
    Object.defineProperties(proto, originals)
    Object.defineProperties(engine, engineOriginals)
  })
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    window.history.replaceState(null, '', '/')
  })

  const open = async (
    path: string,
    account: 'unconfirmed' | 'confirmed',
    apple: AppleAge = 'none'
  ): Promise<void> => {
    confirmed =
      account === 'confirmed'
        ? {
            confirmed: true,
            source: 'self',
            confirmedAt: '2027-04-10T12:00:00.000Z'
          }
        : { confirmed: false, source: null, confirmedAt: null }
    writes.length = 0
    window.history.replaceState(null, '', path)
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <AppleAgeOverride age={apple}>
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
  // Not Now steps back with history.go, which lands after the render that
  // closed the sheet. Wait for the address, and do not sit out the wait when
  // it has already landed.
  const untilPath = async (expected: string): Promise<void> => {
    for (let tries = 0; tries < 40; tries += 1) {
      if (path() === expected) return
      await act(async () => {
        await delay(25)
      })
    }
  }
  const navTab = (label: string): HTMLElement => {
    const tab = [
      ...document.querySelectorAll<HTMLElement>('[role="tab"]')
    ].find(node => node.getAttribute('aria-label') === label)
    if (tab == null) throw new Error(`No ${label} tab`)
    return tab
  }
  const path = (): string => window.location.pathname
  // The chat surface's stand-in while the sheet is up over it.
  const locked = (): Element | null =>
    document.querySelector('[data-testid="chat-locked"]')
  const dot = (): Element | null =>
    document.querySelector('[data-testid="chat-unread"]')

  it('draws Chat, asks on it, returns on Not Now, and opens chat once agreed to', async () => {
    await open('/schedule', 'unconfirmed')
    expect(path()).equals('/schedule')
    navTab('Chat')
    expect(dot(), 'no unread chat for a locked account').equals(null)
    await settle(() => {
      navTab('Chat').click()
    })
    expect(chatAgeSheet()).not.equals(null)
    expect(locked()).not.equals(null)
    expect(path()).equals('/chat')
    await settle(() => {
      pressChatAge('decline')
    })
    expect(chatAgeSheet()).equals(null)
    await untilPath('/schedule')
    expect(path()).equals('/schedule')
    await settle(() => {
      navTab('Chat').click()
    })
    expect(chatAgeSheet()).not.equals(null)
    await settle(() => {
      pressChatAge('agree')
    })
    expect(writes).deep.equals(['self'])
    expect(chatAgeSheet()).equals(null)
    expect(locked()).equals(null)
    expect(path()).equals('/chat')
    expect(dot()).not.equals(null)
    await settle(() => {
      navTab('Home').click()
    })
    await settle(() => {
      navTab('Chat').click()
    })
    expect(chatAgeSheet()).equals(null)
    expect(locked()).equals(null)
    expect(path()).equals('/chat')
  })

  const browserBack = async (): Promise<void> => {
    await settle(() => {
      window.history.back()
    })
  }

  it('takes back the Chat step on Not Now, so Back leaves the tab before it', async () => {
    await open('/schedule', 'unconfirmed')
    await settle(() => {
      navTab('Home').click()
    })
    expect(path()).equals('/')
    const depth = window.history.state?.tsRouteIndex as number
    await settle(() => {
      navTab('Chat').click()
    })
    expect(path()).equals('/chat')
    await settle(() => {
      pressChatAge('decline')
    })
    await untilPath('/')
    expect(path()).equals('/')
    expect(window.history.state?.tsRouteIndex).equals(depth)
    await browserBack()
    await untilPath('/schedule')
    expect(path()).equals('/schedule')
    expect(chatAgeSheet()).equals(null)
  })

  it('takes back a Chats pill on Not Now, so Back does not walk into it', async () => {
    await open('/teams/group_demo', 'unconfirmed')
    const address = path() + window.location.search
    const depth = window.history.state?.tsRouteIndex as number
    await settle(() => {
      clickPill('Chats')
    })
    expect(window.location.search).contains('tab=chats')
    expect(chatAgeSheet()).not.equals(null)
    await settle(() => {
      pressChatAge('decline')
    })
    await untilPath(address.split('?')[0])
    expect(path() + window.location.search).equals(address)
    expect(window.history.state?.tsRouteIndex).equals(depth)
    expect(chatAgeSheet()).equals(null)
  })

  for (const page of [
    '/groups/season/season_demo',
    '/groups/league/league_demo'
  ])
    it(`takes back the Chats pill on Not Now at ${page}, which opened with no tab`, async () => {
      await open(page, 'unconfirmed')
      expect(window.location.search).equals('')
      const depth = window.history.state?.tsRouteIndex as number
      await settle(() => {
        clickPill('Chats')
      })
      expect(window.location.search).contains('tab=chats')
      expect(chatAgeSheet()).not.equals(null)
      await settle(() => {
        pressChatAge('decline')
      })
      expect(chatAgeSheet()).equals(null)
      await untilPath(page)
      expect(path()).equals(page)
      expect(window.location.search).not.contains('tab=chats')
      // No extra step: Back from here leaves the page, not its first tab.
      expect(window.history.state?.tsRouteIndex).equals(depth)
    })

  it('keeps a conversation address behind the sheet, and Not Now leaves it for Home', async () => {
    await open('/chat/cnv_exact', 'unconfirmed')
    expect(chatAgeSheet()).not.equals(null)
    expect(document.querySelector('[data-testid="chat-composer"]')).equals(null)
    await settle(() => {
      pressChatAge('decline')
    })
    // The sheet goes in the same render, while the frame slides out.
    expect(chatAgeSheet()).equals(null)
    await untilPath('/')
    expect(path()).equals('/')
  })

  it('asks before Chat devices from Account, and Not Now stays on Account', async () => {
    await open('/account', 'unconfirmed')
    const row = [
      ...document.querySelectorAll<HTMLElement>('[role="button"]')
    ].find(node =>
      (node.getAttribute('aria-label') ?? '').startsWith('Chat devices')
    )
    expect(row, 'Chat devices').not.equals(undefined)
    expect(
      [...document.querySelectorAll<HTMLElement>('[role="button"]')].some(
        node =>
          (node.getAttribute('aria-label') ?? '').startsWith(
            'Reported messages'
          )
      )
    ).equals(true)
    await settle(() => {
      row!.click()
    })
    expect(chatAgeSheet()).not.equals(null)
    await settle(() => {
      pressChatAge('decline')
    })
    expect(chatAgeSheet()).equals(null)
    expect(window.location.pathname).equals('/account')
  })

  it('asks on a team page’s Chats tab, and Not Now lands on Videos', async () => {
    await open('/teams/group_demo?tab=chats', 'unconfirmed')
    expect(chatAgeSheet()).not.equals(null)
    expect(document.querySelector('[data-testid="entity-chat-list"]')).equals(
      null
    )
    await settle(() => {
      pressChatAge('decline')
    })
    expect(chatAgeSheet()).equals(null)
    expect(window.location.search).not.contains('tab=chats')
  })

  const openAccountMenu = async (): Promise<void> => {
    await settle(() => {
      document
        .querySelector<HTMLElement>('[role="button"][aria-label^="Account, "]')
        ?.click()
    })
    await settle(() => {
      document
        .querySelector<HTMLElement>('[role="button"][aria-label="Account"]')
        ?.click()
    })
  }
  const back = async (): Promise<void> => {
    await settle(() => {
      document.querySelector<HTMLElement>('[aria-label="Back"]')?.click()
    })
  }

  it('hides a team page’s sheet while a frame stands over it, and shows it again on Back', async () => {
    await open('/teams/group_demo?tab=chats', 'unconfirmed')
    expect(chatAgeSheet()).not.equals(null)
    await openAccountMenu()
    expect(path()).equals('/account')
    expect(chatAgeSheet(), 'the team page is beneath').equals(null)
    await back()
    await untilPath('/teams/group_demo')
    expect(path()).equals('/teams/group_demo')
    expect(chatAgeSheet(), 'the team page is on top again').not.equals(null)
  })

  it('draws nothing for a team page once it is popped', async () => {
    await open('/teams/group_demo?tab=chats', 'unconfirmed')
    expect(chatAgeSheet()).not.equals(null)
    await back()
    await untilPath('/')
    expect(path()).equals('/')
    expect(chatAgeSheet()).equals(null)
    await settle(() => undefined)
    expect(chatAgeSheet()).equals(null)
  })

  it('starts device approvals only once chat is allowed', async () => {
    const proto = DeviceApprovals.prototype
    const original = Object.getOwnPropertyDescriptor(proto, 'start')!
    let starts = 0
    proto.start = function (this: DeviceApprovals) {
      starts += 1
    }
    try {
      await open('/schedule', 'unconfirmed')
      expect(starts, 'no approvals for a locked account').equals(0)
      await settle(() => {
        navTab('Chat').click()
      })
      await settle(() => {
        pressChatAge('agree')
      })
      expect(starts).greaterThan(0)
    } finally {
      Object.defineProperty(proto, 'start', original)
    }
  })

  it('starts device approvals once a confirmation made elsewhere is read on coming back', async () => {
    const proto = DeviceApprovals.prototype
    const original = Object.getOwnPropertyDescriptor(proto, 'start')!
    let starts = 0
    proto.start = function (this: DeviceApprovals) {
      starts += 1
    }
    try {
      await open('/schedule', 'unconfirmed')
      expect(starts).equals(0)
      confirmed = {
        confirmed: true,
        source: 'self',
        confirmedAt: '2027-04-12T12:00:00.000Z'
      }
      await settle(() => {
        document.dispatchEvent(new window.Event('visibilitychange'))
      })
      expect(starts).greaterThan(0)
      expect(writes).deep.equals([])
    } finally {
      Object.defineProperty(proto, 'start', original)
    }
  })

  it('opens chat with no sheet when Apple says 13 or older, confirming the account once', async () => {
    await open('/chat', 'unconfirmed', 'over13')
    expect(chatAgeSheet()).equals(null)
    expect(locked()).equals(null)
    expect(writes).deep.equals(['apple'])
  })

  it('shows only the notice when Apple says under 13, even for a confirmed account', async () => {
    await open('/chat', 'confirmed', 'under13')
    expect(document.body.textContent).includes('Chat Is for Ages 13 and Up')
    expect(document.querySelector('[data-testid="chat-age-agree"]')).equals(
      null
    )
    expect(locked()).not.equals(null)
    await settle(() => {
      pressChatAge('ok')
    })
    expect(chatAgeSheet()).equals(null)
    await untilPath('/')
    expect(path()).equals('/')
    navTab('Chat')
  })

  it('opens chat directly for a confirmed account', async () => {
    await open('/chat', 'confirmed')
    expect(chatAgeSheet()).equals(null)
    expect(locked()).equals(null)
    expect(path()).equals('/chat')
    expect(writes).deep.equals([])
  })
})
