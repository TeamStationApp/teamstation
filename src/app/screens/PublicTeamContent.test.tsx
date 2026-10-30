import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { GamesPageQuery, TeamStationClient } from '../../common/api'
import {
  asGroupDetail,
  asPublicGame,
  asPublicGroup,
  type PublicGame
} from '../../common/publicGroups'
import { listProps, reachEnd } from '../../test/PagedListStandIn'
import { countsOf, pageOf } from '../../test/pageOf'
import { Screen } from '../components'
import { ThemeProvider } from '../theme/ThemeContext'
import { PublicTeamContent } from './PublicTeamContent'

let root: Root | undefined
/** Each `show` is a page opened afresh, not a list refreshed where it is. */
let shown = 0
let asked: Array<{ kind: string; id: string; query: GamesPageQuery }> = []
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  asked = []
  document.body.replaceChildren()
})
const group = asPublicGroup({
  id: 'demo',
  kind: 'team',
  name: 'Demo Team',
  imageUrl: null,
  locality: {
    timezone: 'UTC',
    placeId: 'demo',
    city: 'Demo City',
    region: 'CA',
    country: 'US'
  }
})
const game = (
  patch: Record<string, unknown> = {}
): ReturnType<typeof asPublicGame> =>
  asPublicGame({
    id: 'game',
    homeTeam: { id: 'home', name: 'Demo Home' },
    awayTeam: { id: 'away', name: 'Demo Away' },
    seasonId: null,
    startAt: '2026-10-01T18:00:00Z',
    venue: 'Field One',
    status: 'final',
    homeScore: 2,
    awayScore: 3,
    cancellationReason: null,
    withdrawnByTeamId: null,
    ...patch
  })
/** What a guest's read of the public games answers: `games`, by page. */
function publicClient(games: readonly PublicGame[]): TeamStationClient {
  return {
    publicGamesPage: async (
      kind: string,
      id: string,
      query: GamesPageQuery = {}
    ) => {
      asked.push({ kind, id, query })
      const rows =
        query.hasVideo === true
          ? games.filter(row => (row.videoCount ?? 0) > 0)
          : games
      return pageOf(rows, query, {
        counts: countsOf(games.map(row => ({ ...row, status: row.status })))
      })
    }
  } as unknown as TeamStationClient
}

