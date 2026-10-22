import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import type { TeamStationClient } from '../../common/api'
import type {
  ScheduleSettings,
  ScheduleSetup,
  SetupField,
  SetupSeason
} from '../../common/seasonScheduling'
import {
  fill,
  mount,
  press,
  settle,
  text,
  unmount
} from '../../test/gameFormDom'
import { hasLabel, tapLabel, tapText } from '../../test/venueDom'
import { AutoSchedulerScreen, chosenSeasons } from './AutoSchedulerScreen'
import { seasonGameTotal } from './SeasonScheduleGrid'

const SETTINGS: ScheduleSettings = {
  fieldSize: '50/70',
  gameMinutes: 90,
  bufferMinutes: 10,
  regularGames: 3,
  exhibitionGames: 1,
  doubleheaders: 'ifNecessary',
  startsOn: '2027-03-01',
  endsOn: '2027-07-31',
  blackouts: [],
  windows: [
    {
      from: '2027-03-01',
      hours: [{ weekday: 6, start: '08:00', end: '18:00' }]
    }
  ]
}

function season(overrides: Partial<SetupSeason> = {}): SetupSeason {
  return {
    id: 'sea_a',
    name: 'Demo Regular',
    year: 2027,
    timezone: 'America/New_York',
    participants: 7,
    exhibitionTeams: 2,
    teams: [],
    saved: true,
    settings: SETTINGS,
    ...overrides
  }
}

function field(overrides: Partial<SetupField> = {}): SetupField {
  return {
    id: 'fld_one',
    name: 'Field 1',
    venueId: 'ven_demo',
    venueName: 'Example Park',
    sizes: ['50/70'],
    startsOn: null,
    endsOn: null,
    deleted: false,
    ...overrides
  }
}

function setupOf(overrides: Partial<ScheduleSetup> = {}): ScheduleSetup {
  return {
    leagueId: 'lea_a',
    seasonIds: ['sea_a'],
    fieldIds: ['fld_one'],
    seasons: [
      season(),
      season({
        id: 'sea_c',
        name: 'Demo Fall',
        participants: 4,
        exhibitionTeams: 0,
        saved: false,
        settings: { ...SETTINGS, fieldSize: '55/80', exhibitionGames: 0 }
      })
    ],
    fields: [field()],
    ...overrides
  }
}

function fakeClient(
  first: ScheduleSetup | Error,
  options: { failSave?: boolean; failChoice?: boolean } = {}
): {
  client: TeamStationClient
  choices: Array<{ seasonIds: string[]; fieldIds: string[] }>
  saves: Array<[string, ScheduleSettings]>
} {
  let setup = first instanceof Error ? setupOf() : first
  let reads = 0
  const record = {
    choices: [] as Array<{ seasonIds: string[]; fieldIds: string[] }>,
    saves: [] as Array<[string, ScheduleSettings]>,
    client: undefined as unknown as TeamStationClient
  }
  record.client = {
    scheduleSetup: async () => {
      reads++
      if (first instanceof Error && reads === 1) throw first
      return setup
    },
    saveScheduleSetup: async (
      _leagueId: string,
      choice: { seasonIds: string[]; fieldIds: string[] }
    ) => {
      record.choices.push(choice)
      if (options.failChoice === true)
        throw new Error('Choose fields of claimed venues')
      setup = { ...setup, ...choice }
      return setup
    },
    saveScheduleSettings: async (
      seasonId: string,
      settings: ScheduleSettings
    ) => {
      record.saves.push([seasonId, settings])
      if (options.failSave === true) throw new Error('')
      return { seasonId, saved: true, settings }
    }
  } as unknown as TeamStationClient
  return record
}

async function show(
  client: TeamStationClient,
  calls: { fieldManager: number; seasons: string[]; builds: number }
): Promise<void> {
  await mount(
    <AutoSchedulerScreen
      client={client}
      leagueId="lea_a"
      leagueName="Demo League A"
      onFieldManager={() => {
        calls.fieldManager++
      }}
      onOpenSeason={seasonId => {
        calls.seasons.push(seasonId)
      }}
      onBuild={() => {
        calls.builds++
      }}
    />
  )
  await settle(50)
}

const buildButton = (): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
    node => node.textContent === 'Build schedule'
  )!

const disabled = (node: HTMLElement): boolean =>
  node.getAttribute('aria-disabled') === 'true'

