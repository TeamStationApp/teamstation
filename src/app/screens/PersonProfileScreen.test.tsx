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
import { userIdOfGumbo } from '../../common/userId'
import { CoverableScene, coverAndReveal } from '../../test/coverableScene'
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
    player: false,
    ...fields
  }
}

function profile(fields: Partial<PersonProfile> = {}): PersonProfile {
  return asPersonProfile({
    context: { kind: 'team', id: 'tem_hawks', name: 'Demo Hawks' },
    person: {
      userId: userIdOfGumbo(203),
      gumboId: 203,
      shortName: 'Pat N',
      fullName: 'Pat Neshek',
      avatarUrl: null,
      canHoldRoles: true
    },
    guardianOf: [
      {
        userId: userIdOfGumbo(202),
        gumboId: 202,
        shortName: 'Alex Y',
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
  changes: Array<[string, string, string, string, string]>
  stepped: Array<[string, string, string]>
  left: Array<[string, string]>
  players: unknown[]
  loads: number
}

async function render(
  answers: Array<PersonProfile | Error>,
  options: {
    kind?: 'team' | 'season' | 'league'
    failChange?: boolean
    staleManager?: boolean
  } = {}
): Promise<Calls> {
  const calls: Calls = {
    changes: [],
    stepped: [],
    left: [],
    players: [],
    loads: 0
  }
  const kind = options.kind ?? 'team'
  const client = {
    personProfile: async (asked: string, id: string, userId: string) => {
      expect([asked, id, userId]).deep.equals([
        kind,
        'grp_one',
        userIdOfGumbo(203)
      ])
      const answer = answers[Math.min(calls.loads, answers.length - 1)]
      calls.loads++
      if (answer instanceof Error) throw answer
      return answer
    },
    addRole: async (k: string, id: string, userId: string, role: string) => {
      calls.changes.push(['add', k, id, userId, role])
      if (options.staleManager === true)
        throw new HttpError('conflict', 'Manager changed')
      if (options.failChange === true)
        throw new HttpError('forbidden', 'Only an administrator can')
      return { userId, roles: [], member: true }
    },
    removeRole: async (k: string, id: string, userId: string, role: string) => {
      calls.changes.push(['remove', k, id, userId, role])
      return { userId, roles: [], member: false }
    },
    stepDown: async (k: string, id: string, role: string) => {
      calls.stepped.push([k, id, role])
      if (options.failChange === true)
        throw new HttpError('forbidden', 'A coach has to give this back')
      return { userId: userIdOfGumbo(203), roles: [], member: true }
    },
    leaveGroup: async (k: string, id: string) => {
      calls.left.push([k, id])
      return { removed: true }
    }
  } as unknown as TeamStationClient
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <CoverableScene>
          <PersonProfileScreen
            client={client}
            kind={kind}
            id="grp_one"
            userId={userIdOfGumbo(203)}
            onOpenPlayer={(userId, name, from) => {
              calls.players.push([userId, name, from])
            }}
          />
        </CoverableScene>
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

  it('reads the person again in place on coming back from their player page', async function () {
    const calls = await render([profile()])
    expect(calls.loads).equals(1)
    const before = document.body.textContent
    await coverAndReveal()
    expect(calls.loads).equals(2)
    expect(document.body.textContent).equals(before)
  })

  it('puts the photo, the whole name and the level it is for in the hero, then the players they guard', async function () {
    const calls = await render([profile()])
    expect(text()).includes('Pat Neshek')
    expect(text()).includes('Team · Demo Hawks')
    expect(text().indexOf('PARENT/GUARDIAN OF')).lessThan(
      text().indexOf('TEAM ROLES')
    )
    const child = [
      ...document.querySelectorAll<HTMLElement>('[role="button"]')
    ].find(node => node.textContent?.includes('Alex Y') === true)
    await click(child!)
    expect(calls.players).deep.equals([
      [userIdOfGumbo(202), 'Alex Y', { onTeam: 'tem_hawks' }]
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
      ['add', 'team', 'grp_one', userIdOfGumbo(203), 'admin'],
      ['remove', 'team', 'grp_one', userIdOfGumbo(203), 'coach']
    ])
    // Each change reads the profile again.
    expect(calls.loads).equals(3)
  })

  it('refreshes the incumbent when another manager has changed it', async () => {
    const calls = await render([profile()], { staleManager: true })
    await click(buttonIn(rowOf('team', 'headCoach'))!)
    expect(calls.loads).equals(2)
    expect(text()).includes('Manager changed')
  })
  it('asks before replacing the team head coach and keeps cancellation local', async () => {
    const calls = await render([
      profile({
        sections: [
          section('team', {
            editable: true,
            headCoach: { userId: userIdOfGumbo(202), name: 'Alex Young' }
          })
        ]
      })
    ])
    const toggle = buttonIn(rowOf('team', 'headCoach'))!
    await click(toggle)
    expect(text()).includes('Alex Young')
    await click(
      document.querySelector<HTMLElement>('[aria-label="Cancel confirmation"]')!
    )
    expect(calls.changes).length(0)
    await click(toggle)
    await click(
      document.querySelector<HTMLElement>('[aria-label="Confirm replacement"]')!
    )
    expect(calls.changes).deep.equals([
      ['add', 'team', 'grp_one', userIdOfGumbo(203), 'headCoach']
    ])
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
        viewer: { manages: true, admin: false, self: false }
      })
    ])
    expect(buttonIn(rowOf('team', 'admin'))).equals(null)
    expect(rowOf('team', 'admin').textContent).includes('Yes')
    expect(buttonIn(rowOf('team', 'member'))).equals(null)
    // Staff assignments remain editable; only Admin and membership are guarded.
    for (const role of [
      'coach',
      'assistant',
      'scorekeeper',
      'songkeeper',
      'videographer'
    ]) {
      expect(
        buttonIn(rowOf('team', role))?.getAttribute('aria-checked'),
        role
      ).equals('false')
    }
  })

  it('offers an explicit Songkeeper assignment while Scorekeeper is held', async function () {
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
        viewer: { manages: true, admin: false, self: false }
      }),
      profile({
        sections: [section('team', { editable: true, member: true })],
        viewer: { manages: true, admin: false, self: false }
      })
    ])
    expect(
      buttonIn(rowOf('team', 'songkeeper'))?.getAttribute('aria-checked')
    ).equals('false')
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
      ['remove', 'team', 'grp_one', userIdOfGumbo(203), 'scorekeeper']
    ])
    expect(rowOf('team', 'songkeeper').textContent).not.includes('With')
    expect(
      buttonIn(rowOf('team', 'songkeeper'))?.getAttribute('aria-checked')
    ).equals('false')
  })

  for (const role of [
    'coach',
    'assistant',
    'scorekeeper',
    'songkeeper',
    'videographer'
  ] as const)
    it(`adds and removes explicit ${role} while preserving Admin`, async () => {
      const answers = [false, true, false].map(held =>
        profile({
          sections: [
            section('team', {
              editable: true,
              member: true,
              roles: held ? ['admin', role] : ['admin']
            })
          ]
        })
      )
      const calls = await render(answers)
      const toggle = (): HTMLElement => buttonIn(rowOf('team', role))!
      expect(toggle().getAttribute('aria-checked')).equals('false')
      await click(toggle())
      expect(toggle().getAttribute('aria-checked')).equals('true')
      await click(toggle())
      expect(calls.changes).has.length(1)
      await click(
        document.querySelector<HTMLElement>('[aria-label="Confirm removal"]')!
      )
      expect(toggle().getAttribute('aria-checked')).equals('false')
      expect(
        buttonIn(rowOf('team', 'admin'))?.getAttribute('aria-checked')
      ).equals('true')
      expect(calls.changes).deep.equals([
        ['add', 'team', 'grp_one', userIdOfGumbo(203), role],
        ['remove', 'team', 'grp_one', userIdOfGumbo(203), role]
      ])
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
          userId: userIdOfGumbo(203),
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
      ['add', 'season', 'grp_one', userIdOfGumbo(203), 'videographer']
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
          viewer: { manages: false, admin: false, self: false }
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

  it('steps down from a role you hold on the level you opened, and leaves a refusal in the sheet', async function () {
    const calls = await render(
      [
        profile({
          viewer: { manages: false, admin: false, self: true },
          sections: [
            section('team', {
              roles: ['scorekeeper', 'coach'],
              member: true
            }),
            section('season', { roles: ['videographer'] })
          ]
        })
      ],
      { failChange: true }
    )
    expect(buttonIn(rowOf('team', 'scorekeeper'))).equals(null)
    const step = rowOf('team', 'scorekeeper').querySelector<HTMLElement>(
      '[aria-label="Step down as Scorekeeper"]'
    )
    expect(step).not.equals(null)
    expect(
      rowOf('team', 'admin').querySelector('[aria-label^="Step down"]')
    ).equals(null)
    expect(rowOf('team', 'admin').textContent).includes('\u2014')
    expect(
      rowOf('team', 'assistant').querySelector('[aria-label^="Step down"]')
    ).equals(null)
    expect(rowOf('team', 'assistant').textContent).includes('\u2014')
    // Held only because Scorekeeper grants it.
    expect(rowOf('team', 'songkeeper').textContent).includes('With Scorekeeper')
    expect(
      rowOf('team', 'songkeeper').querySelector('[aria-label^="Step down"]')
    ).equals(null)
    expect(
      rowOf('season', 'videographer').querySelector('[aria-label^="Step down"]')
    ).equals(null)
    await click(step!)
    expect(text()).includes('Step down as Scorekeeper?')
    expect(text()).includes(
      'An administrator, a coach, or an assistant has to give this back.'
    )
    await click(
      document.querySelector<HTMLElement>('[aria-label="Cancel confirmation"]')!
    )
    expect(calls.stepped).deep.equals([])
    await click(step!)
    await click(
      document.querySelector<HTMLElement>(
        '[aria-label="Confirm change"] [aria-label="Step Down"]'
      )!
    )
    expect(calls.stepped).deep.equals([['team', 'grp_one', 'scorekeeper']])
    expect(text()).includes('A coach has to give this back')
    expect(document.querySelector('[aria-label="Confirm change"]')).not.equals(
      null
    )
  })

  it('reads a held Admin as Yes, with no Step Down', async function () {
    await render([
      profile({
        viewer: { manages: false, admin: false, self: true },
        sections: [section('team', { roles: ['admin'] })]
      })
    ])
    expect(rowOf('team', 'admin').textContent).includes('Yes')
    expect(
      rowOf('team', 'admin').querySelector('[aria-label^="Step down"]')
    ).equals(null)
    expect(
      rowOf('team', 'songkeeper').querySelector('[aria-label^="Step down"]')
    ).equals(null)
  })

  it('gives an explicit Songkeeper its own Step Down beside Scorekeeper', async function () {
    await render([
      profile({
        viewer: { manages: false, admin: false, self: true },
        sections: [section('team', { roles: ['scorekeeper', 'songkeeper'] })]
      })
    ])
    expect(
      rowOf('team', 'songkeeper').querySelector(
        '[aria-label="Step down as Songkeeper"]'
      )
    ).not.equals(null)
  })

  it('leaves the level from Member, and reads Player with no Step Down on a player membership', async function () {
    const calls = await render([
      profile({
        viewer: { manages: false, admin: false, self: true },
        sections: [
          section('team', {
            member: true,
            player: true,
            roles: ['videographer']
          })
        ]
      })
    ])
    expect(rowOf('team', 'member').textContent).includes('Player')
    expect(
      rowOf('team', 'member').querySelector('[aria-label^="Step down"]')
    ).equals(null)
    await click(
      rowOf('team', 'videographer').querySelector<HTMLElement>(
        '[aria-label="Step down as Videographer"]'
      )!
    )
    expect(text()).includes('Step down as Videographer?')
    await act(async () => {
      root?.unmount()
    })
    const leaving = await render([
      profile({
        viewer: { manages: false, admin: false, self: true },
        sections: [section('team', { member: true })]
      })
    ])
    await click(
      rowOf('team', 'member').querySelector<HTMLElement>(
        '[aria-label="Step down as Member"]'
      )!
    )
    expect(text()).includes('Leave Demo team?')
    expect(text()).includes('lose every role held directly there')
    await click(
      document.querySelector<HTMLElement>(
        '[aria-label="Confirm change"] [aria-label="Step Down"]'
      )!
    )
    expect(leaving.left).deep.equals([['team', 'grp_one']])
    expect(calls.left).deep.equals([])
  })

  it('keeps the Member switch when a manager opens a player', async function () {
    await render([
      profile({
        viewer: { manages: true, admin: false, self: false },
        sections: [
          section('team', {
            editable: true,
            member: true,
            player: true,
            roles: ['scorekeeper']
          })
        ]
      })
    ])
    const member = rowOf('team', 'member')
    expect(member.textContent).not.includes('Player')
    expect(buttonIn(member)?.getAttribute('role')).equals('switch')
  })

  it('keeps a manager’s switches, including on their own profile', async function () {
    await render([
      profile({
        viewer: { manages: true, admin: true, self: true }
      })
    ])
    expect(document.querySelector('[aria-label^="Step down"]')).equals(null)
    expect(
      buttonIn(rowOf('team', 'coach'))?.getAttribute('aria-checked')
    ).equals('true')
  })
})
