import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asRosterEntry, TeamStationClient } from '../../common/api'
import type { GroupRef } from '../../common/groupCreation'
import type { ParentAction, ParentPreview } from '../../common/groupLinks'
import {
  asGroupDetail,
  asPublicGroup,
  type PublicGroup
} from '../../common/publicGroups'
import { userIdOfGumbo } from '../../common/userId'
import { ScopedThemeProvider, ThemeProvider } from '../theme/ThemeContext'
import { tsDark } from '../theme/tsDark'
import type { GroupLinkChoice } from './GroupScreen'
import { GroupScreen } from './GroupScreen'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.replaceChildren()
})
async function mount(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
}
function button(label: string): HTMLElement | undefined {
  return [
    ...document.querySelectorAll<HTMLElement>('[role="button"], [role="tab"]')
  ].find(
    node => (node.getAttribute('aria-label') ?? node.textContent) === label
  )
}
async function press(label: string): Promise<void> {
  const node = button(label)
  expect(node, label).not.equals(undefined)
  await act(async () => {
    node!.click()
    // The ⋮ menu places itself from a measurement that answers a frame later.
    await new Promise(resolve => setTimeout(resolve, 50))
  })
}

const league = asPublicGroup({
  id: 'league_demo',
  kind: 'league',
  name: 'Demo League',
  imageUrl: null,
  locality: null
})
const season = (
  id: string,
  name: string,
  startsOn: string,
  endsOn: string
): PublicGroup =>
  asPublicGroup({
    id,
    kind: 'season',
    name,
    imageUrl: null,
    locality: null,
    startsOn,
    endsOn
  })
const team = (id: string, name: string, external = false): PublicGroup =>
  asPublicGroup({
    id,
    kind: 'team',
    name,
    imageUrl: null,
    locality: null,
    external
  })
const detail = asGroupDetail({
  nonMemberView: false,
  group: league,
  parents: [],
  children: [
    season('season_old', 'Demo Fall', '2025-09-01', '2025-11-30'),
    season('season_new', 'Demo Spring', '2026-03-01', '2026-05-31'),
    season('season_custom', 'Demo Classic', '2025-12-26', '2025-12-28'),
    team('team_hawks', 'Demo Hawks')
  ],
  participatingSeasons: [],
  competingTeams: [],
  keptTeams: [team('team_kept', 'Demo Placeholder', true)],
  teamSeasons: [
    { teamId: 'team_hawks', seasonIds: ['season_new', 'season_old'] }
  ],
  staff: [],
  games: [
    {
      id: 'game_demo',
      homeTeam: { id: 'team_hawks', name: 'Demo Hawks' },
      awayTeam: { id: 'team_kept', name: 'Demo Placeholder' },
      seasonId: 'season_new',
      startAt: '2026-04-01T18:00:00Z',
      venue: null,
      status: 'final',
      homeScore: 3,
      awayScore: 2,
      cancellationReason: null,
      withdrawnByTeamId: null
    }
  ],
  canManage: true,
  canViewPrivate: true,
  canManagePeople: true,
  canSeePeople: true
})

function render(
  api: TeamStationClient,
  opened: GroupRef[],
  links: GroupLinkChoice[] = [],
  created: string[] = []
): React.ReactElement {
  return (
    <GroupScreen
      client={api}
      groupRef={{ kind: 'league', id: league.id }}
      onOpen={group => opened.push(group)}
      onCreate={kind => created.push(kind)}
      onCreateExternal={() => created.push('placeholder')}
      onSettings={() => {}}
      onLink={choice => links.push(choice)}
      onPrivate={() => {}}
    />
  )
}

