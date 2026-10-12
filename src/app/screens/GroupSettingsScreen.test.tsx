import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asManagePage, TeamStationClient } from '../../common/api'
import { asGameScheduleProposal } from '../../common/gameApprovals'
import { asGroupDetail } from '../../common/publicGroups'
import { ThemeProvider } from '../theme/ThemeContext'
import { GroupSettingsScreen } from './GroupSettingsScreen'

let root: Root | undefined
const detail = asGroupDetail({
  nonMemberView: false,
  group: {
    kind: 'team',
    id: 'canonical',
    name: 'Demo Hawks',
    imageUrl: null,
    locality: null
  },
  parents: [],
  children: [],
  participatingSeasons: [],
  competingTeams: [],
  games: [],
  staff: [],
  canManage: true,
  canViewPrivate: false
})
const proposal = asGameScheduleProposal({
  requestId: 'declined-request',
  gameId: null,
  previous: null,
  status: 'declined',
  sentAt: '2026-10-10T18:00:00Z',
  canDelete: true,
  version: null,
  game: {
    homeTeamId: 'canonical',
    awayTeamId: 'visitor',
    seasonId: null,
    startAt: '2026-10-12T18:00:00Z',
    venue: null,
    outsideTournament: null,
    status: 'scheduled'
  }
})
function api(): TeamStationClient {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.group = async () => detail
  client.gameProposals = async () => []
  return client
}
async function mount(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
}
function button(label: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(
    node => (node.getAttribute('aria-label') ?? node.textContent) === label
  )
  expect(found, label).not.equals(undefined)
  return found!
}
async function press(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
  })
}
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})
describe('team settings management and pending saves', () => {
  it('retains canonical declined proposals and request navigation/deletion behind settings', async () => {
    const client = api()
    let removed = false
    let opened = ''
    client.gameProposals = async scope => {
      expect(scope).deep.equals({ kind: 'team', id: 'canonical' })
      return removed ? [] : [proposal]
    }
    client.deleteDeclinedGame = async (id, scope) => {
      expect(id).equals('declined-request')
      expect(scope).deep.equals({ kind: 'team', id: 'canonical' })
      removed = true
    }
    await mount(
      <GroupSettingsScreen
        client={client}
        groupRef={{ kind: 'team', id: 'alias' }}
        onLink={() => undefined}
        onSaved={() => undefined}
        onRequest={id => {
          opened = id
        }}
      />
    )
    expect(document.body.textContent).includes('Declined')
    await press('Open game proposal')
    expect(opened).equals('declined-request')
    await press('Delete declined entry')
    expect(removed).equals(true)
    expect(document.body.textContent).not.includes('Delete declined entry')
  })
  it('does not load administrative proposal lists for a viewer', async () => {
    const client = api()
    let requests = 0
    client.group = async () => ({ ...detail, canManage: false })
    client.gameProposals = async () => {
      requests++
      return [proposal]
    }
    await mount(
      <GroupSettingsScreen
        client={client}
        groupRef={{ kind: 'team', id: 'canonical' }}
        onLink={() => undefined}
        onSaved={() => undefined}
        onRequest={() => undefined}
      />
    )
    expect(requests).equals(0)
    expect(document.body.textContent).not.includes('Game proposals')
  })
  for (const leaves of [false, true])
    it(`locks Cancel and management during a save and ${leaves ? 'ignores completion after leaving' : 'completes exactly once'}`, async () => {
      const client = api()
      client.gameProposals = async () => [proposal]
      let finish!: () => void
      client.updateGroup = async () => {
        await new Promise<void>(resolve => {
          finish = resolve
        })
        return detail.group
      }
      let saved = 0
      let navigated = 0
      client.deleteDeclinedGame = async () => {
        navigated++
      }
      await mount(
        <GroupSettingsScreen
          client={client}
          groupRef={{ kind: 'team', id: 'canonical' }}
          onSaved={() => {
            saved++
          }}
          onCancel={() => {
            navigated++
          }}
          onLink={() => {
            navigated++
          }}
          onCreateGame={() => {
            navigated++
          }}
          onRequest={() => {
            navigated++
          }}
        />
      )
      await press('Save settings')
      for (const label of [
        'Cancel',
        'Join a Season',
        'Create Game',
        'Open game proposal',
        'Delete declined entry'
      ]) {
        expect(button(label).getAttribute('aria-disabled'), label).equals(
          'true'
        )
        await press(label)
      }
      expect(navigated).equals(0)
      if (leaves) {
        await act(async () => {
          root!.unmount()
        })
        root = undefined
      }
      await act(async () => {
        finish()
      })
      expect(saved).equals(leaves ? 0 : 1)
      expect(navigated).equals(0)
    })
})

async function typeAddress(value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="E-mail address"]'
  )
  expect(input).not.equals(null)
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input!.dispatchEvent(new window.Event('input', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 10))
  })
}

