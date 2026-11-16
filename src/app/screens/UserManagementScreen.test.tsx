import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import type { ActivityPage, TeamStationClient } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import type {
  ActivityRow,
  DirectoryPerson,
  PersonAdministration
} from '../../common/userManagement'
import {
  fill,
  mount,
  press,
  settle,
  text,
  unmount
} from '../../test/gameFormDom'
import { listProps, reachEnd } from '../../test/PagedListStandIn'
import { PaneFrameProvider } from '../components/useBreakpoint'
import type { UserManagementTab } from '../navigation/routes'
import { UserManagementScreen } from './UserManagementScreen'

const ruth = userIdOfGumbo(101)
const gehrig = userIdOfGumbo(102)
const base = Date.UTC(2030, 0, 1, 12)

function row(i: number, patch: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: `ses_${String(i).padStart(4, '0')}`,
    at: new Date(base - i * 60_000).toISOString(),
    userId: i % 2 === 0 ? ruth : gehrig,
    displayName: i % 2 === 0 ? 'Babe Ruth' : 'Lou Gehrig',
    email: i % 2 === 0 ? 'ruth@example.com' : null,
    avatarUrl: null,
    lastActiveAt: i % 2 === 0 ? new Date(base).toISOString() : null,
    device: i % 2 === 0 ? 'iPhone' : 'Windows PC',
    appType: i % 2 === 0 ? 'iOS' : 'Web',
    ...patch
  }
}

/** A list of `total` rows, served 50 at a time as the server would. */
function served(
  total: number,
  calls: Array<string | null>,
  options: { failAt?: string; recordedSince?: string } = {}
): (cursor?: string | null) => Promise<ActivityPage> {
  const rows = Array.from({ length: total }, (_, i) => row(i))
  return async (cursor?: string | null) => {
    calls.push(cursor ?? null)
    if (options.failAt != null && cursor === options.failAt) {
      options.failAt = undefined
      throw new Error('The server is not answering')
    }
    const from = cursor == null ? 0 : Number(cursor)
    const items = rows.slice(from, from + 50)
    return {
      items,
      nextCursor: from + 50 < rows.length ? String(from + 50) : null,
      prevCursor: null,
      anchorId: null,
      counts: null,
      ...(cursor == null && options.recordedSince != null
        ? { recordedSince: options.recordedSince }
        : {})
    }
  }
}

const people: DirectoryPerson[] = [
  {
    userId: ruth,
    displayName: 'Babe Ruth',
    avatarUrl: null,
    email: 'ruth.second@example.com',
    affiliations: 'Demo Hawks'
  }
]
const details: PersonAdministration = {
  userId: ruth,
  displayName: 'Babe Ruth',
  avatarUrl: null,
  emails: [
    { email: 'ruth@example.com', isPrimary: true, isVerified: true },
    { email: 'ruth.second@example.com', isPrimary: false, isVerified: false }
  ],
  lastActiveAt: null,
  affiliations: [
    {
      kind: 'team',
      id: 'tem_hawks',
      name: 'Demo Hawks',
      roles: ['head coach', 'coach', 'player']
    },
    { kind: 'league', id: 'lea_a', name: 'Demo League A', roles: ['following'] }
  ]
}

interface Fixture {
  client: TeamStationClient
  logins: Array<string | null>
  sessions: Array<string | null>
  searches: string[]
  opened: string[]
  tabs: UserManagementTab[]
  edits: string[]
  groups: Array<{ kind: string; id: string }>
}

function fixture(
  options: {
    logins?: number
    sessions?: number
    failAt?: string
    directory?: (q: string) => Promise<DirectoryPerson[]>
    person?: () => Promise<PersonAdministration>
  } = {}
): Fixture {
  const f: Omit<Fixture, 'client'> = {
    logins: [],
    sessions: [],
    searches: [],
    opened: [],
    tabs: [],
    edits: [],
    groups: []
  }
  const client = {
    recentLogins: served(options.logins ?? 120, f.logins, {
      failAt: options.failAt
    }),
    recentSessions: served(options.sessions ?? 3, f.sessions, {
      recordedSince: '2030-01-01T12:00:00.000Z'
    }),
    directory: async (q: string) => {
      f.searches.push(q)
      return await (options.directory?.(q) ?? Promise.resolve(people))
    },
    personAdministration: async (userId: string) => {
      f.opened.push(userId)
      return await (options.person?.() ?? Promise.resolve(details))
    }
  } as unknown as TeamStationClient
  return { ...f, client }
}

async function open(
  f: Fixture,
  props: { allowed?: boolean; tab?: UserManagementTab; width?: number } = {}
): Promise<void> {
  await mount(
    <PaneFrameProvider
      frame={{ x: 0, y: 0, width: props.width ?? 1280, height: 900 }}
    >
      <UserManagementScreen
        client={f.client}
        allowed={props.allowed ?? true}
        tab={props.tab}
        onTab={tab => {
          f.tabs.push(tab)
        }}
        onEditAccount={userId => {
          f.edits.push(userId)
        }}
        onOpenGroup={group => {
          f.groups.push(group)
        }}
      />
    </PaneFrameProvider>
  )
}

/** A pill, by its label: pills are tabs, not buttons. */
function pill(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    node => node.textContent === label
  )
}
async function choose(label: string): Promise<void> {
  const node = pill(label)
  expect(node, label).not.equals(undefined)
  await act(async () => {
    node!.click()
  })
  await settle()
}
const lower = (): string => text().toLowerCase()

const drawn = (): string[] =>
  [
    ...document.querySelectorAll(
      '[aria-label^="Login time"], [aria-label^="Session start"]'
    )
  ].map(node => node.getAttribute('aria-label') ?? '')