describe('the league page', () => {
  for (const count of [0, 1, 2]) {
    it(`shares one team card with dividers only between its ${count} rows`, async () => {
      const api = new TeamStationClient({ baseUrl: '/api/v1' })
      const hawks = team('team_hawks', 'Demo Hawks')
      const owls = team('team_owls', 'Demo Owls', true)
      api.group = async () => ({
        ...detail,
        children: count === 0 ? [] : [hawks],
        // A kept team can also be a child: show it only once.
        keptTeams: count === 0 ? [] : count === 1 ? [hawks] : [owls, hawks]
      })
      await mount(render(api, []))
      await press('Teams')
      const cards = document.querySelectorAll<HTMLElement>(
        '[data-testid="league-teams-card"]'
      )
      expect(cards).length(1)
      const card = cards[0]
      const rows = card.querySelectorAll<HTMLElement>(
        '[data-testid="relationship-action-row"]'
      )
      expect(rows).length(count)
      expect(card.children).length(Math.max(0, count * 2 - 1))
      if (count === 0) {
        expect(getComputedStyle(card).backgroundColor).equals(
          'rgba(0, 0, 0, 0)'
        )
        expect(document.body.textContent).includes(
          'No teams in this league yet.'
        )
      } else {
        expect(getComputedStyle(card).backgroundColor).equals(
          'rgb(255, 255, 255)'
        )
        expect(getComputedStyle(card).padding).equals('0px')
        expect(
          parseFloat(getComputedStyle(card).borderTopLeftRadius)
        ).greaterThan(0)
        expect(rows[0].textContent).includes('Demo Hawks')
        for (const row of rows) {
          expect(row.parentElement).equals(card)
          expect(getComputedStyle(row).backgroundColor).equals(
            'rgba(0, 0, 0, 0)'
          )
        }
        if (count === 2) {
          expect(rows[1].textContent).includes('Demo Owls')
          expect(rows[1].textContent).includes('Placeholder team')
          expect(button('Leave Demo Owls from Demo League')).equals(undefined)
          expect(getComputedStyle(card.children[1]).height).equals('1px')
        }
        expect(card.contains(button('Add team')!)).equals(false)
        expect(card.contains(button('Create team')!)).equals(false)
      }
    })
  }
  it('shows team locality and opens the selected team from its identity', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    api.group = async () => ({
      ...detail,
      children: [
        {
          ...team('team_hawks', 'Demo Hawks'),
          locality: {
            city: 'Demo City',
            region: 'Demo Region',
            country: 'Demo Country',
            placeId: null,
            timezone: 'America/Los_Angeles'
          }
        }
      ]
    })
    const opened: GroupRef[] = []
    await mount(render(api, opened))
    await press('Teams')
    const card = document.querySelector('[data-testid="league-teams-card"]')!
    expect(card.textContent).includes('Demo City, Demo Region, Demo Country')
    await press('Open Demo Hawks')
    expect(opened).deep.equals([{ kind: 'team', id: 'team_hawks' }])
  })
  it('keeps dark-theme team names readable on the shared surface', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    api.group = async () => detail
    await mount(
      <ScopedThemeProvider theme={tsDark}>
        {render(api, [])}
      </ScopedThemeProvider>
    )
    await press('Teams')
    const card = document.querySelector<HTMLElement>(
      '[data-testid="league-teams-card"]'
    )!
    const title = [...card.querySelectorAll<HTMLElement>('*')].find(
      node => node.children.length === 0 && node.textContent === 'Demo Hawks'
    )!
    expect(getComputedStyle(title).color).equals('rgb(31, 36, 24)')
    const seasonLabel = [...card.querySelectorAll<HTMLElement>('*')].find(
      node => node.children.length === 0 && node.textContent === 'Demo Spring'
    )!
    const leaveLabel = [...card.querySelectorAll<HTMLElement>('*')].find(
      node => node.children.length === 0 && node.textContent === 'Leave'
    )!
    expect(getComputedStyle(seasonLabel).color).equals('rgb(31, 36, 24)')
    expect(getComputedStyle(leaveLabel).color).equals('rgb(186, 26, 26)')
    expect(getComputedStyle(title).color).not.equals(
      getComputedStyle(card).backgroundColor
    )
  })
  it('lists seasons newest first by time frame, with no schedule', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    api.group = async () => detail
    const opened: GroupRef[] = []
    const links: GroupLinkChoice[] = []
    const created: string[] = []
    await mount(render(api, opened, links, created))
    const text = document.body.textContent ?? ''
    expect(text).not.includes('Schedule and results')
    expect(text).not.includes('Demo Hawks at')
    for (const label of ['Seasons', 'Teams', 'People'])
      expect(button(label), label).not.equals(undefined)
    for (const gone of [
      'Add Team',
      'Create Team',
      'Add Season',
      'Create Season',
      'Create placeholder team'
    ])
      expect(button(gone), gone).equals(undefined)
    const order = ['Demo Spring', 'Demo Classic', 'Demo Fall'].map(name =>
      text.indexOf(name)
    )
    expect(order).deep.equals([...order].sort((a, b) => a - b))
    expect(text).includes('Spring 2026')
    expect(text).includes('Fall 2025')
    expect(text).not.includes('Mar 1, 2026')
    expect(text).includes('Dec 26, 2025')
    await press('Open Demo Spring')
    expect(opened.at(-1)).deep.equals({ kind: 'season', id: 'season_new' })
    await press('Add season')
    expect(links.at(-1)).deep.include({
      targetKind: 'season',
      relationship: 'parent',
      direction: 'children'
    })
    await press('Create season')
    expect(created.at(-1)).equals('season')
  })
  it('shows each team with its league seasons and confirms a row Leave action', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    let loads = 0
    api.group = async () => {
      loads++
      return detail
    }
    const asked: ParentAction[][] = []
    let applied: ParentPreview | undefined
    api.parentPreview = async actions => {
      asked.push(actions)
      return {
        actions,
        effects: [
          ...actions,
          {
            operation: 'detach',
            child: { kind: 'team', id: 'team_hawks' },
            parent: { kind: 'season', id: 'season_new' }
          }
        ],
        expected: {},
        explanation: [
          'Remove Demo League as parent of Demo Hawks',
          'Remove Demo Spring as parent of Demo Hawks',
          'Only management permissions change.',
          'Demo Spring reference time frame: Mar 1, 2026 – May 31, 2026 (UTC).'
        ]
      }
    }
    api.changeParents = async preview => {
      applied = preview
    }
    const opened: GroupRef[] = []
    const created: string[] = []
    await mount(render(api, opened, [], created))
    await press('Teams')
    const text = document.body.textContent ?? ''
    expect(text).includes('Demo Hawks')
    expect(text).includes('Demo Placeholder')
    expect(text).includes('Placeholder team')
    expect(button('More for Demo Placeholder')).equals(undefined)
    await press('Open Demo Fall')
    expect(opened.at(-1)).deep.equals({ kind: 'season', id: 'season_old' })
    await press('Create team')
    await press('Placeholder team')
    expect(created.at(-1)).equals('placeholder')

    await press('Leave Demo Hawks from Demo League')
    expect(asked.at(-1)).deep.equals([
      {
        operation: 'detach',
        child: { kind: 'team', id: 'team_hawks' },
        parent: { kind: 'league', id: league.id }
      }
    ])
    const lines = [...document.querySelectorAll('div[dir="auto"]')].map(
      node => node.textContent
    )
    const first = lines.indexOf('Remove Demo League as parent of Demo Hawks')
    const title = lines.indexOf('Review relationship changes')
    expect(first).greaterThan(-1)
    expect(first).lessThan(title)
    expect(
      lines.indexOf('Remove Demo Spring as parent of Demo Hawks')
    ).lessThan(title)
    expect(lines.indexOf('Only management permissions change.')).greaterThan(
      title
    )
    const before = loads
    await press('Break relationship')
    expect(applied?.actions).deep.equals(asked.at(-1))
    expect(loads).greaterThan(before)
    expect(document.body.textContent).not.includes(
      'Review relationship changes'
    )
  })
  it('reviews a season row departure and cancels without applying it', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    api.group = async () => detail
    const asked: ParentAction[][] = []
    api.parentPreview = async actions => {
      asked.push(actions)
      return {
        actions,
        effects: actions,
        expected: {},
        explanation: ['Only management permissions change.']
      }
    }
    let writes = 0
    api.changeParents = async () => {
      writes++
    }
    await mount(render(api, []))
    await press('Leave Demo Spring from Demo League')
    expect(asked).length(1)
    expect(asked[0][0].child).deep.equals({ kind: 'season', id: 'season_new' })
    await press('Cancel')
    expect(writes).equals(0)
  })
  it('keeps the relationship and hides management from a visitor', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    api.group = async () => ({
      ...detail,
      canManage: false,
      canManagePeople: false,
      canSeePeople: false
    })
    await mount(render(api, []))
    expect(button('People')).equals(undefined)
    expect(button('Add season')).equals(undefined)
    expect(button('More for Demo Spring')).equals(undefined)
    await press('Teams')
    expect(button('Create team')).equals(undefined)
    expect(button('More for Demo Hawks')).equals(undefined)
    expect(button('Leave Demo Hawks from Demo League')).equals(undefined)
    expect(
      document.querySelector('[data-testid="relationship-action-divider"]')
    ).equals(null)
    expect(
      getComputedStyle(
        document.querySelector('[data-testid="league-teams-card"]')!
      ).backgroundColor
    ).equals('rgb(255, 255, 255)')
  })
})

