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
import {
  fixtureCertifications,
  fixtureCounts,
  fixtureTypes
} from '../../test/umpireTypes'
import { Checkbox } from '../components/Checkbox'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  LeagueUmpiresScreen,
  selectedRange,
  umpireNameWidth
} from './LeagueUmpiresScreen'
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
        certifications: fixtureCertifications('majors', true, false)
      }
    ]
    const seasons: UmpireSeason[] = [
      { id: 'spring', name: 'Spring', logoUrl: null, requirement: null }
    ]
    const changes: unknown[] = []
    client.umpireTypes = async () => fixtureTypes
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
    client.saveUmpires = async (_league, edits) => {
      changes.push(...edits)
      for (const edit of edits) {
        const index = people.findIndex(p => p.id === edit.userId)
        if (edit.after == null) {
          if (index >= 0) people.splice(index, 1)
        } else if (index >= 0)
          people[index] = {
            ...people[index],
            certifications: edit.after.certifications
          }
        else
          people.push({
            id: edit.userId,
            name: 'Alex L',
            avatarUrl: null,
            affiliations: 'Demo Hawks',
            certifications: edit.after.certifications
          })
      }
      return people.slice()
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
  it('preserves labeled checkbox rendering and disabled selection behavior', async () => {
    let presses = 0
    await mount(
      <Checkbox
        label="Select row"
        checked
        onPress={() => {
          presses++
        }}
        disabled
      />
    )
    expect(target('Select row').textContent).contains('Select row')
    expect(target('Select row').getAttribute('aria-checked')).equals('true')
    await press('Select row')
    expect(presses).equals(0)
    await mount(
      <Checkbox
        label="Select row"
        checked={false}
        onPress={() => {
          presses++
        }}
      />
    )
    expect(
      target('Select row').querySelector('[data-testid="checkbox-square"]')!
        .textContent
    ).equals('')
    await press('Select row')
    expect(presses).equals(1)
    await act(async () => {
      target('Select row').dispatchEvent(
        new window.KeyboardEvent('keydown', { key: ' ', bubbles: true })
      )
    })
    expect(presses).equals(2)
    await act(async () => {
      target('Select row').dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: ' ',
          repeat: true,
          bubbles: true
        })
      )
    })
    expect(presses).equals(2)
  })
  it('removes unused levels immediately and confirms used level removal', async () => {
    const f = fixture()
    await mount(<UmpireLevelsScreen client={f.client} league="demo" />)
    expect(target('Level name').getAttribute('placeholder')).equals(
      'ie. Majors, Minors, AA, AAA'
    )
    expect(target('Level name').getAttribute('autocapitalize')).equals('words')
    expect(
      target('Add Level').compareDocumentPosition(target('Remove majors')) &
        window.Node.DOCUMENT_POSITION_FOLLOWING
    ).not.equals(0)
    await fill('Level name', 'minors')
    await press('Add Level')
    expect(target('Level name').getAttribute('placeholder')).equals(
      'ie. Majors, Minors, AA, AAA'
    )
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
  it('uses the same catalog behavior for custom types and protects their dependencies', async () => {
    const f = fixture()
    let types = fixtureTypes.map(t => ({ ...t }))
    f.client.umpireTypes = async () => types.slice()
    f.client.addUmpireType = async (_league, name) => {
      const t = { id: name, name, position: types.length, inUse: false }
      types.push(t)
      return t
    }
    f.client.removeUmpireType = async (_league, id) => {
      types = types.filter(t => t.id !== id)
    }
    await mount(
      <UmpireLevelsScreen client={f.client} league="demo" kind="types" />
    )
    expect(target('Type name').getAttribute('placeholder')).equals(
      'ie. Plate, Field, 1st, 2nd, 3rd'
    )
    await fill('Type name', '1st')
    await press('Add Type')
    await press('Remove 1st')
    expect(types).length(2)
    await press('Remove Plate')
    expect(document.body.textContent).contains(
      'game assignments and their credits'
    )
    await press('Remove type')
    expect(types).length(1)
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
    expect(target('Select Spring').textContent).equals('')
    expect(getComputedStyle(target('Select Spring')).minWidth).equals('48px')
    expect(
      getComputedStyle(
        target('Select Spring').querySelector(
          '[data-testid="checkbox-square"]'
        )!
      ).width
    ).equals('24px')
    await press('Select Spring')
    expect(target('Select Spring').getAttribute('aria-checked')).equals('true')
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
    await press('Required Plate')
    await press('Required Plate 0')
    await press('Done')
    await press('Required Field')
    await press('Required Field 2')
    await press('Required Field 1')
    await press('Done')
    await press('Optional Field')
    await press('Optional Field 2')
    await press('Optional Field 1')
    await press('Done')
    await press('Required umpire level')
    await press('Required umpire level majors')
    await press('Done')
    expect(
      document.body.textContent!.indexOf(
        'Apply umpire requirements to the below seasons'
      )
    ).lessThan(document.body.textContent!.indexOf('Spring'))
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <UmpireRequirementsScreen
            client={f.client}
            league="demo"
            seasonIds={[...chosen]}
            onNext={() => undefined}
            onApplied={() => {
              applied = true
            }}
          />
        </ThemeProvider>
      )
    })
    await press('Apply umpire requirements to the below seasons')
    expect(applied).equals(true)
    expect(f.changes).deep.equals([
      {
        seasonIds: ['spring'],
        levelId: 'majors',
        types: fixtureCounts(false, 1, 1)
      }
    ])
  })
  it('manages note definitions with the requested copy and destructive warning', async () => {
    const f = fixture()
    let notes: UmpireLevel[] = []
    f.client.umpireNoteTypes = async () => notes.slice()
    f.client.addUmpireNoteType = async (_league, name) => {
      const note = { id: name, name, position: notes.length, inUse: true }
      notes.push(note)
      return note
    }
    f.client.removeUmpireNoteType = async (_league, id) => {
      notes = notes.filter(n => n.id !== id)
    }
    await mount(
      <UmpireLevelsScreen client={f.client} league="demo" kind="notes" />
    )
    expect(document.body.textContent)
      .contains('Create Per-Game Umpire Notes')
      .and.contains(
        'Create a Notes Type That Can Be Added to Each Game To assist umpires'
      )
    expect(target('Notes Type name').getAttribute('placeholder')).equals(
      'ie. Jersey Color, Venue Contact'
    )
    await fill('Notes Type name', 'Jersey Color')
    await press('Add Notes Type')
    await press('Remove Jersey Color')
    expect(document.body.textContent).contains(
      'Removing notes type “Jersey Color”'
    )
    expect(document.body.textContent).contains(
      'clears its notes from every game'
    )
    await press('Cancel')
    expect(notes).length(1)
    await press('Remove Jersey Color')
    await press('Remove notes type')
    expect(notes).length(0)
  })
  it('summarizes saved per-type requirements on the season list', async () => {
    const f = fixture()
    f.seasons[0].requirement = {
      levelId: 'majors',
      levelName: 'majors',
      types: fixtureCounts(true, 2, 1)
    }
    await mount(
      <UmpireRequirementsScreen
        client={f.client}
        league="demo"
        onNext={() => undefined}
        onApplied={() => undefined}
      />
    )
    expect(document.body.textContent).contains('Plate: 1 required, 0 optional')
    expect(document.body.textContent).contains('Field: 2 required, 1 optional')
    const details = document.querySelector(
      '[data-testid="season-requirements-spring"]'
    )!
    expect(details.parentElement?.textContent).contains('Spring')
    expect(
      details.parentElement?.parentElement?.querySelector(
        '[aria-label="Select Spring"]'
      )
    ).not.equals(null)
  })
  it('gives spare width to names while retaining readable narrow columns', () => {
    expect(umpireNameWidth(1408, 2)).equals(952)
    expect(umpireNameWidth(358, 2)).equals(240)
    expect(umpireNameWidth(0, 0)).equals(240)
  })
  it('keeps long custom certification labels on one line within their column', async () => {
    const { client } = fixture()
    const names = ['First Base Umpire', 'X'.repeat(100)]
    client.umpireTypes = async () =>
      names.map((name, position) => ({
        id: String(position),
        name,
        position,
        inUse: false
      }))
    await mount(<LeagueUmpiresScreen client={client} league="league" />)
    for (const name of names) {
      const label = document.querySelector<HTMLElement>(
        `[aria-label="${name}"]`
      )!
      expect(label.textContent).equals(name)
      expect(label.style.width).equals('100%')
      expect(window.getComputedStyle(label).whiteSpace).equals('nowrap')
      expect(window.getComputedStyle(label).textOverflow).equals('ellipsis')
      expect(
        target(`Jefferson K, majors, ${name}`).getAttribute('role')
      ).equals('button')
    }
  })
  it('sets selected certifications opposite the tapped cell and keeps drag selections', async () => {
    const f = fixture()
    await mount(<LeagueUmpiresScreen client={f.client} league="demo" />)
    expect(document.body.textContent).contains('Jefferson K')
    expect(document.body.textContent).not.contains('Jefferson K.')
    expect(
      target('Jefferson K, majors, Plate').getAttribute('aria-pressed')
    ).equals('false')
    const capability = target('Jefferson K, majors, Plate')
    const circle = capability.querySelector(
      '[data-testid="umpire-certification-circle"]'
    )!
    expect(getComputedStyle(capability).width).equals('48px')
    expect(getComputedStyle(circle).width).equals('30px')
    expect(circle.textContent).equals('')
    expect(getComputedStyle(capability.nextElementSibling!).textAlign).equals(
      'center'
    )
    await press('Select Jefferson K')
    await press('Select Uma R')
    await press('Jefferson K, majors, Plate')
    expect(f.changes).deep.equals([])
    await press('Save')
    expect(
      f.people.every(
        p =>
          p.certifications.find(c => c.typeId === 'uty_plate')?.enabled === true
      )
    ).equals(true)
    await press('Uma R, majors, Plate')
    await press('Save')
    expect(
      f.people.every(
        p =>
          p.certifications.find(c => c.typeId === 'uty_plate')?.enabled !== true
      )
    ).equals(true)
    await press('Select Uma R')
    await press('Uma R, majors, Field')
    await press('Save')
    expect(
      f.people[0].certifications.find(c => c.typeId === 'uty_field')?.enabled
    ).equals(true)
    expect(
      f.people[1].certifications.find(c => c.typeId === 'uty_field')?.enabled
    ).equals(false)
    expect(selectedRange(['a', 'b', 'c'], 0, 2, ['b'])).deep.equals([
      'b',
      'a',
      'c'
    ])
    await fill('Search affiliated people', 'Alex')
    await press('Alex L')
    await press('Save')
    expect(f.people.some(p => p.id === 'three')).equals(true)
    await press('Revoke Uma R')
    await press('Revoke umpire')
    await press('Save')
    expect(f.people.length).equals(2)
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
    expect(target('Manage Umpire Levels').getAttribute('aria-disabled')).equals(
      'true'
    )
    const mutedColor = getComputedStyle(
      target('Manage Umpire Levels').firstElementChild!.firstElementChild!
    ).color
    await press('Manage Umpire Levels')
    await press('Enable Team Credits')
    expect(opened).deep.equals([])
    expect(settings.credits).equals(false)
    await press('Enable umpire management')
    expect(
      getComputedStyle(
        target('Manage Umpire Levels').firstElementChild!.firstElementChild!
      ).color
    ).not.equals(mutedColor)
    await press('Enable Team Credits')
    for (const label of [
      'Manage Umpire Levels',
      'Set Season Requirements',
      'Manage Umpires',
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
    await press('Enable umpire management')
    expect(settings).deep.equals({ management: false, credits: true })
    expect((target('Enable Team Credits') as HTMLInputElement).disabled).equals(
      true
    )
    await press('Manage Umpires')
    expect(opened).length(4)
    await press('Enable umpire management')
    expect(settings.credits).equals(true)
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
    expect(
      target('Set Season Requirements').getAttribute('aria-disabled')
    ).equals('true')
    await press('Set Season Requirements')
    expect(opened).deep.equals([])
    expect(
      target('Manage Umpire Levels').getAttribute('aria-disabled')
    ).not.equals('true')
  })
  it('reports a failed mutation and allows retry', async () => {
    const f = fixture()
    f.client.addUmpireLevel = async () => {
      throw new Error('That level already exists')
    }
    await mount(<UmpireLevelsScreen client={f.client} league="demo" />)
    await fill('Level name', 'majors')
    await press('Add Level')
    expect(document.body.textContent).contains('That level already exists')
  })

  it('ignores mouse dragging and toggles individual checkboxes once', async () => {
    const f = fixture()
    await mount(<LeagueUmpiresScreen client={f.client} league="demo" />)
    const square = document.querySelector<HTMLElement>(
      '[data-testid="umpire-select-drag-one"]'
    )!
    await responderDrag(square, [
      [10, 10],
      [10, 170]
    ])
    expect(target('Select Jefferson K').getAttribute('aria-checked')).equals(
      'false'
    )
    await press('Select Jefferson K')
    expect(target('Select Jefferson K').getAttribute('aria-checked')).equals(
      'true'
    )
    await press('Select Jefferson K')
    expect(target('Select Jefferson K').getAttribute('aria-checked')).equals(
      'false'
    )
  })
  it('keeps Save clean for selection and reverted edits, preserves failed drafts, and reloads explicitly', async () => {
    const f = fixture()
    await mount(<LeagueUmpiresScreen client={f.client} league="demo" />)
    const clean = (): boolean =>
      target('Save').getAttribute('aria-disabled') === 'true'
    expect(clean()).equals(true)
    await press('Select Jefferson K')
    expect(clean()).equals(true)
    await press('Jefferson K, majors, Field')
    expect(clean()).equals(false)
    await press('Jefferson K, majors, Field')
    expect(clean()).equals(true)
    await fill('Search affiliated people', 'Alex')
    await press('Alex L')
    expect(clean()).equals(false)
    await press('Revoke Alex L')
    await press('Revoke umpire')
    expect(clean()).equals(true)
    await press('Jefferson K, majors, Field')
    const save = f.client.saveUmpires.bind(f.client)
    f.client.saveUmpires = async () => {
      throw new Error('Save unavailable')
    }
    await press('Save')
    expect(document.body.textContent).contains('Save unavailable')
    expect(clean()).equals(false)
    f.client.saveUmpires = save
    await press('Save')
    expect(clean()).equals(true)
    await press('Jefferson K, majors, Field')
    await press('Reload saved settings')
    await press('Cancel')
    expect(clean()).equals(false)
    await press('Reload saved settings')
    await press('Discard and reload')
    expect(clean()).equals(true)
  })
  it('opens profiles directly when clean and only after an explicit successful save when dirty', async () => {
    const f = fixture()
    const opened: string[] = []
    await mount(
      <LeagueUmpiresScreen
        client={f.client}
        league="demo"
        onOpenPerson={id => {
          opened.push(id)
        }}
      />
    )
    await press('Open profile for Jefferson K')
    expect(opened).deep.equals(['one'])
    await press('Jefferson K, majors, Plate')
    await press('Open profile for Jefferson K')
    await press('Cancel')
    expect(opened.length).equals(1)
    await press('Open profile for Jefferson K')
    await press('Save and open profile')
    expect(opened).deep.equals(['one', 'one'])
    expect(f.changes.length).equals(1)
  })
})
