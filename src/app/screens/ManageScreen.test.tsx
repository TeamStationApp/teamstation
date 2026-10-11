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
 * The Hawks' page: S keeps songs, H coaches and assists, V films, K keeps
 * score from the league, the manager runs a team inside nothing, and A is an
 * admin of the season above. One account has no address, and one person is
 * invited.
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
            roles: ['coach', 'assistant', 'songkeeper']
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

/**
 * The Hawks' page with somebody who only watches the season above: listed,
 * with a tick under Season, and nothing on the team itself.
 */
function watcherPage(): ManagePage {
  const page = hawksPage()
  page.people.push(
    person(7, 'Lou Watcher', {
      seasons: [{ id: 'sea_2026', name: 'Spring 2026', role: 'spectator' }]
    })
  )
  return page
}

interface Calls {
  roles: Array<{ userId: number; admin: boolean; flags: RoleFlag[] }>
  removed: number[]
  added: string[]
  addedWith: Array<{
    admin?: boolean
    flags?: RoleFlag[]
    idempotencyKey?: string
  }>
  opened: string[]
}

async function mount(
  page: ManagePage | Error = hawksPage(),
  added: 'added' | 'invited' | 'already' = 'added',
  refuse: { roles?: string; remove?: string } = {},
  at: { kind: 'league' | 'season' | 'team'; id: string } = {
    kind: 'team',
    id: 'tem_hawks'
  }
): Promise<Calls> {
  const calls: Calls = {
    roles: [],
    removed: [],
    added: [],
    addedWith: [],
    opened: []
  }
  const client = {
    managePage: async () => {
      if (page instanceof Error) throw page
      return page
    },
    setRoles: async (
      _kind: string,
      _id: string,
      userId: number,
      roles: { admin: boolean; flags: RoleFlag[] }
    ) => {
      if (refuse.roles != null) throw new Error(refuse.roles)
      calls.roles.push({ userId, ...roles })
      return []
    },
    removePerson: async (_kind: string, _id: string, userId: number) => {
      if (refuse.remove != null) throw new Error(refuse.remove)
      calls.removed.push(userId)
      return { removed: true }
    },
    addPerson: async (
      _kind: string,
      _id: string,
      email: string,
      options: Calls['addedWith'][number] = {}
    ) => {
      calls.added.push(email)
      calls.addedWith.push(options)
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
            requestId: 'req_2',
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
          scopeKind={at.kind}
          scopeId={at.id}
          onOpenRequest={id => {
            calls.opened.push(id)
          }}
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
    expect(text).includes('Coach · Assistant · Songkeeper')
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
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Assistant"]')!
        .checked
    ).equals(true)
    expect(songs.checked).equals(true)
    await act(async () => {
      songs.click()
    })
    await press(buttonsNamed('Save').at(-1)!)
    expect(calls.roles).deep.equals([
      { userId: 2, admin: false, flags: ['coach', 'assistant'] }
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
    // Keeping score from above keeps the songs here too.
    const songs = document.querySelector<HTMLInputElement>(
      'input[aria-label="Songkeeper"]'
    )!
    expect(songs.checked).equals(true)
    expect(songs.disabled).equals(true)
    expect(document.body.textContent).includes('Scorekeepers can do this')
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

  it('saves a member’s roles and says so above the table', async function () {
    const calls = await mount()
    await press(labelled('Roles for Hal Coach'))
    expect(document.body.textContent).not.includes('Send invitation')
    await act(async () => {
      document
        .querySelector<HTMLInputElement>('input[aria-label="Videographer"]')!
        .click()
    })
    await press(buttonsNamed('Save').at(-1)!)
    expect(calls.roles).deep.equals([
      {
        userId: 2,
        admin: false,
        flags: ['coach', 'assistant', 'songkeeper', 'videographer']
      }
    ])
    expect(document.body.textContent).includes('Saved the roles of Hal Coach.')
    expect(document.querySelector('input[aria-label="Coach"]')).equals(null)
  })

  it('keeps the roles sheet open with the refusal in it when a save fails', async function () {
    const calls = await mount(hawksPage(), 'added', {
      roles: 'Invite this person to the group first.'
    })
    await press(labelled('Roles for Hal Coach'))
    await act(async () => {
      document
        .querySelector<HTMLInputElement>('input[aria-label="Videographer"]')!
        .click()
    })
    await press(buttonsNamed('Save').at(-1)!)
    expect(calls.roles).deep.equals([])
    // Still open, saying why, rather than closing on a table that looks the
    // same as before.
    expect(document.querySelector('input[aria-label="Coach"]')).not.equals(null)
    expect(document.body.textContent).includes(
      'Invite this person to the group first.'
    )
    // Closing it clears the refusal for the next person.
    await press(buttonsNamed('Cancel').at(-1)!)
    await press(labelled('Roles for Sam Songs'))
    expect(document.body.textContent).not.includes(
      'Invite this person to the group first.'
    )
  })

  it('invites somebody who only watches the season above, with the roles, rather than setting them', async function () {
    const calls = await mount(watcherPage(), 'invited')
    expect(document.body.textContent).includes('Season spectator · Spring 2026')
    await press(labelled('Roles for Lou Watcher'))
    expect(document.body.textContent).includes(
      'Lou Watcher is not in Hawks yet, so these roles go in an invitation. They start when it is accepted.'
    )
    await act(async () => {
      document
        .querySelector<HTMLInputElement>('input[aria-label="Coach"]')!
        .click()
    })
    await press(buttonsNamed('Send invitation').at(-1)!)
    expect(calls.roles).deep.equals([])
    expect(calls.added).deep.equals(['lou@example.com'])
    expect(calls.addedWith[0].admin).equals(false)
    expect(calls.addedWith[0].flags).deep.equals(['coach'])
    expect(calls.addedWith[0].idempotencyKey).matches(/^roles-/)
    expect(document.querySelector('input[aria-label="Coach"]')).equals(null)
    expect(document.body.textContent).includes(
      'Invited Lou Watcher to Hawks as Coach. Nothing changes until the invitation is accepted.'
    )
    // The sent invitation opens from the note it is announced in.
    await press(buttonsNamed('Open sent invitation')[0])
    expect(calls.opened).deep.equals(['req_2'])
  })

  it('sets roles straight away on the season’s own page, where its watcher already is', async function () {
    const page = watcherPage()
    page.scope = { kind: 'season', id: 'sea_2026', name: 'Spring 2026' }
    const calls = await mount(
      page,
      'invited',
      {},
      {
        kind: 'season',
        id: 'sea_2026'
      }
    )
    await press(labelled('Roles for Lou Watcher'))
    expect(document.body.textContent).not.includes('go in an invitation')
    await act(async () => {
      document
        .querySelector<HTMLInputElement>('input[aria-label="Coach"]')!
        .click()
    })
    await press(buttonsNamed('Save').at(-1)!)
    expect(calls.added).deep.equals([])
    expect(calls.roles).deep.equals([
      { userId: 7, admin: false, flags: ['coach'] }
    ])
  })

  it('invites to a league somebody it lists from nowhere in it', async function () {
    const page = watcherPage()
    page.scope = { kind: 'league', id: 'lea_spring', name: 'Spring league' }
    const calls = await mount(
      page,
      'invited',
      {},
      {
        kind: 'league',
        id: 'lea_spring'
      }
    )
    await press(labelled('Roles for Lou Watcher'))
    expect(document.body.textContent).includes(
      'Lou Watcher is not in Spring league yet'
    )
    await act(async () => {
      document
        .querySelector<HTMLInputElement>('input[aria-label="Coach"]')!
        .click()
    })
    await press(buttonsNamed('Send invitation').at(-1)!)
    expect(calls.added).deep.equals(['lou@example.com'])
  })

  it('names a team admin and its flags together in the invitation it sends', async function () {
    const calls = await mount(watcherPage(), 'invited')
    await press(labelled('Roles for Lou Watcher'))
    for (const label of ['Videographer', 'Team admin']) {
      await act(async () => {
        document
          .querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
          .click()
      })
    }
    await press(buttonsNamed('Send invitation').at(-1)!)
    expect(calls.addedWith[0].admin).equals(true)
    expect(document.body.textContent).includes(
      'Invited Lou Watcher to Hawks as Team admin, Videographer.'
    )
  })

  it('marks a listed person with an invitation waiting here', async function () {
    const page = watcherPage()
    page.pending.push({
      inviteId: 'inv_lou',
      email: 'Lou@example.com',
      code: 'lou',
      invitedAt: '2026-03-04T12:00:00.000Z'
    })
    await mount(page)
    expect(labelled('Roles for Lou Watcher').textContent).includes(
      'Invited, not joined yet'
    )
    expect(labelled('Roles for Hal Coach').textContent).not.includes(
      'Invited, not joined yet'
    )
  })

  it('says above the table why a removal failed', async function () {
    const calls = await mount(hawksPage(), 'added', {
      remove: 'You cannot remove the only administrator.'
    })
    await press(buttonsNamed('Remove')[0])
    expect(calls.removed).deep.equals([])
    expect(document.body.textContent).includes(
      'You cannot remove the only administrator.'
    )
  })

  it('says so to somebody who does not administer it', async function () {
    await mount(new Error('Not found'))
    expect(document.body.textContent).includes('You do not administer this.')
  })
})
