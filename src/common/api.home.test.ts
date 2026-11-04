import { expect } from 'chai'
import { describe, it } from 'mocha'

import { TeamStationClient } from './api'

interface Call {
  url: string
  method: string
  body: unknown
}

function client(answer: unknown): { api: TeamStationClient; calls: Call[] } {
  const calls: Call[] = []
  const api = new TeamStationClient({
    baseUrl: '/api/v1',
    fetch: (async (url: unknown, init?: { method?: string; body?: string }) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body == null ? undefined : JSON.parse(init.body)
      })
      return new Response(JSON.stringify(answer), { status: 200 })
    }) as unknown as typeof fetch
  })
  return { api, calls }
}

describe('api client home', () => {
  it('reads GET /me/home and keeps member rows apart from follows', async () => {
    const { api, calls } = client({
      teams: [
        {
          id: 'tem_member',
          name: 'Hawks',
          shortName: null,
          logoPath: null,
          logoUrl: null,
          record: { w: 1, l: 0, t: 0, seasonName: 'Spring' },
          kind: 'full',
          direct: true,
          source: 'member'
        },
        {
          id: 'tem_follow',
          kind: 'team',
          name: 'Gulls',
          imageUrl: null,
          locality: null,
          direct: true,
          source: 'follow'
        }
      ],
      seasons: [
        {
          id: 'sea_member',
          leagueId: null,
          name: 'Spring',
          year: 2026,
          term: null,
          ageGroup: null,
          teams: 2,
          games: 1,
          videos: 0,
          direct: false,
          source: 'member'
        },
        {
          id: 'sea_follow',
          kind: 'season',
          name: 'Fall',
          imageUrl: null,
          locality: null,
          direct: true,
          source: 'follow'
        }
      ],
      leagues: [
        {
          id: 'lea_member',
          kind: 'league',
          name: 'Circuit',
          imageUrl: null,
          locality: null,
          direct: false,
          source: 'member'
        },
        {
          id: 'lea_follow',
          kind: 'league',
          name: 'Fans',
          imageUrl: null,
          locality: null,
          direct: true,
          source: 'follow'
        }
      ]
    })
    const home = await api.home()
    expect(calls).deep.equals([
      { url: '/api/v1/me/home', method: 'GET', body: undefined }
    ])
    expect(home.teams.map(row => row.id)).deep.equals([
      'tem_member',
      'tem_follow'
    ])
    expect(home.teams[0]).deep.equals({
      id: 'tem_member',
      name: 'Hawks',
      shortName: null,
      logoPath: null,
      logoUrl: null,
      record: { w: 1, l: 0, t: 0, seasonName: 'Spring' },
      seasonCategory: 'unscheduled',
      canViewPrivate: false,
      access: undefined,
      latestVideoAt: undefined,
      videoRelationship: undefined,
      videoSeason: undefined,
      following: undefined,
      onTeam: undefined,
      kind: 'full',
      direct: true,
      source: 'member'
    })
    expect(home.teams[1]).include({
      id: 'tem_follow',
      kind: 'team',
      name: 'Gulls',
      direct: true,
      source: 'follow',
      timezone: 'UTC',
      external: false
    })
    expect(home.seasons.map(row => row.source)).deep.equals([
      'member',
      'follow'
    ])
    expect(home.seasons[0]).include({ id: 'sea_member', games: 1, teams: 2 })
    expect(home.leagues.map(row => row.source)).deep.equals([
      'member',
      'follow'
    ])
    expect(home.leagues[0]).include({
      id: 'lea_member',
      kind: 'league',
      direct: false
    })
  })
})