describe('the Auto-Scheduler setup', () => {
  afterEach(unmount)

  it('totals a season’s games', () => {
    expect(seasonGameTotal(season())).equals(10 + 7)
    expect(seasonGameTotal(season({ exhibitionTeams: 0 }))).equals(10)
    expect(chosenSeasons(setupOf()).map(item => item.id)).deep.equals(['sea_a'])
  })

  it('loads after a failure, and shows the grid, warnings and fields', async () => {
    const fake = fakeClient(new Error('down'))
    const calls = { fieldManager: 0, seasons: [] as string[], builds: 0 }
    await show(fake.client, calls)
    expect(text()).includes('could not load')
    await press('Retry')
    await settle(50)
    expect(text()).includes('Demo League A')
    expect(hasLabel('Demo Regular Teams: 7 + 2 exh.')).equals(true)
    expect(hasLabel('Demo Regular Size: 50/70')).equals(true)
    expect(hasLabel('Demo Regular Total games: 17')).equals(true)
    expect(hasLabel('Demo Regular Doubleheaders: Only if necessary')).equals(
      true
    )
    expect(hasLabel('Demo Regular Dates: Mar 1 – Jul 31')).equals(true)
    expect(hasLabel('Demo Regular Blackouts: None')).equals(true)
    expect(hasLabel('Demo Regular Windows: 1 period')).equals(true)
    expect(text()).includes('an odd number')
    expect(text()).includes('4 for one, 3 for the other')
    expect(disabled(buildButton())).equals(false)
    await tapText('Build schedule')
    expect(calls.builds).equals(1)
    await tapLabel('Open the Field Manager')
    await press(
      'Field Manager, Find, claim and set up the venues and fields your league plays on'
    )
    expect(calls.fieldManager).equals(2)
    await tapLabel('Open Demo Regular')
    await tapLabel('Demo Regular Windows: 1 period')
    await tapLabel('Demo Regular Blackouts: None')
    await tapLabel('Demo Regular Teams: 7 + 2 exh.')
    expect(calls.seasons).deep.equals(['sea_a', 'sea_a', 'sea_a', 'sea_a'])
  })

  it('chooses seasons and fields, and blocks building without a field of the size', async () => {
    const fake = fakeClient(setupOf())
    const calls = { fieldManager: 0, seasons: [] as string[], builds: 0 }
    await show(fake.client, calls)
    await tapLabel('Demo Fall')
    await settle(20)
    expect(fake.choices.at(-1)).deep.equals({
      seasonIds: ['sea_a', 'sea_c'],
      fieldIds: ['fld_one']
    })
    expect(text()).includes(
      'Must fix: Demo Fall has no chosen field that sets up as 55/80.'
    )
    expect(disabled(buildButton())).equals(true)
    await tapLabel('Demo Fall')
    await settle(20)
    expect(fake.choices.at(-1)?.seasonIds).deep.equals(['sea_a'])
    expect(disabled(buildButton())).equals(false)
    await tapLabel('Field 1, Example Park')
    await settle(20)
    expect(fake.choices.at(-1)?.fieldIds).deep.equals([])
    expect(disabled(buildButton())).equals(true)
  })

  it('edits a size, doubleheaders, a number and the dates from the grid', async () => {
    const fake = fakeClient(setupOf())
    const calls = { fieldManager: 0, seasons: [] as string[], builds: 0 }
    await show(fake.client, calls)
    await tapLabel('Demo Regular Size: 50/70')
    await press('60/90')
    await settle(20)
    expect(fake.saves.at(-1)?.[1].fieldSize).equals('60/90')
    expect(hasLabel('Demo Regular Size: 60/90')).equals(true)
    await tapLabel('Demo Regular Doubleheaders: Only if necessary')
    await press('Never')
    await settle(20)
    expect(fake.saves.at(-1)?.[1].doubleheaders).equals('never')
    await tapLabel('Demo Regular Game: 90 min')
    await fill('Game length, in minutes', '92')
    await tapText('Save')
    expect(text()).includes('Choose 30 to 600, in 5-minute steps.')
    await fill('Game length, in minutes', '')
    await tapText('Save')
    expect(text()).includes('Choose 30 to 600')
    await fill('Game length, in minutes', '75')
    await tapText('Save')
    await settle(20)
    expect(fake.saves.at(-1)?.[1].gameMinutes).equals(75)
    expect(hasLabel('Demo Regular Game: 75 min')).equals(true)
    await tapLabel('Demo Regular Regular: 3')
    await fill('Regular-season games per team', '4')
    await tapText('Save')
    await settle(20)
    expect(text()).not.includes('an odd number')
    await tapLabel('Demo Regular Between: 10 min')
    await tapText('Cancel')
    await tapLabel('Demo Regular Exhibition: 1')
    expect(hasLabel('Exhibition games per team')).equals(true)
    await tapText('Cancel')
    await tapLabel('Demo Regular Dates: Mar 1 – Jul 31')
    await tapLabel('2027-03-08')
    await tapLabel('2027-03-20')
    await tapText('Use this range')
    await settle(20)
    expect(fake.saves.at(-1)?.[1]).deep.include({
      startsOn: '2027-03-08',
      endsOn: '2027-03-20'
    })
    await tapLabel('Demo Regular Dates: Mar 8 – Mar 20')
    await tapText('Cancel')
    expect(fake.saves.length).equals(5)
  })

  it('says when a save fails, and leaves a deleted field out of changes', async () => {
    const fake = fakeClient(
      setupOf({
        fieldIds: ['fld_one', 'fld_gone'],
        fields: [
          field(),
          field({ id: 'fld_gone', name: 'Field 2', deleted: true })
        ]
      }),
      { failSave: true }
    )
    const calls = { fieldManager: 0, seasons: [] as string[], builds: 0 }
    await show(fake.client, calls)
    expect(text()).includes('Deleted. Uncheck it to leave it out.')
    await tapLabel('Demo Fall')
    await settle(20)
    expect(fake.choices.at(-1)?.fieldIds).deep.equals(['fld_one'])
    await tapLabel('Demo Regular Game: 90 min')
    await fill('Game length, in minutes', '60')
    await tapText('Save')
    await settle(20)
    expect(text()).includes('That could not be saved. Try again.')
    expect(hasLabel('Game length, in minutes')).equals(true)
  })

  it('names a refused choice, and an empty league', async () => {
    const fake = fakeClient(setupOf(), { failChoice: true })
    const calls = { fieldManager: 0, seasons: [] as string[], builds: 0 }
    await show(fake.client, calls)
    await tapLabel('Field 1, Example Park')
    await settle(20)
    expect(text()).includes('Choose fields of claimed venues')
    await unmount()
    await show(
      fakeClient(
        setupOf({ seasons: [], fields: [], seasonIds: [], fieldIds: [] })
      ).client,
      calls
    )
    expect(text()).includes('This league has no seasons yet.')
    expect(text()).includes('Your league has no fields yet.')
    expect(text()).includes('Must fix: Choose a season to schedule.')
  })
})
