import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import { asEventInfo, type EventInfo } from '../../common/eventInfo'
import { ThemeProvider } from '../theme/ThemeContext'
import { EventInfoTab } from './EventInfoTab'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})
const initial = (): EventInfo =>
  asEventInfo({
    id: 'g1',
    eventKind: 'game',
    title: null,
    teamId: 'home',
    teamName: 'Owls',
    startAt: '2027-04-10T18:00:00Z',
    endAt: null,
    timezone: 'UTC',
    venue: 'Demo Field',
    address: null,
    latitude: null,
    longitude: null,
    status: 'scheduled',
    canManage: false,
    replyUserIds: [101, 103, 104],
    attendees: [
      {
        userId: 101,
        name: 'Babe Ruth',
        avatarUrl: null,
        response: null,
        canReply: true
      },
      {
        userId: 103,
        name: 'Mike Trout',
        avatarUrl: null,
        response: null,
        canReply: true
      },
      {
        userId: 104,
        name: 'Ichiro',
        avatarUrl: null,
        response: null,
        canReply: true
      },
      {
        userId: 102,
        name: 'Lou Gehrig',
        avatarUrl: null,
        response: 'no',
        canReply: false
      }
    ]
  })
async function render(client: TeamStationClient): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <EventInfoTab client={client} eventId="g1" />
      </ThemeProvider>
    )
  })
}
async function click(selector: string): Promise<void> {
  const button = selector.startsWith('[')
    ? document.querySelector<HTMLElement>(selector)
    : [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
        node => node.textContent === selector
      )
  expect(button, selector).not.equals(null)
  await act(async () => {
    button!.click()
    await Promise.resolve()
  })
}
const clientFor = (info = initial()): TeamStationClient => {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.eventInfo = async () => structuredClone(info)
  client.eventLocation = async () => ({
    latitude: 34,
    longitude: 12,
    tileUrl: 'https://example.test/{z}/{x}/{y}'
  })
  client.saveRsvp = async (_id, userId, response) => ({ userId, response })
  return client
}
describe('event Info location and family controls', () => {
  for (const [timezone, startAt, endAt, endDate] of [
    ['UTC', '2037-04-10T18:00:00Z', '2037-04-11T17:00:00Z', 'Apr 11, 2037'],
    [
      'America/Los_Angeles',
      '2037-04-11T06:00:00Z',
      '2037-04-11T08:00:00Z',
      'Apr 11, 2037'
    ],
    [
      'America/Los_Angeles',
      '2037-04-10T23:00:00Z',
      '2037-04-11T01:00:00Z',
      null
    ]
  ] as const)
    it(`shows an end date only when local calendar days differ (${timezone}, ${endAt})`, async () => {
      await render(clientFor({ ...initial(), timezone, startAt, endAt }))
      const text = document.body.textContent ?? ''
      const end = new Intl.DateTimeFormat('en', {
        timeZone: timezone,
        dateStyle: endDate == null ? undefined : 'medium',
        timeStyle: 'short'
      }).format(new Date(endAt))
      expect(text).includes(` – ${end}`)
      if (endDate != null) expect(text).includes(` – ${endDate}`)
      else expect(text).not.includes(' – Apr')
    })
  it('renders one independent family row each, omits absent maps, and groups replies in order', async () => {
    const client = clientFor()
    let locations = 0
    client.eventLocation = async () => {
      locations++
      throw new Error('must not request an absent address')
    }
    await render(client)
    expect(document.body.textContent).includes('Are you going?')
    expect(document.querySelectorAll('[role="radiogroup"]')).length(3)
    expect(document.querySelector('iframe')).equals(null)
    expect(locations).equals(0)
    await click('[data-testid="event-rsvp-101-0"]')
    await click('[data-testid="event-rsvp-103-2"]')
    await click('[data-testid="event-rsvp-104-0"]')
    await click('[data-testid="event-rsvp-101-1"]')
    expect(
      document
        .querySelector('[data-testid="event-rsvp-101-1"]')
        ?.getAttribute('aria-checked')
    ).equals('true')
    expect(
      document
        .querySelector('[data-testid="event-rsvp-103-2"]')
        ?.getAttribute('aria-checked')
    ).equals('true')
    expect(
      document
        .querySelector('[data-testid="event-rsvp-104-0"]')
        ?.getAttribute('aria-checked')
    ).equals('true')
    const groups = [
      ...document.querySelectorAll('[data-testid^="attendance-"]')
    ].map(node => node.textContent)
    expect(groups[0]).includes('Ichiro')
    expect(groups[1]).includes('Babe Ruth')
    expect(groups[2]).includes('Mike Trout').and.includes('Lou Gehrig')
    expect(groups[3]).includes('No one yet')
  })
  it('rolls back only a failed row and lets a different child write while it is pending', async () => {
    const client = clientFor()
    let rejectRow: (error: Error) => void = () => undefined
    client.saveRsvp = async (_id, userId, response) =>
      userId === 101
        ? await new Promise((_resolve, reject) => {
            rejectRow = reject
          })
        : { userId, response }
    await render(client)
    await click('[data-testid="event-rsvp-101-0"]')
    expect(
      document
        .querySelector('[data-testid="event-rsvp-101-0"]')
        ?.getAttribute('aria-disabled')
    ).equals('true')
    await click('[data-testid="event-rsvp-104-2"]')
    await act(async () => {
      rejectRow(new Error('Your guardian access changed. Reload.'))
    })
    expect(document.body.textContent).includes('Your guardian access changed')
    expect(
      document.querySelector('[data-testid="event-rsvp-101-1"]')?.textContent
    ).equals('No reply')
    expect(
      document
        .querySelector('[data-testid="event-rsvp-104-2"]')
        ?.getAttribute('aria-checked')
    ).equals('true')
    client.saveRsvp = async (_id, userId, response) => ({ userId, response })
    await click('[data-testid="event-rsvp-101-0"]')
    expect(document.body.textContent).not.includes(
      'Your guardian access changed'
    )
  })
  it('shows recoverable initial load and map failures, then renders the actual map document on retry', async () => {
    const info = {
      ...initial(),
      address: '1 Demo Way',
      endAt: '2027-04-10T20:00:00Z'
    }
    const client = clientFor(info)
    client.eventInfo = async () => {
      throw new Error('Attendance unavailable')
    }
    await render(client)
    expect(document.body.textContent).includes('Attendance unavailable')
    client.eventInfo = async () => info
    client.eventLocation = async () => {
      throw new Error('Map unavailable')
    }
    await click('Retry event information')
    expect(document.body.textContent).includes('Map unavailable')
    client.eventLocation = async () => ({
      latitude: 34,
      longitude: 12,
      tileUrl: 'https://example.test/{z}/{x}/{y}'
    })
    await click('Retry map')
    expect(document.querySelector('iframe')?.getAttribute('srcdoc')).includes(
      'L.map'
    )
    expect(document.body.textContent).includes('8:00 PM')
  })
  it('opens administrator editing and returns to its family controls', async () => {
    const client = clientFor({ ...initial(), canManage: true })
    await render(client)
    await click('Edit event details')
    expect(document.body.textContent).includes('Save event details')
    await click('Back')
    expect(document.body.textContent).includes('Are you going?')
  })
  it('keeps the visitor location view free of private attendance and RSVP controls', async () => {
    const client = clientFor({
      ...initial(),
      canViewAttendance: false,
      attendees: [],
      replyUserIds: []
    })
    await render(client)
    expect(document.body.textContent).includes('Join a participating team')
    expect(document.querySelector('[role="radiogroup"]')).equals(null)
    expect(document.querySelector('[data-testid="attendance-yes"]')).equals(
      null
    )
    expect(document.body.textContent).not.includes('Are you going?')
  })
})
