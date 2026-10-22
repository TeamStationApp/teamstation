import { expect } from 'chai'
import { describe, it } from 'mocha'

import { TeamStationClient } from './api'
import type { ScheduleSettings, ScheduleSetup } from './seasonScheduling'

const SETTINGS: ScheduleSettings = {
  fieldSize: '50/70',
  gameMinutes: 90,
  bufferMinutes: 10,
  regularGames: 4,
  exhibitionGames: 1,
  doubleheaders: 'never',
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
const SETUP: ScheduleSetup = {
  leagueId: 'lea/a',
  seasonIds: ['sea_a'],
  fieldIds: ['fld_one'],
  seasons: [
    {
      id: 'sea_a',
      name: 'Demo Regular',
      year: 2027,
      timezone: 'UTC',
      participants: 7,
      exhibitionTeams: 2,
      teams: [{ id: 'tem_a', name: 'Demo Hawks', exhibition: false }],
      saved: true,
      settings: SETTINGS
    }
  ],
  fields: [
    {
      id: 'fld_one',
      name: 'Field 1',
      venueId: 'ven_a',
      venueName: 'Example Park',
      sizes: ['50/70'],
      startsOn: null,
      endsOn: '2027-09-30',
      deleted: false
    }
  ]
}

const TEAM = {
  name: 'Demo Hawks',
  shortName: null,
  logoPath: null,
  logoUrl: null,
  record: null
}

function client(answers: unknown[]): {
  api: TeamStationClient
  calls: Array<[string, string, unknown]>
} {
  const calls: Array<[string, string, unknown]> = []
  const api = new TeamStationClient({
    baseUrl: '/api/v1',
    fetch: (async (url: unknown, init?: { method?: string; body?: string }) => {
      calls.push([
        init?.method ?? 'GET',
        String(url),
        init?.body == null ? undefined : JSON.parse(init.body)
      ])
      return new Response(JSON.stringify(answers.shift()), { status: 200 })
    }) as unknown as typeof fetch
  })
  return { api, calls }
}

describe('api client scheduling setup', () => {
  it('reads and chooses the setup, saves settings and flags exhibition teams', async () => {
    const { api, calls } = client([
      SETUP,
      SETUP,
      { seasonId: 'sea/a', saved: true, settings: SETTINGS },
      { seasonId: 'sea/a', teamId: 'tem/b', exhibition: true },
      [
        { ...TEAM, id: 'tem_a', exhibition: true },
        { ...TEAM, id: 'tem_b' }
      ]
    ])
    expect(await api.scheduleSetup('lea/a')).deep.equals(SETUP)
    await api.saveScheduleSetup('lea/a', {
      seasonIds: [],
      fieldIds: ['fld_one']
    })
    expect(
      (await api.saveScheduleSettings('sea/a', SETTINGS)).settings
    ).deep.equals(SETTINGS)
    await api.setExhibitionTeam('sea/a', 'tem/b', true)
    const teams = await api.seasonTeams('sea/a')
    expect(teams.map(team => team.exhibition)).deep.equals([true, undefined])
    expect(calls).deep.equals([
      ['GET', '/api/v1/leagues/lea%2Fa/schedule-setup', undefined],
      [
        'PUT',
        '/api/v1/leagues/lea%2Fa/schedule-setup',
        { seasonIds: [], fieldIds: ['fld_one'] }
      ],
      ['PUT', '/api/v1/seasons/sea%2Fa/schedule-settings', SETTINGS],
      [
        'PUT',
        '/api/v1/seasons/sea%2Fa/memberships/tem%2Fb',
        { exhibition: true }
      ],
      ['GET', '/api/v1/seasons/sea%2Fa/teams', undefined]
    ])
  })
})
