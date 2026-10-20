import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asRosterEntry,
  asTeamSummary,
  TeamStationClient
} from '../../common/api'
import type { GroupRef } from '../../common/groupCreation'
import type { ParentAction } from '../../common/groupLinks'
import {
  asGroupDetail,
  asPublicGroup,
  type PublicGroup
} from '../../common/publicGroups'
import { userIdOfGumbo } from '../../common/userId'
import { ThemeProvider } from '../theme/ThemeContext'
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
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
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
    await new Promise(resolve => setTimeout(resolve, 50))
  })
}

const season = asPublicGroup({
  id: 'season_demo',
  kind: 'season',
  name: 'Demo Spring',
  imageUrl: null,
  locality: null,
  startsOn: '2026-03-01',
  endsOn: '2026-05-31'
})
const team = (id: string, name: string): PublicGroup =>
  asPublicGroup({
    id,
    kind: 'team',
    name,
    imageUrl: null,
    locality: {
      city: 'Demo City',
      region: 'Demo Region',
      country: 'US',
      placeId: null,
      timezone: 'America/Chicago'
    }
  })
const detail = asGroupDetail({
  nonMemberView: false,
  group: season,
  parents: [],
  children: [team('team_hawks', 'Demo Hawks')],
  participatingSeasons: [],
  competingTeams: [
    team('team_hawks', 'Demo Hawks'),
    team('team_eagles', 'Demo Eagles')
  ],
  staff: [],
  games: [],
  canManage: true,
  canViewPrivate: true
})
const summary = (id: string, name: string): ReturnType<typeof asTeamSummary> =>
  asTeamSummary({
    id,
    name,
    shortName: null,
    logoPath: null,
    logoUrl: null,
    canViewPrivate: true,
    record: null,
    kind: 'full',
    seasonCategory: 'inSeason'
  })

function client(manage = true): TeamStationClient {
  const api = new TeamStationClient({ baseUrl: '/api/v1' })
  api.group = async () => ({
    ...detail,
    canManage: manage,
    canManagePeople: manage,
    canSeePeople: manage
  })
  api.seasonGames = async () => []
  api.seasonTeams = async () => [
    summary('team_hawks', 'Demo Hawks'),
    summary('team_eagles', 'Demo Eagles')
  ]
  api.standings = async () => []
  return api
}

function render(
  api: TeamStationClient,
  links: GroupLinkChoice[] = [],
  created: string[] = [],
  opened: GroupRef[] = []
): React.ReactElement {
  return (
    <GroupScreen
      client={api}
      groupRef={{ kind: 'season', id: season.id }}
      initialTab="teams"
      onOpen={group => opened.push(group)}
      onCreate={kind => created.push(kind)}
      onCreateExternal={() => created.push('placeholder')}
      onSettings={() => {}}
      onLink={choice => links.push(choice)}
      onPrivate={() => {}}
    />
  )
}

describe('the season page', () => {
  it('replaces the team action buttons with Add and Create pills and a People tab', async () => {
    const links: GroupLinkChoice[] = []
    const created: string[] = []
    await mount(render(client(), links, created))
    for (const gone of [
      'Add Team',
      'Create Team',
      'Invite Team to Season',
      'Manage people and roles',
      'Create placeholder team'
    ])
      expect(button(gone), gone).equals(undefined)
    const tabs = [
      ...document.querySelectorAll<HTMLElement>('[role="tab"]')
    ].map(node => node.textContent)
    expect(tabs.at(-1)).equals('People')
    expect(document.body.textContent).includes('Demo City')
    await press('Add team')
    await press('Team that competes')
    expect(links.at(-1)).deep.include({
      targetKind: 'team',
      relationship: 'participation'
    })
    await press('Add team')
    await press('Team this season manages')
    expect(links.at(-1)).deep.include({
      targetKind: 'team',
      relationship: 'parent'
    })
    await press('Create team')
    await press('Team')
    expect(created.at(-1)).equals('team')
    await press('Create team')
    await press('Placeholder team')
    expect(created.at(-1)).equals('placeholder')
  })
  it('opens a team from anywhere on its card and breaks only a child team link', async () => {
    const api = client()
    const asked: ParentAction[][] = []
    api.parentPreview = async actions => {
      asked.push(actions)
      return {
        actions,
        effects: actions,
        expected: {},
        explanation: [
          'Remove Demo Spring as parent of Demo Hawks',
          'Only management permissions change.'
        ]
      }
    }
    let applied = 0
    api.changeParents = async () => {
      applied++
    }
    const opened: GroupRef[] = []
    await mount(render(api, [], [], opened))
    await press('Open Demo Eagles')
    expect(opened.at(-1)).deep.equals({ kind: 'team', id: 'team_eagles' })
    expect(button('More for Demo Eagles')).equals(undefined)
    await press('Leave Demo Hawks from Demo Spring')
    expect(asked.at(-1)).deep.equals([
      {
        operation: 'detach',
        child: { kind: 'team', id: 'team_hawks' },
        parent: { kind: 'season', id: season.id }
      }
    ])
    expect(document.body.textContent).includes(
      'Remove Demo Spring as parent of Demo Hawks'
    )
    await press('Cancel')
    expect(applied).equals(0)
    expect(document.body.textContent).not.includes(
      'Review relationship changes'
    )
  })
  it('shows a visitor the teams without management', async () => {
    await mount(render(client(false)))
    expect(button('People')).equals(undefined)
    expect(button('Add team')).equals(undefined)
    expect(button('More for Demo Hawks')).equals(undefined)
  })
})

