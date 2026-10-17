import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asGameSummary, TeamStationClient } from '../../common/api'
import { asEventInfo, type EventInfo } from '../../common/eventInfo'
import { PlayerRsvpCounts } from '../components/PlayerRsvpCounts'
import { ThemeProvider } from '../theme/ThemeContext'
import { eventReplyRows, EventRsvpModal } from './EventRsvpModal'

let root: Root | undefined
const info = (): EventInfo =>
  asEventInfo({
    id: 'event_demo',
    eventKind: 'game',
    teamId: 'home',
    teamName: 'Demo Hawks',
    title: null,
    startAt: '2027-04-10T18:00:00Z',
    endAt: null,
    timezone: 'UTC',
    venue: 'Demo Park',
    address: '1 Demo Way',
    latitude: null,
    longitude: null,
    status: 'scheduled',
    canManage: false,
    replyUserIds: [101, 103, 104],
    attendanceTeams: [
      { id: 'home', name: 'Demo Hawks', isParticipant: true },
      { id: 'away', name: 'Demo Eagles', isParticipant: true }
    ],
    attendees: [
      {
        userId: 101,
        name: 'Babe R',
        response: null,
        canReply: true,
        isPlayer: false,
        isTeamParticipant: true,
        avatarUrl: null
      },
      {
        userId: 103,
        name: 'Mike T',
        response: null,
        canReply: true,
        isPlayer: true,
        isTeamParticipant: true,
        avatarUrl: null
      },
      {
        userId: 104,
        name: 'Ichiro',
        response: 'no',
        canReply: true,
        isPlayer: false,
        isTeamParticipant: false,
        avatarUrl: null
      },
      {
        userId: 115,
        name: 'Alex R',
        response: null,
        canReply: false,
        isPlayer: false,
        isTeamParticipant: false,
        avatarUrl: null
      }
    ]
  })
const game = asGameSummary({
  id: 'event_demo',
  homeTeamId: 'home',
  awayTeamId: 'away',
  homeTeamName: 'Demo Hawks',
  awayTeamName: 'Demo Eagles',
  seasonId: null,
  startAt: '2027-04-10T18:00:00Z',
  venue: 'Demo Park',
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  videoCount: 0,
  ingestStatus: 'none'
})
async function render(node: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{node}</ThemeProvider>)
  })
}
async function click(id: string): Promise<void> {
  await act(async () => {
    document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.click()
  })
}
describe('quick event RSVP and player pills', () => {
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()
  })
  it('omits zeros and keeps green, blue and red counts ordered', async () => {
    await render(<PlayerRsvpCounts counts={{ yes: 0, unknown: 5, no: 0 }} />)
    expect(
      document.querySelectorAll('[data-testid^="player-rsvp-count-"]')
    ).length(1)
    expect(document.body.textContent).equals('5')
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <PlayerRsvpCounts counts={{ yes: 2, unknown: 1, no: 3 }} />
        </ThemeProvider>
      )
    })
    expect(
      [...document.querySelectorAll('[data-testid^="player-rsvp-count-"]')].map(
        row => row.textContent
      )
    ).deep.equals(['2', '1', '3'])
  })
  it('shows the parent and rostered children from either team, omitting unrelated children', async () => {
    const primary = info()
    const away = {
      ...primary,
      teamId: 'away',
      attendees: primary.attendees.map(row => ({
        ...row,
        isPlayer: row.userId === 104,
        isTeamParticipant: row.userId === 104
      }))
    }
    expect(eventReplyRows([primary, away]).map(row => row.userId)).deep.equals([
      101, 103, 104
    ])
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.eventInfo = async (_id, team) => (team === 'away' ? away : primary)
    let counts = { yes: 0, unknown: 0, no: 0 }
    await render(
      <EventRsvpModal
        client={client}
        game={game}
        teamId="home"
        onClose={() => undefined}
        onCounts={value => {
          counts = value
        }}
      />
    )
    expect(document.body.textContent)
      .includes('vs Demo Eagles')
      .and.includes('Demo Park')
      .and.includes('1 Demo Way')
    expect(document.querySelector('[data-testid="quick-rsvp-row-115"]')).equals(
      null
    )
    let rejectRow!: (error: Error) => void
    client.saveRsvp = async (_id, id, response) =>
      id === 103
        ? await new Promise((_resolve, reject) => {
            rejectRow = reject
          })
        : { userId: id, response }
    await click('event-rsvp-103-0')
    expect(counts).deep.equals({ yes: 1, unknown: 0, no: 0 })
    await click('event-rsvp-104-0')
    await act(async () => {
      rejectRow(new Error('Save unavailable'))
    })
    expect(counts).deep.equals({ yes: 0, unknown: 1, no: 0 })
    expect(document.body.textContent).includes('Save unavailable')
    expect(
      document
        .querySelector('[data-testid="event-rsvp-104-0"]')!
        .getAttribute('aria-checked')
    ).equals('true')
    // Every line of the sheet is bold: title, time and place, names, errors
    // and the capsule labels. Only the Done button keeps its own weight.
    const lines = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="event-rsvp-modal"] [dir="auto"]'
      )
    ].filter(node => node.textContent !== 'Done')
    expect(lines.map(node => node.textContent))
      .includes('vs Demo Eagles')
      .and.includes('Save unavailable')
      .and.includes('No reply')
    for (const node of lines)
      expect(getComputedStyle(node).fontWeight, node.textContent!).equals('700')
  })
  it('names away, practice and titled events and recovers a failed load', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.eventInfo = async () => {
      throw new Error('Load unavailable')
    }
    await render(
      <EventRsvpModal
        client={client}
        game={game}
        teamId="away"
        onClose={() => undefined}
        onCounts={() => undefined}
      />
    )
    expect(document.body.textContent)
      .includes('at Demo Hawks')
      .and.includes('Load unavailable')
    client.eventInfo = async () => info()
    await act(async () => {
      ;[...document.querySelectorAll<HTMLElement>('[role="button"]')]
        .find(node => node.textContent === 'Retry RSVPs')!
        .click()
    })
    expect(document.body.textContent).not.includes('Load unavailable')
    expect(
      document.querySelector('[data-testid="quick-rsvp-row-103"]')
    ).not.equals(null)
    for (const [type, title] of [
      ['practice', 'Practice'],
      ['other', 'Team dinner']
    ] as const) {
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <EventRsvpModal
              client={client}
              game={{
                ...game,
                eventKind: 'event',
                eventType: type,
                title: 'Team dinner'
              }}
              teamId="home"
              onClose={() => undefined}
              onCounts={() => undefined}
            />
          </ThemeProvider>
        )
      })
      expect(document.body.textContent).includes(title)
    }
  })
})
