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
import { chooseCalendarDate, tapLabel, tapText } from '../../test/venueDom'
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

function fakeClient(
  season: SetupSeason | null | Error,
  options: { failFlag?: boolean } = {}
): {
  client: TeamStationClient
  saves: ScheduleSettings[]
  zones: Array<string | undefined>
  flags: Array<[string, boolean]>
} {
  let reads = 0
  const record = {
    saves: [] as ScheduleSettings[],
    zones: [] as Array<string | undefined>,
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
        seasons:
          season == null ? [] : [season instanceof Error ? SEASON : season],
        fields: []
      }
    },
    saveScheduleSettings: async (
      seasonId: string,
      settings: ScheduleSettings,
      options: { timezone?: string }
    ) => {
      record.saves.push(settings)
      record.zones.push(options.timezone)
      return {
        seasonId,
        saved: true,
        // The server adopts a zone only for a season at the UTC default.
        timezone:
          season instanceof Error || season == null
            ? 'UTC'
            : season.timezone === 'UTC'
              ? (options.timezone ?? 'UTC')
              : season.timezone,
        settings
      }
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

const show = async (client: TeamStationClient): Promise<void> => {
  await mount(
    <ScheduleSeasonScreen client={client} leagueId="lea_a" seasonId="sea_a" />
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
    expect(text()).includes('Times are in Eastern Time.')
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

  it('names the season’s zone, or the viewer’s while it holds the UTC default, and stores it on the first save', async () => {
    const own = fakeClient(SEASON)
    await show(own.client)
    expect(text()).includes('Times are in Eastern Time.')
    await tapText('Add game windows')
    await settle(20)
    // A season with a zone of its own sends none.
    expect(own.zones).deep.equals([undefined])
    await unmount()
    const fresh = fakeClient({ ...SEASON, timezone: 'UTC' })
    await show(fresh.client)
    expect(text()).includes('Times are in Pacific Time.')
    expect(text()).not.includes('UTC')
    expect(text()).not.includes('Coordinated Universal Time')
    await tapText('Add game windows')
    await settle(20)
    expect(fresh.zones).deep.equals(['America/Los_Angeles'])
    expect(text()).includes('Times are in Pacific Time.')
    // The season now holds the zone, so the next save sends none.
    await press('Add blackout day')
    await chooseCalendarDate('2027-04-17')
    await settle(20)
    expect(fresh.zones).deep.equals(['America/Los_Angeles', undefined])
  })

  it('sets blackout days and exhibition teams', async () => {
    const fake = fakeClient(SEASON)
    await show(fake.client)
    await press('Add blackout day')
    await chooseCalendarDate('2027-04-17')
    await settle(20)
    expect(fake.saves.at(-1)?.blackouts).deep.equals(['2027-04-17'])
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
