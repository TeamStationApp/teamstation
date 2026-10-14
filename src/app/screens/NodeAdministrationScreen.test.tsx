import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import type { TeamStationClient } from '../../common/api'
import type { NodeAccount } from '../../common/nodeAdministration'
import {
  fill,
  find,
  mount,
  press,
  settle,
  text,
  unmount
} from '../../test/gameFormDom'
import { NodeAdministrationScreen } from './NodeAdministrationScreen'

const admin: NodeAccount = {
  userId: 101,
  displayName: 'Babe Ruth',
  email: 'babe@example.com',
  isNodeAdmin: true,
  suspended: false,
  loginEnabled: true,
  canRemoveNodeRole: false
}
const account: NodeAccount = {
  ...admin,
  userId: 106,
  displayName: 'Hank Aaron',
  email: 'hank@example.com',
  isNodeAdmin: false,
  canRemoveNodeRole: true
}
function fixture(): {
  client: TeamStationClient
  users: NodeAccount[]
  writes: unknown[]
  changed: number[]
} {
  const users = [{ ...admin }, { ...account }]
  const writes: unknown[] = []
  const changed: number[] = []
  const client = {
    nodeAccounts: async (query = '', only = false) =>
      users
        .filter(
          user =>
            (!only || user.isNodeAdmin) &&
            `${user.displayName} ${user.email}`
              .toLowerCase()
              .includes(query.toLowerCase())
        )
        .map(user => ({ ...user })),
    accountMail: async () => ({ accountMessages: false }),
    setAccountMail: async () => {},
    changeNodeAccount: async (id: number, change: { isNodeAdmin: boolean }) => {
      writes.push({ id, ...change })
      users.find(user => user.userId === id)!.isNodeAdmin = change.isNodeAdmin
    }
  } as unknown as TeamStationClient
  return { client, users, writes, changed }
}
async function open(f: ReturnType<typeof fixture>): Promise<void> {
  await mount(
    <NodeAdministrationScreen
      client={f.client}
      onChanged={id => {
        f.changed.push(id)
      }}
    />
  )
}
describe('compact node access', () => {
  afterEach(unmount)
  it('lists only current admins until searching, with protected Revoke and a mail toggle above them', async () => {
    const f = fixture()
    await open(f)
    expect(text())
      .includes('Babe Ruth')
      .and.not.includes('Hank Aaron')
      .and.not.includes('Suspend')
      .and.not.includes('Refresh accounts')
    expect(find('Revoke Babe Ruth')?.getAttribute('aria-disabled')).equals(
      'true'
    )
    expect(text()).includes('final active node administrator')
    expect(
      document.querySelector<HTMLInputElement>('input[type="checkbox"]')
        ?.checked
    ).equals(false)
    expect(document.body.textContent!.indexOf('Account emails')).lessThan(
      document.body.textContent!.indexOf('NODE ACCESS')
    )
    await fill('Find an account', 'hank@')
    expect(text())
      .includes('Hank Aaron')
      .and.includes('hank@example.com')
      .and.includes('HA')
    expect(find('Add Hank Aaron')?.textContent).equals('Add')
    expect(
      getComputedStyle(find('Add Hank Aaron')!.firstElementChild!).color
    ).equals('rgb(56, 94, 38)')
    await press('Add Hank Aaron')
    expect(f.writes).deep.equals([{ id: 106, isNodeAdmin: true }])
    expect(f.changed).deep.equals([106])
    expect(find('Revoke Hank Aaron')?.textContent).equals('Revoke')
    expect(
      getComputedStyle(find('Revoke Hank Aaron')!.firstElementChild!).color
    ).equals('rgb(186, 26, 26)')
    expect(text().split('Hank Aaron').length - 1).equals(1)
    await press('Revoke Hank Aaron')
    expect(text()).includes('Revoke node access for Hank Aaron?')
    await press('Cancel')
    expect(f.writes).length(1)
    await press('Revoke Hank Aaron')
    await press('Confirm revoke')
    expect(f.writes).deep.equals([
      { id: 106, isNodeAdmin: true },
      { id: 106, isNodeAdmin: false }
    ])
    expect(find('Add Hank Aaron')).not.equals(undefined)
    await fill('Find an account', '')
    expect(text()).not.includes('Hank Aaron')
  })
  it('shows no matches, blocks suspended additions and recovers lookup failures', async () => {
    const f = fixture()
    f.users[1].suspended = true
    await open(f)
    await fill('Find an account', 'Hank')
    expect(find('Add Hank Aaron')?.getAttribute('aria-disabled')).equals('true')
    expect(text()).includes('This account is suspended')
    await fill('Find an account', 'Nobody')
    expect(text()).includes('No accounts match')
    const load = f.client.nodeAccounts.bind(f.client)
    f.client.nodeAccounts = async () => {
      throw new Error('Lookup offline')
    }
    await fill('Find an account', 'hank')
    expect(text()).includes('Lookup offline')
    f.client.nodeAccounts = load
    await press('Retry accounts')
    expect(text()).includes('Hank Aaron').and.not.includes('Lookup offline')
  })
  it('uses the account picture in the same leading person tile', async () => {
    const f = fixture()
    f.users[0].avatarUrl = 'https://images.example.test/avatar.png'
    await open(f)
    expect(document.querySelector('img')?.getAttribute('src')).equals(
      f.users[0].avatarUrl
    )
  })
  it('keeps confirmation through write errors and permits one write at a time', async () => {
    const f = fixture()
    f.users[1].isNodeAdmin = true
    await open(f)
    await press('Revoke Hank Aaron')
    f.client.changeNodeAccount = async () => {
      throw new Error('Access changed')
    }
    await press('Confirm revoke')
    expect(text())
      .includes('Access changed')
      .and.includes('Revoke node access for Hank Aaron?')
    let release!: () => void
    let writes = 0
    f.client.changeNodeAccount = async () => {
      writes++
      await new Promise<void>(resolve => {
        release = resolve
      })
      f.users[1].isNodeAdmin = false
    }
    await press('Confirm revoke')
    await press('Confirm revoke')
    await press('Cancel')
    expect(writes).equals(1)
    expect(text()).includes('Revoke node access for Hank Aaron?')
    await act(async () => {
      release()
    })
    await settle()
    expect(text())
      .not.includes('Revoke node access for Hank Aaron?')
      .and.not.includes('Hank Aaron')
  })
  it('ignores a search response that finishes after a newer query', async () => {
    const f = fixture()
    const load = f.client.nodeAccounts.bind(f.client)
    let old!: (rows: NodeAccount[]) => void
    f.client.nodeAccounts = async (query, only) =>
      query === 'old'
        ? await new Promise(resolve => {
            old = resolve
          })
        : await load(query, only)
    await open(f)
    await fill('Find an account', 'old')
    await fill('Find an account', 'Nobody')
    await act(async () => {
      old([account])
    })
    expect(text()).includes('No accounts match').and.not.includes('Hank Aaron')
  })
})
