import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import type {
  UmpireLevel,
  UmpirePerson,
  UmpireSeason
} from '../../common/umpires'
import { responderDrag } from '../../test/responderDrag'
import { ThemeProvider } from '../theme/ThemeContext'
import { LeagueUmpiresScreen, selectedRange } from './LeagueUmpiresScreen'
import { UmpireLevelsScreen } from './UmpireLevelsScreen'
import { UmpireRequirementsScreen } from './UmpireRequirementsScreen'
import { UmpireSettingsCard } from './UmpireSettingsCard'
describe('management.test.tsx', () => {
  let root: Root | undefined
  async function mount(node: React.ReactElement): Promise<void> {
    await act(async () => root?.unmount())
    document.body.replaceChildren()
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<ThemeProvider>{node}</ThemeProvider>)
    })
  }
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()
  })
  function target(label: string): HTMLElement {
    const n = [
      ...document.querySelectorAll<HTMLElement>('[aria-label], [role="button"]')
    ].find(n => (n.getAttribute('aria-label') ?? n.textContent) === label)
    expect(n, label).not.equals(undefined)
    return n!
  }
  async function press(label: string): Promise<void> {
    await act(async () => {
      target(label).click()
    })
  }
  async function fill(label: string, value: string): Promise<void> {
    const input = target(label)
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!.call(input, value)
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  }
  function fixture(): {
    client: TeamStationClient
    levels: UmpireLevel[]
    people: UmpirePerson[]
    seasons: UmpireSeason[]
    changes: unknown[]
  } {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    const levels = [{ id: 'majors', name: 'majors', position: 0, inUse: true }]
    const people: UmpirePerson[] = [
      {
        id: 'one',
        name: 'Jefferson K',
        avatarUrl: null,
        affiliations: 'Demo Hawks · Guardian of Demo Player',
        certifications: []
      },
      {
        id: 'two',
        name: 'Uma R',
        avatarUrl: null,
        affiliations: 'Demo Hawks',
        certifications: [{ levelId: 'majors', plate: true, field: false }]
      }
    ]
    const seasons: UmpireSeason[] = [
      { id: 'spring', name: 'Spring', logoUrl: null, requirement: null }
    ]
    const changes: unknown[] = []
    client.umpireLevels = async () => levels.slice()
    client.umpirePeople = async (_league, query) =>
      query == null
        ? people.slice()
        : [
            {
              id: 'three',
              name: 'Alex L',
              avatarUrl: null,
              affiliations: 'Demo Hawks',
              certifications: []
            }
          ]
    client.umpireRequirements = async () => seasons
    client.addUmpireLevel = async (_league, name) => {
      const level = { id: name, name, position: levels.length, inUse: false }
      levels.push(level)
      return level
    }
    client.removeUmpireLevel = async (_league, id) => {
      levels.splice(
        levels.findIndex(l => l.id === id),
        1
      )
    }
    client.certifyUmpire = async (_league, id, c) => {
      changes.push([id, c])
      const p = people.find(p => p.id === id)!
      p.certifications = [
        ...p.certifications.filter(v => v.levelId !== c.levelId),
        c
      ]
    }
    client.setUmpireRequirements = async (_league, req) => {
      changes.push(req)
    }
    client.grantUmpire = async (_league, id) => {
      changes.push(id)
    }
    client.revokeUmpire = async (_league, id) => {
      changes.push(id)
      people.splice(
        people.findIndex(p => p.id === id),
        1
      )
    }
    return { client, levels, people, seasons, changes }
  }
  it('removes unused levels immediately and confirms used level removal', async () => {
    const f = fixture()
    await mount(<UmpireLevelsScreen client={f.client} league="demo" />)
    expect(target('Level name').getAttribute('placeholder')).equals('minors')
    await fill('Level name', 'minors')
    await press('Add level')
    expect(target('Level name').getAttribute('placeholder')).equals('AA')
    await press('Remove minors')
    expect(f.levels.length).equals(1)
    expect(document.body.textContent).not.contains('Remove level')
    await press('Remove majors')
    await press('Cancel')
    expect(f.levels.length).equals(1)
    await press('Remove majors')
    await press('Remove level')
    expect(f.levels.length).equals(0)
  })
  it('hides Next until selection and applies above the chosen seasons', async () => {
    const f = fixture()
    let chosen: string[] = []
    await mount(
      <UmpireRequirementsScreen
        client={f.client}
        league="demo"
        onNext={ids => {
          chosen = ids
        }}
        onApplied={() => undefined}
      />
    )
    expect(document.body.textContent).not.contains('Next')
    await press('Select Spring')
    await press('Next')
    expect(chosen).deep.equals(['spring'])
    let applied = false
    await mount(
      <UmpireRequirementsScreen
        client={f.client}
        league="demo"
        seasonIds={chosen}
        onNext={() => undefined}
        onApplied={() => {
          applied = true
        }}
      />
    )
    await press('Plate umpire')
    await press('Field umpires')
    await press('Field umpires 2')
    await press('Field umpires 1')
    await press('Done')
    await press('Umpire level')
    await press('Umpire level majors')
    await press('Done')
    expect(
      document.body.textContent!.indexOf(
        'Apply umpire requirements to the below seasons'
      )
    ).lessThan(document.body.textContent!.indexOf('Spring'))
    await press('Apply umpire requirements to the below seasons')
    expect(applied).equals(true)
    expect(f.changes).deep.equals([
      { seasonIds: ['spring'], levelId: 'majors', plate: false, fieldCount: 1 }
    ])
  })
  it('sets selected certifications opposite the tapped cell and keeps drag selections', async () => {
    const f = fixture()
    await mount(<LeagueUmpiresScreen client={f.client} league="demo" />)
    expect(document.body.textContent).contains('Jefferson K')
    expect(document.body.textContent).not.contains('Jefferson K.')
    expect(
      target('Jefferson K, majors, plate').getAttribute('aria-checked')
    ).equals('false')
    await press('Select Jefferson K')
    await press('Select Uma R')
    await press('Jefferson K, majors, plate')
    expect(f.people.every(p => p.certifications[0].plate)).equals(true)
    await press('Uma R, majors, plate')
    expect(f.people.every(p => !p.certifications[0].plate)).equals(true)
    await press('Select Uma R')
    await press('Uma R, majors, field')
    expect(f.people[0].certifications[0].field).equals(true)
    expect(f.people[1].certifications[0].field).equals(false)
    expect(selectedRange(['a', 'b', 'c'], 0, 2, ['b'])).deep.equals([
      'b',
      'a',
      'c'
    ])
    await fill('Search affiliated people', 'Alex')
    await press('Alex L')
    expect(f.changes).contains('three')
    await press('Revoke Uma R')
    await press('Revoke umpire')
    expect(f.people.length).equals(1)
  })
  it('surfaces failed candidate searches and retries without changing the query', async () => {
    const f = fixture()
    const search = f.client.umpirePeople.bind(f.client)
    let unavailable = true
    f.client.umpirePeople = async (league, query) => {
      if (query != null && unavailable) throw new Error('Network unavailable')
      return await search(league, query)
    }
    await mount(<LeagueUmpiresScreen client={f.client} league="demo" />)
    await fill('Search affiliated people', 'Alex')
    expect(document.body.textContent).contains('Network unavailable')
    unavailable = false
    await press('Retry search')
    expect(document.body.textContent)
      .contains('Alex L')
      .and.not.contains('Network unavailable')
    expect(target('Revoke Uma R').textContent).equals('Revoke')
  })
  it('gates management actions and persists both settings', async () => {
    const f = fixture()
    let settings = { management: false, credits: false }
    const opened: string[] = []
    f.client.umpireSettings = async () => settings
    f.client.setUmpireSettings = async (_l, next) =>
      (settings = { ...settings, ...next })
    await mount(
      <UmpireSettingsCard
        client={f.client}
        league="demo"
        onOpen={n => opened.push(n)}
      />
    )
    expect(target('Create Umpire Levels').getAttribute('aria-disabled')).equals(
      'true'
    )
    await press('Umpire management')
    await press('Team credits')
    for (const label of [
      'Create Umpire Levels',
      'Set Requirements',
      'Add Umpires',
      'Umpire schedule'
    ])
      await press(label)
    expect(opened).deep.equals([
      'umpireLevels',
      'umpireRequirements',
      'leagueUmpires',
      'umpireSchedule'
    ])
    expect(settings).deep.equals({ management: true, credits: true })
  })
  it('keeps requirements disabled for an enabled league with no levels', async () => {
    const f = fixture()
    f.levels.length = 0
    f.client.umpireSettings = async () => ({ management: true, credits: false })
    const opened: string[] = []
    await mount(
      <UmpireSettingsCard
        client={f.client}
        league="demo"
        onOpen={n => opened.push(n)}
      />
    )
    expect(target('Set Requirements').getAttribute('aria-disabled')).equals(
      'true'
    )
    await press('Set Requirements')
    expect(opened).deep.equals([])
    expect(
      target('Create Umpire Levels').getAttribute('aria-disabled')
    ).not.equals('true')
  })
  it('reports a failed mutation and allows retry', async () => {
    const f = fixture()
    f.client.addUmpireLevel = async () => {
      throw new Error('That level already exists')
    }
    await mount(<UmpireLevelsScreen client={f.client} league="demo" />)
    await fill('Level name', 'majors')
    await press('Add level')
    expect(document.body.textContent).contains('That level already exists')
  })

  it('selects a contiguous range through actual pointer movement', async () => {
    const f = fixture()
    await mount(<LeagueUmpiresScreen client={f.client} league="demo" />)
    const square = document.querySelector<HTMLElement>(
      '[data-testid="umpire-select-drag-one"]'
    )!
    await responderDrag(square, [
      [10, 10],
      [10, 90]
    ])
    expect(target('Select Jefferson K').getAttribute('aria-checked')).equals(
      'true'
    )
    expect(target('Select Uma R').getAttribute('aria-checked')).equals('true')
    await responderDrag(square, [
      [10, 10],
      [10, 10]
    ])
    expect(target('Select Jefferson K').getAttribute('aria-checked')).equals(
      'false'
    )
  })
})
