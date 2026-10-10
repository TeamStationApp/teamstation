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
  tab: 'team' | 'schedule',
  patch: Record<string, unknown> = {}
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
        <PublicTeamContent detail={detail} tab={tab} />
      </ThemeProvider>
    )
  })
}
describe('minimal public team information', () => {
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
      'coach, admin',
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
