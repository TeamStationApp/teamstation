import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { TeamStationClient } from '../../common/api'
import type { Notification } from '../../common/notifications'
import { userIdOfGumbo } from '../../common/userId'
import { App } from '../App'
import { parseRoute } from '../navigation/routes'
import { showRoute } from '../navigation/useAddressBar'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  NotificationDetailScreen,
  NotificationsScreen
} from './NotificationsScreen'

/**
 * Guardian invitations and requests in the inbox. The server words both, so
 * the inbox draws them through the same title and description as every other
 * kind; accepting one makes the person a guardian, so the app asks again
 * what they may do, and the child's teams open at once.
 */
let root: Root | undefined
const originalFetch = globalThis.fetch

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  globalThis.fetch = originalFetch
})

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function mount(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await delay(20)
  })
}

async function press(label: string): Promise<void> {
  const node = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(
    node => (node.getAttribute('aria-label') ?? node.textContent) === label
  )
  expect(node, label).not.equals(undefined)
  await act(async () => {
    node!.click()
    await delay(20)
  })
}

const text = (): string => document.body.textContent ?? ''

const invitation: Notification = {
  id: 'event_guardian_invite',
  requestId: 'request_guardian_invite',
  type: 'guardian',
  title: 'Be a guardian of Alfonso S',
  description: "Ichiro from Demo Hawks invited you to be Alfonso S's guardian.",
  sentAt: '2026-10-06T12:00:00Z',
  expiresAt: '2026-10-20T12:00:00Z',
  status: 'pending',
  canAct: true,
  canWithdraw: false,
  canResend: false,
  viewed: false
}
const request: Notification = {
  ...invitation,
  id: 'event_guardian_request',
  requestId: 'request_guardian_request',
  title: "Grant Hartwig asks to be Alfonso S's guardian",
  description:
    "Approving lets them see Alfonso S's teams and manage Alfonso S's details."
}

describe('guardian notifications', function () {
  it('lists an invitation and a request by the words the server sent', async function () {
    const client = {
      notifications: async () => ({
        items: [invitation, request],
        hasPending: true,
        nextCursor: null
      })
    } as unknown as TeamStationClient
    const opened: string[] = []
    await mount(
      <NotificationsScreen
        client={client}
        onOpen={id => {
          opened.push(id)
        }}
      />
    )
    for (const item of [invitation, request]) {
      expect(text()).includes(item.title)
      expect(text()).includes(item.description)
    }
    expect(text().split('Needs your approval')).has.length(3)
    await press("Grant Hartwig asks to be Alfonso S's guardian")
    expect(opened).deep.equals(['request_guardian_request'])
  })

  it('accepts an invitation, shows it accepted and tells the app', async function () {
    let current = invitation
    const decided: Array<[string, string]> = []
    let changed = 0
    const client = {
      notification: async () => current,
      viewNotification: async () => {},
      decideRelationship: async (id: string, action: string) => {
        decided.push([id, action])
        current = { ...current, status: 'accepted', canAct: false }
        return { id, status: 'accepted' }
      }
    } as unknown as TeamStationClient
    await mount(
      <NotificationDetailScreen
        client={client}
        id={invitation.requestId}
        onChanged={() => {
          changed++
        }}
      />
    )
    expect(text()).includes('Be a guardian of Alfonso S')
    expect(text()).includes(invitation.description)
    await press('Accept invitation')
    expect(decided).deep.equals([['request_guardian_invite', 'accept']])
    expect(text()).includes('Accepted')
    expect(text()).not.includes('Accept invitation')
    expect(changed).equals(1)
  })

  it('asks for the roles again once a guardian invitation is accepted', async function () {
    const asked: string[] = []
    let current = invitation
    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      const method = init?.method ?? 'GET'
      const path = url.split('?')[0]
      asked.push(`${method} ${path}`)
      if (
        path.endsWith('/relationship-requests/request_guardian_invite/accept')
      )
        current = { ...current, status: 'accepted', canAct: false }
      const data = path.endsWith('/auth/me')
        ? { id: userIdOfGumbo(106), displayName: 'Tim Raines', isAdmin: false }
        : path.endsWith('/me/roles')
          ? {
              teams: {},
              guardianOf: current.status === 'accepted' ? [201] : []
            }
          : path.endsWith('/me/notifications/request_guardian_invite')
            ? current
            : path.endsWith('/accept')
              ? { id: invitation.requestId, status: 'accepted' }
              : path.endsWith('/me/notifications/summary')
                ? { hasPending: current.status === 'pending' }
                : {}
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    showRoute(parseRoute('/notifications/request_guardian_invite', ''), true)
    await mount(<App />)
    await act(async () => {
      await delay(50)
    })
    const roles = (): number =>
      asked.filter(line => line === 'GET /api/v1/me/roles').length
    expect(text()).includes('Be a guardian of Alfonso S')
    const before = roles()
    expect(before).greaterThan(0)
    await press('Accept invitation')
    await act(async () => {
      await delay(50)
    })
    expect(asked).includes(
      'POST /api/v1/relationship-requests/request_guardian_invite/accept'
    )
    expect(text()).includes('Accepted')
    expect(roles()).equals(before + 1)
  })
})

