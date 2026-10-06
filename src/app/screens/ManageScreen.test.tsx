import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type {
  ManagePage,
  ScopePerson,
  TeamStationClient
} from '../../common/api'
import type { RoleFlag } from '../../common/roles'
import { ThemeProvider } from '../theme/ThemeContext'
import { ManageScreen } from './ManageScreen'

let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function person(
  userId: number,
  displayName: string,
  patch: Partial<ScopePerson> = {}
): ScopePerson {
  return {
    userId,
    displayName,
    emails: [`${displayName.split(' ')[0].toLowerCase()}@example.com`],
    teams: [],
    seasons: [],
    leagues: [],
    grants: [],
    adminOf: [],
    createdAt: '2026-03-01T12:00:00.000Z',
    lastSignInAt: null,
    lastSeenAt: null,
    ...patch
  }
}

/**
 * The Hawks' page: S keeps songs, H coaches, V films, K keeps score from the
 * league, the manager runs a team inside nothing, and A is an admin of the
 * season above. One account has no address, and one person is invited.
 */
function hawksPage(): ManagePage {
  return {
    scope: { kind: 'team', id: 'tem_hawks', name: 'Hawks' },
    tree: {
      leagues: [{ id: 'lea_spring', name: 'Spring league' }],
      seasons: [{ id: 'sea_2026', name: 'Spring 2026' }],
      teams: [{ id: 'tem_hawks', name: 'Hawks' }]
    },
    people: [
      person(1, 'Sam Songs', {
        teams: [{ id: 'tem_hawks', name: 'Hawks', role: 'member' }],
        grants: [
          {
            kind: 'team',
            id: 'tem_hawks',
            name: 'Hawks',
            roles: ['songkeeper']
          }
        ],
        lastSignInAt: '2026-03-02T12:00:00.000Z',
        lastSeenAt: '2026-04-02T12:00:00.000Z'
      }),
      person(2, 'Hal Coach', {
        teams: [{ id: 'tem_hawks', name: 'Hawks', role: 'member' }],
        grants: [
          {
            kind: 'team',
            id: 'tem_hawks',
            name: 'Hawks',
            roles: ['coach', 'songkeeper']
          }
        ]
      }),
      person(3, 'Kit Keeper', {
        leagues: [
          { id: 'lea_spring', name: 'Spring league', role: 'spectator' }
        ],
        grants: [
          {
            kind: 'league',
            id: 'lea_spring',
            name: 'Spring league',
            roles: ['scorekeeper']
          },
          // A level beside this one, as a league's page would list it.
          { kind: 'team', id: 'tem_rivals', name: 'Rivals', roles: ['admin'] }
        ]
      }),
      person(4, 'Ada Admin', {
        seasons: [{ id: 'sea_2026', name: 'Spring 2026', role: 'member' }],
        grants: [
          {
            kind: 'season',
            id: 'sea_2026',
            name: 'Spring 2026',
            roles: ['admin']
          }
        ],
        adminOf: [{ kind: 'season', id: 'sea_2026', name: 'Spring 2026' }]
      }),
      person(5, 'Max Manager', {
        teams: [{ id: 'tem_hawks', name: 'Hawks', role: 'manager' }]
      }),
      person(6, 'Nobody Here', {
        emails: [],
        teams: [{ id: 'tem_hawks', name: 'Hawks', role: 'owner' }]
      })
    ],
    pending: [
      {
        inviteId: 'inv_1',
        email: 'new@example.com',
        code: 'abc',
        invitedAt: '2026-03-03T12:00:00.000Z'
      }
    ],
    invites: []
  }
}

interface Calls {
  roles: Array<{ userId: number; admin: boolean; flags: RoleFlag[] }>
  removed: number[]
  added: string[]
  safesport: Array<{ leagueId: string; lao: boolean }>
  guardiansOf: Array<{ teamId: string; userId: number }>
}

