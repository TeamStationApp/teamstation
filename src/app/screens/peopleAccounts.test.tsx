import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { Dimensions, Keyboard } from 'react-native'

import { asAddedPerson, TeamStationClient } from '../../common/api'
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
import { AddPeopleScreen } from './AddPeopleScreen'

const group = { kind: 'team' as const, id: 'tem_demo' }
const first = {
  userId: userIdOfGumbo(301),
  displayName: 'Mookie B',
  avatarUrl: null,
  affiliations: 'Demo Hawks'
}
const second = {
  userId: userIdOfGumbo(302),
  displayName: 'Mike T',
  avatarUrl: null,
  affiliations: ''
}
const rows = [first, second]
function client(): TeamStationClient {
  const api = new TeamStationClient({ baseUrl: '/api/v1' })
  api.searchPeopleAccounts = async (_group, q, excluded) =>
    rows.filter(
      row =>
        row.displayName.toLowerCase().includes(q.toLowerCase()) &&
        excluded?.includes(row.userId) !== true
    )
  api.addPersonAccount = async (_group, userId) =>
    asAddedPerson({
      added: true,
      person: { ...rows.find(row => row.userId === userId)! }
    })
  return api
}
describe('account selection screen', () => {
  afterEach(unmount)
  it('bounds results above an already-open keyboard and updates after keyboard changes', async () => {
    const getDimensions = Dimensions.get.bind(Dimensions)
    Dimensions.get = () => ({ width: 375, height: 667, scale: 1, fontScale: 1 })
    const metrics = Keyboard.metrics?.bind(Keyboard)
    const listen = Keyboard.addListener.bind(Keyboard)
    const callbacks = new Map<string, (event: any) => void>()
    Keyboard.metrics = () => ({
      screenX: 0,
      screenY: 180,
      width: 375,
      height: 300
    })
    Keyboard.addListener = ((event: string, callback: (event: any) => void) => {
      callbacks.set(event, callback)
      return {
        remove() {
          callbacks.delete(event)
        }
      }
    }) as typeof Keyboard.addListener
    try {
      const api = client()
      api.searchPeopleAccounts = async () =>
        Array.from({ length: 5 }, (_, n) => ({
          userId: userIdOfGumbo(400 + n),
          displayName: `Demo${n} Person`,
          avatarUrl: null,
          affiliations: ''
        }))
      await mount(
        <AddPeopleScreen
          client={api}
          group={group}
          scopeName="Demo"
          onDone={() => {}}
          onCancel={() => {}}
        />
      )
      await fill('Search users', 'Demo')
      await settle()
      const panel = (): HTMLElement | null =>
        document.querySelector('[data-testid="account-search-results"]')
      expect(Number.parseFloat(panel()!.style.maxHeight)).equals(168)
      await press('Select Demo4 Person')
      expect(text()).contains('Demo4 Person ×')
      await act(async () => {
        callbacks.get('keyboardDidShow')!({ endCoordinates: { screenY: 140 } })
      })
      await fill('Search users', 'Dem')
      await settle()
      expect(Number.parseFloat(panel()!.style.maxHeight)).equals(128)
      await act(async () => {
        callbacks.get('keyboardDidHide')!({})
      })
      expect(panel()).equals(null)
      await unmount()
    } finally {
      Dimensions.get = getDimensions
      Keyboard.metrics = metrics
      Keyboard.addListener = listen
    }
  })
  it('selects multiple accounts, excludes selections, removes them and submits pills alone', async () => {
    const api = client()
    const sent: string[] = []
    api.addPersonAccount = async (_group, userId) => {
      sent.push(userId)
      return asAddedPerson({
        added: true,
        person: rows.find(row => row.userId === userId)
      })
    }
    let notice = ''
    await mount(
      <AddPeopleScreen
        client={api}
        group={group}
        scopeName="Demo"
        onDone={value => {
          notice = value ?? ''
        }}
        onCancel={() => {}}
      />
    )
    expect(find('Add people')?.getAttribute('aria-disabled')).equals('true')
    await fill('Search users', 'M')
    await settle()
    await press('Select Mookie B')
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="Search users"]')!
        .value
    ).equals('')
    expect(
      document.querySelector('[data-testid="account-search-results"]')
    ).equals(null)
    await fill('Search users', 'M')
    await settle()
    expect(find('Select Mookie B')).equals(undefined)
    await press('Select Mike T')
    await press('Remove Mookie B')
    await fill('Search users', 'Mookie')
    await settle()
    await press('Select Mookie B')
    await press('Add people')
    expect(sent).deep.equals([second.userId, first.userId])
    expect(notice).contains('Added 2, invited 0')
  })
  it('keeps invalid addresses blocking and deduplicates mixed success counts', async () => {
    const api = client()
    let calls = 0
    api.addPerson = async (_kind, _id, email) => {
      calls++
      return asAddedPerson(
        email === 'existing@example.test'
          ? { added: true, person: first }
          : {
              added: false,
              invited: {
                inviteId: 'inv_demo',
                code: 'demo-fixture',
                email,
                invitedAt: '2026-01-01'
              }
            }
      )
    }
    let notice = ''
    await mount(
      <AddPeopleScreen
        client={api}
        group={group}
        scopeName="Demo"
        onDone={value => {
          notice = value ?? ''
        }}
        onCancel={() => {}}
      />
    )
    await fill('Search users', 'Mookie')
    await settle()
    await press('Select Mookie B')
    await fill('E-mail addresses', 'bad-address')
    expect(find('Add people')?.getAttribute('aria-disabled')).equals('true')
    await fill('E-mail addresses', 'existing@example.test, new@example.test')
    await press('Add people')
    expect(calls).equals(2)
    expect(notice).contains('Added 1, invited 1')
    expect(notice).contains('Mookie B, new@example.test')
    expect(notice).not.contains('existing@example.test')
  })
  it('retains failed accounts and addresses for retry while clearing successful ones', async () => {
    const api = client()
    api.addPersonAccount = async (_group, userId) => {
      if (userId === first.userId) throw new Error('Try this account again')
      return asAddedPerson({ added: true, person: second })
    }
    api.addPerson = async () => {
      throw new Error('Try this address again')
    }
    await mount(
      <AddPeopleScreen
        client={api}
        group={group}
        scopeName="Demo"
        onDone={() => {}}
        onCancel={() => {}}
      />
    )
    for (const name of ['Mookie B', 'Mike T']) {
      await fill('Search users', name)
      await settle()
      await press(`Select ${name}`)
    }
    await fill('E-mail addresses', 'retry@example.test')
    await press('Add people')
    expect(find('Remove Mookie B')).not.equals(undefined)
    expect(find('Remove Mike T')).equals(undefined)
    expect(text()).contains('Added 1, invited 0, 2 failed')
    api.addPersonAccount = async () =>
      asAddedPerson({ added: true, person: first })
    api.addPerson = async () => asAddedPerson({ added: false })
    await press('Add people')
  })
  it('ignores stale results and dismissal, and presents no-match and error states', async () => {
    const api = client()
    let resolveOld: ((rows: Array<typeof first>) => void) | undefined
    api.searchPeopleAccounts = async (_group, q) =>
      q === 'old'
        ? await new Promise(resolve => {
            resolveOld = resolve
          })
        : q === 'error'
          ? await Promise.reject(new Error('offline'))
          : []
    await mount(
      <AddPeopleScreen
        client={api}
        group={group}
        scopeName="Demo"
        onDone={() => {}}
        onCancel={() => {}}
      />
    )
    await fill('Search users', 'old')
    await settle()
    await fill('Search users', 'nothing')
    await settle()
    expect(text()).contains('No accounts match')
    await act(async () => {
      resolveOld?.([first])
    })
    expect(find('Select Mookie B')).equals(undefined)
    await act(async () => {
      document.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      )
    })
    expect(
      document.querySelector('[data-testid="account-search-results"]')
    ).equals(null)
    await fill('Search users', 'error')
    await settle()
    expect(text()).contains('Accounts could not load')
    await press('Close account results')
    expect(
      document.querySelector('[data-testid="account-search-results"]')
    ).equals(null)
    await fill('Search users', ' ')
    await settle()
    expect(
      document.querySelector('[data-testid="account-search-results"]')
    ).equals(null)
  })
})
