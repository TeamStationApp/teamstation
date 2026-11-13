import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'
import React, { act } from 'react'

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
  rowTextColor,
  settle,
  text,
  unmount
} from '../../test/gameFormDom'
import {
  chooseCalendarDate,
  chooseDateRange,
  hasLabel,
  tapLabel,
  tapText,
  venueDetail,
  venueField
} from '../../test/venueDom'
import { ScopedThemeProvider } from '../theme/ThemeContext'
import { tsDark } from '../theme/tsDark'
import { ScheduleSeasonScreen } from './ScheduleSeasonScreen'

const SEASON: SetupSeason = {
  id: 'sea_a',
  name: 'Demo Regular',
  year: 2027,
  timezone: 'America/New_York',
  participants: 1,
  exhibitionTeams: 1,
  teams: [
    { id: 'tem_hawks', name: 'Demo Hawks', exhibition: false },
    { id: 'tem_owls', name: 'Demo Owls', exhibition: true }
  ],
  saved: false,
  settings: {
    fieldSize: '50/70',
    gameMinutes: 90,
    bufferMinutes: 10,
    regularGames: 4,
    exhibitionGames: 1,
    doubleheaders: 'ifNecessary',
    startsOn: '2027-03-01',
    endsOn: '2027-07-31',
    blackouts: [],
    windows: []
  }
}

const EVENINGS = [{ weekday: 2, start: '17:30', end: '21:00' }]
const LATER = [{ weekday: 2, start: '18:00', end: '21:00' }]

/** seasonA's two periods: from Mar 1, and from Jun 1. */
const PERIODS = [
  { from: '2027-03-01', hours: EVENINGS },
  { from: '2027-06-01', hours: LATER }
]

/** The league's playoffs: Mar 1 to May 31, at the UTC default. */
const PLAYOFFS: SetupSeason = {
  ...SEASON,
  id: 'sea_p',
  name: 'Demo Playoffs',
  timezone: 'UTC',
  teams: [],
  participants: 0,
  exhibitionTeams: 0,
  settings: { ...SEASON.settings, endsOn: '2027-05-31' }
}

function fakeClient(
  season: SetupSeason | null | Error,
  options: { failFlag?: boolean; others?: SetupSeason[] } = {}
): {
  client: TeamStationClient
  saves: ScheduleSettings[]
  /** Anything a save sent beyond the season and its settings. */
  extras: unknown[][]
  flags: Array<[string, boolean]>
} {
  let reads = 0
  const record = {
    saves: [] as ScheduleSettings[],
    extras: [] as unknown[][],
    flags: [] as Array<[string, boolean]>,
    client: undefined as unknown as TeamStationClient
  }
  record.client = {
    scheduleSetup: async (): Promise<ScheduleSetup> => {
      reads++
      if (season instanceof Error && reads === 1) throw season
      return {
        leagueId: 'lea_a',
        seasonIds: [],
        fieldIds: [],
        addedFieldIds: [],
        seasons: [
          ...(options.others ?? []),
          ...(season == null ? [] : [season instanceof Error ? SEASON : season])
        ],
        fields: []
      }
    },
    saveScheduleSettings: async (
      seasonId: string,
      settings: ScheduleSettings,
      ...extra: unknown[]
    ) => {
      record.saves.push(settings)
      record.extras.push(extra)
      return { seasonId, saved: true, settings }
    },
    setExhibitionTeam: async (
      _seasonId: string,
      teamId: string,
      exhibition: boolean
    ) => {
      record.flags.push([teamId, exhibition])
      if (options.failFlag === true) throw new Error('Not found')
    }
  } as unknown as TeamStationClient
  return record
}

const show = async (
  client: TeamStationClient,
  seasonId = 'sea_a'
): Promise<void> => {
  await mount(
    <ScheduleSeasonScreen
      client={client}
      leagueId="lea_a"
      seasonId={seasonId}
    />
  )
  await settle(50)
}