describe('user management', function () {
  afterEach(unmount)

  it('tells anybody but a node administrator it is not theirs, and asks nothing', async function () {
    const f = fixture()
    await open(f, { allowed: false })
    expect(text()).equals('Only node administrators can open User Management.')
    expect([...f.logins, ...f.sessions, ...f.searches]).deep.equals([])
  })

  it('opens on the newest 50 logins and reads 50 more at the end, once at a time', async function () {
    const f = fixture()
    await open(f)
    for (const label of ['Recent Logins', 'Recent Sessions', 'User List'])
      expect(pill(label), label).not.equals(undefined)
    expect(text()).includes('User Management')
    expect(drawn()).to.have.length(50)
    expect(f.logins).deep.equals([null])
    // Every column, in the viewer's own time.
    expect(text())
      .includes('Login time')
      .and.includes('Last active')
      .and.includes('ruth@example.com')
      .and.includes('Windows PC')
      .and.includes('iOS')
    await act(async () => {
      reachEnd()
      reachEnd()
    })
    await settle(0)
    expect(f.logins).deep.equals([null, '50'])
    expect(drawn()).to.have.length(100)
    await act(async () => {
      reachEnd()
    })
    await settle(0)
    expect(drawn()).to.have.length(120)
    expect(new Set(drawn()).size).equals(120)
    expect(text()).includes('No older activity.')
    await act(async () => {
      reachEnd()
    })
    expect(f.logins).deep.equals([null, '50', '100'])
  })

  it('keeps its rows when a page fails, and reads it again on Retry', async function () {
    const f = fixture({ failAt: '50' })
    await open(f)
    await act(async () => {
      reachEnd()
    })
    await settle(0)
    expect(drawn()).to.have.length(50)
    expect(text()).not.includes('No older activity.')
    await press('Retry')
    await settle(0)
    expect(drawn()).to.have.length(100)
    expect(f.logins).deep.equals([null, '50', '50'])
  })

  it('shows sessions on their own tab, since when they are recorded, and says when there are none', async function () {
    const f = fixture()
    await open(f, { tab: 'sessions' })
    expect(text())
      .includes('Session start')
      .and.includes('Sessions recorded since 2030-01-01')
    expect(drawn()).to.have.length(3)
    await choose('Recent Logins')
    expect(f.tabs).deep.equals(['logins'])
    // The sessions page stays built beside it, so a pill chosen again is at once.
    expect(
      drawn().filter(label => label.startsWith('Login time'))
    ).to.have.length(50)

    await unmount()
    const empty = fixture({ logins: 0 })
    await open(empty)
    expect(text()).includes('No logins are recorded.')
  })

  it('stacks every column on a phone', async function () {
    const f = fixture({ logins: 2 })
    await open(f, { width: 390 })
    expect(listProps().estimatedItemSize).equals(104)
    expect(text())
      .includes('Babe Ruth')
      .and.includes('ruth@example.com')
      .and.includes('iPhone · iOS · Last active')
      .and.includes('Windows PC · Web · Last active —')
      .and.not.includes('Login time')
  })

  it('searches after a pause, and opens a person in place of the results', async function () {
    const f = fixture()
    await open(f, { tab: 'users' })
    expect(text()).includes('Type a name or an email address')
    // Neither activity list is read for a tab nobody opened.
    expect([...f.logins, ...f.sessions]).deep.equals([])
    await fill('Find a person', 'r')
    await fill('Find a person', 'ruth')
    expect(f.searches).deep.equals([])
    await settle(600)
    expect(f.searches).deep.equals(['ruth'])
    expect(text())
      .includes('Babe Ruth')
      .and.includes('ruth.second@example.com')
      .and.includes('Demo Hawks')
    await press('Babe Ruth')
    await settle(0)
    expect(f.opened).deep.equals([ruth])
    expect(lower()).includes('email addresses').and.includes('affiliations')
    expect(text())
      .includes('Primary')
      .and.includes('Unverified')
      .and.includes('Team · Head coach · Coach · Player')
      .and.includes('League · Following')
    await press('Demo Hawks')
    expect(f.groups).deep.equals([{ kind: 'team', id: 'tem_hawks' }])
    await press('Edit Babe Ruth’s account')
    expect(f.edits).deep.equals([ruth])
    // Typing again brings the results back.
    await fill('Find a person', 'ruth s')
    await settle(600)
    expect(lower()).not.includes('affiliations')
    await press('Clear')
    await settle(600)
    expect(text()).includes('Type a name or an email address')
  })

  it('says when nobody matches, and when a search or a person fails', async function () {
    let fail = true
    const f = fixture({
      directory: async q =>
        q === 'nobody'
          ? []
          : fail
            ? await Promise.reject(new Error('Search is down'))
            : people,
      person: async () => await Promise.reject(new Error('Person is down'))
    })
    await open(f, { tab: 'users' })
    await fill('Find a person', 'nobody')
    await settle(600)
    expect(text()).includes('No people match.')
    await fill('Find a person', 'ruth')
    await settle(600)
    expect(text()).includes('Search is down')
    fail = false
    await press('Retry')
    await settle(0)
    expect(text()).includes('ruth.second@example.com')
    await press('Babe Ruth')
    await settle(0)
    expect(text()).includes('Person is down')
    // Retry reads the person again, and not the search.
    const searched = f.searches.length
    await press('Retry')
    await settle(0)
    expect(f.opened).deep.equals([ruth, ruth])
    expect(f.searches).to.have.length(searched)
  })
})