describe('a notification that somebody added you', function () {
  const grant: Notification = {
    id: 'aud_grant',
    requestId: 'aud_grant',
    type: 'grant',
    title: 'Dana Lee added you as Coach of Demo Hawks',
    description:
      "You are a member of Demo Hawks now. If you don't want to be, leave it here.",
    sentAt: '2026-10-06T12:00:00Z',
    expiresAt: '2026-10-06T12:00:00Z',
    status: 'accepted',
    canAct: false,
    canWithdraw: false,
    canResend: false,
    viewed: false,
    leave: { kind: 'team', id: 'tem_hawks', name: 'Demo Hawks' }
  }

  it('lists it as new, then added once opened', async function () {
    const client = {
      notifications: async () => ({
        items: [
          grant,
          { ...grant, id: 'aud_old', requestId: 'aud_old', viewed: true }
        ],
        hasPending: true,
        nextCursor: null
      })
    } as unknown as TeamStationClient
    await mount(
      <NotificationsScreen client={client} onOpen={() => undefined} />
    )
    expect(text()).includes(grant.title)
    expect(text()).includes('New')
    expect(text()).includes('Added')
    expect(text()).not.includes('Needs your approval')
  })

  it('leaves the team from the notification, and stops offering to', async function () {
    let current = grant
    const left: Array<[string, string]> = []
    let changed = 0
    let fail = true
    const client = {
      notification: async () => current,
      viewNotification: async () => {},
      leaveGroup: async (kind: string, id: string) => {
        if (fail) {
          fail = false
          throw new Error('The last direct administrator stays')
        }
        left.push([kind, id])
        current = { ...current, leave: null }
        return { removed: true }
      }
    } as unknown as TeamStationClient
    await mount(
      <NotificationDetailScreen
        client={client}
        id={grant.requestId}
        onChanged={() => {
          changed++
        }}
      />
    )
    expect(text()).includes(grant.title)
    expect(text()).includes('Added')
    expect(text()).not.includes('Accept invitation')
    await press('Leave Demo Hawks')
    expect(text()).includes('The last direct administrator stays')
    expect(changed).equals(0)
    await press('Leave Demo Hawks')
    expect(left).deep.equals([['team', 'tem_hawks']])
    expect(text()).includes('You left Demo Hawks.')
    expect(text()).not.includes('Leave Demo Hawks')
    expect(changed).equals(1)
  })
})