describe('a group’s people in its Settings', () => {
  function people(kind: 'team' | 'season' | 'league'): {
    client: TeamStationClient
    calls: unknown[]
  } {
    const calls: unknown[] = []
    const client = api()
    client.group = async () => ({
      ...detail,
      group: { ...detail.group, kind, id: `${kind}_one` }
    })
    let pending = true
    client.managePage = async (asked, id) => {
      calls.push(['page', asked, id])
      return asManagePage({
        scope: { kind, id, name: `Demo ${kind}` },
        tree: { leagues: [], seasons: [], teams: [] },
        people: [
          {
            userId: 301,
            displayName: 'Nolan Quiet',
            emails: [],
            teams: kind === 'team' ? [{ id, name: 'x', role: 'member' }] : [],
            seasons:
              kind === 'season' ? [{ id, name: 'x', role: 'member' }] : [],
            leagues:
              kind === 'league' ? [{ id, name: 'x', role: 'member' }] : [],
            adminOf: [],
            createdAt: '2026-01-01T00:00:00Z',
            lastSignInAt: null,
            lastSeenAt: null
          },
          {
            userId: 302,
            displayName: 'Pat Young',
            emails: ['pat@example.com'],
            teams: [],
            seasons: [],
            leagues: [],
            adminOf: [],
            createdAt: '2026-01-01T00:00:00Z',
            lastSignInAt: null,
            lastSeenAt: null
          }
        ],
        pending: pending
          ? [
              {
                inviteId: 'inv_one',
                email: 'newcomer@example.com',
                code: 'abc',
                invitedAt: '2026-10-01T00:00:00Z',
                requestId: 'req_one'
              }
            ]
          : [],
        invites: []
      })
    }
    client.invites = async () => ({ canInvite: true, invites: [] })
    client.addPerson = async (asked, id, email, options) => {
      calls.push(['add', asked, id, email, options?.admin, options?.flags])
      pending = false
      return email.startsWith('pat')
        ? {
            added: true,
            person: { userId: 302, displayName: 'Pat Young', email },
            invited: undefined
          }
        : {
            added: false,
            person: undefined,
            invited: {
              inviteId: 'inv_two',
              email,
              code: 'def',
              invitedAt: '2026-10-02T00:00:00Z',
              requestId: 'req_two'
            }
          }
    }
    client.removePerson = async (asked, id, userId) => {
      calls.push(['remove', asked, id, userId])
      return { removed: true }
    }
    return { client, calls }
  }

  for (const kind of ['team', 'season', 'league'] as const)
    it(`adds somebody by address, lists the invitations waiting and the people with no address, for a ${kind}`, async () => {
      const { client, calls } = people(kind)
      const opened: string[] = []
      await mount(
        <GroupSettingsScreen
          client={client}
          groupRef={{ kind, id: `${kind}_one` }}
          onLink={() => undefined}
          onSaved={() => undefined}
          onRequest={id => {
            opened.push(id)
          }}
        />
      )
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
      })
      const text = (): string => document.body.textContent ?? ''
      expect(text()).includes('ADD SOMEBODY')
      expect(text()).includes('INVITATIONS WAITING')
      expect(text()).includes('newcomer@example.com')
      expect(text()).includes('NO ADDRESS ON FILE')
      expect(text()).includes('Nolan Quiet')
      // Somebody with an address is managed from the people list instead.
      expect(text()).not.includes('Pat Young')
      expect(text()).includes('INVITE PEOPLE')
      await press('Open')
      expect(opened).deep.equals(['req_one'])

      // Roles chosen for the add, then an account added at once.
      await press('Choose roles')
      await act(async () => {
        document
          .querySelector<HTMLInputElement>('input[aria-label="Coach"]')!
          .click()
      })
      await press('Save')
      expect(text()).includes('Adds them as: Coach.')
      await typeAddress('pat@example.com')
      await press('Add')
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
      })
      expect(text()).includes('Pat Young has been added.')
      expect(calls).deep.include([
        'add',
        kind,
        `${kind}_one`,
        'pat@example.com',
        false,
        ['coach']
      ])
      expect(text()).not.includes('INVITATIONS WAITING')

      await press('Remove Nolan Quiet')
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
      })
      expect(calls).deep.include(['remove', kind, `${kind}_one`, 301])
    })

  it('says an invitation went to an address nobody holds, and opens it', async () => {
    const { client } = people('team')
    const opened: string[] = []
    await mount(
      <GroupSettingsScreen
        client={client}
        groupRef={{ kind: 'team', id: 'team_one' }}
        onLink={() => undefined}
        onSaved={() => undefined}
        onRequest={id => {
          opened.push(id)
        }}
      />
    )
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    await typeAddress('later@example.com')
    await press('Add')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(document.body.textContent).includes(
      'An invitation is on its way to later@example.com.'
    )
    await press('Open sent invitation')
    expect(opened).deep.equals(['req_two'])
  })
})
