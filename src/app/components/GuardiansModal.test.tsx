import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asRosterEntry,
  type Guardian,
  type RelativeKind,
  type TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { userIdOfGumbo } from '../../common/userId'
import { ThemeProvider } from '../theme/ThemeContext'
import { GuardiansModal } from './GuardiansModal'

/**
 * The modal a coach changes a player's guardians and family in: it lists
 * them with their kind, adds by address or by somebody picked from the
 * team, as a guardian or an adult family member, and removes.
 */
let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function render(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await delay(10)
  })
}

function labelled(label: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(found, label).not.equals(null)
  return found!
}

async function press(label: string): Promise<void> {
  await act(async () => {
    labelled(label).click()
    await delay(10)
  })
}

async function type(label: string, value: string): Promise<void> {
  await act(async () => {
    const input = labelled(label) as HTMLInputElement
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await delay(10)
  })
}

const text = (): string => document.body.textContent ?? ''
const disabled = (label: string): boolean =>
  labelled(label).getAttribute('aria-disabled') === 'true'

const roster = [
  asRosterEntry({
    userId: userIdOfGumbo(7),
    shortName: 'Pat P',
    jersey: null,
    positions: [],
    isPlayer: true,
    role: 'member',
    section: 'player',
    staffRoles: [],
    inheritedFrom: null
  }),
  asRosterEntry({
    userId: userIdOfGumbo(20),
    shortName: 'Blair B',
    jersey: null,
    positions: [],
    isPlayer: false,
    role: 'member',
    section: 'follower',
    staffRoles: [],
    inheritedFrom: null
  }),
  asRosterEntry({
    userId: userIdOfGumbo(21),
    shortName: 'Blake C',
    jersey: null,
    positions: [],
    isPlayer: false,
    role: 'member',
    section: 'follower',
    staffRoles: [],
    inheritedFrom: null
  })
]

interface Added {
  who: { userId: string } | { email: string }
  kind: RelativeKind
}

function fakeClient(
  start: Guardian[] | Error,
  added: Added[],
  removed: string[]
): TeamStationClient {
  let list = start instanceof Error ? [] : [...start]
  return {
    guardians: async () => {
      if (start instanceof Error) throw start
      return list
    },
    roster: async () => roster,
    addGuardian: async (
      _teamId: string,
      _userId: number,
      who: { userId: string } | { email: string },
      kind: RelativeKind
    ) => {
      added.push({ who, kind })
      if ('email' in who) {
        if (who.email === 'quinn@x') {
          throw new HttpError('badRequest', 'No account', {
            reason: 'guardianNeedsAccount'
          })
        }
        if (who.email === 'broken@x') throw new Error('')
        return {
          guardians: list,
          invited: {
            inviteId: 'inv_1',
            email: who.email,
            code: 'abc',
            invitedAt: '2027-04-01T00:00:00.000Z'
          }
        }
      }
      const entry = roster.find(row => row.userId === who.userId)
      list = [
        ...list,
        {
          userId: who.userId,
          name: entry?.shortName ?? '',
          email: null,
          kind
        }
      ]
      return { guardians: list }
    },
    removeGuardian: async (_teamId: string, _userId: string, id: string) => {
      removed.push(id)
      list = list.filter(guardian => guardian.userId !== id)
      return true
    }
  } as unknown as TeamStationClient
}

const g1: Guardian = {
  userId: userIdOfGumbo(11),
  name: 'Gale Guardian',
  email: 'g1@x',
  kind: 'guardian'
}

describe('GuardiansModal', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('lists guardians and family with their kind, and removes one', async function () {
    const removed: string[] = []
    const changes: Guardian[][] = []
    await render(
      <GuardiansModal
        client={fakeClient(
          [
            g1,
            {
              userId: userIdOfGumbo(12),
              name: 'Fay Family',
              email: null,
              kind: 'family'
            }
          ],
          [],
          removed
        )}
        teamId="t1"
        playerId={userIdOfGumbo(7)}
        playerName="Pat P"
        onChanged={list => {
          changes.push(list)
        }}
        onClose={() => undefined}
      />
    )
    expect(text()).includes('Guardians and family of Pat P')
    expect(text()).includes('Guardian · g1@x')
    expect(text()).includes('Fay Family')
    expect(text()).includes('Family')
    await press('Remove Gale Guardian')
    expect(removed).deep.equals([userIdOfGumbo(11)])
    expect(text()).not.includes('Gale Guardian')
    expect(changes.at(-1)?.map(guardian => guardian.userId)).deep.equals([
      userIdOfGumbo(12)
    ])
  })

  it('adds by address, as the kind chosen, and says an invitation went', async function () {
    const added: Added[] = []
    await render(
      <GuardiansModal
        client={fakeClient([], added, [])}
        teamId="t1"
        playerId={userIdOfGumbo(7)}
        playerName="Pat P"
        onClose={() => undefined}
      />
    )
    expect(text()).includes('Nobody is linked yet.')
    expect(disabled('Add by e-mail')).equals(true)
    await press('Adult family member')
    await type('E-mail address or name', 'aunt@x')
    expect(disabled('Add by e-mail')).equals(false)
    await press('Add by e-mail')
    expect(added).deep.equals([{ who: { email: 'aunt@x' }, kind: 'family' }])
    expect(text()).includes(
      'An invitation is on its way to aunt@x. Only that address can accept it.'
    )
  })

  it('offers people on the team by name, never the player or one already linked', async function () {
    const added: Added[] = []
    await render(
      <GuardiansModal
        client={fakeClient([g1], added, [])}
        teamId="t1"
        playerId={userIdOfGumbo(7)}
        playerName="Pat P"
        onClose={() => undefined}
      />
    )
    await type('E-mail address or name', 'b')
    expect(document.querySelector('[aria-label="Add Blair B"]')).equals(null)
    await type('E-mail address or name', 'Bl')
    expect(document.querySelector('[aria-label="Add Pat P"]')).equals(null)
    await type('E-mail address or name', 'Pa')
    expect(document.querySelector('[aria-label="Add Pat P"]')).equals(null)
    await type('E-mail address or name', 'bla')
    await press('Add Blair B')
    expect(added).deep.equals([
      { who: { userId: userIdOfGumbo(20) }, kind: 'guardian' }
    ])
    expect(text()).includes('Blair B is linked.')
    await type('E-mail address or name', 'bla')
    expect(document.querySelector('[aria-label="Add Blair B"]')).equals(null)
    expect(document.querySelector('[aria-label="Add Blake C"]')).not.equals(
      null
    )
  })

  it('says why a person with no way to sign in cannot be a guardian', async function () {
    await render(
      <GuardiansModal
        client={fakeClient([], [], [])}
        teamId="t1"
        playerId={userIdOfGumbo(7)}
        playerName="Pat P"
        onClose={() => undefined}
      />
    )
    await type('E-mail address or name', 'quinn@x')
    await press('Add by e-mail')
    expect(text()).includes('That person has no way to sign in.')
    await type('E-mail address or name', 'broken@x')
    await press('Add by e-mail')
    expect(text()).includes('Something went wrong')
  })

  it('says when the list cannot be read, and closes', async function () {
    let closed = 0
    await render(
      <GuardiansModal
        client={fakeClient(new Error('offline'), [], [])}
        teamId="t1"
        playerId={userIdOfGumbo(7)}
        playerName="Pat P"
        onClose={() => {
          closed += 1
        }}
      />
    )
    expect(text()).includes('Cannot load the guardians.')
    await press('Done')
    expect(closed).equals(1)
  })
})