describe('a season of the next schedule', () => {
  afterEach(unmount)
  // The viewer is in Pacific Time.
  const zone = process.env.TZ
  before(() => {
    process.env.TZ = 'America/Los_Angeles'
  })
  after(() => {
    if (zone == null) delete process.env.TZ
    else process.env.TZ = zone
  })

  it('selects season fields explicitly, disables incompatible fields and prunes them on size changes', async () => {
    const fields: SetupField[] = [
      {
        id: 'fld_one',
        name: 'Field 1',
        venueId: 'ven_demo',
        venueName: 'Example Park',
        sizes: ['50/70'],
        startsOn: null,
        endsOn: null,
        deleted: false,
        ours: true,
        ownerNames: []
      },
      {
        id: 'fld_two',
        name: 'Field 2',
        venueId: 'ven_demo',
        venueName: 'Example Park',
        sizes: ['60/90'],
        startsOn: null,
        endsOn: null,
        deleted: false,
        ours: true,
        ownerNames: []
      }
    ]
    const record = fakeClient(SEASON)
    const original = record.client.scheduleSetup.bind(record.client)
    record.client.scheduleSetup = async id => ({
      ...(await original(id)),
      fields
    })
    await show(record.client)
    expect(text()).includes('Season Scheduling Constraints')
    expect(text()).includes('CHOOSE REQUIRED FIELD SIZE')
    const incompatible = document.querySelector(
      '[aria-label="Field 2, Example Park"]'
    )!
    expect(incompatible.getAttribute('aria-disabled')).equals('true')
    await tapLabel('Field 2, Example Park')
    expect(record.saves).length(0)
    await tapLabel('Field 1, Example Park')
    expect(record.saves.at(-1)?.fieldIds).deep.equals(['fld_one'])
    await act(async () => {
      document
        .querySelector<HTMLElement>('[aria-label="Required field size 60/90"]')!
        .click()
    })
    await settle()
    expect(record.saves.at(-1)).includes({ fieldSize: '60/90' })
    expect(record.saves.at(-1)?.fieldIds).deep.equals([])
    expect(
      document.querySelector<HTMLInputElement>(
        '[aria-label="Required field size 50/70"]'
      )!.checked
    ).equals(false)
    await tapLabel('Field 2, Example Park')
    expect(record.saves.at(-1)?.fieldIds).deep.equals(['fld_two'])
  })

  it('adds a registry field to the list, selects it only when its size matches and removes it without deleted fields', async () => {
    const record = fakeClient(SEASON)
    const chosen = venueField({
      id: 'fld_harbor',
      name: 'Harbor Diamond',
      sizes: ['50/70']
    })
    const venue = venueDetail({ fields: [chosen] })
    record.client.venues = async () => [
      {
        ...venue,
        placeId: 'demo',
        group: 'unclaimed',
        distanceKm: null,
        claimed: false,
        pendingClaim: false
      }
    ]
    record.client.venue = async () => venue
    let added: string[] = []
    let listed: string[] | undefined
    record.client.saveScheduleSetup = async (_id, choice) => {
      added = choice.addedFieldIds ?? []
      listed = choice.fieldIds
      return {
        ...(await record.client.scheduleSetup('lea_a')),
        fieldIds: ['fld_gone'],
        addedFieldIds: added,
        fields: [
          {
            ...chosen,
            id: 'fld_gone',
            name: 'Gone Field',
            venueId: venue.id!,
            venueName: venue.name,
            deleted: true,
            ours: true,
            ownerNames: []
          },
          {
            ...chosen,
            venueId: venue.id!,
            venueName: venue.name,
            deleted: false,
            ours: false,
            ownerNames: []
          }
        ]
      }
    }
    await show(record.client)
    await tapLabel('Add a field from the registry')
    await settle()
    await press(`${venue.name}, ${venue.address}`)
    await settle()
    await press('Harbor Diamond, 50/70')
    await settle()
    expect(added).deep.equals(['fld_harbor'])
    expect(record.saves.at(-1)?.fieldIds).deep.equals(['fld_harbor'])
    await tapLabel(`Remove Harbor Diamond, ${venue.name} from the list`)
    await settle()
    expect(added).deep.equals([])
    expect(listed).deep.equals([])
    expect(record.saves.at(-1)?.fieldIds).deep.equals([])
  })

  it('repairs multiple deleted, incompatible and missing selections in one save', async () => {
    const record = fakeClient({
      ...SEASON,
      settings: {
        ...SEASON.settings,
        fieldIds: ['stale', 'stale2', 'incompatible', 'missing', 'valid']
      }
    })
    const original = record.client.scheduleSetup.bind(record.client)
    const stale: SetupField = {
      id: 'stale',
      name: 'Old Field',
      venueId: 'venue',
      venueName: 'Park',
      sizes: ['50/70'],
      startsOn: null,
      endsOn: null,
      deleted: true,
      ours: true,
      ownerNames: []
    }
    record.client.scheduleSetup = async id => ({
      ...(await original(id)),
      fields: [
        stale,
        { ...stale, id: 'stale2', name: 'Old Field 2' },
        {
          ...stale,
          id: 'incompatible',
          name: 'Large Field',
          sizes: ['60/90'],
          deleted: false
        },
        { ...stale, id: 'valid', name: 'Current Field', deleted: false }
      ]
    })
    const save = record.client.saveScheduleSettings.bind(record.client)
    record.client.saveScheduleSettings = async (id, settings) => {
      if (settings.fieldIds?.some(field => field !== 'valid') === true)
        throw new Error('Choose available fields of the required size')
      return await save(id, settings)
    }
    await show(record.client)
    expect(
      document
        .querySelector('[aria-label="Old Field, Park"]')!
        .getAttribute('aria-disabled')
    ).equals('true')
    await tapLabel('Remove unavailable selection Old Field')
    await settle()
    expect(record.saves.at(-1)?.fieldIds).deep.equals(['valid'])
    expect(hasLabel('Remove unavailable selection Old Field')).equals(false)
    expect(hasLabel('Remove unavailable selection Old Field 2')).equals(false)
    expect(hasLabel('Remove unavailable selection Large Field')).equals(false)
  })

  it('shows and saves weekly maximums and the preferred portion, preserving other settings', async () => {
    const record = fakeClient(SEASON)
    await show(record.client)
    const field = (label: string): HTMLInputElement =>
      document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
    expect(hasLabel('Max games on weekdays: 1')).equals(true)
    expect(hasLabel('Max games on weekend: 1')).equals(true)
    expect(text().indexOf('Max games on weekdays')).lessThan(
      text().indexOf('Max games on weekend')
    )
    expect(text().indexOf('Max games on weekend')).lessThan(
      text().indexOf('Prefer game on:')
    )
    await tapLabel('Max games on weekdays: 1')
    await fill('Max games on weekdays', '2')
    await act(async () => {
      field('Max games on weekdays').blur()
    })
    await settle()
    expect(record.saves.at(-1)).includes({
      maxGamesOnWeekdays: 2,
      gameMinutes: 90
    })
    expect(text()).includes('Game maximum saved.')
    await tapLabel('Max games on weekend: 1')
    await fill('Max games on weekend', '0')
    await act(async () => {
      field('Max games on weekend').blur()
    })
    await settle()
    await tapLabel('weekdays')
    expect(record.saves.at(-1)).includes({
      maxGamesOnWeekdays: 2,
      maxGamesOnWeekend: 0,
      preferGameOn: 'weekdays'
    })
    const count = record.saves.length
    await tapLabel('Max games on weekend: 0')
    await fill('Max games on weekend', '201')
    await act(async () => {
      field('Max games on weekend').blur()
    })
    await settle()
    expect(record.saves).length(count)
    expect(text()).includes('Choose a maximum from 0 to 200.')
    await act(async () => {
      field('Max games on weekend').focus()
    })
    await fill('Max games on weekend', '0')
    await act(async () => {
      field('Max games on weekend').blur()
    })
    await settle()
    expect(record.saves).length(count)
    expect(text()).not.includes('Choose a maximum from 0 to 200.')
    await tapLabel('weekend')
    expect(hasLabel('Max games on weekend: 0')).equals(true)
    expect(record.saves.at(-1)).includes({
      maxGamesOnWeekend: 0,
      preferGameOn: 'weekend'
    })
  })

  it('keeps its period rows readable on a dark shared card', async () => {
    await mount(
      <ScopedThemeProvider theme={tsDark}>
        <ScheduleSeasonScreen
          client={
            fakeClient({
              ...SEASON,
              settings: { ...SEASON.settings, windows: PERIODS }
            }).client
          }
          leagueId="lea_a"
          seasonId="sea_a"
        />
      </ScopedThemeProvider>
    )
    await settle(50)
    expect(rowTextColor('Starts')).equals('rgb(31, 36, 24)')
    await tapLabel('Max games on weekdays: 1')
    expect(
      getComputedStyle(
        document.querySelector('[aria-label="Max games on weekdays"]')!
      ).color
    ).equals('rgb(31, 36, 24)')
  })

  it('loads after a failure, and says when the season has left the league', async () => {
    await show(fakeClient(new Error('down')).client)
    expect(text()).includes('could not load')
    await press('Retry')
    await settle(50)
    expect(text()).includes('Times are local to each field.')
    await unmount()
    await show(fakeClient(null).client)
    expect(text()).includes('no longer part of the league')
  })

  it('adds window periods with end dates, sets their hours, and removes one', async () => {
    const fake = fakeClient(SEASON)
    await show(fake.client)
    expect(text()).includes('No time windows. No games can be scheduled.')
    await tapText('Add another time window')
    await settle(20)
    // A season's first window runs to its last day; every window ends.
    expect(fake.saves.at(-1)?.windows).deep.equals([
      { from: '2027-03-01', until: '2027-07-31', hours: [] }
    ])
    await press('Windows from Monday, March 1, 2027: Saturday, Closed')
    await tapText('Open')
    await tapText('Done')
    await settle(20)
    const open = [{ weekday: 6, start: '17:00', end: '21:00' }]
    expect(fake.saves.at(-1)?.windows).deep.equals([
      { from: '2027-03-01', until: '2027-07-31', hours: open }
    ])
    expect(text()).includes('Time windows saved.')
    await tapText('Add another time window')
    await chooseCalendarDate('2027-06-01')
    await settle(20)
    // The new period starts as a copy of the one it splits.
    expect(fake.saves.at(-1)?.windows).deep.equals([
      { from: '2027-03-01', until: '2027-05-31', hours: open },
      { from: '2027-06-01', until: '2027-07-31', hours: open }
    ])
    await tapText('Add another time window')
    await chooseCalendarDate('2027-06-01')
    expect(text()).includes('A period already starts on that date.')
    await tapLabel('Remove Windows from Monday, March 1, 2027')
    await settle(20)
    expect(fake.saves.at(-1)?.windows.map(period => period.from)).deep.equals([
      '2027-06-01'
    ])
  })

  it('splits a dated period when a period is added from a date inside it', async () => {
    const dated = [
      { from: '2027-03-01', until: '2027-05-31', hours: EVENINGS },
      PERIODS[1]
    ]
    const fake = fakeClient({
      ...SEASON,
      settings: { ...SEASON.settings, windows: dated }
    })
    await show(fake.client)
    await tapText('Add another time window')
    await chooseCalendarDate('2027-04-15')
    await settle(20)
    expect(text()).not.includes('can’t overlap')
    expect(fake.saves.at(-1)?.windows).deep.equals([
      { from: '2027-03-01', until: '2027-04-14', hours: EVENINGS },
      { from: '2027-04-15', until: '2027-05-31', hours: EVENINGS },
      // An older open window gets the season's last day as its end.
      { ...PERIODS[1], until: '2027-07-31' }
    ])
    expect(text()).includes('Mar 1 – Apr 14')
    expect(text()).includes('Apr 15 – May 31')
    expect(text()).includes('Time windows saved.')
  })

  it('moves a period’s end, and has no way to leave one without an end', async () => {
    const bounded = [
      { from: '2027-03-01', until: '2027-05-31', hours: EVENINGS },
      { from: '2027-06-01', until: '2027-07-31', hours: LATER }
    ]
    const fake = fakeClient({
      ...SEASON,
      settings: { ...SEASON.settings, windows: bounded }
    })
    await show(fake.client)
    expect(text()).includes('Mar 1 – May 31')
    expect(text()).includes('Jun 1 – Jul 31')
    await tapLabel('Change the end of Windows from Monday, March 1, 2027')
    expect(hasLabel('Choose 2027-05-31')).equals(true)
    // A season's window always ends.
    expect(text()).not.includes('No end date')
    await chooseCalendarDate('2027-05-20')
    await settle(20)
    expect(fake.saves.at(-1)?.windows).deep.equals([
      { from: '2027-03-01', until: '2027-05-20', hours: EVENINGS },
      bounded[1]
    ])
    expect(text()).includes('Mar 1 – May 20')
    expect(text()).includes('Thursday, May 20, 2027')
    expect(text()).includes('Time windows saved.')
    // An end date on or after the next period's start is refused here.
    await tapLabel('Change the end of Windows from Monday, March 1, 2027')
    await chooseCalendarDate('2027-06-01')
    await settle(20)
    expect(fake.saves).length(1)
    expect(text()).includes('Periods of game windows can’t overlap.')
    // So is one before the period's start.
    await tapLabel('Change the end of Windows from Monday, March 1, 2027')
    await chooseCalendarDate('2027-02-27')
    expect(text()).includes(
      'End each period of game windows on or after the day it starts.'
    )
    expect(fake.saves).length(1)
    // The last period's calendar opens on its own last day.
    await tapLabel('Change the end of Windows from Tuesday, June 1, 2027')
    expect(hasLabel('Choose 2027-07-31')).equals(true)
    await tapText('Cancel')
    expect(fake.saves).length(1)
  })

  it('moves a period’s start within its end, and names a date outside the season’s year with its year', async () => {
    const fake = fakeClient({
      ...SEASON,
      settings: {
        ...SEASON.settings,
        endsOn: '2028-01-31',
        windows: [
          PERIODS[0],
          { from: '2027-12-20', until: '2028-01-10', hours: LATER }
        ]
      }
    })
    await show(fake.client)
    expect(text()).includes('Dec 20 – Jan 10, 2028')
    await tapLabel('Change the start of Windows from Monday, March 1, 2027')
    await chooseCalendarDate('2027-03-08')
    await settle(20)
    expect(fake.saves.at(-1)?.windows.map(period => period.from)).deep.equals([
      '2027-03-08',
      '2027-12-20'
    ])
    expect(text()).includes('Time windows saved.')
    // The window that had no end now ends before the next one starts.
    expect(fake.saves.at(-1)?.windows[0].until).equals('2027-12-19')
    // A start past its own end is refused.
    await tapLabel('Change the start of Windows from Monday, March 8, 2027')
    await chooseCalendarDate('2028-01-20')
    await settle(20)
    expect(text()).includes(
      'End each period of game windows on or after the day it starts.'
    )
    expect(fake.saves).length(1)
  })

  it('copies the game windows of another of the league’s seasons, moved to this one', async () => {
    const empty = { ...SEASON, id: 'sea_none', name: 'Demo Fall' }
    const spring = {
      ...SEASON,
      settings: {
        ...SEASON.settings,
        windows: [{ ...PERIODS[0], until: '2027-05-20' }, PERIODS[1]]
      }
    }
    const older = {
      ...SEASON,
      id: 'sea_old',
      name: 'Demo Spring',
      year: 2026,
      settings: {
        ...SEASON.settings,
        startsOn: '2026-03-01',
        endsOn: '2026-07-31',
        windows: [{ from: '2026-04-01', hours: EVENINGS }]
      }
    }
    const fake = fakeClient(PLAYOFFS, { others: [older, empty, spring] })
    await show(fake.client, 'sea_p')
    await tapText('Copy from another season')
    // Only the other seasons with windows, newest first.
    const sheet = text().slice(text().indexOf('Copy game windows from'))
    expect(sheet.indexOf('Demo Regular')).lessThan(sheet.indexOf('Demo Spring'))
    expect(sheet).includes('2027 · 2 periods')
    expect(sheet).includes('2026 · 1 period')
    expect(sheet).not.includes('Demo Fall')
    await tapLabel('Demo Regular')
    await settle(20)
    // The seasons start together, and the June period starts after the
    // playoffs end, so only the first is copied.
    expect(fake.saves.at(-1)?.windows).deep.equals([
      { from: '2027-03-01', until: '2027-05-20', hours: EVENINGS }
    ])
    expect(fake.extras.at(-1)).deep.equals([])
    expect(text()).includes('Game windows copied from Demo Regular.')
    expect(text()).includes('Mar 1 – May 20')
    // Over windows the season has, the copy asks first.
    await tapText('Copy from another season')
    await tapLabel('Demo Spring')
    expect(text()).includes('Replace this season’s game windows?')
    expect(text()).includes(
      'Demo Spring’s windows take the place of this season’s 1 period.'
    )
    await tapText('Cancel')
    expect(fake.saves).length(1)
    expect(text()).includes('Mar 1 – May 20')
    await tapText('Copy from another season')
    await tapLabel('Demo Spring')
    await tapLabel('Replace game windows')
    await settle(20)
    // A year apart, the April 1 period lands on April 1 here.
    expect(fake.saves.at(-1)?.windows).deep.equals([
      { from: '2027-04-01', hours: EVENINGS }
    ])
    expect(text()).includes('From Apr 1')
  })

  it('asks to replace in the sheet the source was picked in, never in a second sheet', async () => {
    // iOS won't present a modal while another is leaving, so the question
    // takes the place of the list in the same, still-presented sheet.
    const playoffs = {
      ...PLAYOFFS,
      settings: { ...PLAYOFFS.settings, windows: [PERIODS[1]] }
    }
    const regular = {
      ...SEASON,
      settings: { ...SEASON.settings, windows: [PERIODS[0]] }
    }
    const fake = fakeClient(playoffs, { others: [regular] })
    await show(fake.client, 'sea_p')
    const sheets = (): Element[] => [
      ...document.querySelectorAll('[aria-label="Close"]')
    ]
    expect(sheets()).length(0)
    await tapText('Copy from another season')
    expect(sheets()).length(1)
    const sheet = sheets()[0]
    await tapLabel('Demo Regular')
    expect(text()).includes('Replace this season’s game windows?')
    expect(text()).not.includes('Copy game windows from')
    // The same sheet, never unmounted, and no other beside it.
    expect(sheets()).length(1)
    expect(sheets()[0]).equals(sheet)
    expect(sheet.isConnected).equals(true)
    expect(fake.saves).length(0)
    await tapLabel('Replace game windows')
    await settle(20)
    expect(sheets()).length(0)
    expect(fake.saves.at(-1)?.windows).deep.equals([
      { from: '2027-03-01', hours: EVENINGS }
    ])
    // Cancel at the question closes the sheet and keeps what was there.
    await tapText('Copy from another season')
    await tapLabel('Demo Regular')
    await tapText('Cancel')
    expect(sheets()).length(0)
    expect(fake.saves).length(1)
    // So does a tap on the screen behind it.
    await tapText('Copy from another season')
    await tapLabel('Demo Regular')
    await tapLabel('Close')
    expect(sheets()).length(0)
    expect(text()).not.includes('Replace this season’s game windows?')
    expect(fake.saves).length(1)
  })

  it('says when another season’s windows all fall after this one ends, and saves nothing', async () => {
    const late = {
      ...SEASON,
      settings: { ...SEASON.settings, windows: [PERIODS[1]] }
    }
    const fake = fakeClient(PLAYOFFS, { others: [late] })
    await show(fake.client, 'sea_p')
    await tapText('Copy from another season')
    await tapLabel('Demo Regular')
    await settle(20)
    expect(text()).includes(
      'Demo Regular’s windows all fall after this season ends.'
    )
    expect(fake.saves).deep.equals([])
    // With no other season's windows to copy, there is no button.
    await unmount()
    await show(fakeClient(PLAYOFFS, { others: [SEASON] }).client, 'sea_p')
    expect(text()).not.includes('Copy from another season')
  })

  it('says times are local to each field, whatever zone the season holds, and saves no zone', async () => {
    for (const timezone of ['America/New_York', 'UTC']) {
      const fake = fakeClient({ ...SEASON, timezone })
      await show(fake.client)
      expect(text(), timezone).includes('Times are local to each field.')
      for (const named of [
        'UTC',
        'Coordinated Universal Time',
        'Eastern Time',
        'Pacific Time',
        'time zone'
      ])
        expect(text(), timezone).not.includes(named)
      await tapText('Add another time window')
      await settle(20)
      await press('Add blackout dates')
      await chooseDateRange('2027-04-17', '2027-04-17')
      await settle(20)
      expect(fake.saves, timezone).length(2)
      for (const saved of fake.saves)
        expect(saved, timezone).not.have.property('timezone')
      expect(fake.extras, timezone).deep.equals([[], []])
      await unmount()
    }
  })

  it('sets blackout days and exhibition teams', async () => {
    const fake = fakeClient(SEASON)
    await show(fake.client)
    // A range is added as its dates, and listed as one range.
    await press('Add blackout dates')
    await chooseDateRange('2027-04-02', '2027-04-05')
    await settle(20)
    expect(fake.saves.at(-1)?.blackouts).deep.equals([
      '2027-04-02',
      '2027-04-03',
      '2027-04-04',
      '2027-04-05'
    ])
    expect(text()).includes('Apr 2 – Apr 5 · 4 days')
    await tapLabel('Demo Hawks')
    await settle(20)
    expect(fake.flags).deep.equals([['tem_hawks', true]])
    expect(text()).includes('Demo Hawks saved.')
    await tapLabel('Demo Owls')
    await settle(20)
    expect(fake.flags.at(-1)).deep.equals(['tem_owls', false])
  })

  it('says when a flag can’t be saved, and when there are no teams', async () => {
    const fake = fakeClient(SEASON, { failFlag: true })
    await show(fake.client)
    await tapLabel('Demo Hawks')
    await settle(20)
    expect(text()).includes('Not found')
    await unmount()
    await show(fakeClient({ ...SEASON, teams: [] }).client)
    expect(text()).includes('This season has no teams yet.')
  })
})
