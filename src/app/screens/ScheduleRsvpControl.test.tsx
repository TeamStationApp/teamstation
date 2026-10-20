import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asGameSummary,
  type GameSummary,
  TeamStationClient
} from '../../common/api'
import { asEventInfo, type EventInfo } from '../../common/eventInfo'
import { userIdOfGumbo } from '../../common/userId'
import { ThemeProvider } from '../theme/ThemeContext'
import { canScheduleRsvp, ScheduleRsvpControl } from './ScheduleRsvpControl'

let root: Root | undefined
const game = (): GameSummary =>
  asGameSummary({
    id: 'game_demo',
    homeTeamId: 'home',
    awayTeamId: 'away',
    homeTeamName: 'Demo Hawks',
    awayTeamName: 'Demo Eagles',
    seasonId: null,
    startAt: new Date(Date.now() + 86400000).toISOString(),
    venue: null,
    status: 'scheduled',
    homeScore: null,
    awayScore: null,
    videoCount: 0,
    ingestStatus: 'none',
    playerRsvps: { yes: 0, unknown: 1, no: 0 }
  })
const info = (): EventInfo =>
  asEventInfo({
    id: 'game_demo',
    eventKind: 'game',
    teamId: 'home',
    teamName: 'Demo Hawks',
    title: null,
    startAt: game().startAt,
    endAt: null,
    timezone: 'UTC',
    venue: null,
    address: null,
    latitude: null,
    longitude: null,
    status: 'scheduled',
    canManage: false,
    replyUserIds: [userIdOfGumbo(101), userIdOfGumbo(103)],
    attendees: [
      {
        userId: userIdOfGumbo(101),
        gumboId: 101,
        name: 'Babe R',
        response: null,
        canReply: true,
        isPlayer: false,
        isTeamParticipant: true,
        avatarUrl: null
      },
      {
        userId: userIdOfGumbo(103),
        gumboId: 103,
        name: 'Mike T',
        response: null,
        canReply: true,
        isPlayer: true,
        isTeamParticipant: true,
        avatarUrl: null
      }
    ]
  })
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})
async function click(id: string): Promise<void> {
  await act(async () => {
    document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.click()
  })
}
describe('compact upcoming schedule RSVP control', () => {
  it('excludes started, undated, canceled, live, final and pending events', () => {
    const row = game()
    expect(canScheduleRsvp(row)).equals(true)
    for (const status of ['final', 'cancelled', 'inProgress'])
      expect(canScheduleRsvp({ ...row, status })).equals(false)
    expect(canScheduleRsvp({ ...row, startAt: null })).equals(false)
    expect(canScheduleRsvp({ ...row, pendingApproval: true })).equals(false)
    expect(canScheduleRsvp(row, Date.parse(row.startAt!))).equals(false)
  })
  it('loads saved family replies, replaces the small button with colored avatars and reopens from their shared target', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    const saved = info()
    client.eventInfo = async () => structuredClone(saved)
    client.saveRsvp = async (_id, id, response) => {
      saved.attendees.find(row => row.userId === id)!.response = response
      return { userId: id, response }
    }
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const node = (
      <ThemeProvider>
        <ScheduleRsvpControl
          client={client}
          game={game()}
          teamId="home"
          label="vs Demo Eagles"
        />
      </ThemeProvider>
    )
    await act(async () => {
      root!.render(node)
    })
    const button = document.querySelector(
      '[data-testid="schedule-rsvp-button"]'
    )!
    expect(getComputedStyle(button).paddingTop).equals('3px')
    await click('schedule-rsvp-control-game_demo')
    await click('event-rsvp-usr_111111111111111111112k-0')
    await click('event-rsvp-usr_111111111111111111112n-2')
    await act(async () => {
      ;[...document.querySelectorAll<HTMLElement>('[role="button"]')]
        .find(row => row.textContent === 'Done')!
        .click()
    })
    expect(
      document.querySelector('[data-testid="schedule-rsvp-button"]')
    ).equals(null)
    expect(
      getComputedStyle(
        document.querySelector(
          '[data-testid="schedule-rsvp-avatar-usr_111111111111111111112k"]'
        )!
      ).borderColor
    ).equals('rgb(32, 138, 75)')
    expect(
      getComputedStyle(
        document.querySelector(
          '[data-testid="schedule-rsvp-avatar-usr_111111111111111111112n"]'
        )!
      ).borderColor
    ).equals('rgb(203, 57, 65)')
    await click('schedule-rsvp-control-game_demo')
    expect(
      document
        .querySelector(
          '[data-testid="event-rsvp-usr_111111111111111111112n-2"]'
        )!
        .getAttribute('aria-checked')
    ).equals('true')
    await click('event-rsvp-usr_111111111111111111112n-1')
    await act(async () => {
      ;[...document.querySelectorAll<HTMLElement>('[role="button"]')]
        .find(row => row.textContent === 'Done')!
        .click()
    })
    expect(
      getComputedStyle(
        document.querySelector(
          '[data-testid="schedule-rsvp-avatar-usr_111111111111111111112n"]'
        )!
      ).borderColor
    ).equals('rgb(35, 118, 207)')
    await act(async () => {
      root!.unmount()
    })
    root = createRoot(host)
    await act(async () => {
      root!.render(node)
    })
    expect(
      document.querySelectorAll('[data-testid^="schedule-rsvp-avatar-"]')
    ).length(2)
  })
})
