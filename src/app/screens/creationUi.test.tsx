import { expect } from 'chai'
import { afterEach, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Pressable, Text } from 'react-native'

import {
  asSeasonSummary,
  asTeamSummary,
  TeamStationClient
} from '../../common/api'
import type { GroupKind, GroupPicture } from '../../common/groupCreation'
import { asPublicGroup } from '../../common/publicGroups'
import { AppHeader } from '../components/AppHeader'
import { DateRangePicker } from '../components/DateRangePicker'
import { GroupPictureChooser } from '../components/GroupPictureChooser'
import { SectionHeader } from '../components/SectionHeader'
import { ThemeProvider } from '../theme/ThemeContext'
import { CreateGroupScreen } from './CreateGroupScreen'
import { HomeScreen } from './HomeScreen'

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
function button(label: string): HTMLElement {
  const node = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(n => (n.getAttribute('aria-label') ?? n.textContent) === label)
  expect(node, label).not.equals(undefined)
  return node!
}
async function press(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
  })
}
async function fill(label: string, value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`
  )!
  expect(input, label).not.equals(null)
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

it('offers a name first for every group and updates chosen initials after returning to edit', async () => {
  const api = new TeamStationClient({ baseUrl: '/api/v1' })
  api.citySuggestions = async () => ({
    suggestions: [
      {
        id: 'google:fixture',
        primary: 'Demo City',
        secondary: 'Demo Region, Canada'
      }
    ],
    provider: 'google',
    attribution: 'Powered by Google',
    snapshot: ''
  })
  api.location = async () => ({
    city: 'Demo City',
    region: 'Demo Region',
    country: 'Canada',
    placeId: 'google:fixture',
    timezone: 'America/Toronto'
  })
  api.pictures = async () => {
    throw new Error('Group flow must not request icons')
  }
  for (const kind of ['league', 'season', 'team'] as const) {
    await mount(
      <CreateGroupScreen
        client={api}
        kind={kind}
        onCreated={() => {}}
        onCancel={() => {}}
      />
    )
    const label = `${kind[0].toUpperCase()}${kind.slice(1)} name`
    expect(button('Continue').getAttribute('aria-disabled')).equals('true')
    await fill(label, 'Demo First')
    await press('Continue')
    if (kind === 'season') {
      await press('Custom time frame')
      await press('Cancel')
      continue
    }
    await press('Location not set, Add a city')
    await fill('City', 'Demo City')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    await press('Choose Demo City, Demo Region, Canada')
    await press('Save')
    await press('Continue')
    await press('Use initials')
    expect(
      document.querySelector('[aria-label="Initials preview: DF"]')
    ).not.equals(null)
    await press('Previous step')
    await press('Previous step')
    await fill(label, 'Changed Club')
    await press('Continue')
    await press('Continue')
    expect(
      document.querySelector('[aria-label="Initials preview: CC"]')
    ).not.equals(null)
    expect(document.body.textContent).not.includes('Sports pictures')
  }
})

it('retains initials when upload is canceled or fails and previews a successful photo', async () => {
  const api = new TeamStationClient({ baseUrl: '/api/v1' })
  let calls = 0
  api.pictures = async () => {
    calls++
    return []
  }
  let attempt = 0
  function Picker(): React.ReactElement {
    const [value, setValue] = useState<GroupPicture>({ initials: true })
    return (
      <GroupPictureChooser
        client={api}
        name="Demo Club"
        value={value}
        onChange={setValue}
        pickPhoto={async () => {
          attempt++
          if (attempt === 1) return null
          if (attempt === 2) throw new Error('Album unavailable')
          return { base64: 'AAAA', contentType: 'image/png' }
        }}
      />
    )
  }
  await mount(<Picker />)
  await press('Add Photo')
  expect(
    document.querySelector('[aria-label="Initials preview: DC"]')
  ).not.equals(null)
  await press('Add Photo')
  expect(document.body.textContent).includes('Album unavailable')
  await press('Add Photo')
  expect(
    document.querySelector('[aria-label="Your selected photo"]')
  ).not.equals(null)
  expect(document.body.textContent).not.includes('Album unavailable')
  await press('Use initials')
  expect(
    document.querySelector('[aria-label="Initials preview: DC"]')
  ).not.equals(null)
  expect(calls).equals(0)
})

it('highlights a wrapped inclusive calendar range with square continuations and rounded endpoints', async () => {
  await mount(
    <DateRangePicker
      now={new Date(2026, 9, 1)}
      onChoose={() => {}}
      onCancel={() => {}}
    />
  )
  await press('2026-10-08')
  await press('2026-10-20')
  const css = (day: string): CSSStyleDeclaration =>
    window.getComputedStyle(button(day))
  expect(css('2026-10-08').backgroundColor).equals('rgb(23, 105, 210)')
  expect(css('2026-10-08').borderTopLeftRadius).not.oneOf(['', '0', '0px'])
  expect(css('2026-10-10').borderTopRightRadius).oneOf(['', '0', '0px'])
  expect(css('2026-10-11').borderTopLeftRadius).oneOf(['', '0', '0px'])
  expect(css('2026-10-20').borderTopRightRadius).not.oneOf(['', '0', '0px'])
  expect(
    window.getComputedStyle(button('2026-10-12').firstElementChild!).color
  ).equals('rgb(255, 255, 255)')
  await press('2026-10-29')
  await press('Next month')
  await press('2026-11-04')
  expect(css('2026-11-01').borderTopLeftRadius).oneOf(['', '0', '0px'])
  await press('2026-11-07')
  await press('2026-11-07')
  expect(css('2026-11-07').borderTopLeftRadius).not.oneOf(['', '0', '0px'])
  expect(css('2026-11-07').borderTopRightRadius).not.oneOf(['', '0', '0px'])
})

it('places navigation, bell and account in order and preserves pending and default section actions', async () => {
  let bells = 0
  let accounts = 0
  let actions = 0
  await mount(
    <>
      <AppHeader
        title="Demo"
        showMark
        onBack={() => {}}
        nav={
          <Pressable accessibilityRole="button" accessibilityLabel="Schedule">
            <Text>Schedule</Text>
          </Pressable>
        }
        notifications={{
          pending: true,
          onPress: () => {
            bells++
          }
        }}
        account={{
          name: 'Demo User',
          onPress: () => {
            accounts++
          }
        }}
      />
      <SectionHeader
        title="Demo section"
        actionLabel="View all"
        onAction={() => {
          actions++
        }}
      />
    </>
  )
  const buttons = [...document.querySelectorAll('[role="button"]')]
  expect(buttons.indexOf(button('Schedule'))).lessThan(
    buttons.indexOf(button('Notifications'))
  )
  expect(buttons.indexOf(button('Notifications'))).lessThan(
    buttons.indexOf(button('Account, Demo User'))
  )
  expect(
    document.querySelector('[data-testid="notification-pending-dot"]')
  ).not.equals(null)
  await press('Notifications')
  await press('Account, Demo User')
  await press('View all')
  expect([bells, accounts, actions]).deep.equals([1, 1, 1])
})

for (const kinds of [
  [],
  ['league'],
  ['season'],
  ['team'],
  ['league', 'season'],
  ['league', 'season', 'team']
] as GroupKind[][]) {
  it(`shows contextual home creation controls for ${kinds.length === 0 ? 'empty account' : kinds.join(',')}`, async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    api.teams = async () =>
      kinds.includes('team')
        ? [
            asTeamSummary({
              id: 'team_demo',
              name: 'Demo Team',
              shortName: null,
              logoPath: null,
              logoUrl: null
            })
          ]
        : []
    api.seasons = async () =>
      kinds.includes('season')
        ? [
            asSeasonSummary({
              id: 'season_demo',
              name: 'Demo Season',
              leagueId: null,
              year: 2026,
              term: null,
              ageGroup: null,
              teams: 1,
              games: 0,
              videos: 0
            })
          ]
        : []
    api.ownGroups = async () =>
      kinds.includes('league')
        ? [
            asPublicGroup({
              id: 'league_demo',
              kind: 'league',
              name: 'Demo League',
              imageUrl: null,
              locality: null
            })
          ]
        : []
    api.liveNow = async () => []
    api.recentGame = async () => null
    const opened: GroupKind[] = []
    await mount(
      <HomeScreen
        client={api}
        onCreateGroup={kind => opened.push(kind)}
        onOpenGroup={() => {}}
        onOpenTeam={() => {}}
        onOpenSeason={() => {}}
        onOpenGame={() => {}}
      />
    )
    for (const kind of ['league', 'season', 'team'] as const) {
      const title = kind[0].toUpperCase() + kind.slice(1)
      // A section on Home carries its own `Create League` pill; a kind with
      // no section yet is created from its large card.
      const label = `Create ${title}`
      await press(label)
    }
    expect(opened).deep.equals(['league', 'season', 'team'])
    const content = document.body.textContent!
    if (kinds.includes('season') && !kinds.includes('team'))
      expect(content.indexOf('Create Team')).greaterThan(
        content.indexOf(
          kinds.includes('season') ? 'Demo Season' : 'Demo League'
        )
      )
    expect(content).not.includes('Current & past')
    // Every kind with nothing in it has its large card, whatever else there
    // is; a kind there is has none.
    const words = {
      league: 'Create an organization',
      season: 'Create a season or tournament',
      team: 'A team is a collection'
    }
    for (const kind of ['league', 'season', 'team'] as const)
      expect(content.includes(words[kind]), kind).equals(!kinds.includes(kind))
  })
}

it('does not show empty-account creation cards while loading or on a failed load', async () => {
  const api = new TeamStationClient({ baseUrl: '/api/v1' })
  api.liveNow = async () => []
  api.seasons = async () => []
  let rejectLoad: (error: Error) => void = () => {}
  api.teams = async () =>
    await new Promise((_resolve, reject) => {
      rejectLoad = reject
    })
  await mount(
    <HomeScreen
      client={api}
      onCreateGroup={() => {}}
      onOpenTeam={() => {}}
      onOpenSeason={() => {}}
      onOpenGame={() => {}}
    />
  )
  expect(document.body.textContent).includes('Loading')
  expect(document.body.textContent).not.includes('Create League')
  await act(async () => {
    rejectLoad(new Error('Cannot load groups'))
  })
  expect(document.body.textContent).includes('Cannot load groups')
  expect(document.body.textContent).not.includes('Create League')
})
