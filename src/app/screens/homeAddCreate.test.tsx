import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asTeamSummary, TeamStationClient } from '../../common/api'
import type { GroupKind, GroupRef } from '../../common/groupCreation'
import type { ParentAction } from '../../common/groupLinks'
import { asPublicGroup, type PublicGroup } from '../../common/publicGroups'
import { ThemeProvider } from '../theme/ThemeContext'
import { CreateGroupScreen } from './CreateGroupScreen'
import { DiscoverScreen } from './DiscoverScreen'
import { HomeScreen } from './HomeScreen'
import { seasonAllowed } from './ParentChooser'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.replaceChildren()
})
async function settle(ms = 30): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}
async function mount(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
  await settle()
}
function control(label: string): HTMLElement | undefined {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[role="button"], [role="radio"], [role="switch"], input[type="checkbox"]'
    )
  ].find(
    node => (node.getAttribute('aria-label') ?? node.textContent) === label
  )
}
async function press(label: string): Promise<void> {
  const node = control(label)
  expect(node, label).not.equals(undefined)
  await act(async () => {
    node!.click()
  })
  await settle()
}
async function fill(label: string, value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`
  )!
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

const group = (
  kind: GroupKind,
  id: string,
  name: string,
  leagueId: string | null = null
): PublicGroup =>
  asPublicGroup({
    id,
    kind,
    name,
    imageUrl: null,
    locality: null,
    startsOn: kind === 'season' ? '2026-03-01' : null,
    endsOn: kind === 'season' ? '2026-05-31' : null,
    leagueId
  })

describe('Home Add and Create, following, and choosing a new team’s parents', () => {
  it('offers only Create on each Home section and lists followed groups', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    api.teams = async () => [
      asTeamSummary({
        id: 'team_own',
        name: 'Demo Own',
        shortName: null,
        logoPath: null,
        logoUrl: null,
        canViewPrivate: true,
        record: null,
        kind: 'full'
      })
    ]
    api.seasons = async () => []
    api.ownGroups = async () => []
    api.follows = async () => [
      group('team', 'team_fan', 'Demo Followed Team'),
      group('team', 'team_own', 'Demo Own'),
      group('league', 'league_fan', 'Demo Followed League')
    ]
    api.recentGame = async () => null
    api.liveNow = async () => []
    const created: GroupKind[] = []
    const opened: GroupRef[] = []
    await mount(
      <HomeScreen
        client={api}
        onOpenTeam={() => {}}
        onOpenSeason={() => {}}
        onOpenGame={() => {}}
        onCreateGroup={kind => created.push(kind)}
        onOpenGroup={ref => opened.push(ref)}
      />
    )
    const text = document.body.textContent ?? ''
    expect(text).includes('Demo Followed Team')
    expect(text.split('Demo Own').length).equals(2)
    expect(text).includes('Following')
    expect(text).includes('Demo Followed League')
    // Finding something to follow is the Search tab's job: Home has no Add.
    for (const label of ['Add team', 'Add league', 'Add Season', 'Add Team'])
      expect(control(label), label).equals(undefined)
    await press('Create Team')
    await press('Create League')
    // No seasons at all: their Create waits at the bottom.
    await press('Create Season')
    expect(created).deep.equals(['team', 'league', 'season'])
    await press('Demo Followed Team')
    expect(opened.at(-1)).deep.equals({ kind: 'team', id: 'team_fan' })
  })
  it('follows and unfollows from Discover, except what is already on Home', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    const hawks = group('season', 'season_demo', 'Demo Spring')
    const mine = group('season', 'season_mine', 'Demo Mine')
    api.discoverGroups = async () => [hawks, mine]
    api.follows = async () => []
    api.ownGroups = async () => [mine]
    const calls: string[] = []
    api.follow = async ref => {
      calls.push(`follow:${ref.id}`)
      return hawks
    }
    api.unfollow = async ref => {
      calls.push(`unfollow:${ref.id}`)
    }
    await mount(
      <DiscoverScreen
        client={api}
        onOpen={() => {}}
        initialKind="season"
        follow
      />
    )
    await settle(300)
    expect(control('Follow Demo Mine')).equals(undefined)
    expect(control('Unfollow Demo Mine')).equals(undefined)
    await press('Follow Demo Spring')
    expect(control('Unfollow Demo Spring')).not.equals(undefined)
    await press('Unfollow Demo Spring')
    expect(calls).deep.equals(['follow:season_demo', 'unfollow:season_demo'])
  })
  it('keeps a team’s seasons in one league', () => {
    const seasons = [
      group('season', 'a1', 'A One', 'league_a'),
      group('season', 'a2', 'A Two', 'league_a'),
      group('season', 'b1', 'B One', 'league_b'),
      group('season', 'solo', 'Solo')
    ]
    const allowed = (choice: {
      leagueId?: string
      seasonIds: string[]
    }): string[] =>
      seasons.filter(s => seasonAllowed(s, choice, seasons)).map(s => s.id)
    expect(allowed({ seasonIds: [] })).deep.equals(['a1', 'a2', 'b1', 'solo'])
    expect(allowed({ seasonIds: ['a1'] })).deep.equals(['a1', 'a2'])
    expect(allowed({ seasonIds: ['solo'] })).deep.equals(['solo'])
    expect(allowed({ leagueId: 'league_b', seasonIds: [] })).deep.equals(['b1'])
  })
  it('ends team creation by choosing administered leagues and seasons', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    api.ownGroups = async role => {
      expect(role).equals('admin')
      return [
        group('league', 'league_a', 'Demo League A'),
        group('season', 'a1', 'Demo A Spring', 'league_a'),
        group('season', 'a2', 'Demo A Fall', 'league_a'),
        group('season', 'b1', 'Demo B Spring', 'league_b')
      ]
    }
    api.pictures = async () => []
    let body: { parent?: GroupRef } | undefined
    api.createGroup = async created => {
      body = created
      return {
        id: 'team_new',
        kind: 'team',
        name: created.name,
        imageUrl: null
      }
    }
    const previewed: ParentAction[][] = []
    let applied = 0
    api.parentPreview = async actions => {
      previewed.push(actions)
      return { actions, effects: actions, expected: {}, explanation: [] }
    }
    api.changeParents = async () => {
      applied++
    }
    const done: GroupRef[] = []
    await mount(
      <CreateGroupScreen
        client={api}
        kind="team"
        initialLocality={{
          city: 'Demo Town',
          region: 'Demo Region',
          country: 'US',
          placeId: null,
          timezone: 'America/New_York'
        }}
        onCreated={ref => done.push(ref)}
        onCancel={() => {}}
      />
    )
    await fill('Team name', 'Demo New Hawks')
    await press('Continue')
    await press('Continue')
    await press('Use initials')
    await press('Continue')
    expect(document.body.textContent).includes('Add Team to Season or League')
    expect(document.body.textContent).includes('LEAGUES')
    expect(document.body.textContent).includes('SEASONS')
    await press('Demo League A')
    const b1 = control('Demo B Spring') as HTMLInputElement
    expect(b1.disabled || b1.getAttribute('aria-disabled') === 'true').equals(
      true
    )
    await press('Demo A Spring')
    await press('Demo A Fall')
    await press('Create Team')
    expect(body?.parent).deep.equals({ kind: 'season', id: 'a1' })
    expect(previewed).deep.equals([
      [
        {
          operation: 'attach',
          child: { kind: 'team', id: 'team_new' },
          parent: { kind: 'season', id: 'a2' }
        }
      ]
    ])
    expect(applied).equals(1)
    expect(done).deep.equals([{ kind: 'team', id: 'team_new' }])
  })
})