describe('a reminder to upload a recording', function () {
  const reminder: Notification = {
    id: 'evt_reminder',
    requestId: 'evt_reminder',
    type: 'recordingUpload',
    title: 'Upload your recording',
    description:
      'Home Plate on iPhone 13 Pro — provide a higher-quality copy for future viewing.',
    sentAt: '2026-10-07T12:00:00Z',
    expiresAt: '2026-10-07T12:00:00Z',
    status: 'pending',
    canAct: true,
    canWithdraw: false,
    canResend: false,
    viewed: false,
    leave: null,
    gameId: 'gam_00000000000000000001',
    liveStreamId: 'lvs_00000000000000000001'
  }

  it('comes first in Pending, labelled a reminder, and its body opens the game', async function () {
    const opened: string[] = []
    const uploads: string[] = []
    const decided: string[] = []
    const client = {
      notifications: async () => ({
        items: [invitation, reminder],
        hasPending: true,
        nextCursor: null
      }),
      decideRelationship: async (id: string) => {
        decided.push(id)
      }
    } as unknown as TeamStationClient
    await mount(
      <NotificationsScreen
        client={client}
        onOpen={id => {
          opened.push(id)
        }}
        onUpload={gameId => {
          uploads.push(gameId)
        }}
      />
    )
    const page = text()
    expect(page.indexOf(reminder.title)).lessThan(
      page.indexOf(invitation.title)
    )
    expect(page).includes(reminder.description)
    expect(page).includes('Reminder')
    expect(page.split('Needs your approval')).has.length(2)
    await press(`${reminder.title}. ${reminder.description}`)
    expect(uploads).deep.equals(['gam_00000000000000000001'])
    await press('Upload')
    expect(uploads).deep.equals([
      'gam_00000000000000000001',
      'gam_00000000000000000001'
    ])
    expect(opened).deep.equals([])
    expect(decided).deep.equals([])
  })

  it('opens from History, without asking for a decision', async function () {
    const opened: string[] = []
    const settled = { ...reminder, status: 'accepted' as const, canAct: false }
    const client = {
      notifications: async ({ history }: { history: boolean }) => ({
        items: history ? [settled] : [],
        hasPending: false,
        nextCursor: null
      })
    } as unknown as TeamStationClient
    await mount(
      <NotificationsScreen
        client={client}
        onOpen={id => {
          opened.push(id)
        }}
      />
    )
    await press('History')
    expect(text()).includes('Reminder')
    expect(text()).not.includes('Dismiss')
    await press('Upload your recording')
    expect(opened).deep.equals(['evt_reminder'])
  })

  it('dismisses, drops the card and asks for the pending dot again', async function () {
    const dismissed: string[] = []
    let refreshed = 0
    let fail = true
    const client = {
      notifications: async () => ({
        items: [reminder],
        hasPending: true,
        nextCursor: null
      }),
      dismissNotification: async (id: string) => {
        if (fail) {
          fail = false
          throw new Error('Dismissing failed')
        }
        dismissed.push(id)
      }
    } as unknown as TeamStationClient
    await mount(
      <NotificationsScreen
        client={client}
        onOpen={() => undefined}
        onDismissed={() => {
          refreshed++
        }}
      />
    )
    await press('Dismiss')
    expect(text()).includes('Dismissing failed')
    expect(text()).includes(reminder.title)
    expect(refreshed).equals(0)
    await press('Dismiss')
    expect(dismissed).deep.equals(['evt_reminder'])
    expect(text()).not.includes(reminder.title)
    expect(text()).includes('No approvals are waiting for you.')
    expect(refreshed).equals(1)
  })

  it('shows Upload in its detail and nothing to accept', async function () {
    const uploads: string[] = []
    const client = {
      notification: async () => reminder,
      viewNotification: async () => {}
    } as unknown as TeamStationClient
    await mount(
      <NotificationDetailScreen
        client={client}
        id={reminder.requestId}
        onChanged={() => undefined}
        onUpload={gameId => {
          uploads.push(gameId)
        }}
      />
    )
    expect(text()).includes(reminder.title)
    expect(text()).includes(reminder.description)
    expect(text()).includes('Reminder')
    expect(text()).not.includes('Accept invitation')
    expect(text()).not.includes('Decline invitation')
    expect(text()).not.includes('Valid until')
    await press('Upload')
    expect(uploads).deep.equals(['gam_00000000000000000001'])
  })

  it('lights the header dot, clears it on Dismiss, and Upload opens the game', async function () {
    let pending = true
    const asked: string[] = []
    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      const method = init?.method ?? 'GET'
      const path = url.split('?')[0]
      asked.push(`${method} ${path}`)
      if (method === 'PUT' && path.endsWith('/evt_reminder/dismissed')) {
        pending = false
        return new Response(null, { status: 204 })
      }
      const data = path.endsWith('/auth/me')
        ? { id: userIdOfGumbo(106), displayName: 'Tim Raines', isAdmin: false }
        : path.endsWith('/me/roles')
          ? { teams: {}, guardianOf: [] }
          : path.endsWith('/me/notifications/summary')
            ? { hasPending: pending }
            : path.endsWith('/me/notifications')
              ? {
                  items: pending ? [reminder] : [],
                  hasPending: pending,
                  nextCursor: null
                }
              : {}
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    const dot = (): boolean =>
      document.querySelector('[data-testid="notification-pending-dot"]') != null
    showRoute(parseRoute('/notifications', ''), true)
    await mount(<App />)
    await act(async () => {
      await delay(50)
    })
    expect(text()).includes(reminder.title)
    expect(dot()).equals(true)
    await press('Upload')
    expect(window.location.pathname).equals('/games/gam_00000000000000000001')
    expect(window.location.search).equals('?tab=watch')
    showRoute(parseRoute('/notifications', ''), true)
    await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()
    await mount(<App />)
    await act(async () => {
      await delay(50)
    })
    await press('Dismiss')
    await act(async () => {
      await delay(50)
    })
    expect(asked).includes(
      'PUT /api/v1/me/notifications/evt_reminder/dismissed'
    )
    expect(text()).not.includes(reminder.title)
    expect(dot()).equals(false)
  })
})
