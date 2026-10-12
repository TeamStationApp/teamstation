import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { TeamStationClient } from '../../common/api'
import type { Notification } from '../../common/notifications'
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
  title: 'Be a guardian of Avery S',
  description: "Ichiro from Demo Hawks invited you to be Avery S's guardian.",
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
  title: "Grace Hill asks to be Avery S's guardian",
  description:
    "Approving lets them see Avery S's teams and manage Avery S's details."
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
    await press("Grace Hill asks to be Avery S's guardian")
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
    expect(text()).includes('Be a guardian of Avery S')
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
        ? { id: 106, displayName: 'Tim Raines', isAdmin: false }
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
    expect(text()).includes('Be a guardian of Avery S')
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