async function mount(
  page: ManagePage | Error = hawksPage(),
  added: 'added' | 'invited' | 'already' = 'added',
  scope: { kind: 'league' | 'season' | 'team'; id: string } = {
    kind: 'team',
    id: 'tem_hawks'
  }
): Promise<Calls> {
  const calls: Calls = {
    roles: [],
    removed: [],
    added: [],
    safesport: [],
    guardiansOf: []
  }
  const client = {
    managePage: async () => {
      if (page instanceof Error) throw page
      return page
    },
    setSafesport: async (leagueId: string, lao: boolean) => {
      calls.safesport.push({ leagueId, lao })
      if (!(page instanceof Error)) {
        page.scope = { ...page.scope, safesportLao: lao }
      }
      return lao
    },
    guardians: async (teamId: string, userId: number) => {
      calls.guardiansOf.push({ teamId, userId })
      return []
    },
    roster: async () => [],
    setRoles: async (
      _kind: string,
      _id: string,
      userId: number,
      roles: { admin: boolean; flags: RoleFlag[] }
    ) => {
      calls.roles.push({ userId, ...roles })
      return []
    },
    removePerson: async (_kind: string, _id: string, userId: number) => {
      calls.removed.push(userId)
      return { removed: true }
    },
    addPerson: async (_kind: string, _id: string, email: string) => {
      calls.added.push(email)
      if (added === 'added') {
        return {
          added: true,
          person: { userId: 9, displayName: 'Pat New', email }
        }
      }
      if (added === 'invited') {
        return {
          added: false,
          invited: {
            inviteId: 'inv_2',
            email,
            code: 'def',
            invitedAt: '2026-03-03T12:00:00.000Z'
          }
        }
      }
      return { added: false }
    },
    invites: async () => ({ canInvite: false, invites: [] })
  } as unknown as TeamStationClient
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <ManageScreen
          client={client}
          scopeKind={scope.kind}
          scopeId={scope.id}
        />
      </ThemeProvider>
    )
    await delay(10)
  })
  return calls
}

function labelled(label: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(found, label).not.equals(null)
  return found!
}

function buttonsNamed(text: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="button"]')].filter(
    node => node.textContent === text
  )
}

async function press(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.click()
    await delay(10)
  })
}

