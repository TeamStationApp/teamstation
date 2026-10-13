import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asGameSummary,
  asTeamSummary,
  type GameSummary,
  type TeamStationClient
} from '../../common/api'
import { ThemeProvider } from '../theme/ThemeContext'
import type { GameListOpenOptions } from './gameListOptions'
import { TeamScreen } from './TeamScreen'

let root: Root | undefined
let host: HTMLElement
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})
const team = asTeamSummary({
  id: 'tem_home',
  name: 'Demo Home',
  shortName: null,
  logoPath: null
})
const game = (patch: Partial<GameSummary> = {}): GameSummary =>
  asGameSummary({
    id: 'gam_pending',
    homeTeamId: team.id,
    awayTeamId: 'tem_away',
    homeTeamName: team.name,
    awayTeamName: 'Demo Away',
    seasonId: 'sea_demo',
    startAt: '2026-09-01T18:00:00Z',
    venue: null,
    status: 'final',
    homeScore: 4,
    awayScore: 0,
    videoCount: 1,
    ingestStatus: 'none',
    pendingApproval: true,
    pendingRequestId: 'req_team',
    ...patch
  })
async function render(
  mode: 'schedule' | 'videos',
  row: GameSummary
): Promise<Array<{ id: string; options?: GameListOpenOptions }>> {
  const opened: Array<{ id: string; options?: GameListOpenOptions }> = []
  const client = {
    teamGames: async () => [row],
    roster: async () => [],
    teamStats: async () => [],
    teamPitchingStats: async () => [],
    standings: async () => []
  } as unknown as TeamStationClient
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <TeamScreen
          client={client}
          team={team}
          initialTab={mode}
          onOpenGame={(id, _title, options) => opened.push({ id, options })}
        />
      </ThemeProvider>
    )
    await new Promise(resolve => setTimeout(resolve, 20))
  })
  return opened
}
/** The game's row: a video card names both teams, a schedule row only the opponent. */
function target(): HTMLElement | undefined {
  return [...host.querySelectorAll<HTMLElement>('[role="button"]')].find(node =>
    /^(Demo Home )?vs Demo Away/.test(node.getAttribute('aria-label') ?? '')
  )
}
describe('pending games through the actual team card', () => {
  it('shows pending in place of the win score and opens the authorized request from Schedule', async () => {
    const opened = await render('schedule', game())
    expect(host.textContent).includes('Pending approval')
    expect(host.textContent).not.includes('W 4–0')
    await act(async () => {
      target()!.click()
    })
    expect(opened).deep.equals([
      { id: 'gam_pending', options: { pendingRequestId: 'req_team' } }
    ])
  })
  it('does not link a pending schedule event without request permission', async () => {
    const opened = await render(
      'schedule',
      game({
        pendingRequestId: null,
        videoCount: 0,
        homeScore: null,
        awayScore: null,
        status: 'scheduled'
      })
    )
    expect(host.textContent).includes('Pending approval')
    expect(target()).equals(undefined)
    expect(opened).deep.equals([])
  })
  it('keeps published recordings playable from Videos when a request is pending', async () => {
    const opened = await render('videos', game({ pendingRequestId: null }))
    expect(host.textContent).includes('Pending approval')
    await act(async () => {
      target()!.click()
    })
    expect(opened).deep.equals([
      { id: 'gam_pending', options: { tab: 'watch', autoPlay: true } }
    ])
  })
  it('preserves the ordinary win card and exposes canceled withdrawal history separately', async () => {
    const opened = await render(
      'schedule',
      game({ pendingApproval: false, pendingRequestId: null })
    )
    expect(host.textContent).includes('W 4–0')
    await act(async () => {
      target()!.click()
    })
    expect(opened).deep.equals([
      { id: 'gam_pending', options: { autoPlay: false } }
    ])
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    host.remove()
    await render(
      'schedule',
      game({
        pendingApproval: false,
        status: 'cancelled',
        cancellationReason: 'withdrawal',
        withdrawnByTeamName: 'Demo Away'
      })
    )
    expect(host.textContent).includes('Canceled')
    expect(host.textContent).includes('Demo Away withdrew')
    expect(host.textContent).not.includes('W 4–0')
  })
})
