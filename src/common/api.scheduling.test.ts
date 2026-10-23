import { expect } from 'chai'
import { describe, it } from 'mocha'

import { TeamStationClient } from './api'
import type { GameToReschedule, SchedulePreview } from './schedulePreviews'
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
      { seasonId: 'sea/a', saved: true, timezone: 'UTC', settings: SETTINGS },
      {
        seasonId: 'sea/a',
        saved: true,
        timezone: 'America/Los_Angeles',
        settings: SETTINGS
      },
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
    // A season set up in the viewer's zone sends it, and reads it back.
    expect(
      (
        await api.saveScheduleSettings('sea/a', SETTINGS, {
          timezone: 'America/Los_Angeles'
        })
      ).timezone
    ).equals('America/Los_Angeles')
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
        '/api/v1/seasons/sea%2Fa/schedule-settings',
        { ...SETTINGS, timezone: 'America/Los_Angeles' }
      ],
      [
        'PUT',
        '/api/v1/seasons/sea%2Fa/memberships/tem%2Fb',
        { exhibition: true }
      ],
      ['GET', '/api/v1/seasons/sea%2Fa/teams', undefined]
    ])
  })

  it('keeps a period’s end date through the setup, and sends it again with a save', async () => {
    const windows = [
      {
        from: '2027-03-01',
        until: '2027-05-20',
        hours: [{ weekday: 6, start: '08:00', end: '18:00' }]
      },
      {
        from: '2027-06-01',
        hours: [{ weekday: 6, start: '09:00', end: '17:00' }]
      }
    ]
    const ended = { ...SETTINGS, windows }
    const { api, calls } = client([
      { ...SETUP, seasons: [{ ...SETUP.seasons[0], settings: ended }] },
      { seasonId: 'sea_a', saved: true, timezone: 'UTC', settings: ended }
    ])
    const [season] = (await api.scheduleSetup('lea/a')).seasons
    expect(season.settings.windows).deep.equals(windows)
    // A grid cell saves the season's settings with one number changed.
    const saved = await api.saveScheduleSettings('sea_a', {
      ...season.settings,
      gameMinutes: 100
    })
    expect(calls[1][2]).deep.equals({ ...ended, gameMinutes: 100 })
    expect(saved.settings.windows).deep.equals(windows)
  })

  it('builds, reads, edits and publishes previews, and lists games to reschedule', async () => {
    const preview: SchedulePreview = {
      id: 'spv/1',
      leagueId: 'lea/a',
      mode: 'full',
      existing: 'workAround',
      status: 'open',
      createdAt: '2026-10-22T12:00:00.000Z',
      options: [],
      blocking: 'not enough 50/70 field time to give every team 4 games',
      edits: { option: 0, rejectedGameKeys: [], addedGames: [] },
      replacing: 0,
      publishedOption: null,
      publishedAt: null,
      published: [],
      teams: [],
      seasons: [],
      fields: []
    }
    const listed: GameToReschedule = {
      previewId: 'spv/1',
      gameKey: 'g1',
      gameId: null,
      seasonId: 'sea_a',
      homeTeamId: 'tem_a',
      awayTeamId: 'tem_b',
      homeTeamName: 'Demo Hawks',
      awayTeamName: 'Demo Owls',
      startAt: '2027-04-17T14:00:00.000Z',
      endAt: null,
      timezone: 'UTC',
      exhibition: false,
      fieldId: null,
      reason: 'declined'
    }
    const added = {
      seasonId: 'sea_a',
      homeTeamId: 'tem_a',
      awayTeamId: 'tem_b',
      exhibition: false,
      fieldId: 'fld_one',
      size: '50/70' as const,
      startAt: '2027-04-17T14:00:00.000Z',
      endAt: '2027-04-17T15:30:00.000Z'
    }
    const { api, calls } = client([
      preview,
      preview,
      preview,
      { preview, scheduled: 1, awaiting: 0, removed: 0 },
      { items: [listed] }
    ])
    expect(
      await api.buildSchedulePreview('lea/a', {
        mode: 'full',
        existing: 'workAround',
        timezone: 'America/New_York'
      })
    ).deep.equals(preview)
    await api.schedulePreview('spv/1')
    await api.editSchedulePreview('spv/1', { option: 0, addedGames: [added] })
    expect((await api.publishSchedulePreview('spv/1', 0)).scheduled).equals(1)
    expect(await api.gamesToReschedule('lea/a')).deep.equals([listed])
    expect(calls).deep.equals([
      [
        'POST',
        '/api/v1/leagues/lea%2Fa/schedule-previews',
        { mode: 'full', existing: 'workAround', timezone: 'America/New_York' }
      ],
      ['GET', '/api/v1/schedule-previews/spv%2F1', undefined],
      [
        'PUT',
        '/api/v1/schedule-previews/spv%2F1',
        { option: 0, addedGames: [added] }
      ],
      ['POST', '/api/v1/schedule-previews/spv%2F1/publications', { option: 0 }],
      ['GET', '/api/v1/leagues/lea%2Fa/games-to-reschedule', undefined]
    ])
  })
})