async function show(
  tab: 'team' | 'schedule' | 'videos' | 'stats',
  patch: Record<string, unknown> = {},
  onOpenGame?: React.ComponentProps<typeof PublicTeamContent>['onOpenGame'],
  client?: TeamStationClient
): Promise<void> {
  const detail = asGroupDetail({
    group,
    parents: [{ ...group, kind: 'league', id: 'league' }],
    children: [],
    participatingSeasons: [{ ...group, kind: 'season', id: 'season' }],
    competingTeams: [],
    games: [game()],
    staff: [{ name: 'Demo A.', roles: ['coach', 'admin'] }],
    canManage: false,
    nonMemberView: false,
    ...patch
  })
  if (root == null) {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <Screen pagedList>
          <PublicTeamContent
            key={++shown}
            client={client ?? publicClient(detail.games)}
            detail={detail}
            tab={tab}
            onOpenGame={onOpenGame}
          />
        </Screen>
      </ThemeProvider>
    )
  })
}
describe('minimal public team information', () => {
  it('opens public video and schedule rows without autoplay and keeps staff inert', async () => {
    const opened: unknown[][] = []
    const open = (...args: unknown[]): void => {
      opened.push(args)
    }
    await show(
      'videos',
      { games: [game({ videoCount: 1 }), game({ id: 'empty' })] },
      open
    )
    expect(document.querySelectorAll('[role="button"]')).has.length(1)
    await act(async () => {
      document.querySelector<HTMLElement>('[role="button"]')!.click()
    })
    expect(opened[0]).deep.equals([
      'game',
      'Demo Away at Demo Home',
      { tab: 'watch', autoPlay: false }
    ])
    await show('schedule', {}, open)
    await act(async () => {
      document.querySelector<HTMLElement>('[role="button"]')!.click()
    })
    expect(opened[1]).deep.equals([
      'game',
      'Demo Away at Demo Home',
      { autoPlay: false }
    ])
    await show('team', { staff: [{ name: 'Mike T.', roles: ['coach'] }] })
    expect(document.body.textContent).includes('STAFF')
    expect(document.querySelector('[role="button"], a, [tabindex="0"]')).equals(
      null
    )
    await show('team', { staff: [] })
    expect(document.body.textContent).includes('No public staff listed')
    await show('videos', { games: [] })
    expect(document.body.textContent).includes(
      'No game has a video attached yet'
    )
    await show('stats')
    expect(document.body.textContent).includes('membership is required')
  })
  it('uses the member role badge and subtitle without making staff navigable', async () => {
    await show('team', {
      staff: [
        {
          name: 'Babe R.',
          roles: ['admin'],
          inheritedFrom: { level: 'league', role: 'admin' }
        },
        {
          name: 'Mike T.',
          roles: ['coach', 'scorekeeper'],
          inheritedFrom: { level: 'season', role: 'coach' }
        }
      ]
    })
    for (const text of ['League admin', 'Season coach', 'Coach · Scorekeeper'])
      expect(document.body.textContent).includes(text)
    expect(document.querySelector('[role="button"], a, [tabindex="0"]')).equals(
      null
    )
  })
  it('shows location, parent relationships, participation and short staff names', async () => {
    await show('team', {
      group: { ...group, external: true },
      custodian: { ...group, kind: 'league' }
    })
    for (const text of [
      'Demo City',
      'Parent league: Demo Team',
      'Participating season: Demo Team',
      'Demo A.',
      'Coach',
      'Placeholder team',
      'Managed by Demo Team'
    ])
      expect(document.body.textContent).includes(text)
  })
  it('shows real results and keeps pending/canceled rows from showing a misleading score', async () => {
    await show('schedule')
    expect(document.body.textContent).includes('3–2')
    expect(document.body.textContent).includes('Field One')
    await show('schedule', {
      games: [
        game({ pendingApproval: true, venue: null }),
        game({
          id: 'withdrawn',
          status: 'cancelled',
          cancellationReason: 'withdrawal',
          withdrawnByTeamName: 'Demo Away'
        }),
        game({ id: 'canceled', status: 'cancelled' }),
        game({
          id: 'scheduled',
          homeScore: null,
          awayScore: null,
          status: 'scheduled'
        })
      ]
    })
    expect(document.body.textContent).includes('Pending approval')
    expect(document.body.textContent).includes('Demo Away withdrew')
    expect(document.body.textContent).not.includes('3–2')
  })

  describe('its lists', () => {
    const season = Array.from({ length: 60 }, (_row, index) =>
      game({
        id: `game${index}`,
        startAt: new Date(Date.UTC(2026, 3, index + 1)).toISOString(),
        homeTeam: { id: 'home', name: `Home ${index}` },
        homeScore: null,
        awayScore: null,
        videoCount: index % 2 === 0 ? 2 : 0
      })
    )
    const hasRow = (index: number): boolean =>
      (listProps().data as readonly PublicGame[]).some(
        row => row.id === `game${index}`
      )

    it('reads the schedule by page, in the order it is played', async () => {
      await show('schedule', { games: [] }, undefined, publicClient(season))
      expect(asked).deep.equals([
        { kind: 'team', id: 'demo', query: { order: 'asc' } }
      ])
      expect(hasRow(0)).equals(true)
      expect(hasRow(49)).equals(true)
      expect(hasRow(50)).equals(false)
      await act(async () => {
        reachEnd()
      })
      expect(asked[1].query).deep.equals({ order: 'asc', cursor: 'next:50' })
      expect(hasRow(59)).equals(true)
    })

    it('asks Videos for games with a video, and reads the note from counts', async () => {
      await show('videos', { games: [] }, undefined, publicClient(season))
      expect(asked).deep.equals([
        { kind: 'team', id: 'demo', query: { order: 'asc', hasVideo: true } }
      ])
      expect(document.body.textContent).includes('30 with video')
      expect(hasRow(0)).equals(true)
      expect(hasRow(1)).equals(false)
      // More than the first page holds: the list's, not what is loaded.
      const many = season.map(row => ({ ...row, videoCount: 1 }))
      await show('videos', { games: [] }, undefined, publicClient(many))
      expect(document.body.textContent).includes('60 with video')
      expect(hasRow(59)).equals(false)
      await act(async () => {
        reachEnd()
      })
      expect(hasRow(59)).equals(true)
    })

    it('reads nothing on a tab with no list', async () => {
      await show('team')
      await show('stats')
      expect(asked).deep.equals([])
    })

    it('says why a list could not load, and retries', async () => {
      let fail = true
      const answers = publicClient([game()])
      const client = {
        publicGamesPage: async (...args: unknown[]) => {
          if (fail) throw new Error('Offline for now')
          return await (
            answers.publicGamesPage as (...a: unknown[]) => unknown
          )(...args)
        }
      } as unknown as TeamStationClient
      await show('schedule', { games: [] }, undefined, client)
      expect(document.querySelector('[role="alert"]')?.textContent).equals(
        'Offline for now'
      )
      expect(document.body.textContent).not.includes('No games scheduled')
      fail = false
      await act(async () => {
        document.querySelector<HTMLElement>('[role="button"]')!.click()
      })
      expect(document.querySelector('[role="alert"]')).equals(null)
      expect(document.body.textContent).includes('Demo Away')
    })
  })
})
