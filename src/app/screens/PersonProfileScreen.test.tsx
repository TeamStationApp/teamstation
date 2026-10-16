import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asPersonProfile,
  type PersonProfile,
  type ProfileSection,
  type TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { ThemeProvider } from '../theme/ThemeContext'
import { PersonProfileScreen } from './PersonProfileScreen'

/**
 * The person profile: the hero with the level it was opened from, the
 * players they guard there, and a section of roles per level, with Add and
 * Remove only on the level opened from and only for a viewer who manages its
 * people, Admin only for an administrator, and Follower never a button.
 */
let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const text = (): string => document.body.textContent ?? ''

function section(
  level: ProfileSection['level'],
  fields: Partial<ProfileSection> = {}
): ProfileSection {
  return {
    level,
    groups: [{ id: `${level}_one`, name: `Demo ${level}` }],
    roles: [],
    member: false,
    follower: false,
    editable: false,
    ...fields
  }
}

function profile(fields: Partial<PersonProfile> = {}): PersonProfile {
  return asPersonProfile({
    context: { kind: 'team', id: 'tem_hawks', name: 'Demo Hawks' },
    person: {
      userId: 203,
      shortName: 'Pat Y',
      fullName: 'Pat Young',
      avatarUrl: null,
      canHoldRoles: true
    },
    guardianOf: [
      {
        userId: 202,
        shortName: 'Avery Y',
        avatarUrl: null,
        teamId: 'tem_hawks'
      }
    ],
    sections: [
      section('team', { editable: true, member: true, roles: ['coach'] }),
      section('season', {
        groups: [
          { id: 'sea_a', name: 'Demo Playoffs' },
          { id: 'sea_b', name: 'Demo Regular' }
        ],
        roles: ['scorekeeper'],
        follower: true
      }),
      section('league', { member: true })
    ],
    viewer: { manages: true, admin: true },
    ...fields
  })
}

interface Calls {
  changes: Array<[string, string, string, number, string]>
  players: unknown[]
  loads: number
}

async function render(
  answers: Array<PersonProfile | Error>,
  options: { kind?: 'team' | 'season' | 'league'; failChange?: boolean } = {}
): Promise<Calls> {
  const calls: Calls = { changes: [], players: [], loads: 0 }
  const kind = options.kind ?? 'team'
  const client = {
    personProfile: async (asked: string, id: string, userId: number) => {
      expect([asked, id, userId]).deep.equals([kind, 'grp_one', 203])
      const answer = answers[Math.min(calls.loads, answers.length - 1)]
      calls.loads++
      if (answer instanceof Error) throw answer
      return answer
    },
    addRole: async (k: string, id: string, userId: number, role: string) => {
      calls.changes.push(['add', k, id, userId, role])
      if (options.failChange === true)
        throw new HttpError('forbidden', 'Only an administrator can')
      return { userId, roles: [], member: true }
    },
    removeRole: async (k: string, id: string, userId: number, role: string) => {
      calls.changes.push(['remove', k, id, userId, role])
      return { userId, roles: [], member: false }
    }
  } as unknown as TeamStationClient
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <PersonProfileScreen
          client={client}
          kind={kind}
          id="grp_one"
          userId={203}
          onOpenPlayer={(userId, name, from) => {
            calls.players.push([userId, name, from])
          }}
        />
      </ThemeProvider>
    )
    await delay(10)
  })
  return calls
}

/** The row of `role` in the section for `level`. */
function rowOf(level: string, role: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(
    `[data-testid="role-${level}-${role}"]`
  )
  expect(node, `${level} ${role}`).not.equals(null)
  return node!
}
function buttonIn(node: HTMLElement): HTMLElement | null {
  return node.querySelector<HTMLElement>('[role="switch"]')
}
async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.click()
    await delay(10)
  })
}

