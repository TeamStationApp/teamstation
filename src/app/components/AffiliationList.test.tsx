import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  type AccountAffiliationGroup,
  type AccountAffiliations,
  asAccountAffiliations,
  type TeamStationClient
} from '../../common/api'
import type { GroupRef } from '../../common/groupCreation'
import { userIdOfGumbo } from '../../common/userId'
import { ThemeProvider } from '../theme/ThemeContext'
import { AffiliationList, affiliationPills } from './AffiliationList'
import { SceneShownProvider } from './sceneShown'

/**
 * The account screen's Affiliations: one row per league, season and team the
 * person belongs to directly, and per player they guard, each with pills for
 * what they are there and a chevron that opens it. A row they only follow
 * carries Following, which stops the follow once confirmed.
 */
describe('the account’s affiliations', function () {
  let root: Root | undefined
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    document.body.replaceChildren()
  })

  const delay = async (ms = 20): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, ms))
  }
  const text = (): string => document.body.textContent ?? ''
  const button = (label: string): HTMLElement | undefined =>
    [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
      node => (node.getAttribute('aria-label') ?? node.textContent) === label
    )
  const press = async (label: string): Promise<void> => {
    const node = button(label)
    expect(node, label).not.equals(undefined)
    await act(async () => {
      node!.click()
      await delay()
    })
  }

  const group = (
    kind: AccountAffiliationGroup['kind'],
    id: string,
    name: string,
    ties: Partial<AccountAffiliationGroup> = {}
  ): Record<string, unknown> => ({
    kind,
    id,
    group: {
      id,
      kind,
      name,
      imageUrl: null,
      locality: null,
      parentNames: kind === 'team' ? ['Demo Regular'] : []
    },
    roles: [],
    ...ties
  })
  const answer: AccountAffiliations = asAccountAffiliations({
    groups: [
      group('league', 'lea_a', 'Demo League A', { roles: ['admin'] }),
      group('season', 'sea_regular', 'Demo Regular', {
        roles: ['coach', 'scorekeeper']
      }),
      group('team', 'tem_hawks', 'Demo Hawks', {
        roles: ['coach'],
        headCoach: true,
        player: true
      }),
      group('team', 'tem_owls', 'Demo Owls', { member: true }),
      group('team', 'tem_eagles', 'Demo Eagles', { following: true }),
      group('season', 'sea_playoffs', 'Demo Playoffs', {
        member: true,
        following: true
      })
    ],
    players: [
      {
        userId: userIdOfGumbo(400),
        name: 'Mookie B',
        avatarUrl: null,
        teamNames: ['Demo Hawks', 'Demo Owls']
      }
    ]
  })

  const mount = async (
    client: Partial<TeamStationClient>
  ): Promise<{ groups: GroupRef[]; players: unknown[] }> => {
    const groups: GroupRef[] = []
    const players: unknown[] = []
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <AffiliationList
            client={client as TeamStationClient}
            onOpenGroup={ref => {
              groups.push(ref)
            }}
            onOpenPlayer={(userId, name) => {
              players.push([userId, name])
            }}
          />
        </ThemeProvider>
      )
      await delay()
    })
    return { groups, players }
  }

  it('names what the person is on each group, and Spectator only without anything else', () => {
    const pills = answer.groups.map(affiliationPills)
    expect(pills).deep.equals([
      ['Admin'],
      ['Coach', 'Scorekeeper'],
      ['Manager/Head Coach', 'Player'],
      ['Spectator'],
      [],
      ['Spectator']
    ])
  })

  it('lists a row per group and per guarded player, each opening its page', async () => {
    const opened = await mount({ accountAffiliations: async () => answer })
    expect(text()).includes('AFFILIATIONS7')
    expect(text()).includes('Demo League AAdmin')
    expect(text()).includes('Demo RegularCoachScorekeeper')
    expect(text()).includes('Demo HawksDemo RegularManager/Head CoachPlayer')
    expect(text()).includes('Mookie BDemo Hawks, Demo OwlsGuardian')
    // Following is a pill only on the row that does nothing else.
    expect(
      document.querySelectorAll('[data-testid="affiliation-following"]')
    ).length(1)
    expect(button('Following Demo Eagles')).not.equals(undefined)
    await press('Open Demo League A')
    await press('Open Demo Eagles')
    await press('Open Mookie B')
    expect(opened.groups).deep.equals([
      { kind: 'league', id: 'lea_a' },
      { kind: 'team', id: 'tem_eagles' }
    ])
    expect(opened.players).deep.equals([[userIdOfGumbo(400), 'Mookie B']])
  })

  it('stops a follow only once confirmed, and keeps the row while it fails', async () => {
    const unfollowed: GroupRef[] = []
    let refuse = true
    await mount({
      // As the server answers: without what has been unfollowed.
      accountAffiliations: async () => ({
        ...answer,
        groups: answer.groups.filter(
          group => !unfollowed.some(ref => ref.id === group.id)
        )
      }),
      unfollow: async (ref: GroupRef) => {
        if (refuse) throw new Error('No connection')
        unfollowed.push(ref)
      }
    })
    await press('Following Demo Eagles')
    expect(text()).includes('Stop following Demo Eagles?')
    expect(text()).includes(
      'Demo Eagles leaves your Home and its updates stop.'
    )
    await press('Cancel')
    expect(text()).not.includes('Stop following Demo Eagles?')
    expect(text()).includes('Demo Eagles')
    await press('Following Demo Eagles')
    await press('Stop Following')
    expect(text()).includes('No connection')
    expect(button('Following Demo Eagles')).not.equals(undefined)
    expect(unfollowed).deep.equals([])
    refuse = false
    await press('Stop Following')
    expect(unfollowed).deep.equals([{ kind: 'team', id: 'tem_eagles' }])
    expect(button('Following Demo Eagles')).equals(undefined)
    expect(text()).not.includes('Demo Eagles')
    expect(text()).includes('AFFILIATIONS6')
  })

  it('says when a reload on coming back fails, above the rows it last read', async () => {
    let fail = false
    const client = {
      accountAffiliations: async () => {
        if (fail) throw new Error('Affiliations are offline')
        return answer
      }
    } as unknown as TeamStationClient
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const show = async (shown: boolean): Promise<void> => {
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <SceneShownProvider value={shown}>
              <AffiliationList client={client} />
            </SceneShownProvider>
          </ThemeProvider>
        )
        await delay()
      })
    }
    await show(true)
    expect(text()).includes('Demo League A')
    expect(text()).not.includes('offline')
    fail = true
    await show(false)
    await show(true)
    expect(text()).includes('Affiliations are offline')
    expect(text()).includes('Demo League A')
    fail = false
    await show(false)
    await show(true)
    expect(text()).not.includes('offline')
  })

  it('keeps an unfollowed row gone when a read begun before the unfollow answers after it', async () => {
    let slow: ((found: AccountAffiliations) => void) | undefined
    let reads = 0
    const client = {
      accountAffiliations: async () => {
        reads++
        if (reads === 1) return answer
        if (reads === 3)
          return {
            ...answer,
            groups: answer.groups.filter(group => group.id !== 'tem_eagles')
          }
        return await new Promise<AccountAffiliations>(resolve => {
          slow = resolve
        })
      },
      unfollow: async () => undefined
    } as unknown as TeamStationClient
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const show = async (shown: boolean): Promise<void> => {
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <SceneShownProvider value={shown}>
              <AffiliationList client={client} />
            </SceneShownProvider>
          </ThemeProvider>
        )
        await delay()
      })
    }
    await show(true)
    // Coming back starts a read that answers late, with the follow in it.
    await show(false)
    await show(true)
    expect(slow).not.equals(undefined)
    await press('Following Demo Eagles')
    await press('Stop Following')
    expect(button('Following Demo Eagles')).equals(undefined)
    // The unfollow read again, behind the late one.
    expect(reads).equals(3)
    await act(async () => {
      slow!(answer)
      await delay()
    })
    expect(button('Following Demo Eagles')).equals(undefined)
    expect(text()).not.includes('Demo Eagles')
  })

  it('says it is loading, why it failed, and draws only the header with none', async () => {
    let finish: (found: AccountAffiliations) => void = () => undefined
    await mount({
      accountAffiliations: async () =>
        await new Promise<AccountAffiliations>(resolve => {
          finish = resolve
        })
    })
    expect(text()).equals('AFFILIATIONSLoading…')
    await act(async () => {
      finish({ groups: [], players: [] })
      await delay()
    })
    expect(text()).equals('AFFILIATIONS0')
    expect(
      document.querySelector('[data-testid="relationship-action-row"]')
    ).equals(null)
    await act(async () => {
      root?.unmount()
    })
    await mount({
      accountAffiliations: async () => {
        throw new Error('Affiliations are offline')
      }
    })
    expect(text()).equals('AFFILIATIONSAffiliations are offline')
    await act(async () => {
      root?.unmount()
    })
    await mount({
      accountAffiliations: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'gone'
      }
    })
    expect(text()).includes('Affiliations could not load.')
  })
})
