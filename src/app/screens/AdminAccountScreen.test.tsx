import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import type { AccountSettings } from '../../common/accountSettings'
import {
  type AccountApi,
  asSession,
  type Session,
  type TeamStationClient
} from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import {
  fill,
  find,
  mount,
  press,
  settle,
  text,
  unmount
} from '../../test/gameFormDom'
import { AdminAccountScreen } from './AdminAccountScreen'

const admin = userIdOfGumbo(105)
const target = userIdOfGumbo(106)
const session: Session = asSession({
  token: 'tok',
  expiresAt: '2031-01-01T00:00:00.000Z',
  user: {
    id: admin,
    displayName: 'José Alvarez',
    isAdmin: true,
    email: 'node@example.com',
    avatarUrl: null
  }
})

function settings(displayName: string): AccountSettings {
  return {
    user: {
      id: target,
      gumboId: null,
      displayName,
      email: 'raines@example.com',
      isAdmin: false,
      avatarUrl: null
    },
    hasPassword: false,
    passwordNeedsUpgrade: false,
    passwordParameters: null,
    newPasswordSalt: undefined,
    emails: [
      {
        id: 'uem_1',
        email: 'raines@example.com',
        isPrimary: true,
        isVerified: true
      },
      {
        id: 'uem_2',
        email: 'raines.second@example.com',
        isPrimary: false,
        isVerified: false
      }
    ]
  }
}

function fixture(load: () => Promise<AccountSettings>): {
  client: TeamStationClient
  asked: string[]
  writes: unknown[]
} {
  const asked: string[] = []
  const writes: unknown[] = []
  const api: AccountApi = {
    accountSettings: load,
    setAccountName: async displayName => {
      writes.push({ displayName })
      return settings(displayName)
    },
    setAccountPhoto: async () => settings('Tim Raines'),
    clearAccountPhoto: async () => settings('Tim Raines'),
    chooseCatalogPicture: async () => undefined
  }
  const client = {
    accountOf: (userId: string) => {
      asked.push(userId)
      return api
    },
    accountSettings: async () => {
      throw new Error('The signed-in account was read')
    }
  } as unknown as TeamStationClient
  return { client, asked, writes }
}

describe('another person’s account, for a node administrator', function () {
  afterEach(unmount)

  it('shows their name, photo and addresses, and none of the administrator’s own', async function () {
    const f = fixture(async () => settings('Tim Raines'))
    await mount(
      <AdminAccountScreen
        client={f.client}
        session={session}
        allowed
        userId={target}
      />
    )
    expect(f.asked).deep.equals([target])
    expect(text())
      .includes('Account · Tim Raines')
      .and.includes('raines.second@example.com · Unverified')
      .and.not.includes('José Alvarez')
    for (const hidden of [
      'Password',
      'Sign out',
      'Delete account',
      'Node administration',
      'Make primary',
      'Add email address',
      'Chat devices',
      // The Affiliations section is the signed-in person's own.
      'AFFILIATIONS'
    ])
      expect(text(), hidden).not.includes(hidden)
    await fill('Name', 'Timothy Raines')
    await press('Save name')
    await settle(0)
    expect(f.writes).deep.equals([{ displayName: 'Timothy Raines' }])
    expect(text()).includes('Name saved')
  })

  it('shows nothing of anybody until their account loads, and Retry when it fails', async function () {
    let fail = true
    let answer!: (value: AccountSettings) => void
    const f = fixture(
      async () =>
        await new Promise<AccountSettings>((resolve, reject) => {
          if (fail) reject(new Error('That account could not load'))
          else answer = resolve
        })
    )
    await mount(
      <AdminAccountScreen
        client={f.client}
        session={session}
        allowed
        userId={target}
      />
    )
    expect(text())
      .includes('That account could not load')
      .and.not.includes('José Alvarez')
    expect(document.querySelector('input[aria-label="Name"]')).equals(null)
    fail = false
    await press('Retry')
    expect(text())
      .includes('Loading account settings…')
      .and.not.includes('José Alvarez')
    answer(settings('Tim Raines'))
    await settle(0)
    expect(text()).includes('Tim Raines')
    expect(find('Change photo') ?? find('Add photo')).not.equals(undefined)
  })

  it('is refused to anybody but a node administrator', async function () {
    const f = fixture(async () => settings('Tim Raines'))
    await mount(
      <AdminAccountScreen
        client={f.client}
        session={session}
        allowed={false}
        userId={target}
      />
    )
    expect(text()).equals('Only node administrators can open User Management.')
  })

  it('tells the shell when the administrator changed their own account here', async function () {
    const f = fixture(async () => ({
      ...settings('José Alvarez'),
      user: { ...settings('José Alvarez').user, id: admin }
    }))
    const changed: string[] = []
    const props = {
      client: f.client,
      session,
      allowed: true,
      onAccountChanged: (user: { displayName: string }) => {
        changed.push(user.displayName)
      }
    }
    await mount(<AdminAccountScreen {...props} userId={admin} />)
    await fill('Name', 'José A. Alvarez')
    await press('Save name')
    await settle(0)
    expect(changed).deep.equals(['José A. Alvarez'])
    await unmount()
    // Somebody else's change is theirs, not the signed-in person's.
    await mount(<AdminAccountScreen {...props} userId={target} />)
    await fill('Name', 'Timothy Raines')
    await press('Save name')
    await settle(0)
    expect(changed).deep.equals(['José A. Alvarez'])
  })
})
