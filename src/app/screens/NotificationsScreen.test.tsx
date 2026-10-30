import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import type { Notification } from '../../common/notifications'
import { userIdOfGumbo } from '../../common/userId'
import { listProps, reachEnd } from '../../test/PagedListStandIn'
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

function byLabel(label: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(node, label).not.equals(null)
  return node!
}

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
  it('lists an invitation and a request by the words the server sent, each with Accept and Reject', async function () {
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
    // Each card is decided where it is: Accept left of Reject, named for it.
    for (const item of [invitation, request]) {
      const accept = byLabel(`Accept ${item.title}`)
      const reject = byLabel(`Reject ${item.title}`)
      expect(accept.textContent).equals('Accept')
      expect(reject.textContent).equals('Reject')
      expect(
        accept.compareDocumentPosition(reject) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).not.equals(0)
    }
    expect(
      document.querySelectorAll('[data-testid="notification-accept"]')
    ).length(2)
    expect(
      document.querySelectorAll('[data-testid="notification-reject"]')
    ).length(2)
    // The card is no button: its title opens nothing.
    expect(
      [...document.querySelectorAll('[role="button"]')].some(
        node => node.getAttribute('aria-label') === request.title
      )
    ).equals(false)
    expect(opened).deep.equals([])
  })

  it('accepts and rejects on the card, drops it from Pending, and tells the app', async function () {
    const game: Notification = {
      ...invitation,
      id: 'event_game',
      requestId: 'request_game',
      type: 'game',
      title: 'Demo Hawks at Demo Owls'
    }
    const decided: Array<[string, string, string]> = []
    let decidedTimes = 0
    let history = 0
    const client = {
      notifications: async (options: { history?: boolean }) => {
        if (options.history === true) history++
        return {
          items: options.history === true ? [] : [invitation, request, game],
          hasPending: true,
          nextCursor: null
        }
      },
      decideRelationship: async (id: string, action: string) => {
        decided.push(['relationship', id, action])
        return { id, status: action === 'accept' ? 'accepted' : 'declined' }
      },
      decideGameRequest: async (id: string, action: string) => {
        decided.push(['game', id, action])
        return { id, status: 'accepted' }
      }
    } as unknown as TeamStationClient
    await mount(
      <NotificationsScreen
        client={client}
        onOpen={() => undefined}
        onDecided={() => {
          decidedTimes++
        }}
      />
    )
    await press(`Accept ${invitation.title}`)
    await press(`Reject ${request.title}`)
    await press(`Accept ${game.title}`)
    expect(decided).deep.equals([
      ['relationship', invitation.requestId, 'accept'],
      ['relationship', request.requestId, 'decline'],
      ['game', game.requestId, 'accept']
    ])
    expect(decidedTimes).equals(3)
    expect(text()).not.includes(invitation.title)
    expect(text()).not.includes(request.title)
    expect(text()).includes('No approvals are waiting for you.')
    // History is read again from the server.
    await press('History')
    expect(history).equals(1)
  })

  it('keeps a card whose decision failed, says why, and lets it be pressed again', async function () {
    let fail = true
    let release: () => void = () => undefined
    const gate: { hold?: Promise<void> } = {}
    const decided: string[] = []
    const client = {
      notifications: async () => ({
        items: [invitation, request],
        hasPending: true,
        nextCursor: null
      }),
      decideRelationship: async (id: string, action: string) => {
        await gate.hold
        if (fail) throw new Error('The request has expired')
        decided.push(`${id}:${action}`)
        return { id, status: 'accepted' }
      }
    } as unknown as TeamStationClient
    await mount(
      <NotificationsScreen client={client} onOpen={() => undefined} />
    )
    await press(`Accept ${invitation.title}`)
    expect(text()).includes('The request has expired')
    expect(text()).includes(invitation.title)
    fail = false
    // One decision out: every card's pills wait for it.
    gate.hold = new Promise<void>(resolve => {
      release = resolve
    })
    await press(`Accept ${invitation.title}`)
    expect(
      byLabel(`Reject ${request.title}`).getAttribute('aria-disabled')
    ).equals('true')
    await act(async () => {
      release()
      await delay(20)
    })
    expect(decided).deep.equals([`${invitation.requestId}:accept`])
    expect(text()).not.includes(invitation.title)
    expect(text()).not.includes('The request has expired')
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
  it('asks for the roles and the bell again when Accept is pressed on the list, and stays there', async function () {
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
          : path.endsWith('/me/notifications/summary')
            ? { hasPending: current.status === 'pending' }
            : path.endsWith('/me/notifications')
              ? {
                  items: current.status === 'pending' ? [current] : [],
                  hasPending: current.status === 'pending',
                  nextCursor: null
                }
              : path.endsWith('/accept')
                ? { id: invitation.requestId, status: 'accepted' }
                : {}
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    showRoute(parseRoute('/notifications', ''), true)
    await mount(<App />)
    await act(async () => {
      await delay(50)
    })
    const count = (line: string): number =>
      asked.filter(one => one === line).length
    const roles = count('GET /api/v1/me/roles')
    const bell = count('GET /api/v1/me/notifications/summary')
    await press(`Accept ${invitation.title}`)
    await act(async () => {
      await delay(50)
    })
    expect(asked).includes(
      'POST /api/v1/relationship-requests/request_guardian_invite/accept'
    )
    expect(count('GET /api/v1/me/roles')).equals(roles + 1)
    expect(count('GET /api/v1/me/notifications/summary')).greaterThan(bell)
    expect(window.location.pathname).equals('/notifications')
    expect(text()).not.includes('Be a guardian of Alfonso S')
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

describe('a player added with a notice', function () {
  const notice: Notification = {
    ...invitation,
    id: 'event_player_add',
    requestId: 'request_player_add',
    type: 'playerAdd',
    title: 'Dave Roberts added Mookie B to Ridgeview Falcons',
    description: 'Mookie B was added to the roster of Ridgeview Falcons.',
    status: 'applied',
    canAct: false,
    canReject: true,
    rejectUntil: '2027-01-26T12:00:00Z'
  }

  it('offers Reject without Accept, and Dismiss only while it is pending', async function () {
    const decided: string[] = []
    const dismissed: string[] = []
    const client = {
      notifications: async (options: { history?: boolean }) => ({
        items: [notice],
        hasPending: options.history !== true,
        nextCursor: null
      }),
      decideRelationship: async (id: string, action: string) => {
        decided.push(`${id} ${action}`)
        return { id, status: 'declined' }
      },
      dismissNotification: async (id: string) => {
        dismissed.push(id)
      }
    } as unknown as TeamStationClient
    await mount(
      <NotificationsScreen client={client} onOpen={() => undefined} />
    )
    expect(text()).includes(notice.title)
    expect(text()).includes('You can reject this until')
    expect(
      document.querySelectorAll('[data-testid="notification-accept"]')
    ).length(0)
    byLabel(`Dismiss ${notice.title}`)
    await press(`Dismiss ${notice.title}`)
    expect(dismissed).deep.equals([notice.requestId])
    expect(text()).not.includes(notice.title)

    await press('History')
    expect(text()).includes(notice.title)
    expect(
      [...document.querySelectorAll('[aria-label]')].some(
        node => node.getAttribute('aria-label') === `Dismiss ${notice.title}`
      )
    ).equals(false)
    await press(`Reject ${notice.title}`)
    expect(decided).deep.equals([`${notice.requestId} decline`])
  })

  it('says when it was added once it can no longer be rejected', async function () {
    const settled: Notification = { ...notice, canReject: false }
    const client = {
      notifications: async () => ({
        items: [settled],
        hasPending: false,
        nextCursor: null
      })
    } as unknown as TeamStationClient
    await mount(
      <NotificationsScreen client={client} onOpen={() => undefined} />
    )
    await press('History')
    expect(text()).includes('Added on')
    expect(
      [...document.querySelectorAll('[aria-label]')].some(
        node => node.getAttribute('aria-label') === `Reject ${notice.title}`
      )
    ).equals(false)
  })
})

describe("a player's side removing them", function () {
  const removal: Notification = {
    ...invitation,
    id: 'evt_removed',
    requestId: 'evt_removed',
    type: 'playerAddRejected',
    title: 'A guardian removed Mookie B from Ridgeview Falcons',
    description: 'Mookie B is no longer on it.',
    status: 'accepted',
    canAct: false,
    canReject: false,
    rejectUntil: null
  }

  it('waits in Pending with nothing to accept, and leaves on Dismiss', async function () {
    const dismissed: string[] = []
    const client = {
      notifications: async () => ({
        items: [removal],
        hasPending: true,
        nextCursor: null
      }),
      dismissNotification: async (id: string) => {
        dismissed.push(id)
      }
    } as unknown as TeamStationClient
    await mount(
      <NotificationsScreen client={client} onOpen={() => undefined} />
    )
    expect(text()).includes(removal.title)
    expect(text()).includes(removal.description)
    expect(text()).not.includes('Accept')
    await press(`Dismiss ${removal.title}`)
    expect(dismissed).deep.equals(['evt_removed'])
    expect(text()).not.includes(removal.title)
  })
})

describe('notifications a page at a time', function () {
  type Mode = 'pending' | 'sent' | 'history'
  interface Query {
    history?: boolean
    sent?: boolean
    cursor?: string
  }
  const PAGE = 25
  const modeOf = ({ history, sent }: Query): Mode =>
    history === true ? 'history' : sent === true ? 'sent' : 'pending'
  const inbox = (mode: Mode, count: number): Notification[] =>
    Array.from({ length: count }, (_row, index) => ({
      ...invitation,
      id: `${mode}_event_${index}`,
      requestId: `${mode}_${index}`,
      title: `${mode} row ${index}.`,
      canAct: mode === 'pending',
      status: mode === 'history' ? ('accepted' as const) : invitation.status
    }))

  /** Each mode's rows, cut as the server cuts them. */
  function server(rows: Record<Mode, Notification[]>): {
    client: TeamStationClient
    reads: Query[]
  } {
    const reads: Query[] = []
    const client = {
      notifications: async (query: Query) => {
        reads.push(query)
        const start = query.cursor == null ? 0 : Number(query.cursor)
        const list = rows[modeOf(query)]
        const end = start + PAGE
        return {
          items: list.slice(start, end),
          hasPending: rows.pending.length > 0,
          nextCursor: end < list.length ? String(end) : null
        }
      },
      dismissNotification: async () => undefined,
      decideRelationship: async (id: string) => ({ id, status: 'accepted' })
    } as unknown as TeamStationClient
    return { client, reads }
  }

  const reached = async (): Promise<void> => {
    await act(async () => {
      reachEnd()
      await delay(20)
    })
  }

  for (const mode of ['pending', 'sent', 'history'] as const)
    it(`reads ${mode} by page, with no button, and comes back to what it held`, async function () {
      const rows = {
        pending: inbox('pending', 60),
        sent: inbox('sent', 60),
        history: inbox('history', 60)
      }
      const { client, reads } = server(rows)
      await mount(
        <NotificationsScreen client={client} onOpen={() => undefined} />
      )
      if (mode !== 'pending') await press(mode[0].toUpperCase() + mode.slice(1))
      expect(text()).includes(`${mode} row 24.`)
      expect(text()).not.includes(`${mode} row 25.`)
      expect(text()).not.includes('Load more')
      await reached()
      expect(text()).includes(`${mode} row 49.`)
      await reached()
      expect(text()).includes(`${mode} row 59.`)
      expect(
        reads.filter(query => modeOf(query) === mode).map(read => read.cursor)
      ).deep.equals([undefined, '25', '50'])
      // The other way and back: its pages are held, and all read again.
      await press(mode === 'sent' ? 'History' : 'Sent')
      reads.length = 0
      await press(mode[0].toUpperCase() + mode.slice(1))
      expect(text()).includes(`${mode} row 59.`)
      expect(reads.map(read => read.cursor)).deep.equals([
        undefined,
        '25',
        '50'
      ])
    })

  it('says so when a mode has nothing in it', async function () {
    const { client } = server({ pending: [], sent: [], history: [] })
    await mount(
      <NotificationsScreen client={client} onOpen={() => undefined} />
    )
    expect(text()).includes('No approvals are waiting for you.')
    await press('Sent')
    expect(text()).includes('No sent invitations are waiting for approval.')
    await press('History')
    expect(text()).includes('No resolved notifications yet.')
  })

  it('keeps one row for a request read on two pages, where it first came', async function () {
    const rows = inbox('pending', 2)
    let second = false
    const client = {
      notifications: async () => {
        if (second)
          return {
            items: [
              { ...rows[0], title: 'Read again.' },
              { ...rows[1], requestId: 'after', title: 'After.' }
            ],
            hasPending: true,
            nextCursor: null
          }
        second = true
        return { items: rows, hasPending: true, nextCursor: 'more' }
      }
    } as unknown as TeamStationClient
    await mount(
      <NotificationsScreen client={client} onOpen={() => undefined} />
    )
    await reached()
    const page = text()
    expect(page).not.includes('pending row 0.')
    expect(page.indexOf('Read again.')).lessThan(page.indexOf('pending row 1.'))
    expect(page.indexOf('pending row 1.')).lessThan(page.indexOf('After.'))
  })

  it('leaves a row taken by a page that has more behind it, and reads on', async function () {
    const rows = {
      pending: inbox('pending', 40),
      sent: [],
      history: inbox('history', 1)
    }
    const { client, reads } = server(rows)
    await mount(
      <NotificationsScreen client={client} onOpen={() => undefined} />
    )
    let decided = 0
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <NotificationsScreen
            client={client}
            onOpen={() => undefined}
            onDecided={() => {
              decided++
            }}
          />
        </ThemeProvider>
      )
    })
    reads.length = 0
    for (let index = 0; index < 16; index++) {
      const { title } = rows.pending[index]
      await press(`Accept ${title}`)
      expect(text()).not.includes(title)
    }
    expect(decided).equals(16)
    // Nine left of 25: fewer than fill a screen, so the next page came.
    expect(reads.map(read => read.cursor)).deep.equals(['25'])
    expect(text()).includes('pending row 39.')
  })

  it('tells a mounted row what is being dismissed and decided', async function () {
    const rows = inbox('pending', 3)
    const reminders = rows.map(row => ({
      ...row,
      type: 'recordingUpload',
      gameId: null
    }))
    const hold: { release?: () => void } = {}
    const client = {
      notifications: async () => ({
        items: [...reminders.slice(0, 2), rows[2]],
        hasPending: true,
        nextCursor: null
      }),
      dismissNotification: async () => {
        await new Promise<void>(resolve => {
          hold.release = resolve
        })
      },
      decideRelationship: async (id: string) => {
        await new Promise<void>(resolve => {
          hold.release = resolve
        })
        return { id, status: 'accepted' }
      }
    } as unknown as TeamStationClient
    await mount(
      <NotificationsScreen client={client} onOpen={() => undefined} />
    )
    const before = listProps().extraData
    const busyRows = (): number =>
      document.querySelectorAll('[aria-busy="true"]').length
    const dismissButtons = (): HTMLElement[] =>
      [...document.querySelectorAll<HTMLElement>('[role="button"]')].filter(
        node => node.textContent === 'Dismiss'
      )
    await act(async () => {
      dismissButtons()[0].click()
      await delay(20)
    })
    expect(listProps().extraData).not.equals(before)
    // Its own row shows the spinner; the other waits for it.
    expect(busyRows()).equals(1)
    expect(dismissButtons()).has.length(1)
    expect(dismissButtons()[0].getAttribute('aria-disabled')).equals('true')
    await act(async () => {
      hold.release?.()
      await delay(20)
    })
    expect(busyRows()).equals(0)
    expect(dismissButtons()).has.length(1)
    expect(dismissButtons()[0].getAttribute('aria-disabled')).not.equals('true')
    await press(`Accept ${rows[2].title}`)
    expect(
      byLabel(`Reject ${rows[2].title}`).getAttribute('aria-disabled')
    ).equals('true')
    await act(async () => {
      hold.release?.()
      await delay(20)
    })
    expect(text()).not.includes(rows[2].title)
  })

  it('keeps the rows and shows Retry at the end when a later page fails', async function () {
    const rows = inbox('pending', 30)
    let fail = true
    const client = {
      notifications: async ({ cursor }: Query) => {
        if (cursor == null)
          return {
            items: rows.slice(0, 25),
            hasPending: true,
            nextCursor: '25'
          }
        if (fail) throw new Error('The inbox went away')
        return {
          items: rows.slice(25),
          hasPending: true,
          nextCursor: null
        }
      }
    } as unknown as TeamStationClient
    await mount(
      <NotificationsScreen client={client} onOpen={() => undefined} />
    )
    await reached()
    expect(text()).includes('Could not load more')
    expect(text()).includes('pending row 24.')
    expect(text()).not.includes('The inbox went away')
    fail = false
    await press('Retry')
    expect(text()).includes('pending row 29.')
    expect(text()).not.includes('Could not load more')
  })

  it('keeps the rows and says why when reading them again fails', async function () {
    const rows = inbox('pending', 2)
    let fail = false
    const client = {
      notifications: async () => {
        if (fail) throw new Error('The inbox went away')
        return { items: rows, hasPending: true, nextCursor: null }
      }
    } as unknown as TeamStationClient
    await mount(
      <NotificationsScreen client={client} onOpen={() => undefined} />
    )
    fail = true
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
      await delay(20)
    })
    expect(text()).includes('The inbox went away')
    expect(text()).includes('pending row 1.')
    fail = false
    await press('Retry notifications')
    expect(text()).not.includes('The inbox went away')
    expect(text()).includes('pending row 1.')
  })

  it('forgets every mode once the server refuses a page', async function () {
    const rows = {
      pending: inbox('pending', 30),
      sent: inbox('sent', 2),
      history: []
    }
    const { client } = server(rows)
    const read = client.notifications.bind(client)
    let refuse = false
    client.notifications = async query => {
      if (refuse) throw new HttpError('forbidden', 'You were signed out')
      return await read(query)
    }
    await mount(
      <NotificationsScreen client={client} onOpen={() => undefined} />
    )
    await press('Sent')
    expect(text()).includes('sent row 1.')
    await press('Pending')
    refuse = true
    await reached()
    expect(text()).includes('You were signed out')
    expect(text()).not.includes('pending row')
    expect(text()).not.includes('No approvals are waiting')
    await press('Sent')
    await act(async () => {
      await delay(20)
    })
    expect(text()).not.includes('sent row')
    refuse = false
    await press('Retry notifications')
    expect(text()).includes('sent row 1.')
    expect(text()).not.includes('You were signed out')
  })
})
