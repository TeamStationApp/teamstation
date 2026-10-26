import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'
import React from 'react'

import type { TeamStationClient } from '../../common/api'
import type {
  ScheduleSettings,
  ScheduleSetup,
  SetupSeason
} from '../../common/seasonScheduling'
import { mount, press, settle, text, unmount } from '../../test/gameFormDom'
import {
  chooseCalendarDate,
  chooseDateRange,
  hasLabel,
  tapLabel,
  tapText
} from '../../test/venueDom'
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

  it('adds window periods, sets their hours, and removes one', async () => {
    const fake = fakeClient(SEASON)
    await show(fake.client)
    expect(text()).includes('No game windows yet.')
    await tapText('Add game windows')
    await settle(20)
    expect(fake.saves.at(-1)?.windows).deep.equals([
      { from: '2027-03-01', hours: [] }
    ])
    await press('Windows from Monday, March 1, 2027: Saturday, Closed')
    await tapText('Open')
    await tapText('Done')
    await settle(20)
    expect(fake.saves.at(-1)?.windows).deep.equals([
      {
        from: '2027-03-01',
        hours: [{ weekday: 6, start: '17:00', end: '21:00' }]
      }
    ])
    expect(text()).includes('Windows saved.')
    await tapText('Add a period from a date')
    await chooseCalendarDate('2027-06-01')
    await settle(20)
    // The new period starts as a copy of the one before it.
    expect(fake.saves.at(-1)?.windows).deep.equals([
      {
        from: '2027-03-01',
        hours: [{ weekday: 6, start: '17:00', end: '21:00' }]
      },
      {
        from: '2027-06-01',
        hours: [{ weekday: 6, start: '17:00', end: '21:00' }]
      }
    ])
    await tapText('Add a period from a date')
    await chooseCalendarDate('2027-06-01')
    expect(text()).includes('A period already starts on that date.')
    await tapLabel('Remove the windows from Monday, March 1, 2027')
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
    await tapText('Add a period from a date')
    await chooseCalendarDate('2027-04-15')
    await settle(20)
    expect(text()).not.includes('can’t overlap')
    expect(fake.saves.at(-1)?.windows).deep.equals([
      { from: '2027-03-01', until: '2027-04-14', hours: EVENINGS },
      { from: '2027-04-15', until: '2027-05-31', hours: EVENINGS },
      PERIODS[1]
    ])
    expect(text()).includes('Mar 1 – Apr 14')
    expect(text()).includes('Apr 15 – May 31')
    expect(text()).includes('Period added.')
  })

  it('gives a period an end date, then takes it away again', async () => {
    const fake = fakeClient({
      ...SEASON,
      settings: { ...SEASON.settings, windows: PERIODS }
    })
    await show(fake.client)
    expect(text()).includes('From Mar 1')
    expect(text()).includes('From Jun 1')
    // With no end date, a period runs until the next, and the last to the
    // season's end.
    expect(text()).includes('When the next period begins')
    expect(text()).includes('End of season')
    await tapLabel('Change the end of the windows from Monday, March 1, 2027')
    // The calendar opens on the day before the next period.
    expect(hasLabel('Choose 2027-05-31')).equals(true)
    await chooseCalendarDate('2027-05-20')
    await settle(20)
    expect(fake.saves.at(-1)?.windows).deep.equals([
      { from: '2027-03-01', until: '2027-05-20', hours: EVENINGS },
      PERIODS[1]
    ])
    expect(text()).includes('Mar 1 – May 20')
    expect(text()).includes('Thursday, May 20, 2027')
    expect(text()).includes('End date saved.')
    // An end date on or after the next period's start is refused here.
    await tapLabel('Change the end of the windows from Monday, March 1, 2027')
    await chooseCalendarDate('2027-06-01')
    await settle(20)
    expect(fake.saves).length(1)
    expect(text()).includes('Periods of game windows can’t overlap.')
    // So is one before the period's start.
    await tapLabel('Change the end of the windows from Monday, March 1, 2027')
    await chooseCalendarDate('2027-02-27')
    expect(text()).includes(
      'End each period of game windows on or after the day it starts.'
    )
    expect(fake.saves).length(1)
    await tapLabel('Change the end of the windows from Monday, March 1, 2027')
    await tapText('No end date')
    await settle(20)
    expect(fake.saves.at(-1)?.windows).deep.equals(PERIODS)
    expect(Object.keys(fake.saves.at(-1)!.windows[0])).not.includes('until')
    expect(text()).includes('From Mar 1')
    expect(text()).includes('End date removed.')
    // The last period's calendar opens on the season's last day.
    await tapLabel('Change the end of the windows from Tuesday, June 1, 2027')
    expect(hasLabel('Choose 2027-07-31')).equals(true)
    await tapText('Cancel')
    expect(fake.saves).length(2)
  })

  it('moves a period’s start, and names a date outside the season’s year with its year', async () => {
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
    await tapLabel('Change the start of the windows from Monday, March 1, 2027')
    await chooseCalendarDate('2027-03-08')
    await settle(20)
    expect(fake.saves.at(-1)?.windows.map(period => period.from)).deep.equals([
      '2027-03-08',
      '2027-12-20'
    ])
    expect(text()).includes('Start saved.')
    // A start past the next period's moves it after that one.
    await tapLabel('Change the start of the windows from Monday, March 8, 2027')
    await chooseCalendarDate('2028-01-20')
    await settle(20)
    expect(fake.saves.at(-1)?.windows.map(period => period.from)).deep.equals([
      '2027-12-20',
      '2028-01-20'
    ])
    expect(text()).includes('From Jan 20, 2028')
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
      await tapText('Add game windows')
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
