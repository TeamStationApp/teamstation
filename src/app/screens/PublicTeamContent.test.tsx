import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asGroupDetail,
  asPublicGame,
  asPublicGroup
} from '../../common/publicGroups'
import { ThemeProvider } from '../theme/ThemeContext'
import { PublicTeamContent } from './PublicTeamContent'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
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
async function show(
  tab: 'team' | 'schedule' | 'videos' | 'stats',
  patch: Record<string, unknown> = {},
  onOpenGame?: React.ComponentProps<typeof PublicTeamContent>['onOpenGame']
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
        <PublicTeamContent detail={detail} tab={tab} onOpenGame={onOpenGame} />
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
})