describe('a season’s People tab, and a team’s roster, through the group page', () => {
  const people = [
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
      inheritedFrom: null,
      teamNames: ['Demo Hawks']
    }),
    asRosterEntry({
      userId: userIdOfGumbo(106),
      gumboId: 106,
      shortName: 'Tim R',
      jersey: null,
      positions: [],
      isPlayer: false,
      role: 'member',
      section: 'family',
      staffRoles: [],
      inheritedFrom: null
    })
  ]
  async function tapRow(name: string): Promise<void> {
    const row = [
      ...document.querySelectorAll<HTMLElement>('[role="button"]')
    ].find(node => node.textContent?.includes(name) === true)
    expect(row, name).not.equals(undefined)
    await act(async () => {
      row!.click()
      await new Promise(resolve => setTimeout(resolve, 20))
    })
  }

  it('opens a player’s page and anybody else’s profile from the season', async () => {
    const api = client()
    api.levelPeople = async () => ({ people, manages: true, admin: true })
    const players: unknown[] = []
    const persons: unknown[] = []
    await mount(
      <GroupScreen
        client={api}
        groupRef={{ kind: 'season', id: season.id }}
        initialTab="people"
        onOpen={() => {}}
        onCreate={() => {}}
        onSettings={() => {}}
        onLink={() => {}}
        onPrivate={() => {}}
        onOpenPlayer={(userId, name, from) => {
          players.push([userId, name, from])
        }}
        onOpenPerson={(group, userId) => {
          persons.push([group, userId])
        }}
      />
    )
    expect(document.body.textContent).includes('Demo Hawks')
    await tapRow('Alfonso S')
    await tapRow('Tim R')
    expect(players).deep.equals([
      [userIdOfGumbo(201), 'Alfonso S', { seasonId: season.id }]
    ])
    expect(persons).deep.equals([
      [{ kind: 'season', id: season.id }, userIdOfGumbo(106)]
    ])
  })

  it('opens somebody on a team’s roster as the team’s profile', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    const hawks = asGroupDetail({
      ...detail,
      group: team('team_canonical', 'Demo Hawks'),
      canManagePeople: true
    })
    api.group = async () => hawks
    api.teamGames = async () => []
    api.roster = async () => people
    api.teamStats = async () => []
    api.teamPitchingStats = async () => []
    const persons: unknown[] = []
    await mount(
      <GroupScreen
        client={api}
        groupRef={{ kind: 'team', id: 'team_alias' }}
        initialTab="team"
        onOpen={() => {}}
        onCreate={() => {}}
        onSettings={() => {}}
        onLink={() => {}}
        onPrivate={() => {}}
        onOpenPerson={(group, userId) => {
          persons.push([group, userId])
        }}
      />
    )
    await tapRow('Tim R')
    expect(persons).deep.equals([
      [{ kind: 'team', id: 'team_canonical' }, userIdOfGumbo(106)]
    ])
  })
})