async function type(label: string, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(labelled(label), value)
    labelled(label).dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

describe('the manage page, with role flags', function () {
  // Inside the suite, so it runs before the DOM setup empties the body: the
  // roles modal's portal must still be there to be taken down.
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('lists each person’s roles in words, marking those from above', async function () {
    await mount()
    const text = document.body.textContent ?? ''
    expect(text).includes('Songkeeper')
    expect(text).includes('Coach · Songkeeper')
    expect(text).includes('Scorekeeper · from Spring league')
    expect(text).includes('Season admin · from Spring 2026')
    expect(text).includes('Team manager · Hawks')
    expect(text).includes('Team admin · Rivals')
    // Somebody holding nothing here says so, and an account with no address
    // is in its own group at the bottom.
    expect(text).includes('No address on file')
    expect(text).includes('Invited, not joined yet')
  })

  it('opens the roles of a person from their line, and saves them with setRoles', async function () {
    const calls = await mount()
    await press(labelled('Roles for Hal Coach'))
    const coach = document.querySelector<HTMLInputElement>(
      'input[aria-label="Coach"]'
    )!
    const songs = document.querySelector<HTMLInputElement>(
      'input[aria-label="Songkeeper"]'
    )!
    expect(coach.checked).equals(true)
    expect(songs.checked).equals(true)
    await act(async () => {
      songs.click()
    })
    await press(buttonsNamed('Save').at(-1)!)
    expect(calls.roles).deep.equals([
      { userId: 2, admin: false, flags: ['coach'] }
    ])
  })

  it('shows a role from above on and fixed in the modal', async function () {
    await mount()
    await press(labelled('Roles for Kit Keeper'))
    const keeper = document.querySelector<HTMLInputElement>(
      'input[aria-label="Scorekeeper"]'
    )!
    expect(keeper.checked).equals(true)
    expect(keeper.disabled).equals(true)
    expect(document.body.textContent).includes('From Spring league')
    // Cancel closes it without saving anything.
    await press(buttonsNamed('Cancel').at(-1)!)
    expect(document.querySelector('input[aria-label="Scorekeeper"]')).equals(
      null
    )
  })

  it('shows an admin from above with every flag fixed', async function () {
    await mount()
    await press(buttonsNamed('Change role')[3])
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Team admin"]'
      )!.disabled
    ).equals(true)
    expect(document.body.textContent).includes('Admins can do all of this')
  })

  it('removes a person from this level, filters, and adds by address', async function () {
    const calls = await mount()
    await press(buttonsNamed('Remove')[0])
    expect(calls.removed).deep.equals([1])

    await type('Search', 'kit')
    expect(document.body.textContent).includes('1 of 6')
    await type('Search', 'hal@')
    expect(document.body.textContent).includes('Hal Coach')
    await type('Search', '')

    await type('E-mail address', 'pat@example.com')
    await press(buttonsNamed('Add')[0])
    expect(calls.added).deep.equals(['pat@example.com'])
    expect(document.body.textContent).includes('Pat New has been added.')
  })

  it('says when an address was invited, or already had access', async function () {
    await mount(hawksPage(), 'invited')
    await type('E-mail address', 'new@example.com')
    await press(buttonsNamed('Add')[0])
    expect(document.body.textContent).includes(
      'An invitation is on its way to new@example.com.'
    )
    await act(async () => {
      root?.unmount()
    })
    await mount(hawksPage(), 'already')
    await type('E-mail address', 'sam@example.com')
    await press(buttonsNamed('Add')[0])
    expect(document.body.textContent).includes(
      'sam@example.com already had access.'
    )
  })

  it('reads a server from before the flags by its admin levels', async function () {
    const page = hawksPage()
    const ada = page.people[3]
    page.people = [{ ...ada, grants: undefined }]
    await mount(page)
    expect(document.body.textContent).includes(
      'Season admin · from Spring 2026'
    )
  })

  it('offers Guardians on a player of this team, and on nobody else', async function () {
    const page = hawksPage()
    page.people.push(
      person(7, 'Pia Player', {
        teams: [
          { id: 'tem_hawks', name: 'Hawks', role: 'member', isPlayer: true }
        ]
      })
    )
    const calls = await mount(page)
    expect(buttonsNamed('Guardians').length).equals(1)
    await press(labelled('Guardians Pia Player'))
    expect(document.body.textContent).includes(
      'Guardians and family of Pia Player'
    )
    expect(calls.guardiansOf).deep.equals([{ teamId: 'tem_hawks', userId: 7 }])
    await press(labelled('Done'))
    expect(document.body.textContent).not.includes(
      'Guardians and family of Pia Player'
    )
  })

  it('shows a league’s SafeSport switch, and turns it on and off', async function () {
    const page = hawksPage()
    page.scope = {
      kind: 'league',
      id: 'lea_spring',
      name: 'Spring league',
      safesportLao: false
    }
    const calls = await mount(page, 'added', {
      kind: 'league',
      id: 'lea_spring'
    })
    const text = document.body.textContent ?? ''
    expect(text).includes('SafeSport Local Affiliated Organization')
    expect(text).includes(
      "This league is directly affiliated with USA Baseball or one of its state or regional affiliates, which makes it a SafeSport Local Affiliated Organization. The MAAPP then binds it: an adult's one-on-one messages to a player under 18 must also include the player's parent or guardian, an adult family member, or another adult of the league. A league that is only a chartered Little League is not one."
    )
    const lao = (): HTMLInputElement =>
      document.querySelector<HTMLInputElement>(
        'input[aria-label="SafeSport Local Affiliated Organization"]'
      )!
    expect(lao().checked).equals(false)
    await press(lao())
    expect(calls.safesport).deep.equals([{ leagueId: 'lea_spring', lao: true }])
    expect(lao().checked).equals(true)
    await press(lao())
    expect(calls.safesport.at(-1)).deep.equals({
      leagueId: 'lea_spring',
      lao: false
    })
    // No team here, so no Guardians.
    expect(buttonsNamed('Guardians')).deep.equals([])
  })

  it('shows no SafeSport switch on a team', async function () {
    await mount()
    expect(document.body.textContent).not.includes('SafeSport')
  })

  it('says so to somebody who does not administer it', async function () {
    await mount(new Error('Not found'))
    expect(document.body.textContent).includes('You do not administer this.')
  })
})
