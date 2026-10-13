import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { asGameDetail, TeamStationClient } from '../../common/api'
import { asEventInfo } from '../../common/eventInfo'
import { pressSchedule } from '../../test/eventScheduleDom'
import { ThemeProvider } from '../theme/ThemeContext'
import { EventSettingsScreen } from './EventSettingsScreen'

const info = asEventInfo({
  id: 'event_demo',
  eventKind: 'event',
  title: 'Team dinner',
  teamId: 'home',
  teamName: 'Demo Hawks',
  startAt: '2027-04-10T18:00:00Z',
  endAt: null,
  timezone: 'UTC',
  venue: null,
  address: null,
  latitude: null,
  longitude: null,
  status: 'scheduled',
  canManage: true,
  attendees: [],
  replyUserIds: []
})
const game = asGameDetail({
  id: info.id,
  eventKind: 'event',
  title: info.title,
  nonMemberView: false,
  homeTeamId: 'home',
  awayTeamId: '',
  homeTeamName: info.teamName,
  awayTeamName: '',
  seasonId: null,
  startAt: info.startAt,
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  videos: [],
  ingestStatus: 'none',
  ingestMessage: null,
  canScore: false
})
describe('event-aware settings route', () => {
  it('ignores a save completion after leaving the mounted settings visit', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.game = async () => game
    client.eventInfo = async () => info
    let complete!: (value: typeof info) => void
    client.updateEventInfo = async () =>
      await new Promise(resolve => {
        complete = resolve
      })
    let saves = 0
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(
          <ThemeProvider>
            <EventSettingsScreen
              client={client}
              gameId={info.id}
              onSaved={() => {
                saves++
              }}
              onCancel={() => undefined}
            />
          </ThemeProvider>
        )
      })
      await pressSchedule('Save event details')
      await act(async () => {
        root.unmount()
      })
      await act(async () => {
        complete(info)
      })
      expect(saves).equals(0)
    } finally {
      host.remove()
    }
  })
  it('edits/cancels titled events from Settings with a local draft', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.game = async () => game
    client.eventInfo = async () => info
    let status = ''
    client.updateEventInfo = async (_id, body) => {
      status = String(body.status)
      return info
    }
    let saved = ''
    let canceled = false
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(
          <ThemeProvider>
            <EventSettingsScreen
              client={client}
              gameId={info.id}
              onSaved={result => {
                saved = result.status
              }}
              onCancel={() => {
                canceled = true
              }}
            />
          </ThemeProvider>
        )
      })
      expect(document.body.textContent)
        .includes('Event Settings')
        .and.not.includes('Game Settings')
      await pressSchedule('Cancel event')
      await pressSchedule('Save event details')
      expect(status).equals('cancelled')
      expect(saved).equals('eventUpdated')
      await pressSchedule('Back')
      expect(canceled).equals(true)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
  it('retries failed loads and never exposes editing to a spectator', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.game = async () => {
      throw new Error('Settings unavailable')
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(
          <ThemeProvider>
            <EventSettingsScreen
              client={client}
              gameId={info.id}
              onSaved={() => undefined}
              onCancel={() => undefined}
            />
          </ThemeProvider>
        )
      })
      expect(document.body.textContent).includes('Settings unavailable')
      client.game = async () => game
      client.eventInfo = async () => ({ ...info, canManage: false })
      await pressSchedule('Retry event settings')
      expect(document.body.textContent).includes('administrator access')
      expect(
        document.querySelector('[data-testid="event-schedule-date"]')
      ).equals(null)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
})