describe('the person profile', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('puts the photo, the whole name and the level it is for in the hero, then the players they guard', async function () {
    const calls = await render([profile()])
    expect(text()).includes('Pat Young')
    expect(text()).includes('Team · Demo Hawks')
    expect(text().indexOf('PARENT/GUARDIAN OF')).lessThan(
      text().indexOf('TEAM ROLES')
    )
    const child = [
      ...document.querySelectorAll<HTMLElement>('[role="button"]')
    ].find(node => node.textContent?.includes('Avery Y') === true)
    await click(child!)
    expect(calls.players).deep.equals([
      [202, 'Avery Y', { onTeam: 'tem_hawks' }]
    ])
  })

  it('gives an administrator a toggle on every team row, Admin included, and none above', async function () {
    const calls = await render([profile()])
    expect(text().indexOf('TEAM ROLES')).lessThan(
      text().indexOf('SEASON ROLES')
    )
    expect(text().indexOf('SEASON ROLES')).lessThan(
      text().indexOf('LEAGUE ROLES')
    )
    // One Season section for both of the team's seasons, read-only.
    expect(text()).includes('Demo Playoffs · Demo Regular')
    expect(text()).includes(
      'Change these on Demo Playoffs, Demo Regular’s page.'
    )
    for (const role of [
      'admin',
      'coach',
      'assistant',
      'scorekeeper',
      'songkeeper',
      'videographer',
      'member'
    ])
      expect(buttonIn(rowOf('team', role)), role).not.equals(null)
    expect(
      buttonIn(rowOf('team', 'coach'))?.getAttribute('aria-checked')
    ).equals('true')
    expect(
      buttonIn(rowOf('team', 'admin'))?.getAttribute('aria-checked')
    ).equals('false')
    expect(buttonIn(rowOf('team', 'follower'))).equals(null)
    expect(rowOf('team', 'follower').textContent).includes('Not following')
    for (const level of ['season', 'league'])
      for (const role of ['admin', 'coach', 'member'])
        expect(buttonIn(rowOf(level, role)), `${level} ${role}`).equals(null)
    expect(rowOf('season', 'scorekeeper').textContent).includes('Yes')
    expect(rowOf('season', 'follower').textContent).includes('Following')
    expect(rowOf('league', 'member').textContent).includes('Yes')

    await click(buttonIn(rowOf('team', 'admin'))!)
    await click(buttonIn(rowOf('team', 'coach'))!)
    await click(
      document.querySelector<HTMLElement>('[aria-label="Confirm removal"]')!
    )
    expect(calls.changes).deep.equals([
      ['add', 'team', 'grp_one', 203, 'admin'],
      ['remove', 'team', 'grp_one', 203, 'coach']
    ])
    // Each change reads the profile again.
    expect(calls.loads).equals(3)
  })

  it('keeps Admin, and an administrator’s membership, from a coach or assistant', async function () {
    await render([
      profile({
        sections: [
          section('team', {
            editable: true,
            member: true,
            roles: ['admin']
          })
        ],
        viewer: { manages: true, admin: false }
      })
    ])
    expect(buttonIn(rowOf('team', 'admin'))).equals(null)
    expect(rowOf('team', 'admin').textContent).includes('Yes')
    expect(buttonIn(rowOf('team', 'member'))).equals(null)
    // Every staff role comes with Admin, so none is offered again.
    for (const role of [
      'coach',
      'assistant',
      'scorekeeper',
      'songkeeper',
      'videographer'
    ]) {
      expect(buttonIn(rowOf('team', role)), role).equals(null)
      expect(rowOf('team', role).textContent, role).includes('With Admin')
    }
  })

  it('reads Songkeeper as with Scorekeeper, and offers it again once Scorekeeper is taken away', async function () {
    const calls = await render([
      profile({
        sections: [
          section('team', {
            editable: true,
            member: true,
            roles: ['scorekeeper']
          }),
          section('season', { roles: ['admin'] })
        ],
        viewer: { manages: true, admin: false }
      }),
      profile({
        sections: [section('team', { editable: true, member: true })],
        viewer: { manages: true, admin: false }
      })
    ])
    expect(buttonIn(rowOf('team', 'songkeeper'))).equals(null)
    expect(rowOf('team', 'songkeeper').textContent).includes('With Scorekeeper')
    expect(
      buttonIn(rowOf('team', 'scorekeeper'))?.getAttribute('aria-checked')
    ).equals('true')
    expect(
      buttonIn(rowOf('team', 'coach'))?.getAttribute('aria-checked')
    ).equals('false')
    // A level above reads the same way: Admin there brings the rest there.
    expect(rowOf('season', 'coach').textContent).includes('With Admin')
    expect(rowOf('season', 'admin').textContent).includes('Yes')

    await click(buttonIn(rowOf('team', 'scorekeeper'))!)
    await click(
      document.querySelector<HTMLElement>('[aria-label="Confirm removal"]')!
    )
    expect(calls.changes).deep.equals([
      ['remove', 'team', 'grp_one', 203, 'scorekeeper']
    ])
    expect(rowOf('team', 'songkeeper').textContent).not.includes('With')
    expect(
      buttonIn(rowOf('team', 'songkeeper'))?.getAttribute('aria-checked')
    ).equals('false')
  })

  it('keeps a Songkeeper given as well as Scorekeeper once Scorekeeper goes', async function () {
    await render([
      profile({
        sections: [
          section('team', {
            editable: true,
            member: true,
            roles: ['songkeeper']
          })
        ]
      })
    ])
    expect(
      buttonIn(rowOf('team', 'songkeeper'))?.getAttribute('aria-checked')
    ).equals('true')
  })

  it('offers no role to somebody who cannot sign in, only their membership', async function () {
    await render([
      profile({
        person: {
          userId: 203,
          shortName: 'Nolan Q',
          fullName: null,
          avatarUrl: null,
          canHoldRoles: false
        },
        guardianOf: []
      })
    ])
    expect(text()).includes('Nolan Q can’t sign in')
    expect(text()).not.includes('PARENT/GUARDIAN OF')
    expect(buttonIn(rowOf('team', 'admin'))).equals(null)
    expect(buttonIn(rowOf('team', 'songkeeper'))).equals(null)
    // A role they hold can still be taken away.
    expect(
      buttonIn(rowOf('team', 'coach'))?.getAttribute('aria-checked')
    ).equals('true')
    expect(
      buttonIn(rowOf('team', 'member'))?.getAttribute('aria-checked')
    ).equals('true')
  })

  it('edits only a season’s own roles from the season, and the league’s are for reading', async function () {
    const calls = await render(
      [
        profile({
          context: { kind: 'season', id: 'grp_one', name: 'Demo Regular' },
          sections: [
            section('season', { editable: true }),
            section('league', { roles: ['coach'] })
          ]
        })
      ],
      { kind: 'season', failChange: true }
    )
    expect(text()).includes('Season · Demo Regular')
    expect(text()).not.includes('TEAM ROLES')
    expect(buttonIn(rowOf('league', 'coach'))).equals(null)
    await click(buttonIn(rowOf('season', 'videographer'))!)
    expect(calls.changes).deep.equals([
      ['add', 'season', 'grp_one', 203, 'videographer']
    ])
    // The server's refusal is said on the page.
    expect(document.querySelector('[role="alert"]')?.textContent).includes(
      'Only an administrator can'
    )
  })

  it('reads every row for somebody who does not manage, and says when it may not open', async function () {
    await render(
      [
        profile({
          context: { kind: 'league', id: 'grp_one', name: 'Demo League' },
          sections: [section('league', { member: true })],
          viewer: { manages: false, admin: false }
        })
      ],
      { kind: 'league' }
    )
    expect(text()).includes('League · Demo League')
    expect(
      document.querySelectorAll('[data-testid^="role-"] [role="switch"]')
    ).length(0)
    await act(async () => {
      root?.unmount()
    })
    await render([new HttpError('notFound', 'Not found')])
    expect(text()).includes('You can’t open this person here.')
  })
})