describe('a league’s People tab', () => {
  it('lists its people and opens a player’s page and anybody else’s profile', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    api.group = async () => detail
    api.levelPeople = async (kind, id) => {
      expect([kind, id]).deep.equals(['league', league.id])
      return {
        people: [
          asRosterEntry({
            userId: userIdOfGumbo(201),
            gumboId: 201,
            shortName: 'Alfonso S',
            jersey: null,
            positions: [],
            isPlayer: true,
            role: 'member',
            section: 'player',
            staffRoles: [],
            inheritedFrom: null
          }),
          asRosterEntry({
            userId: userIdOfGumbo(271),
            gumboId: 271,
            shortName: 'Leo G',
            jersey: null,
            positions: [],
            isPlayer: false,
            role: 'member',
            section: 'spectator',
            staffRoles: [],
            inheritedFrom: null
          })
        ],
        manages: true,
        admin: true
      }
    }
    const players: unknown[] = []
    const persons: unknown[] = []
    await mount(
      <GroupScreen
        client={api}
        groupRef={{ kind: 'league', id: league.id }}
        initialTab="people"
        onOpen={() => {}}
        onCreate={() => {}}
        onSettings={() => {}}
        onLink={() => {}}
        onPrivate={() => {}}
        onOpenPlayer={(userId, name) => {
          players.push([userId, name])
        }}
        onOpenPerson={(group, userId) => {
          persons.push([group, userId])
        }}
      />
    )
    for (const name of ['Alfonso S', 'Leo G']) {
      const row = [
        ...document.querySelectorAll<HTMLElement>('[role="button"]')
      ].find(node => node.textContent?.includes(name) === true)
      expect(row, name).not.equals(undefined)
      await act(async () => {
        row!.click()
        await new Promise(resolve => setTimeout(resolve, 20))
      })
    }
    expect(players).deep.equals([[userIdOfGumbo(201), 'Alfonso S']])
    expect(persons).deep.equals([
      [{ kind: 'league', id: league.id }, userIdOfGumbo(271)]
    ])
  })
})
